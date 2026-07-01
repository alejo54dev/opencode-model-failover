/**
*	model-failover.js
*
*	OpenCode plugin — intercepts permanent HTTP 4xx errors and fails over
*	through a configured chain of models. Every error re-tries the chain
*	from the beginning so models that recover are picked up again. On
*	success the chain resets; on exhaustion the session is terminated.
*
*	Install: cp model-failover.js ~/.config/opencode/plugins/model-failover.js
*	Config:  ~/.config/opencode/model-failover.json
*
*	@name model-failover
 *	@version 5.1.0
*	@author Alejandro Carraretto
*	@license MIT
*/

import { appendFileSync, existsSync, readFileSync } from "node:fs" ;
import { homedir } from "node:os" ;
import { join } from "node:path" ;

// ---------------------------------------------------------------
// Constants
// ---------------------------------------------------------------

const CONFIG_DIR  = join( homedir(), ".config", "opencode" ) ;
const CONFIG_FILE = join( CONFIG_DIR, "model-failover.json" ) ;
const LOG_FILE    = join( CONFIG_DIR, "model-failover.log" ) ;

const LOG_LEVEL =
{
	ERROR : 0,
	INFO  : 1,
	DEBUG : 2
} ;

const FAIL_CODES = [ 401, 402, 403, 404 ] ;

// ---------------------------------------------------------------
// State — single source of truth, all methods read/write it directly
// ---------------------------------------------------------------

const State =
{
	config         : null,   // { enabled, models, logLevel }
	sessionID      : null,   // session currently being failed over
	originalModel  : null,   // { providerID, modelID } — first model seen
	failoverModel  : null,   // { providerID, modelID, variant? } — last working model
	lastError      : null,   // { name, statusCode, message }
	isFailingOver  : false,  // re-entrancy guard for #failover()
	iterationError : null,   // statusCode captured from session.error during a cascade iteration
	isExhausted    : false   // informational flag set when the whole chain fails
} ;

// ---------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------

class ModelFailoverPlugin
{
	#client ;
	#level ;

	constructor( { client } )
	{
		this.#client = client ;
		this.#loadConfig() ;
	}

	// -- config ---------------------------------------------------

	#loadConfig()
	{
		if ( ! existsSync( CONFIG_FILE ) )
		{
			this.#log( LOG_LEVEL.ERROR, `Config not found at ${ CONFIG_FILE }` ) ;
			return ;
		}

		try
		{
			const raw = JSON.parse( readFileSync( CONFIG_FILE, "utf-8" ) ) ;
			const models = Array.isArray( raw.models )
				? raw.models.filter( ( e ) => typeof e?.model == "string" && e.model != "" )
				: [ ] ;

			State.config = {
				enabled  : typeof raw.enabled == "boolean" ? raw.enabled : true,
				models,
				logLevel : [ "error", "info", "debug" ].includes( raw.logLevel )
					? raw.logLevel
					: "info"
			} ;

			this.#level = State.config.logLevel ;

			this.#log( LOG_LEVEL.INFO,
				`Loaded: ${ models.length } models, enabled: ${ State.config.enabled }` ) ;
		}
		catch ( err )
		{
			this.#log( LOG_LEVEL.ERROR, `Config parse error: ${ err.message }` ) ;
		}
	}

	// -- logger ---------------------------------------------------

	#log( rank, message )
	{
		const min = LOG_LEVEL[ this.#level?.toUpperCase?.() ] ?? 1 ;

		if ( rank > min ) return ;

		const label = Object.keys( LOG_LEVEL )[ rank ] ;

		try
		{
			appendFileSync( LOG_FILE,
				`[${ new Date().toISOString() }] [${ label }]: ${ message }\n` ) ;
		}
		catch {}
	}

	// -- entry helpers --------------------------------------------

	#labelFromEntry( entry )
	{
		return `${ entry.model }${ entry.variant ? `:${ entry.variant }` : "" }` ;
	}

	#modelFromEntry( entry )
	{
		const slash = entry.model.indexOf( "/" ) ;
		return slash == -1
			? null
			: {
				providerID : entry.model.substring( 0, slash ),
				modelID    : entry.model.substring( slash + 1 ),
				variant    : entry.variant
			} ;
	}

	// -- failover cascade -----------------------------------------

	async #failover()
	{
		if ( State.isFailingOver ) return ;
		if ( ! State.config?.models?.length ) return ;
		if ( ! State.sessionID ) return ;

		State.isFailingOver = true ;

		try
		{
			for ( let i = 0 ; i < State.config.models.length ; i ++ )
			{
				if ( ! State.sessionID )
				{
					this.#log( LOG_LEVEL.DEBUG, "Cascade aborted — session reset" ) ;
					return ;
				}

				const entry = State.config.models[ i ] ;
				const model = this.#modelFromEntry( entry ) ;
				const label = this.#labelFromEntry( entry ) ;

				if ( ! model )
				{
					this.#log( LOG_LEVEL.ERROR,
						`Bad model at [${ i }]: ${ entry.model }, skipping` ) ;
					continue ;
				}

				State.iterationError = null ;
				this.#log( LOG_LEVEL.INFO, `Trying ${ i }: ${ label }` ) ;

				let result ;

				try
				{
					result = await this.#client.session.prompt( {
						path : { id : State.sessionID },
						body : {
							model,
							parts : [
								{ type : "text", text : `✅ Failover to [${ label }]`, ignored : true },
								{ type : "text", text : "Continue." }
							]
						}
					} ) ;
				}
				catch ( err )
				{
					State.iterationError = ( err?.statusCode != null && err.statusCode !== 0 )
						? err.statusCode
						: "throw" ;
					this.#log( LOG_LEVEL.DEBUG,
						`prompt() threw for ${ label }: ${ err?.message ?? err }` ) ;
				}

				if ( ! State.iterationError && result )
				{
					if ( result?.data?.info?.error )
					{
						State.iterationError = result.data.info.error.statusCode ?? "error" ;
						this.#log( LOG_LEVEL.DEBUG,
							`Response error for ${ label }: ${ result.data.info.error.message ?? result.data.info.error.statusCode }` ) ;
					}
					else if ( result?.data?.info?.state == "rejected" )
					{
						State.iterationError = "rejected" ;
						this.#log( LOG_LEVEL.DEBUG, `Response rejected for ${ label }` ) ;
					}
				}

				await new Promise( r => setTimeout( r, 300 ) ) ;

				if ( State.iterationError )
				{
					this.#log( LOG_LEVEL.INFO,
						`Failed ${ i }: ${ label } — ${ State.iterationError }` ) ;
					continue ;
				}

				this.#log( LOG_LEVEL.INFO, `Override: ${ label }` ) ;
				State.failoverModel = model ;
				return ;
			}

			State.isExhausted    = true ;
			State.failoverModel  = null ;
			this.#log( LOG_LEVEL.INFO, "Cascade exhausted" ) ;

			await this.#client.session.prompt( {
				path : { id : State.sessionID },
				body : { parts : [ { type : "text", text : "❌ Failover chain exhausted" } ] }
			} ).catch( () => {} ) ;
		}
		finally
		{
			State.isFailingOver = false ;
		}
	}

	// -- hooks ----------------------------------------------------

	async onEvent( { event } )
	{
		if ( event.type == "session.deleted" )
		{
			this.reset() ;
			return ;
		}

		if ( event.type == "session.status"
			&& event.properties?.status?.type == "retry" )
		{
			const sid = event.properties?.sessionID ;
			if ( ! sid || State.isFailingOver ) return ;

			State.sessionID = sid ;
			State.lastError = {
				name       : "RetryError",
				statusCode : 0,
				message    : event.properties?.status?.reason ?? ""
			} ;

			this.#log( LOG_LEVEL.DEBUG, `Cascade retry ${ sid }` ) ;
			await this.#failover() ;
			return ;
		}

		if ( event.type != "session.error" ) return ;

		const err = event.properties?.error ;
		if ( err?.name == "MessageAbortedError" ) return ;

		const sc = err?.data?.statusCode ;
		if ( ! FAIL_CODES.includes( sc ) ) return ;

		if ( State.isFailingOver )
		{
			if ( event.properties.sessionID === State.sessionID )
			{
				State.iterationError = sc ;
				this.#log( LOG_LEVEL.DEBUG, `Deferred: ${ sc } during cascade` ) ;
			}

			return ;
		}

		const sid = event.properties?.sessionID ;
		if ( ! sid ) return ;

		State.lastError = {
			name       : err?.name ?? "",
			statusCode : sc,
			message    : err?.data?.message ?? ""
		} ;

		State.sessionID = sid ;

		this.#log( LOG_LEVEL.ERROR,
			`Fail: ${ State.originalModel?.providerID ?? "?" }/${ State.originalModel?.modelID ?? "?" } — ${ sc }` ) ;

		await this.#failover() ;
	}

	onChatMessage( input, output )
	{
		if ( ! input.sessionID ) return ;
		if ( State.isFailingOver ) return ;

		State.sessionID      = null ;
		State.lastError      = null ;
		State.iterationError = null ;
		State.isExhausted    = false ;

		if ( ! State.originalModel && input.model?.providerID && input.model?.modelID )
		{
			State.originalModel = {
				providerID : input.model.providerID,
				modelID    : input.model.modelID,
				variant    : input.model.variant
			} ;

			this.#log( LOG_LEVEL.INFO,
				`Current model: ${ State.originalModel.providerID }/${ State.originalModel.modelID }` ) ;
		}

		if ( ! State.failoverModel || ! output?.message?.model ) return ;

		const msg  = output.message.model ;
		const orig = State.originalModel ;
		const fm   = State.failoverModel ;

		if ( orig
			&& msg.providerID == orig.providerID
			&& msg.modelID    == orig.modelID
			&& msg.variant    == orig.variant )
		{
			output.message.model = { ...fm } ;
		}
		else if ( msg.providerID != fm.providerID
			|| msg.modelID    != fm.modelID
			|| msg.variant    != fm.variant )
		{
			State.failoverModel = null ;
			State.originalModel = {
				providerID : msg.providerID,
				modelID    : msg.modelID,
				variant    : msg.variant
			} ;
		}
	}

	reset()
	{
		this.#log( LOG_LEVEL.DEBUG, "State reset" ) ;

		State.sessionID      = null ;
		State.originalModel  = null ;
		State.failoverModel  = null ;
		State.lastError      = null ;
		State.isFailingOver  = false ;
		State.iterationError = null ;
		State.isExhausted    = false ;
	}
}

// ---------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------

export default async function plugin( { client } )
{
	const instance = new ModelFailoverPlugin( { client } ) ;

	if ( ! State.config?.enabled ) return { } ;

	return {
		event          : ( e ) => instance.onEvent( e ),
		"chat.message" : ( i, o ) => instance.onChatMessage( i, o ),
		dispose        : () => instance.reset()
	} ;
}

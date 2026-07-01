/**
 *	model-failover.js
 *
 *	OpenCode plugin — intercepts permanent HTTP 4xx errors and fails over
 *	through a configured chain of models. The chain retries from index 0 on
 *	every fresh trigger. On success the chain resets; on exhaustion the
 *	session is terminated with a fixed message.
 *
 *	Error detection uses a dual mechanism:
 *	1. Synchronous — prompt() throw / result.data.info inspection
 *	2. Asynchronous — session.error events during isBusy set the inCascade flag
 *	   that is checked after the lock is released (zero-timing-gap pattern)
 *
 *	Install: cp model-failover.js ~/.config/opencode/plugins/model-failover.js
 *	Config:  ~/.config/opencode/model-failover.json
 *
 *	@name model-failover
 *	@version 6.0.1
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
	config        : null,   // { enabled, models, logLevel }
	sessionID     : null,   // session currently being failed over
	originalModel : null,   // { providerID, modelID, variant? } — user's TUI selection
	failoverModel : null,   // { providerID, modelID, variant? } — last working model
	lastError     : null,   // { name, statusCode, message }
	idx           : 0,      // chain index, advances per attempt
	isBusy        : false,  // re-entrancy guard for #failover()
	inCascade     : false,  // continues the chain; set async by session.error or sync by prompt() failure
	isExhausted   : false   // informational flag
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
				logLevel : [ "error", "info", "debug" ].includes( raw.logLevel.toLowerCase() )
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

	/**
	 * One step of the failover cascade. Each call tries exactly one
	 * model from the chain. Recursive calls via the inCascade flag
	 * advance the index without races.
	 *
	 * Exhaustion is checked at the top — before any I/O — so it is
	 * always reached when the index runs past the configured chain.
	 */
	async #failover()
	{
		if ( State.isBusy ) return ;
		if ( ! State.config?.models?.length ) return ;
		if ( ! State.sessionID ) return ;

		State.isBusy  = true ;
		State.inCascade = false ;

		try
		{
			const models = State.config.models ;

			if ( State.idx >= models.length )
			{
				State.isExhausted   = true ;
				State.failoverModel = null ;
				this.#log( LOG_LEVEL.INFO, "Chain models exhausted" ) ;

				await this.#client.session.prompt( {
					path : { id : State.sessionID },
					body : { parts : [ { type : "text", text : "❌ Failover chain exhausted" } ] }
				} ).catch( () => {} ) ;

				return ;
			}

			const i = State.idx ;
			State.idx ++ ;

			const entry = models[ i ] ;
			const model = this.#modelFromEntry( entry ) ;
			const label = this.#labelFromEntry( entry ) ;

			if ( ! model )
			{
				this.#log( LOG_LEVEL.ERROR,
					`Bad model at [${ i }]: ${ entry.model }, skipping` ) ;

				State.inCascade = true ;
				return ;
			}

			this.#log( LOG_LEVEL.INFO, `Trying ${ i }: ${ label }` ) ;

			try
			{
				const result = await this.#client.session.prompt( {
					path : { id : State.sessionID },
					body : {
						model,
						parts : [
							{ type : "text", text : `✅ Failover to [${ label }]`, ignored : true },
							{ type : "text", text : "Continue." }
						]
					}
				} ) ;

				if ( result?.data?.info?.error )
				{
					State.inCascade = true ;

					this.#log( LOG_LEVEL.DEBUG,
						`Response error for ${ label }: ${ result.data.info.error.message ?? result.data.info.error.statusCode ?? "unknown" }` ) ;
				}
				else if ( result?.data?.info?.state == "rejected" )
				{
					State.inCascade = true ;
					this.#log( LOG_LEVEL.DEBUG, `Response rejected for ${ label }` ) ;
				}
			}
			catch ( err )
			{
				State.inCascade = true ;

				this.#log( LOG_LEVEL.DEBUG,
					`Prompt threw for ${ label }: ${ err?.message ?? String( err ) }` ) ;
			}

			if ( State.inCascade )
			{
				this.#log( LOG_LEVEL.INFO, `Failed ${ i }: ${ label }` ) ;
				return ;
			}

			this.#log( LOG_LEVEL.INFO, `Override: ${ label }` ) ;
			State.failoverModel = model ;
			this.#log( LOG_LEVEL.INFO, "Cascade complete" ) ;
		}
		finally
		{
			State.isBusy = false ;
		}

		if ( State.inCascade )
		{
			State.inCascade = false ;
			await this.#failover() ;
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
			if ( ! sid || State.isBusy ) return ;

			State.sessionID = sid ;
			State.idx       = 0 ;
			State.inCascade   = false ;
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

		if ( State.isBusy )
		{
			if ( event.properties.sessionID === State.sessionID )
			{
				State.inCascade = true ;
				this.#log( LOG_LEVEL.DEBUG, `Cascade signal: ${ sc } during busy` ) ;
			}

			return ;
		}

		if ( State.failoverModel
			&& event.properties?.sessionID === State.sessionID )
		{
			this.#log( LOG_LEVEL.INFO, `Stale error dropped: ${ sc } (override active)` ) ;
			return ;
		}

		const sid = event.properties?.sessionID ;
		if ( ! sid ) return ;

		if ( State.idx > 0 )
		{
			State.inCascade = true ;
			return ;
		}

		State.idx = 0 ;
		State.inCascade = false ;

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
		if ( State.isBusy ) return ;

		State.sessionID   = null ;
		State.lastError   = null ;
		State.idx         = 0 ;
		State.inCascade     = false ;
		State.isExhausted = false ;

		const sel = input.model ;

		if ( ! sel?.providerID || ! sel?.modelID ) return ;

		if ( ! State.originalModel )
		{
			State.originalModel = {
				providerID : sel.providerID,
				modelID    : sel.modelID,
				variant    : sel.variant
			} ;

			this.#log( LOG_LEVEL.INFO,
				`Current model: ${ State.originalModel.providerID }/${ State.originalModel.modelID }` ) ;
		}

		const orig = State.originalModel ;

		if ( orig
			&& ( sel.providerID != orig.providerID
				|| sel.modelID    != orig.modelID
				|| sel.variant    != orig.variant ) )
		{
			State.failoverModel = null ;
			State.originalModel = {
				providerID : sel.providerID,
				modelID    : sel.modelID,
				variant    : sel.variant
			} ;

			this.#log( LOG_LEVEL.INFO,
				`Model changed: ${ State.originalModel.providerID }/${ State.originalModel.modelID }` ) ;
			return ;
		}

		if ( ! State.failoverModel || ! output?.message?.model ) return ;

		const fm = State.failoverModel ;

		if ( sel.providerID == orig.providerID && sel.modelID == orig.modelID && sel.variant == orig.variant )
		{
			output.message.model = { ...fm } ;
		}
	}

	reset()
	{
		this.#log( LOG_LEVEL.DEBUG, "State reset" ) ;

		State.sessionID     = null ;
		State.originalModel = null ;
		State.failoverModel = null ;
		State.lastError     = null ;
		State.idx           = 0 ;
		State.isBusy        = false ;
		State.inCascade       = false ;
		State.isExhausted   = false ;
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

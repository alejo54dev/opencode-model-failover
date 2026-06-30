/**
*	model-failover.js
*
*	OpenCode plugin — intercepts permanent HTTP 4xx errors and fails over
*	through a configured chain of models. Every error re-tries the chain
*	from the beginning so models that recover are picked up again. On
*	success the chain resets; on exhaustion the session is terminated.
*
*	Install: cp model-failover.js ~/.config/opencode/plugins/model-failover.js
*	Config: ~/.config/opencode/model-failover.json
*
*	@name model-failover
*	@version 3.0.0
*	@author Alejandro Carraretto
*	@license MIT
*/

import { appendFileSync, existsSync, readFileSync } from "node:fs" ;
import { homedir } from "node:os" ;
import { join } from "node:path" ;

// ---------------------------------------------------------------
// 1. Constants
// ---------------------------------------------------------------

const CONFIG_DIR  = join( homedir(),  ".config", "opencode" ) ;
const CONFIG_FILE = join( CONFIG_DIR, "model-failover.json" ) ;
const LOG_FILE    = join( CONFIG_DIR, "model-failover.log" ) ;

const LOG_LEVEL =
{
	ERROR : 0,
	INFO  : 1,
	DEBUG : 2
} ;

// ---------------------------------------------------------------
// 2. Global state (live — every field used directly, no locals)
// ---------------------------------------------------------------

const State =
{
	config        : null,   // { enabled, models, logLevel }
	sessionID     : null,   // current session being failed over
	chainIdx      : 0,      // current index in models[] during cascade
	originalModel : null,   // { providerID, modelID } — logged once, never cleared
	lastError     : null,   // { name, statusCode, message }
	isExhausted   : false,  // flag set when whole chain fails
	isFailingOver : false,  // guard to prevent re-entrant failover
	cascade       : false,   // signals pending cascade after current attempt
	deferredError : null,    // session.error captured during cascade
	deferredRetry : false    // session.status retry captured during cascade
} ;

// ---------------------------------------------------------------
// 3. Plugin class
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
				? raw.models.filter(
					( e ) => typeof e?.model == "string" && e.model != ""
				)
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
			appendFileSync(
				LOG_FILE,
				`[${ new Date().toISOString() }] [${ label }]: ${ message }\n`
			) ;
		}
		catch {}
	}

	// -- helpers ---------------------------------------------------

	#isRetryable( statusCode )
	{
		return statusCode != null && [ 401, 402, 403, 404, 500 ].includes( statusCode ) ;
	}

	/** Human label for a models[] entry. */
	#entryLabel( entry )
	{
		return `${ entry.model }${ entry.variant ? `:${ entry.variant }` : "" }` ;
	}

	/** Parse slash-delimited model string into providerID/modelID. */
	#parseModel( entry )
	{
		const slash = entry.model.indexOf( "/" ) ;

		return slash == -1
			? null
			: {
				providerID : entry.model.substring( 0, slash ),
				modelID    : entry.model.substring( slash + 1 )
			} ;
	}

	// -- failover cascade ------------------------------------------

	async #failover()
	{
		if ( State.isFailingOver )
		{
			State.cascade = true ;
			return ;
		}

		State.isFailingOver = true ;
		State.cascade       = false ;

		let idx, label ;

		try
		{
			if ( State.chainIdx >= State.config.models.length )
			{
				State.isExhausted = true ;

				this.#log( LOG_LEVEL.INFO, `Cascade exhausted` ) ;

				await this.#client.session.abort( { path : { id : State.sessionID } } )
					.catch( () => {} ) ;

				await this.#client.session.prompt( {
					path : { id : State.sessionID },
					body : { parts : [ { type : "text", text : "❌ Failover chain exhausted" } ] }
				} ).catch( () => {} ) ;

				return ;
			}

			State.isExhausted = false ;

			idx         = State.chainIdx ;
			const entry = State.config.models[ idx ] ;
			const parsed = this.#parseModel( entry ) ;

			if ( ! parsed )
			{
				this.#log( LOG_LEVEL.ERROR,
					`Bad model at [${ idx }]: ${ entry.model }, skipping` ) ;

				State.chainIdx++ ;
				State.cascade = true ;

				return ;
			}

			State.chainIdx++ ;

			label = this.#entryLabel( entry ) ;

			this.#log( LOG_LEVEL.INFO, `Trying ${ idx }: ${ label }` ) ;

			await this.#client.session.abort( { path : { id : State.sessionID } } )
				.catch( () => {} ) ;

			const result = await this.#client.session.prompt( {
				path : { id : State.sessionID },
				body : {
					model : {
						providerID : parsed.providerID,
						modelID    : parsed.modelID,
						variant    : entry.variant
					},
					parts : [
						{ type : "text", text : `✅ Failover model to [${ label }]`, ignored : true },
						{ type : "text", text : "Continue." }
					]
				}
			} ) ;

			const immediate   = result?.data?.info?.error ;
			const state       = result?.data?.info?.state ;
			const deferred    = State.deferredError ;
			const hasRetry    = State.deferredRetry ;
			State.deferredError = null ;
			State.deferredRetry = false ;

			if ( immediate || deferred || state == "rejected" || hasRetry )
			{
				const code = immediate?.data?.statusCode
					?? deferred?.statusCode
					?? "" ;

				this.#log( LOG_LEVEL.ERROR,
					`Failed ${ idx }: ${ label }${ code ? ` — ${ code }` : "" }` ) ;

				State.cascade = true ;
			}
			else
			{
				this.#log( LOG_LEVEL.INFO, `Override: ${ label }` ) ;
				State.cascade = false ;
			}
		}
		catch ( err )
		{
			const msg  = err?.message ?? String( err ) ;
			const code = err?.statusCode ?? err?.data?.statusCode ?? "" ;

			State.lastError = {
				name       : err?.name ?? "PromptError",
				statusCode : code,
				message    : msg
			} ;

			this.#log( LOG_LEVEL.ERROR,
				`Failed ${ idx }: ${ label }${ code ? ` — ${ code }` : "" }` ) ;

			State.cascade = true ;
		}
		finally
		{
			State.isFailingOver = false ;
		}

		if ( State.cascade )
		{
			State.cascade = false ;

			await this.#failover() ;
		}
	}

	// -- hooks -----------------------------------------------------

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
			const p = event.properties ;

			if ( ! p?.sessionID ) return ;

			if ( State.isFailingOver )
			{
				State.deferredRetry = true ;

				this.#log( LOG_LEVEL.DEBUG,
					`Event deferred: retry for ${ p.sessionID }` ) ;

				return ;
			}

			this.#log( LOG_LEVEL.DEBUG, `Cascade retry ${ p.sessionID }` ) ;

			await this.#failover() ;

			return ;
		}

		if ( event.type != "session.error" ) return ;

		const p = event.properties ;

		if ( ! p?.sessionID ) return ;

		const errName = p?.error?.name ;

		if ( errName == "MessageAbortedError" ) return ;

		if ( State.isFailingOver )
		{
			State.deferredError = {
				sessionID  : p.sessionID,
				statusCode : p?.error?.data?.statusCode ?? 0,
				message    : p?.error?.data?.message ?? ""
			} ;

			this.#log( LOG_LEVEL.DEBUG,
				`Event deferred: session.error for ${ p.sessionID }` ) ;

			return ;
		}

		State.lastError = {
			name       : errName ?? "",
			statusCode : p?.error?.data?.statusCode ?? 0,
			message    : p?.error?.data?.message ?? ""
		} ;

		const sc = p?.error?.data?.statusCode ;
		const isStatusCodeFail = sc != null
			&& [ 401, 402, 403, 404 ].includes( sc ) ;
		const inCascade = State.chainIdx > 0 ;

		if ( ! isStatusCodeFail && ! inCascade )
		{
			this.#log( LOG_LEVEL.DEBUG,
				`Event skipped — ${ p.sessionID }: ${ errName }${ sc != null ? ` (${ sc })` : "" }` ) ;

			return ;
		}

		State.sessionID = p.sessionID ;

		let failModel ;

		if ( State.chainIdx == 0 && State.originalModel )
		{
			failModel = `${ State.originalModel.providerID }/${ State.originalModel.modelID }` ;
		}

		this.#log( LOG_LEVEL.ERROR,
			`Fail${ failModel ? `: ${ failModel }` : "" } ${ sc != null ? `— ${ sc }` : "" }` ) ;

		await this.#failover() ;
	}

	onChatMessage( input )
	{
		if ( ! input.sessionID ) return ;

		if ( State.isFailingOver ) return ;

		State.chainIdx  = 0 ;
		State.lastError = null ;

		if ( ! State.originalModel && input.model?.providerID && input.model?.modelID )
		{
			State.originalModel = {
				providerID : input.model.providerID,
				modelID    : input.model.modelID
			} ;

			this.#log( LOG_LEVEL.INFO,
				`Current model: ${ State.originalModel.providerID }/${ State.originalModel.modelID }` ) ;
		}
	}

	reset()
	{
		this.#log( LOG_LEVEL.DEBUG, "State reset" ) ;

		State.sessionID     = null ;
		State.chainIdx      = 0 ;
		State.lastError     = null ;
		State.isExhausted   = false ;
		State.isFailingOver = false ;
		State.cascade       = false ;
		State.deferredError = null ;
		State.deferredRetry = false ;
	}
}

// ---------------------------------------------------------------
// 4. Plugin entry point
// ---------------------------------------------------------------

export default async function plugin( { client } )
{
	const instance = new ModelFailoverPlugin( { client } ) ;

	if ( ! State.config?.enabled )
	{
		return {} ;
	}

	return {
		event          : ( e ) => instance.onEvent( e ),
		"chat.message" : ( i, o ) => instance.onChatMessage( i, o ),
		dispose        : () => instance.reset()
	} ;
}

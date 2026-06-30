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

/** Log prefixes for clean, reusable formatting. */
const LOG = {
	ERROR : "[ERROR]: ",
	INFO  : "[INFO]: ",
	DEBUG : "[DEBUG]: "
} ;

/** Internal rank for filtering by configured log level. */
const LOG_RANK = Object.freeze( {
	"[ERROR]: " : 0,
	"[INFO]: "  : 1,
	"[DEBUG]: " : 2
} ) ;

const CFG_RANK = Object.freeze( {
	error : 0,
	info  : 1,
	debug : 2
} ) ;

// ---------------------------------------------------------------
// 2. Global state (live — every field used directly, no locals)
// ---------------------------------------------------------------

const State = {
	config        : null,   // { enabled, models, logLevel }
	sessionID     : null,   // current session being failed over
	chainIdx      : 0,      // current index in models[] during cascade
	originalModel : null,   // { providerID, modelID } first model ever seen
	failoverModel : null,   // { providerID, modelID, variant } last working model
	lastError     : null,   // { name, statusCode, message }
	isExhausted   : false,  // flag set when whole chain fails
	isFailingOver : false   // guard to prevent re-entrant failover
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
			this.#log( LOG.ERROR, `Config not found at ${ CONFIG_FILE }` ) ;

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

			this.#log( LOG.INFO,
				`Loaded: ${ models.length } models, enabled: ${ State.config.enabled }` ) ;
		}
		catch ( err )
		{
			this.#log( LOG.ERROR, `Config parse error: ${ err.message }` ) ;
		}
	}

	// -- logger ---------------------------------------------------

	#log( prefix, message )
	{
		const rank = LOG_RANK[ prefix ] ;
		const min = CFG_RANK[ this.#level ] ?? 1 ;

		if ( rank == null || rank > min ) return ;

		try
		{
			appendFileSync(
				LOG_FILE,
				`[${ new Date().toISOString() }] ${ prefix }${ message }\n`
			) ;
		}
		catch {}
	}

	// -- helpers ---------------------------------------------------

	#isRetryable( statusCode )
	{
		return statusCode != null && statusCode >= 400 && statusCode < 500 ;
	}

	#modelKey( m )
	{
		return `${ m.providerID }/${ m.modelID }` ;
	}

	/** Human label for a models[] entry. */
	#entryLabel( entry )
	{
		return `${ entry.model }${ entry.variant ? `:${ entry.variant }` : "" }` ;
	}

	/** Error suffix for log lines. */
	#errorSuffix()
	{
		const e = State.lastError ;

		if ( ! e ) return "" ;

		return `— ${ e.name } ${ e.statusCode > 0 ? `(${ e.statusCode })` : "" }` ;
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
		// Chain exhausted — no more models to try
		if ( State.chainIdx >= State.config.models.length )
		{
			State.isExhausted   = true ;
			State.failoverModel = null ;

			this.#log( LOG.ERROR, `Failover chain exhausted ${ this.#errorSuffix() }` ) ;

			await this.#client.session.abort( { path : { id : State.sessionID } } )
				.catch( () => {} ) ;

			await this.#client.session.prompt( {
				path : { id : State.sessionID },
				body : { parts : [ { type : "text", text : "❌ Failover chain exhausted" } ] }
			} ).catch( () => {} ) ;

			State.isFailingOver = false ;

			return ;
		}

		State.isExhausted   = false ;
		State.isFailingOver = true ;

		const idx = State.chainIdx ;
		const entry = State.config.models[ idx ] ;
		const parsed = this.#parseModel( entry ) ;

		if ( ! parsed )
		{
			this.#log( LOG.ERROR,
				`Bad model at [${ idx }]: ${ entry.model }, skipping` ) ;

			State.chainIdx++ ;

			await this.#failover() ;

			return ;
		}

		/** Pre-advance chainIdx so the next call starts at the next model. */
		State.chainIdx++ ;

		const label = this.#entryLabel( entry ) ;

		this.#log( LOG.INFO, `[${ idx }] ${ label } ${ this.#errorSuffix() }` ) ;

		await this.#client.session.abort( { path : { id : State.sessionID } } )
			.catch( () => {} ) ;

		try
		{
			await this.#client.session.prompt( {
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

			State.failoverModel = {
				providerID : parsed.providerID,
				modelID    : parsed.modelID,
				variant    : entry.variant
			} ;

			State.isFailingOver = false ;

			this.#log( LOG.INFO,
				`Success: ${ this.#modelKey( State.failoverModel ) }, chain reset` ) ;

			// chainIdx stays advanced — continuation uses it to find next model.
		}
		catch ( err )
		{
			const msg = err?.message ?? String( err ) ;
			const code = err?.statusCode ?? err?.data?.statusCode ?? "" ;

			this.#log( LOG.ERROR,
				`Prompt failed for ${ State.sessionID } (${ label }): ${ msg }`
				+ `${ code ? ` status=${ code }` : "" }, cascading` ) ;

			State.lastError = {
				name       : err?.name ?? "PromptError",
				statusCode : code,
				message    : msg
			} ;

			State.failoverModel = null ;

			// ChainIdx is already advanced — try the next model.
			await this.#failover() ;
		}
	}

	// -- hooks -----------------------------------------------------

	async onEvent( { event } )
	{
		if ( event.type == "session.deleted" )
		{
			if ( State.sessionID )
			{
				const p = event.properties ;
				// v1 uses info.id, v2 uses sessionID
				const deletedID = p?.info?.id ?? p?.sessionID ;

				if ( deletedID && deletedID !== State.sessionID ) return ;
			}

			State.sessionID     = null ;
			State.chainIdx      = 0 ;
			State.originalModel = null ;
			State.failoverModel = null ;
			State.lastError     = null ;
			State.isExhausted   = false ;
			State.isFailingOver = false ;

			return ;
		}

		if ( event.type == "session.status" )
		{
			const p = event.properties ;

			if ( ! p?.sessionID || p?.status?.type != "retry" ) return ;

			// Continuation via retry — cascade if we are mid-chain.
			if ( State.sessionID === p.sessionID && State.chainIdx > 0
				&& ! State.isExhausted && ! State.isFailingOver )
			{
				State.lastError = {
					name       : "RetryError",
					statusCode : "",
					message    : p.status.message ?? ""
				} ;

				this.#log( LOG.INFO,
					`Retry at [${ State.chainIdx - 1 }], cascading to [${ State.chainIdx }]` ) ;

				await this.#failover() ;
			}

			return ;
		}

		if ( event.type == "session.error" )
		{
			const p = event.properties ;

			if ( ! p?.sessionID ) return ;
			if ( p?.error?.name == "MessageAbortedError" ) return ;

			// Re-entrancy guard
			if ( State.isFailingOver ) return ;

			// Same session continuation — cascade to next model.
			if ( State.sessionID === p.sessionID )
			{
				if ( State.isExhausted ) return ;

				if ( State.chainIdx > 0 )
				{
					State.lastError = {
						name       : p?.error?.name ?? "Error",
						statusCode : p?.error?.data?.statusCode ?? "",
						message    : p?.error?.data?.message ?? ""
					} ;

					// The current failover model just failed — clear it so
					// onChatMessage doesn't override with a stale/broken model
					// or misinterpret a runtime retry as a user model change.
					State.failoverModel = null ;

					this.#log( LOG.INFO,
						`Failover at [${ State.chainIdx - 1 }] failed,`
						+ ` cascading to [${ State.chainIdx }]` ) ;

					await this.#failover() ;

					return ;
				}
			}

			// Initial failover for a new session error.
			const sc = p?.error?.data?.statusCode ;

			if ( ! this.#isRetryable( sc ) ) return ;

			this.#log( LOG.DEBUG,
				`session.error: ${ p?.error?.name ?? "Error" } (${ sc })` ) ;

			State.sessionID = p.sessionID ;
			State.chainIdx  = 0 ;
			State.lastError = {
				name       : p?.error?.name ?? "Error",
				statusCode : sc,
				message    : p?.error?.data?.message ?? ""
			} ;

			await this.#failover() ;
		}
	}

	async onChatMessage( input, output )
	{
		if ( ! input.sessionID || ! input.model ) return ;
		if ( ! input.model.providerID || ! input.model.modelID ) return ;

		if ( ! State.originalModel )
		{
			State.originalModel = {
				providerID : input.model.providerID,
				modelID    : input.model.modelID
			} ;

			this.#log( LOG.DEBUG,
				`Original model: ${ this.#modelKey( State.originalModel ) }` ) ;

			return ;
		}

		if ( ! State.failoverModel ) return ;

		const inputKey    = this.#modelKey( input.model ) ;
		const originalKey = this.#modelKey( State.originalModel ) ;
		const failoverKey = this.#modelKey( State.failoverModel ) ;

		if ( inputKey === originalKey )
		{
			output.message.model = {
				providerID : State.failoverModel.providerID,
				modelID    : State.failoverModel.modelID,
				variant    : State.failoverModel.variant
			} ;

			this.#log( LOG.DEBUG, `Override to ${ failoverKey }` ) ;

			return ;
		}

		if ( inputKey === failoverKey ) return ;

		this.#log( LOG.INFO,
			`User model change, clearing failover for ${ input.sessionID }` ) ;

		State.chainIdx      = 0 ;
		State.failoverModel = null ;
		State.originalModel = {
			providerID : input.model.providerID,
			modelID    : input.model.modelID
		} ;
	}

	dispose()
	{
		State.config        = null ;
		State.sessionID     = null ;
		State.chainIdx      = 0 ;
		State.originalModel = null ;
		State.failoverModel = null ;
		State.lastError     = null ;
		State.isExhausted   = false ;
		State.isFailingOver = false ;
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
		dispose        : () => instance.dispose()
	} ;
}

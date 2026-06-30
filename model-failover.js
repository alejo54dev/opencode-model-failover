/**
*	model-failover.js
*
*	OpenCode plugin — intercepts permanent model errors (HTTP 401/402/403/404)
*	and fails over through a configured model chain. Also handles cascading
*	failures: if a failover model itself errors, the chain advances to the next.
*
*	## Cascade per session
*
*	Per-session state is a single integer index in Map<sessionID>. On each
*	session.error the failover loop starts from that index, logs the attempt,
*	increments the index, and tries the next model. If the prompt succeeds the
*	index is reset to 0 so the next error restarts from the beginning — this
*	gives previously-failed models a chance to be retried. If the chain
*	exhausts the session entry is removed.
*
*	## Works with any agent/provider
*
*	The model is injected directly into the prompt() API body as a per-call
*	override. No session-level model change is persisted (the OpenCode API
*	does not support it), so every user prompt that hits a broken model will
*	trigger the failover flow.
*
*	Install: cp model-failover.js ~/.config/opencode/plugins/model-failover.js
*	Config: ~/.config/opencode/model-failover.json
*
*	@name	model-failover
*	@version	2.1.10
*	@author	Alejandro Carraretto
*	@license	MIT
*/

import { appendFileSync, existsSync, readFileSync } from "node:fs" ;
import { homedir } from "node:os" ;
import { join } from "node:path" ;

/** ~/.config/opencode (or $XDG_CONFIG_HOME/opencode) */
const CONFIG_DIR = join(
	process.env.XDG_CONFIG_HOME ?? join( homedir(), ".config" ),
	"opencode"
) ;

/** Rank of each log level — lower number = more severe. */
const LOG_RANK = { error : 0, info : 1, debug : 2 } ;

/**
*	Creates a file-based logger that appends to model-failover.log inside the
*	opencode config directory. Respects the configured minimum log level.
*
*	@param	{"error"|"info"|"debug"} level — minimum level to emit
*	@returns	{{ error: Function, info: Function, debug: Function }}
*/
function createLogger( level )
{
	const min = LOG_RANK[ level ] ?? 1 ;

	function write( lvl, args )
	{
		if ( LOG_RANK[ lvl ] > min ) return ;
		try
		{
			appendFileSync(
				join( CONFIG_DIR, "model-failover.log" ),
				`[${ new Date().toISOString() }] [${ lvl.toUpperCase() }] ${ args.join( " " ) }\n`
			) ;
		}
		catch {}  // Silently ignore write errors (disk full, no perm, etc.)
	}

	return {
		error : ( ...a ) => write( "error", a ),
		info  : ( ...a ) => write( "info", a ),
		debug : ( ...a ) => write( "debug", a )
	} ;
}

/**
*	Loads and validates plugin config from disk.
*
*	Reads ~/.config/opencode/model-failover.json. Missing or malformed config
*	silently falls back to sensible defaults so the plugin never crashes on
*	startup.
*
*	@returns	{{ enabled: boolean, models: Array<{model:string, variant?:string}>, logLevel: string }}
*/
function loadConfig()
{
	const path = join( CONFIG_DIR, "model-failover.json" ) ;

	// No config file → enabled by default with an empty model list
	if ( ! existsSync( path ) )
	{
		return { enabled : true, models : [ ], logLevel : "info" } ;
	}

	try
	{
		const raw = JSON.parse( readFileSync( path, "utf-8" ) ) ;
		const models = Array.isArray( raw.models )
			? raw.models
				.filter( ( e ) => typeof e?.model == "string" && e.model != "" )
				.map( ( e ) => ( {
					model : e.model,
					variant : typeof e.variant == "string" ? e.variant : undefined
				} ) )
			: [ ] ;

		return {
			enabled : typeof raw.enabled == "boolean" ? raw.enabled : true,
			models,
			logLevel : [ "error", "info", "debug" ].includes( raw.logLevel )
				? raw.logLevel
				: "info"
		} ;
	}
	catch
	{
		// JSON parse error → fall back to defaults
		return { enabled : true, models : [ ], logLevel : "info" } ;
	}
}

/**
*	Plugin entry point. Called once by the OpenCode runtime.
*
*	Returns two hooks:
*		- `event`   — listens for session.error and session.deleted
*		- `dispose` — cleans up per-session state
*
*	@param	{{ client: import("@opencode-ai/sdk").Client }} param0
*	@returns	{{ event: Function, dispose: Function }}
*/
export default async function plugin( { client } )
{
	const config = loadConfig() ;
	const log = createLogger( config.logLevel ) ;

	/**
	*	Per-session failover index.
	*
	*	Map<sessionID, chainIndex>. Absence means idx=0 (no cascade in
	*	progress). Index is advanced BEFORE prompting so a failing model
	*	automatically moves the cursor; on success it is RESET to 0 so the
	*	next error restarts from the beginning of the chain.
	*/
	const sessions = new Map() ;

	log.debug( "INIT:", JSON.stringify( config ) ) ;

	if ( ! config.enabled )
	{
		log.info( "Disabled" ) ;

		return {} ;
	}

	/**
	*	Runs the failover cascade: iterates through config.models starting
	*	from the stored index, aborting the failing request and re-prompting
	*	with the next model until one succeeds or the chain exhausts.
	*
	*	On success the index is reset to 0 (fresh start for next error).
	*	On full exhaustion the session entry is deleted and a terminal
	*	"Failover chain exhausted" message is sent.
	*
	*	@param	{string} sessionID
	*	@param	{{ name: string, statusCode: number|null, message: string }} errorInfo
	*/
	async function failover( sessionID, errorInfo )
	{
		let idx = sessions.get( sessionID ) ?? 0 ;

		while ( idx < config.models.length )
		{
			const entry = config.models[ idx ] ;
			const slash = entry.model.indexOf( "/" ) ;

			// Models must be "providerID/modelID" format
			if ( slash == -1 )
			{
				log.error( `Bad model at [${ idx }]: ${ entry.model }, skipping` ) ;
				idx++ ;
				sessions.set( sessionID, idx ) ;
				continue ;
			}

			// Human-readable label for logs and UI
			const label = `${ entry.model }${ entry.variant ? `:${ entry.variant }` : "" }` ;
			const s = errorInfo
				? `— ${ errorInfo.name } ${ errorInfo.statusCode > 0 ? `(${ errorInfo.statusCode })` : "" }`
				: "" ;

			log.info( `[${ idx }] ${ label } ${ s }` ) ;

			// Advance index BEFORE attempting so a failing model moves the
			// cascade forward automatically
			idx++ ;
			sessions.set( sessionID, idx ) ;

			// Cancel the in-flight failing request (ignore abort errors)
			await client.session.abort( { path : { id : sessionID } } ).catch( () => {} ) ;

			try
			{
				// Re-prompt with the failover model as a per-call override
				await client.session.prompt( {
					path : { id : sessionID },
					body : {
						model : {
							providerID : entry.model.substring( 0, slash ),
							modelID : entry.model.substring( slash + 1 ),
							variant : entry.variant
						},
						parts : [
							{ type : "text", text : `✅ Failover model to [${ label }]` },
							{ type : "text", text : "Continue." }
						]
					}
				} ) ;

				// Reset to start — next error will retry from model 0.
				// This lets previously-failed models be retried in case
				// they become available again.
				sessions.set( sessionID, 0 ) ;
				return ;
			}
			catch ( err )
			{
				// Failover model itself failed → log and cascade to next
				const msg = err?.message ?? String( err ) ;
				const code = err?.statusCode ?? err?.data?.statusCode ?? "" ;

				log.error(
					`Prompt failed for ${ sessionID } (${ label }): ${ msg }`
					+ `${ code ? ` status=${ code }` : "" }, cascading`
				) ;

				errorInfo = {
					name : err?.name ?? "PromptError",
					statusCode : code,
					message : msg
				} ;
				// Loop continues with idx already advanced
			}
		}

		// All models exhausted — clean up and send terminal message
		sessions.delete( sessionID ) ;

		const s = errorInfo
			? `— ${ errorInfo.name } ${ errorInfo.statusCode > 0 ? `(${ errorInfo.statusCode })` : "" }`
			: "" ;

		log.error( `Failover chain exhausted ${ s }` ) ;

		await client.session.abort( { path : { id : sessionID } } ).catch( () => {} ) ;

		await client.session.prompt( {
			path : { id : sessionID },
			body : { parts : [ { type : "text", text : "❌ Failover chain exhausted" } ] }
		} ).catch( () => {} ) ;
	}

	/**
	*	Handles session events from the runtime.
	*
	*	Triggers a failover when:
	*		- A model returns HTTP 401/402/403/404
	*		- The session is already mid-cascade (idx > 0) and errors again
	*
	*	Ignores MessageAbortedError (intentional user cancellation).
	*
	*	Cleans up per-session state on session.deleted.
	*
	*	@param	{{ event: import("@opencode-ai/plugin").Event }} param0
	*/
	async function onEvent( { event } )
	{
		if ( event.type == "session.deleted" )
		{
			const id = event.properties?.info?.id ;

			if ( id ) sessions.delete( id ) ;

			return ;
		}

		if ( event.type == "session.error" )
		{
			const p = event.properties ;

			if ( ! p?.sessionID ) return ;
			if ( p?.error?.name == "MessageAbortedError" ) return ;

			const sc = p?.error?.data?.statusCode ;
			const isStatusCodeFail = sc != null && [ 401, 402, 403, 404 ].includes( sc ) ;
			const inCascade = ( sessions.get( p.sessionID ) ?? 0 ) > 0 ;

			// Only act on permanent HTTP errors or errors during an active cascade
			if ( ! isStatusCodeFail && ! inCascade ) return ;

			await failover( p.sessionID, {
				name : p.error.name ?? "Error",
				statusCode : sc,
				message : p?.error?.data?.message ?? ""
			} ) ;
		}
	}

	/** Cleans up all session state when the plugin is disposed. */
	function onDispose()
	{
		sessions.clear() ;
	}

	return {
		event   : onEvent,
		dispose : onDispose
	} ;
}

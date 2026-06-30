/**
 * 	model-failover.js
 *
 * 	OpenCode plugin — intercepts permanent model errors (HTTP 401/402/403/404)
 * 	and fails over through a configured model chain.
 *
 * 	Design: Per-session state stored in a Map<sessionID> created on demand.
 * 	Each entry holds chain index, busy guard, unified cascade flag, and
 * 	metadata (lastError, triggeredAt). The busy guard prevents re-entrancy
 * 	and stops `chat.message` from rewinding the chain during the plugin's
 * 	own prompt. The chain index rewinds on each user message.
 * 	When the last model fails, a "chain exhausted" message is sent once.
 * 	Also intercepts session.status("retry") to cascade immediately without
 * 	waiting for the automatic retry to fail.
 *
 * 	Install:
 * 		cp model-failover.js ~/.config/opencode/plugins/model-failover.js
 *
 * 	Config: ~/.config/opencode/model-failover.json
 *
 * 	@name model-failover
 * 	@version 8.0.0
 * 	@author Alejandro Carraretto
 * 	@license MIT
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs" ;
import { homedir } from "node:os" ;
import { join } from "node:path" ;

// ── Config ─────────────────────────────────────────────

/** Default settings merged with user overrides from model-failover.json. */
const DEFAULT_CONFIG = {
	enabled : true,
	models : [ ],
	logLevel : "info"
} ;

/**
 * Returns the absolute path to the OpenCode config directory.
 *
 * @returns {string}
 */
function getConfigDir()
{
	const xdg = process.env.XDG_CONFIG_HOME ?? join( homedir(), ".config" ) ;

	return join( xdg, "opencode" ) ;
}

/**
 * Parses a single model entry from the config file.
 *
 * @param {unknown} entry - Raw JSON value.
 * @returns {{ model:string, variant?:string }}
 */
function parseEntry( entry )
{
	if ( typeof entry == "object" && entry != null )
	{
		return {
			model : typeof entry.model == "string" ? entry.model : "",
			variant : typeof entry.variant == "string" ? entry.variant : undefined
		} ;
	}

	return { model : "", variant : undefined } ;
}

/**
 * Loads and validates the plugin config from disk.
 * Falls back to defaults on missing or invalid values.
 *
 * @returns {typeof DEFAULT_CONFIG}
 */
function loadConfig()
{
	const configPath = join( getConfigDir(), "model-failover.json" ) ;

	if ( ! existsSync( configPath ) )
	{
		return { ...DEFAULT_CONFIG } ;
	}

	try
	{
		const raw = JSON.parse( readFileSync( configPath, "utf-8" ) ) ;

		return {
			enabled : typeof raw.enabled == "boolean"
				? raw.enabled
				: DEFAULT_CONFIG.enabled,
			models : Array.isArray( raw.models )
				? raw.models.map( parseEntry ).filter( ( e ) => e.model != "" )
				: [ ...DEFAULT_CONFIG.models ],
			logLevel : [ "error", "info", "debug" ].includes( raw.logLevel )
				? raw.logLevel
				: DEFAULT_CONFIG.logLevel
		} ;
	}
	catch
	{
		return { ...DEFAULT_CONFIG } ;
	}
}

// ── Logger ─────────────────────────────────────────────

/** Numeric rank for log-level comparisons. */
const LOG_RANK = { error : 0, info : 1, debug : 2 } ;

/**
 * File-based logger that appends to model-failover.log.
 *
 * @param {"error"|"info"|"debug"} level - Minimum level to emit.
 * @returns {{ error:Function, info:Function, debug:Function }}
 */
function createLogger( level )
{
	const min = LOG_RANK[ level ] ?? 1 ;

	function write( lvl, ...args )
	{
		if ( LOG_RANK[ lvl ] > min ) return ;

		const ts = new Date().toISOString() ;

		const body = args.map(
			( a ) => ( typeof a == "string" ? a : JSON.stringify( a ) )
		).join( " " ) ;

		try
		{
			appendFileSync(
				join( getConfigDir(), "model-failover.log" ),
				`[${ ts }] [${ lvl.toUpperCase() }] ${ body }\n`
			) ;
		}
		catch {}
	}

	return {
		error : ( ...args ) => write( "error", ...args ),
		info  : ( ...args ) => write( "info", ...args ),
		debug : ( ...args ) => write( "debug", ...args )
	} ;
}

// ── Helpers ────────────────────────────────────────────

/**
 * Splits a "providerID/modelID" string into its two parts.
 *
 * @param {string} spec - e.g. "openai/gpt-4".
 * @returns {{ providerID:string, modelID:string }}
 */
function parseModel( spec )
{
	const idx = spec.indexOf( "/" ) ;

	if ( idx == -1 ) return { providerID : "", modelID : spec } ;

	return {
		providerID : spec.substring( 0, idx ),
		modelID : spec.substring( idx + 1 )
	} ;
}

/**
 * Formats a model as "providerID/modelID:variant".
 *
 * @param {{ providerID:string, modelID:string }} base
 * @param {string} [variant]
 * @returns {string}
 */
function formatModelLabel( base, variant )
{
	return `${ base.providerID }/${ base.modelID }${ variant ? ":" + variant : "" }` ;
}

// ── Plugin ─────────────────────────────────────────────

/**
 * Plugin entry point.
 *
 * On permanent error (HTTP 401/402/403/404) or session.status("retry"):
 * aborts the failing request and re-prompts with the next model in the
 * failover chain. Per-session state stored via Map<sessionID>.
 * The chain index rewinds on each user message.
 *
 * @param {Object} params
 * @param {import("@opencode-ai/plugin").Client} params.client
 * @returns {Promise<{ event:Function, "chat.message":Function, dispose:Function }>}
 */
export default async function plugin( { client } )
{
	const config = loadConfig() ;
	const log = createLogger( config.logLevel ) ;

	log.info( "init:", JSON.stringify( config ) ) ;

	if ( ! config.enabled )
	{
		log.info( "disabled" ) ;
		return {} ;
	}

	/** Per-session state map. Created on demand by getSession(). */
	const sessions = new Map() ;

	/**
	 * Returns the state object for a session, creating it if missing.
	 * Acts as the single source of truth for the entire failover flow.
	 *
	 * @param {string} sessionID
	 * @returns {{
	 * 	idx:number, busy:boolean, cascade:boolean, sessionID:string,
	 * 	lastError:({ name:string, statusCode:number, message:string }|null),
	 * 	triggeredAt:(number|null)
	 * }}
	 */
	function getSession( sessionID )
	{
		let s = sessions.get( sessionID ) ;

		if ( ! s )
		{
			s = {
				idx : 0,
				busy : false,
				cascade : false,
				sessionID,
				lastError : null,
				triggeredAt : null
			} ;

			sessions.set( sessionID, s ) ;
		}

		return s ;
	}

	/**
	 * Tries the next model in the failover chain for a session.
	 *
	 * Idempotent — re-entrant calls are ignored via s.busy.
	 * The chain index advances before any I/O so events triggered
	 * by our own abort/prompt do not double-advance.
	 *
	 * @param {string} sessionID
	 * @returns {Promise<void>}
	 */
	async function failover( sessionID )
	{
		const s = getSession( sessionID ) ;

		if ( s.busy ) return ;

		s.busy = true ;
		s.cascade = false ;

		try
		{
			const idx = s.idx ;

			log.debug( `failover called, idx=${ idx } modelCount=${ config.models.length }` ) ;

			if ( idx >= config.models.length )
			{
				sessions.delete( sessionID ) ;

				log.error( `chain exhausted for ${ sessionID }` ) ;

				await client.session.abort(
					{ path : { id : sessionID } }
				).catch( ( err ) =>
				{
					log.debug( `abort error on exhausted for ${ sessionID }: ${ err?.message ?? "" }` ) ;
				} ) ;

				await client.session.prompt( {
					path : { id : sessionID },
					body : {
						parts : [
							{ type : "text", text : "❌ Failover chain exhausted." }
						]
					}
				} ).catch( ( err ) =>
				{
					log.debug( `exhausted prompt error for ${ sessionID }: ${ err?.message ?? "" }` ) ;
				} ) ;

				return ;
			}

			const entry = config.models[ idx ] ;
			const base = parseModel( entry.model ) ;

			if ( ! base.providerID )
			{
				log.error( `bad model entry at [${ idx }]: ${ entry.model }, skipping` ) ;

				s.idx++ ;
				s.cascade = true ;

				return ;
			}

			s.idx++ ;

			const label = formatModelLabel( base, entry.variant ) ;

			log.info( `[${ idx }] ${ label }` ) ;

			await client.session.abort(
				{ path : { id : sessionID } }
			).catch( ( err ) =>
			{
				log.debug( `abort error for ${ sessionID }: ${ err?.message ?? "" }` ) ;
			} ) ;

			try
			{
				await client.session.prompt( {
					path : { id : sessionID },
					body : {
						model : {
							providerID : base.providerID,
							modelID : base.modelID,
							variant : entry.variant
						},
						parts : [
							{
								type : "text",
								text : `✅ Failover model to [${ label }]`
							},
							{ type : "text", text : "Continue." }
						]
					}
				} ) ;
			}
			catch ( err )
			{
				s.cascade = true ;

				const msg = err?.message ?? String( err ) ;
				const code = err?.statusCode ?? err?.data?.statusCode ?? "" ;

				log.error(
					`prompt failed for ${ sessionID } (${ label }): ${ msg }`
					+ `${ code ? " status=" + code : "" }, cascading`
				) ;
			}
		}
		finally
		{
			s.busy = false ;
		}

		if ( s.cascade )
		{
			s.cascade = false ;
			await failover( sessionID ) ;
		}
	}

	/**
	 * Handles session events.
	 *
	 * Triggers failover() on:
	 * - HTTP 401/402/403/404 status code on session.error
	 * - Any session.error while already in a cascade (idx > 0)
	 * - session.status("retry") — cascades immediately without waiting
	 *   for the automatic retry to fail
	 *
	 * @param {{ event: Object }} params - The OpenCode event payload.
	 * @returns {Promise<void>}
	 */
	async function onEvent( { event } )
	{
		if ( event.type == "session.deleted" )
		{
			const id = event.properties?.info?.id ;

			if ( id ) sessions.delete( id ) ;

			return ;
		}

		if ( event.type == "session.status"
			&& event.properties?.status?.type == "retry" )
		{
			const sessionID = event.properties.sessionID ;

			if ( ! sessionID ) return ;

			const s = getSession( sessionID ) ;

			if ( s.busy )
			{
				s.cascade = true ;
				return ;
			}

			await failover( sessionID ) ;
			return ;
		}

		if ( event.type != "session.error" ) return ;

		const p = event.properties ;
		if ( ! p?.sessionID ) return ;

		const errName = p?.error?.name ;
		if ( errName == "MessageAbortedError" ) return ;

		const statusCode = p?.error?.data?.statusCode ;
		const sessionID = p.sessionID ;
		const s = getSession( sessionID ) ;

		if ( s.busy )
		{
			s.cascade = true ;
			log.debug( `pending cascade for ${ sessionID } (busy in failover())` ) ;

			return ;
		}

		s.lastError = {
			name : errName ?? "",
			statusCode : statusCode ?? 0,
			message : p?.error?.data?.message ?? ""
		} ;
		s.triggeredAt = Date.now() ;

		const isStatusCodeFail = statusCode != null
			&& [ 401, 402, 403, 404 ].includes( statusCode ) ;

		const inCascade = s.idx > 0 ;

		if ( ! isStatusCodeFail && ! inCascade )
		{
			log.debug(
				`event skipped — ${ sessionID }: ${ errName } status=${ statusCode }`
				+ ` cascade=${ inCascade }`
			) ;

			return ;
		}

		log.info(
			`triggering for ${ sessionID }: ${ errName } status=${ statusCode }`
			+ ` cascade=${ inCascade }`
		) ;

		await failover( sessionID ) ;
	}

	/**
	 * Rewinds the chain index on each user message.
	 * Skip during the plugin's own in-flight failover prompt (guarded by busy).
	 *
	 * @param {{ sessionID?: string }} input - The chat message payload.
	 * @returns {void}
	 */
	function onChatMessage( input )
	{
		if ( ! input.sessionID ) return ;

		const s = getSession( input.sessionID ) ;

		if ( s.busy ) return ;

		s.idx = 0 ;
		s.lastError = null ;
		s.triggeredAt = null ;

		log.debug( `chain rewound for ${ input.sessionID }` ) ;
	}

	/**
	 * Cleans up on plugin disposal.
	 *
	 * @returns {void}
	 */
	function onDispose()
	{
		sessions.clear() ;
		log.info( "disposed" ) ;
	}

	return {
		event          : onEvent,
		"chat.message" : onChatMessage,
		dispose        : onDispose
	} ;
}

/**
 *	model-failover.js
 *
 *	OpenCode plugin — intercepts permanent model errors (quota, billing,
 *	auth, rate limits) and fails over through a configured fallback chain.
 *
 *	Design: No persistent session state beyond a chain index counter that
 *	resets on each new user message. Each error cascade advances through
 *	the chain; the next user message restarts from the beginning.
 *
 *	Install:
 *		cp model-failover.js ~/.config/opencode/plugins/model-failover.js
 *
 *	Config: ~/.config/opencode/model-failover.json
 *
 *	@name model-failover
 *	@version 5.0.0
 *	@author Alejandro Carraretto
 *	@license MIT
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs" ;
import { homedir } from "node:os" ;
import { join } from "node:path" ;

// ── Config ─────────────────────────────────────────────

/** Error-message substrings that signal a permanent (non-recoverable) failure. */
const DEFAULT_PATTERNS = [
	"usage limit",
	"quota exceeded",
	"credit balance",
	"billing",
	"free usage",
	"free tier",
	"insufficient quota",
	"payment required",
	"subscription",
	"subscribe to",
	"rate limit",
	"too many requests",
	"model not found",
	"model not supported",
	"unknown model",
	"model does not exist"
] ;

/** Default settings merged with user overrides from model-failover.json. */
const DEFAULT_CONFIG = {
	enabled : true,
	fallbackChain : [ ],
	patterns : DEFAULT_PATTERNS,
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
 * Parses a single fallback-chain entry from the config file.
 *
 * @param {unknown} entry - Raw JSON value.
 * @returns {{ model:string, variant?:string }}
 */
function parseEntry( entry )
{
	if ( typeof entry === "object" && entry !== null )
	{
		return {
			model : typeof entry.model === "string" ? entry.model : "",
			variant : typeof entry.variant === "string" ? entry.variant : undefined
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
			enabled : typeof raw.enabled === "boolean"
				? raw.enabled
				: DEFAULT_CONFIG.enabled,
			fallbackChain : Array.isArray( raw.fallbackChain )
				? raw.fallbackChain.map( parseEntry ).filter( ( e ) => e.model !== "" )
				: [ ...DEFAULT_CONFIG.fallbackChain ],
			patterns : Array.isArray( raw.patterns )
				? raw.patterns.filter( ( p ) => typeof p === "string" )
				: [ ...DEFAULT_CONFIG.patterns ],
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
			( a ) => ( typeof a === "string" ? a : JSON.stringify( a ) )
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

	if ( idx === -1 ) return { providerID : "", modelID : spec } ;

	return {
		providerID : spec.substring( 0, idx ),
		modelID : spec.substring( idx + 1 )
	} ;
}

/**
 * Returns a predicate that checks messages against permanent-error patterns.
 * All matching is case-insensitive.
 *
 * @param {string[]} patterns
 * @returns {( msg:string ) => boolean}
 */
function createMatcher( patterns )
{
	const lower = patterns.map( ( p ) => p.toLowerCase() ) ;

	return ( msg ) => lower.some( ( p ) => msg.toLowerCase().includes( p ) ) ;
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
 * On permanent error: aborts the failing request and re-prompts with the
 * next model in the fallback chain. A single chain-index counter per session
 * advances through the chain; the counter resets on each new user message.
 *
 * @param {Object} params
 * @param {import("@opencode-ai/plugin").Client} params.client
 * @returns {Promise<{ event:Function, "chat.message":Function, dispose:Function }>}
 */
export default async function plugin( { client } )
{
	const config = loadConfig() ;
	const log = createLogger( config.logLevel ) ;
	const isPermanent = createMatcher( config.patterns ) ;

	log.info( "init:", JSON.stringify( config ) ) ;

	if ( ! config.enabled )
	{
		log.info( "disabled" ) ;

		return {} ;
	}

	/** @type {Map<string, number>} Next chain index per session. Reset on each user message. */
	const chainIdx = new Map() ;

	/**
	 * Advances the session one step through the fallback chain.
	 * Each call picks the current entry, increments the index,
	 * aborts the failing request, and re-prompts with the fallback model.
	 * If the re-prompt fails, the next `session.error` event drives
	 * the cascade to the following entry — no internal loop needed.
	 *
	 * @param {string} sessionID
	 * @returns {Promise<void>}
	 */
	async function advanceFailover( sessionID )
	{
		const idx = chainIdx.get( sessionID ) ?? 0 ;
		const entry = config.fallbackChain[ idx ] ;

		if ( ! entry )
		{
			log.error( `chain exhausted for ${ sessionID }` ) ;

			return ;
		}

		const base = parseModel( entry.model ) ;

		if ( ! base.providerID )
		{
			log.error( `bad fallback entry: ${ entry.model }` ) ;

			return ;
		}

		chainIdx.set( sessionID, idx + 1 ) ;

		const label = formatModelLabel( base, entry.variant ) ;

		log.info( `[${ idx }] ${ label }` ) ;

		await client.session.abort( { path : { id : sessionID } } ).catch( () => {} ) ;

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
							text : `✅ Failover to ${ label }`,
							ignored : true
						},
						{ type : "text", text : "Continue." }
					]
				}
			} ) ;
		}
		catch
		{
			log.warn( `re-prompt failed for ${ sessionID } (${ label }), waiting for event` ) ;
		}
	}

	/**
	 * Handles session events.
	 *
	 * - Permanent error (message patterns or 401/402/403/404): starts failover
	 *   from the beginning of the chain.
	 * - Any error while chainIdx > 0 (we are already inside a failover
	 *   cascade): advances to the next entry.
	 *
	 * Each `session.error` event advances one step through the fallback
	 * chain. The cascade is driven by the event system itself: if the
	 * fallback model also fails, its `session.error` fires another step.
	 *
	 * @param {{ event: Object }} params - The OpenCode event payload.
	 * @returns {Promise<void>}
	 */
	async function onEvent( { event } )
	{
		// Clean up state when a session is deleted
		if ( event.type === "session.deleted" )
		{
			const id = event.properties?.info?.id ;
			chainIdx.delete( id ) ;

			return ;
		}

		let sessionID = null ;
		let message = null ;
		let isFailoverSignal = false ;

		// Extract error info from retry or error events
		if ( event.type === "session.status" )
		{
			const p = event.properties ;

			if ( ! p?.sessionID || p?.status?.type !== "retry" || ! p.status.message ) return ;

			sessionID = p.sessionID ;
			message = p.status.message ;
		}
		else if ( event.type === "session.error" )
		{
			const p = event.properties ;

			if ( ! p?.sessionID ) return ;
			if ( p?.error?.name === "MessageAbortedError" ) return ;

			sessionID = p.sessionID ;
			message = p?.error?.data?.message ?? null ;
		}
		else
		{
			return ;
		}

		if ( ! sessionID ) return ;

		if ( message )
		{
			isFailoverSignal = isPermanent( message ) ;
		}

		// Status code 401/402/403 triggers failover regardless of message
		if ( ! isFailoverSignal && event.type === "session.error" )
		{
			const sc = event.properties?.error?.data?.statusCode ;
			isFailoverSignal = sc === 401 || sc === 402 || sc === 403 || sc === 404 ;
		}

		// Any error while the chain index is > 0 (already in a cascade)
		// advances to the next fallback entry — regardless of error type.
		if ( ! isFailoverSignal )
		{
			const currentIdx = chainIdx.get( sessionID ) ?? 0 ;

			if ( currentIdx > 0 )
			{
				log.debug( `cascade error (idx=${ currentIdx }), advancing chain` ) ;
				isFailoverSignal = true ;
			}
		}

		if ( ! isFailoverSignal ) return ;

		await advanceFailover( sessionID ) ;
	}

	/**
	 * Resets the chain index on each user message so the next error
	 * cascade starts from the beginning of the fallback chain.
	 *
	 * @param {{ sessionID?: string }} input - The chat message payload.
	 * @returns {void}
	 */
	function onChatMessage( input )
	{
		if ( input.sessionID ) chainIdx.delete( input.sessionID ) ;
	}

	/**
	 * Cleans up on plugin disposal.
	 *
	 * @returns {void}
	 */
	function onDispose()
	{
		chainIdx.clear() ;
		log.info( "disposed" ) ;
	}

	return {
		event        : onEvent,
		"chat.message" : onChatMessage,
		dispose      : onDispose
	} ;
}

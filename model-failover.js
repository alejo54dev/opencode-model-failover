/**
 *	model-failover.js
 *
 *	OpenCode plugin — intercepts permanent model errors (quota, billing,
 *	auth, rate limits, unknown models) and fails over through a configured
 *	chain of models.
 *
 *	Design:
 *	  - event hook:       ONLY detects permanent errors (single responsibility)
 *	  - advanceFailover:  drives the failover mechanics (abort + re-prompt)
 *	  - chat.message:     resets the failover chain for a fresh user message
 *	  - inProgress guard per session prevents re-entrancy from rapid-fire events
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
	enabled  : true,
	models   : [ ],
	patterns : DEFAULT_PATTERNS,
	logLevel : "info"
} ;

/**
 *	Returns the absolute path to the OpenCode config directory.
 *
 *	@returns {string}
 */
function getConfigDir()
{
	const xdg = process.env.XDG_CONFIG_HOME ?? join( homedir(), ".config" ) ;

	return join( xdg, "opencode" ) ;
}

/**
 *	Parses a single model entry from the config file.
 *
 *	@param {unknown} entry - Raw JSON value.
 *	@returns {{ model:string, variant?:string }}
 */
function parseEntry( entry )
{
	if ( typeof entry == "object" && entry != null )
	{
		return {
			model   : typeof entry.model == "string" ? entry.model : "",
			variant : typeof entry.variant == "string" ? entry.variant : undefined
		} ;
	}

	return { model : "", variant : undefined } ;
}

/**
 *	Loads and validates the plugin config from disk.
 *	Falls back to defaults on missing or invalid values.
 *
 *	@returns {typeof DEFAULT_CONFIG}
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
			patterns : Array.isArray( raw.patterns )
				? raw.patterns.filter( ( p ) => typeof p == "string" )
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

const LOG_RANK = { error : 0, info : 1, debug : 2 } ;

/**
 *	File-based logger that appends to model-failover.log.
 *
 *	@param {"error"|"info"|"debug"} level - Minimum level to emit.
 *	@returns {{ error:Function, info:Function, debug:Function }}
 */
function createLogger( level )
{
	const min = LOG_RANK[ level ] ?? 1 ;

	function write( lvl, ...args )
	{
		if ( LOG_RANK[ lvl ] > min ) return ;

		const ts = new Date().toISOString() ;
		const body = args.map( ( a ) => ( typeof a == "string" ? a : JSON.stringify( a ) ) ).join( " " ) ;

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
 *	Splits a "providerID/modelID" string into its two parts.
 *
 *	@param {string} spec - e.g. "openai/gpt-4".
 *	@returns {{ providerID:string, modelID:string }}
 */
function parseModel( spec )
{
	const idx = spec.indexOf( "/" ) ;

	if ( idx == -1 ) return { providerID : "", modelID : spec } ;

	return {
		providerID : spec.substring( 0, idx ),
		modelID    : spec.substring( idx + 1 )
	} ;
}

/**
 *	Returns a predicate that checks messages against permanent-error patterns.
 *	All matching is case-insensitive.
 *
 *	@param {string[]} patterns
 *	@returns {( msg:string ) => boolean}
 */
function createMatcher( patterns )
{
	const lower = patterns.map( ( p ) => p.toLowerCase() ) ;

	return ( msg ) => lower.some( ( p ) => msg.toLowerCase().includes( p ) ) ;
}

/**
 *	Formats a model as "providerID/modelID:variant".
 *
 *	@param {{ providerID:string, modelID:string }} base
 *	@param {string} [variant]
 *	@returns {string}
 */
function formatModelLabel( base, variant )
{
	return `${ base.providerID }/${ base.modelID }${ variant ? ":" + variant : "" }` ;
}

// ── Plugin ─────────────────────────────────────────────

/**
 *	Plugin entry point.
 *
 *	Responsibilities:
 *	  - event hook:       detect permanent errors, hand off to advanceFailover
 *	  - advanceFailover:  abort failing request, re-prompt with next model
 *	  - chat.message:     reset failover chain for a new user message
 *
 *	@param {Object} params
 *	@param {import("@opencode-ai/plugin").Client} params.client
 *	@returns {Promise<{ event:Function, "chat.message":Function, dispose:Function }>}
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

	/**
	 *	Per-session failover state.
	 *
	 *	@type {Map<string, { attempts:number, inProgress:boolean }>}
	 */
	const sessions = new Map() ;

	/**
	 *	True while the plugin is inside advanceFailover — prevents
	 *	chat.message from resetting state for messages the plugin
	 *	itself sends via session.prompt.
	 */
	let isFailoverActive = false ;

	/**
	 *	Advances the session one step through the failover chain.
	 *
	 *	1. Picks models[s.attempts]
	 *	2. Increments attempts
	 *	3. Aborts the current request
	 *	4. Re-prompts with the selected model (or exhausted message)
	 *
	 *	@param {string} sessionID
	 *	@returns {Promise<void>}
	 */
	async function advanceFailover( sessionID )
	{
		const s = sessions.get( sessionID ) ;

		if ( ! s || s.inProgress ) return ;

		s.inProgress = true ;

		try
		{
			// Loop through the chain until we find a valid entry or exhaust it
			while ( true )
			{
				const entry = config.models[ s.attempts ] ;

				// ── Chain exhausted ─────────────────
				if ( ! entry )
				{
					log.error( `chain exhausted for ${ sessionID }` ) ;

					s.attempts = -1 ;

					await client.session.abort( { path : { id : sessionID } } ).catch( () => {} ) ;

					isFailoverActive = true ;

					await client.session.prompt( {
						path : { id : sessionID },
						body : {
							parts : [
								{ type : "text", text : "❌ Failover chain exhausted." }
							]
						}
					} ).catch( () => {} ) ;

					isFailoverActive = false ;

					return ;
				}

				// ── Validate entry ──────────────────
				const base = parseModel( entry.model ) ;

				if ( ! base.providerID )
				{
					log.error( `bad model entry: ${ entry.model }` ) ;
					s.attempts++ ;

					continue ; // skip to next entry
				}

				// ── Advance & re-prompt ─────────────
				const label = formatModelLabel( base, entry.variant ) ;
				const idx = s.attempts ;

				s.attempts++ ;

				log.info( `[${ idx }] ${ label }` ) ;

				await client.session.abort( { path : { id : sessionID } } ).catch( () => {} ) ;

				isFailoverActive = true ;

				try
				{
					await client.session.prompt( {
						path : { id : sessionID },
						body : {
							model : {
								providerID : base.providerID,
								modelID    : base.modelID,
								variant    : entry.variant
							},
							parts : [
								{
									type    : "text",
									text    : `✅ Failover to [${ label }]`,
									ignored : true
								},
								{ type : "text", text : "Continue." }
							]
						}
					} ) ;
				}
				catch
				{
					log.error( `re-prompt failed for ${ sessionID } (${ label })` ) ;
				}

				isFailoverActive = false ;

				return ;
			}
		}
		finally
		{
			s.inProgress = false ;
		}
	}

	// ── Hooks ────────────────────────────────────────

	return {
		/**
		 *	Handles session events.
		 *
		 *	session.deleted — cleans up session state.
		 *	session.error   — detects permanent errors and starts failover.
		 *
		 *	Only listens to session.error (not session.status retry) to avoid
		 *	double-processing the same error. The inProgress guard per session
		 *	prevents re-entrancy from rapid-fire events.
		 */
		event : async ( { event } ) =>
		{
			if ( event.type == "session.deleted" )
			{
				sessions.delete( event.properties?.info?.id ) ;

				return ;
			}

			if ( event.type != "session.error" ) return ;

			const sessionID = event.properties?.sessionID ;

			if ( ! sessionID ) return ;

			// Ignore aborts we caused ourselves
			if ( event.properties?.error?.name == "MessageAbortedError" ) return ;

			// Init session state on first error
			if ( ! sessions.has( sessionID ) )
			{
				sessions.set( sessionID, { attempts : 0, inProgress : false } ) ;
			}

			const s = sessions.get( sessionID ) ;

			// Already processing a failover for this session
			if ( s.inProgress ) return ;

			// Chain was exhausted; wait for next user message to reset
			if ( s.attempts == -1 ) return ;

			// Extract error info
			const err = event.properties?.error?.data ;
			const msg = err?.message ?? "" ;

			let shouldFailover = isPermanent( msg ) ;

			// Status codes that always trigger failover
			if ( ! shouldFailover )
			{
				const sc = err?.statusCode ;
				shouldFailover = sc == 401 || sc == 402 || sc == 403 || sc == 404 ;
			}

			if ( ! shouldFailover ) return ;

			log.error( `permanent: ${ msg }` ) ;

			await advanceFailover( sessionID ) ;
		},

		/**
		 *	Resets the failover chain on each new user message.
		 *
		 *	Does NOT reset when isFailoverActive is true (i.e. when the plugin
		 *	itself is sending a prompt during failover).
		 *
		 *	@param {{ sessionID?:string }} input
		 *	@returns {void}
		 */
		"chat.message" : ( input ) =>
		{
			if ( ! input.sessionID || isFailoverActive ) return ;

			sessions.set( input.sessionID, { attempts : 0, inProgress : false } ) ;
		},

		/**
		 *	Cleans up on plugin disposal.
		 *
		 *	@returns {void}
		 */
		dispose : () =>
		{
			sessions.clear() ;
			log.info( "disposed" ) ;
		}
	} ;
}

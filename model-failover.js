#!/usr/bin/env node
/**
*	model-failover.js
*
*	Single-file OpenCode plugin that switches the active model to a
*	configured fallback when the current model fails (rate limit, quota
*	exhaustion, auth error, network failure, etc.).
*
*	Behavior:
*	- Intercepts `session.status` with type "retry" and a permanent error
*	  pattern to trigger immediate failover, skipping OpenCode's native
*	  retry countdown.
*	- Classifies errors as permanent or transient based on status code,
*	  retryable flag, and message patterns.
*	- Picks the next eligible fallback from the chain (skipping cooldowns
*	  and the current model).
*	- Overrides the next `chat.message` for the session with the new model
*	  and annotates the message summary so the user sees a transparent
*	  notice in the chat output.
*	- Surfaces a TUI toast on every failover outcome.
*	- Logs every decision to `~/.config/opencode/model-failover.log` with
*	  error/info/debug levels.
*
*	Install:
*		cp model-failover.js ~/.config/opencode/plugins/model-failover.js
*
*	Config:
*		~/.config/opencode/model-failover.json
*
*	@module opencode-model-failover
*	@author Alejandro Carraretto
*	@license MIT
*/

import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/*************************************************************
 *	Constants
 *************************************************************/

/**
*	HTTP status codes that force immediate failover.
*	@type {ReadonlySet<number>}
*/
const IMMEDIATE_STATUS_CODES = new Set( [ 401, 402, 403 ] )

/**
*	HTTP status codes that may succeed on retry.
*	@type {ReadonlySet<number>}
*/
const RETRYABLE_STATUS_CODES = new Set( [ 429, 500, 502, 503, 504, 529 ] )

/**
*	Milliseconds to wait after aborting a session before continuing.
*	@type {number}
*/
const ABORT_DELAY_MS = 300

/**
*	Milliseconds between cleanup sweeps for stale cooldowns and sessions.
*	@type {number}
*/
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000

/**
*	How long a session entry is kept in memory without activity.
*	@type {number}
*/
const SESSION_TTL_MS = 10 * 60 * 1000

/**
*	Error message substrings that indicate a permanent failure.
*	@type {readonly string[]}
*/
const PERMANENT_ERROR_PATTERNS = [
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
]

/**
*	Error message substrings that indicate a transient failure.
*	@type {readonly string[]}
*/
const TRANSIENT_ERROR_PATTERNS = [
	"overloaded",
	"capacity exceeded",
	"econnrefused",
	"econnreset",
	"epipe",
	"etimedout",
	"eai_again",
	"fetch failed",
	"connection refused",
	"connection reset",
	"socket hang up",
	"network error",
	"internal server error",
	"service unavailable",
	"bad gateway",
	"gateway timeout",
]

/**
*	Canonical log level rank used to filter messages.
*	@type {Readonly<Record<string, number>>}
*/
const LOG_RANK = { error : 0, info : 1, debug : 2 }

/*************************************************************
 *	Config
 *************************************************************/

/**
*	Fallback model entry from the user config.
*	@typedef {Object} FallbackEntry
*	@property {string} model     "providerID/modelID" string.
*	@property {string} [variant] Optional capability tier (max/high/medium/low).
*/

/**
*	Resolved plugin configuration.
*	@typedef {Object} FailoverConfig
*	@property {boolean}             enabled        Master switch.
*	@property {FallbackEntry[]}     fallbackChain  Ordered list of fallbacks.
*	@property {number}              maxRetries     Auto-retries before failover.
*	@property {number}              cooldownMs     Cooldown per failed model.
*	@property {"error"|"info"|"debug"} logLevel     Logger verbosity.
*	@property {boolean}             healthCheck    Probe each model before picking.
*/

/**
*	Default config used when the file is missing or malformed.
*	@type {FailoverConfig}
*/
const DEFAULT_CONFIG = {
	enabled : true,
	fallbackChain : [],
	maxRetries : 2,
	cooldownMs : 30_000,
	logLevel : "info",
	healthCheck : false,
}

/**
*	Resolve the OpenCode config directory following XDG.
*	@return {string} Absolute path to the opencode config dir.
*/
function getConfigDir()
{
	const xdg = process.env.XDG_CONFIG_HOME ?? join( homedir(), ".config" )
	return join( xdg, "opencode" )
}

/**
*	Build a composite model key string.
*	@param {string} providerID Provider identifier.
*	@param {string} modelID    Model identifier.
*	@return {string} "providerID/modelID".
*/
function modelKey( providerID, modelID )
{
	return `${ providerID }/${ modelID }`
}

/**
*	Parse a "providerID/modelID" string.
*	@param {string} spec Model string.
*	@return {{providerID: string, modelID: string}} Empty providerID on parse failure.
*/
function parseModel( spec )
{
	const idx = spec.indexOf( "/" )
	if ( idx === -1 )
	{
		return { providerID : "", modelID : spec }
	}
	return {
		providerID : spec.substring( 0, idx ),
		modelID : spec.substring( idx + 1 ),
	}
}

/**
*	Coerce a raw config entry into a FallbackEntry.
*	@param {unknown} entry Raw value from the JSON config.
*	@return {FallbackEntry} Entry with empty model string on invalid input.
*/
function parseFallbackEntry( entry )
{
	if ( typeof entry === "string" )
	{
		return { model : entry }
	}
	if ( typeof entry === "object" && entry !== null )
	{
		const obj = /** @type {Record<string, unknown>} */ ( entry )
		const model = typeof obj.model === "string" ? obj.model : ""
		const variant = typeof obj.variant === "string" ? obj.variant : undefined
		return { model, variant }
	}
	return { model : "" }
}

/**
*	Load and validate the plugin config from disk.
*	@return {FailoverConfig} Parsed config with defaults applied.
*/
function loadConfig()
{
	const configPath = join( getConfigDir(), "model-failover.json" )
	if ( ! existsSync( configPath ) )
	{
		return { ...DEFAULT_CONFIG }
	}
	try
	{
		const raw = JSON.parse( readFileSync( configPath, "utf-8" ) )
		const logLevel = raw.logLevel
		return {
			enabled : typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
			fallbackChain : Array.isArray( raw.fallbackChain )
				? raw.fallbackChain.map( parseFallbackEntry ).filter( ( e ) => e.model !== "" )
				: [ ...DEFAULT_CONFIG.fallbackChain ],
			maxRetries : typeof raw.maxRetries === "number"
				? Math.max( 0, Math.floor( raw.maxRetries ) )
				: DEFAULT_CONFIG.maxRetries,
			cooldownMs : typeof raw.cooldownMs === "number"
				? Math.max( 0, Math.floor( raw.cooldownMs ) )
				: DEFAULT_CONFIG.cooldownMs,
			logLevel : [ "error", "info", "debug" ].includes( logLevel )
				? logLevel
				: DEFAULT_CONFIG.logLevel,
			healthCheck : typeof raw.healthCheck === "boolean"
				? raw.healthCheck
				: DEFAULT_CONFIG.healthCheck,
		}
	}
	catch
	{
		return { ...DEFAULT_CONFIG }
	}
}

/*************************************************************
 *	Logger
 *************************************************************/

/**
*	Current log level (mutable via setLogLevel).
*	@type {"error"|"info"|"debug"}
*/
let currentLogLevel = "info"

/**
*	Set the current log level. Messages below this rank are dropped.
*	@param {"error"|"info"|"debug"} level New log level.
*	@return {void}
*/
function setLogLevel( level )
{
	currentLogLevel = level
}

/**
*	Resolve the log file path.
*	@return {string} Absolute path to model-failover.log.
*/
function getLogPath()
{
	return join( getConfigDir(), "model-failover.log" )
}

/**
*	Append a log entry to the plugin log file.
*	@param {"error"|"info"|"debug"} level Severity level.
*	@param {...unknown} args        Values to log.
*	@return {void}
*/
function log( level, ...args )
{
	if ( LOG_RANK[ level ] > LOG_RANK[ currentLogLevel ] ) return
	const timestamp = new Date().toISOString()
	const prefix = level === "error" ? "ERR" : level === "info" ? "INF" : "DBG"
	const body = args
		.map( ( a ) => typeof a === "string" ? a : JSON.stringify( a ) )
		.join( " " )
	try
	{
		appendFileSync( getLogPath(), `[${ timestamp }] [${ prefix }] [model-failover] ${ body }\n` )
	}
	catch
	{

	}
}

/*************************************************************
 *	State
 *************************************************************/

/**
*	Per-session failover state.
*	@typedef {Object} SessionState
*	@property {{providerID:string, modelID:string, variant?:string}|undefined} originalModel  Snapshot at first chat.message.
*	@property {{providerID:string, modelID:string, variant?:string}|undefined} failoverModel Active override.
*	@property {boolean}       failoverInProgress Guards against concurrent execution.
*	@property {number}        createdAt          Creation timestamp.
*	@property {number}        lastFailoverAt     Last failover timestamp.
*/

/**
*	Map of sessionID -> state.
*	@type {Map<string, SessionState>}
*/
const sessions = new Map()

/**
*	Map of modelKey -> cooldown expiry timestamp.
*	@type {Map<string, number>}
*/
const modelCooldowns = new Map()

/**
*	Pending cooldown cleanup timers.
*	@type {Map<string, NodeJS.Timeout>}
*/
const cooldownTimers = new Map()

/**
*	Get or create the session state entry.
*	@param {string} sessionID Session identifier.
*	@return {SessionState} Session state.
*/
function ensureSession( sessionID )
{
	let s = sessions.get( sessionID )
	if ( ! s )
	{
		s = {
			originalModel : undefined,
			failoverModel : undefined,
			failoverInProgress : false,
			createdAt : Date.now(),
			lastFailoverAt : 0,
		}
		sessions.set( sessionID, s )
	}
	return s
}

/**
*	Clear the failover override for a session.
*	@param {SessionState} s Session state to reset.
*	@return {void}
*/
function clearFailover( s )
{
	s.failoverModel = undefined
}

/**
*	Whether a model is currently in cooldown.
*	@param {{providerID:string, modelID:string}} m Model reference.
*	@return {boolean} True if cooldown has not yet expired.
*/
function isModelInCooldown( m )
{
	const key = modelKey( m.providerID, m.modelID )
	const expiry = modelCooldowns.get( key )
	if ( expiry === undefined ) return false
	if ( Date.now() < expiry ) return true
	modelCooldowns.delete( key )
	return false
}

/**
*	Mark a model as failed and start its cooldown.
*	@param {{providerID:string, modelID:string}} m  Model reference.
*	@param {number}                                ms Cooldown duration.
*	@return {void}
*/
function markModelCooldown( m, ms )
{
	const key = modelKey( m.providerID, m.modelID )
	modelCooldowns.set( key, Date.now() + ms )

	const previous = cooldownTimers.get( key )
	if ( previous !== undefined ) clearTimeout( previous )
	const timer = setTimeout( () =>
	{
		modelCooldowns.delete( key )
		cooldownTimers.delete( key )
	}, ms )
	if ( typeof timer.unref === "function" ) timer.unref()
	cooldownTimers.set( key, timer )
}

/**
*	Sweep stale sessions and any leftover cooldown entries.
*	@return {void}
*/
function cleanupStaleState()
{
	const now = Date.now()
	for ( const [ id, state ] of sessions )
	{
		if ( state.failoverInProgress ) continue
		if ( now - state.createdAt >= SESSION_TTL_MS ) sessions.delete( id )
	}
}

/*************************************************************
 *	Classification
 *************************************************************/

/**
*	Check whether a message matches a permanent error pattern.
*	@param {string} msg Error message.
*	@return {boolean} True if any pattern matches.
*/
function isPermanentError( msg )
{
	const lower = msg.toLowerCase()
	return PERMANENT_ERROR_PATTERNS.some( ( p ) => lower.includes( p ) )
}

/**
*	Check whether a message matches a transient error pattern.
*	@param {string} msg Error message.
*	@return {boolean} True if any pattern matches.
*/
function isTransientError( msg )
{
	const lower = msg.toLowerCase()
	return TRANSIENT_ERROR_PATTERNS.some( ( p ) => lower.includes( p ) )
}

/**
*	Classify an error as immediate (failover) or retry (wait).
*	@param {number|undefined} statusCode HTTP status code.
*	@param {boolean|undefined} isRetryable Provider-reported flag.
*	@param {string|undefined} message    Error message.
*	@return {"immediate"|"retry"} Decision.
*/
function classifyError( statusCode, isRetryable, message )
{
	if ( statusCode !== undefined && IMMEDIATE_STATUS_CODES.has( statusCode ) )
	{
		return "immediate"
	}
	if ( message && isPermanentError( message ) )
	{
		return "immediate"
	}
	if ( isRetryable === false ) return "immediate"
	if ( isRetryable === true ) return "retry"
	if ( statusCode !== undefined && RETRYABLE_STATUS_CODES.has( statusCode ) )
	{
		return "retry"
	}
	if ( message && isTransientError( message ) ) return "retry"
	return "immediate"
}

/*************************************************************
 *	Failover core
 *************************************************************/

/**
*	Pick the next eligible fallback entry.
*	Skips the current model, models in cooldown, and invalid specs.
*	@param {SessionState}        s     Session state.
*	@param {FallbackEntry[]}     chain Ordered fallback entries.
*	@return {FallbackEntry|null} First eligible entry or null.
*/
function pickNext( s, chain )
{
	const current = s.originalModel
	for ( const entry of chain )
	{
		const base = parseModel( entry.model )
		if ( ! base.providerID )
		{
			log( "error", `invalid fallback spec: ${ entry.model }` )
			continue
		}
		if ( current && current.providerID === base.providerID && current.modelID === base.modelID )
		{
			log( "debug", `skipping fallback matching current model: ${ entry.model }` )
			continue
		}
		if ( isModelInCooldown( base ) )
		{
			log( "debug", `skipping fallback in cooldown: ${ entry.model }` )
			continue
		}
		return entry
	}
	return null
}

/**
*	Abort the session stream and wait for it to settle.
*	@param {string}                                  sessionID Session to abort.
*	@param {ReturnType<typeof import("@opencode-ai/sdk").createOpencodeClient>} client SDK client.
*	@return {Promise<void>} Resolves when abort completes (or fails silently).
*/
async function abortSession( sessionID, client )
{
	try
	{
		await client.session.abort( { path : { id : sessionID } } )
		await new Promise( ( r ) => setTimeout( r, ABORT_DELAY_MS ) )
	}
	catch
	{

	}
}

/**
*	Display a TUI toast and log the outcome.
*	@param {ReturnType<typeof import("@opencode-ai/sdk").createOpencodeClient>} client SDK client.
*	@param {{title:string, message:string, variant:"info"|"warning"|"error", duration?:number}} body Toast body.
*	@return {Promise<void>}
*/
async function toast( client, body )
{
	try
	{
		await client.tui.showToast( { body } )
	}
	catch
	{

	}
}

/**
*	Execute a full failover for a session: abort, pick, set state, notify.
*	Guarded against concurrent execution per session.
*	@param {string}       sessionID Target session.
*	@param {string}       reason    Human-readable trigger reason.
*	@param {FailoverConfig} config  Plugin config.
*	@param {ReturnType<typeof import("@opencode-ai/sdk").createOpencodeClient>} client SDK client.
*	@return {Promise<void>}
*/
async function executeFailover( sessionID, reason, config, client )
{
	const s = ensureSession( sessionID )
	if ( s.failoverInProgress ) return
	s.failoverInProgress = true
	try
	{
		if ( ! s.originalModel )
		{
			log( "error", `failover requested but original model unknown for session ${ sessionID }` )
			return
		}

		await abortSession( sessionID, client )

		const next = pickNext( s, config.fallbackChain )
		if ( ! next )
		{
			log( "error", `fallback chain exhausted for session ${ sessionID }` )
			await toast( client, {
				title : "Failover",
				message : `Fallback chain exhausted for session ${ sessionID }`,
				variant : "error",
			} )
			return
		}

		const base = parseModel( next.model )
		s.failoverModel = {
			providerID : base.providerID,
			modelID : base.modelID,
			variant : next.variant,
		}
		s.lastFailoverAt = Date.now()

		const fromKey = modelKey( s.originalModel.providerID, s.originalModel.modelID )
		const toKey = modelKey( s.failoverModel.providerID, s.failoverModel.modelID )
		log( "info", `failover (${ reason }): ${ fromKey } -> ${ toKey }` )

		await toast( client, {
			title : "Failover",
			message : `Switched to ${ toKey } (was ${ fromKey })`,
			variant : "warning",
			duration : 5000,
		} )
	}
	finally
	{
		s.failoverInProgress = false
	}
}

/*************************************************************
 *	Event handlers
 *************************************************************/

/**
*	Handle OpenCode events.
*	@param {{event:any}} input Hook input.
*	@param {FailoverConfig} config Plugin config.
*	@param {ReturnType<typeof import("@opencode-ai/sdk").createOpencodeClient>} client SDK client.
*	@return {Promise<void>}
*/
async function handleEvent( input, config, client )
{
	const event = input.event
	log( "debug", `event: ${ event.type }` )

	if ( event.type === "session.deleted" )
	{
		const props = event.properties
		if ( props?.info?.id )
		{
			sessions.delete( props.info.id )
		}
		return
	}

	if ( event.type === "session.error" )
	{
		const props = event.properties
		const sessionID = props?.sessionID
		if ( ! sessionID ) return

		const err = props?.error
		if ( ! err || ! err.data ) return
		if ( err.name === "MessageAbortedError" ) return

		const isAuth = err.name === "ProviderAuthError"
		const isNotFound = err.name === "ProviderModelNotFoundError"
		const action = classifyError(
			err.data.statusCode,
			isAuth || isNotFound ? false : err.data.isRetryable,
			err.data.message,
		)
		log( action === "immediate" ? "error" : "info", `session.error: ${ err.data.message }` )
		if ( action === "immediate" )
		{
			const s = ensureSession( sessionID )
			markModelCooldown( s.originalModel ?? { providerID : "", modelID : "" }, config.cooldownMs )
			await executeFailover( sessionID, "session.error", config, client )
		}
		return
	}

	if ( event.type === "session.status" )
	{
		const props = event.properties
		if ( props?.status?.type !== "retry" || ! props.status.message ) return

		const sessionID = props.sessionID
		const message = props.status.message
		const attempt = props.status.attempt ?? 1

		if ( isPermanentError( message ) )
		{
			log( "error", `permanent retry status (session ${ sessionID }): ${ message }` )
			const s = ensureSession( sessionID )
			markModelCooldown( s.originalModel ?? { providerID : "", modelID : "" }, config.cooldownMs )
			await executeFailover( sessionID, "permanent_status", config, client )
			return
		}

		if ( isTransientError( message ) )
		{
			if ( attempt < config.maxRetries )
			{
				log( "debug", `transient retry ${ attempt }/${ config.maxRetries } (session ${ sessionID })` )
				return
			}
			log( "error", `transient retries exhausted (session ${ sessionID }) (${ attempt }/${ config.maxRetries })` )
			const s = ensureSession( sessionID )
			markModelCooldown( s.originalModel ?? { providerID : "", modelID : "" }, config.cooldownMs )
			await executeFailover( sessionID, "transient_exhausted", config, client )
			return
		}

		log( "error", `unknown retry status (session ${ sessionID }): ${ message }` )
		const s = ensureSession( sessionID )
		markModelCooldown( s.originalModel ?? { providerID : "", modelID : "" }, config.cooldownMs )
		await executeFailover( sessionID, "unknown_status", config, client )
	}
}

/*************************************************************
 *	chat.message hook
 *************************************************************/

/**
*	Override the model on a chat.message when a failover is active.
*	Only resets the failover if the user picks a third model (neither
*	the original nor the failover).
*	@param {{sessionID?:string, model?:{providerID:string, modelID:string}, variant?:string}} input  Hook input.
*	@param {{message:any, parts:any[]}} output Hook output (mutated).
*	@param {FailoverConfig} _config Plugin config (unused, kept for parity).
*	@return {Promise<void>}
*/
async function handleChatMessage( input, output, _config )
{
	if ( ! input.sessionID ) return

	const s = ensureSession( input.sessionID )

	if ( input.model )
	{
		const incoming = {
			providerID : input.model.providerID,
			modelID : input.model.modelID,
			variant : input.variant,
		}
		if ( ! s.originalModel )
		{
			s.originalModel = { ...incoming }
		}
		else
		{
			const isOriginal = incoming.providerID === s.originalModel.providerID
				&& incoming.modelID === s.originalModel.modelID
			const isFailover = s.failoverModel
				&& incoming.providerID === s.failoverModel.providerID
				&& incoming.modelID === s.failoverModel.modelID

			if ( ! isOriginal && ! isFailover )
			{
				if ( s.failoverModel )
				{
					log( "info", `user switched to a third model, clearing failover for session ${ input.sessionID }` )
					clearFailover( s )
				}
				s.originalModel = { ...incoming }
			}
		}
	}

	if ( ! s.failoverModel ) return

	const fromKey = s.originalModel
		? modelKey( s.originalModel.providerID, s.originalModel.modelID )
		: "unknown"
	const toKey = modelKey( s.failoverModel.providerID, s.failoverModel.modelID )
	const variant = s.failoverModel.variant

	log( "debug", `chat.message override (session ${ input.sessionID }): ${ fromKey } -> ${ toKey }` )

	output.message.model = {
		providerID : s.failoverModel.providerID,
		modelID : s.failoverModel.modelID,
	}
	if ( variant !== undefined ) output.message.variant = variant

	output.message.summary = output.message.summary ?? { diffs : [] }
	const fromLabel = s.originalModel
		? `${ fromKey }${ s.originalModel.variant ? ` (${ s.originalModel.variant })` : "" }`
		: fromKey
	const toLabel = `${ toKey }${ variant ? ` (${ variant })` : "" }`
	output.message.summary.body = `⬆️ Failover: ${ fromLabel } → ${ toLabel }`
}

/*************************************************************
 *	Plugin entry
 *************************************************************/

/**
*	OpenCode plugin entry point.
*	@param {{client: ReturnType<typeof import("@opencode-ai/sdk").createOpencodeClient>, project:any, directory:string, worktree:string, serverUrl:URL, $:any, experimental_workspace:any}} input Plugin input.
*	@return {Promise<{event?:Function, "chat.message"?:Function, dispose?:Function}>} Hook set.
*/
export default async function plugin( input )
{
	const { client } = input
	const config = loadConfig()
	setLogLevel( config.logLevel )
	log( "info", "initialized:", JSON.stringify( config ) )

	if ( ! config.enabled )
	{
		log( "info", "plugin disabled, no hooks installed" )
		return {}
	}

	const cleanupTimer = setInterval( cleanupStaleState, CLEANUP_INTERVAL_MS )
	if ( typeof cleanupTimer.unref === "function" ) cleanupTimer.unref()

	return {
		event : ( payload ) => handleEvent( payload, config, client ),
		"chat.message" : ( i, o ) => handleChatMessage( i, o, config ),
		dispose : async () =>
		{
			clearInterval( cleanupTimer )
			for ( const t of cooldownTimers.values() ) clearTimeout( t )
			cooldownTimers.clear()
		},
	}
}

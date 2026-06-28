/**
 *	model-failover.js
 *
 *	OpenCode plugin that intercepts permanent model errors and fails over
 *	through a configured chain of fallback models.
 *
 *	Install:
 *		cp model-failover.js ~/.config/opencode/plugins/model-failover.js
 *
 *	Config: ~/.config/opencode/model-failover.json
 *
 *	@name model-failover
 *	@version 4.0.0
 *	@author Alejandro Carraretto
 *	@license MIT
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs" ;
import { homedir } from "node:os" ;
import { join } from "node:path" ;

// ── Config ─────────────────────────────────────────────

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
	"too many requests"
] ;

const DEFAULT_CONFIG = {
	enabled : true,
	fallbackChain : [ ],
	cooldownMs : 30_000,
	patterns : DEFAULT_PATTERNS,
	logLevel : "info"
} ;

function getConfigDir()
{
	const xdg = process.env.XDG_CONFIG_HOME ?? join( homedir(), ".config" ) ;

	return join( xdg, "opencode" ) ;
}

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
			enabled : typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
			fallbackChain : Array.isArray( raw.fallbackChain )
				? raw.fallbackChain.map( parseEntry ).filter( ( e ) => e.model !== "" )
				: [ ...DEFAULT_CONFIG.fallbackChain ],
			cooldownMs : typeof raw.cooldownMs === "number"
				? Math.max( 0, Math.floor( raw.cooldownMs ) )
				: DEFAULT_CONFIG.cooldownMs,
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

const LOG_RANK = { error : 0, info : 1, debug : 2 } ;

function createLogger( level )
{
	const min = LOG_RANK[ level ] ?? 1 ;

	function write( lvl, ...args )
	{
		if ( LOG_RANK[ lvl ] > min ) return ;

		const ts = new Date().toISOString() ;
		const body = args.map( ( a ) => ( typeof a === "string" ? a : JSON.stringify( a ) ) ).join( " " ) ;

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
		info : ( ...args ) => write( "info", ...args ),
		debug : ( ...args ) => write( "debug", ...args )
	} ;
}

// ── Helpers ────────────────────────────────────────────

function parseModel( spec )
{
	const idx = spec.indexOf( "/" ) ;

	if ( idx === -1 ) return { providerID : "", modelID : spec } ;

	return {
		providerID : spec.substring( 0, idx ),
		modelID : spec.substring( idx + 1 )
	} ;
}

function modelKey( ref )
{
	return `${ ref.providerID }/${ ref.modelID }` ;
}

function createMatcher( patterns )
{
	const lower = patterns.map( ( p ) => p.toLowerCase() ) ;

	return ( msg ) => lower.some( ( p ) => msg.toLowerCase().includes( p ) ) ;
}

function displayModelID( ref )
{
	return ref.modelID + (ref.variant ? `:${ ref.variant }` : "") ;
}

function formatDisplayModel( ref )
{
	return {
		providerID : ref.providerID,
		modelID : ref.modelID,
		variant : ref.variant
	} ;
}

function formatModelLabel( ref )
{
	return `${ ref.providerID }/${ displayModelID( ref ) }` ;
}

// ── Plugin ─────────────────────────────────────────────

/**
 *	@typedef {{ providerID:string, modelID:string }} ModelRef
 *	@typedef {{ providerID:string, modelID:string, variant?:string }} ModelRefWithVariant
 *	@typedef {{ model:string, variant?:string }} FallbackEntry
 *	@typedef {{ currentModel?:ModelRefWithVariant, failoverModel?:ModelRefWithVariant, failoverError?:string, failoverInProgress:boolean }} SessionState
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

	/** @type {Map<string, SessionState>} */
	const sessions = new Map() ;

	/** @type {Map<string, number>} */
	const cooldowns = new Map() ;

	function ensureSession( id )
	{
		let s = sessions.get( id ) ;

		if ( ! s )
		{
			s = { failoverInProgress : false } ;
			sessions.set( id, s ) ;
		}

		return s ;
	}

	function isInCooldown( ref )
	{
		const key = modelKey( ref ) ;
		const expiry = cooldowns.get( key ) ;

		if ( expiry === undefined ) return false ;
		if ( Date.now() < expiry ) return true ;

		cooldowns.delete( key ) ;

		return false ;
	}

	function pickFallback( current, chain )
	{
		for ( const entry of chain )
		{
			const base = parseModel( entry.model ) ;

			if ( ! base.providerID )
			{
				log.error( `bad entry: ${ entry.model }` ) ;

				continue ;
			}

			if ( current && current.providerID === base.providerID && current.modelID === base.modelID )
			{
				log.debug( `skip current: ${ entry.model }` ) ;

				continue ;
			}

			if ( isInCooldown( base ) )
			{
				log.debug( `skip cooldown: ${ entry.model }` ) ;

				continue ;
			}

			return entry ;
		}

		return null ;
	}

	async function failover( sessionID, reason, current )
	{
		const s = ensureSession( sessionID ) ;

		if ( s.failoverInProgress ) return ;

		s.failoverInProgress = true ;

		try
		{
			cooldowns.set( modelKey( current ), Date.now() + config.cooldownMs ) ;
			log.debug( `cooldown ${ modelKey( current ) } ${ config.cooldownMs }ms` ) ;

			const next = pickFallback( current, config.fallbackChain ) ;

			if ( ! next )
			{
				log.error( `chain exhausted for ${ sessionID }` ) ;

				s.failoverError = `❌ Failover: no fallback for ${ modelKey( current ) }` ;

				return ;
			}

			const base = parseModel( next.model ) ;

			s.failoverModel = {
				providerID : base.providerID,
				modelID : base.modelID,
				variant : next.variant
			} ;

			// Prevent reselecting this fallback if it also fails
			cooldowns.set( modelKey( base ), Date.now() + config.cooldownMs ) ;
			log.debug( `cooldown ${ modelKey( base ) } ${ config.cooldownMs }ms` ) ;

			const from = modelKey( current ) ;
			const to = modelKey( base ) ;

			log.info( `${ reason }: ${ from } -> ${ to }` ) ;

			try
			{
				await client.session.abort( { path : { id : sessionID } } ) ;
			}
			catch {}

			// Re-prompt the session with the fallback model
			try
			{
				const label = formatModelLabel( s.failoverModel ) ;

				await client.session.prompt( {
					path : { id : sessionID },
					body : {
						model : {
							providerID : base.providerID,
							modelID : base.modelID,
							variant : next.variant
						},
						parts : [
							{ type : "text", text : `✅ Failover to ${ label }`, ignored : true },
							{ type : "text", text : "Continue." }
						]
					}
				} ) ;
			}
			catch
			{
				log.error( `re-prompt failed for ${ sessionID }` ) ;
			}

			// Update global config model so the UI selector reflects the change
			// in both plan and build modes.
			try
			{
				const modelStr = `${ base.providerID }/${ base.modelID }` ;

				const configBody = { model : modelStr } ;

				// Also update per-agent models so the selector changes in both
				// plan and build modes regardless of per-agent overrides.
				try
				{
					const cur = await client.config.get() ;
					const agent = { ...( cur.agent ?? {} ) } ;

					agent.plan = { ...agent.plan, model : modelStr, variant : next.variant } ;
					agent.build = { ...agent.build, model : modelStr, variant : next.variant } ;
					configBody.agent = agent ;
				}
				catch
				{
					log.debug( "config.get unavailable, top-level only" ) ;
				}

				await client.config.update( { body : configBody } ) ;

				log.debug( `config model set to ${ modelStr }` ) ;
			}
			catch {}
		}
		finally
		{
			s.failoverInProgress = false ;
		}
	}

	// ── Hooks ──────────────────────────────────────────

	return {
		event : async ( { event } ) =>
		{
			log.debug( `event: ${ event.type }` ) ;

			if ( event.type === "session.deleted" )
			{
				const id = event.properties?.info?.id ;

				if ( id ) sessions.delete( id ) ;

				return ;
			}

			let sessionID = null ;
			let message = null ;

			if ( event.type === "session.status" )
			{
				const props = event.properties ;

				if ( ! props?.sessionID || props?.status?.type !== "retry" || ! props.status.message )
				{
					return ;
				}

				sessionID = props.sessionID ;
				message = props.status.message ;
			}
			else if ( event.type === "session.error" )
			{
				const props = event.properties ;

				if ( ! props?.sessionID ) return ;
				if ( props?.error?.name === "MessageAbortedError" ) return ;

				sessionID = props.sessionID ;
				message = props?.error?.data?.message ?? null ;

				if ( ! message )
				{
					const sc = props?.error?.data?.statusCode ;

					if ( sc === 401 || sc === 402 || sc === 403 )
					{
						message = `HTTP ${ sc }` ;
					}
				}
			}
			else
			{
				return ;
			}

			if ( ! message || ! sessionID ) return ;

			let isFailoverSignal = isPermanent( message ) ;

			// Status code 401/402/403 always trigger failover regardless of message
			if ( ! isFailoverSignal && event.type === "session.error" )
			{
				const sc = event.properties?.error?.data?.statusCode ;
				isFailoverSignal = sc === 401 || sc === 402 || sc === 403 ;
			}

			if ( ! isFailoverSignal ) return ;

			const s = ensureSession( sessionID ) ;

			if ( ! s.currentModel )
			{
				// No model captured yet — nothing to fail over from
				return ;
			}

			log.error( `permanent: ${ message }` ) ;

			await failover(
				sessionID,
				event.type === "session.error" ? "error" : "retry",
				s.currentModel
			) ;
		},

		"chat.message": async ( input, output ) =>
		{
			if ( ! input.sessionID || ! input.model ) return ;

			const s = ensureSession( input.sessionID ) ;

			if ( ! s.currentModel )
			{
				s.currentModel = {
					providerID : input.model.providerID,
					modelID : input.model.modelID,
					variant : input.model.variant
				} ;
			}

		// Show chain-exhausted warning
		if ( s.failoverError )
		{
			output.parts.push( { type : "text", text : s.failoverError, ignored : true } ) ;
			output.message.summary = output.message.summary ?? { diffs : [ ] } ;
			output.message.summary.body = s.failoverError ;

			s.failoverError = undefined ;
		}

		if ( ! s.failoverModel ) return ;

		// Incoming model matches the original failed model — override to fallback
		if (
			input.model.providerID === s.currentModel.providerID &&
			input.model.modelID === s.currentModel.modelID
		)
		{
			log.debug( `override for ${ input.sessionID }` ) ;

			const label = formatModelLabel( s.failoverModel ) ;

			output.message.model = formatDisplayModel( s.failoverModel ) ;
			output.message.summary = output.message.summary ?? { diffs : [ ] } ;
			output.message.summary.body = `✅ Failover: ${ label }` ;

			s.currentModel = {
				providerID : s.failoverModel.providerID,
				modelID : s.failoverModel.modelID,
				variant : s.failoverModel.variant
			} ;
			s.failoverModel = undefined ;

			return ;
		}

		// Incoming model already matches the failover target — clean up
		if (
			input.model.providerID === s.failoverModel.providerID &&
			input.model.modelID === s.failoverModel.modelID
		)
		{
			log.debug( `already on failover model for ${ input.sessionID }` ) ;

			const label = formatModelLabel( s.failoverModel ) ;

			output.message.model = formatDisplayModel( s.failoverModel ) ;
			output.message.summary = output.message.summary ?? { diffs : [ ] } ;
			output.message.summary.body = `✅ Failover: ${ label }` ;

			s.currentModel = {
				providerID : s.failoverModel.providerID,
				modelID : s.failoverModel.modelID,
				variant : s.failoverModel.variant
			} ;
			s.failoverModel = undefined ;

			return ;
		}

			// Neither — user manually changed model
			log.info( `user override, clearing failover for ${ input.sessionID }` ) ;

			s.failoverModel = undefined ;
			s.currentModel = {
				providerID : input.model.providerID,
				modelID : input.model.modelID,
				variant : input.model.variant
			} ;
		},

		dispose : async () =>
		{
			sessions.clear() ;
			cooldowns.clear() ;
			log.info( "disposed" ) ;
		}
	} ;
}

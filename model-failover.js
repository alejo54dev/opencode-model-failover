/**
*	model-failover.js
*
*	OpenCode plugin — intercepts permanent HTTP 4xx/500 errors and fails
*	over through a configured chain of models.
*
*	Install: cp model-failover.js ~/.config/opencode/plugins/model-failover.js
*	Config:  ~/.config/opencode/model-failover.json
*
*	@name model-failover
*	@version 2.0.5
*	@author Alejandro Carraretto
*	@author DeepSeek-V4
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

// ---------------------------------------------------------------
// STATE — minimal
// ---------------------------------------------------------------

const STATE =
{
	config        : null,   // { enabled, models, logLevel }
	sessionID     : null,   // session being failed over
	originalModel : null,   // { providerID, modelID, variant? }
	failoverModel : null,   // { providerID, modelID, variant? }
	isBusy        : false,  // re-entrancy guard
} ;

// ---------------------------------------------------------------
// Logger
// ---------------------------------------------------------------

function log( level, message )
{
	const min = LOG_LEVEL[ STATE.config?.logLevel?.toUpperCase?.() ] ?? 1 ;

	if ( level > min ) return ;

	const label = Object.keys( LOG_LEVEL )[ level ] ;

	try
	{
		appendFileSync( LOG_FILE, `[${ new Date().toISOString() }] [${ label }]: ${ message }\n` ) ;
	}
	catch {}
}

// ---------------------------------------------------------------
// Config
// ---------------------------------------------------------------

function loadConfig()
{
	if ( ! existsSync( CONFIG_FILE ) )
	{
		log( LOG_LEVEL.ERROR, `Config not found at ${ CONFIG_FILE }` ) ;
		return ;
	}

	try
	{
		const raw = JSON.parse( readFileSync( CONFIG_FILE, "utf-8" ) ) ;

		const models = Array.isArray( raw.models )
			? raw.models.filter( ( e ) => typeof e?.model == "string" && e.model != "" )
			: [ ] ;

		STATE.config = {
			enabled  : typeof raw.enabled == "boolean" ? raw.enabled : true,
			models,
			logLevel : [ "error", "info", "debug" ].includes( raw.logLevel?.toLowerCase() ?? "" )
				? raw.logLevel
				: "info"
		} ;

		log( LOG_LEVEL.INFO, `Loaded: ${ models.length } models, enabled: ${ STATE.config.enabled }` ) ;
	}
	catch ( err )
	{
		log( LOG_LEVEL.ERROR, `Config parse error: ${ err.message }` ) ;
	}
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function parseEntry( entry )
{
	const slash = entry.model.indexOf( "/" ) ;

	if ( slash == -1 ) return null ;

	return {
		providerID : entry.model.substring( 0, slash ),
		modelID    : entry.model.substring( slash + 1 ),
		variant    : entry.variant
	} ;
}

// ---------------------------------------------------------------
// Failover — simple for loop, no recursion
// ---------------------------------------------------------------

async function failover( sessionID, client )
{
	if ( STATE.isBusy ) return ;
	if ( ! STATE.config?.models?.length ) return ;
	if ( ! sessionID ) return ;

	STATE.isBusy = true ;

	try
	{
		const models = STATE.config.models ;

		for ( let i = 0 ; i < models.length ; i ++ )
		{
			const entry = models[ i ] ;
			const model = parseEntry( entry ) ;
			const label = `${ entry.model }${ entry.variant ? ":" + entry.variant : "" }` ;

			if ( ! model )
			{
				log( LOG_LEVEL.ERROR, `Bad model at [${ i }]: ${ entry.model }, skipping` ) ;
				continue ;
			}

			log( LOG_LEVEL.INFO, `Trying ${ i }: ${ label }` ) ;

			await client.session.abort( { path : { id : sessionID } } ).catch( () => {} ) ;

			try
			{
				const result = await client.session.prompt( {
					path : { id : sessionID },
					body : {
						model,
						parts : [
							{ type : "text", text : `✅ Failover to [${ label }]`, ignored : true },
							{ type : "text", text : "Continue." }
						]
					}
				} ) ;

				const info  = result?.data?.info ;
				const state = info?.state ;

				const errMsg = info?.error?.data?.message
					?? info?.error?.message
					?? result?.error?.data?.message
					?? result?.error?.message
					?? "" ;

				if ( errMsg == "Aborted" )
				{
					log( LOG_LEVEL.DEBUG, `Prompt aborted for ${ label }, stopping cascade` ) ;
					return ;
				}

				if ( errMsg || ( state && state != "ok" ) )
				{
					log( LOG_LEVEL.DEBUG,
						`Response error for ${ label }: ${ errMsg || state || "unknown" }`
					) ;
					continue ;
				}

				log( LOG_LEVEL.INFO, `Override: ${ label }` ) ;
				STATE.failoverModel = model ;

				return ;
			}
			catch ( err )
			{
				log( LOG_LEVEL.DEBUG, `Prompt threw for ${ label }: ${ err?.message ?? String( err ) }` ) ;
			}
		}

		// Exhausted
		STATE.failoverModel = null ;
		log( LOG_LEVEL.INFO, "Chain models exhausted" ) ;

		await client.session.abort( { path : { id : sessionID } } ).catch( () => {} ) ;

		await client.session.prompt( {
			path : { id : sessionID },
			body : {
				parts : [
					{ type : "text", text : "❌ Failover chain exhausted." }
				]
			}
		} ).catch( ( err ) =>
		{
			log( LOG_LEVEL.DEBUG, `Exhausted prompt error for ${ sessionID }: ${ err?.message ?? "unknown" }` ) ;
		} ) ;
	}
	finally
	{
		STATE.isBusy = false ;
	}
}

// ---------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------

async function onEvent( { event }, client )
{
	if ( event.type == "session.deleted" )
	{
		reset() ;
		return ;
	}

	if ( event.type == "session.status" && event.properties?.status?.type == "retry" )
	{
		const sid = event.properties?.sessionID ;

		if ( ! sid ) return ;
		if ( STATE.isBusy || STATE.failoverModel ) return ;

		STATE.sessionID = sid ;
		log( LOG_LEVEL.DEBUG, `Cascade retry ${ sid }` ) ;

		await failover( sid, client ) ;
		return ;
	}

	if ( event.type != "session.error" ) return ;

	const err = event.properties?.error ;
	if ( err?.name == "MessageAbortedError" ) return ;

	const sid = event.properties?.sessionID ;
	if ( ! sid ) return ;

	const sc = err?.data?.statusCode ;

	if ( STATE.isBusy ) return ;

	if ( STATE.failoverModel && sid === STATE.sessionID )
	{
		log( LOG_LEVEL.DEBUG, `Stale skip: ${ sc ?? "?" } (override active)` ) ;
		return ;
	}

	STATE.sessionID = sid ;

	log( LOG_LEVEL.ERROR,
		`Fail: ${ STATE.originalModel?.providerID ?? "?" }/${ STATE.originalModel?.modelID ?? "?" } — ${ sc }`
	) ;

	await failover( sid, client ) ;
}

function onChatMessage( input, output )
{
	if ( ! input.sessionID ) return ;
	if ( STATE.isBusy ) return ;

	STATE.sessionID = input.sessionID ;

	const sel = input.model ;

	if ( ! sel?.providerID || ! sel?.modelID ) return ;

	if ( ! STATE.originalModel )
	{
		STATE.originalModel = {
			providerID : sel.providerID,
			modelID    : sel.modelID,
			variant    : sel.variant
		} ;

		log( LOG_LEVEL.INFO, `Current model: ${ STATE.originalModel.providerID }/${ STATE.originalModel.modelID }` ) ;
	}

	const orig = STATE.originalModel ;

	if ( orig && ( sel.providerID != orig.providerID || sel.modelID != orig.modelID || sel.variant != orig.variant ) )
	{
		STATE.failoverModel = null ;
		STATE.originalModel = {
			providerID : sel.providerID,
			modelID    : sel.modelID,
			variant    : sel.variant
		} ;

		log( LOG_LEVEL.INFO, `Model changed: ${ STATE.originalModel.providerID }/${ STATE.originalModel.modelID }` ) ;
		return ;
	}

	if ( ! STATE.failoverModel || ! output?.message?.model ) return ;

	output.message.model = { ...STATE.failoverModel } ;
}

function reset()
{
	STATE.sessionID     = null ;
	STATE.originalModel = null ;
	STATE.failoverModel = null ;
	STATE.isBusy        = false ;
}

// ---------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------

export default async function plugin( { client } )
{
	loadConfig() ;

	if ( ! STATE.config?.enabled ) return { } ;

	return {
		event          : ( e ) => onEvent( e, client ),
		"chat.message" : onChatMessage,
		dispose        : reset
	} ;
}

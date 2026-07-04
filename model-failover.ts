/**
*	model-failover.ts
*
*	OpenCode plugin — Intercepts OpenCode model provider errors and fails
*	over through a configured chain of models.
*
*	Install: cp model-failover.ts ~/.config/opencode/plugins/model-failover.ts
*	Config:  ~/.config/opencode/model-failover.json
*
*	Example config:
*	{
*		"enabled": true,
*		"models":
*		[
*			{ "model": "opencode-go/deepseek-v4-flash", "variant": "max" },
*			{ "model": "opencode-go/deepseek-v4-pro", "variant": "medium" },
*			{ "model": "deepseek/deepseek-v4-flash-free", "variant": "max" }
*		],
*		"logLevel": "info"     // "silent" | "error" | "info" | "debug"
*	}
*
*	@name model-failover
*	@version 1.0.27
*	@author Alejandro Carraretto
*	@author DeepSeek-V4
*	@license MIT
*/

import type { Plugin, PluginInput } from "@opencode-ai/plugin" ;
import { appendFileSync, readFileSync } from "node:fs" ;
import { homedir } from "node:os" ;
import { join } from "node:path" ;

// ─── Paths ─────────────────────────────────────────────────────────────────

const CONFIG_DIR  = join( homedir(), ".config", "opencode" ) ;
const CONFIG_FILE = join( CONFIG_DIR, "model-failover.json" ) ;
const LOG_FILE    = join( CONFIG_DIR, "model-failover.log" ) ;

// ─── Constants ─────────────────────────────────────────────────────────────

const LOG_LEVEL =
{
	SILENT : 0,
	ERROR  : 1,
	INFO   : 2,
	DEBUG  : 3,
} as const ;

const STATE : State =
{
	config        : null,
	sessionID     : null,
	originalModel : null,
	failoverModel : null,
	isBusy        : false,
} ;

const CONFIG =
{
	enabled  : true,
	models   : [] as ModelEntry[],
	logLevel : "info" as "silent" | "error" | "info" | "debug",
};

// ─── Config ────────────────────────────────────────────────────────────────

function loadConfig()
{
	let file : Record<string, unknown> = {};

	try
	{
		file = JSON.parse( readFileSync( CONFIG_FILE, "utf-8" ) );
	}
	catch
	{
		log( LOG_LEVEL.ERROR, `Config not found or parse error at ${ CONFIG_FILE }` ) ;
		return ;
	}

	const models = Array.isArray( file.models )
		? file.models.filter( ( e : any ) => typeof e?.model == "string" && e.model != "" )
		: [] ;

	const level = ( file.logLevel ?? "" ).toLowerCase() ;

	const opts =
	{
		enabled  : typeof file.enabled == "boolean" ? file.enabled : true,
		models   : models,
		logLevel : level in LOG_LEVEL ? level : "info",
	} as typeof CONFIG;

	CONFIG.logLevel = opts.logLevel ;
	STATE.config    = opts ;

	log( LOG_LEVEL.INFO, "Config loaded" ) ;
	log( LOG_LEVEL.INFO, `Loaded: ${ models.length } models, enabled: ${ opts.enabled }` ) ;

	return opts ;
}

// ─── Logger ────────────────────────────────────────────────────────────────

function log( level : number, message : string ) : void
{
	const min = LOG_LEVEL[ ( CONFIG.logLevel ?? "info" ).toUpperCase() ] ?? LOG_LEVEL.ERROR ;

	if ( level > min ) return ;

	const label = Object.keys( LOG_LEVEL )[ level ] ?? "" ;

	try
	{
		appendFileSync( LOG_FILE, `[${ new Date().toISOString() }] [${ label }]: ${ message }\n` ) ;
	}
	catch {}
}

// ─── Interfaces ────────────────────────────────────────────────────────────

interface ModelEntry
{
	model : string ;
	variant? : string ;
}

interface ParsedModel
{
	providerID : string ;
	modelID    : string ;
	variant?   : string ;
}

interface Config
{
	enabled  : boolean ;
	models   : ModelEntry[ ] ;
	logLevel : string ;
}

interface State
{
	config        : Config | null ;
	sessionID     : string | null ;
	originalModel : ParsedModel | null ;
	failoverModel : ParsedModel | null ;
	isBusy        : boolean ;
}

interface SessionError
{
	name? : string ;
	message? : string ;
	data? : { statusCode? : number ; message? : string } ;
}

interface SessionEvent
{
	type : "session.deleted" | "session.status" | "session.error" | string ;
	properties? :
	{
		sessionID? : string ;
		status? : { type : string } ;
		error? : SessionError ;
	} ;
}

interface ChatInput
{
	sessionID? : string ;
	model? : ParsedModel ;
}

interface ChatOutput
{
	message? : { model? : ParsedModel } ;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function parseEntry( entry : ModelEntry ) : ParsedModel | null
{
	const slash = entry.model.indexOf( "/" ) ;

	if ( slash == -1 ) return null ;

	return {
		providerID : entry.model.substring( 0, slash ),
		modelID    : entry.model.substring( slash + 1 ),
		variant    : entry.variant,
	} ;
}

// ─── Failover ──────────────────────────────────────────────────────────────

async function failover( sessionID : string, client : PluginInput[ "client" ] ) : Promise< void >
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
							{ type : "text", text : "Continue." },
						],
					},
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
						`Response error for ${ label }: ${ errMsg || state || "unknown" }`,
					) ;
					continue ;
				}

				log( LOG_LEVEL.INFO, `Override: ${ label }` ) ;
				STATE.failoverModel = model ;
				return ;
			}
			catch ( err )
			{
				log( LOG_LEVEL.DEBUG, `Prompt threw for ${ label }: ${ ( err as Error )?.message ?? String( err ) }` ) ;
			}
		}

		STATE.failoverModel = null ;
		log( LOG_LEVEL.INFO, "Chain models exhausted" ) ;

		await client.session.abort( { path : { id : sessionID } } ).catch( () => {} ) ;

		await client.session.prompt( {
			path : { id : sessionID },
			body : {
				parts : [
					{ type : "text", text : "❌ Failover chain exhausted." },
				],
			},
		} ).catch( ( err ) =>
		{
			log( LOG_LEVEL.DEBUG, `Exhausted prompt error for ${ sessionID }: ${ ( err as Error )?.message ?? "unknown" }` ) ;
		} ) ;
	}
	finally
	{
		STATE.isBusy = false ;
	}
}

// ─── Hooks ─────────────────────────────────────────────────────────────────

async function onEvent( { event } : { event : SessionEvent }, client : PluginInput[ "client" ] ) : Promise< void >
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
		`Fail: ${ STATE.originalModel?.providerID ?? "?" }/${ STATE.originalModel?.modelID ?? "?" } — ${ sc }`,
	) ;

	await failover( sid, client ) ;
}

function onChatMessage( input : ChatInput, output : ChatOutput ) : void
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
			variant    : sel.variant,
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
			variant    : sel.variant,
		} ;

		log( LOG_LEVEL.INFO, `Model changed: ${ STATE.originalModel.providerID }/${ STATE.originalModel.modelID }` ) ;
		return ;
	}

	if ( ! STATE.failoverModel || ! output?.message?.model ) return ;

	output.message.model = { ...STATE.failoverModel } ;
}

function reset() : void
{
	STATE.sessionID     = null ;
	STATE.originalModel = null ;
	STATE.failoverModel = null ;
	STATE.isBusy        = false ;
}

// ─── Plugin ────────────────────────────────────────────────────────────────

export default ( async ( { client } : PluginInput ) =>
{
	loadConfig() ;

	if ( ! STATE.config?.enabled ) return { } ;

	return {
		event          : ( e : { event : SessionEvent } ) => onEvent( e, client ),
		"chat.message" : onChatMessage,
		dispose        : reset,
	} ;
} ) satisfies Plugin ;

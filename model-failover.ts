/**
*	model-failover.ts
*
*	OpenCode plugin — Intercepts OpenCode model provider errors and fails
*	over through a configured chain of models.
*
*	Install: cp model-failover.ts ~/.config/opencode/plugins/model-failover.ts
*	Config:  ~/.config/opencode/model-failover.jsonc
*
*	Example config:
*	{
*		"enabled": true,
*		"chain":
*		[
*			{ "model": "opencode-zen/hy3-free", "variant": "high" },
*			{ "model": "opencode-go/deepseek-v4-pro", "variant": "high" },
*			{ "model": "deepseek/deepseek-v4-flash-free", "variant": "max" },
*		],
*		"log_level": "info",    // "silent" | "error" | "info" | "debug"
*	}
*
*	@name model-failover
*	@version 1.0.38
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
const CONFIG_FILE = join( CONFIG_DIR, "model-failover.jsonc" ) ;
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
	enabled   : true,
	chain     : [] as ChainEntry[],
	log_level : "info" as "silent" | "error" | "info" | "debug",
};

// ─── Interfaces ────────────────────────────────────────────────────────────

interface ChainEntry
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
	enabled   : boolean ;
	chain     : ChainEntry[ ] ;
	log_level : string ;
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

// ─── Global Helpers ──────────────────────────────────────────────────────────

// Current local datetime as ISO-like string: "2026-07-06T20:30:26"
function timestamp() : string
{
	const utc    = new Date() ;
	const offset = utc.getTimezoneOffset() ;
	const local  = new Date( utc.getTime() - offset * 60 * 1000 ) ;

	return local.toISOString().slice( 0, 19 ) ;
}

// Load config from ~/.config/opencode/model-failover.json, fall back to defaults
function loadConfig() : typeof CONFIG
{
	let file : Record<string, unknown> = {} ;
	try
	{
		file = Bun.JSONC.parse( readFileSync( CONFIG_FILE, "utf-8" ) ) ;
	}
	catch
	{
		log( LOG_LEVEL.ERROR, `Config not found or parse error at ${ CONFIG_FILE }` ) ;
	}

	const chain = Array.isArray( file.chain )
		? file.chain.filter( ( e : any ) => typeof e?.model == "string" && e.model != "" )
		: [] ;

	// Validate between file values and defaults values.
	CONFIG.enabled    = file.enabled    ?? CONFIG.enabled ;
	CONFIG.chain      = chain           ?? CONFIG.chain ;
	CONFIG.log_level  = file.log_level  ?? CONFIG.log_level ;

	log( LOG_LEVEL.INFO, "Config loaded" ) ;
	log( LOG_LEVEL.INFO, `Loaded: ${ CONFIG.chain.length } models` ) ;

	return CONFIG ;
}

// Append timestamped entry to ~/.config/opencode/model-failover.log
function log( level : number, message : string ) : void
{
	const min = LOG_LEVEL[ ( CONFIG.log_level ?? "info" ).toUpperCase() ] ?? LOG_LEVEL.ERROR ;

	if ( level > min ) return ;

	const label = Object.keys( LOG_LEVEL )[ level ] ?? "" ;

	try
	{
		appendFileSync( LOG_FILE, `[${ timestamp() }] [${ label }]: ${ message }\n` ) ;
	}
	catch {}
}

// ─── Helpers ───────────────────────────────────────────────────────────────

// Parse a "provider/model" string into providerID + modelID + optional variant
function parseEntry( entry : ChainEntry ) : ParsedModel | null
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

// Iterate the model chain, abort retry loop, try each model in sequence until one responds OK
async function failover( sessionID : string, client : PluginInput[ "client" ] ) : Promise< void >
{
	if ( STATE.isBusy ) return ;
	if ( ! STATE.config?.chain?.length ) return ;
	if ( ! sessionID ) return ;

	STATE.isBusy = true ;

	try
	{
		const chain = STATE.config.chain ;

		for ( let i = 0 ; i < chain.length ; i ++ )
		{
			const entry = chain[ i ] ;
			const model = parseEntry( entry ) ;
			const label = `${ entry.model }${ entry.variant ? ":" + entry.variant : "" }` ;

			if ( ! model )
			{
				log( LOG_LEVEL.ERROR, `Bad model at [${ i }]: ${ entry.model }, skipping` ) ;
				continue ;
			}

			await new Promise( r => setTimeout( r, 1000 ) ) ; // pre wait

			log( LOG_LEVEL.INFO, `Trying ${ i }: ${ label }` ) ;
			await client.session.abort( { path : { id : sessionID } } ).catch( () => {} ) ;

			await new Promise( r => setTimeout( r, 1000 ) ) ; // post wait

			try
			{
				const result = await client.session.prompt( {
					path : { id : sessionID },
					body : {
						model,
						parts : [
							// ignored: UI-only notification, NOT sent to model
							{ type : "text", text : `✅ Failover to [${ label }]`, ignored : true },
							// synthetic: system-generated, sent to model
							{ type : "text", text : "Continue.", synthetic: true },
						],
					},
				} );

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
					);
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
					{
						type : "text", text : "❌ Failover chain exhausted.",
						// synthetic+ignored: UI notification only
						synthetic: true, ignored : true
					},
				],
			},
		} ).catch( ( err ) =>
		{
			log( LOG_LEVEL.DEBUG, `Exhausted prompt error for ${ sessionID }: ${ ( err as Error )?.message ?? "unknown" }` ) ;
		} );
	}
	finally
	{
		STATE.isBusy = false ;
	}
}

// ─── Hooks ─────────────────────────────────────────────────────────────────

// Handle session events: session.deleted → reset, session.status (retry) → failover, session.error → failover
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
	);

	await failover( sid, client ) ;
}

// Intercept chat.message to track original model and inject failover model override
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
		};

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
		};

		log( LOG_LEVEL.INFO, `Model changed: ${ STATE.originalModel.providerID }/${ STATE.originalModel.modelID }` ) ;
		return ;
	}

	if ( ! STATE.failoverModel || ! output?.message?.model ) return ;

	output.message.model = { ...STATE.failoverModel } ;
}

// Reset all session state: sessionID, original/failover model, busy flag
function reset() : void
{
	STATE.sessionID     = null ;
	STATE.originalModel = null ;
	STATE.failoverModel = null ;
	STATE.isBusy        = false ;

	log( LOG_LEVEL.INFO, "Disposed" ) ;
}

// ─── Plugin ────────────────────────────────────────────────────────────────

// Plugin factory: load config, register event/chat.message/dispose hooks
export default ( async ( { client } : PluginInput ) =>
{
	const opts = loadConfig() ;

	if ( !opts.enabled )
	{
		log( LOG_LEVEL.INFO, "Disabled" ) ;
		return {} ;
	}

	return {
		// Hook: intercept session events for failover logic
		event : ( e : { event : SessionEvent } ) => onEvent( e, client ),
		// Hook: intercept messages to inject failover model
		"chat.message" : onChatMessage,
		// Cleanup: reset all state
		dispose : reset,
	};
} ) satisfies Plugin ;

// ─── END ──────────────────────────────────────────────────────────────

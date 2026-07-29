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
*			{ "model": "opencode/hy3-free", "variant": "high" },
*			{ "model": "opencode/deepseek-v4-flash-free", "variant": "max" },
*			{ "model": "deepseek/deepseek-v4-flash", "variant": "max" },
*			{ "model": "deepseek/deepseek-v4-pro", "variant": "high" },
*		],
*		"log_level": "info",    // "silent" | "error" | "info" | "debug"
*	}
*
*	@name model-failover
*	@version 1.1.24
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

const CONFIG =
{
	enabled   : true,
	chain     : [] as ChainEntry[],
	log_level : "info" as "silent" | "error" | "info" | "debug",
} ;

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

// ─── Helpers ────────────────────────────────────────────────────────────────

// Current local datetime as ISO-like string: "2026-07-06T20:30:26"
function timestamp() : string
{
	const utc    = new Date() ;
	const offset = utc.getTimezoneOffset() ;
	const local  = new Date( utc.getTime() - offset * 60 * 1000 ) ;

	return local.toISOString().slice( 0, 19 ) ;
}

// Load config from ~/.config/opencode/model-failover.jsonc, fall back to defaults
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

// ─── ModelFailover ──────────────────────────────────────────────────────────

class ModelFailover
{
	private config        : typeof CONFIG ;
	private client        : PluginInput[ "client" ] ;
	private sessionID     : string | null   = null ;
	private originalModel : ParsedModel | null = null ;
	private failoverModel : ParsedModel | null = null ;
	private isBusy        : boolean = false ;

	// Initialize: store config + client, no side effects
	constructor( config : typeof CONFIG, client : PluginInput[ "client" ] )
	{
		this.config = config ;
		this.client = client ;
	}

	// Parse a "provider/model" string into providerID + modelID + optional variant
	protected parseEntry( entry : ChainEntry ) : ParsedModel | null
	{
		const slash = entry.model.indexOf( "/" ) ;

		if ( slash == -1 ) return null ;

		return {
			providerID : entry.model.substring( 0, slash ),
			modelID    : entry.model.substring( slash + 1 ),
			variant    : entry.variant,
		} ;
	}

	// Iterate the model chain, abort retry loop, try each model in sequence until one responds OK
	protected async failover( sessionID : string ) : Promise< void >
	{
		if ( this.isBusy ) return ;
		if ( ! this.config?.chain?.length ) return ;
		if ( ! sessionID ) return ;

		this.isBusy = true ;

		try
		{
			const chain = this.config.chain ;

			for ( let i = 0 ; i < chain.length ; i ++ )
			{
				const entry = chain[ i ] ;
				const model = this.parseEntry( entry ) ;
				const label = `${ entry.model }${ entry.variant ? ":" + entry.variant : "" }` ;

				if ( ! model )
				{
					log( LOG_LEVEL.ERROR, `Bad model at [${ i }]: ${ entry.model }, skipping` ) ;
					continue ;
				}

				await new Promise( r => setTimeout( r, 1000 ) ) ; // pre wait

				log( LOG_LEVEL.INFO, `Trying ${ i }: ${ label }` ) ;
				await this.client.session.abort( { path : { id : sessionID } } ).catch( () => {} ) ;

				try
				{
					const result = await this.client.session.prompt( {
						path : { id : sessionID },
						body : {
							model,
							parts : [
								// ignored: UI-only notification, NOT sent to model
								{ type : "text", text : `✅ Failover to [${ label }]`, ignored : true },
								// synthetic: system-generated, sent to model
								{ type : "text", text : "Continue.", synthetic : true },
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
					this.failoverModel = model ;
					return ;
				}
				catch ( err )
				{
					log( LOG_LEVEL.DEBUG, `Prompt threw for ${ label }: ${ ( err as Error )?.message ?? String( err ) }` ) ;
				}
			}

			this.failoverModel = null ;
			log( LOG_LEVEL.INFO, "Chain models exhausted" ) ;

			await this.client.session.abort( { path : { id : sessionID } } ).catch( () => {} ) ;

			await this.client.session.prompt( {
				path : { id : sessionID },
				body : {
					parts : [
						// ignored: UI-only notification, NOT sent to model
						{ type : "text", text : "❌ Failover chain exhausted.", ignored : true },
					],
				},
			} ).catch( ( err ) =>
			{
				log( LOG_LEVEL.DEBUG, `Exhausted prompt error for ${ sessionID }: ${ ( err as Error )?.message ?? "unknown" }` ) ;
			} );
		}
		finally
		{
			this.isBusy = false ;
		}
	}

	// ── Public hooks ──────────────────────────────────────────────────────

	// Handle session events: session.deleted → dispose, session.status (retry) → failover, session.error → failover
	public async onEvent( { event } : { event : SessionEvent } ) : Promise< void >
	{
		if ( event.type == "session.deleted" )
	{
		this.dispose() ;
		return ;
	}

		if ( event.type == "session.status" && event.properties?.status?.type == "retry" )
		{
			const sid = event.properties?.sessionID ;

			if ( ! sid ) return ;
			if ( this.isBusy || this.failoverModel ) return ;

			this.sessionID = sid ;
			log( LOG_LEVEL.DEBUG, `Cascade retry ${ sid }` ) ;

			await this.failover( sid ) ;
			return ;
		}

		if ( event.type != "session.error" ) return ;

		const err = event.properties?.error ;
		if ( err?.name == "MessageAbortedError" ) return ;

		const sid = event.properties?.sessionID ;
		if ( ! sid ) return ;

		const sc = err?.data?.statusCode ;

		if ( this.isBusy ) return ;

		if ( this.failoverModel && sid === this.sessionID )
		{
			log( LOG_LEVEL.DEBUG, `Stale skip: ${ sc ?? "?" } (override active)` ) ;
			return ;
		}

		this.sessionID = sid ;

		log( LOG_LEVEL.ERROR,
			`Fail: ${ this.originalModel?.providerID ?? "?" }/${ this.originalModel?.modelID ?? "?" } — ${ sc }`,
		);

		await this.failover( sid ) ;
	}

	// Intercept chat.message to track original model and inject failover model override
	public onChatMessage( input : ChatInput, output : ChatOutput ) : void
	{
		if ( ! input.sessionID ) return ;
		if ( this.isBusy ) return ;

		this.sessionID = input.sessionID ;

		const sel = input.model ;

		if ( ! sel?.providerID || ! sel?.modelID ) return ;

		if ( ! this.originalModel )
		{
			this.originalModel = {
				providerID : sel.providerID,
				modelID    : sel.modelID,
				variant    : sel.variant,
			};

			log( LOG_LEVEL.INFO, `Current model: ${ this.originalModel.providerID }/${ this.originalModel.modelID }` ) ;
		}

		const orig = this.originalModel ;

		if ( orig && ( sel.providerID != orig.providerID || sel.modelID != orig.modelID || sel.variant != orig.variant ) )
		{
			this.failoverModel = null ;
			this.originalModel = {
				providerID : sel.providerID,
				modelID    : sel.modelID,
				variant    : sel.variant,
			};

			log( LOG_LEVEL.INFO, `Model changed: ${ this.originalModel.providerID }/${ this.originalModel.modelID }` ) ;
			return ;
		}

		if ( ! this.failoverModel || ! output?.message?.model ) return ;

		output.message.model = { ...this.failoverModel } ;
	}

	// Dispose: clear all session state: sessionID, original/failover model, busy flag
	public dispose() : void
	{
		this.sessionID     = null ;
		this.originalModel = null ;
		this.failoverModel = null ;
		this.isBusy        = false ;

		log( LOG_LEVEL.INFO, "Disposed" ) ;
	}
}

// ─── Plugin ────────────────────────────────────────────────────────────────

// Plugin factory: load config, build ModelFailover, register event/chat.message/dispose hooks
export default ( async ( ctx : PluginInput ) =>
{
	const opts = loadConfig() ;

	if ( ! opts.enabled )
	{
		log( LOG_LEVEL.INFO, "Disabled" ) ;
		return {} ;
	}

	const mf = new ModelFailover( opts, ctx.client ) ;

	return {
		// Hook: intercept session events for failover logic
		event : ( e : { event : SessionEvent } ) => mf.onEvent( e ),
		// Hook: intercept messages to inject failover model
		"chat.message" : ( i : ChatInput, o : ChatOutput ) => mf.onChatMessage( i, o ),
		// Cleanup: clear all state
		dispose : () => mf.dispose(),
	} ;
} ) satisfies Plugin ;

// ─── END ──────────────────────────────────────────────────────────────

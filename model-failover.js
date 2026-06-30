/**
 * model-failover.js
 *
 * OpenCode plugin — intercepts permanent model errors (HTTP 401/402/403/404)
 * and fails over through a configured model chain.
 *
 * Simple while-loop cascade: on error, iterates through models[] until one
 * succeeds or the chain exhausts. Per-session state is just a chain index
 * in Map<sessionID>. The index persists across messages so a failover model
 * that later fails continues the cascade.
 *
 * Install: cp model-failover.js ~/.config/opencode/plugins/model-failover.js
 * Config: ~/.config/opencode/model-failover.json
 *
 * @name model-failover
 * @version 9.0.0
 * @author Alejandro Carraretto
 * @license MIT
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs" ;
import { homedir } from "node:os" ;
import { join } from "node:path" ;

const CONFIG_DIR = join(
	process.env.XDG_CONFIG_HOME ?? join( homedir(), ".config" ),
	"opencode"
) ;

const LOG_RANK = { error : 0, info : 1, debug : 2 } ;

/** File-based logger appending to model-failover.log. */
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
		catch {}
	}

	return {
		error : ( ...a ) => write( "error", a ),
		info  : ( ...a ) => write( "info", a ),
		debug : ( ...a ) => write( "debug", a )
	} ;
}

/** Loads and validates plugin config from disk. */
function loadConfig()
{
	const path = join( CONFIG_DIR, "model-failover.json" ) ;

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
		return { enabled : true, models : [ ], logLevel : "info" } ;
	}
}

/** Plugin entry point. */
export default async function plugin( { client } )
{
	const config = loadConfig() ;
	const log = createLogger( config.logLevel ) ;
	const sessions = new Map() ;

	log.debug( "INIT:", JSON.stringify( config ) ) ;

	if ( ! config.enabled )
	{
		log.info( "Disabled" ) ;

		return {} ;
	}

	/**
	 * Iterates through the failover chain until one model succeeds
	 * or the chain is exhausted.
	 */
	async function failover( sessionID, errorInfo )
	{
		let idx = sessions.get( sessionID ) ?? 0 ;

		while ( idx < config.models.length )
		{
			const entry = config.models[ idx ] ;
			const slash = entry.model.indexOf( "/" ) ;

			if ( slash == -1 )
			{
				log.error( `Bad model at [${ idx }]: ${ entry.model }, skipping` ) ;
				idx++ ;
				sessions.set( sessionID, idx ) ;
				continue ;
			}

			const label = `${ entry.model }${ entry.variant ? `:${ entry.variant }` : "" }` ;
			const s = errorInfo
				? `— ${ errorInfo.name } ${ errorInfo.statusCode != null ? `(${ errorInfo.statusCode })` : "" }`
				: "" ;

			log.info( `[${ idx }] ${ label } ${ s }` ) ;

			idx++ ;
			sessions.set( sessionID, idx ) ;

			await client.session.abort( { path : { id : sessionID } } ).catch( () => {} ) ;

			try
			{
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

				return ;
			}
			catch ( err )
			{
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
			}
		}

		sessions.delete( sessionID ) ;

		const s = errorInfo
			? `— ${ errorInfo.name } ${ errorInfo.statusCode != null ? `(${ errorInfo.statusCode })` : "" }`
			: "" ;

		log.error( `Failover chain exhausted ${ s }` ) ;

		await client.session.abort( { path : { id : sessionID } } ).catch( () => {} ) ;

		await client.session.prompt( {
			path : { id : sessionID },
			body : { parts : [ { type : "text", text : "❌ Failover chain exhausted" } ] }
		} ).catch( () => {} ) ;
	}

	/** Handles session events — triggers failover on HTTP 401-404. */
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

			if ( ! isStatusCodeFail && ! inCascade ) return ;

			await failover( p.sessionID, {
				name : p.error.name ?? "Error",
				statusCode : sc,
				message : p?.error?.data?.message ?? ""
			} ) ;
		}
	}

	/** Cleans up on plugin disposal. */
	function onDispose()
	{
		sessions.clear() ;
	}

	return {
		event   : onEvent,
		dispose : onDispose
	} ;
}

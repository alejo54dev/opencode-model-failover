/**
 *	model-failover.test.js
 *
 *	Tests for ModelFailoverPlugin using `bun test`.
 *
 *	Run: bun test model-failover.test.js
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test" ;
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs" ;
import { homedir } from "node:os" ;
import { join } from "node:path" ;

import plugin from "./model-failover.js" ;

// ---------------------------------------------------------------
// 1. Constants
// ---------------------------------------------------------------

const CONFIG_DIR  = join( homedir(),  ".config", "opencode" ) ;
const CONFIG_FILE = join( CONFIG_DIR, "model-failover.json" ) ;
const LOG_FILE    = join( CONFIG_DIR, "model-failover.log" ) ;

const TEST_CONFIG = {
	enabled : true,
	models  : [
		{ model : "provider/model-a", variant : "default" },
		{ model : "provider/model-b", variant : "max"    },
		{ model : "provider/model-c", variant : "default" }
	],
	logLevel : "debug"
} ;

// ---------------------------------------------------------------
// 2. Helpers
// ---------------------------------------------------------------

function writeConfig( config )
{
	writeFileSync( CONFIG_FILE, JSON.stringify( config, null, "\t" ) ) ;
}

function cleanLog()
{
	try { unlinkSync( LOG_FILE ) ; } catch {}
}

function readLog()
{
	try { return readFileSync( LOG_FILE, "utf-8" ) ; } catch { return "" ; }
}

/**
 * Create a mock client that rejects prompt() for models in `failModels`.
 * When `latch` is provided, prompt() waits on the latch to resolve.
 */
function createMockClient( opts = {} )
{
	const { failModels = [], latch = null } = opts ;
	let callCount = 0 ;

	return {
		_callCount : () => callCount,
		session : {
			abort  : () => Promise.resolve(),
			prompt : ( { body } ) =>
			{
				callCount++ ;

				if ( ! body?.model )
					return Promise.resolve() ;

				const modelID = body.model.modelID ;

				if ( failModels.includes( modelID ) )
					return Promise.reject(
						Object.assign( new Error( `Model ${ modelID } error` ), {
							name       : "APIError",
							statusCode : 402,
							data       : { statusCode : 402 }
						} )
					) ;

				if ( latch )
					return latch.then( () => Promise.resolve() ) ;

				return Promise.resolve() ;
			}
		}
	} ;
}

/**
 * Create an event object for session.error.
 */
function makeErrorEvent( sessionID, statusCode = 402, errorName = "APIError" )
{
	return {
		event : {
			type       : "session.error",
			properties : {
				sessionID,
				error : {
					name : errorName,
					data : { statusCode }
				}
			}
		}
	} ;
}

/**
 * Create an event object for session.deleted.
 */
function makeDeletedEvent()
{
	return {
		event : { type : "session.deleted" }
	} ;
}

/**
 * Create a session.status retry event.
 */
function makeRetryEvent( sessionID, message = "" )
{
	return {
		event : {
			type       : "session.status",
			properties : {
				sessionID,
				status : { type : "retry", attempt : 1, message, next : 0 }
			}
		}
	} ;
}

// ---------------------------------------------------------------
// 3. Test suite
// ---------------------------------------------------------------

describe( "ModelFailoverPlugin", () =>
{
	let hooks ;
	let client ;
	let originalConfig = null ;

	// -- lifecycle ------------------------------------------------

	beforeEach( async () =>
	{
		if ( originalConfig === null && existsSync( CONFIG_FILE ) )
			originalConfig = readFileSync( CONFIG_FILE, "utf-8" ) ;

		cleanLog() ;
		writeConfig( TEST_CONFIG ) ;
	} ) ;

	afterEach( () =>
	{
		if ( hooks && typeof hooks.dispose == "function" )
			hooks.dispose() ;
	} ) ;

	afterAll( () =>
	{
		if ( originalConfig )
			writeFileSync( CONFIG_FILE, originalConfig ) ;
		else
			try { unlinkSync( CONFIG_FILE ) ; } catch {}
	} ) ;

	// -- tests ----------------------------------------------------

	it( "returns three hooks when enabled", async () =>
	{
		client = createMockClient() ;
		hooks  = await plugin( { client } ) ;

		expect( hooks ).toHaveProperty( "event" ) ;
		expect( hooks[ "chat.message" ] ).toBeFunction() ;
		expect( hooks ).toHaveProperty( "dispose" ) ;
	} ) ;

	it( "returns empty object when disabled", async () =>
	{
		writeConfig( { enabled : false, models : [], logLevel : "info" } ) ;
		client = createMockClient() ;
		hooks  = await plugin( { client } ) ;

		expect( hooks ).toEqual( {} ) ;
	} ) ;

	it( "clears all state on session.deleted", async () =>
	{
		client = createMockClient( { failModels : [ "model-a" ] } ) ;
		hooks  = await plugin( { client } ) ;

		// Trigger failover cascade (model-a → model-b)
		await hooks.event( makeErrorEvent( "s1" ) ) ;

		// Clear state
		await hooks.event( makeDeletedEvent() ) ;
		cleanLog() ;

		// Fire a new session.error — should start a fresh cascade (chainIdx=0)
		await hooks.event( makeErrorEvent( "s1" ) ) ;

		const log = readLog() ;
		const idx0Count = ( log.match( /\[0\]/g ) || [] ).length ;

		expect( idx0Count ).toBe( 1 ) ;
	} ) ;

	it( "ignores non-retryable status codes (5xx)", async () =>
	{
		client = createMockClient( { failModels : [ "model-a" ] } ) ;
		hooks  = await plugin( { client } ) ;

		await hooks.event( makeErrorEvent( "s1", 500 ) ) ;

		const log = readLog() ;
		expect( log ).not.toContain( "[0]" ) ;
	} ) ;

	it( "ignores MessageAbortedError", async () =>
	{
		client = createMockClient() ;
		hooks  = await plugin( { client } ) ;

		await hooks.event( {
			event : {
				type       : "session.error",
				properties : {
					sessionID : "s1",
					error     : { name : "MessageAbortedError" }
				}
			}
		} ) ;

		const log = readLog() ;
		expect( log ).not.toContain( "[0]" ) ;
	} ) ;

	it( "cascades to next model when prompt() rejects", async () =>
	{
		client = createMockClient( { failModels : [ "model-a" ] } ) ;
		hooks  = await plugin( { client } ) ;

		await hooks.event( makeErrorEvent( "s1" ) ) ;

		const log = readLog() ;

		// model-a failed → model-b should be attempted
		expect( log ).toContain( "Success: provider/model-b" ) ;
		expect( log ).toContain( "Prompt failed" ) ;
		expect( log ).toContain( "cascading" ) ;
	} ) ;

	it( "advances chainIdx on prompt rejection", async () =>
	{
		client = createMockClient( { failModels : [ "model-a", "model-b" ] } ) ;
		hooks  = await plugin( { client } ) ;

		await hooks.event( makeErrorEvent( "s1" ) ) ;

		const log = readLog() ;

		// model-a failed → model-b failed → model-c succeeds
		expect( log ).toContain( "Success: provider/model-c" ) ;
		expect( log ).toContain( "[0]" ) ;
		expect( log ).toContain( "[1]" ) ;
		expect( log ).toContain( "[2]" ) ;
	} ) ;

	it( "exhausts chain when all models fail", async () =>
	{
		client = createMockClient( { failModels : [ "model-a", "model-b", "model-c" ] } ) ;
		hooks  = await plugin( { client } ) ;

		await hooks.event( makeErrorEvent( "s1" ) ) ;

		const log = readLog() ;

		expect( log ).toContain( "Failover chain exhausted" ) ;
	} ) ;

	it( "continues cascade when failover model fails after success (continuation)", async () =>
	{
		// All three prompt() succeed (no rejection).
		// Then fire session.error as if the runtime failed each model.
		client = createMockClient() ; // no fail models → all prompt() succeed
		hooks  = await plugin( { client } ) ;

		// 1) Original error → #failover runs → model[0] prompt succeeds → failoverModel = model-a
		await hooks.event( makeErrorEvent( "s1" ) ) ;

		let log = readLog() ;
		expect( log ).toContain( "Success: provider/model-a" ) ;

		// 2) Runtime fails model-a → continuation → #failover tries model[1]
		await hooks.event( makeErrorEvent( "s1" ) ) ;

		log = readLog() ;
		expect( log ).toContain( "cascading to [1]" ) ;

		// 3) Runtime fails model-b → continuation → #failover tries model[2]
		await hooks.event( makeErrorEvent( "s1" ) ) ;

		log = readLog() ;
		expect( log ).toContain( "cascading to [2]" ) ;

		// 4) Runtime fails model-c → continuation → chainIdx=3 → exhausted
		await hooks.event( makeErrorEvent( "s1" ) ) ;

		log = readLog() ;
		expect( log ).toContain( "Failover chain exhausted" ) ;
	} ) ;

	it( "continues cascade via session.status retry", async () =>
	{
		client = createMockClient() ;
		hooks  = await plugin( { client } ) ;

		// 1) Original error → #failover → model[0] succeeds
		await hooks.event( makeErrorEvent( "s1" ) ) ;

		let log = readLog() ;
		expect( log ).toContain( "Success: provider/model-a" ) ;

		// 2) Retry event for same session → continuation → model[1]
		await hooks.event( makeRetryEvent( "s1", "quota exceeded" ) ) ;

		log = readLog() ;
		expect( log ).toContain( "cascading to [1]" ) ;
		expect( log ).toContain( "Success: provider/model-b" ) ;

		// 3) Retry event again → continuation → model[2]
		await hooks.event( makeRetryEvent( "s1", "rate limited" ) ) ;

		log = readLog() ;
		expect( log ).toContain( "cascading to [2]" ) ;
		expect( log ).toContain( "Success: provider/model-c" ) ;

		// 4) Retry event → chain exhausted
		await hooks.event( makeRetryEvent( "s1", "model not found" ) ) ;

		log = readLog() ;
		expect( log ).toContain( "Failover chain exhausted" ) ;
	} ) ;

	it( "ignores session.status retry when not mid-chain (chainIdx 0)", async () =>
	{
		client = createMockClient() ;
		hooks  = await plugin( { client } ) ;

		await hooks.event( makeRetryEvent( "s1", "quota" ) ) ;

		const log = readLog() ;
		expect( log ).not.toContain( "cascading" ) ;
	} ) ;

	it( "reentrancy guard blocks second session.error during failover", async () =>
	{
		let promptResolve ;
		const latch = new Promise( r => { promptResolve = r ; } ) ;

		client = createMockClient( { latch } ) ;
		hooks  = await plugin( { client } ) ;

		// Start failover — prompt() will pause on latch
		const failoverPromise = hooks.event( makeErrorEvent( "s1" ) ) ;

		// Wait one microtick so isFailingOver is set
		await Promise.resolve() ;

		// Fire second session.error — should be blocked
		await hooks.event( makeErrorEvent( "s1" ) ) ;

		// Log should NOT contain a second "[0]" entry
		const logBefore = readLog() ;
		const zeroCountBefore = ( logBefore.match( /\[0\]/g ) || [] ).length ;
		expect( zeroCountBefore ).toBe( 1 ) ;

		// Release the latch so failover completes
		promptResolve() ;
		await failoverPromise ;
	} ) ;

	it( "overrides output model to failoverModel on chat.message", async () =>
	{
		client = createMockClient( { failModels : [ "model-a" ] } ) ;
		hooks  = await plugin( { client } ) ;

		// First message → captures originalModel
		const input  = { sessionID : "s1", model : { providerID : "original", modelID : "gpt-default" } } ;
		const output = { message : { model : null } } ;

		hooks[ "chat.message" ]( input, output ) ;

		// Trigger failover → model-b succeeds
		await hooks.event( makeErrorEvent( "s1" ) ) ;

		// Second message with original model → output should be overridden
		const output2 = { message : { model : null } } ;
		hooks[ "chat.message" ]( input, output2 ) ;

		expect( output2.message.model ).toEqual( {
			providerID : "provider",
			modelID    : "model-b",
			variant    : "max"
		} ) ;
	} ) ;

	it( "clears failover state when user changes model", async () =>
	{
		client = createMockClient( { failModels : [ "model-a" ] } ) ;
		hooks  = await plugin( { client } ) ;

		// First message → captures originalModel
		const input  = { sessionID : "s1", model : { providerID : "original", modelID : "gpt-default" } } ;
		const output = { message : { model : null } } ;

		hooks[ "chat.message" ]( input, output ) ;

		// Trigger failover → model-b succeeds → failoverModel set
		await hooks.event( makeErrorEvent( "s1" ) ) ;

		// User changes model to something else → failoverState cleared
		const input2  = { sessionID : "s1", model : { providerID : "other", modelID : "custom" } } ;
		const output2 = { message : { model : null } } ;

		hooks[ "chat.message" ]( input2, output2 ) ;

		// Disabled no longer has failover override
		const output3 = { message : { model : null } } ;
		hooks[ "chat.message" ]( input2, output3 ) ;

		expect( output3.message.model ).toBeNull() ;
	} ) ;

	it( "does not override when input model matches failoverModel", async () =>
	{
		client = createMockClient( { failModels : [ "model-a" ] } ) ;
		hooks  = await plugin( { client } ) ;

		// First message → captures original
		hooks[ "chat.message" ](
			{ sessionID : "s1", model : { providerID : "original", modelID : "gpt-default" } },
			{ message : { model : null } }
		) ;

		// Trigger failover → model-b succeeds
		await hooks.event( makeErrorEvent( "s1" ) ) ;

		// Message with the failover model itself → no override needed
		const output = { message : { model : null } } ;
		hooks[ "chat.message" ](
			{ sessionID : "s1", model : { providerID : "provider", modelID : "model-b" } },
			output
		) ;

		expect( output.message.model ).toBeNull() ;
	} ) ;
} ) ;

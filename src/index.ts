import type { Plugin, PluginInput } from "@opencode-ai/plugin"

import { loadConfig, modelKey, parseModel, type FailoverConfig } from "./config"
import {
	ABORT_DELAY_MS,
	IMMEDIATE_STATUS_CODES,
	PERMANENT_ERROR_PATTERNS,
	RETRYABLE_STATUS_CODES,
	TRANSIENT_ERROR_PATTERNS,
} from "./constants"
import { log, setLogLevel } from "./logger"

const SESSION_TTL_MS = 10 * 60 * 1000

interface SessionState
{
	failoverInProgress: boolean
	createdAt: number
}

interface ModelRef
{
	providerID: string
	modelID: string
}

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000

const sessions = new Map<string, SessionState>()
const modelCooldowns = new Map<string, number>()
const failoverModels = new Map<string, ModelRef>()

function ensureSession(sessionID: string): SessionState
{
	let s = sessions.get(sessionID)
	if (!s)
	{
		s = { failoverInProgress: false, createdAt: Date.now() }
		sessions.set(sessionID, s)
	}
	return s
}

function isModelInCooldown(m: ModelRef): boolean
{
	const key = modelKey(m.providerID, m.modelID)
	const expiry = modelCooldowns.get(key)
	if (expiry === undefined) return false
	if (Date.now() < expiry) return true
	modelCooldowns.delete(key)
	return false
}

function markModelCooldown(m: ModelRef, ms: number): void
{
	modelCooldowns.set(modelKey(m.providerID, m.modelID), Date.now() + ms)
}

function isPermanentError(msg: string): boolean
{
	const lower = msg.toLowerCase()
	return PERMANENT_ERROR_PATTERNS.some((p) => lower.includes(p))
}

function isTransientError(msg: string): boolean
{
	const lower = msg.toLowerCase()
	return TRANSIENT_ERROR_PATTERNS.some((p) => lower.includes(p))
}

function classify(
	statusCode: number | undefined,
	isRetryable: boolean | undefined,
	message: string | undefined,
): "immediate" | "retry"
{
	if (statusCode !== undefined && IMMEDIATE_STATUS_CODES.has(statusCode))
	{
		return "immediate"
	}

	if (message && isPermanentError(message))
	{
		return "immediate"
	}

	if (isRetryable === false) return "immediate"

	if (isRetryable === true) return "retry"

	if (statusCode !== undefined && RETRYABLE_STATUS_CODES.has(statusCode))
	{
		return "retry"
	}

	if (message && isTransientError(message)) return "retry"

	return "immediate"
}

async function abort(sessionID: string, client: PluginInput["client"]): Promise<void>
{
	try
	{
		await client.session.abort({ path: { id: sessionID } })
		await new Promise((r) => setTimeout(r, ABORT_DELAY_MS))
	}
	catch
	{
		/* session may already be idle */
	}
}

async function rePrompt(
	sessionID: string,
	model: ModelRef,
	client: PluginInput["client"],
): Promise<boolean>
{
	try
	{
		await client.session.prompt({
			path: { id: sessionID },
			body: {
				model: { providerID: model.providerID, modelID: model.modelID },
				parts: [{ type: "text" as const, text: "Continue" }],
			},
		})
		return true
	}
	catch
	{
		return false
	}
}

async function tryFallbackChain(
	sessionID: string,
	chain: ModelRef[],
	cooldownMs: number,
	client: PluginInput["client"],
): Promise<ModelRef | null>
{
	for (const model of chain)
	{
		if (isModelInCooldown(model))
		{
			log("debug", `skipping ${modelKey(model.providerID, model.modelID)} (cooldown)`)
			continue
		}

		log("debug", `trying fallback: ${modelKey(model.providerID, model.modelID)}`)
		if (await rePrompt(sessionID, model, client))
		{
			log("info", `fallback succeeded: ${modelKey(model.providerID, model.modelID)}`)
			return model
		}

		log("debug", `fallback failed: ${modelKey(model.providerID, model.modelID)}`)
		markModelCooldown(model, cooldownMs)
	}

	log("error", `fallback chain exhausted`)
	console.warn(`❌ fallback chain exhausted for session ${sessionID}`)
	return null
}

async function executeFailover(
	sessionID: string,
	config: FailoverConfig,
	client: PluginInput["client"],
): Promise<void>
{
	const s = ensureSession(sessionID)
	if (s.failoverInProgress) return

	s.failoverInProgress = true
	failoverModels.delete(sessionID)
	try
	{
		await abort(sessionID, client)

		const chain = config.fallbackChain.map(parseModel)
		if (chain.length === 0)
		{
			log("error", `no fallback models configured`)
			return
		}

		log("info", `starting failover for session ${sessionID}`)
		const succeeded = await tryFallbackChain(sessionID, chain, config.cooldownMs, client)

		if (succeeded)
		{
			const key = modelKey(succeeded.providerID, succeeded.modelID)
			failoverModels.set(sessionID, succeeded)
			log("info", `failover to ${key}`)
			console.warn(`✅ failover to ${key}`)
		}
	}
	finally
	{
		s.failoverInProgress = false
	}
}

function cleanupStaleState(): void
{
	const now = Date.now()

	for (const [key, expiry] of modelCooldowns)
	{
		if (now >= expiry) modelCooldowns.delete(key)
	}

	for (const [id, state] of sessions)
	{
		if (state.failoverInProgress) continue
		if (now - state.createdAt >= SESSION_TTL_MS) sessions.delete(id)
	}
}

export default (async ({ client }) =>
{
	const config = loadConfig()

	setLogLevel(config.logLevel)

	log("info", "initialized:", JSON.stringify(config))

	if (!config.enabled) return {}

	const cleanupTimer = setInterval(cleanupStaleState, CLEANUP_INTERVAL_MS)

	return {
		event: async ({ event }) =>
		{
			log("debug", `event: ${event.type}`)

			if (event.type === "session.deleted")
			{
				const props = event.properties as { info?: { id?: string } }
				if (props.info?.id)
				{
					sessions.delete(props.info.id)
					failoverModels.delete(props.info.id)
				}
				return
			}

			if (event.type === "session.error")
			{
				const props = event.properties as {
					sessionID?: string
					error?: {
						name: string
						data: {
							message: string
							statusCode?: number
							isRetryable?: boolean
						}
					}
				}

				const sessionID = props.sessionID
				if (!sessionID) return

				const err = props.error
				if (!err) return

				if (err.name === "MessageAbortedError") return

				const isAuth = err.name === "ProviderAuthError"
				const isNotFound = err.name === "ProviderModelNotFoundError"

				const action = classify(
					err.data.statusCode,
					isAuth || isNotFound ? false : err.data.isRetryable,
					err.data.message,
				)

				if (action === "immediate")
				{
					log("error", `permanent error: ${err.data.message}`)
					await executeFailover(sessionID, config, client)
				}
				else if (action === "retry")
				{
					log("info", `retryable error (${err.data.statusCode}): ${err.data.message}`)
					await executeFailover(sessionID, config, client)
				}

				return
			}

			if (event.type === "session.status")
			{
				const props = event.properties as {
					sessionID: string
					status: {
						type: "idle" | "retry" | "busy"
						message?: string
						attempt?: number
					}
				}

				if (props.status.type !== "retry" || !props.status.message) return

				if (isPermanentError(props.status.message))
				{
					log("error", `permanent retry status (session ${props.sessionID}): ${props.status.message}`)
					await executeFailover(props.sessionID, config, client)
					return
				}

				if (isTransientError(props.status.message))
				{
					const attempt = props.status.attempt ?? 1
					if (attempt <= config.maxRetries) return

					log("error", `retries exhausted (session ${props.sessionID}) (${attempt}/${config.maxRetries})`)
					await executeFailover(props.sessionID, config, client)
					return
				}

				log("error", `unknown retry status (session ${props.sessionID}): ${props.status.message}`)
				await executeFailover(props.sessionID, config, client)
			}
		},

		"chat.message": async (input, output) =>
		{
			const m = failoverModels.get(input.sessionID)
			if (m)
			{
				log("debug", `override model for session ${input.sessionID}: ${modelKey(m.providerID, m.modelID)}`)
				output.message.model = { providerID: m.providerID, modelID: m.modelID }
			}
		},

		dispose: async () =>
		{
			clearInterval(cleanupTimer)
		},
	}
}) satisfies Plugin

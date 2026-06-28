import type { Plugin, PluginInput } from "@opencode-ai/plugin"

import { loadConfig, parseModel, type FailoverConfig } from "./config"
import {
	ABORT_DELAY_MS,
	IMMEDIATE_STATUS_CODES,
	PERMANENT_ERROR_PATTERNS,
	RETRYABLE_STATUS_CODES,
	TRANSIENT_ERROR_PATTERNS,
} from "./constants"

interface SessionState
{
	cooldownUntil: number
	retryCount: number
	failoverInProgress: boolean
}

interface ModelRef
{
	providerID: string
	modelID: string
}

const SESSION_TTL_MS = 10 * 60 * 1000
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000

const sessions = new Map<string, SessionState>()
const modelCooldowns = new Map<string, number>()

function modelKey(m: ModelRef): string
{
	return `${m.providerID}/${m.modelID}`
}

function ensureSession(sessionID: string): SessionState
{
	let s = sessions.get(sessionID)
	if (!s)
	{
		s = { cooldownUntil: 0, retryCount: 0, failoverInProgress: false }
		sessions.set(sessionID, s)
	}
	return s
}

function isCooldownActive(sessionID: string): boolean
{
	const s = sessions.get(sessionID)
	return s !== undefined && Date.now() < s.cooldownUntil
}

function activateCooldown(sessionID: string, ms: number): void
{
	const s = ensureSession(sessionID)
	s.cooldownUntil = Date.now() + ms
}

function isModelInCooldown(m: ModelRef): boolean
{
	const expiry = modelCooldowns.get(modelKey(m))
	if (expiry === undefined) return false
	if (Date.now() < expiry) return true
	modelCooldowns.delete(modelKey(m))
	return false
}

function markModelCooldown(m: ModelRef, ms: number): void
{
	modelCooldowns.set(modelKey(m), Date.now() + ms)
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

type ErrorAction = "immediate" | "retry" | "ignore"

function classify(
	statusCode: number | undefined,
	isRetryable: boolean | undefined,
	message: string | undefined,
): ErrorAction
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

	return "retry"
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
	client: PluginInput["client"],
): Promise<boolean>
{
	for (const model of chain)
	{
		if (isModelInCooldown(model))
		{
			console.warn(`[model-failover] skipping ${modelKey(model)} (cooldown)`)
			continue
		}

		console.warn(`[model-failover] trying fallback: ${modelKey(model)}`)
		if (await rePrompt(sessionID, model, client))
		{
			console.warn(`[model-failover] fallback succeeded: ${modelKey(model)}`)
			return true
		}

		console.warn(`[model-failover] fallback failed: ${modelKey(model)}`)
		markModelCooldown(model, 60_000)
	}

	console.warn(`[model-failover] fallback chain exhausted`)
	return false
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
	try
	{
		if (isCooldownActive(sessionID))
		{
			console.warn(`[model-failover] session ${sessionID} in cooldown, skipping failover`)
			return
		}

		await abort(sessionID, client)
		activateCooldown(sessionID, config.cooldownMs)

		const chain = config.fallbackChain.map(parseModel)
		if (chain.length === 0)
		{
			console.warn(`[model-failover] no fallback models configured`)
			return
		}

		console.warn(`[model-failover] starting failover for session ${sessionID}`)
		await tryFallbackChain(sessionID, chain, client)
	}
	finally
	{
		s.failoverInProgress = false
	}
}

function cleanupStaleSessions(): void
{
	const now = Date.now()
	for (const [id, state] of sessions)
	{
		if (now - state.cooldownUntil > SESSION_TTL_MS && !state.failoverInProgress)
		{
			sessions.delete(id)
		}
	}
	for (const [key, expiry] of modelCooldowns)
	{
		if (now >= expiry)
		{
			modelCooldowns.delete(key)
		}
	}
}

export default (async ({ client }) =>
{
	const config = loadConfig()

	if (!config.enabled) return {}

	const cleanupTimer = setInterval(cleanupStaleSessions, CLEANUP_INTERVAL_MS)

	return {
		event: async ({ event }) =>
		{
			if (event.type === "session.deleted")
			{
				const props = event.properties as { info?: { id?: string } }
				if (props.info?.id)
				{
					sessions.delete(props.info.id)
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
					console.warn(`[model-failover] permanent error: ${err.data.message}`)
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
					console.warn(`[model-failover] permanent retry status: ${props.status.message}`)
					await executeFailover(props.sessionID, config, client)
					return
				}

				if (isTransientError(props.status.message))
				{
					const attempt = props.status.attempt ?? 1
					if (attempt <= config.maxRetries) return

					console.warn(`[model-failover] retries exhausted (${attempt}/${config.maxRetries})`)
					await executeFailover(props.sessionID, config, client)
					return
				}

				console.warn(`[model-failover] unknown retry status: ${props.status.message}`)
				await executeFailover(props.sessionID, config, client)
			}
		},

		dispose: async () =>
		{
			clearInterval(cleanupTimer)
		},
	}
}) satisfies Plugin

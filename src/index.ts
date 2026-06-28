import type { Plugin, PluginInput } from "@opencode-ai/plugin"

import { loadConfig, parseModel, type FailoverConfig } from "./config"
import {
	ABORT_DELAY_MS,
	BACKOFF_BASE_MS,
	IMMEDIATE_STATUS_CODES,
	PERMANENT_ERROR_PATTERNS,
	RETRYABLE_STATUS_CODES,
	TRANSIENT_ERROR_PATTERNS,
} from "./constants"

interface SessionState
{
	cooldownUntil: number
	retryCount: number
}

interface ModelRef
{
	providerID: string
	modelID: string
}

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
		s = { cooldownUntil: 0, retryCount: 0 }
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
	sessionID: string,
): ErrorAction
{
	if (isCooldownActive(sessionID)) return "ignore"

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
		if (isModelInCooldown(model)) continue

		if (await rePrompt(sessionID, model, client)) return true

		markModelCooldown(model, 60_000)
	}
	return false
}

async function handleError(
	sessionID: string,
	config: FailoverConfig,
	client: PluginInput["client"],
	statusCode: number | undefined,
	isRetryable: boolean | undefined,
	message: string | undefined,
): Promise<void>
{
	const action = classify(statusCode, isRetryable, message, sessionID)

	if (action === "ignore") return

	if (action === "immediate")
	{
		await abort(sessionID, client)
		activateCooldown(sessionID, config.cooldownMs)

		const chain = config.fallbackChain.map(parseModel)
		if (chain.length === 0) return

		await tryFallbackChain(sessionID, chain, client)
		return
	}

	const s = ensureSession(sessionID)
	s.retryCount++

	if (s.retryCount <= config.maxRetries)
	{
		const waitMs = BACKOFF_BASE_MS * 2 ** (s.retryCount - 1)
		await new Promise((r) => setTimeout(r, waitMs))
		await abort(sessionID, client)

		if (await rePrompt(sessionID, { providerID: "", modelID: "" }, client)) return
	}

	s.retryCount = 0
	await abort(sessionID, client)
	activateCooldown(sessionID, config.cooldownMs)

	const chain = config.fallbackChain.map(parseModel)
	if (chain.length === 0) return

	await tryFallbackChain(sessionID, chain, client)
}

export default (async ({ client }) =>
{
	const config = loadConfig()

	if (!config.enabled) return {}

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

				await handleError(
					sessionID,
					config,
					client,
					err.data.statusCode,
					isAuth || isNotFound ? false : err.data.isRetryable,
					err.data.message,
				)
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
					if (isCooldownActive(props.sessionID)) return

					await abort(props.sessionID, client)
					activateCooldown(props.sessionID, config.cooldownMs)

					const chain = config.fallbackChain.map(parseModel)
					if (chain.length > 0)
					{
						await tryFallbackChain(props.sessionID, chain, client)
					}
					return
				}

				if (isTransientError(props.status.message))
				{
					const attempt = props.status.attempt ?? 1
					if (attempt <= config.maxRetries) return

					if (isCooldownActive(props.sessionID)) return

					await abort(props.sessionID, client)
					activateCooldown(props.sessionID, config.cooldownMs)

					const chain = config.fallbackChain.map(parseModel)
					if (chain.length > 0)
					{
						await tryFallbackChain(props.sessionID, chain, client)
					}
					return
				}

				await abort(props.sessionID, client)
				activateCooldown(props.sessionID, config.cooldownMs)

				const chain = config.fallbackChain.map(parseModel)
				if (chain.length > 0)
				{
					await tryFallbackChain(props.sessionID, chain, client)
				}
			}
		},
	}
}) satisfies Plugin

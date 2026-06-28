import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface FailoverConfig {
	enabled: boolean
	fallbackChain: string[]
	maxRetries: number
	cooldownMs: number
}

const DEFAULT_CONFIG: FailoverConfig = {
	enabled: true,
	fallbackChain: [],
	maxRetries: 2,
	cooldownMs: 30_000,
}

function getConfigDir(): string
{
	const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
	return join(xdg, "opencode")
}

export function loadConfig(): FailoverConfig
{
	const configPath = join(getConfigDir(), "model-failover.json")

	if (!existsSync(configPath))
	{
		return DEFAULT_CONFIG
	}

	try
	{
		const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>

		return {
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
			fallbackChain: Array.isArray(raw.fallbackChain)
				? raw.fallbackChain.filter((e): e is string => typeof e === "string")
				: DEFAULT_CONFIG.fallbackChain,
			maxRetries: typeof raw.maxRetries === "number" ? raw.maxRetries : DEFAULT_CONFIG.maxRetries,
			cooldownMs: typeof raw.cooldownMs === "number" ? raw.cooldownMs : DEFAULT_CONFIG.cooldownMs,
		}
	}
	catch
	{
		return DEFAULT_CONFIG
	}
}

export function parseModel(spec: string): { providerID: string; modelID: string }
{
	const idx = spec.indexOf("/")
	if (idx === -1)
	{
		return { providerID: spec, modelID: spec }
	}
	return {
		providerID: spec.substring(0, idx),
		modelID: spec.substring(idx + 1),
	}
}

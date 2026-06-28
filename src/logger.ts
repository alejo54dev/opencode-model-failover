import { appendFileSync } from "node:fs"
import { join } from "node:path"

import { getConfigDir } from "./config"

export type LogLevel = "error" | "info" | "debug"

const RANK: Record<LogLevel, number> = { error: 0, info: 1, debug: 2 }

let currentLevel: LogLevel = "info"

export function setLogLevel(level: LogLevel): void
{
	currentLevel = level
}

function getLogPath(): string
{
	return join(getConfigDir(), "model-failover.log")
}

export function log(level: LogLevel, ...args: unknown[]): void
{
	if (RANK[level] > RANK[currentLevel]) return

	const timestamp = new Date().toISOString()
	const prefix = level === "error" ? "ERR" : level === "info" ? "INF" : "DBG"
	const message = `[model-failover] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`

	try
	{
		appendFileSync(getLogPath(), `[${timestamp}] [${prefix}] ${message}\n`)
	}
	catch
	{
		/* fail silently */
	}
}

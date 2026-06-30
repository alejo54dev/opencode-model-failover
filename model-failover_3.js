// ~/.config/opencode/plugin/model-failover.js
// Plugin de Failover para OpenCode - Sin dependencias externas

import { readFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ------------------------------------------------------------
// 1. CONFIGURACIÓN Y ESTADO GLOBAL
// ------------------------------------------------------------

const CONFIG_DIR = join(homedir(), ".config", "opencode");
const CONFIG_FILE = join(CONFIG_DIR, "model-failover.json");
const LOG_FILE = join(CONFIG_DIR, "model-failover.log");

// Estado global único del plugin
const State = {
	config: null,
	currentIndex: 0,
	currentModel: null,
	healthMap: new Map(),
	isFailingOver: false,
	lastError: null
};

// ------------------------------------------------------------
// 2. SISTEMA DE LOGS
// ------------------------------------------------------------

const LogLevels = { ERROR: 0, INFO: 1, DEBUG: 2 };

function GetLogLevel(levelName) {
	const map = { error: 0, info: 1, debug: 2 };
	return map[levelName?.toLowerCase()] ?? 1;
}

function ShouldLog(messageLevel) {
	if (!State.config) return true;
	const configured = GetLogLevel(State.config.logLevel);
	return messageLevel <= configured;
}

function Log(message, level = "info") {
	const levelNum = GetLogLevel(level);
	if (!ShouldLog(levelNum)) return;

	const timestamp = new Date().toISOString();
	const logLine = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;

	try {
		if (!existsSync(CONFIG_DIR)) {
			mkdirSync(CONFIG_DIR, { recursive: true });
		}
		appendFileSync(LOG_FILE, logLine, "utf8");
	} catch (err) {
		console.error("[ModelFailover] Error escribiendo log:", err.message);
	}

	if (level === "error") console.error(`[ModelFailover] ${message}`);
	else if (level === "debug") console.debug(`[ModelFailover] ${message}`);
	else console.log(`[ModelFailover] ${message}`);
}

// ------------------------------------------------------------
// 3. CARGA DE CONFIGURACIÓN
// ------------------------------------------------------------

function LoadConfig() {
	try {
		if (!existsSync(CONFIG_FILE)) {
			Log("Archivo de configuración no encontrado: " + CONFIG_FILE, "error");
			return null;
		}

		const raw = readFileSync(CONFIG_FILE, "utf8");
		const config = JSON.parse(raw);

		if (!config.enabled) {
			Log("Plugin deshabilitado por configuración", "info");
			return null;
		}

		if (!config.models || !Array.isArray(config.models) || config.models.length === 0) {
			Log("La configuración debe tener un array 'models' no vacío", "error");
			return null;
		}

		Log(`Configuración cargada: ${config.models.length} modelos en cadena`, "debug");
		return config;
	} catch (err) {
		Log(`Error cargando configuración: ${err.message}`, "error");
		return null;
	}
}

// ------------------------------------------------------------
// 4. LÓGICA CENTRAL DE FAILOVER
// ------------------------------------------------------------

function GetModelIdentifier(modelEntry) {
	return `${modelEntry.model}:${modelEntry.variant || "default"}`;
}

function IsRetryableError(error) {
	// Solo consideramos errores con código de estado HTTP 40X (400-499)
	const status = error?.status || error?.statusCode || 0;
	return status >= 400 && status < 500;
}

function GetNextModel() {
	if (!State.config) return null;

	const models = State.config.models;
	const startIndex = State.currentIndex;

	for (let i = 0; i < models.length; i++) {
		const idx = (startIndex + i) % models.length;
		const modelEntry = models[idx];
		const modelId = GetModelIdentifier(modelEntry);

		if (!State.healthMap.get(modelId) === false) {
			State.currentIndex = idx;
			return modelEntry;
		}
	}

	// Si todos están caídos, reiniciamos y probamos desde el principio
	Log("Todos los modelos están caídos. Reiniciando healthMap...", "info");
	State.healthMap.clear();
	State.currentIndex = 0;
	return models[0] || null;
}

function PerformFailover(error) {
	if (State.isFailingOver) {
		Log("Failover ya en progreso, ignorando...", "debug");
		return null;
	}

	if (!State.config) {
		Log("Configuración no disponible para failover", "error");
		return null;
	}

	const models = State.config.models;
	if (models.length === 0) return null;

	const currentModelId = GetModelIdentifier(State.currentModel);
	State.healthMap.set(currentModelId, false);
	State.lastError = error;

	Log(`Modelo ${currentModelId} ha fallado. Código: ${error?.status || error?.statusCode || "desconocido"}`, "error");

	const nextModel = GetNextModel();
	if (!nextModel) {
		Log("❌ CHAIN EXHAUSTED - No hay más modelos disponibles", "error");
		return null;
	}

	const nextModelId = GetModelIdentifier(nextModel);
	if (nextModelId === currentModelId) {
		Log("⚠️ No hay modelos alternativos disponibles. Chain exhausted.", "error");
		return null;
	}

	State.isFailingOver = true;
	State.currentModel = nextModel;
	State.currentIndex = State.config.models.indexOf(nextModel);

	Log(`🔄 FAILOVER → ${nextModelId}`, "info");
	console.log(`\n[ModelFailover] ⚡ Failover to ${nextModelId}\n`);

	State.isFailingOver = false;
	return nextModel;
}

// ------------------------------------------------------------
// 5. RESET DE POSICIÓN (modelo funciona → volver al principio)
// ------------------------------------------------------------

function ResetToPrimary() {
	if (!State.config || State.config.models.length === 0) return;

	const primaryId = GetModelIdentifier(State.config.models[0]);
	const currentId = GetModelIdentifier(State.currentModel);

	if (currentId !== primaryId && State.currentModel) {
		if (!State.healthMap.get(primaryId) === false) {
			Log(`🔄 Volviendo al modelo primario: ${primaryId}`, "info");
			State.currentIndex = 0;
			State.currentModel = State.config.models[0];
			State.healthMap.delete(primaryId);
		}
	}
}

// ------------------------------------------------------------
// 6. HOOKS DE OPECODE
// ------------------------------------------------------------

export const ModelFailoverPlugin = async (context) => {
	Log("Plugin ModelFailover cargado correctamente", "info");

	State.config = LoadConfig();

	if (!State.config || !State.config.enabled) {
		Log("Plugin desactivado o sin configuración válida", "info");
		return {};
	}

	if (State.config.models.length > 0) {
		State.currentIndex = 0;
		State.currentModel = State.config.models[0];
		Log(`Modelo inicial: ${GetModelIdentifier(State.currentModel)}`, "info");
	}

	return {
		"session.error": async ({ event }) => {
			if (!State.config?.enabled) return;

			const error = event?.data?.error || event?.error || event;
			Log(`Evento session.error detectado: ${error?.message || "sin detalles"}`, "debug");

			if (IsRetryableError(error)) {
				const nextModel = PerformFailover(error);
				if (!nextModel) {
					Log("❌ No se pudo realizar failover. Chain exhausted.", "error");
				}
			} else {
				Log(`Error no retryable (código ${error?.status || error?.statusCode || 'sin código'})`, "debug");
			}
		},

		"message.updated": async ({ event }) => {
			if (!State.config?.enabled) return;

			const message = event?.data || event;
			if (message && !message.error) {
				ResetToPrimary();
			}
		},

		"session.updated": async ({ event }) => {
			if (!State.config?.enabled) return;

			const session = event?.data || event;
			if (session?.status === "error") {
				const error = session?.error || session?.lastError;
				if (error && IsRetryableError(error)) {
					const nextModel = PerformFailover(error);
					if (!nextModel) {
						Log("❌ No se pudo realizar failover. Chain exhausted.", "error");
					}
				}
			}
		},

		"tool.execute.before": async ({ event }) => {
			if (!State.config?.enabled) return;

			const currentId = GetModelIdentifier(State.currentModel);
			if (State.healthMap.get(currentId) === false) {
				Log(`Modelo actual ${currentId} está marcado como caído, forzando failover`, "debug");
				const nextModel = PerformFailover(new Error("Modelo marcado como caído previamente"));
				if (!nextModel) {
					Log("❌ No se pudo realizar failover. Chain exhausted.", "error");
				}
			}
		}
	};
};

export default ModelFailoverPlugin;

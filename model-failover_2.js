/**
 * model-failover.js
 * Plugin de failover para OpenCode CLI.
 * Intercepta peticiones LLM, detecta errores 4xx, rota al siguiente modelo en cadena,
 * reinicia el puntero al tener éxito, y loggea todo a archivo.
 */

const Fs = require("fs");
const Path = require("path");
const Os = require("Os");
const Http = require("http");
const Https = require("https");

class modelFailoverPlugin {
	constructor()
	{
		this.State = {
			Enabled: false,
			Models: [],
			CurrentIndex: 0,
			LogLevel: "info",
			ConfigPath: Path.join(Os.homedir(), ".config", "opencode", "model-failover.json"),
			LogPath: Path.join(Os.homedir(), ".config", "opencode", "model-failover.log"),
			IsExhausted: false,
			LastError: null,
			RequestCount: 0,
			OriginalFetch: null,
			IsInitialized: false
		};

		this.Initialize();
	}

	Initialize()
	{
		if (this.State.IsInitialized) return;

		try {
			if (Fs.existsSync(this.State.ConfigPath)) {
				const RawConfig = Fs.readFileSync(this.State.ConfigPath, "utf8");
				const ParsedConfig = JSON.parse(RawConfig);

				this.State.Enabled = Boolean(ParsedConfig.Enabled);
				this.State.Models = Array.isArray(ParsedConfig.Models) ? ParsedConfig.Models : [];
				this.State.LogLevel = (ParsedConfig.LogLevel === "debug" || ParsedConfig.LogLevel === "error") ? ParsedConfig.LogLevel : "info";
				this.State.IsExhausted = false;
				this.State.CurrentIndex = 0;
				this.State.IsInitialized = true;

				this.WriteLog("info", "Plugin loaded. Chain: " + this.State.Models.length + " models. Enabled: " + this.State.Enabled);

				if (this.State.Enabled) {
					this.InterceptNetwork();
				}
			} else {
				this.WriteLog("error", "Config missing at " + this.State.ConfigPath);
			}
		} catch (Error) {
			this.WriteLog("error", "Init failed: " + Error.message);
		}
	}

	WriteLog(Level, Message)
	{
		const LevelOrder = { "error": 0, "info": 1, "debug": 2 };
		const CurrentThreshold = LevelOrder[this.State.LogLevel] || 0;
		const MessageLevel = LevelOrder[Level];

		if (MessageLevel === undefined || MessageLevel > CurrentThreshold) return;

		const Timestamp = new Date().toISOString();
		const LogLine = `[${Timestamp}] [${Level.toUpperCase()}] ${Message}\n`;

		try {
			Fs.appendFileSync(this.State.LogPath, LogLine);
		} catch (Error) {
			console.error("[Failover] WriteLog error: " + Error.message);
		}
	}

	GetNextModel()
	{
		if (this.State.CurrentIndex >= this.State.Models.length) {
			this.State.IsExhausted = true;
			this.WriteLog("error", "Chain exhausted. No fallback models.");
			console.error("\n[Failover] Chain exhausted. Task aborted.\n");
			return null;
		}

		return this.State.Models[this.State.CurrentIndex];
	}

	InterceptNetwork()
	{
		// Node 18+ usa fetch nativo. Interceptar global es seguro si se escopa a rutas LLM.
		if (typeof globalThis.fetch === "function") {
			this.State.OriginalFetch = globalThis.fetch;
			const Self = this;

			globalThis.fetch = async function FetchInterceptor(url, options)
			{
				// Solo interceptar si parece una petición LLM (endpoints comunes)
				const UrlString = typeof url === "string" ? url : url.toString();
				const IsLlmRequest = UrlString.includes("/v1/chat") || UrlString.includes("/v1/completions") || UrlString.includes("/generate");

				if (!IsLlmRequest || Self.State.IsExhausted) {
					return Self.State.OriginalFetch(url, options);
				}

				Self.State.RequestCount++;
				Self.WriteLog("debug", "Request #" + Self.State.RequestCount + " intercepted.");

				try {
					const Response = await Self.State.OriginalFetch(url, options);

					if (Response.status >= 400 && Response.status < 500) {
						Self.WriteLog("info", "HTTP " + Response.status + " detected. Triggering failover...");
						const RetryResult = await Self.HandleFailover(url, options, Response);
						return RetryResult || Response;
					}

					// Éxito: reiniciar puntero
					Self.State.CurrentIndex = 0;
					Self.WriteLog("debug", "Request successful. Pointer reset to 0.");
					return Response;
				} catch (Error) {
					Self.WriteLog("error", "Network exception: " + Error.message);
					throw Error;
				}
			};

			this.WriteLog("info", "globalThis.fetch intercepted successfully.");
		} else {
			// Fallback para Node <18: interceptar http/https.request (más complejo, loggeamos advertencia)
			this.WriteLog("error", "globalThis.fetch not available. Failover requires Node 18+.");
		}
	}

	async HandleFailover(url, options, failedResponse)
	{
		if (!this.State.Enabled || this.State.IsExhausted) return null;

		// Avanzar al siguiente modelo
		this.State.CurrentIndex++;
		const NextModel = this.GetNextModel();
		if (!NextModel) return null;

		console.log("\n[Failover] Switching to: " + NextModel.Model + " (variant: " + NextModel.Variant + ")\n");
		this.WriteLog("info", "Failover to " + NextModel.Model);

		// Modificar cuerpo de la petición si es JSON
		let NewOptions = { ...options };
		if (NewOptions.body && typeof NewOptions.body === "string") {
			try {
				const ParsedBody = JSON.parse(NewOptions.body);
				// Reemplazar campo model común en APIs LLM
				ParsedBody.model = NextModel.Model;
				if (NextModel.Variant) ParsedBody.variant = NextModel.Variant;
				NewOptions.body = JSON.stringify(ParsedBody);
			} catch (Error) {
				this.WriteLog("debug", "Body is not JSON, sending original with model header override.");
				NewOptions.headers = { ...(NewOptions.headers || {}), "X-Failover-Model": NextModel.Model };
			}
		}

		// Reintentar con el mismo fetch original
		try {
			const RetryResponse = await this.State.OriginalFetch(url, NewOptions);
			if (RetryResponse.ok) {
				this.State.CurrentIndex = 0; // Éxito, resetear
				this.WriteLog("info", "Retry successful with " + NextModel.Model);
			}
			return RetryResponse;
		} catch (Error) {
			this.WriteLog("error", "Retry failed: " + Error.message);
			return this.HandleFailover(url, NewOptions, null); // Recursión controlada (avanza índice)
		}
	}
}

// Exportación estándar para carga por CLI / plugin loader
module.exports = modelFailoverPlugin;

// Auto-inicialización si se carga como script global o require directo
if (require.main === module || typeof global !== "undefined") {
	const Instance = new modelFailoverPlugin();
	if (global.opencode && global.opencode.plugins) {
		global.opencode.plugins.register("model-failover", Instance);
	}
}

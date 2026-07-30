/**
 * llama.cpp Metrics Monitor
 *
 * Shows live llama.cpp server metrics while the agent works, by polling the
 * server's Prometheus `/metrics` endpoint (enabled with `--metrics` /
 * LLAMA_ARG_ENDPOINT_METRICS). Companion to thinking-budget-cap.ts and
 * llamacpp-reasoning-mode.ts.
 *
 * Display:
 *   - A one-line footer status (ctx.ui.setStatus) with the headline numbers:
 *     generation tok/s, prompt tok/s, requests currently processing.
 *   - A multi-line widget above the editor (ctx.ui.setWidget) with the fuller
 *     breakdown (throughput, totals, decode/slot stats, KV cache if exposed).
 *
 * The poller only runs while a llama.cpp request is in flight: it starts on
 * `before_provider_request` and stops after `after_provider_response` (with one
 * final refresh so the last-known throughput/totals stay on screen while idle).
 * llama.cpp's `requests_processing` gauge confirms when the server is busy.
 *
 * Metrics parsed (llama.cpp exposes a subset depending on version; missing ones
 * are simply skipped):
 *   llamacpp:predicted_tokens_seconds   generation throughput (gauge)
 *   llamacpp:prompt_tokens_seconds      prompt/prefill throughput (gauge)
 *   llamacpp:requests_processing        in-flight requests (gauge)
 *   llamacpp:requests_deferred          queued requests (gauge)
 *   llamacpp:tokens_predicted_total     cumulative generated tokens (counter)
 *   llamacpp:prompt_tokens_total        cumulative prompt tokens (counter)
 *   llamacpp:n_decode_total             cumulative llama_decode() calls
 *   llamacpp:n_busy_slots_per_decode    avg busy slots per decode (gauge)
 *   llamacpp:kv_cache_usage_ratio       KV cache fill 0..1 (gauge, if present)
 *   llamacpp:kv_cache_tokens            KV cache tokens (gauge, if present)
 *
 * Runtime control:
 *   /metrics            print a full snapshot now
 *   /metrics on         arm the monitor (poll live during requests)
 *   /metrics off        disarm and clear the display
 *   /metrics url        show the resolved metrics endpoint URL
 *
 * Configuration (all optional):
 *   PI_METRICS_URL         full metrics URL. Overrides auto-detection, e.g.
 *                          http://localhost:8080/metrics
 *   PI_METRICS_INTERVAL_MS poll interval in ms. Default 2000. Clamped to >=250.
 *   PI_METRICS_AUTOSTART   "on" (default) | "off". Whether the monitor is armed
 *                          at session start (polls during requests). Toggle at
 *                          runtime with /metrics on|off.
 *
 * URL resolution order: PI_METRICS_URL, else the llamacpp provider's resolved
 * base URL (from ctx.modelRegistry.getProviderAuth) with a trailing /v1 stripped
 * and /metrics appended, else http://localhost:8080/metrics.
 *
 * Router mode: when llama-server serves multiple models (router mode), the
 * `/metrics` endpoint must be queried per-model via `?model=<model>`. This is
 * automatic: whenever the active model's provider is llamacpp and its id is
 * known, the id is appended as a `model` query param. Non-router llama-server
 * instances simply ignore the unknown query param, so no extra configuration
 * is needed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TARGET_PROVIDER = "llamacpp";
const STATUS_KEY = "llamacpp-metrics";
const DEFAULT_URL = "http://localhost:8080/metrics";
const DEFAULT_INTERVAL_MS = 2000;
const MIN_INTERVAL_MS = 250;

type Metrics = Record<string, number>;

/** Parse Prometheus text exposition into a flat name->value map. */
function parsePrometheus(text: string): Metrics {
	const out: Metrics = {};
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		// `name value` or `name{labels...} value`; take last whitespace field.
		const lastSpace = trimmed.lastIndexOf(" ");
		if (lastSpace < 0) continue;
		let name = trimmed.slice(0, lastSpace).trim();
		const value = Number.parseFloat(trimmed.slice(lastSpace + 1).trim());
		if (!Number.isFinite(value)) continue;
		const brace = name.indexOf("{");
		if (brace >= 0) name = name.slice(0, brace);
		out[name] = value;
	}
	return out;
}

/** Append `?model=<modelId>` (router mode) to the metrics URL, if known. */
function withModelParam(url: string, modelId: string | undefined): string {
	if (!modelId) return url;
	try {
		const u = new URL(url);
		u.searchParams.set("model", modelId);
		return u.toString();
	} catch {
		return url; // malformed URL: fall back unchanged
	}
}

function fmt(n: number | undefined, digits = 1): string {
	if (n === undefined || !Number.isFinite(n)) return "-";
	return n.toLocaleString("en-US", {
		minimumFractionDigits: 0,
		maximumFractionDigits: digits,
	});
}

function statusLine(m: Metrics): string {
	const gen = m["llamacpp:predicted_tokens_seconds"];
	const prompt = m["llamacpp:prompt_tokens_seconds"];
	const processing = m["llamacpp:requests_processing"];
	const deferred = m["llamacpp:requests_deferred"];
	const parts = [
		`gen ${fmt(gen)} tok/s`,
		`prompt ${fmt(prompt)} tok/s`,
		`busy ${fmt(processing, 0)}`,
	];
	if (deferred && deferred > 0) parts.push(`queued ${fmt(deferred, 0)}`);
	return `llama.cpp: ${parts.join(" · ")}`;
}

function widgetLines(m: Metrics): string[] {
	const lines: string[] = ["llama.cpp metrics"];
	const push = (label: string, key: string, digits = 1, suffix = "") => {
		if (m[key] !== undefined) lines.push(`  ${label}: ${fmt(m[key], digits)}${suffix}`);
	};
	push("gen throughput", "llamacpp:predicted_tokens_seconds", 1, " tok/s");
	push("prompt throughput", "llamacpp:prompt_tokens_seconds", 1, " tok/s");
	push("processing", "llamacpp:requests_processing", 0);
	push("deferred", "llamacpp:requests_deferred", 0);
	push("predicted total", "llamacpp:tokens_predicted_total", 0, " tok");
	push("prompt total", "llamacpp:prompt_tokens_total", 0, " tok");
	push("decode calls", "llamacpp:n_decode_total", 0);
	push("busy slots/decode", "llamacpp:n_busy_slots_per_decode", 2);
	if (m["llamacpp:kv_cache_usage_ratio"] !== undefined) {
		lines.push(`  kv cache: ${fmt(m["llamacpp:kv_cache_usage_ratio"] * 100, 1)}%`);
	}
	push("kv cache tokens", "llamacpp:kv_cache_tokens", 0, " tok");
	return lines;
}

export default function llamacppMetricsExtension(pi: ExtensionAPI) {
	const intervalRaw = Number.parseInt(process.env.PI_METRICS_INTERVAL_MS ?? "", 10);
	const intervalMs = Number.isFinite(intervalRaw)
		? Math.max(MIN_INTERVAL_MS, intervalRaw)
		: DEFAULT_INTERVAL_MS;
	const autostart = (process.env.PI_METRICS_AUTOSTART ?? "on").trim().toLowerCase() !== "off";

	let metricsUrl = process.env.PI_METRICS_URL?.trim() || "";
	let authHeaders: Record<string, string> = {};
	let timer: ReturnType<typeof setInterval> | undefined;
	let enabled = autostart; // armed: poll while requests are in flight
	let inFlight = 0;
	let warnedFetch = false;
	let lastCtx: any;

	// Resolve the metrics URL + auth headers from the llamacpp provider config,
	// unless an explicit PI_METRICS_URL was given.
	function resolveEndpoint(ctx: any) {
		try {
			const auth = ctx?.modelRegistry?.getProviderAuth?.(TARGET_PROVIDER);
			if (auth?.headers && typeof auth.headers === "object") {
				authHeaders = { ...auth.headers };
			}
			if (auth?.apiKey && !authHeaders["Authorization"] && !authHeaders["authorization"]) {
				authHeaders["Authorization"] = `Bearer ${auth.apiKey}`;
			}
			if (!metricsUrl) {
				const base: string | undefined = auth?.baseUrl;
				if (base) {
					const root = base.replace(/\/+$/, "").replace(/\/v\d+$/, "");
					metricsUrl = `${root}/metrics`;
				}
			}
		} catch {
			// fall through to default
		}
		if (!metricsUrl) metricsUrl = DEFAULT_URL;
	}

	async function fetchMetrics(modelId?: string): Promise<Metrics | null> {
		try {
			const res = await fetch(withModelParam(metricsUrl, modelId), { headers: authHeaders });
			if (!res.ok) return null;
			return parsePrometheus(await res.text());
		} catch {
			return null;
		}
	}

	async function refresh(ctx: any) {
		const modelId = ctx?.model?.provider === TARGET_PROVIDER ? ctx.model.id : undefined;
		const m = await fetchMetrics(modelId);
		if (!ctx?.hasUI) return;
		if (m === null) {
			if (!warnedFetch) {
				warnedFetch = true;
				ctx.ui.setStatus(
					STATUS_KEY,
					`llama.cpp metrics: unreachable (${withModelParam(metricsUrl, modelId)})`,
				);
			}
			return;
		}
		warnedFetch = false;
		ctx.ui.setStatus(STATUS_KEY, statusLine(m));
		ctx.ui.setWidget(STATUS_KEY, widgetLines(m));
	}

	function startPolling(ctx: any) {
		lastCtx = ctx;
		if (timer) return;
		void refresh(ctx);
		timer = setInterval(() => void refresh(lastCtx), intervalMs);
		// Don't keep the process alive just for polling.
		(timer as any)?.unref?.();
	}

	function stopPolling() {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	}

	function clearDisplay(ctx: any) {
		if (ctx?.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, "");
			ctx.ui.setWidget(STATUS_KEY, []);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		resolveEndpoint(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopPolling();
		clearDisplay(ctx);
	});

	// Poll only while a llama.cpp request is actually in flight.
	pi.on("before_provider_request", (_event, ctx) => {
		if (ctx.model?.provider !== TARGET_PROVIDER) return undefined;
		lastCtx = ctx;
		inFlight++;
		if (enabled) startPolling(ctx);
		return undefined;
	});

	pi.on("after_provider_response", (_event, ctx) => {
		if (ctx.model?.provider !== TARGET_PROVIDER) return;
		lastCtx = ctx;
		inFlight = Math.max(0, inFlight - 1);
		if (inFlight === 0) {
			stopPolling();
			// One last refresh so the final numbers linger on screen while idle.
			if (enabled) void refresh(ctx);
		}
	});

	pi.registerCommand("metrics", {
		description: "llama.cpp metrics: on | off | url | (blank for snapshot now)",
		getArgumentCompletions: (prefix) => {
			const opts = ["on", "off", "url"];
			const filtered = opts.filter((o) => o.startsWith(prefix.trim().toLowerCase()));
			return filtered.length > 0 ? filtered.map((o) => ({ value: o, label: o })) : null;
		},
		handler: async (args, ctx) => {
			if (!metricsUrl) resolveEndpoint(ctx);
			const arg = args.trim().toLowerCase();
			const modelId = ctx?.model?.provider === TARGET_PROVIDER ? ctx.model.id : undefined;

			if (arg === "on") {
				enabled = true;
				if (inFlight > 0) startPolling(ctx);
				ctx.ui.notify(
					`llama.cpp metrics: armed — polls during requests (${withModelParam(metricsUrl, modelId)})`,
					"info",
				);
				return;
			}
			if (arg === "off") {
				enabled = false;
				stopPolling();
				clearDisplay(ctx);
				ctx.ui.notify("llama.cpp metrics: disarmed", "info");
				return;
			}
			if (arg === "url") {
				ctx.ui.notify(`llama.cpp metrics endpoint: ${withModelParam(metricsUrl, modelId)}`, "info");
				return;
			}

			// Blank / anything else: one-shot snapshot.
			const m = await fetchMetrics(modelId);
			if (m === null) {
				ctx.ui.notify(
					`llama.cpp metrics: could not reach ${withModelParam(metricsUrl, modelId)}. Is the server ` +
						"started with --metrics?",
					"error",
				);
				return;
			}
			ctx.ui.notify(widgetLines(m).join("\n"), "info");
		},
	});
}

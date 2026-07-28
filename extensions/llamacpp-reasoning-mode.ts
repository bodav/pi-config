/**
 * llama.cpp Reasoning Mode
 *
 * Turns the model's chain-of-thought reasoning on or off, either up front via an
 * env var or interactively at runtime via the `/reasoning` slash command.
 * Complements thinking-budget-cap.ts: that extension tunes HOW MUCH the model
 * thinks, this one decides WHETHER it thinks at all.
 *
 * How it works (verified against llama.cpp server-common.cpp):
 *
 *   Each request is initialized from the server's launch flags (opt.*), then any
 *   matching field in the request body OVERRIDES that default. So per-request
 *   fields win over `--reasoning` / `--reasoning-budget` at startup.
 *
 *   - "off": we set three overlapping switches so thinking is suppressed
 *     regardless of the model's chat template:
 *       reasoning_effort: "none"            -> server maps to enable_thinking=false
 *       chat_template_kwargs.enable_thinking: false  -> template-level toggle
 *       reasoning_budget_tokens: 0          -> model-agnostic hard end-of-thinking
 *     The budget=0 path is the robust one: it force-closes the think block even
 *     for templates that ignore enable_thinking.
 *
 *   - "on": we request thinking explicitly via the template toggle:
 *       chat_template_kwargs.enable_thinking: true
 *     We deliberately do NOT send reasoning_budget_tokens here: the server treats
 *     -1 as "defer to server default", so a request cannot UNLOCK a budget cap
 *     the server imposed at launch. If the server was started with
 *     `--reasoning-budget 0`, "on" cannot force thinking back on; raise the
 *     server cap (or use budget>0) for that.
 *
 *   - "auto" (default): returns the payload untouched, so the server's launch
 *     configuration / the model's template decides.
 *
 * Field names matter: the per-request budget field is `reasoning_budget_tokens`
 * (server-common.cpp), NOT `reasoning_budget` (that is the launch flag only).
 *
 * Runtime control:
 *   /reasoning            show the current mode
 *   /reasoning on         force thinking on for subsequent requests
 *   /reasoning off        force thinking off for subsequent requests
 *   /reasoning auto       defer to the server/template default
 *
 * The chosen mode lives in memory for the session and takes effect on the next
 * provider request. It is not persisted across restarts; use PI_REASONING to set
 * the startup default.
 *
 * Configuration (optional):
 *   PI_REASONING  "on" | "off" | "auto". Default "auto". Startup mode.
 *
 * The provider is hardcoded to "llamacpp": only the local llama.cpp provider is
 * touched; cloud/other models are left untouched. Unknown fields are ignored by
 * servers, so an older llama.cpp that doesn't understand a field simply skips it
 * rather than erroring.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TARGET_PROVIDER = "llamacpp";

type Mode = "on" | "off" | "auto";

const MODES: Mode[] = ["on", "off", "auto"];

function parseMode(raw: string | undefined): Mode | null {
	switch (raw?.trim().toLowerCase()) {
		case "on":
		case "1":
		case "true":
		case "enabled":
			return "on";
		case "off":
		case "0":
		case "false":
		case "none":
		case "disabled":
			return "off";
		case "auto":
		case "":
		case undefined:
			return "auto";
		default:
			return null;
	}
}

export default function llamacppReasoningModeExtension(pi: ExtensionAPI) {
	// Startup default; may be changed at runtime via /reasoning.
	let mode: Mode = parseMode(process.env.PI_REASONING) ?? "auto";

	pi.registerCommand("reasoning", {
		description: "Control llama.cpp reasoning: on | off | auto",
		getArgumentCompletions: (prefix) => {
			const filtered = MODES.filter((o) => o.startsWith(prefix.trim().toLowerCase()));
			return filtered.length > 0 ? filtered.map((o) => ({ value: o, label: o })) : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			if (arg === "" || arg === "status") {
				ctx.ui.notify(`reasoning: ${mode} (llama.cpp)`, "info");
				return;
			}

			const parsed = parseMode(arg);
			if (parsed === null) {
				ctx.ui.notify(`reasoning: unknown mode "${arg}". Use on | off | auto.`, "error");
				return;
			}

			mode = parsed;
			ctx.ui.notify(`reasoning set to: ${mode} (applies to next request)`, "info");
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		// Only touch the local llama.cpp provider; leave cloud/other models alone.
		if (ctx.model?.provider !== TARGET_PROVIDER) return undefined;
		// "auto" defers entirely to the server/template — nothing to inject.
		if (mode === "auto") return undefined;

		const payload = event.payload as Record<string, unknown>;

		// Merge rather than clobber any chat_template_kwargs already present.
		const existingKwargs =
			(payload.chat_template_kwargs as Record<string, unknown> | undefined) ?? {};

		if (mode === "off") {
			return {
				...payload,
				reasoning_effort: "none",
				reasoning_budget_tokens: 0,
				chat_template_kwargs: { ...existingKwargs, enable_thinking: false },
			};
		}

		// mode === "on"
		return {
			...payload,
			chat_template_kwargs: { ...existingKwargs, enable_thinking: true },
		};
	});
}

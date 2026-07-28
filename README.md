# pi-config

Extensions, skills, and prompts for [`pi`](https://github.com/earendil-works/pi) (the `@earendil-works/pi-coding-agent` CLI).

## Addons

### Extensions

| File | What it does | Config |
|---|---|---|
| `extensions/write-edit-guard.ts` | Blocks `write` on existing files; redirects to `edit`. Also detects `rm`/`mv` bypass attempts and protects `.git/` and `node_modules/`. | — |
| `extensions/llamacpp-reasoning-mode.ts` | Toggles chain-of-thought reasoning on/off for the llama.cpp provider via `/reasoning` slash command or `PI_REASONING` env var. | `PI_REASONING` (`on` / `off` / `auto`) |

### Skills

| Directory | When it loads |
|---|---|
| `skills/workspace-discovery/` | Before any code change — requires reading AGENTS.md, README.md, package manifest first |
| `skills/edit-over-write/` | Any modification to an existing file — enforces `edit` tool, never `write` |
| `skills/claim-verification/` | Bug hunts, reviews, audits — must quote the defining source line before asserting code is wrong |

## Install

```bash
pi install git:github.com/bodav/pi-config
```

## Update

```bash
pi update pi-config
```

## Remove

```bash
pi remove pi-config
```

## Configuration

| Env var | Values | Default | Description |
|---|---|---|---|
| `PI_REASONING` | `on`, `off`, `auto` | `auto` | Startup reasoning mode for llama.cpp |

Use `pi config` (interactive TUI) to enable/disable individual extensions or skills without uninstalling the whole package.

## How each piece works

### Write-Edit Guard

Intercepts `tool_call` events and blocks `write` if the target path exists on disk, was deleted earlier in the session (closes `rm && write` bypass), or is inside `.git/` / `node_modules/`. Returns a structured reason directing the model to use `edit` instead.

### llama.cpp Reasoning Mode

Injects `reasoning_effort`, `reasoning_budget_tokens`, and `chat_template_kwargs.enable_thinking` into llama.cpp requests based on the chosen mode. All three switches are set for "off" to suppress thinking regardless of the model's chat template. Runtime control via the `/reasoning` slash command.

### Workspace Discovery

Instructs the model to run a discovery pass — check for AGENTS.md, CLAUDE.md, README.md — and read the package manifest before any code changes. Prevents small models from charging into edits without understanding project conventions.

### Edit-Over-Write

Reinforces the edit-over-write rule at the instruction layer so the tool-level guard fires less often.

### Claim Verification

Imposes a "no claim without a quoted source line" discipline: read and cite the defining source before asserting anything is wrong, trace control flow (or run it) for runtime claims, and label unverified guesses as guesses.

## License

MIT

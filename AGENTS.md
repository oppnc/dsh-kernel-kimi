# AGENTS.md — Maintainer Guide

Verbose engineering notes for `dsh-kernel-kimi`. This package is "Kimi Code written in DSH
form": the kimi-cli tool surface re-registered as DSH tools with identical names and schemas,
implemented on DSH services so the surface survives `toolFilter` scoping.

## System prompt (persona)

`lib/system-prompt.js` carries the upstream **Kimi Code CLI** system prompt, rewritten in DSH
form: tool names and runtime placeholders are adapted to the DSH tool surface, while the
behavior rules are kept verbatim. Upstream source: https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/agents/default/system.md

`apply()` registers it as the `deployment:persona` section (order `0`) with
`complete: true`, and calls `systemPrompt.suppressRuntimeContext()`. Together these make
the vendor prompt the **sole** system-prompt section and drop the runtime-context snapshot,
so a session on this kernel sees ONLY the vendor's own system prompt.

Consequence for presets: a preset that mounts this plugin MUST NOT also mount a
`@deepseek-ai/dsh-persona` row — both register `deployment:persona` in the same scope and
the second registration throws. The kernel presets ship without that row.

## Tool registry and schema provenance

Each tool inherits its name and parameter schema from the kimi-cli source (Pydantic `Params`
classes under `kimi-cli/src/kimi_cli/tools/`). The table maps tool → provenance file.

| Tool | kimi-cli source |
| --- | --- |
| `ReadFile` | `read.py` |
| `WriteFile` | `write.py` |
| `StrReplaceFile` | `replace.py` |
| `Glob` | `glob.py` |
| `Grep` | `grep_local.py` |
| `Shell` | `shell/__init__.py` |
| `ReadMediaFile` | `read_media.py` |
| `SearchWeb` | web tool definition |
| `FetchURL` | web tool definition |
| `TaskList` | task/background tool definition |
| `TaskOutput` | task/background tool definition |
| `TaskStop` | task/background tool definition |
| `SetTodoList` | `todo/__init__.py` |
| `AskUserQuestion` | `ask_user/__init__.py` |
| `Agent` | `tools/agent` |
| `ExitPlanMode` | plan-mode tool definition |
| `EnterPlanMode` | plan-mode tool definition |

## Service-level implementation decisions

All tools read their dependencies via `ctx.get(...)` (optional) so a missing service degrades
to a clear error string rather than crashing the plugin.

- **fs — direct use.** `ReadFile`/`WriteFile`/`StrReplaceFile`/`Glob`/`Grep` call the DSH `fs`
  service directly. For *mutating* writes `WriteFile` and `StrReplaceFile` pass
  `sandboxPolicy.resolve()` as the 5th argument to `fs.writeText`/`fs.editText`; this was a
  real bug fix — without it the sandbox rejected valid writes. The working-directory fallback
  for `cwd` uses `sandboxPolicy.workspaceRoot`.
- **subprocess — `resolveExecutable` + fallback.** `Shell` first tries
  `subprocess.resolveExecutable('pwsh.exe')`, falling back to the absolute Windows PowerShell
  path `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`. This fixes an `ENOENT`
  that occurred under a sanitized `PATH`. Output is bounded (`stdout` 1 MB, `stderr` 100 KB)
  and quoted with an exit-code marker.
- **own glob matcher.** `globToRegex` implements `*`, `**`, `?`, and `{a,b}` brace expansion
  (with regex metacharacter escaping) because the `fs` service exposes no glob primitive.
  `Glob` and `Grep`'s `glob` filter share it, and both skip `SKIP_DIRS`
  (`node_modules`, `.git`, `.dsh`, `.venv`, `__pycache__`, `dist`).
- **jobs service for background tasks.** `Shell` with `run_in_background=true` spawns via
  `subprocess.spawn` and wraps it in `jobs.start`, exposing `cancel`/`done`/`readOutput`.
  `TaskList`/`TaskOutput`/`TaskStop` delegate to `jobs.list`/`jobs.read`/`jobs.wait`/
  `jobs.kill`, scoped by `exec.agent`.
- **attachments for `ReadMediaFile`.** Image bytes are read via `fs.readBytes` (20 MB cap) and
  attached with `attachments.saveImage`; the `output.render` function emits an `image` block
  from the returned attachment ref so the model can actually see it. Video is not supported.
- **userQuestions for `AskUserQuestion`.** The tool forwards the questions array to
  `userQuestions.ask` and JSON-serializes the answer. Note the DSH option shape uses camelCase
  (`multiSelect`), mapped from the kimi snake_case `multi_select`.
- **plugin-local todo store.** `SetTodoList` keeps a `Map` keyed by `exec.agent.id`; there is
  no DSH todos service, so parity is achieved with an in-plugin store.
- **`Agent` matches the stock `subagent` tool.** Background is the default
  (`run_in_background !== false` → `subagents.startContinuable`), returning a durable child
  id at inbox acceptance. `resume` delivers `prompt` through `subagents.followup` (the same
  channel `send_message` uses). Foreground (`run_in_background: false`) awaits
  `subagents.start` and, on a non-`completed` stop, appends
  `"Partial output before the run ended:"` plus the child's text — the native wording.
  Every request sets `agentOptions` / `persona` / `toolFilter` / `maxDepth: 3` explicitly
  because the continuable route never calls `provider.start()`. The tool declares
  `isConcurrencySafe: () => true` and registers a `systemPrompt` section (`tool:Agent`,
  order `116.5`) that teaches the background-first convention while the tool is visible.

## DSH `ToolDefinition` contract

- `output.schema` is an *enforced subset*: unlike kimi-cli, DSH must know the return shape.
  Most tools use `strDef`, which sets `output.schema = { type: 'string' }` plus a text `render`.
  Object-returning tools declare explicit `properties` and `additionalProperties` (see
  `ReadMediaFile`, whose schema sets `additionalProperties: true` to admit the `attachment`
  field). Never leave `additionalProperties` implicit.
- `render` is required and receives `(args, value)`; it returns an array of blocks
  (`text` or `image`).

## Why PascalCase names

Names are deliberately `PascalCase` (e.g. `ReadFile`, not `read_file`) to reproduce kimi-cli
exactly and to **avoid DSH's automatic `snake_case` tool-name collisions**. Registering the
authentic surface name is the whole point of the assimilation.

## Known gaps

- **Video not supported** — `ReadMediaFile` handles images only (PNG/JPEG/WebP/GIF).
- ~~**`Agent` resume / run_in_background.**~~ **RESOLVED** (mesh gap #5). `Agent` is
  background-first on the native continuable route (`subagents.startContinuable`): omitting
  `run_in_background` (or setting it true) returns a durable child id that `list_agents` /
  `send_message` / `interrupt_agent` / `Agent.resume` operate on, exactly like the stock
  `subagent` tool. Set `run_in_background: false` only to wait for the one-shot result.
  See the `Agent` implementation note above.
- **MCP / think tools omitted** — the MCP surface and kimi "think" tools have no DSH
  equivalent and are not registered.
- **loop_control knobs** (`max_attempts_per_step`, etc.) have no DSH counterpart
  (`agentLoop` only exposes `maxParallelToolCalls`); alignment is documentation level only.
- **`SearchWeb` / `FetchURL` prefer kimi-cli's Moonshot endpoints.** They POST to
  `https://api.kimi.com/coding/v1/search` and `/fetch` with the same OAuth
  access token the Kimi CLI stores under `~/.kimi-code/credentials/kimi-code.json`
  (static `api_key` is the fallback). `ctx.web` / a local GET is only used when
  that credential is missing or the Moonshot call fails. This is the 1.49
  surface: DeepSeek's `web_search` provider is **not** the kimi-cli path.

### Mesh gaps this surface used to inherit (now resolved upstream)

These lived in `dsh-kernel-mesh` and are **not** open work for this package:

- ~~**Mesh gap #5 — continuable subagent route.**~~ **RESOLVED** in the mesh; this package's
  `Agent` consumes that route as its default (see above).
- ~~**Mesh gap #6 — non-streaming transports.**~~ **RESOLVED** in the mesh: both adapter
  factories stream real SSE (`stream: true`, curl `-N`) with JSON auto-fallback when a
  provider ignores streaming. This surface has no transport of its own.
- ~~**Unclassified adapter errors.**~~ **RESOLVED** in the mesh: adapters throw with
  canonical own-property codes (`e.code` + `e.failure`) so `dsh-llm-retry` retries
  `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`. This surface does not throw adapter
  errors.

## Differential test procedure

1. Prepare identical input directories for both channels.
2. Run the real kimi CLI (ACP/yolo) on the task; record per-item outputs.
3. Run a `kimi-kernel` preset session (model `kimi-kernel/k3-256k`) on the *same* task with
   only this package's tool surface enabled.
4. Compare results item by item. A passing run shows identical counts/values (e.g. the CSS
   color tally: 17 = 11 `#hex` + 6 `rgba()`), with the difference only in the artifact
   filename (`analysis-kimi.txt` vs `analysis-dsh.txt`).
5. Optionally cross-check with an independent regex pass (`#[0-9a-fA-F]{3,8}` and
   `rgba?\(`) to confirm the numbers.

## Layout

```
dsh-kernel-kimi/
  lib/index.js      # the whole plugin (single-file ESM Cordis plugin)
  package.json      # type:module + exports/files/scripts.test (DSH plugin contract)
  LICENSE           # MIT
  README.md         # short human-facing English doc
  README.zh.md      # Chinese translation
  README.i18n.yaml  # bilingual-pair git blob hashes
  AGENTS.md         # this file
  AGENTS.zh-CN.md   # Chinese translation of this file
```


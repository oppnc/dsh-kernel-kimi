# AGENTS.md — Maintainer Guide

Verbose engineering notes for `dsh-kernel-kimi`. This package is "Kimi Code written in DSH
form": the **Kimi Code CLI 0.39.1** (`@moonshot-ai/kimi-code@0.39.1`) tool surface
re-registered as DSH tools with identical names, descriptions and schemas, implemented on
DSH services so the surface survives `toolFilter` scoping.

### Mesh dependency and fallback mount

`dsh-kernel-mesh` is a declared dependency (`dsh-kernel-mesh@^0.1.8`),
so installing this package also installs the mesh. The mesh is still expected to be mounted
ONCE by the host composition (profile bundle) and shared by all vendor packages. As a
safety net, `apply()` first runs `ensureKernelMesh(ctx, ...)` (`lib/ensure-mesh.js`): if
the mesh's `kernelMesh` marker service is absent AND no `*-kernel` route is registered,
the plugin mounts its own copy of the mesh (bare specifier, with a dev-layout sibling
fallback). A fallback-mounted mesh shares THIS row's lifecycle — its routes disappear
when the row unloads — so the profile-level mount stays the preferred form and the
fallback logs a pointer to `dsh plugin add dsh-kernel-mesh`.

## System prompt (persona)

`lib/system-prompt.js` carries the upstream **Kimi Code CLI 0.39.1** main-agent system
prompt, rewritten in DSH form. The source of truth is the fully RENDERED prompt captured
live on the wire (`.glm-test/kimi-code-distill/capture/captured-system-full.txt`); the
generator `.glm-test/kimi-code-distill/gen-prompt.mjs` applies exactly these adaptations:

1. drops the runtime-computed `# Environment` block (working dir / today's date);
2. drops the skill-listing appendix (DSH form discovers skills through the `Skill` tool
   and the `skills` service);
3. deletes the `Keep them informed` bullet — upstream itself excludes it unless
   `KIMI_CODE_SHARE_ENV` is set (the capture host had it set);
4. fixes the stale "Kimi For Coding" model sentence to the 0.39.1 catalog truth
   (default model `k3-256k` on the `kimi-for-coding` provider);
5. references the todo tool by its DSH-registered name `TodoList`.

Everything else — every behavior rule — is verbatim upstream.

`apply()` registers it as the `deployment:persona` section (order `0`) with
`complete: true`, and calls `systemPrompt.suppressRuntimeContext()`. Together these make
the vendor prompt the **sole** system-prompt section and drop the runtime-context snapshot,
so a session on this kernel sees ONLY the vendor's own system prompt.

Consequence for presets: a preset that mounts this plugin MUST NOT also mount a
`@deepseek-ai/dsh-persona` row — both register `deployment:persona` in the same scope and
the second registration throws. The kernel presets ship without that row.

## Tool registry and schema provenance

Every tool's description and parameter schema is **verbatim upstream 0.39.1**, stored in
the generated module `lib/upstream-surface.js`. Provenance:

- 26 tools come from the LIVE wire capture
  (`.glm-test/kimi-code-distill/capture/tools/<Name>.json`, captured with a
  media-capable model so `ReadMediaFile` appears);
- `WebSearch` is registered upstream only when a search provider is configured, so it was
  absent from the capture; its description comes from 0.39.1 source
  (`agent-core-v2/src/agent/tools/web-search/web-search.md`) and its schema from
  `WebSearchInputSchema` (`{query}` only).

The single intentional deviation: `ReadMediaFile`'s trailing **Capabilities** paragraph is
generated upstream from the model's modalities; DSH attachments save images only, so the
paragraph states the DSH image-only truth.

**Regeneration rule: never retype a description or schema by hand.** Re-run
`.glm-test/kimi-code-distill/gen-surface.mjs` after a new capture.

The smoke test asserts `def.description === UPSTREAM_SURFACE[name].description` and
deep-equality of `parameters` for every registered tool, so drift fails the build.

### The 27 registered tools (26 upstream wire + WebSearch)

`Agent`, `AgentSwarm`, `AskUserQuestion`, `Bash`, `CreateGoal`, `CronCreate`,
`CronDelete`, `CronList`, `Edit`, `EnterPlanMode`, `ExitPlanMode`, `FetchURL`, `GetGoal`,
`Glob`, `Grep`, `Read`, `ReadMediaFile`, `SetGoalBudget`, `Skill`, `TaskList`,
`TaskOutput`, `TaskStop`, `TodoList`, `UpdateGoal`, `WaitFor`, `WebSearch`, `Write`.

Upstream-gated-off tools are NOT registered, matching upstream defaults: `TowerInit` /
`TowerStatus` / `TowerTeardown` (`KIMI_CODE_EXPERIMENTAL_TOWER`), `select_tools`
(`TOOL_SELECT`), and the `fork` param on `Agent`/`AgentSwarm` (`SUBAGENT_FORK`).

### Old → new mapping (1.49 → 0.39.1)

| 1.49 (removed) | 0.39.1 | Notes |
| --- | --- | --- |
| `ReadFile` | `Read` | same params (`path`/`line_offset`/`n_lines`) |
| `WriteFile` | `Write` | same params |
| `StrReplaceFile` | `Edit` | schema change: single `old_string`/`new_string`/`replace_all`; no edit array |
| `Shell` | `Bash` | adds `cwd`, `disable_timeout`; `description` no longer required for background |
| `SearchWeb` | `WebSearch` | `query` only (upstream schema); DSH impl keeps limit 5, no page crawling |
| `SetTodoList` | `TodoList` | `{title,status}` items; omitted `todos` queries; `[]` clears |
| — | `WaitFor` | new; maps onto `jobs.wait` |
| — | `Skill` | new; maps onto the DSH `skills` service |
| — | `CreateGoal`/`GetGoal`/`SetGoalBudget`/`UpdateGoal` | new; map onto the DSH `goals` service |
| — | `CronCreate`/`CronList`/`CronDelete` | new; **honest stubs** (no DSH cron service) |
| — | `AgentSwarm` | new; fan-out over continuable subagents |

## Service-level implementation decisions

All tools read their dependencies via `ctx.get(...)` (optional) so a missing service
degrades to a clear error string rather than crashing the plugin.

- **fs — direct use.** `Read`/`Write`/`Edit`/`Glob`/`Grep` call the DSH `fs` service
  directly. For *mutating* writes `Write` and `Edit` pass `sandboxPolicy.resolve()` as the
  5th argument to `fs.writeText`/`fs.editText`; this was a real bug fix — without it the
  sandbox rejected valid writes. The working-directory fallback for `cwd` uses
  `sandboxPolicy.workspaceRoot`.
- **subprocess — `resolveExecutable` + fallback.** `Bash` first tries
  `subprocess.resolveExecutable('pwsh.exe')`, falling back to the absolute Windows
  PowerShell path `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`. Output is
  bounded (`stdout` 1 MB, `stderr` 100 KB) and quoted with an exit-code marker. `cwd` is
  resolved relative to the session workspace root; `disable_timeout: true` removes the
  kill timer entirely.
- **own glob matcher.** `globToRegex` implements `*`, `**`, `?`, and `{a,b}` brace
  expansion (with regex metacharacter escaping) because the `fs` service exposes no glob
  primitive. `include_ignored: true` (Glob/Grep) searches ignored directories too, but
  `.git` is always skipped (upstream semantics); the default skips `SKIP_DIRS`
  (`node_modules`, `.git`, `.dsh`, `.venv`, `__pycache__`, `dist`).
- **Grep extras.** `-i` → regex `i` flag; `multiline` → `ms` flags with whole-file
  matching (match-start line reported); `-n` line numbers are always present in DSH
  content output; `offset` + `head_limit` (default 250, `0` = unlimited) window the
  results; `type` maps through a small honest extension table (`js`, `ts`, `py`, `go`,
  `rust`, `java`, `c`, `cpp`, `json`, `md`, `html`, `css`, `sh`, `yaml`, `toml`, `xml`) —
  an unknown kind returns an error instead of silently widening the search.
- **jobs service for background tasks.** `Bash` with `run_in_background=true` spawns via
  `subprocess.spawn` and wraps it in `jobs.start`, exposing `cancel`/`done`/`readOutput`.
  `TaskList`/`TaskOutput`/`TaskStop` delegate to `jobs.list`/`jobs.read`/`jobs.kill`,
  scoped by `exec.agent`. 0.39.1 removed `TaskOutput`'s `block`/`timeout` — waiting moved
  to the new `WaitFor` tool, which maps onto `jobs.wait`; without `task_id` it races
  `jobs.wait` over every active task (upstream's "first to settle" semantics). The DSH
  jobs service has no log-file path, so `TaskOutput` returns buffered text and surfaces
  no `output_path`. `TaskStop`'s upstream `timeout` (grace before force-kill) is accepted
  but not threaded through — DSH `jobs.kill` escalation is internal.
- **attachments for `ReadMediaFile`.** Image bytes are read via `fs.readBytes` (20 MB cap)
  and attached with `attachments.saveImage`; `output.render` emits an `image` block from
  the returned ref so the model can actually see it. Upstream `region` (crop) and
  `full_resolution` are accepted but NOT honored — the attachments service has no crop
  pipeline; a text note says so when they are used. Video is not supported.
- **userQuestions for `AskUserQuestion`.** The tool forwards the questions array to
  `userQuestions.ask` (question `id`s are generated `q1..qN`; camelCase `multiSelect`
  mapped from upstream `multi_select`) and JSON-serializes the answer. Upstream
  `background: true` files the question without blocking; DSH `userQuestions` has no
  background ask, so questions are always asked in the foreground.
- **plugin-local todo store.** `TodoList` keeps a `Map` keyed by `exec.agent.id`; there is
  no DSH todos service, so parity is achieved with an in-plugin store. Omitting `todos`
  queries, `[]` clears.
- **goals service for the goal tools.** `CreateGoal` → `goals.create(agent, {objective})`
  (the upstream `completionCriterion` has no DSH field and is folded into the objective
  text; `replace: true` clears an existing goal first via `goals.clear` with the current
  ref). `GetGoal` → `goals.get`, copying only primitive leaf fields (a GoalView is live
  runtime data). `UpdateGoal` → `goals.resume` / `goals.complete` / `goals.block` with a
  policy reason `{code: 'agent-reported', ...}`. `SetGoalBudget`: only `unit: "turns"`
  maps (onto the round cap via `goals.edit(agent, ref, {max_goal_rounds})`); token and
  wall-clock budgets honestly answer "not supported by the DSH goal runtime".
- **skills service for `Skill`.** `skills.get(name, {scope, cwd, signal})` (falling back
  to a plain `get` when the scoped call fails), returning the skill body; `args` are
  appended as an `ARGUMENTS:` block (the DSH skill body has no placeholder protocol). A
  miss returns the available skill names from `skills.list`.
- **Cron tools are honest stubs.** The DSH runtime has no cron/scheduler service
  (verified via the Service inspect provider). `CronCreate`/`CronList`/`CronDelete`
  register with the verbatim upstream surface and return a clear explanation pointing at
  `CreateGoal`/`SetGoalBudget` (session continuation) and the host OS scheduler
  (wall-clock). Do NOT fake persistence — the model must learn the truth on first use.
- **`Agent` matches the stock `subagent` tool; description stays upstream-verbatim.**
  Background is the DSH default (`run_in_background !== false` →
  `subagents.startContinuable`), returning a durable child id at inbox acceptance.
  `resume` delivers `prompt` through `subagents.followup` (the same channel
  `send_message` uses). Foreground (`run_in_background: false`) awaits `subagents.start`
  and, on a non-`completed` stop, appends `"Partial output before the run ended:"` plus
  the child's text — the native wording. The upstream 0.39.1 description teaches
  FOREGROUND-first; per the sync decision the description is kept verbatim and the DSH
  runtime truth is documented by the `tool:Agent` prompt section (order `116.5`) instead.
  The non-upstream `model`/`timeout` params from 0.1.4 were dropped for schema fidelity.
  Every request sets `agentOptions` / `persona` / `maxDepth: 3` explicitly because the
  continuable route never calls `provider.start()`. `toolFilter` is deliberately NOT set:
  since dsh-tools 0.1.1-rc.2, `tools.restrict()` accepts only GLOBAL tool names and
  rejects scope-local (vendor) names — the mesh `agent/created` listener applies the
  child tool mask instead (mesh AGENTS.md §6). The tool declares
  `isConcurrencySafe: () => true`.
- **`AgentSwarm` is a fan-out mapping, not a stub.** One continuable background subagent
  per item (same spawn path as `Agent`), with `{{item}}` substituted into
  `prompt_template`; `resume_agent_ids` fans one follow-up message out to every listed
  child via `subagents.followup`. Upstream's `fork` param is gated off and not
  registered. Upstream's richer swarm topology (task dependencies, structured per-item
  results) has no DSH counterpart — the returned text lists the durable child ids and
  points at `WaitFor` / `Agent resume` / `AgentSwarm resume_agent_ids`.

## DSH `ToolDefinition` contract

- `output.schema` is an *enforced subset*: unlike the CLI, DSH must know the return
  shape. Most tools use `strDef`, which sets `output.schema = { type: 'string' }` plus a
  text `render`. Object-returning tools declare explicit `properties` and
  `additionalProperties` (see `ReadMediaFile`, whose schema sets
  `additionalProperties: true` to admit the `attachment` field). Never leave
  `additionalProperties` implicit.
- `render` is required and receives `(args, value)`; it returns an array of blocks
  (`text` or `image`).

## Why PascalCase names

Names are deliberately `PascalCase` (e.g. `Read`, not `read_file`) to reproduce the CLI
exactly and to **avoid DSH's automatic `snake_case` tool-name collisions**. Registering
the authentic surface name is the whole point of the assimilation.

## Subagent recipes (`lib/subagents.js`)

Generated by `.glm-test/kimi-code-distill/gen-subagents.mjs` from 0.39.1 source:

- personas = the verbatim shared `TASK_AGENT_ROLE_PREFIX` plus the per-type overlay
  (coder overlay from `profiles.ts` `CODER_ROLE`; explore = the full
  `explore-overlay.md`, which already embeds the prefix; plan overlay from
  `features/plan/profile/plan.ts` `PLAN_ROLE`), inserted into the full system prompt at
  the slot right before `# Prompt and Tool Use`;
- allow-lists = `CODER_TOOLS` / `EXPLORE_TOOLS` / `PLAN_TOOLS` minus `mcp__*` (no MCP in
  DSH form):
  - coder: `Bash` `CronCreate` `CronDelete` `CronList` `Edit` `EnterPlanMode`
    `ExitPlanMode` `Glob` `Grep` `Read` `ReadMediaFile` `Skill` `TaskList` `TaskOutput`
    `TaskStop` `TodoList` `WaitFor` `WebSearch` `FetchURL` `Write` — **no
    `Agent`/`AgentSwarm`** (upstream PR #2837; nesting depth 1);
  - explore: `Bash` `Read` `ReadMediaFile` `Glob` `Grep` `WebSearch` `FetchURL`;
  - plan: `Read` `ReadMediaFile` `Glob` `Grep` `WebSearch` `FetchURL` (no shell);
- upstream `summaryPolicy` (`minChars: 200`, `retries: 1`) has no DSH recipe field;
  alignment is documentation level only.

## Known gaps

- **Video not supported** — `ReadMediaFile` handles images only (PNG/JPEG/WebP/GIF).
- **`ReadMediaFile` `region`/`full_resolution` accepted but not honored** (no crop
  pipeline in the attachments service; a note is appended when they are used).
- **Cron tools are honest stubs** — no DSH cron/scheduler service exists.
- **`SetGoalBudget` only maps `turns`** — token/wall-clock budgets honestly refuse.
- **`AskUserQuestion background: true` falls back to a foreground ask** — no background
  question channel in DSH `userQuestions`.
- **`TaskStop timeout` accepted but not threaded** — `jobs.kill` escalation is internal.
- **`Grep type` covers a small extension map** — unknown kinds error rather than widening.
- **MCP / Tower / select_tools / fork omitted** — upstream gated-off or no DSH equivalent.
- **`Agent` description vs behavior** — description is upstream foreground-first verbatim;
  DSH behavior is background-first (stock `subagent` semantics), documented by the
  `tool:Agent` section.
- **loop_control knobs** (`max_attempts_per_step`, etc.) have no DSH counterpart
  (`agentLoop` only exposes `maxParallelToolCalls`); alignment is documentation level only.
- **`WebSearch` / `FetchURL` prefer the Moonshot endpoints.** They POST to
  `https://api.kimi.com/coding/v1/search` and `/fetch` with the OAuth access token stored
  under `$KIMI_CODE_HOME/.kimi-code/credentials/kimi-code.json` (or `~/.kimi-code/...`;
  static `api_key` from `config.toml` is the fallback), carrying the 0.39.1 wire headers
  (`user-agent: kimi-code-cli/0.39.1`, `X-Msh-Platform: kimi_code_cli`,
  `X-Msh-Version: 0.39.1`, OS-derived `X-Msh-Device-*`). `ctx.web` / a local GET is only
  used when that credential is missing or the Moonshot call fails. Upstream registers
  `WebSearch` only when a search provider is configured; the DSH form registers it
  unconditionally because of the web-service fallback.

### Mesh gaps this surface used to inherit (now resolved upstream)

These lived in `dsh-kernel-mesh` and are **not** open work for this package:

- ~~**Mesh gap #5 — continuable subagent route.**~~ **RESOLVED** in the mesh; this
  package's `Agent`/`AgentSwarm` consume that route as their default (see above).
- ~~**Mesh gap #6 — non-streaming transports.**~~ **RESOLVED** in the mesh: both adapter
  factories stream real SSE (`stream: true`, curl `-N`) with JSON auto-fallback when a
  provider ignores streaming. This surface has no transport of its own.
- ~~**Unclassified adapter errors.**~~ **RESOLVED** in the mesh: adapters throw with
  canonical own-property codes (`e.code` + `e.failure`) so `dsh-llm-retry` retries
  `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`. This surface does not throw adapter
  errors.

## Differential test procedure

1. Prepare identical input directories for both channels.
2. Run the real Kimi Code CLI (ACP/yolo) on the task; record per-item outputs.
3. Run a `kimi-kernel` preset session (model `kimi-kernel/k3-256k`) on the *same* task
   with only this package's tool surface enabled.
4. Compare results item by item. A passing run shows identical counts/values (e.g. the
   CSS color tally: 17 = 11 `#hex` + 6 `rgba()`), with the difference only in the
   artifact filename (`analysis-kimi.txt` vs `analysis-dsh.txt`).
5. Optionally cross-check with an independent regex pass (`#[0-9a-fA-F]{3,8}` and
   `rgba?\(`) to confirm the numbers.

## Layout

```
dsh-kernel-kimi/
  lib/index.js             # the plugin (single-file ESM Cordis plugin)
  lib/upstream-surface.js  # GENERATED: verbatim 0.39.1 descriptions + schemas
  lib/system-prompt.js     # GENERATED: 0.39.1 main-agent system prompt, DSH form
  lib/subagents.js         # GENERATED: coder/explore/plan recipes, verbatim personas
  package.json             # type:module + exports/files/scripts.test (DSH plugin contract)
  LICENSE                  # MIT
  README.md                # short human-facing English doc
  README.zh.md             # Chinese translation
  README.i18n.yaml         # bilingual-pair git blob hashes
  AGENTS.md                # this file
  AGENTS.zh-CN.md          # Chinese translation of this file
```

Generators live in `.glm-test/kimi-code-distill/` (evidence: `capture/`, `repo/`,
`extracted/`); see that directory's `REPORT.md` for the full 0.39.1 distillation.

# Changelog

## 0.1.7

- **Publish channels.** Preferred install is `dsh plugin --profile web add dsh-kernel-kimi` (npm, once published); GitHub remains a fallback because `lib/` ships in the repository. The mesh dependency is `github:oppnc/dsh-kernel-mesh#semver:^0.1.7`. Keywords include `dsh-plugin`.

## 0.1.6

- **Mesh dependency + fallback mount.** `dsh-kernel-mesh` is now a declared
  dependency (`dsh-kernel-mesh@^0.1.6`, originally a GitHub specifier), so installing this
  package also installs the mesh. At `apply()` time the plugin checks for the
  mesh's `kernelMesh` marker service / any `*-kernel` route; when the host
  composition never mounted the mesh, the plugin mounts its own copy
  (`lib/ensure-mesh.js`) so kernel routes and subagent recipes keep working —
  with a logged pointer to the preferred profile-level mount
  (`dsh plugin add dsh-kernel-mesh`), since a fallback-mounted mesh shares this
  row's lifecycle.

## 0.1.5

- **Sync to Kimi Code CLI 0.39.1 (`@moonshot-ai/kimi-code@0.39.1`).** Every tool
  description and parameter schema is now VERBATIM upstream, generated from the
  live 0.39.1 wire capture into the new `lib/upstream-surface.js` — never
  retyped by hand. The only deviation is `ReadMediaFile`'s capabilities
  paragraph (adapted to the DSH image-only form).
- **Renames (old tool gone, new tool registered):** `ReadFile`→`Read`,
  `WriteFile`→`Write`, `StrReplaceFile`→`Edit` (single edit per call:
  `old_string`/`new_string`/`replace_all`), `Shell`→`Bash` (adds `cwd`,
  `disable_timeout`), `SearchWeb`→`WebSearch` (`query` only),
  `SetTodoList`→`TodoList` (`{title,status}` items; omitted `todos` queries,
  `[]` clears).
- **Parameter changes:** `Glob` `directory`→`path` plus `include_ignored`
  (VCS metadata `.git` always skipped); `Grep` adds `-i`, `-n`, `offset`,
  `multiline`, `include_ignored`, `type` (a small honest extension map; unknown
  kinds error) and defaults `head_limit` to 250 (`0` = unlimited);
  `TaskOutput` drops `block`/`timeout` (waiting is `WaitFor`'s job; the DSH
  jobs service has no log file, so no `output_path` is surfaced);
  `AskUserQuestion` questions no longer carry `id` and gain `background`
  (accepted; DSH `userQuestions` has no background ask, so questions are always
  foreground); `Agent` gains required `description`, `subagent_type` (default
  `coder`) and `resume`, drops the non-upstream `model`/`timeout` params.
- **New tools:** `WaitFor` (jobs.wait; without `task_id`, waits for ANY active
  task), `Skill` (DSH `skills` service: `skills.get` body + `ARGUMENTS:`
  appendix), `CreateGoal`/`GetGoal`/`SetGoalBudget`/`UpdateGoal` (DSH `goals`
  service; `SetGoalBudget` maps `unit: "turns"` onto the goal round cap —
  token/wall-clock budgets honestly report "not supported by the DSH goal
  runtime"), `AgentSwarm` (fan-out: one continuable background subagent per
  item with `{{item}}` substitution; `resume_agent_ids` fans one follow-up out
  to all). `CronCreate`/`CronList`/`CronDelete` are registered with the
  verbatim upstream surface but are HONEST STUBS — the DSH runtime has no
  cron/scheduler service (verified via the Service inspect provider), so they
  return a clear explanation. `Tower*`/`select_tools`/`fork` are upstream
  gated-off and NOT registered, matching upstream defaults.
- **`Agent` description is upstream-verbatim (foreground-first wording)** while
  the implementation keeps the DSH background-first behavior; the `tool:Agent`
  prompt section now documents that runtime truth instead of contradicting the
  description.
- **System prompt rewritten to 0.39.1** from the fully rendered live capture
  (`captured-system-full.txt`): behavior rules verbatim; runtime-computed
  metadata dropped (`# Environment` block, skill listing appendix,
  "Keep them informed" — upstream's own env-gated block); the stale
  "Kimi For Coding" model sentence fixed to the 0.39.1 catalog (default
  `k3-256k`); `todoList` referenced by its DSH name `TodoList`.
- **Subagent recipes (`lib/subagents.js`) regenerated from 0.39.1 source:**
  personas are the verbatim `TASK_AGENT_ROLE_PREFIX` + per-type overlay
  (explore overlay from `explore-overlay.md`); coder allow-list loses
  `Agent`/`AgentSwarm` per upstream PR #2837 (nesting depth 1) and gains
  `Cron*`/`Skill`/`WaitFor`; explore = `Bash`/`Read`/`ReadMediaFile`/`Glob`/
  `Grep`/`WebSearch`/`FetchURL`; plan drops `Bash`.
- **Search/fetch headers track the 0.39.1 wire:** `user-agent:
  kimi-code-cli/0.39.1`, `X-Msh-Platform: kimi_code_cli`,
  `X-Msh-Version: 0.39.1`, real OS-derived device headers.
- **`KIMI_CODE_HOME` override honored** when locating `~/.kimi-code`
  credentials, matching upstream.

## 0.1.4

- **`Agent` reuses the L2 recipes.** The inline subagent definitions are gone;
  `Agent` maps `coder`/`explore`/`plan` onto `lib/subagents.js` (upstream
  kimi-code `coder/explore/plan.yaml`).
- **`kimi-agent` toolFilter matches upstream.** Dropped `Agent` and
  `AskUserQuestion` (not in upstream `coder.yaml`).

## 0.1.3

- **Upstream system prompt.** `lib/system-prompt.js` carries the Kimi Code CLI
  `system.md` (runtime placeholders adapted to DSH); `apply()` registers it as the
  `deployment:persona` section with `complete: true` + `suppressRuntimeContext()`.
- **L2 subagent recipes.** `lib/subagents.js` ships `kimi-agent` (coder),
  `kimi-explore`, and `kimi-plan`, each = the full system prompt with the upstream
  `roleAdditional` block (from kimi-code `coder/explore/plan.yaml`) inserted at the
  `${ROLE_ADDITIONAL}` slot.
- **Subagent mounting config.** `apply(ctx, config)` accepts `config.persona`,
  `config.skipPersona`, and `config.tools`.

## 0.1.2

- Initial DSH-form kimi-cli tool surface.

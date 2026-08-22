English | [中文](README.zh.md)

# dsh-kernel-kimi

DSH runs on one simple idea: **everything is a plugin**. Models, tools, subagents — plug them together however you like.

So we did exactly that: we turned **Kimi Code into a DSH plugin**. The kimi-cli tool surface you already know — `ReadFile`, `WriteFile`, `StrReplaceFile`, `Glob`, `Grep`, `Shell`, `ReadMediaFile`, `SearchWeb`, `FetchURL`, `TaskList`, `TaskOutput`, `TaskStop`, `SetTodoList`, `AskUserQuestion`, `Agent`, `ExitPlanMode`, `EnterPlanMode` — is now a set of native DSH tools. Same names, same schemas, same behavior.

The payoff is simple: use the kimi CLI natively inside DSH — **no different** from opening Kimi Code itself. Every model stays in the environment it knows best — main agent or subagent, it feels like coming home.

`SearchWeb` / `FetchURL` talk to the same Moonshot endpoints the Kimi CLI uses (`api.kimi.com/coding/v1/search` and `/fetch`) with the shared OAuth token. Distilled from kimi-cli **1.49.0**.

> We differentially verified against the real kimi CLI: the same task on the same directory produces identical results, item by item.

## System prompt & subagents

`lib/system-prompt.js` carries the upstream **Kimi Code CLI** `system.md` (runtime
placeholders adapted to DSH); `apply()` registers it as the agent's sole
system-prompt section (`complete: true` + `suppressRuntimeContext()`).

`lib/subagents.js` ships the kernel's own subagent recipes — `kimi-agent`
(coder), `kimi-explore`, `kimi-plan` — each = the full system prompt with the
upstream `roleAdditional` block inserted. The mesh loads them and mounts this
plugin on each child with a `config.tools` whitelist.

## Install

1. Install the plugin into your profile with the official plugin command:

   ```sh
   dsh plugin --profile web add github:oppnc/dsh-kernel-kimi
   ```

   This package is a plain plugin (no `dsh.bundle` declaration), so `dsh plugin` installs it as an inactive dependency — that is expected: the preset row below references it by name.

2. Install the `kimi-kernel` agent preset: copy its directory into `~/.dsh/.agent-presets/kimi-kernel/`. The shipped preset already includes the `kimi-surface` row inside the **planning** group (so the plan tools can reach `planMode`); if you author your own preset, add it there:

   ```yaml
   - id: kimi-surface
     name: dsh-kernel-kimi
   ```

## Usage

Start a session on the `kimi-kernel` preset and pick the model `kimi-kernel/k3-256k`. Your main agent runs on the Kimi kernel with the full kimi tool surface.

## License

MIT — see [LICENSE](LICENSE).

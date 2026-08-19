# Changelog

## 1.0.4

- **`Agent` reuses the L2 recipes.** The inline subagent definitions are gone;
  `Agent` maps `coder`/`explore`/`plan` onto `lib/subagents.js` (upstream
  kimi-code `coder/explore/plan.yaml`).
- **`kimi-agent` toolFilter matches upstream.** Dropped `Agent` and
  `AskUserQuestion` (not in upstream `coder.yaml`).

## 1.0.3

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

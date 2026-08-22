[English](README.md) | 中文

# dsh-kernel-kimi

DSH 有个很朴素的想法：**一切都是插件**。模型是插件，工具是插件，子代理也是插件，想怎么拼就怎么拼。

顺着这个思路，我们把 **Kimi Code 写成了 DSH 插件**。你熟悉的 kimi-cli 工具面——`ReadFile`、`WriteFile`、`StrReplaceFile`、`Glob`、`Grep`、`Shell`、`ReadMediaFile`、`SearchWeb`、`FetchURL`、`TaskList`、`TaskOutput`、`TaskStop`、`SetTodoList`、`AskUserQuestion`、`Agent`、`ExitPlanMode`、`EnterPlanMode`——现在就是 DSH 的原生工具，名字一样、参数一样、行为一样。

好处很简单：在 DSH 里原生使用 kimi CLI，和直接打开 Kimi Code **没有任何区别**。每个模型都待在自己最熟悉的环境里，不管是主 agent 还是 subagent，感觉就像回家一样。

`SearchWeb` / `FetchURL` 走的是 Kimi CLI 同一套 Moonshot 接口（`api.kimi.com/coding/v1/search` 和 `/fetch`），共用 OAuth token。对齐 kimi-cli **1.49.0**。

> 我们用真实 kimi CLI 做过差分验收：同一个任务、同一个目录，两条通道跑出来的结果逐项一致。

## 系统提示词与子代理

`lib/system-prompt.js` 携带上游 **Kimi Code CLI** 的 `system.md`（运行时占位符
已适配 DSH）；`apply()` 把它注册为 agent 唯一的 system-prompt 段（`complete: true`
+ `suppressRuntimeContext()`）。

`lib/subagents.js` 提供该内核自己的子代理配方——`kimi-agent`（coder）、
`kimi-explore`、`kimi-plan`——每个都是完整 system prompt 插入上游
`roleAdditional` 段后的结果。mesh 会加载它们，并在每个子代理上以
`config.tools` 白名单挂载本插件。

## 安装

1. 用官方插件命令把本包装进你的 profile：

   ```sh
   dsh plugin --profile web add github:oppnc/dsh-kernel-kimi
   ```

   本包是普通插件（没有 `dsh.bundle` 声明），`dsh plugin` 会把它作为不激活的依赖安装——这是预期行为：下面的预设行会按名字引用它。

2. 安装 `kimi-kernel` agent 预设：把它的目录复制到 `~/.dsh/.agent-presets/kimi-kernel/`。随附的预设已经在 **planning** 分组里包含 `kimi-surface` 行（这样计划类工具能触达 `planMode`）；如果你自己写预设，就把它加进该分组：

   ```yaml
   - id: kimi-surface
     name: dsh-kernel-kimi
   ```

## 使用

在 `kimi-kernel` 预设上开启会话，选模型 `kimi-kernel/k3-256k`。主 agent 就跑在 Kimi 内核和完整的 kimi 工具面上。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。

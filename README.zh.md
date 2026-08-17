[English](README.md) | 中文

# dsh-kernel-kimi

DSH 有个很朴素的想法：**一切都是插件**。模型是插件，工具是插件，子代理也是插件，想怎么拼就怎么拼。

顺着这个思路，我们把 **Kimi Code 写成了 DSH 插件**。你熟悉的 kimi-cli 工具面——`ReadFile`、`WriteFile`、`StrReplaceFile`、`Glob`、`Grep`、`Shell`、`ReadMediaFile`、`SearchWeb`、`FetchURL`、`TaskList`、`TaskOutput`、`TaskStop`、`SetTodoList`、`AskUserQuestion`、`Agent`、`ExitPlanMode`、`EnterPlanMode`——现在就是 DSH 的原生工具，名字一样、参数一样、行为一样。

好处很简单：在 DSH 里原生使用 kimi CLI，和直接打开 Kimi Code **没有任何区别**。每个模型都待在自己最熟悉的环境里，不管是主 agent 还是 subagent，感觉就像回家一样。

`SearchWeb` / `FetchURL` 走的是 Kimi CLI 同一套 Moonshot 接口（`api.kimi.com/coding/v1/search` 和 `/fetch`），共用 OAuth token。对齐 kimi-cli **1.49.0**。

> 我们用真实 kimi CLI 做过差分验收：同一个任务、同一个目录，两条通道跑出来的结果逐项一致。

## 安装

把本包复制进你的 DSH profiles：

```bash
cp -r dsh-kernel-kimi ~/.dsh/profiles/node_modules/dsh-kernel-kimi
```

然后在 `kimi-kernel` agent 预设里加一行（放在 planning 分组内，这样计划类工具能触达 `planMode`）：

```yaml
- id: kimi-surface
  name: dsh-kernel-kimi
```

## 使用

在 `kimi-kernel` 预设上开启会话，选模型 `kimi-kernel/k3-256k`。主 agent 就跑在 Kimi 内核和完整的 kimi 工具面上。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。

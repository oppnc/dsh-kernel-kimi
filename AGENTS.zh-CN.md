# AGENTS.md — 维护者指南

`dsh-kernel-kimi` 的详细工程说明。本包是"写成 DSH 形式的 Kimi Code"：将 kimi-cli 工具面
以相同名称、相同 schema 重新注册为 DSH 工具，并实现在 DSH 服务之上，从而使该工具面在
`toolFilter` 裁剪下依然存活。

## 工具注册与 schema 出处

每个工具的名称与参数 schema 均来自 kimi-cli 源码（`kimi-cli/src/kimi_cli/tools/` 下的
Pydantic `Params` 类）。下表为工具 → 出处文件的映射。

| 工具 | kimi-cli 出处 |
| --- | --- |
| `ReadFile` | `read.py` |
| `WriteFile` | `write.py` |
| `StrReplaceFile` | `replace.py` |
| `Glob` | `glob.py` |
| `Grep` | `grep_local.py` |
| `Shell` | `shell/__init__.py` |
| `ReadMediaFile` | `read_media.py` |
| `SearchWeb` | web 工具定义 |
| `FetchURL` | web 工具定义 |
| `TaskList` | task/background 工具定义 |
| `TaskOutput` | task/background 工具定义 |
| `TaskStop` | task/background 工具定义 |
| `SetTodoList` | `todo/__init__.py` |
| `AskUserQuestion` | `ask_user/__init__.py` |
| `Agent` | `tools/agent` |
| `ExitPlanMode` | plan-mode 工具定义 |
| `EnterPlanMode` | plan-mode 工具定义 |

## 服务级实现决策

所有工具都通过 `ctx.get(...)`（可选）读取依赖，因此缺失的服务会退化为清晰的错误字符串，
而不是让插件崩溃。

- **fs —— 直接使用。** `ReadFile`/`WriteFile`/`StrReplaceFile`/`Glob`/`Grep` 直接调用 DSH
  的 `fs` 服务。对*会写文件*的 `WriteFile` 与 `StrReplaceFile`，把 `sandboxPolicy.resolve()`
  作为第 5 个参数传给 `fs.writeText`/`fs.editText`——这是一次真实 bug 修复：不传时沙箱会
  误拒合法写入。工作目录回退使用 `sandboxPolicy.workspaceRoot`。
- **subprocess —— `resolveExecutable` + 回退。** `Shell` 先尝试
  `subprocess.resolveExecutable('pwsh.exe')`，失败则回退到 Windows PowerShell 绝对路径
  `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`。这修复了在净化 `PATH` 下出现
  的 `ENOENT`。输出有上限（`stdout` 1 MB、`stderr` 100 KB），并附带 exit-code 标记。
- **自研 glob 匹配器。** `globToRegex` 实现了 `*`、`**`、`?` 与 `{a,b}` 花括号展开（含正则
  元字符转义），因为 `fs` 服务没有暴露 glob 原语。`Glob` 与 `Grep` 的 `glob` 过滤器共用它，
  且都跳过 `SKIP_DIRS`（`node_modules`、`.git`、`.dsh`、`.venv`、`__pycache__`、`dist`）。
- **jobs 服务做后台任务。** `Shell` 的 `run_in_background=true` 通过 `subprocess.spawn` 派发，
  并用 `jobs.start` 封装，暴露 `cancel`/`done`/`readOutput`。`TaskList`/`TaskOutput`/
  `TaskStop` 委托给 `jobs.list`/`jobs.read`/`jobs.wait`/`jobs.kill`，并按 `exec.agent` 限定
  作用域。
- **attachments 实现 `ReadMediaFile`。** 图片字节经 `fs.readBytes`（20 MB 上限）读取，再经
  `attachments.saveImage` 附加；`output.render` 函数由返回的 attachment 引用发出 `image`
  块，使模型真正"看见"图片。视频不受支持。
- **userQuestions 实现 `AskUserQuestion`。** 该工具把 questions 数组转发给
  `userQuestions.ask`，并对答案做 JSON 序列化。注意 DSH 的选项结构用的是驼峰（`multiSelect`），
  是从 kimi 的蛇形 `multi_select` 映射而来。
- **插件内 todo 存储。** `SetTodoList` 维护一个以 `exec.agent.id` 为键的 `Map`；DSH 没有
  todos 服务，因此用插件内存储达成对等。
- **`Agent` 对齐原生 `subagent` 工具。** 后台为默认（`run_in_background !== false` →
  `subagents.startContinuable`），在收件箱受理时返回持久子代理 id。`resume` 通过
  `subagents.followup` 投递 `prompt`（与 `send_message` 同一通道）。前台
  （`run_in_background: false`）等待 `subagents.start`，并在非 `completed` 停止时追加
  `"Partial output before the run ended:"` 与子代理已产出的文本——与原生措辞一致。每个
  请求都显式设置 `agentOptions` / `persona` / `toolFilter` / `maxDepth: 3`，因为可续接
  路由从不调用 `provider.start()`。工具声明 `isConcurrencySafe: () => true`，并注册
  `systemPrompt` 段落（`tool:Agent`，order `116.5`），在工具可见时教导后台优先约定。

## DSH `ToolDefinition` 合约

- `output.schema` 是*受强制约束的子集*：与 kimi-cli 不同，DSH 必须知道返回结构。多数工具
  使用 `strDef`，它设置 `output.schema = { type: 'string' }` 并附带文本 `render`。返回对象的
  工具要显式声明 `properties` 与 `additionalProperties`（见 `ReadMediaFile`，其 schema 设
  `additionalProperties: true` 以容纳 `attachment` 字段）。切勿让 `additionalProperties` 处于
  隐式状态。
- `render` 为必需项，接收 `(args, value)`，返回块数组（`text` 或 `image`）。

## 为何使用 PascalCase 命名

名称刻意采用 `PascalCase`（如 `ReadFile` 而非 `read_file`），一是为了精确复刻 kimi-cli，
二是为了**避开 DSH 自动的 `snake_case` 工具名冲突**。注册真正的工具面名称，正是本次同化
的全部意义所在。

## 已知缺口

- **不支持视频** —— `ReadMediaFile` 仅处理图片（PNG/JPEG/WebP/GIF）。
- ~~**`Agent` 的 resume / run_in_background。**~~ **已解决**（mesh 缺口 #5）。`Agent` 现在
  以后台优先走原生可续接路由（`subagents.startContinuable`）：省略 `run_in_background`
  （或设为 true）即返回持久子代理 id，`list_agents` / `send_message` / `interrupt_agent` /
  `Agent.resume` 均可操作，与原生 `subagent` 工具一致。仅在下一步必须等待一次性结果时
  才设 `run_in_background: false`。见上文 `Agent` 实现说明。
- **MCP / think 工具被省略** —— MCP 面与 kimi 的 "think" 工具在 DSH 无等价物，故未注册。
- **loop_control 旋钮**（`max_attempts_per_step` 等）在 DSH 无对应物（`agentLoop` 只暴露
  `maxParallelToolCalls`）；对齐仅停留在文档层面。
- **`SearchWeb` / `FetchURL` 优先走 kimi-cli 的 Moonshot 端点。** 它们用 Kimi CLI 存在
  `~/.kimi-code/credentials/kimi-code.json` 里的同一份 OAuth access token（静态
  `api_key` 是回退）POST 到 `https://api.kimi.com/coding/v1/search` 和 `/fetch`。只有
  凭据缺失或 Moonshot 调用失败时才用 `ctx.web` / 本地 GET。这是 1.49 的工具面：
  DeepSeek 的 `web_search` provider **不是** kimi-cli 路径。

### 本工具面曾经继承、现已在上游解决的 mesh 缺口

这些记录在 `dsh-kernel-mesh`，**不是**本包的待办：

- ~~**Mesh 缺口 #5 —— 可续接子代理路由。**~~ **已在 mesh 解决**；本包的 `Agent` 把它作为
  默认路由使用（见上）。
- ~~**Mesh 缺口 #6 —— 非流式传输。**~~ **已在 mesh 解决**：两条 adapter 工厂现在真正流式
  传输 SSE（`stream: true`、curl `-N`），并在提供方忽略流式时自动回退到 JSON。本工具面
  自身没有传输层。
- ~~**未分类的 adapter 错误。**~~ **已在 mesh 解决**：adapter 以规范的自有属性码
  （`e.code` + `e.failure`）抛出，因此 `dsh-llm-retry` 会重试 `RATE_LIMIT` / `SERVER` /
  `TIMEOUT` / `TRANSPORT`。本工具面不抛出 adapter 错误。

## 差分验收流程

1. 为两条通道准备完全相同的输入目录。
2. 用真 kimi CLI（ACP/yolo）跑任务，逐项记录输出。
3. 用 `kimi-kernel` 预设会话（模型 `kimi-kernel/k3-256k`）在*相同*任务上、仅启用本包工具面
   地再跑一遍。
4. 逐项比对结果。通过即表示计数/数值完全一致（例如 CSS 颜色统计：17 = 11 个 `#hex` +
   6 个 `rgba()`），差别仅在产物文件名（`analysis-kimi.txt` vs `analysis-dsh.txt`）。
5. 可选地用独立正则复核（`#[0-9a-fA-F]{3,8}` 与 `rgba?\(`）来确认数字。

## 目录结构

```
dsh-kernel-kimi/
  lib/index.js      # 整个插件（单文件 ESM Cordis 插件）
  package.json      # type:module + exports/files/scripts.test（DSH 插件契约）
  LICENSE           # MIT
  README.md         # 面向用户的简短英文文档
  README.zh.md      # 中文翻译
  README.i18n.yaml  # 双语配对的 git blob hash
  AGENTS.md         # 本文件
  AGENTS.zh-CN.md   # 本文件的中文翻译
```


# 第 17 步 · 模式系统与多智能体

> **产出文件**：`framework/modes.ts`、`modes/*.json`、`prompts/*.md`、`apps/shared-mode.ts`、`plugins/prompt.ts`、`plugins/multi-agent.ts`、`kernel/{command,program,authoring}-tools.ts`、`kernel/ptc-runtime.ts`
> **DSH 对应**：`packages/preset/`（agent preset）、`packages/ptc-runtime/`、`packages/subagent/`
> **目标级别**：L3（能自己写一份模式声明并接上）
> **验收判据**：五个模式可选可切；模式真的改变装配（`--dump` 可见）；多智能体派发后子 agent 各有独立会话

---

## L0 要解决的问题

第 16 步结束时，harness 能跑、能学、能自改。但**"这个 agent 是什么"是写死的**：

```
profiles/agent.json  → 固定的一组插件
bundles/core.json    → 固定的工具列表
```

想让它变成"只用一个终端工具的版本"或者"能写程序批量调工具"的版本，就得**另建一份 profile**。
而 profile 管的是"装哪些插件"，工具集那些还得再进 bundle 改 —— 于是"我想换个形态试试"
变成了一次跨文件的编辑。

DSH 对这件事的答案很明确（`.agents/notes/implemented/architecture/2026-09-18-declarative-agent-presets.md`）：

> Host 共享 agent loop；每个 Agent 只看到**它选中的那套**工具、提示词与技能。

它有四个 preset：Standard（常规）、PTC、Minimal（最小）、Creator（创造）。
**这四套的差别不是代码，是装配。**

这一步把这件事搬进来，并补一个本项目自己需要的第五个模式：**多智能体**。

## L1 设计与原理

### 1.1 模式 = 一份声明

```json
{
  "id": "ptc",
  "name": "PTC 模式",
  "description": "含常规模式全部能力，另加 run_program…",
  "prompt": "ptc.md",
  "tools": ["read_file", "write_file", "list_dir", "run_program"],
  "disable": ["multi-agent"],
  "llm": { "temperature": 0 },
  "guard": { "rules": ["loop", "irreversible", "quota", "path"], "maxCalls": 12, "approve": [] },
  "limits": { "maxSteps": 10 }
}
```

选这个形状（JSON 文件）而不是"在代码里 `if (mode === 'ptc')`"，理由有三条，每条都能验证：

| 理由 | 怎么验证 |
|---|---|
| 声明可以**被人改** | 写个 `modes/*.json` 就能试，不用读代码 |
| 声明可以**被分享** | 把文件发给人，对方 `--mode` 就能用同一套 |
| 声明可以**被装配出来** | Web GUI 的装配面板就是"写这个文件"的图形前端 |

### 1.2 ★ 为什么不复用 patch，而是新增一个钩子 ★

第 6 步定下的 `patch` 语义是**整段替换 config**（这条被文档化过，也被 `bad-id` 之类的示例依赖）。
而模式只想改几个字段：

```
tools 行的 config = { workspace, builtin }      ← 模式只想改 builtin
agent-loop 的 config = { maxSteps, checkpoints } ← 模式只想改 maxSteps
```

两条路都试过：

| 方案 | 后果 |
|---|---|
| 让模式生成 patch | 必须写出**完整** config → 5 个模式要复制 5 份 `workspace`、`savePath`，改一处忘一处是必然的 |
| 把 patch 改成深合并 | 破坏"整段替换"这条规则 —— 而它存在是有原因的：深合并**无法删除字段**，且"这个值从哪继承来的"会变得不可追踪 |
| **新增 `transformRows` 钩子**（最终选择） | "拿到合并结果 → 加工 → 装载"：模式只改它关心的字段，patch 语义不变 |

代价是这一步发生在 patch 层叠**之后**，所以它不参与 patch 的计算 —— 但它发生在最后，
于是 `dump()` 看到的仍是最终结果（`--dump` 里能看到模式改动后的 `builtin`）。

### 1.3 系统提示词必须进日志

模式要能带自己的提示词（PTC 得教模型什么时候写程序、Minimal 要提醒它只有一个 shell）。
但 agent 在此之前**没有系统提示词** —— 消息从 `user/message` 开始。

加它的时候有一个必须做对的地方：**提示词不能是内存里的隐状态**。

第 7 步的核心不变量是「Model-visible ⟺ logged」——凡是模型能看到的，必须能从日志重建。
提示词是最显眼的那部分，如果它藏在插件的内存里，"模型当时看到什么"就有一块永远答不上来。

所以：

```ts
// kernel/session.ts
setSystemPrompt(text: string, mode?: string): void {
  if (systemPromptOf(this.#events) === text) return   // 没变就不写，免得每轮塞一条
  this.append('session/system-prompt', { text, mode })
}
```

`deriveMessages()` 读日志里**最后一条** —— 于是"什么时候换了提示词、换成什么"是查得到的事实，
而"每轮重复写一条相同的"被那个相等判断挡住了。

### 1.4 多智能体：隔离全部来自既有机制

```
主 agent ──spawn_agent──► 子 agent #1（独立会话 · 独立工具集 · 独立步数预算）
        ◄──── 只有结论回到主上下文 ────
```

| 隔离项 | 靠什么 | 来自第几步 |
|---|---|---|
| 独立会话 | `session/factory` | 7 |
| 独立工具集 | `subsetTools()`（`framework/scope.ts`） | 2、5 |
| 独立循环与预算 | `new Agent({ maxSteps })` | 8 |

**加这个能力没有改 `kernel/agent.ts` 一行代码。** 这是第 1–16 步那些"能力做成服务、
行为挂扩展点"的取舍在这里的兑现 —— 如果当初把子 agent 做成循环里的一个 `if (isSubagent)`，
这里就必须动核心。

接口上刻意给了 `tasks: string[]`（一次派多个，内部并发）：因为 `kernel/agent.ts` 的工具调用
是**串行**的，如果一次只能派一个，"并行推进三件事"就退化成串行 —— 而那正是派发的主要收益。

### 1.5 PTC：为什么值得单开一个模式

同一件任务（读 20 个文件统计词频）在两种模式下差别不在"能不能做"，而在**上下文里留下了什么**：

```
常规模式：  20 份文件全文进上下文 → 模型读完自己统计   （上下文被中间结果吃满）
PTC 模式：  模型写一段程序 → 程序在**新进程**里读完 20 个文件 → 只有一行统计回到对话
```

演示里的实测：程序内部调了 4 次工具，**上下文里只有 1 条 `tool/result`**。

实现上它与 DSH 对齐了三条语义：**每次运行都是全新进程**、**只返回打印输出与返回值**、
**失败是结果而不是异常**（程序崩了返回 `ok: false`，让模型自己看到并改）。

协议走**带前缀的 stderr**（`@@PTC@@{json}`），因为 stdout 要留给程序自己的输出 ——
两者混在一条管道里时，模型打印一行恰好长得像协议消息就会出错（很难查）。

## L2 决策表

| # | 决策 | 我们的选择 | 替代方案 | 代价落在谁身上 |
|---|---|---|---|---|
| 1 | 模式的形态 | JSON 文件（`modes/*.json`） | 代码里的分支 / 数据库 | **维护者**：多一套 schema 要校验 |
| 2 | 怎么合进装配 | 新增 `transformRows` 钩子 | 生成完整 patch / patch 改深合并 | **流程**：多一步加工；换来 patch 语义不变 |
| 3 | 提示词归属 | 独立 `prompt` 插件 + 一行配置 | 塞进 agent-loop 的 config | **模式作者**：多认一个插件 id；换来模式不必知道 agent-loop 的字段名 |
| 4 | 提示词的可见性 | 写进日志（`session/system-prompt`） | 只放内存 | **存储**：日志多一条；换来"模型看到什么"可重建 |
| 5 | 自定义模式落点 | 写成文件（与内置同格式） | 存在浏览器/数据库 | **便利性**：要写盘；换来可分享、可版本化、可 `--mode` 用 |
| 6 | 多智能体的工具形态 | `tasks: string[]`（批量并发） | 一次一个 | **诊断**：一批里某个失败要单独看；换来并行 |
| 7 | 子 agent 的隔离 | 复用 session/scope/loop | 新写一套子循环 | **无**（这就是当初分层的目的） |
| 8 | `spawn_agent` 的来源 | 由 multi-agent 插件注册 | 写进 tools 的 builtin 白名单 | **一致性**：工具清单有两个来源；换来"插件装了才有这个工具"的语义正确 |
| 9 | PTC 的执行位置 | 新进程（`node bootstrap.mjs`） | 同进程 `node:vm` | **复杂度**：要写父子协议；换来"每次运行干净"与 DSH 语义一致 |
| 10 | PTC 的协议通道 | 带前缀的 stderr | stdout 分帧 / 额外 fd | **可读性**：stderr 里混着报错；换来程序输出原样保留 |
| 11 | `run_command` 的退出码 | 非零即 `isError`，但输出照给 | 非零只报错 | **判定**：模型要多看一行；换来它能拿到编译错误去修 |

## L3 实现与验证

### 3.1 文件清单

| 文件 | 职责 |
|---|---|
| `framework/modes.ts` | 声明解析与校验、`applyMode`、摘要 |
| `modes/*.json`、`prompts/*.md` | 五个模式与它们的提示词 |
| `apps/shared-mode.ts` | 三个界面共用的模式解析 + 自定义模式落盘 |
| `plugins/prompt.ts` | 提示词服务 |
| `plugins/multi-agent.ts` | 子智能体服务 + `spawn_agent` 工具 |
| `kernel/ptc-runtime.ts` + `ptc-bootstrap.mjs` | PTC 运行时（父进程 + 子进程 SDK） |
| `kernel/{command,program,authoring}-tools.ts` | `run_command` / `run_program` / `write_skill`·`write_plugin`·`list_authoring` |
| `src/demos/demo-modes.ts` | 五个模式各跑一次的演示 |

### 3.2 关键代码

**装载时的加工**（`framework/loader.ts` 新增的钩子）：

```ts
const composed = composeRows(bundles, layers)
const rows = options.transformRows === undefined ? composed : [...options.transformRows(composed)]
```

**模式只改它关心的字段**（`framework/modes.ts`）：

```ts
if (shouldDisable) { if (row.disabled !== true) keys.push('disabled') }
else if (row.id === 'tools') { config['builtin'] = decl.tools }
else if (row.id === 'prompt') { config['text'] = promptText; config['mode'] = decl.id }
```

**子智能体的三样隔离**（`plugins/multi-agent.ts`）：

```ts
const childSession = factory.create(id)                       // 独立日志
const childTools = request.tools === undefined ? parentTools : subsetTools(parentTools, request.tools)
const agent = new Agent({ provider, tools: childTools, session: childSession, workspace, maxSteps })
```

### 3.3 运行验证

```powershell
node src/apps/cli.ts --list-modes
```

```
  creator        内置   创造模式
                        工具：read_file, list_dir, write_skill, write_plugin, list_authoring, run_command
  minimal        内置   最小模式
                        工具：run_command
  multi-agent    内置   多智能体模式
                        工具：read_file, write_file, list_dir
  ptc            内置   PTC 模式
                        工具：read_file, write_file, list_dir, run_program
  standard       内置   常规模式
                        工具：read_file, write_file, list_dir, delete_file
```

```powershell
node src/apps/cli.ts --profile profiles/chat.json --mode minimal --dump "x"
```

```
======== 模式 ========
  minimal　最小模式
[prompt] 已装载：模式=minimal，743 字符
                     config: {"workspace":"workspace","builtin":["run_command"]}
  multi-agent        ../src/plugins/multi-agent.ts  [已禁用]
  （模式 minimal 改动了：llm[llm.temperature], tools[builtin], guard[guard.rules+guard.maxCalls+guard.approve], prompt[text+mode], agent-loop[maxSteps]）
```

★ `tools` 的 `builtin` 变成了 `["run_command"]`、`multi-agent` 行被禁用、提示词换成 minimal.md ——
**模式真的改变了装配**，而不只是"加载了一个配置项"。

五个模式的实际行为（`node src/demos/demo-modes.ts` 节选）：

```
======== 演示 2：PTC 模式写程序批量干活 ========
--- 进上下文的工具结果 ---
  "✓ （PTC 程序执行完成：调用工具 4 次，耗时 75 ms）"
★ 程序内部调了 4 次工具，但上下文里只有 1 条 tool/result

======== 演示 3：最小模式只有一个终端工具 ========
--- run_command 的输出 ---
$ node --version
v24.12.0

======== 演示 4：多智能体模式派发子智能体 ========
  状态：complete（2 步，会话 sub-1-mufkgro6）
  结论：（离线规则模式）工作目录里有 6 个条目
  状态：complete（2 步，会话 sub-2-mufkgro6）

======== 演示 5：创造模式的写权限分级 ========
已覆盖技能 skills/demo-generated-skill.md（177 字节）
--- 写源码被守卫拦下 ---
{ "裁决": "ask", "规则": "irreversible" }
```

### 3.4 验收判据

| 判据 | 怎么验 | 期望 |
|---|---|---|
| 五个模式都在 | `--list-modes` | 五个 id 全部出现 |
| 模式改变装配 | `--mode minimal --dump` | `"builtin":["run_command"]`，且 `multi-agent` 显示"[已禁用]" |
| 提示词进了日志 | 任一会话的 `events` | 有 `session/system-prompt`，且 `deriveMessages()` 首条是 `role: 'system'` |
| PTC 真的省上下文 | `demo-modes.ts` 演示 2 | 4 次工具调用只产生 1 条 `tool/result` |
| 子 agent 有独立会话 | 演示 4 | 每个子智能体带不同 `sessionId` |
| 隔离是真的 | 装 emoji 观察工具表 | 子 agent 只看得到 `tools` 参数里给的 |
| 权限分级 | 演示 5 | `write_skill` 成功、`write_plugin` 被 `irreversible` 拦下 |
| 自定义装配可落盘 | Web GUI 装配面板保存 | 生成 `modes/custom-*.json`，立即生效 |
| 一键验收 | `node src/apps/verify.ts` | 23/23 通过 |

## L4 仍未解决

| 缺陷 | 后果 | 修法 | 当初为什么这么选 |
|---|---|---|---|
| **切换模式要重新装载** | 切换有成本（重建会话、丢上下文） | 做 revision 保留（DSH 的做法：Agent 持有旧 revision，直到它被释放） | 那需要 Loader 树的引用计数，是另一个量级的工程 |
| **`skills` 字段没被消费** | 模式声明里写了技能子集也不生效 | 在 `evolution/skills.ts` 之上加一层"可见技能子集" | 技能库当前只按触发词匹配，没有"按模式可见"的概念 |
| **PTC 与 minimal 没有沙箱** | `run_program` / `run_command` 以当前用户权限运行 | 接 OS 级隔离（bwrap / Landlock / 容器） | 那是系统编程，不是架构；本项目只做限流（次数/时限/输出） |
| **子 agent 不继承守卫** | 父 agent 的守卫策略不会传到子 agent | 把守卫工厂往下传一层 | 刻意简化：子 agent 有自己的工具集，策略该由调用方决定 |
| **子 agent 之间不能通信** | 只能"派下去、收回来"，无法互相协商 | 加一个共享的消息通道 | 那会引入并发与顺序问题，本轮只需要主从 |
| **PTC 输出上限是硬截断** | 打太多会被切掉，模型可能看不到结尾 | 溢出部分落盘并告诉模型路径（第 2 步的 spill 思路） | 先做最简单的保护 |
| **模式之间不能继承** | 五个模式里有大量重复字段（guard、llm） | 加 `extends` 字段做深合并 | 深合并的语义坑多（这正是 1.2 拒绝它的原因），等真有第六七个模式再说 |
| **装配面板不校验工具组合** | 可以勾出"只有 write_file 没有 read_file"这种怪组合 | 加几条组合规则（写前必读之类） | 那是策略，不是装配的职责；`guard` 更适合管这个 |

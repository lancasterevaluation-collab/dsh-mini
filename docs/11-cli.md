# 第 11 步 · CLI 端到端

> **产出文件**：`src/apps/cli.ts`（约 200 行）、`src/apps/verify.ts`（约 160 行）
> **DSH 对应**：`apps/cli/src/` + `packages/boot/app-boot/`（🔶 大幅简化：JSON 而非 YAML，无 pnpm 解析）
> **目标级别**：L3（关掉本文，能自己写出一个"装载 → 跑任务 → 报告"的入口）
> **验收判据**：`node src/apps/cli.ts "任务"` 能跑通一个完整任务，并且 `--dump` 能打印最终生效的配置

---

## L0 要解决的问题

到第 10 步为止，我们的 harness **能力齐了，但没有入口**。想跑一次任务，你得写一个演示文件：

```ts
const session = new Session('demo')
const agent = new Agent({
  provider: new MockProvider([...]),
  tools: registry,
  session,
  workspace: '.',
  retryPolicy: { mode: 'normal', maxRetries: 3 },
  guards: guards1,
  approver: allowListApprover([]),
})
await agent.run('任务')
```

这段代码有四个问题，每一个都会在真实使用里咬人：

| 现象 | 根因 |
|---|---|
| 换一个 provider 要改代码 | 装配写在**调用点**，而不是配置里 |
| "我改了配置怎么没生效" | 没有 dump —— 生效值只存在于内存里 |
| `cli.ts ... && echo ok` 说谎 | 失败与取消都返回退出码 0 |
| 同一个任务跑两次结果不一致 | 装配顺序依赖"我记得按什么顺序 new" |

这一步把入口收成一条命令，并让**装配完全来自配置**。

## L1 设计与原理

### 1.1 应用层的位置：它是唯一被允许"知道全部"的地方

```
apps/        选 profile → 装载 → 跑任务 → 报告      ← 这一步在这里
profiles/    配置即组合（JSON）
plugins/     能力，每个只认识自己的依赖
framework/   容器、事件、作用域、装载器
kernel/      纯能力，不认识上面任何人
```

这条分层规则给 CLI 划了一条**上限**：它不能写业务逻辑。

判断标准很简单 —— **如果 CLI 里出现了 `if`，而那个 `if` 判断的是业务状态（工具类型、错误码、消息角色），说明有插件没写完。**

CLI 只做四件事：解析参数、装载、报告、收尾。

### 1.2 三个必须做对的细节

**① dump 排在执行之前**

「改了配置但没生效」是配置系统最经典的故障。第 6 步的 `loadProfile` 已经提供了 `dump()`，CLI 要做的是**在跑任务之前就调用它** —— 因为一旦任务开始，输出会被日志淹没，而人只会看最后 30 行。

**② 退出码要真实**

```ts
return result.status === 'complete' ? 0 : 2
```

三种结局对应三个含义：`complete` = 成功、`cancelled`/`max-steps` = 没成功但也不是崩、抛错 = 失败。
把它们混成都返回 0，会让所有自动化脚本（CI、批处理、`&&` 链）**集体说谎**。

**③ 卸载要真的发生**

`finally { loaded.unloadAll() }` 看着像形式主义 —— 进程都要退出了，还卸载什么？

它的价值是**验证**：只有真的跑过卸载，插件的 disposer 才会被执行到。`plugins/session.ts` 的落盘、`plugins/evolution.ts` 的 sqlite 句柄释放都挂在那里。如果从来不跑，那行代码就是"看起来对但从未验证过"的代码。

### 1.3 一个刻意的取舍：不做交互式

CLI 是**单次任务**的，没有 REPL、没有交互式审批。

原因是审批路径已经由第 10 步的 `Approver` 抽象掉了：交互式 CLI 需要的是"读一行 stdin"的 approver，而不是一个循环。把审批做成服务，就能让同一个 CLI 既跑在终端（问人）又跑在 CI（白名单），而 CLI 自己不需要知道区别。

这是"能力做成服务"的直接红利。

## L2 决策表

| # | 决策 | 我们的选择 | 替代方案 | 代价落在谁身上 |
|---|---|---|---|---|
| 1 | 入口形态 | 单次任务命令 | 交互式 REPL | 使用者要重复输入开关；换来的是可脚本化、可 CI |
| 2 | 配置来源 | profile 文件（可叠加 `--patch`） | 命令行逐项开关 | 加一个开关要改 CLI 代码；换来的是"组合"能版本化、可 diff |
| 3 | 任务传参 | 位置参数（所有非开关的词拼起来） | `--task "..."` | 任务里不能以 `--` 开头；换来的是最自然的用法 |
| 4 | 输出粒度 | 事件流摘要（只挑 6 类事件） | 打印全部事件 / 只打印结果 | 摘要可能漏掉你要的那条；换来的是 600 条日志不刷屏 |
| 5 | 退出码 | 0 / 1（装载或崩）/ 2（任务未成功） | 全部 0 | 脚本作者要区分两种非零；换来的是自动化可信 |
| 6 | 默认 profile | `profiles/agent.json`（离线 mock） | 强制显式指定 | 新手少一个必填参数；代价是"我明明配了 deepseek 怎么还是 mock" —— 由 dump 兜住 |
| 7 | 中断处理 | `SIGINT` → `AbortController.abort()` | 直接 `process.exit` | 需要多写三行；换来的是 turn 被正常闭合、日志可续 |

**关于第 7 条的展开**：直接退出会让日志停在一个**未闭合的 turn** 上（有 `turn/start` 没有 `turn/end`）。第 7 步的不变量是"日志任何时候都是完整状态" —— 取消路径破坏它，就等于把"可恢复"这个能力丢掉了。

## L3 实现与验证

### 3.1 文件清单

| 文件 | 职责 | 关键点 |
|---|---|---|
| `src/apps/cli.ts` | 唯一入口 | 参数解析 / 装载 / dump / 跑任务 / 报告 / 退出码 |
| `src/apps/verify.ts` | 一键验收 | 子进程跑 16 个演示 + 2 个端到端检查 |

### 3.2 关键代码

**参数解析：默认值必须相对文件定位，而不是相对 cwd**

```ts
const HERE = import.meta.dirname
let profile = resolve(HERE, '../../profiles/agent.json')
```

如果把默认 profile 写成 `'profiles/agent.json'`，那么从别的目录执行 `node D:/agent-harness-lab/src/apps/cli.ts ...` 就会找不到配置。**默认值要相对"程序"而不是相对"调用者的位置"**。

**装载与 dump**

```ts
loaded = await loadProfile(args.profile, args.patches)
console.log('\n======== 生效的配置 ========')
loaded.dump()
if (args.dumpOnly) return 0
```

注意 `--dump` 提前返回：它不跑任务、不产生副作用，是一个**只读探针**。

**事件流摘要**

```ts
const keep = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result', 'tool/guard', 'assistant/attempt'])
```

这六类事件正好覆盖"人想看的因果链"：用户说了什么 → 模型决定做什么 → 工具结果 → 被守卫拦了 → 重试了。
其余的（`turn/start`、`step/end`…）是记账事件，看它们只会让输出变长。

### 3.3 运行验证

```powershell
node src/apps/cli.ts --profile profiles/evolution.json "读一下 README 并总结"
```

真实输出（节选）：

```
[llm] 已装载：mock（model=mock-offline）
[tools] 已装载：workspace=D:\agent-harness-lab\tmp\cli-workspace；工具=read_file, list_dir, write_file, delete_file
[session] 已装载：id=cli；落盘=...\.sessions\cli.jsonl
[retry] 已装载：mode=normal maxRetries=3 budget=6
[guard] 已装载：规则=loop, irreversible, quota, path；自动批准=(无，一律问人)
[agent-loop] 已装载：maxSteps=8；...；retry=已装；guard=已装；checkpoints=...
[evolution] 已装载：memory=8 nudge=... skills=2（来自 skills）

======== 生效的配置 ========
profile：evolution（D:\agent-harness-lab\profiles\evolution.json）
bundle：../bundles/core.json → ../bundles/evolution.json
生效的行：
  llm                ../src/plugins/llm.ts
  ...
  evolution          ../src/plugins/evolution.ts

======== 事件流 ========
  #1 用户：读一下 README 并总结
  #3 模型：(无文本) → 要调用 1 个工具
  #4   调用 list_dir
  #5   结果 ✓ README.md
  #9   调用 read_file
  #13 模型：读完 README 了：这是一个演示工作目录。

======== 结果 ========
  状态        complete
  步数        2
  工具调用    3（失败 0）
  守卫        deny=0 ask=0
  消息数      6（这就是模型看到的全部）
```

### 3.4 验收判据

| 判据 | 怎么验 | 期望 |
|---|---|---|
| 端到端跑通 | `node src/apps/cli.ts "任务"` | 退出码 0，打印完整事件流与统计 |
| 配置可 dump | `--dump` | 打印生效的行与各自的 config |
| 配置可覆盖 | `--patch patches/cli-override.json` | 被覆盖的行显示新值 |
| 退出码真实 | 让任务失败（用 mock 脚本耗尽） | 退出码 ≠ 0 |
| 一键验收 | `node src/apps/verify.ts` | 18/18 通过 |

## L4 仍未解决

| 缺陷 | 后果 | 修法 | 当初为什么这么选 |
|---|---|---|---|
| **没有流式输出** | 长任务里用户看不到任何进展，只能等 | provider 加 `chatStream`，CLI 边收边打印 | 第 1 步的 `Provider` 是单次返回；流式要改接口与所有实现，属于第 1 步的范围扩大 |
| **单会话** | 一个进程只能跑一条会话，多 agent 场景要自己造 factory | 用 `session/factory` 服务，CLI 加 `--concurrent` | 课程目标是"跑通"，并发会引入会话隔离与日志交错两个新问题 |
| **没有交互式审批** | `ask` 裁决只能靠 `approve` 白名单，人无法临时批准 | 写一个读 stdin 的 `Approver`（约 30 行） | 见 L1 的 1.3：审批是服务，CLI 不该知道它的形态 |
| **参数解析是手写的** | 不支持 `--a=b` 形式、不支持 `--help` | 换成解析库（但零依赖约束下要自己写） | 手写 40 行能覆盖全部实际用法，引入依赖的收益为负 |
| **`verify.ts` 靠字符串匹配判断通过** | 演示文案一改，验收就误报 | 让每个演示导出一个结构化的检查结果 | 演示的输出是给人看的，改成结构化会牺牲可读性 |

**其中第 5 条是我写 verify 时踩到的真问题**：一开始我用"输出尾部 6 行"做匹配，结果 9 个演示误报失败 —— 因为期望的字符串出现在输出中段。修法是把判定改成全文匹配，显示仍用尾部。**这类"验收工具自己不可靠"的故障最危险，因为它会让你开始不信任验收结果。**

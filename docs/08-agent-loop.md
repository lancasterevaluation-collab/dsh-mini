# 第 8 步 · agent 循环

> **代码**：`src/kernel/agent.ts`（约 160 行） · **演示**：`src/demos/demo-agent.ts`
> **对前几步的反哺**：改了 `llm.ts`（`Provider.chat` 加 `signal`、新增 `CANCELLED` 错误码）和 `session.ts`（`TurnEndReason` 加 `'max-steps'`）
> **DSH 对应**：`packages/core/agent-loop/src/agent.ts`（`ReactLoopAgent`）
> **本篇目标级别**：L3（关掉文档能从零重写）
> **预计阅读**：90–120 分钟 · **预计动手**：100 分钟

---

## 本篇新词

> 全部术语在 [`glossary.md`](../glossary.md)。先花 60 秒扫一遍。

| 词 | 一句话 | 为什么必须懂 |
|---|---|---|
| **驱动（driver）** | 决定"下一步做什么"的那段代码 | 它是唯一有"控制流"的地方 |
| **配对规则** | assistant 带 N 个 `tool_calls`，后面必须跟 N 个 tool 消息 | **违反直接 400** |
| **收工判定** | 什么条件下认为任务完成了 | 模型不再要求调用工具 |
| **步数上限** | 防止无限循环的硬边界 | 超限**不是错误**，是另一种结局 |
| **取消（cancellation）** | 调用方主动中止 | 必须传到底层，且**不该被重试** |
| **闭合的 turn** | 每个 turn 都有配对的 `turn/end` | 日志"任何时候都是完整状态" |
| **顺序执行 vs 并发执行** | 多个工具调用的两种处理 | 我们选顺序，理由见 1.6 |

---

## 第 0 节 · 这一步的成品长什么样

### 0.1 你会写出什么

```
┌────────────────────────────────────────────────────────────────────┐
│  agent.ts（约 160 行）                                              │
│                                                                    │
│  ① DEFAULT_MAX_STEPS   默认步数上限（20）                           │
│  ② AgentOptions        依赖注入：provider / tools / session / …     │
│  ③ TurnStatus          'complete' | 'max-steps' | 'cancelled'      │
│  ④ TurnResult          { status, steps, text }                     │
│  ⑤ Agent 类                                                        │
│       constructor      注入依赖                                     │
│       run()            ★ 跑一次任务（turn）                         │
│       #step()          ★ 走一步（step）                             │
└────────────────────────────────────────────────────────────────────┘
```

**它只有约 160 行** —— **但它是把前面七步全部串起来的那 160 行。**

### 0.2 对前几步的修改

**这一步的需求反哺了第 1 步和第 7 步的设计。**

| 文件 | 改动 | 为什么 |
|---|---|---|
| `llm.ts` | `Provider.chat` 加 `signal?: AbortSignal` | **支持取消** |
| `llm.ts` | `LLMErrorCode` 加 `'CANCELLED'` | 取消**不该被重试** |
| `llm.ts` | `toTransportError` 把 `AbortError` 归成 `CANCELLED` | **修掉第 1 步 L9 缺陷 2** |
| `llm.ts` | `DeepSeekProvider` 用 `AbortSignal.any` 合并超时与取消 | 两个信号都要生效 |
| `llm.ts` | `MockProvider.chat` 也检查 `signal` | **否则取消路径测不出来** |
| `session.ts` | `TurnEndReason` 加 `'max-steps'` | **超限不是错误**，要能区分 |

**这就是"分步演进"的真实形态**：

> **你在第 8 步才需要"取消"，而第 1 步的接口没有它。**
> **于是第 8 步回过头改第 1 步 —— 这是正常的，不是"当初设计错了"。**

**关键是要"在需要它的时候才改"**，而不是"一开始就预留所有可能性"。

### 0.3 运行起来是什么样

```powershell
node src/demos/demo-agent.ts
```

关键输出：

```
--- 结果 ---
{"status":"complete","steps":2,"text":"工具返回了 hello。"}

--- 事件流 ---
["0 turn/start","1 user/message","2 step/start","3 assistant/message","4 tool/call",
 "5 tool/result","6 step/end","7 step/start","8 assistant/message","9 step/end","10 turn/end"]

--- 配对检查 ---
{"第 1 步 assistant 要求的工具数":2,"实际产生的 tool/result 数":2,
 "说明":"★ 必须相等 —— 少一条服务端就 400"}

--- 结果（步数超限）---
{"status":"max-steps","steps":3,"text":""}

--- 统计 ---
  demo-1   steps=2  turns=1  工具=1  错误=0
  demo-2   steps=2  turns=1  工具=2  错误=0
  demo-4   steps=3  turns=1  工具=3  错误=0
```

**最后一段是你要的**：**把一批任务的 `steps` 求平均，就是"平均完成步数"。**

---

## 第 0.5 节 · 系统视角

### 你在哪里

```
             ⑦ 入口层（第 11 步，还没写）
                        ▲
                        │ 调 agent.run(task)
                        │
        ┌───────────────┴───────────────┐
        │ 【第 8 步】                    │
        │ ★ agent 循环 —— 总装 ★          │
        │ ▶ 你在这里 ◀                    │
        └───────────────┬───────────────┘
                        │ 它同时使用前面所有零件
   ┌────────┬───────────┼───────────┬────────┐
   ▼        ▼           ▼           ▼        ▼
 模型层    工具层      会话日志    事件      配置
（第 1 步）（第 2 步）（第 7 步）（第 4 步）（第 6 步）
```

**前面的每一步都只是"一个零件"；第 8 步是"装配线"。**

**它没有引入任何新机制** —— 它做的是**给零件排序**：

```
第 1 步的 Provider      → 用来发请求
第 2 步的 ToolRegistry  → 用来生成 schema 和执行
第 7 步的 Session        → 用来记录和派生
```

### 下游：谁在用 agent 循环

| 第 8 步的产物 | 谁消费 | 用来做什么 | 依赖强度 |
|---|---|---|---|
| `Agent` 类 | 第 11 步的 CLI | 跑任务 | 🔴 极强 |
| `TurnResult` | 第 11 步、**你的评测脚本** | 判断成功/失败/超限 | 🔴 极强 |
| `run(task, signal)` | 第 10 步（取消） | 中断长任务 | 🔴 强 |
| `#step` 的结构 | 第 9 步（重试插在请求失败处） | 挂扩展点 | 🔴 强 |
| `session` getter | 第 15 步（诊断） | 拿到日志做归因 | 🔴 强 |

**注意第二行** —— **`TurnResult.status` 就是你台账里的"这道题成功没成功"**：

| status | 含义 | 统计时算成功吗 |
|---|---|---|
| `'complete'` | 模型自己收工了 | ✅ 通常算 |
| `'max-steps'` | 跑到上限 | ❌ 通常是失败 |
| `'cancelled'` | 被取消 | ❌ 不算 |

**而这三个值直接来自 `turn/end.reason`** —— 第 7 步的字段在这里被消费。

### 连锁影响分析

#### 连锁 1：如果循环自己维护消息数组（不从日志派生）

```
Agent 里加一个 #messages: ChatMessage[]
   ↓
每次请求用它，同时也往日志 append
   ↓
★ 又变成了"两份数据" —— 而这是第 7 步花力气消灭的东西 ★
   ↓
某次改动只更新了一边
   ↓
模型看到的 ≠ 日志记的
   ↓
★ 无法从日志复现这次请求 ★
```

**我们连"缓存一份派生结果"都没做** —— **每次请求都重新派生**（O(n)）。

**为什么敢这么做？**

| 理由 | 说明 |
|---|---|
| 正确性优先 | 派生是纯函数，不可能不一致 |
| n 很小 | 一个 turn 的消息通常几十条 |
| 优化留到以后 | 如果慢了，可以加缓存**但必须失效正确** |

**这是一个"先用最笨但最对的做法"的例子。**

#### 连锁 2：如果不每步校验不变量

```
某个地方（插件、工具、未来的扩展）绕过日志改了消息
   ↓
如果没有校验：这个 bug 会一路飘到服务端
   ↓
服务端返回 400（"消息格式不对"）
   ↓
★ 你不知道是哪一步、哪段代码改的 ★
```

**有了校验**：

```
Model-visible 与日志不一致：第 3 条（role=tool）内容不同
日志：echo: hello
实际：（被改过）
```

**错误信息直接指向"第 3 条"** —— 你立刻知道去哪找。

**代价**：每次请求多一次 O(n) 比较。**相比网络请求（几百 ms），这个开销可以忽略。**

#### 连锁 3：如果不保证"配对规则"

```
模型一次要求调用 3 个工具
   ↓
第 2 个工具执行时抛了未捕获的异常
   ↓
循环中断，只产生了 2 条 tool/result
   ↓
下一个请求里：assistant 有 3 个 tool_calls，但只有 2 条 tool 消息
   ↓
★ 服务端 400：每个 tool_call 必须有对应的 tool result ★
```

**而我们的实现让它"结构上不可能发生"**：

```ts
for (const call of response.toolCalls) {
  this.#session.recordToolCall(call.id, call.name)
  const result = await this.#tools.execute(...)      // ★ 永远返回结果，不抛异常
  this.#session.recordToolResult(call.id, call.name, result.content, result.isError)
}
```

**关键在第 2 步的设计**：`ToolRegistry.execute()` **任何失败都返回 `fail(...)`，绝不抛异常**。

**所以"每个调用都有结果"是必然的。**

> **这是第 2 步那个决策在第 8 步的兑现** —— 当时说"失败不是异常"，现在看到了它的价值。

### 现在该建立的三个习惯

| 习惯 | 做法 | 训练什么 |
|---|---|---|
| **"结构上不可能"优于"小心不要忘"** | 用设计消灭错误，而不是用纪律 | 可靠性思维 |
| **需要时才改前面的接口** | 不要一开始预留所有可能性 | 避免过度设计 |
| **每条路径都要留下闭合状态** | 正常/超限/取消/出错，四种都要闭合 | 状态机完备性 |

> ### 停下来想一想（不给答案）
>
> 1. 如果循环**缓存**派生结果（只在日志变化时重算），需要什么机制保证缓存不过期？
> 2. 演示 4 里 `max-steps` 的 turn 是"闭合"的，但它**没有产出任何最终文本**。这合理吗？使用者该拿什么给用户看？
> 3. **取消检查放在每步开头** —— 如果放在 `await provider.chat` 之后呢？会有什么不同？

---

## L0 要解决的问题

### 0.1 第 7 步留下的具体缺陷：**没有驱动**

到第 7 步，你能记录、派生、统计、持久化、校验 —— **但一次任务要手工 append 一堆事件**。

**演示 1 的 11 条事件，在第 7 步要这么写**：

```ts
const turn = session.startTurn()
session.recordUser('…')
const step1 = session.startStep()
session.recordAssistant('', [call], usage)
session.recordToolCall(call.id, call.name)
session.recordToolResult(call.id, call.name, content, false)
session.endStep(step1)
// … 还要决定"下一步做什么"
```

**每一步都要人来决定。**

### 0.2 缺的是"控制流"

| 缺什么 | 后果 |
|---|---|
| 什么时候请求模型 | 人工 |
| 什么时候算结束 | 人工 |
| 模型要求多个工具时怎么处理 | 人工 |
| 出错/超时/取消怎么办 | 人工 |

**第 8 步要写的，就是这段控制流。**

### 0.3 这一步要回答的五个问题

| # | 问题 | 本篇位置 |
|---|---|---|
| 1 | 循环的状态放哪？ | **唯一状态是日志**（1.2） |
| 2 | 什么时候算结束？ | 三种路径（1.4） |
| 3 | 多个工具调用怎么处理？ | 顺序 + 配对（1.3、1.6） |
| 4 | 怎么支持取消？ | 反哺第 1 步（1.5） |
| 5 | 出错时 turn 怎么闭合？ | 四种路径都闭合（1.4） |

---

## L1 设计与原理

### 1.1 循环的形状：极简

```
run(task, signal?)
  │
  ├─ 开 turn，记 user/message
  │
  └─ for step = 1 … maxSteps:
       ├─ 取消了？ → 闭合 turn(cancelled)，返回
       ├─ #step():
       │    ├─ 开 step
       │    ├─ 派生消息
       │    ├─ ★ 校验不变量
       │    ├─ 请求模型
       │    ├─ 落盘 assistant/message
       │    ├─ 没有工具调用？ → 闭合 step + turn(complete)，返回最终文本
       │    ├─ 有工具调用 → 逐个执行 + 落盘结果
       │    └─ 闭合 step
       └─ 继续下一步
  │
  └─ 循环结束（没走到 complete）→ 闭合 turn(max-steps)，返回
```

**55 行的控制流。** 加上注释和类型才 160 行。

**这个形状值得记住** —— 因为它和所有 agent 系统的核心循环**基本一致**：

| 系统 | 循环形状 |
|---|---|
| 我们的 | 上面这个 |
| DSH 的 `agent-loop` | 同样的骨架 + 更多扩展点（pre-step / request / request-error / turn-stopping） |
| Claude Code | 据逆向分析，同样是最小 ReAct 循环（⚠️） |
| Hermes | `AIAgent` 的 ReAct 循环（⚠️） |

**差别全在"外围"**（扩展点、压缩、审批、重试），**不在这个骨架**。

### 1.2 ★ 唯一的状态是日志 ★

```ts
async #step(signal?: AbortSignal): Promise<string | undefined> {
  const step = this.#session.startStep()

  // ① 从日志派生请求 —— 不维护内存里的消息数组
  const messages = this.#session.deriveMessages()
  // …
}
```

**`Agent` 类里没有 `#messages` 字段。** 唯一的字段是依赖引用和配置。

**对比"常见做法"**：

```ts
// 常见做法（我们不采用）
class Agent {
  #messages: ChatMessage[] = []      // ← 内存状态

  async #step() {
    this.#messages.push(...)          // 同时维护内存
    this.#session.append(...)         // 和日志
  }
}
```

**为什么不用？**

**因为那又回到了"两份数据"**（第 7 步 1.1 节详述）。

**"每次重新派生"的代价**：

| 代价 | 量级 |
|---|---|
| 一次 O(n) 遍历 | n 是消息数（通常几十） |
| 一次数组构造 | 同上 |

**相比网络请求（几百 ms 到几秒），可以忽略。**

**而且它带来一个额外好处**：

> **`Agent` 变成几乎无状态的 —— 同一个实例可以连续跑多个任务，也可以被丢弃后从日志重建。**

**这在第 11 步的 CLI 里有用**（`--resume` 时从日志重建 agent）。

### 1.3 ★ 配对规则：结构上保证 ★

#### 规则

> **assistant 消息带 N 个 `tool_calls`，后面必须跟 N 个 `tool` 消息。**

**违反的后果**：服务端返回 400（多数 provider 都会校验这个）。

#### 我们的实现

```ts
for (const call of response.toolCalls) {
  this.#session.recordToolCall(call.id, call.name)

  const result = await this.#tools.execute(call.name, call.arguments, { workspace: this.#workspace })

  this.#session.recordToolResult(call.id, call.name, result.content, result.isError)
}
```

**关键：`execute()` 永远返回 `ToolResult`，永远不抛异常。**

**所以"循环被执行完"和"每个 call 都有 result"是同一件事。**

**演示 2 验证了配对**：

```
{"第 1 步 assistant 要求的工具数":2,"实际产生的 tool/result 数":2}
```

**演示 3 验证了"失败也配对"**：

```
["✗ 未知工具 \"does_not_exist\"。可用工具：echo","✗ 工具 echo 的参数不合法："]
```

**两次失败都产生了 `tool/result`**（`isError: true`）。

#### 这个保证的边界在哪

**它保证"工具执行阶段"的配对。但有两个场景它管不到**：

| 场景 | 会怎样 |
|---|---|
| `provider.chat` 之后、`recordAssistant` 之前抛错 | 循环中断，但**没有记录 assistant** → 日志里没这回事，也不会 400 |
| 工具执行**之间**被取消（signal aborted） | **当前实现不检查** → 会继续执行完所有工具 |

**第一条是安全的**（因为没记录就没有不一致）。

**第二条是一个真实缺陷**：如果用户在工具执行中途取消，**我们仍会把那一步的工具全部执行完**。

**写进 L9。**

**改进方式**：

```ts
for (const call of response.toolCalls) {
  this.#session.recordToolCall(call.id, call.name)
  if (signal?.aborted === true) {
    // 取消后的调用也必须产生结果 —— 否则配对破了
    this.#session.recordToolResult(call.id, call.name, '（任务被取消，未执行）', true)
    continue
  }
  // …
}
```

**注意：即使取消，也要为每个 call 写结果** —— **这正是"配对规则优先于取消"的体现。**

**这个细节在 DSH 里有对应的实现**（它对取消后未分发的调用写 `ABORTED_BEFORE_DISPATCH` 结果对）。

### 1.4 三种结束路径 + 四种闭合

#### 三种结束路径（对使用者可见）

| status | 触发 | `turn/end.reason` |
|---|---|---|
| `'complete'` | 模型不再要求调用工具 | `'complete'` |
| `'max-steps'` | 跑满 `maxSteps` | `'max-steps'` |
| `'cancelled'` | 调用方中止 | `'cancelled'` |

#### 四种闭合（对日志而言）

**加上异常路径**：

```ts
} catch (error) {
  // ★ 出错也要留下闭合的 turn —— 否则日志永远停在一个"未完成"的状态
  this.#session.endTurn(turn, 'error')
  throw error
}
```

**"四种闭合"的意义**：

> **无论发生什么，日志里都不会有"未闭合的 turn"。**

**这和 `Session.load` 的"修复未闭合 turn"是同一原则的两端**：

| 位置 | 做什么 |
|---|---|
| `load`（第 7 步） | **读的时候**修复崩溃留下的未闭合 turn |
| `run`（第 8 步） | **写的时候**保证不留未闭合的 turn |

**两道防线，因为"未闭合"会导致派生和统计出错。**

#### 一个容易忽略的细节：`endStep` 也要闭合

```ts
if (response.toolCalls.length === 0) {
  this.#session.endStep(step)
  return response.content
}
// …
this.#session.endStep(step)
return undefined
```

**两条路径都调了 `endStep`。**

**如果漏了 `endStep`**：统计里的 `steps` 会少算 —— **而 `steps` 正是"平均完成步数"。**

**一个数据正确性问题，却源于一个"忘记闭合"的实现细节。**

#### 那 `catch` 里的 step 呢

**注意 `catch` 只闭合 `turn`，没闭合 `step`。**

```
步骤 3 的 #step 抛错
   ↓
catch 里：endTurn(turn, 'error')
   ↓
step 3 的 step/start 没有配对的 step/end
```

**这是一个真实的缺陷**（日志里会有未闭合的 step）。

**为什么没修**：`catch` 拿不到 `step` 编号（它在 `#step` 内部）。

**修法**：让 `#step` 自己处理异常（在内部 try/catch 并闭合 step）。

**写进 L9。**

**但注意**：`turn/end` 闭合了，所以**统计的 `turns` 是准的**，只有 `steps` 可能多一条没有 end 的 start。

**而 `computeStats` 数的是 `step/end`** —— **所以多出来的那个 `step/start` 不影响统计。**

**这算不算问题？** —— **从统计看没问题，从"日志完整性"看有问题。**

**这是个好例子**：**同一份数据，不同的使用方式对"完整性"的要求不同。**

### 1.5 ★ 取消：第 8 步反哺第 1 步 ★

#### 需求从哪来

**`run(task, signal)` 需要能中止。** 因为：

- 用户可能想停（Ctrl+C）
- 上层可能有超时
- **科研里要控制"单题时间预算"**

#### 但第 1 步的接口没有 signal

```ts
// 第 1 步
chat(messages, tools?): Promise<LLMResponse>
```

**第 8 步加上**：

```ts
chat(messages, tools?, signal?): Promise<LLMResponse>
```

#### 连带的三处改动

**① `MockProvider` 也要检查 signal**

```ts
if (signal?.aborted === true) {
  throw new LLMError('CANCELLED', '请求在开始前已被取消')
}
```

**为什么 mock 也要？**

> **如果 mock 不遵守取消语义，那"取消路径"在当前的所有测试里都测不出来。**
> **而真实 provider 会遵守 —— 于是"mock 通过、真实失败"。**

**这是"测试替身必须与真实实现语义一致"的又一例**（第 1 步的 `toToolCall` 复用也是为此）。

**② `DeepSeekProvider` 要合并两个信号**

```ts
const timeout = AbortSignal.timeout(this.#timeoutMs)
const combined = signal === undefined ? timeout : AbortSignal.any([timeout, signal])
```

**`AbortSignal.any([...])` 是 ES2024 的能力**（Node 20+）：**任何一个触发，结果信号就触发。**

**为什么不能只用一个？**

| 只用 timeout | 只用 signal |
|---|---|
| 用户取消时请求还在跑（直到超时） | 没有超时保护 |

**两个都要。**

**③ `AbortError` 不再是可重试的传输错误**

```ts
if (name === 'AbortError') {
  // 第 8 步修正：外部取消不该被当作「可重试的传输错误」
  return new LLMError('CANCELLED', '请求被取消', { cause })
}
```

**这是第 1 步 L9 缺陷 2 的修复** —— 当时我就标注了它，**现在有需求了才修**。

**这验证了"缺陷清单"的价值**：

> **写第 1 步时就记下"`AbortError` 归成 `TRANSPORT` 是权宜之计"，
> 到第 8 步需要取消时，立刻知道该改哪里。**

#### 这次反哺的方法论意义

**如果第 1 步"预留"了 signal 参数会怎样？**

```ts
// 假装第 1 步就预留
chat(messages, tools?, signal?, onChunk?, maxRetries?, metadata?): Promise<LLMResponse>
```

**问题是**：

| 预留的代价 | 说明 |
|---|---|
| 接口噪声 | 每个实现都要接受一堆用不到的参数 |
| **猜错方向** | 预留的可能是"永远用不上"的东西 |
| **假的安全感** | 以为想全了，其实没有 |

**我们的做法**：

> **需要时才加参数，并且同步改所有实现和所有测试。**

**代价**：改动分散（要改 6 处）。
**收益**：**接口始终只包含"真正被需要的东西"。**

**这是"YAGNI（You Aren't Gonna Need It）"的实践** —— 但它有前提：

> **前提是"改起来不贵"。**
> **而"改起来不贵"的前提是：类型系统能找出所有需要改的地方**（编译器报错）。
>
> **这正是我们全程用 TypeScript 的收益。**

### 1.6 顺序执行 vs 并发执行

#### 我们选顺序

```ts
for (const call of response.toolCalls) {
  const result = await this.#tools.execute(...)
}
```

**每个调用依次执行。**

#### 为什么不做并发

**并发的前提是"这几个调用互不影响"** —— 而判断这一点**需要对每个工具有元数据**。

**我们有什么信息？**

| 信息 | 有吗 |
|---|---|
| 工具名 | ✅ |
| 参数 | ✅ |
| **它有没有副作用** | ❌ **（第 2 步设计的 `sideEffect` 还没实现）** |
| **它能不能并行** | ❌ |

**没有这些信息，就无法安全并发。**

**具体风险**：

```
模型一次要求：① 读 a.txt  ② 写 a.txt  ③ 读 a.txt
如果并发执行 → ②③ 的顺序不确定
   ↓
★ 结果不可复现 ★
```

**而"不可复现"对科研是致命的。**

#### 什么条件下可以并发

**当你能证明"这些调用互不干扰"时。** DSH 的做法是**把工具分类**：

| 类别 | 行为 |
|---|---|
| **exclusive（独占）** | **单独执行，前后形成屏障** |
| **parallel-safe（可并行）** | 可以并发，受 `maxParallelToolCalls` 限制 |

**它的注释**（✅ 我们读过 `packages/core/agent-loop/src/tool-calls.ts`）：

> "Schedules one assistant step's tool calls. **Exclusive calls form barriers**; parallel-safe calls use the bounded rolling pool."

**从我们的角度来看**：这是**"用元数据换并发"** —— 而元数据就是第 2 步的 `sideEffect`（还没实现）。

**所以顺序执行的真正理由是**：

> **我们缺少"哪些工具可以并行"的元数据。**

**对应我们的改进路径**：

| 步骤 | 做什么 |
|---|---|
| 1 | 实现 `sideEffect` 字段（第 2 步的挑战题 1） |
| 2 | 把 `sideEffect: 'none'` 的工具标为"可并行" |
| 3 | 循环里把连续的"可并行"调用打包执行 |
| 4 | 保留"有副作用"的调用作为屏障 |

**这也是一个可以做成挑战题的设计**（见 L7）。

> ### 停下来想一想（不给答案）
>
> 1. 如果循环"缓存派生结果"，需要什么机制保证缓存不过期？（提示：日志什么时候会变？）
> 2. `catch` 里没有 `endStep` —— **这会影响 `computeStats` 的哪些字段？为什么？**
> 3. **取消时**，工具执行循环应该"立刻跳出"还是"为每个调用补一条未执行的结果"？两者的代价分别是什么？

---

## L2 决策表

| # | 决策 | 我们的选择 | 替代方案 | 代价落在谁身上 |
|---|---|---|---|---|
| 1 | 状态放哪 | **只在日志里** | 内存维护消息数组 | 每次请求多一次 O(n) 派生；换来结构性一致 |
| 2 | 不变量校验 | **每次请求前** | 只在调试时校验 | 每次多一次 O(n) 比较；换来 bug 当场暴露 |
| 3 | 工具执行 | **顺序** | 并发 | 慢；换来可复现（**并发需要元数据**） |
| 4 | 配对保证 | **每个调用都产生结果** | 靠开发者的纪律 | 失败也占一条日志；换来结构上不 400 |
| 5 | 步数上限 | **有默认值（20）** | 无上限 | 简单任务可能被截断；换来不会无限循环 |
| 6 | 超限的语义 | **独立的 `'max-steps'`** | 归到 `'error'` | 要多改一个类型；换来统计能区分 |
| 7 | 取消检查点 | **每步开头** | 每次 await 后 | 粒度粗；换来实现简单且语义清晰 |
| 8 | 取消信号 | **反哺第 1 步加参数** | 用全局 AbortController | 改了 6 处代码；换来显式、可组合 |
| 9 | 出错时 | **闭合 turn 后抛出** | 吞掉错误返回失败状态 | 调用方要 try/catch；换来错误不被隐藏 |
| 10 | `endStep` | **两条路径都调** | 用 finally | 容易漏；换来显式（但漏了会算错 steps） |

### 关于第 6 条的论证

**为什么"超步数"不是错误？**

| 视角 | 判断 |
|---|---|
| 它是失败吗 | **对任务来说通常是**（没做完） |
| 它是错误吗 | **不是** —— 没有任何东西出错 |
| 那它是什么 | **一种"预算耗尽"的结束** |

**分开的价值在统计**：

```
如果把 max-steps 归到 error：
   你无法区分"跑崩了"和"跑到上限"
   ↓
   而这两者的应对完全不同：
     跑崩了 → 修 bug
     到上限 → 提高上限 或 改进效率
```

**这是"错误分类要够细才能指导行动"的又一例**（第 1 步的 `LLMErrorCode` 也是这个逻辑）。

### 关于第 9 条的论证

**为什么出错时不"返回一个失败的 TurnResult"，而是抛？**

| 方案 | 调用方体验 |
|---|---|
| 返回 `{ status: 'error' }` | 不用 try/catch；但**容易忽略** |
| **抛出**（我们选的） | 必须处理；**不会被静默忽略** |

**判断标准**：**这个失败是"预期内的"还是"意外的"？**

| 情况 | 类型 | 处理 |
|---|---|---|
| 模型收工 / 超步数 / 取消 | **预期内** | 返回值 |
| provider 网络错误 / 工具层意外 bug | **意外** | 抛出 |

**这个划分和第 2 步的"工具失败不是异常"是一致的**：

```
工具执行失败  → 预期内（模型会瞎编参数）→ 返回 fail 结果
循环本身出错  → 意外（网络挂了、代码有 bug）→ 抛出
```

> **同一条原则，在两处应用。**

> ### 停下来想一想（不给答案）
>
> 1. 第 1 条说"每次派生 O(n)"。**如果一个 turn 有 200 步，总开销是多少？** 可接受吗？
> 2. 第 5 条说默认 20 步。**这个数字怎么定？** 定太小和太大分别有什么后果？
> 3. 第 10 条说"用 finally 也可以，但显式更好" —— **你同意吗？** finally 有什么陷阱？

---

---

## L3 实现：逐行讲解

### 3.0 文件结构

```
┌─── 常量与类型（20–50 行）    DEFAULT_MAX_STEPS / AgentOptions / TurnStatus / TurnResult
├─── Agent 类（55–160 行）
│      constructor           注入依赖
│      session getter        暴露会话
│      run()                 ★ turn 层控制流
│      #step()               ★ step 层控制流
└─── 注释占三分之一
```

**160 行里，真正的控制流只有约 55 行。**

**剩下的都是类型、注释、和"确保每条路径都闭合"的代码。**

### 3.1 文件头注释：三个设计要点（第 1–27 行）

```ts
/**
 * 第 8 步 ｜ agent 循环：把「请求 → 工具 → 再请求」自动化
 *
 * 到第 7 步为止，所有零件都齐了：
 *   模型层（1）、工具层（2）、容器（3）、事件与依赖注入（4）、
 *   隔离（5）、配置（6）、会话日志（7）
 *
 * 但**没有东西驱动它们**：一次任务要手工 append 一堆事件。
 *
 * 这一步就是那个驱动。它的形状极简 ——
 *
 *     while (还有事做) {
 *       请求模型（用日志派生的消息）
 *       如果模型不要求调用工具 → 收工
 *       执行工具 → 结果写进日志
 *     }
 *
 * ── 三个设计要点 ──────────────────────────────────────────────────────
 *
 * ① **唯一的状态是日志。** 循环自己不维护消息数组 —— 每次请求前从日志派生。
 *    于是「模型看到的」与「日志记的」结构上不可能不一致。
 *
 * ② **每次请求前校验不变量。** 一旦有代码绕过日志直接改消息，当场暴露。
 *
 * ③ **工具消息必须与 tool_calls 一一配对。** assistant 带 N 个 tool_calls，
 *    后面就必须跟 N 个 tool 消息 —— 少一条服务端直接 400。
 *    ★ 我们的做法：**每个调用都产生一条结果**（失败也产生失败结果）。
 *    这样配对是**结构上保证**的，而不是靠记忆。
 */
```

**这段注释的三个部分**：

| 部分 | 内容 | 作用 |
|---|---|---|
| 第 1 段 | 前七步都齐了，但没有驱动 | **交代位置** |
| 第 2 段 | **伪代码形状** | **一眼看懂这个文件干什么** |
| 第 3 段 | **三个设计要点** | **读代码前先知道重点在哪** |

**第 2 段用伪代码而不是散文** —— 因为**控制流用代码表达最清楚**：

```
while (还有事做) {
  请求模型（用日志派生的消息）
  如果模型不要求调用工具 → 收工
  执行工具 → 结果写进日志
}
```

**五行伪代码 = 一整个文件的本质。**

**第 3 段的三个要点，每一个都在正文里有对应的小节**（1.2、1.2 的校验、1.3）。

**这是"文件头注释与正文互相索引"的做法。**

### 3.2 常量与类型（第 20–50 行）

```ts
/** 默认的步数上限。 */
export const DEFAULT_MAX_STEPS = 20

/** 一次 run 的依赖。 */
export interface AgentOptions {
  readonly provider: Provider
  readonly tools: ToolRegistry
  readonly session: Session
  /** 工具的工作目录。 */
  readonly workspace: string
  /** 最多走几步；不给用 {@link DEFAULT_MAX_STEPS}。 */
  readonly maxSteps?: number
}

/** 一次 turn 的结局。 */
export type TurnStatus = 'complete' | 'max-steps' | 'cancelled'

/** 一次 run 的结果。 */
export interface TurnResult {
  readonly status: TurnStatus
  /** 实际走了多少步。 */
  readonly steps: number
  /** 收工时的模型文本（非 complete 时为空串）。 */
  readonly text: string
}
```

#### `AgentOptions` —— 依赖注入的形态

**它把四个依赖列出来**：

| 依赖 | 来自 | 作用 |
|---|---|---|
| `provider` | 第 1 步 | 发请求 |
| `tools` | 第 2 步 | schema + 执行 |
| `session` | 第 7 步 | 记录 + 派生 |
| `workspace` | 配置 | 工具的工作目录 |
| `maxSteps` | 配置（可选） | 上限 |

**这就是"依赖注入"的手写版**：

```ts
// 依赖注入
const agent = new Agent({ provider, tools, session, workspace })

// 硬编码（不采用）
class Agent {
  constructor() {
    this.#provider = new DeepSeekProvider({ apiKey: process.env.KEY })   // ← 写死了
    this.#tools = new ToolRegistry()
    this.#session = new Session(randomId())
  }
}
```

**差别在"测试时能不能替换"**：

```ts
// 注入版：测试时可以全换成 mock
const agent = new Agent({ provider: mockProvider, tools: mockTools, session: new Session('t'), workspace: '.' })
```

**这就是我们在第 3–6 步建立的容器思想在"没有容器时"的手工形态。**

**注意**：**第 8 步还没把它包成插件**（那要等第 11 步之后）。**所以现在是手工注入。**

**这也是"分步演进"的体现** —— 先能用，再插件化。

#### `TurnResult.steps` 的类型是 `number` 而不是字面量

**注意 `steps` 的注释**："实际走了多少步"。

**为什么强调"实际"？**

因为三种状态下它的含义不同：

| status | steps 的含义 |
|---|---|
| `complete` | 收工时是第几步 |
| `max-steps` | 等于上限 |
| `cancelled` | **取消前完成了几步** |

**第三行是关键** —— 见 3.4 的 `step - 1`。

#### `text` 的注释

```ts
/** 收工时的模型文本（非 complete 时为空串）。 */
readonly text: string
```

**"非 complete 时为空串"** 这个说明很重要 —— 否则使用者会以为"超步数时能拿到部分输出"。

**这也是一个真实的设计局限**：

> **如果任务跑到上限，用户拿到的是空文本 —— 而模型其实说了很多。**
>
> **更好的设计**：返回最后一条 assistant 的 content。

**写进 L9。**

### 3.3 `Agent` 类的字段（第 55–80 行）

```ts
export class Agent {
  readonly #provider: Provider
  readonly #tools: ToolRegistry
  readonly #session: Session
  readonly #workspace: string
  readonly #maxSteps: number

  constructor(options: AgentOptions) {
    this.#provider = options.provider
    this.#tools = options.tools
    this.#session = options.session
    this.#workspace = options.workspace
    this.#maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
  }

  /** 这个 agent 正在写的会话。 */
  get session(): Session {
    return this.#session
  }
```

#### 五个字段全是 `readonly #`

**`readonly`**：构造后不变。
**`#`**：真私有。

**注意没有 `#messages`** —— **这是 1.2 节那个设计决策的直接体现。**

**"字段列表就是"这个类维护什么状态"的清单"** —— 而我们的清单里**没有任何可变状态**。

#### `session` 的 getter

**为什么要暴露它？**

因为**调用方需要拿日志**：

```ts
const result = await agent.run('任务')
const stats = agent.session.stats()          // 统计
const events = agent.session.events          // 全部事件
await agent.session.save('path.jsonl')       // 保存
```

**这是"把日志的所有权交给调用方"** —— agent 只是"写日志的人"，不是"日志的所有者"。

**这和 DSH 的设计一致**：会话由 `ctx.sessions` 服务管理，agent loop 只写入。

### 3.4 `run()`（第 82–118 行）★ turn 层 ★

```ts
  async run(task: string, signal?: AbortSignal): Promise<TurnResult> {
    const turn = this.#session.startTurn()
    this.#session.recordUser(task)

    try {
      for (let step = 1; step <= this.#maxSteps; step += 1) {
        // 取消检查放在每步开头：这样「取消时已完成几步」是准确的
        if (signal?.aborted === true) {
          this.#session.endTurn(turn, 'cancelled')
          return { status: 'cancelled', steps: step - 1, text: '' }
        }

        const finalText = await this.#step(signal)
        if (finalText !== undefined) {
          this.#session.endTurn(turn, 'complete')
          return { status: 'complete', steps: step, text: finalText }
        }
      }

      this.#session.endTurn(turn, 'max-steps')
      return { status: 'max-steps', steps: this.#maxSteps, text: '' }
    } catch (error) {
      // ★ 出错也要留下闭合的 turn —— 否则日志永远停在一个"未完成"的状态
      this.#session.endTurn(turn, 'error')
      throw error
    }
  }
```

#### 逐段

**① 开 turn + 记用户输入**

```ts
const turn = this.#session.startTurn()
this.#session.recordUser(task)
```

**两行，但顺序重要**：先 `startTurn` 再 `recordUser` —— 这样日志里 `turn/start` 在 `user/message` 之前。

**为什么顺序重要？** 因为**派生是按顺序的**，而且**人读日志时顺序就是时间线**。

**② 循环边界**

```ts
for (let step = 1; step <= this.#maxSteps; step += 1) {
```

**`step` 从 1 开始**（不是 0）—— 因为"第 1 步"比"第 0 步"符合直觉。

**注意这个 `step` 是"循环计数"，而 `#step()` 内部还会 `startStep()` 分配一个 session 里的 step 编号。**

**两者会一致吗？**

| | 值 |
|---|---|
| 循环变量 `step` | 1, 2, 3… |
| `session.startStep()` 分配 | 也是 1, 2, 3…（第 7 步的 `#nextStep` 从 1 开始） |

**它们恰好一致，但是"两个独立的计数器"。**

**这是个隐患**：如果 `#step()` 因为某种原因没有分配（比如抛错），两个计数器就会错位。

**为什么没统一？** 因为 `#step()` 需要自己分配（它要记录 step 编号），而循环需要自己计数（它要判断边界）。

**更干净的做法**：让 `#step()` 返回它分配的编号，循环用它判断边界。

**写进 L9。**

**③ 取消检查放在循环开头**

```ts
if (signal?.aborted === true) {
  this.#session.endTurn(turn, 'cancelled')
  return { status: 'cancelled', steps: step - 1, text: '' }
}
```

**注意 `steps: step - 1`** —— 因为**这一步还没执行**。

```
step = 1 时取消 → steps: 0（一步都没走）
step = 3 时取消 → steps: 2（走完了 2 步）
```

**这个 `-1` 很容易写错。** 如果你写成 `steps: step`，会多算一步。

**演示 5 验证了它**：

```
--- 结果 ---  {"status":"cancelled","steps":0,"text":""}
```

**（一开始就取消 → 0 步）**

**④ 收工**

```ts
const finalText = await this.#step(signal)
if (finalText !== undefined) {
  this.#session.endTurn(turn, 'complete')
  return { status: 'complete', steps: step, text: finalText }
}
```

**`#step()` 的返回值约定**：

| 返回 | 含义 |
|---|---|
| `string` | **收工了**，这是最终文本 |
| `undefined` | **还没完**，继续下一步 |

**为什么用 `undefined` 而不是 `null` 或特殊对象？**

因为**"没有值"就是 `undefined` 的原生语义** —— 不需要发明新东西。

**但注意**：**空字符串 `''` 是合法的"收工"** —— 所以不能用 `if (finalText)` 判断（空串是 falsy）。

**我们用了 `!== undefined`** —— **这正是"区分'没有值'和'空值'"的实践**（和第 1 步的 `parseError !== ''` 同一个道理）。

**⑤ 超步数**

```ts
this.#session.endTurn(turn, 'max-steps')
return { status: 'max-steps', steps: this.#maxSteps, text: '' }
```

**注意它在 `for` 循环之后** —— 意味着**循环自然结束**（没 `return`）。

**⑥ 异常路径**

```ts
} catch (error) {
  this.#session.endTurn(turn, 'error')
  throw error
}
```

**原样重抛**（不包装）—— 理由同第 3 步的装载失败（保留原始类型和堆栈）。

**注意这里没有 `endStep`** —— **见 1.4 节末尾的缺陷分析。**

#### 一个隐含的保证

**这个函数的四条返回/抛出路径，每条都调了 `endTurn`。**

**这是"turn 一定闭合"的实现。**

**验证方式**：数一数 `endTurn` 出现几次 —— **4 次**（cancelled / complete / max-steps / error）。

**而 `return` 语句有 3 个、`throw` 1 个** —— **一一对应。**

### 3.5 `#step()`（第 120–160 行）★ step 层 ★

```ts
  async #step(signal?: AbortSignal): Promise<string | undefined> {
    const step = this.#session.startStep()

    // ① 从日志派生请求 —— 不维护内存里的消息数组
    const messages = this.#session.deriveMessages()

    // ② ★ 校验不变量：实际要发的消息，必须与日志派生的完全一致
    assertModelVisibleMatchesLog(this.#session, messages)

    // ③ 请求模型
    const response = await this.#provider.chat(messages, this.#tools.schemas(), signal)

    // ④ 先落盘，再决策 —— 保证"模型说了什么"永远是第一个被记住的事实
    this.#session.recordAssistant(response.content, response.toolCalls, response.usage)

    // ⑤ 模型不再要求调用工具 → 收工
    if (response.toolCalls.length === 0) {
      this.#session.endStep(step)
      return response.content
    }

    // ⑥ 执行工具。**顺序执行**，且每个调用都产生一条结果（见文件头的 ③）
    for (const call of response.toolCalls) {
      this.#session.recordToolCall(call.id, call.name)

      const result = await this.#tools.execute(call.name, call.arguments, {
        workspace: this.#workspace,
      })

      this.#session.recordToolResult(call.id, call.name, result.content, result.isError)
    }

    this.#session.endStep(step)
    return undefined
  }
```

#### 六个编号步骤的设计

**① 派生 → ② 校验 → ③ 请求 → ④ 落盘 → ⑤ 判断 → ⑥ 执行**

**这个顺序本身是设计**：

| 顺序 | 为什么 |
|---|---|
| 派生在请求前 | **每次都重新派生**（不缓存） |
| **校验在派生后、请求前** | 校验的是"**即将发出的东西**" |
| **落盘在判断前** | **"模型说了什么"是事实**，先记下来再决策 |
| 执行在判断后 | 只有"有工具调用"才执行 |

**第 3 条的措辞值得记住**：

> **先落盘，再决策。**

**为什么？**

因为**"模型说了什么"是已经发生的事实** —— 无论我们接下来怎么决策（执行工具、收工、还是抛错），这个事实都不会变。

**而"决策"可能失败**（比如工具执行抛异常）—— **如果先决策后落盘，那个事实就丢了。**

**这是一个通用的原则**：

> **事实先记，决策后做。**

#### ② 校验的位置为什么在这里

```ts
const messages = this.#session.deriveMessages()
assertModelVisibleMatchesLog(this.#session, messages)
```

**紧跟在派生之后** —— 校验的是"**刚派生出来的、即将发出去的那一份**"。

**为什么不在别处校验？**

| 位置 | 问题 |
|---|---|
| 循环开始时 | 那时还没派生 |
| 请求返回后 | 那时消息已经发出去了 |
| **派生后立刻** | ✅ 在"发出前"的最后时刻 |

**这是"在最靠近边界的地方校验"** —— 和内层的参数校验是同一个原则。

**注意它"总是通过"**（因为 `messages` 就是派生的结果）。

**那它有什么用？**

**它防的是"未来有人绕过日志改消息"**：

```ts
// 未来某个插件可能这么干（错误做法）
const messages = session.deriveMessages()
messages.push({ role: 'user', content: '（偷偷加一句）' })      // ← 这里就露馅了
assertModelVisibleMatchesLog(session, messages)                  // ★ 抛错 ★
```

**所以它现在是"永久通过"，将来是"哨兵"。**

**这类"当前冗余、防止未来的错误"的代码，要写清它的目的** —— 否则会被后来的人当成死代码删掉。

**我们的注释写了**："★ 校验不变量：实际要发的消息，必须与日志派生的完全一致"。

**但没写"为什么现在是冗余的"** —— **这是个可以改进的点。**

#### ③ 请求：三个参数

```ts
const response = await this.#provider.chat(messages, this.#tools.schemas(), signal)
```

| 参数 | 来源 |
|---|---|
| `messages` | 日志派生 |
| `this.#tools.schemas()` | 工具注册表（**每次重新生成**） |
| `signal` | 从 `run` 透传下来 |

**注意 `schemas()` 每次调用都重新生成** —— 这也是一种"不缓存"。

**为什么？** 因为**工具集可能变**（将来的 scope 隔离会让不同 agent 看到不同工具）。

**代价**：每次请求多一次 O(工具数) 的构造。**可忽略。**

#### ⑤ 收工判断

```ts
if (response.toolCalls.length === 0) {
  this.#session.endStep(step)
  return response.content
}
```

**判断依据是"有没有工具调用"，而不是"内容是否为空"。**

**这两者的区别很重要**：

| 情况 | toolCalls | content | 我们怎么处理 |
|---|---|---|---|
| 模型正常回答 | 空 | 有内容 | ✅ 收工 |
| 模型只调工具 | 非空 | 空 | ✅ 继续 |
| **两者都空** | 空 | 空 | ⚠️ **也收工**（返回空文本） |
| 两者都有 | 非空 | 有内容 | ✅ 继续（内容先落盘了） |

**第三行是一个边缘情况**：模型返回了空响应。

**我们"收工并返回空文本"** —— 但**这其实是个失败**（模型什么都没说）。

**第 1 步的 `EMPTY_RESPONSE` 错误码就是为这种情况准备的** —— **但它在 provider 层被拦吗？**

**看第 1 步的 `parseCompletion`**：

```ts
if (!Array.isArray(choices) || choices.length === 0) {
  throw new LLMError('EMPTY_RESPONSE', ...)      // ← 只在"没有 choices"时抛
}
```

**它只在"没有 choices"时抛** —— **如果 choices 存在但 message 是空的，不会抛。**

**所以"两者都空"的情况会走到我们的 `complete` 分支。**

**这是一个真实的缺陷**（写进 L9）：**空响应应该被当作失败，而不是"成功收工"。**

**修法**：

```ts
if (response.toolCalls.length === 0) {
  if (response.content === '') {
    this.#session.endStep(step)
    throw new LLMError('EMPTY_RESPONSE', '模型返回了空响应')     // ← 让上层处理
  }
  // …
}
```

**但那样会抛异常 —— 而抛异常会走 `catch` 分支（turn 闭合为 `error`）。**

**这也许正是对的**：空响应是个错误。

#### ⑥ 工具执行循环

```ts
for (const call of response.toolCalls) {
  this.#session.recordToolCall(call.id, call.name)

  const result = await this.#tools.execute(call.name, call.arguments, {
    workspace: this.#workspace,
  })

  this.#session.recordToolResult(call.id, call.name, result.content, result.isError)
}
```

**三行一组，重复 N 次**：

| 行 | 记什么 |
|---|---|
| `recordToolCall` | **我们要开始调用了**（过程事件） |
| `execute` | 执行（**永远返回结果**） |
| `recordToolResult` | **结果**（表面事件） |

**注意 `recordToolCall` 在 `execute` 之前** —— 这样即使 `execute` 内部有副作用（比如它自己写了日志），**顺序也是"先记调用，再记结果"**。

**`execute` 的第四个参数是 `workspace`** —— **不是 signal**。

**这意味着：工具执行不响应取消。**

**这正是 1.3 节末尾说的缺陷** —— **取消时仍会执行完所有工具。**

**改法见挑战题。**

#### 两条返回路径都 `endStep`

```ts
if (response.toolCalls.length === 0) {
  this.#session.endStep(step)
  return response.content
}
// …
this.#session.endStep(step)
return undefined
```

**没有用 `finally`** —— **因为我们想要"显式的两处"**。

**用 `finally` 会怎样**：

```ts
try {
  // …
  return response.content
} finally {
  this.#session.endStep(step)      // ← 更简洁
}
```

**它能工作，而且更不容易漏。**

**但 `finally` 有个陷阱**：**如果 `endStep` 内部抛错，它会掩盖原来的错误**。

**而 `endStep` 现在不会抛**（它只是 `append`）。

**所以两者都可以** —— **我们用显式版，因为它读起来更"看得见"**。

**但代价是"将来有人加第三条返回路径时会漏"。**

**这是一个真实的取舍**：**显式（可读）vs finally（不易漏）。**

**（个人倾向 `finally`，因为它更不容易错。但显式版在"只有两条路径"时是清楚的。）**

---

## L4 运行与验证

### 4.1 怎么运行

```powershell
cd D:\agent-harness-lab
node src/demos/demo-agent.ts
```

### 4.2 六组演示逐条解读

#### 演示 1 · 完整任务

```
--- 结果 ---  {"status":"complete","steps":2,"text":"工具返回了 hello。"}

--- 事件流 ---
["0 turn/start","1 user/message","2 step/start","3 assistant/message","4 tool/call",
 "5 tool/result","6 step/end","7 step/start","8 assistant/message","9 step/end","10 turn/end"]

--- 最终派生出的消息 ---
[{"role":"user","content":"用 echo 工具回显 hello"},
 {"role":"assistant","content":"","toolCalls":[{...}]},
 {"role":"tool","content":"echo: hello","toolCallId":"call_0","name":"echo"},
 {"role":"assistant","content":"工具返回了 hello。"}]
```

**要观察的四件事**：

| 观察 | 说明 |
|---|---|
| **11 条事件** | 一个 turn、两个 step |
| **4 条消息** | 表面事件才产生消息（第 7 步的规则） |
| 事件顺序 | `tool/call` 在 `assistant/message` 之后、`tool/result` 之前 |
| **第 3 条消息带 `toolCallId`** | 配对的关键 |

**注意第 2 条消息的 `content` 是空串** —— **但 `toolCalls` 非空**。

**这正是第 1 步说的"模型只调工具时 content 常为空"。**

#### 演示 2 · 配对规则（★ 核心 ★）

```
--- 配对检查 ---
{"第 1 步 assistant 要求的工具数":2,"实际产生的 tool/result 数":2,
 "说明":"★ 必须相等 —— 少一条服务端就 400"}
```

**要观察的**：**两个数字必须相等**。

**它是怎么保证的？** —— **因为 `execute` 永不抛异常**（第 2 步的设计）。

**这一组演示的是"两个步骤之间的设计耦合"**：

> **第 2 步的"失败不是异常"，在第 8 步变成了"配对是结构上保证的"。**

#### 演示 3 · 工具失败也配对

```
--- 两次失败的结果都进了日志 ---
["✗ 未知工具 \"does_not_exist\"。可用工具：echo",
 "✗ 工具 echo 的参数不合法："]
```

**要观察的**：

| 观察 | 说明 |
|---|---|
| 两次都是 `✗`（isError: true） | 失败被正确标记 |
| **失败也产生了 `tool/result`** | **配对没破** |
| 错误信息里有"可用工具" | 模型能自我纠正 |

**而且循环继续了**（第 3 步模型说"我知道错了。"）—— **因为失败不是异常。**

#### 演示 4 · 步数超限

```
--- 结果 ---  {"status":"max-steps","steps":3,"text":""}

--- turn 是怎么闭合的 ---
{"seq":17,"time":...,"type":"turn/end","data":{"turn":1,"reason":"max-steps"}}
```

**要观察的三件事**：

| 观察 | 说明 |
|---|---|
| `status: 'max-steps'` | **不是 `'error'`** |
| `steps: 3` | 等于 `maxSteps` |
| `reason: 'max-steps'` | 日志里也是这个值 |

**第 2 条是"超限不是错误"的体现** —— 统计时能区分。

#### 演示 5 · 取消

```
--- 结果 ---  {"status":"cancelled","steps":0,"text":""}
--- turn 的 reason ---  cancelled
```

**要观察的**：**`steps: 0`** —— 因为一开始就取消了，**一步都没走**。

**注意 `text` 是空串** —— **这是"取消时不返回部分文本"的局限**（见 L9）。

#### 演示 6 · 统计（★ 与你科研对接 ★）

```
  demo-1   steps=2  turns=1  工具=1  错误=0
  demo-2   steps=2  turns=1  工具=2  错误=0
  demo-4   steps=3  turns=1  工具=3  错误=0
```

**要观察的**：

| 任务 | steps | 说明 |
|---|---|---|
| demo-1 | 2 | 调一次工具 + 一次回答 |
| demo-2 | 2 | 调两个工具（同一步）+ 一次回答 |
| demo-4 | 3 | 跑满上限 |

**第二行值得注意**：**调两个工具仍然只算 2 步** —— 因为**它们在同一个 step 里**。

> **"步"是"一次模型请求"，不是"一次工具调用"。** 这个区分在报告"平均完成步数"时必须说清。

**而 `工具=?` 那一列才是"工具调用次数"** —— **两个指标回答不同的问题**。

### 4.3 验收判据

| # | 判据 | 验证 |
|---|---|---|
| 1 | 六组演示全部符合上述输出 | 运行 |
| 2 | 演示 2 的两个数字相等 | 看输出 |
| 3 | 演示 3 的失败也产生了 `tool/result` | 看输出 |
| 4 | 演示 4 的 `status` 是 `max-steps` 而非 `error` | 看输出 |
| 5 | 演示 5 的 `steps` 是 0 | 看输出 |
| 6 | **你能说出"配对为什么是结构上保证的"** | 口述（提示：第 2 步的哪个设计） |
| 7 | 你能说出"为什么先落盘再决策" | 口述 |
| 8 | 你能说出"循环自己维护消息数组会怎样" | 口述 |
| 9 | **关掉文档**能写出 `run()` 的骨架 | 见 L6 |

---

## L5 语法速查（本篇新增）

> 第 1–7 步的语法分别在 [`01`](../01-llm.md#l5-本篇-typescript-语法速查) / [`02`](../02-tools.md#l5-语法速查本篇新增) / [`03`](../03-context.md#l5-语法速查本篇新增) / [`04`](../04-events.md#l5-语法速查本篇新增) / [`05`](../05-scope.md#l5-语法速查本篇新增) / [`06`](../06-loader.md#l5-语法速查本篇新增) / [`07`](../07-session.md#l5-语法速查本篇新增) 里。

| 语法 | 例子 | 含义 | 注意 |
|---|---|---|---|
| **`AbortSignal.any`** | `AbortSignal.any([a, b])` | 任一触发即触发 | ES2024，Node 20+ |
| `signal?.aborted === true` | 取消检查 | **严格等于 true** | 不用 truthy 判断 |
| **`x !== undefined`** | 区分"没有值"和"空值" | **空串是合法值** | 不能用 `if (x)` |
| `private` 方法 `#step` | `async #step()` | 真私有 | |
| 返回 `T \| undefined` | `Promise<string \| undefined>` | 两种含义的返回 | |

### 本篇新增的两条规则

**规则 23：区分"没有值"和"空值"时，必须用 `=== undefined`**

```ts
// ❌ 空串会被当成"没有值"
if (finalText) { … }

// ✅
if (finalText !== undefined) { … }
```

**规则 24：`AbortSignal.any` 用于合并多个中止来源**

```ts
const combined = AbortSignal.any([AbortSignal.timeout(ms), userSignal])
```

**它让"超时"和"用户取消"共用一个信号。**

---

## L6 关文档重写判据

### 必须能写出的部分

| 难度 | 要写的东西 | 通过标准 |
|---|---|---|
| ★ | `AgentOptions` / `TurnResult` | 字段完整 |
| ★★ | `run()` 的骨架 | **三种结束 + 异常，四条路径都闭合 turn** |
| ★★ | `run()` 的取消分支 | **`steps: step - 1`** |
| ★★★ | `#step()` 的六步 | 派生 → 校验 → 请求 → 落盘 → 判断 → 执行 |
| ★★★ | 工具执行循环 | **每个 call 都产生 result** |
| ★★ | 五个私有字段 | **没有 `#messages`** |

### 卡住时的自检问题

| 卡在哪 | 问自己 |
|---|---|
| 状态放哪 | "如果我在内存里也存一份消息数组，会怎样？" |
| 什么时候收工 | "模型不要求调用工具，还可能是别的情况吗？" |
| 取消的 steps | "取消时这一步执行了吗？" |
| 配对 | "如果 execute 抛异常，配对还成立吗？" |
| 异常路径 | "抛错时 turn 闭合了吗？" |
| `endStep` | "有几种返回路径？每种都调了吗？" |

### 分级判定

| 程度 | 判定 |
|---|---|
| 能写出 ★★ 及以下 | 不够 L3，重读 3.4 |
| 能写出 ★★★ 但漏了工具循环的"每调用必结果" | 回去想"配对规则怎么保证" |
| 全部写出 | ✅ **达标** |

---

## L7 挑战题（不给答案）

### 挑战 1 · 让取消能中断工具执行

**当前缺陷**（L9 缺陷 2）：取消检查只在每步开头，**工具执行循环不检查**。

**要求**：

1. 在工具循环里检查 `signal?.aborted`
2. **取消后仍要为剩余调用写结果**（否则配对破了）
3. 结果内容类似 `'（任务被取消，未执行）'`，`isError: true`

**思考**：为什么"取消后仍要写结果"？**不写会怎样？**

### 挑战 2 · 空响应应该算失败

**当前缺陷**（L9 缺陷 1）：`content === ''` 且没有工具调用时，我们**当作"成功收工"**。

**要求**：

1. 改成抛 `LLMError('EMPTY_RESPONSE', ...)`
2. 验证 turn 被闭合为 `'error'`
3. **思考**：抛异常 vs 返回一个特殊的 `status`，哪个更好？

### 挑战 3 · 并发执行互不干扰的工具

**当前是顺序执行。** 要支持并发，需要知道"哪些工具能并行"。

**要求**：

1. 给 `Tool` 加一个 `parallelSafe?: boolean` 字段
2. 在循环里：**连续的 `parallelSafe` 调用打包并发**，遇到不安全的作为屏障
3. 演示：三个 `echo` 并发，一个 `write` 强制屏障

**思考**：并发的返回值顺序怎么保证？（提示：`toolCalls` 的顺序 vs `execute` 的完成顺序）

### 挑战 4 · 让超步数时返回最后一条文本

**当前缺陷**（L9 缺陷 3）：`max-steps` 时 `text` 是空串，**但模型其实说过很多话**。

**要求**：

1. 让 `run()` 在超步数时返回**最后一条 assistant 消息的 `content`**
2. **思考**：这个"最后一条"从哪里取？（提示：从日志找最后一条 `assistant/message`）
3. 这算是"改状态"还是"读状态"？

### 挑战 5 · 让循环支持"中断并续跑"

**场景**：一个任务跑到第 10 步被取消了，用户想"从第 10 步继续"。

**要求**：

1. 设计一个 `resume()`：从已有会话继续跑
2. **思考**：需要什么信息？（提示：`turn/end.reason` 是 `cancelled` 还是 `max-steps`）
3. 续跑时应该开新 turn 还是复用旧 turn？**日志上有什么差别？**

**这道题直接对应第 11 步的 `--resume`。**

---

## L8 自检清单

### 理解层（L1）

- [ ] 我能画出循环的形状（伪代码级）
- [ ] ★ **我能解释"唯一状态是日志"以及它消灭了什么**
- [ ] ★ **我能解释"配对为什么是结构上保证的"**（提示：第 2 步的哪个设计）
- [ ] 我能说出三种结束路径和四种闭合
- [ ] 我能解释"先落盘再决策"
- [ ] 我能说出"为什么超限不是错误"
- [ ] 我能说出"顺序 vs 并发"的取舍依据

### 实现层（L3）

- [ ] 我关掉文档写出了 `run()` 的骨架
- [ ] 我写出了取消分支的 `steps: step - 1`
- [ ] 我写出了 `#step()` 的六步
- [ ] 我写出了工具执行循环（每调用必结果）
- [ ] 我能解释"为什么五个字段里没有 `#messages`"

### 语法层

- [ ] 我会用 `AbortSignal.any`
- [ ] 我知道区分"没有值/空值"要用 `!== undefined`

### 系统层（L4）

- [ ] **我能说出这一步反哺了第 1 步的哪两处**
- [ ] 我能说出 `TurnResult.status` 怎么用于统计
- [ ] 我能说出"步"和"工具调用"的区别

---

## L9 仍未解决

### 会被后续步骤解决的

| 遗留问题 | 哪一步 |
|---|---|
| 没有全局作用点去调 `agent.run()` | 第 11 步 |
| 请求失败没有重试 | 第 9 步 |
| 工具执行没有超时/审批 | 第 10 步 |
| agent 还不是插件（手工注入依赖） | 第 11 步之后 |

### 当前实现的真实缺陷

#### 缺陷 1 · 空响应被当作"成功收工" ★

```ts
if (response.toolCalls.length === 0) {
  this.#session.endStep(step)
  return response.content      // ← content 可能是空串
}
```

**问题**：模型返回空响应时，我们返回 `status: 'complete', text: ''`。

**后果**：

| 使用方 | 会怎么理解 |
|---|---|
| 用户 | "模型什么都没说" |
| **统计** | **算作"成功完成"** |
| 评测 | **可能算通过**（如果没有额外校验） |

**而实际上这是一个失败** —— 模型既没回答也没调工具。

**为什么没拦**：第 1 步的 `parseCompletion` 只在"没有 `choices`"时抛 `EMPTY_RESPONSE`；**choices 存在但 message 为空时不抛**。

**修法**：见挑战题 2。

#### 缺陷 2 · 取消不中断工具执行 ★

```ts
for (const call of response.toolCalls) {
  this.#session.recordToolCall(call.id, call.name)
  const result = await this.#tools.execute(...)      // ← 不看 signal
  this.#session.recordToolResult(...)
}
```

**问题**：**取消检查只在循环开头** —— 一次工具执行到一半取消，**剩下的工具仍会全部执行完**。

**后果**：

| 场景 | 后果 |
|---|---|
| 用户想停 | 要等当前这一步的所有工具跑完 |
| 有副作用的工具 | **取消后仍在改文件** |
| 科研的时间预算 | 不准确 |

**修法**：见挑战题 1。

**注意**：修的时候**必须仍为每个调用写结果**（否则配对破了）—— **这是"配对优先于取消"的体现。**

#### 缺陷 3 · `max-steps` 时不返回已有文本

```ts
this.#session.endTurn(turn, 'max-steps')
return { status: 'max-steps', steps: this.#maxSteps, text: '' }
```

**问题**：跑到上限时，**模型可能已经说了很多有用的东西**（分散在前面的 assistant 消息里），但我们返回空串。

**后果**：使用者拿不到任何输出。

**修法**：从日志取最后一条 `assistant/message` 的 `content`。

**为什么没做**：**返回值的语义会变复杂**（`text` 在不同 status 下含义不同）。

**但"拿不到输出"是更差的体验。**

#### 缺陷 4 · `catch` 里不闭合 `step`

```ts
} catch (error) {
  this.#session.endTurn(turn, 'error')      // ← 只闭合 turn
  throw error
}
```

**问题**：如果 `#step()` 中途抛错，**它的 `step/start` 没有配对的 `step/end`**。

**后果**：

| 使用方 | 影响 |
|---|---|
| `computeStats` | ✅ **无影响**（它数 `step/end`） |
| 日志完整性检查 | ❌ **会发现不匹配** |
| 人工读日志 | ⚠️ 会困惑 |

**有趣的是**：**它不影响统计** —— 因为统计数的是 `step/end`，而多出来的 `step/start` 不被计数。

**这引出一个更深的观察**：

> **同一份数据，不同的使用方式对"完整性"的要求不同。**
> **统计只关心"数得对"，而审计关心"每件事都有始有终"。**

**修法**：`#step()` 内部 try/catch 并闭合 step。

#### 缺陷 5 · 两个 step 计数器可能错位

```ts
for (let step = 1; step <= this.#maxSteps; step += 1) {     // ① 循环计数
  // …
  const step = this.#session.startStep()                     // ② session 分配的编号
```

**两处都在维护"第几步"。**

**正常情况下它们一致**（都从 1 开始、都每次 +1）。

**但如果有路径只递增一个**（比如某种早退），就会错位 —— **而错位不会被发现。**

**修法**：让 `#step()` 返回它分配的编号，循环用它。

**为什么这么写**：**两个需求不同** —— 循环要"判断边界"，`#step` 要"记录编号"。

**但"两个计数器恰好一致"是一种脆弱的设计。**

#### 缺陷 6 · `#step()` 的返回值语义有点绕

```ts
async #step(signal?: AbortSignal): Promise<string | undefined>
```

**`string` = 收工；`undefined` = 继续。**

**问题**：**"返回一个值是收工信号"这个约定不明显** —— 读者要记住它。

**更清晰的写法**：

```ts
type StepOutcome =
  | { kind: 'continue' }
  | { kind: 'done'; text: string }

async #step(signal?: AbortSignal): Promise<StepOutcome>
```

**代价**：多一个类型、多一层解构。
**收益**：**调用处一眼看出有三种情况**（实际上只有两种，但可扩展）。

**这是"用类型表达意图"vs"用约定表达意图"的取舍。**

**我们选了约定**（因为只有两种状态）—— **但这是个可以在评审时争论的点。**

---

## L10 提问训练

### 本篇引出的 12 个好问题

**关于设计（L3 层）**

1. 为什么循环不维护内存消息数组？代价是什么？
2. 为什么"先落盘再决策"？反过来会怎样？
3. 为什么取消检查放在每步开头，而不是每次 await 后？
4. 为什么"超步数"要单独一个状态，而不是归到 error？
5. 为什么两个 step 计数器分别维护？

**关于系统（L4 层）**

6. **第 9 步的重试应该插在哪个位置？**（提示：`provider.chat` 抛错的地方）
7. **第 10 步的审批应该插在哪？**（提示：`tools.execute` 周围）
8. **如果 agent 变成插件（第 11 步之后），它的依赖怎么注入？**
9. **并发执行工具需要什么元数据？** 那些元数据从哪来？

**关于科研（L5 层）**

10. ★ **`steps` 和"工具调用次数"是两个指标 —— 报告时该怎么用？**
11. ★ **`max-steps` 的数量本身就是一个指标**（"有多少题撞到上限"）—— 它能说明什么？
12. ★ **如果要做"干预 vs 自我修正"实验，干预应该插在这个循环的哪一步？**

### 问题升级练习

| 模糊问题 | 精确问题 | 提升在哪 |
|---|---|---|
| "为什么要配对？" | "如果 assistant 有 3 个 tool_calls 而只有 2 条 tool 消息，**服务端会返回什么？我们的实现为什么不可能出现这种情况？**" | 要求**指出结论的依据** |
| "取消怎么做的？" | "取消检查在每步开头 —— **如果工具执行到一半取消，会发生什么？**" | 指出**实现的边界** |
| "步数怎么算的？" | "一个 step 里调 5 个工具，还算 1 步吗？**这会不会让'平均步数'失真？**" | 指向**指标的定义问题** |

> ### 你的练习
>
> 挑一个改写，发给我：
>
> 1. "循环是怎么工作的？"
> 2. "为什么要有步数上限？"
> 3. ★ **"我要统计'干预后被纠正的比例'，这个循环里该在哪里埋点？"**

---

## L11 系统影响回溯

### 11.1 三个预判的检验

| 第 0.5 节的问题 | 现在你应该能答的 |
|---|---|
| 缓存派生结果需要什么机制？ | 需要在**日志变化时**失效 —— 而日志只在 `append` 时变。**所以可以做"版本号 + 惰性重算"**，但要小心"工具在循环里改了会话"这种跨边界情况 |
| `max-steps` 没有最终文本合理吗？ | **不合理**（见缺陷 3）。应该从日志取最后一条 assistant 的 content |
| 取消检查放 `await` 之后会怎样？ | **粒度更细**（每次网络往返后都查），但**"取消时走了几步"会难以定义**（是"完成了的步"还是"尝试过的步"？） |

**第 3 个问题值得展开**：

**我们选"每步开头检查"，是为了让 `steps` 有一个清晰的定义**：

> **`steps` = 完整走完的步数。**

**如果放在 `await` 之后**，那"当前这一步"算不算完成？**边界就模糊了。**

**这是"粒度粗反而语义清晰"的例子。**

### 11.2 本篇的"锚点"一句话

> **循环自己不持有状态 —— 它只做"派生、请求、记录"三件事的编排。**

它在后面的影子：

| 哪一步 | 同一思想的再现 |
|---|---|
| 第 9 步 | 重试不修改状态，只是**再走一次失败的步骤** |
| 第 10 步 | 守卫不改工具实现，只在周围**加一层检查** |
| 第 11 步 | CLI 不持有状态，只调 `run()` 然后读日志 |
| 第 15 步 | 诊断不修改日志，只**从日志算结论** |
| 第 16 步 | 演化不改进程状态，只**改配置再跑一次** |

**"不持有状态"是贯穿整个系统的原则** —— 而第 8 步是它最集中的体现。

### 11.3 通向第 9 步的桥

**第 8 步结束时，系统状态：**

```
✅ 能跑任务了 —— 循环驱动一切
✅ 每次请求都校验不变量
✅ 三种结束路径 + 四种闭合
❌ 但请求失败就直接抛 —— 没有重试
❌ 一次 429 就让整个任务失败
```

**第 9 步要解决"失败恢复"。** 带着这些问题进入：

1. **重试应该插在哪？** 在 `#step()` 里 try/catch？还是包一层？
2. **重试要"回到失败前"，还是"从当前继续"？** 两者的区别是什么？
3. ★ **第 1 步的 `LLMErrorCode` 在这里终于要被用到了** —— 哪些 code 该重试？
4. **如果第 3 步成功、第 5 步失败，重试应该重跑第 5 步还是从头？**
5. **重试的日志长什么样？** 失败的那次要不要记？（提示：第 7 步的 `assistant/attempt` 概念）

**第 5 个问题很关键** —— 因为**"失败的尝试"也是一种事实**，而我们目前的选择是"不记"（因为它不是表面事件）。

**第 9 步要决定：失败的尝试该不该进日志？**

**DSH 的答案是"要"**（它有专门的 `assistant/attempt` 事件，记录"settled failed, retried, cancelled, and stream-error attempts"）。

> **而"不记"的代价是：你无法从日志回答"这道题重试了几次"。**
> **—— 而那正是你的科研要的数据。**

---

## 本篇完结

| 检查项 | 应该达到 |
|---|---|
| 能画出循环的形状 | L1 |
| **能解释"唯一状态是日志"** | L1 |
| **能解释"配对为什么是结构上保证的"** | L1 |
| **能关掉文档写出 `run()` 的骨架** | **L3** |
| 能说出四种闭合 | L3 |
| 能说出这一步反哺了第 1 步的哪两处 | L4 |
| 能提出至少 3 个 L4/L5 层的问题 | L4 |

---

**读完这篇，请回答我三个问题：**

1. **"先落盘再决策"** 这个原则 —— 你能想到它在别的地方的应用吗？（不限于本课程）

2. **缺陷 2**（取消不中断工具执行）：修的时候"仍要为每个调用写结果" —— **这个要求会不会让"取消"变得不那么及时？** 你怎么权衡？

3. **下一站**：`09-retry.md`（重试），还是先补那三份系统分析文档的深度（克隆源码）？

**我建议继续 `09-retry.md`** —— 因为它是**第一个"插在循环上的插件"**，而那个"怎么插"的模式会在第 10、15、16 步反复用到。
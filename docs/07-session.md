# 第 7 步 · 会话日志（唯一真相）

> **代码**：`src/kernel/session.ts`（约 380 行） · **演示**：`src/demos/demo-session.ts`
> **DSH 对应**：`packages/core/session/src/`（`ctx.sessions`）
> **本篇目标级别**：L3（关掉文档能从零重写）
> **预计阅读**：100–140 分钟 · **预计动手**：120 分钟

---

## 本篇新词

> 全部术语在 [`glossary.md`](glossary.md)。先花 90 秒扫一遍。

| 词 | 一句话 | 为什么必须懂 |
|---|---|---|
| **session（会话）** | 一次交互的完整记录，有 id、可持久化 | 进程退出后还能回答"当时发生了什么" |
| **session log（会话日志）** | 按发生顺序记下全部事实的事件流 | ★ **它是唯一真相（single source of truth）** ★ |
| **append-only（只追加）** | 只允许往末尾加，不许改、不许删 | 日志能当审计依据的前提 |
| **event（事件）** | 日志里的一条记录，带 `seq` 和 `time` | 日志的基本单位 |
| **derive（派生）** | 从日志**算出**某个东西 | 消息是算出来的，不是另存一份 |
| **surface event（表面事件）** | 会在模型历史里留下痕迹的事件 | 派生的唯一输入 |
| **process event（过程事件）** | 只用于记账的事件（turn/step） | 派生时被忽略 |
| **seq（序号）** | 事件的连续编号，从 0 开始不跳号 | 用于校验日志完整性 |
| **JSONL** | 每行一个 JSON 的文件格式 | 天然支持"一行行追加" |
| **不变量（invariant）** | 任何时候都必须成立的条件 | 可以用运行时断言强制 |

---

## 第 0 节 · 这一步的成品长什么样

### 0.1 你会写出什么

```
┌────────────────────────────────────────────────────────────────────┐
│  session.ts（约 380 行）                                            │
│                                                                    │
│  一、事件词汇表                                                     │
│    ① SessionEventMap    8 种事件 → payload 类型（可扩展）            │
│    ② SURFACE_EVENT_TYPES ★ 哪些是表面事件（核心）                    │
│                                                                    │
│  二、事件封装                                                       │
│    ③ SessionEvent       seq + time + type + data                   │
│                                                                    │
│  三、Session 类                                                     │
│    ④ append()           唯一的写入口（只追加）                       │
│    ⑤ startTurn / endTurn / startStep / endStep  过程事件小助手       │
│    ⑥ recordUser / recordAssistant / recordToolCall / recordToolResult │
│    ⑦ deriveMessages()   从日志派生消息                              │
│    ⑧ stats()            统计（步数 / token / 工具调用）              │
│    ⑨ save() / load()    JSONL 持久化 + **未闭合 turn 修复**          │
│                                                                    │
│  四、派生函数（独立于类，可单独测试）                                 │
│    ⑩ deriveMessages(events)   ★ 纯函数                              │
│                                                                    │
│  五、统计                                                           │
│    ⑪ computeStats(events)     ★ 纯函数                              │
│                                                                    │
│  六、不变量                                                         │
│    ⑫ assertModelVisibleMatchesLog()  ★ 运行时断言                   │
└────────────────────────────────────────────────────────────────────┘
```

### 0.2 运行起来是什么样

```powershell
node src/demos/demo-session.ts
```

关键输出：

```
--- 事件流（注意 seq 只增不跳）---
[ "0 turn/start", "1 user/message", "2 step/start", "3 assistant/message",
  "4 tool/call", "5 tool/result", "6 step/end", "7 step/start",
  "8 assistant/message", "9 step/end", "10 turn/end" ]

--- 对比 ---
{ "事件总数": 11, "消息总数": 4,
  "差值说明": "差的就是过程事件 —— 它们只用于记账" }

--- 这次任务的统计 ---
{ "turns": 1, "steps": 2, "toolCalls": 1, "toolErrors": 0, "tokens": 360, "messages": 4 }

--- 篡改被抓出来 ---
Model-visible 与日志不一致：第 0 条（role=user）内容不同
日志：帮我看看 src/kernel/llm.ts 有多少行
实际：（被偷偷改过的内容）
```

**第二段是本篇的核心**：**11 个事件，只有 4 条消息** —— 差的 7 个就是"过程事件"。

**最后一段是"不变量"的价值**：有人绕过日志改了消息，**当场被抓出来**。

---

## 第 0.5 节 · 系统视角

### 你在哪里

```
                    ★ 能力层 ★
        ┌──────────────┬──────────────┬──────────────┐
        │ 第 8 步       │ 第 9 步       │ 第 10 步      │
        │ agent 循环    │ 重试          │ 校验 / 审批   │
        └──────┬───────┴──────┬───────┴──────┬───────┘
               │              │              │
               └──────────────┼──────────────┘
                              │ 全部建立在会话日志上
                    ┌─────────┴─────────┐
                    │ 【第 7 步】        │
                    │ 会话日志           │
                    │ ▶ 你在这里 ◀        │
                    └─────────┬─────────┘
                              │ 用第 1 步的消息类型
                              ▼
                        第 1 步 · 模型层
```

**第 7 步是 Phase 2 的地基。** 循环、重试、校验、诊断 —— **全都建立在它上面**。

### 下游：谁在用会话日志

| 第 7 步的产物 | 谁消费 | 用来做什么 | 依赖强度 |
|---|---|---|---|
| `Session` 类 | 第 8 步的循环 | 记录每一步、派生请求 | 🔴 极强 |
| `deriveMessages()` | 第 8 步的循环 | **构造发给模型的请求** | 🔴 极强 |
| `assertModelVisibleMatchesLog()` | 第 8 步的循环 | 每次请求前校验不变量 | 🔴 强 |
| `SessionEvent` 格式 | 第 9 步重试、第 15 步诊断 | 回溯"失败发生在哪一步" | 🔴 强 |
| `stats()` | **你的科研台账** | **平均步数、token 消耗、工具调用次数** | 🔴 强 |
| `save()` / `load()` | 第 11 步 CLI 的 `--resume` | 会话持久化 | 🔴 强 |

**注意第五行** —— 它是**整门课里与你科研对接最直接的一处**：

> **导师问的"这道题平均花多少步"，答案就是 `stats().steps` 的均值。**
> **"token 消耗多少"，答案是 `stats().tokens`。**
> **"干预触发了几次"，只要干预机制往日志里记一条事件，答案也在里面。**

### 连锁影响分析

#### 连锁 1：如果不区分"表面事件"和"过程事件"

```
所有事件都参与派生消息
   ↓
turn/start、step/start 这些也变成消息发给模型
   ↓
★ 模型看到一堆它无法理解的"格式标记" ★
   ↓
更糟：tool/call 和 assistant/message 里有重复信息
   ↓
★ 消息内容与模型的预期格式不符，行为退化 ★
```

**正确的做法是"派生时过滤"**，而过滤的依据就是 `SURFACE_EVENT_TYPES`：

```ts
const SURFACE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'user/message', 'assistant/message', 'tool/result',
])
```

**为什么 `tool/call` 不是表面事件？**

因为**它携带的信息已经在 `assistant/message.toolCalls` 里了**。

```
assistant/message: { content: '', toolCalls: [{ id: 'call_1', name: 'read_file', ... }] }
tool/call:         { toolCallId: 'call_1', name: 'read_file' }      ← 重复信息
```

**`tool/call` 存在的理由不是"给模型看"，而是"给记账用"** —— 它让"工具调用次数"可以直接数事件，不用解析 `assistant/message` 的嵌套结构。

> **同一个事实可以记两次，但只有一份是"给模型看的"。**

#### 连锁 2：如果日志可以被修改

```
某个 bug 让"重试"逻辑改写了历史事件
   ↓
① 审计失效 —— 你无法知道"当时到底发生了什么"
② 派生结果随修改而变 —— 同一份日志两次读取可能不同
③ 第 9 步的重试无法安全进行 —— 它依赖"日志是不可变的过去"
   ↓
★ 「唯一真相」这个定位彻底失效 ★
```

**所以我们只提供 `append()`，没有 `update()` / `delete()`。**

**这不是"忘了写"，而是"有意不提供"** —— 因为**提供了就会被用**。

**DSH 的对应**：它的会话日志是不可变的，而且有 `invariant` 包专门校验日志的关系不变式（比如"每个 tool/result 必须有配对的 assistant/message.toolCalls"）。

#### 连锁 3：如果不修复"未闭合的 turn"

```
进程在 turn 中间崩了
   ↓
日志的最后是 turn/start 而没有 turn/end
   ↓
下次加载这份日志
   ↓
★ 统计时 turns 少 1（因为计数靠 turn/end）★
★ 而且"这个 turn 是完整的吗"无法回答 ★
```

**演示 5 验证了修复**：

```
--- 崩之前的最后一条事件 ---                  user/message
--- 读回后的最后一条事件（应被补成 turn/end）---  { "type": "turn/end", "data": { "turn": 1, "reason": "error" } }
--- 修复后的统计（turns 应该是 1）---          { "turns": 1, ... }
```

**注意补的 `reason` 是 `'error'`** —— 因为**崩溃不是正常完成**。

**这个 `reason` 字段很重要**：第 15 步的诊断要区分"正常结束"和"崩溃结束"，而**`reason` 就是依据**。

### 现在该建立的三个习惯

| 习惯 | 做法 | 训练什么 |
|---|---|---|
| **区分"事实"和"派生"** | 只存事实，其余都算出来 | 消除不一致的根源 |
| **不可变的数据要"不提供修改接口"** | 不是靠约定，是靠 API 设计 | 用设计约束行为 |
| **崩溃恢复要显式处理** | 给"未完成的东西"补一个明确的结束 | 状态机的完备性 |

> ### 停下来想一想（不给答案）
>
> 1. `tool/call` 的信息在 `assistant/message` 里已经有了。**为什么还要单独记一条？** 如果不记会怎样？
> 2. 演示 1 里事件总数 11、消息总数 4。**如果再加一个 `step/start`，这两个数字各变成几？**
> 3. **如果日志要支持"从第 3 条事件之后重新开始"（fork），数据结构上要做什么？**

---

## L0 要解决的问题

### 0.1 第 6 步留下的具体缺陷：**没有记忆**

到第 6 步，插件能装载、能配置、能隔离 —— 但**跑一次任务，过程只存在于内存里**。

**三个具体现象：**

| 现象 | 后果 |
|---|---|
| 进程一退，什么都不知道了 | 无法回答"上次这个配置跑出过什么问题" |
| 步数、token 没有被计数 | **你的台账没有任何数据来源** |
| "模型看到的历史"是内存里的数组 | 它是**唯一副本** —— 一旦哪里改错，无从对照 |

### 0.2 第三条最隐蔽，也最重要

**内存里的消息数组，是"唯一副本"。**

```
某处代码：messages.push({ role: 'tool', content: '...' })     // 忘了带 toolCallId
   ↓
没有任何地方能发现这个错误
   ↓
直到模型返回 400，你才知道"消息格式不对"
   ↓
但你不知道是哪一步、哪一段代码加错了
```

**如果有日志**：

```
日志：tool/result { toolCallId: 'call_1', ... }        ← 事实里有 toolCallId
派生：{ role: 'tool', content: '...', toolCallId: 'call_1' }
对比：实际消息里没有 toolCallId
   ↓
★ 立刻定位："有代码绕过日志直接改消息" ★
```

**这就是 `assertModelVisibleMatchesLog` 的价值** —— 它把"内存数据是唯一副本"变成了"日志是唯一副本，内存数据必须与它一致"。

### 0.3 这一步要回答的四个问题

| # | 问题 | 本篇位置 |
|---|---|---|
| 1 | 记什么？（事件粒度） | 事件词汇表（1.2） |
| 2 | "模型看到的历史"和"日志"是两份数据吗？ | **不变量（1.1）** |
| 3 | 怎么保证日志是可信的？ | append-only（1.3） |
| 4 | **"平均完成步数"从哪来？** | **统计（1.6）** |

**第 2 个问题是全篇的核心。**

---

## L1 设计与原理

### 1.1 ★ 核心不变量：Model-visible ⟺ logged ★

**这一条是全篇、乃至整个 DSH 里最有价值的设计思想。**

> **凡是模型能看到的，必须能从日志重建。**

#### 反例：两份独立维护的数据

**最直觉的做法**：

```ts
class Agent {
  messages: ChatMessage[] = []       // ← 发给模型的

  async run(task: string) {
    this.messages.push({ role: 'user', content: task })
    const res = await this.llm.chat(this.messages)

    // 同时往日志里记一份
    this.log.append({ type: 'user/message', data: { text: task } })
    this.log.append({ type: 'assistant/message', data: { content: res.content } })

    this.messages.push({ role: 'assistant', content: res.content })
    // ...
  }
}
```

**问题**：**两份数据，两个写入点。**

任何一次"只写了一边"或"两边内容不同"，都会造成不可发现的不一致。

```
某次改动：给 messages 加了一条系统提示，但忘了记日志
   ↓
模型看到了它，但日志里没有
   ↓
★ 你永远无法从日志复现那次请求 ★
★ 而"能复现"恰恰是科研的基本要求 ★
```

#### 正解：一份数据，其余算出来

```ts
class Agent {
  // ★ 没有 messages 字段

  async run(task: string) {
    this.session.recordUser(task)                       // 只写日志
    const messages = this.session.deriveMessages()      // ★ 从日志算出来
    const res = await this.llm.chat(messages, ...)
    this.session.recordAssistant(res.content, res.toolCalls, res.usage)
  }
}
```

**效果**：

| | 两份数据 | 一份数据 + 派生 |
|---|---|---|
| 写入点 | 2 个 | **1 个** |
| 不一致的可能 | **有** | **结构上不可能** |
| 复现能力 | 靠自觉 | **天然保证** |
| 代码量 | 更多 | 更少 |

**"结构上不可能"这个词是关键** —— 不是"我们小心一点就不会错"，而是**"这个错误无法被写出来"**。

#### 为什么这条不变量对科研尤其重要

**你的论文需要"可复现"。** 而可复现的前提是**能重建当时的确切输入**。

```
两份数据的情况：
  "我们复现了实验，但模型看到的提示词和论文里写的不完全一样"
  ★ 这是个致命问题 ★

一份数据的情况：
  日志 → 派生 → 请求，三步都是确定性的
  ★ 任何人都能从日志重建出完全相同的请求 ★
```

**DSH 把这条写成了仓库级的强制规范**：

> 「**Model-visible ⟺ logged**: anything that reaches a model request must be reconstructable from the session log; a new model-visible input requires a session event.」

**并且有一个运行时不变式包专门校验它**（`packages/core/agent-loop/src/invariant.ts`）。

#### 一个副作用：什么该进日志变得很清楚

**判断标准**：

> **"这个东西会进模型请求吗？"
> 会 → 必须有一条会话事件。
> 不会 → 不需要（比如工具调用的耗时统计）。**

**这条标准让"该不该记"不再需要讨论。**

### 1.2 表面事件 vs 过程事件

**日志里有两种事件：**

| 类型 | 会在模型历史里留下痕迹吗 | 例子 |
|---|---|---|
| **表面事件（surface）** | ✅ 会 | `user/message`、`assistant/message`、`tool/result` |
| **过程事件（process）** | ❌ 不会 | `turn/start`、`turn/end`、`step/start`、`step/end`、`tool/call` |

**派生时只读表面事件**：

```ts
export function deriveMessages(events: readonly SessionEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const event of events) {
    if (!SURFACE_EVENT_TYPES.has(event.type)) continue     // ★ 关键的一行
    // ... 转换
  }
  return messages
}
```

**演示 2 验证了它**：

```
事件总数: 11
消息总数: 4      ← 只有表面事件产生了消息
```

**这 7 个"被忽略"的事件各自在做什么？**

| 事件 | 为什么记它 |
|---|---|
| `turn/start` / `turn/end` | 界定任务边界；`turn/end.reason` 说明怎么结束的 |
| `step/start` / `step/end` | **数"这道题花了多少步"** |
| `tool/call` | **数"工具被调用了多少次"**（不用解析嵌套结构） |

**它们全是"给记账用的"** —— 而这正是你的台账需要的。

### 1.3 append-only：为什么只提供 `append()`

```ts
append<K extends SessionEventType>(type: K, data: SessionEventMap[K]): SessionEvent {
  const event: SessionEvent = {
    seq: this.#events.length,      // ← 序号 = 当前长度，天然连续
    time: Date.now(),
    type,
    data,
  }
  this.#events.push(event)         // ← 只有 push，没有别的
  return event
}
```

**`seq: this.#events.length`** —— 这个写法保证：

| 保证 | 说明 |
|---|---|
| 从 0 开始 | 第一条的 `length` 是 0 |
| 连续不跳号 | 因为每次只 `+1` |
| 【可用于校验】 | 读回来的日志，`seq` 必须等于下标 |

**"只提供 append"是设计，不是遗漏**：

> **提供了 `update()` / `delete()`，就一定会被用。**
> **而一旦历史可改，"唯一真相"这个定位就失效了。**

**DSH 的对应**：会话日志的物理文件是**提交后永不修改**的（连压缩和迁移都写新文件）。

**代价**：日志会一直增长。**换来**：可审计、可复现。

（第 10 步会解决"日志太长"的问题 —— 但那是**压缩派生结果**，不是删日志。）

### 1.4 派生是纯函数（为什么这一点很重要）

```ts
export function deriveMessages(events: readonly SessionEvent[]): ChatMessage[] {
  // 输入：事件流。输出：消息数组。没有别的依赖。
}
```

**它是纯函数** —— 同样的输入永远给同样的输出，不碰文件、不碰时间、不碰全局状态。

**带来的三个好处**：

| 好处 | 说明 |
|---|---|
| **可单独测试** | 构造一组事件，断言派生的消息 —— **不需要真的跑 agent** |
| **可回放** | 拿到一份日志，就能重建当时的请求 |
| **可对比** | 两个版本的派生逻辑，跑同一份日志，看差异 |

**第三条对你的科研特别有用**：

> **"如果我改了消息拼装逻辑，之前的实验结果还会一样吗？"**
> —— 拿旧日志跑新逻辑，对比输出即可。

**注意 `Session` 类里也包装了一个 `deriveMessages()` 方法**：

```ts
deriveMessages(): ChatMessage[] {
  return deriveMessages(this.#events)
}
```

**这是"类方法转发到纯函数"的模式** —— 类提供便利，纯函数提供可测试性。

### 1.5 未闭合 turn 的修复

```ts
// 修复未闭合的 turn
const lastTurnStart = [...session.#events].reverse().find((event) => event.type === 'turn/start')
if (lastTurnStart !== undefined) {
  const turn = readNumber(lastTurnStart, 'turn')
  const ended = session.#events.some(
    (event) => event.type === 'turn/end' && readNumber(event, 'turn') === turn,
  )
  if (!ended) session.endTurn(turn, 'error')
}
```

#### 逐部分

```ts
[...session.#events].reverse().find((event) => event.type === 'turn/start')
```

**从后往前找最后一个 `turn/start`。**

- `[...]` 复制（`reverse` 会改原数组）
- `.reverse()` 反转
- `.find()` 找第一个满足条件的 —— **反转后的第一个 = 原数组的最后一个**

**为什么不直接取 `events[events.length - 1]`？**

因为**中间可能已经有过别的 turn**：

```
turn/start(1) ... turn/end(1) ... turn/start(2) ... user/message
                                   ↑ 这才是要找的
```

#### 检查是否已结束

```ts
const ended = session.#events.some(
  (event) => event.type === 'turn/end' && readNumber(event, 'turn') === turn,
)
```

**注意 `readNumber(event, 'turn') === turn` 这个条件** —— 它匹配的是**同一个 turn 编号的结束事件**。

**为什么不能只判"有没有 turn/end"？**

```
turn/start(1) ... turn/end(1) ... turn/start(2) ...
                                   ↑ 有 turn/end，但那是 turn 1 的
```

**只判 `type === 'turn/end'` 会误判成"已结束"。**

#### 为什么补 `reason: 'error'`

```ts
if (!ended) session.endTurn(turn, 'error')
```

**因为崩溃不是正常完成。**

| reason | 什么时候 |
|---|---|
| `'complete'` | 正常跑完 |
| `'cancelled'` | 用户取消 |
| `'error'` | **异常路径**（包括崩溃恢复） |

**这个字段的用途在第 15 步**：诊断要区分"正常结束但结果不对"和"异常中断" —— **它们的归因完全不同**。

#### 这个修复的哲学

> **面对不完整的状态，补一个"明确的结束"，而不是留着它不完整。**

**为什么？**

| 方案 | 后果 |
|---|---|
| 留着不完整的 turn | 每次读日志都要处理"可能不完整"这个情况 |
| **补一个明确的结束** | **读的时候状态总是完整的** |

**这是"把复杂性收敛到一处"的应用** —— 加载时处理一次，之后所有人都不用再管。

### 1.6 ★ 统计：与你科研的直接对接 ★

```ts
export interface SessionStats {
  readonly turns: number
  readonly steps: number        // ← 「平均完成步数」的「步数」
  readonly toolCalls: number
  readonly toolErrors: number
  readonly tokens: number
  readonly messages: number
}
```

**演示 3 的输出**：

```
{ "turns": 1, "steps": 2, "toolCalls": 1, "toolErrors": 0, "tokens": 360, "messages": 4 }
```

#### 这些数字分别回答你导师的哪个问题

| 字段 | 导师的问题 |
|---|---|
| `steps` | **"题目平均完成步数多少？"** |
| `tokens` | "这周消耗了多少？" |
| `toolCalls` | "模型用了多少工具？" |
| `toolErrors` | "失败里有多少是工具错误？" |
| `turns` | "跑了多少次任务？" |

#### 但注意：单次统计 ≠ 平均

```ts
// 单题
const s = singleTask.stats()

// 一批题的"平均完成步数"
const all = tasks.map((t) => t.stats())
const meanSteps = all.reduce((sum, s) => sum + s.steps, 0) / all.length
```

**而这个均值有一个陷阱**（你在工作手册里见过）：

> **失败题的步数可能是"跑满预算"，会把平均值拉高。**
>
> 所以要区分：
> - **全部题的平均步数**（被失败题污染）
> **成功题的平均步数**（才是"能做的题做得多快"）

**实现方式**：从 `turn/end.reason` 判断这道题成功没成功：

```ts
const successful = tasks.filter((t) => {
  const end = t.events.findLast((e) => e.type === 'turn/end')
  return end?.data?.reason === 'complete'
})
```

**而 `reason` 字段正是 1.5 节的那个字段** —— **同一个设计，两处用途。**

（严格说 `reason: 'complete'` 只表示"turn 正常结束"，不等于"任务成功" —— **任务成功与否取决于评测判分**。这里演示的是"怎么从日志里区分"。）

#### 更深的一层：统计函数也是纯函数

```ts
export function computeStats(events: readonly SessionEvent[]): SessionStats
```

**所以它可以对任意一段事件流算统计**：

```ts
computeStats(session.events.slice(0, 50))      // 前 50 个事件的统计
computeStats(session.events.filter(e => e.type === 'tool/call'))   // 只有工具调用
```

**第二行很有意思**：它算的是"工具调用事件"的统计，但因为我们传的是过滤后的数组，`steps` 会是 0。

**这说明 `computeStats` 的语义是"给定事件流，数出里面的东西"** —— 一个纯粹的函数。

> ### 停下来想一想（不给答案）
>
> 1. 如果 `deriveMessages` 是纯函数，**那 `Session.deriveMessages()` 这个包装方法还有必要吗？** 什么时候用哪个？
> 2. 演示 5 里补的 `turn/end` 是 `reason: 'error'`。**如果进程是被用户 Ctrl+C 杀掉的，应该补什么 reason？** 怎么区分？
> 3. **`stats().tokens` 是把所有 `usage` 字段的数字加起来** —— 这样做有什么问题？（提示：`usage` 里可能有 `prompt_tokens` 和 `total_tokens`，后者是前者的和）

---

## L2 决策表

| # | 决策 | 我们的选择 | 替代方案 | 代价落在谁身上 |
|---|---|---|---|---|
| 1 | 数据模型 | **一份日志 + 派生** | 日志和消息各存一份 | 每次请求要重新派生；换来结构性一致 |
| 2 | 事件粒度 | **表面 + 过程两类** | 只记表面事件 | 多记几个事件；换来统计不用解析嵌套 |
| 3 | 写接口 | **只有 `append`** | 提供 update/delete | 无法修改历史；换来可审计 |
| 4 | 序号 | **`seq = length`** | 时间戳 / UUID | 单进程内足够；换来可校验（seq 必须等于下标） |
| 5 | 持久化格式 | **JSONL** | 单个 JSON 数组 | 文件更大（每行都有字段名）；换来可追加、可流式读 |
| 6 | 加载修复 | **补未闭合的 turn** | 留着不管 | 加载时多一步；换来"读到的状态总是完整的" |
| 7 | 派生函数 | **独立纯函数** | 只做类方法 | 多一层转发；换来可测试、可回放 |
| 8 | 统计 | **独立纯函数** | 只做类方法 | 同上 |
| 9 | 不变量检查 | **提供运行时断言** | 只靠约定 | 每次请求多一次比较；换来 bug 立刻暴露 |
| 10 | `tool/call` | **单独记一条** | 只靠 `assistant/message` | 多一条事件；换来统计简单 |

### 关于第 5 条的论证

**为什么 JSONL 而不是"一个 JSON 数组"？**

```jsonl
// JSONL：每行一条
{"seq":0,"time":123,"type":"turn/start","data":{"turn":1}}
{"seq":1,"time":124,"type":"user/message","data":{"text":"你好"}}
```

```json
// JSON 数组：整个文件是一个大数组
[{"seq":0,...},{"seq":1,...}]
```

| 维度 | JSONL | JSON 数组 |
|---|---|---|
| **追加** | ✅ 直接在末尾写一行 | ❌ 要重写整个文件（或在末尾改 `]`） |
| **流式读** | ✅ 一行行处理 | ❌ 要全部解析完 |
| **损坏影响面** | 只坏一行 | **整个文件解析失败** |
| 文件大小 | 更大（每行重复字段名） | 更紧凑 |

**决定性理由是"追加"和"损坏影响面"**：

> **崩溃时，JSONL 通常只有最后一行是坏的；JSON 数组则整个文件都读不了。**

**这对"进程可能随时被杀"的场景至关重要。**

**DSH 用的也是 JSONL**（`session.vN.jsonl[.zstd]`），而且还会 zstd 压缩。

### 关于第 3 条的完整性论证

**"不提供修改接口"会不会带来实际困难？**

**会**。比如：

```
需求：会话标题要能改
   ↓
如果标题存在事件里，就没法改
   ↓
解法：标题是一条**新的事件**（"标题现在改成 X"），而不是修改旧事件
```

**这正是 DSH 的做法** —— 会话标题也是一条事件，后来的覆盖先前的。

**这是"用追加表达修改"的模式**：

| 想做的事 | append-only 的做法 |
|---|---|
| 改标题 | 追加一条"标题变更"事件 |
| 删消息 | 追加一条"消息被撤回"事件（派生时跳过被撤回的） |
| 撤销 | 追加一条"撤销到 seq N"事件 |

**代价**：文件更大、派生逻辑更复杂。
**换来**：历史完整、可审计、可重放。

**这个模式在分布式系统里很常见**（事件溯源 / event sourcing）。

### 关于第 9 条的论证

**运行时断言会不会太慢？**

```ts
assertModelVisibleMatchesLog(session, actual)
```

它做的是：

1. 派生一次消息（O(n)）
2. 逐条比较（O(n)）

**每次请求前多 O(n)** —— 而请求本身是网络调用（几百毫秒到几秒）。

**相比网络开销，这个检查可以忽略。**

**但它的收益很大**：**任何"绕过日志改消息"的代码，会在第一次运行时就被抓住。**

**这是"用极小的固定成本换一类 bug 的消灭"。**

> ### 停下来想一想（不给答案）
>
> 1. 第 4 条说"`seq = length` 在单进程内足够"。**多进程写同一份日志会怎样？**
> 2. 如果按第 3 条的思路，**"删除一条消息"该怎么用追加表达？**
> 3. **不变量检查放在"每次请求前"合适吗？** 有没有更省的位置？

---

---

## L3 实现：逐行讲解

### 3.0 文件结构

```
┌─── 一、事件词汇表（30–75 行）    SessionEventMap + SURFACE_EVENT_TYPES ★
├─── 二、事件封装（80–95 行）      SessionEvent
├─── 三、Session 类（100–230 行）  append / 小助手 / save / load ★
├─── 四、派生（235–290 行）        deriveMessages ★（纯函数）
├─── 五、统计（295–350 行）        computeStats（纯函数）
└─── 六、不变量（355–380 行）      assertModelVisibleMatchesLog ★
```

**这个文件比前几步的都长（380 行），但它有一个清晰的三段式**：

```
记录（append）  →  派生（deriveMessages）  →  校验（assert）
     ↑                    ↑                      ↑
   唯一写入口          纯函数                 运行时断言
```

**三段都是围绕同一个不变量服务的。**

### 3.1 文件头注释（第 1–22 行）

```ts
/**
 * 第 7 步 ｜ 会话日志：唯一真相（single source of truth）
 *
 * 到第 6 步为止，一次任务的过程**只存在于内存里**。进程一退，什么都没了。
 * 更糟的是：即使不退出，你也回答不了这些问题 ——
 *
 *   这次任务为什么失败？          （过程没记下来）
 *   平均每道题花了多少步？        （步数没被计数）
 *   模型当时到底看到了什么？      （历史和请求是两份数据）
 *
 * ── 核心不变量 ────────────────────────────────────────────────────────
 *
 *   ★ Model-visible ⟺ logged ★
 *
 * 「凡是模型能看到的，必须能从日志重建。」
 *
 * 这条不变量一句话消灭了整类 bug：**模型看到的历史，和存下来的日志，
 * 永远不会不一致** —— 因为前者是后者**算出来的**，不是另一份独立维护的数据。
 *
 * 实现它的方式是「表面事件」（surface events）：
 *   日志里有两种事件 ——
 *     表面事件：会在模型历史里留下痕迹（user/message、assistant/message、tool/result）
 *     过程事件：只用于记账（turn/start、step/end、tool/call，…）
 *   deriveMessages() **只读表面事件**，于是消息天然与日志一致。
 */
```

**这段注释的三个层次值得学**：

| 段 | 内容 | 作用 |
|---|---|---|
| 1 | 上一步留下的**三个具体问题**（还都加了括号说明为什么） | **动机** |
| 2 | **核心不变量 + 一句话解释它消灭了什么** | **设计思想** |
| 3 | **实现它的机制**（表面事件） | **怎么做到的** |

**第 1 段的三行括号特别值得注意**：

```
这次任务为什么失败？          （过程没记下来）
平均每道题花了多少步？        （步数没被计数）
模型当时到底看到了什么？      （历史和请求是两份数据）
```

**它把"问题"和"根因"并排放** —— 读者立刻看到"这三个困扰我很久的问题，根源是同一件事"。

**而第三行"历史和请求是两份数据"直接指向了本步的核心设计。**

### 3.2 `SessionEventMap`（第 32–56 行）

```ts
export interface SessionEventMap {
  'turn/start': { turn: number }
  'turn/end': { turn: number; reason: TurnEndReason }
  'step/start': { step: number }
  'step/end': { step: number }
  'user/message': { text: string }
  'assistant/message': { content: string; toolCalls?: readonly ToolCall[]; usage?: LLMUsage }
  'tool/call': { toolCallId: string; name: string }
  'tool/result': { toolCallId: string; name: string; content: string; isError: boolean }
}
```

#### 八种事件的三组

| 组 | 事件 | 作用 |
|---|---|---|
| **边界** | `turn/start` `turn/end` `step/start` `step/end` | 界定范围，用于计数 |
| **对话** | `user/message` `assistant/message` | 表面事件的主要部分 |
| **工具** | `tool/call` `tool/result` | 一个记账、一个表面 |

#### 注意 `assistant/message` 的可选字段

```ts
'assistant/message': { content: string; toolCalls?: readonly ToolCall[]; usage?: LLMUsage }
```

**三个字段只有 `content` 是必填**：

| 字段 | 什么时候有 |
|---|---|
| `content` | 总是有（可能是空串） |
| `toolCalls` | 模型要求调用工具时 |
| `usage` | provider 返回了用量时 |

**注意 `toolCalls` 的 `readonly ToolCall[]`** —— 直接复用第 1 步的类型。

**这是"类型复用"的好处**：`deriveMessages` 可以直接把它塞进 `ChatMessage`，**不需要转换**。

#### 与第 1 步 `ChatMessage` 的对应关系

```
SessionEventMap['user/message']       { text: string }
      ↓ deriveMessages
ChatMessage                           { role: 'user', content: text }

SessionEventMap['assistant/message']  { content, toolCalls?, usage? }
      ↓
ChatMessage                           { role: 'assistant', content, toolCalls? }

SessionEventMap['tool/result']        { toolCallId, name, content, isError }
      ↓
ChatMessage                           { role: 'tool', content, toolCallId, name }
```

**注意 `tool/result` 的 `isError` 字段** —— 它**不进消息**（模型看到的是内容，不是标志）。

**但它在日志里** —— 因为**统计要用它**（`toolErrors` 计数）。

> **同一个事件可以同时服务两个目的**：给模型看的部分（`content`）和给记账用的部分（`isError`）。

### 3.3 `SURFACE_EVENT_TYPES`（第 58–70 行）★ 核心 ★

```ts
export const SURFACE_EVENT_TYPES: ReadonlySet<string> = new Set<SessionEventType>([
  'user/message',
  'assistant/message',
  'tool/result',
])
```

**三行数据，决定了整条不变量能不能成立。**

#### 为什么用 `Set` 而不是数组

```ts
// Set（我们的选择）
SURFACE_EVENT_TYPES.has(event.type)      // O(1)

// 数组
SURFACE_EVENT_TYPES.includes(event.type)  // O(n)
```

**`deriveMessages` 对每个事件都要查一次** —— `Set` 让它是 O(1)。

**这是"热路径用对数据结构"的例子** —— 虽然只有 3 个元素时差距可忽略，**但 `Set` 表达了"这是一个成员判断"的意图**。

#### `ReadonlySet<string>` 的类型标注

```ts
export const SURFACE_EVENT_TYPES: ReadonlySet<string> = new Set<SessionEventType>([...])
//                              ┌─────────────────┐   ┌──────────────────────┐
//                              对外只读的类型        实际是可变 Set（但没别的地方改它）
```

**为什么右边的泛型是 `SessionEventType`（更窄）而左边是 `string`（更宽）？**

因为 **`deriveMessages` 拿到的 `event.type` 是 `string`**（`SessionEvent.type` 声明为 `string`）。

**如果左边也用 `SessionEventType`，`has(event.type)` 就会类型不匹配**：

```ts
SURFACE_EVENT_TYPES.has(event.type)      // event.type 是 string
//                       ↑ Set<SessionEventType>.has 要求 SessionEventType
```

**所以故意放宽成 `string`** —— **这是"为了让消费方好用而放宽导出类型"的取舍**。

**代价**：调用方可以传任意字符串（不会报错）。**换来**：消费方不用做类型断言。

#### 为什么 `SURFACE_EVENT_TYPES` 是"导出"的

**因为第 8 步的循环要用它** —— 比如"判断某个事件是不是表面事件"。

**而且导出它等于把"什么是表面事件"这个知识公开** —— 而不是藏在 `deriveMessages` 内部。

**这是"把判断依据显式化"的做法。**

### 3.4 `SessionEvent`（第 76–86 行）

```ts
export interface SessionEvent {
  /** 序号，从 0 开始，**不跳号**。用于校验日志完整性。 */
  readonly seq: number
  /** 发生时刻（毫秒时间戳）。 */
  readonly time: number
  /** 事件类型。 */
  readonly type: string
  /** 事件数据。 */
  readonly data: unknown
}
```

#### 两个值得注意的点

**① `type` 是 `string` 而不是 `SessionEventType`**

**为什么？**

因为**事件类型是"可扩展"的**（插件可以用声明合并加事件）。而**日志里可能包含当前代码不认识的事件类型**。

```ts
// 日志由更新版本的代码写入，当前版本不认识 'image/attached'
{ seq: 42, time: ..., type: 'image/attached', data: {...} }
```

**如果 `type` 声明成 `SessionEventType`，这份日志就读不进来。**

**DSH 在这方面更严格** —— 它对未知事件类型是**拒绝加载**的（除非事件带 `ignorable: true`）：

> 「`SessionEventMap` members are required-on-read by default — builds that do not know a type refuse the log unless the event carries the envelope's `ignorable: true`」

**我们的选择更宽松**（不认识就跳过），**代价是"静默丢失信息"**。写进 L9。

**② `data: unknown`**

**为什么不写成泛型 `SessionEvent<T>`？**

```ts
// 泛型版本
interface SessionEvent<T = unknown> {
  readonly type: string
  readonly data: T
}
```

**问题**：`type` 和 `data` 应该**联动**（`type` 是 `'user/message'` 时，`data` 应该是 `{text: string}`）。

```ts
// 真正的联动版本（可辨识联合）
type SessionEvent = { [K in SessionEventType]: { seq: number; time: number; type: K; data: SessionEventMap[K] } }[SessionEventType]
```

**那是一个映射类型**，会让每个事件都有精确的类型。

**我们没用**，因为：

| 理由 | 说明 |
|---|---|
| 读回来的事件要运行时校验 | 类型再准也挡不住"文件被手改" |
| `deriveMessages` 里要做类型收窄 | 联合类型会让每次访问都要判别 |
| 教学上更复杂 | 映射类型对初学者是负担 |

**代价**：`data` 是 `unknown`，取字段要手动收窄（`asText` / `readNumber` 就是为此存在的）。

**这是"在类型精确度和实现复杂度之间的取舍"。**

### 3.5 `Session` 的字段与 `append()`（第 96–130 行）

```ts
export class Session {
  readonly id: string
  #events: SessionEvent[] = []
  #nextTurn = 1
  #nextStep = 1

  constructor(id: string) {
    this.id = id
  }

  get events(): readonly SessionEvent[] {
    return this.#events
  }

  append<K extends SessionEventType>(type: K, data: SessionEventMap[K]): SessionEvent {
    const event: SessionEvent = {
      seq: this.#events.length,
      time: Date.now(),
      type,
      data,
    }
    this.#events.push(event)
    return event
  }
```

#### `#nextTurn` / `#nextStep` 为什么要单独维护

**因为编号不能从 `events.length` 推出来。**

```
事件：turn/start(1), user/message, step/start(1), ..., step/end(1), turn/end(1)
      ↑ turn 编号                ↑ step 编号
```

**turn 编号和 step 编号是两套独立的序列**：

| 编号 | 什么时候递增 |
|---|---|
| `#nextTurn` | `startTurn()` 被调用时 |
| `#nextStep` | `startStep()` 被调用时 |

**如果都从事件数推**，会混乱（`step/start` 的数量和 `turn/start` 的数量不同）。

#### `append` 的泛型

```ts
append<K extends SessionEventType>(type: K, data: SessionEventMap[K]): SessionEvent
```

**效果**：

```ts
session.append('user/message', { text: '你好' })      // ✅
session.append('user/message', { text: 123 })         // ❌ text 必须是 string
session.append('user/message', {})                    // ❌ 缺 text
session.append('user/msg', { text: 'x' })             // ❌ 不是合法类型
```

**四种错误全在编译期挡住。**

**这是"类型化事件表"的价值** —— 和第 4 步的 `EventMap` 是同一套技巧。

#### `seq: this.#events.length`

**这一行保证了序号的性质**：

| 性质 | 为什么成立 |
|---|---|
| 从 0 开始 | 第一条的 `length` 是 0 |
| 连续不跳号 | 每次 push 后 length +1 |
| **可用于校验** | 读回来的 `events[i].seq` 必须等于 `i` |

**第三条是一个"免费的完整性检查"** —— 如果日志被手工改过（删了一行），`seq` 就会和下标对不上。

**我们没实现这个检查**（见挑战题）。

#### 为什么 `append` 返回 `SessionEvent`

**因为调用方可能需要它**：

```ts
const event = session.append('user/message', { text: 'x' })
console.log(event.seq)      // 拿到刚写入的序号
```

**尤其是"拿到 seq 之后要引用它"的场景**（比如第 16 步的审计要记录"这次改动对应哪条事件"）。

### 3.6 过程事件小助手（第 132–160 行）

```ts
  startTurn(): number {
    const turn = this.#nextTurn
    this.#nextTurn += 1
    this.append('turn/start', { turn })
    return turn
  }

  endTurn(turn: number, reason: TurnEndReason = 'complete'): void {
    this.append('turn/end', { turn, reason })
  }

  startStep(): number {
    const step = this.#nextStep
    this.#nextStep += 1
    this.append('step/start', { step })
    return step
  }

  endStep(step: number): void {
    this.append('step/end', { step })
  }
```

#### 为什么要这些"小助手"

**对比两种写法**：

```ts
// 不用小助手
const turn = 1
session.append('turn/start', { turn })
// ... 中间要自己维护 turn 计数
session.append('turn/end', { turn, reason: 'complete' })

// 用小助手
const turn = session.startTurn()
// ...
session.endTurn(turn)
```

**小助手做了三件事**：

| 事 | 价值 |
|---|---|
| 分配编号 | 调用方不用自己维护计数器 |
| 写事件 | 调用方不用记字段名 |
| 返回编号 | **`endTurn(turn)` 需要它** |

**第三条是关键** —— `startTurn` 返回的编号要传回给 `endTurn`。**这形成了配对使用的契约。**

#### `endTurn` 的默认参数

```ts
endTurn(turn: number, reason: TurnEndReason = 'complete'): void
```

**默认 `'complete'`** —— 因为**绝大多数 turn 是正常结束的**。

**调用方只在异常时写第二个参数**：

```ts
session.endTurn(turn)                     // 正常
session.endTurn(turn, 'cancelled')        // 被取消
session.endTurn(turn, 'error')            // 出错
```

#### 一个设计问题：为什么不让 `Session` 自己追踪"当前 turn"

```ts
// 另一种设计（不采用）
class Session {
  #currentTurn: number | undefined
  startTurn() { this.#currentTurn = ++this.#n; ... }
  endTurn(reason) { ...this.#currentTurn... }      // ← 不用传编号
}
```

**看起来更方便，但它引入了状态**：

| | 显式传编号（我们的选择） | 内部追踪当前 turn |
|---|---|---|
| 状态 | **无** | 有（`#currentTurn`） |
| 能否嵌套 | ✅（虽然用不上） | ❌ |
| 错误检测 | 传错编号能看出来 | **静默** |
| 代码量 | 调用方多写一个参数 | 少写一个参数 |

**我们选"显式传编号"** —— 因为它**不引入额外状态**，而且**配对关系在代码里可见**（`const turn = startTurn(); ...; endTurn(turn)`）。

**这又是"显式优于隐式"。**

### 3.7 `recordXxx` 四个方法（第 162–180 行）

```ts
  recordUser(text: string): void {
    this.append('user/message', { text })
  }

  recordAssistant(content: string, toolCalls?: readonly ToolCall[], usage?: LLMUsage): void {
    this.append('assistant/message', {
      content,
      ...(toolCalls !== undefined && toolCalls.length > 0 ? { toolCalls } : {}),
      ...(usage !== undefined ? { usage } : {}),
    })
  }

  recordToolCall(toolCallId: string, name: string): void {
    this.append('tool/call', { toolCallId, name })
  }

  recordToolResult(toolCallId: string, name: string, content: string, isError: boolean): void {
    this.append('tool/result', { toolCallId, name, content, isError })
  }
```

#### `recordAssistant` 里的两个条件展开

```ts
content,
...(toolCalls !== undefined && toolCalls.length > 0 ? { toolCalls } : {}),
...(usage !== undefined ? { usage } : {}),
```

**为什么 `toolCalls` 多了一个 `length > 0` 条件？**

因为**空数组没有信息量**：

```json
{ "content": "回答", "toolCalls": [] }      ← 噪音
{ "content": "回答" }                        ← 干净
```

**为什么 `usage` 只判 `undefined`？**

因为 `usage` 是对象（不是数组），"空对象"也是有意义的（可能有 `{}` 的情况，虽然少见）。

**这两个条件的不同，反映了"数组的空"和"对象的空"在语义上的差别** —— 数组空 = 没有元素；对象空 = 有但没内容。

（严格说 `usage: {}` 也可能该被省略。**我们的判断是"给定就记"**，因为空对象可能来自 provider 的真实响应。）

### 3.8 `save()` 与 `load()`（第 184–230 行）★

#### `save`：目录自动创建

```ts
  async save(path: string): Promise<void> {
    // save 应该「拿来就能用」—— 不该要求调用方先建目录
    await mkdir(dirname(path), { recursive: true })
    const text = this.#events.map((event) => JSON.stringify(event)).join('\n')
    await writeFile(path, text === '' ? '' : `${text}\n`, 'utf8')
  }
```

**`mkdir(dirname(path), { recursive: true })` 这一行是我在跑演示时补的** —— 因为最初的版本假设目录存在，演示 4 直接报了 `ENOENT`。

**这正是 L9 里会记录的缺陷之一**（"`save` 假设目录存在"），**而修法就是这两行**。

**"save 应该拿来就能用"是个设计判断**：

| 方案 | 调用方体验 |
|---|---|
| 要求先建目录 | 每个调用点都要 `mkdir` —— **一定有地方忘** |
| **自己建目录** | 拿来就用 |

**这类"让 API 更宽容"的改动，成本极低而收益很高。**

**另外 `text === '' ? '' : \`${text}\n\`` 这个三元**：

```ts
// 空日志：写空文件（不是 "\n"）
// 非空：末尾补一个换行
```

**为什么末尾要换行？** 因为 **JSONL 的每一行都应该以 `\n` 结尾**（包括最后一行），这样追加时不用特殊处理。

**为什么空日志不写 `\n`？** 因为一个只含换行的文件读回来会得到一个空行，虽然 `split` 后过滤掉了，但**"空文件"和"只有换行的文件"语义上应该一样，干脆统一成空文件**。

#### `load`：三步

```ts
  static async load(id: string, path: string): Promise<Session> {
    const session = new Session(id)
    const text = await readFile(path, 'utf8')

    // ① 逐行解析
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      session.#events.push(JSON.parse(line) as SessionEvent)
    }

    // ② 恢复计数器
    for (const event of session.#events) {
      if (event.type === 'turn/start') session.#nextTurn = Math.max(session.#nextTurn, readNumber(event, 'turn') + 1)
      if (event.type === 'step/start') session.#nextStep = Math.max(session.#nextStep, readNumber(event, 'step') + 1)
    }

    // ③ 修复未闭合的 turn
    // ...
  }
```

**② 恢复计数器这一步很容易被忘。**

**如果忘了会怎样？**

```
日志里有 turn 1，读回来后 #nextTurn 仍是 1
   ↓
下一次 startTurn() 分配 turn 1  ← ★ 和历史上的 turn 1 撞号 ★
   ↓
turn/end 匹配时会把两个 turn 1 混淆
```

**`Math.max(...)` 的作用**：取所有 `turn/start` 里最大的编号 + 1。

**为什么用 `Math.max` 而不是"最后一个"？**

因为**正常情况下日志是顺序的**，但**如果日志被合并或重排过**（比如手工拼接过），取最大值更稳。

**这是"防御性"的写法** —— 代价是可忽略的，收益是"重排的日志也能正确恢复"。

#### ③ 修复未闭合 turn（1.5 节已详讲）

**这里补充一个实现细节**：

```ts
const lastTurnStart = [...session.#events].reverse().find((event) => event.type === 'turn/start')
```

**`[...]` + `reverse()` + `find()` 的组合** —— **从后往前找第一个**。

**对比"从前往后找最后一个"**：

```ts
// 另一种写法：正向遍历，每次覆盖
let lastTurnStart: SessionEvent | undefined
for (const event of session.#events) {
  if (event.type === 'turn/start') lastTurnStart = event
}
```

**两者等价**，但：

| 写法 | 遍历次数 | 可读性 |
|---|---|---|
| `reverse().find()` | 1 次（但要先复制） | "我要最后一个" → 反转后找第一个 |
| 正向遍历覆盖 | 1 次 | "一路记着最后一个" |

**我们用了前者** —— 因为它**更短**，而且"反转后找第一个"是常见的惯用法。

**代价**：多一次数组复制（O(n) 内存）。**对日志长度来说可忽略。**

### 3.9 `deriveMessages()`（第 235–290 行）★ 核心 ★

```ts
export function deriveMessages(events: readonly SessionEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = []

  for (const event of events) {
    if (!SURFACE_EVENT_TYPES.has(event.type)) continue      // ★ 关键的一行

    const data = event.data
    if (typeof data !== 'object' || data === null) continue
    const record = data as Record<string, unknown>

    switch (event.type) {
      case 'user/message':
        messages.push({ role: 'user', content: asText(record['text']) })
        break

      case 'assistant/message': {
        const toolCalls = Array.isArray(record['toolCalls'])
          ? (record['toolCalls'] as readonly ToolCall[])
          : undefined
        messages.push({
          role: 'assistant',
          content: asText(record['content']),
          ...(toolCalls !== undefined ? { toolCalls } : {}),
        })
        break
      }

      case 'tool/result':
        messages.push({
          role: 'tool',
          content: asText(record['content']),
          toolCallId: asText(record['toolCallId']),
          name: asText(record['name']),
        })
        break

      default:
        // 不可达：SURFACE_EVENT_TYPES 已经过滤过了
        break
    }
  }

  return messages
}
```

#### 三层防线

| 层 | 挡什么 |
|---|---|
| `SURFACE_EVENT_TYPES.has(...)` | 过程事件 |
| `typeof data !== 'object'` | 畸形的 `data`（文件被改过） |
| `switch` 的 `default` | 未来新增的表面事件类型（**这里没处理**） |

**第三层值得注意**：`default: break` **静默忽略了未处理的表面事件**。

**如果将来往 `SURFACE_EVENT_TYPES` 加了一个新类型但忘了在 `switch` 里处理** —— **它会静默不产生消息**。

**这是"开放联合用 default"的代价**（第 2、4 步讲过：封闭联合用 `assertNever`，可扩展联合用 `default`）。

**但这里的 `default` 连日志都没打** —— **如果它真的发生，你完全不会知道。**

**写进 L9。**

#### `asText` 的作用

```ts
function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
```

**一行函数，但它是"从 `unknown` 安全取值"的标准工具。**

**为什么需要它？** 因为 `record['content']` 的类型是 `unknown`（`Record<string, unknown>` 的取值）。

**为什么不用 `as string`？**

```ts
content: record['content'] as string      // ← 骗编译器
```

**如果 `content` 实际上是数字，`as string` 会让它在运行时是个数字** —— 而它会被塞进 `ChatMessage.content`（声明是 `string`）。

**后果**：模型层序列化后，`content` 是数字 → 服务端报错。

**`asText` 的做法是"不是字符串就给空串"** —— **类型诚实，且不会崩**。

**代价**：数据不对时静默变成空串（**又是一种"沉默"**，见 L9）。

**更好的做法**：抛错或者记一条警告。**我们选择了宽容**（因为日志可能来自旧版本）。

#### 三个 `case` 的映射

| 事件 | → | 消息 |
|---|---|---|
| `user/message` | → | `{ role: 'user', content: text }` |
| `assistant/message` | → | `{ role: 'assistant', content, toolCalls? }` |
| `tool/result` | → | `{ role: 'tool', content, toolCallId, name }` |

**注意 `assistant` 的 `toolCalls` 用了条件展开** —— 和第 3.7 节的 `recordAssistant` 呼应。

**为什么要一致？**

因为**第 1 步的 `ChatMessage.toolCalls` 是可选的**（`toolCalls?: readonly ToolCall[]`）。

**如果我们总是给 `toolCalls: undefined`**：

```ts
{ role: 'assistant', content: 'x', toolCalls: undefined }
```

**在 `assertModelVisibleMatchesLog` 的比较里**，这**不会有问题**（因为我们只比了 `role` 和 `content`）。

**但 `JSON.stringify` 时 `toolCalls` 会消失** —— 结果一样。

**所以这里的一致性是"风格一致"而非"功能必需"。** 保持它是因为**读代码的人不该猜"为什么这里有一个条件展开那里没有"**。

### 3.10 `computeStats()`（第 295–350 行）

```ts
export function computeStats(events: readonly SessionEvent[]): SessionStats {
  let turns = 0
  let steps = 0
  let toolCalls = 0
  let toolErrors = 0
  let tokens = 0

  for (const event of events) {
    switch (event.type) {
      case 'turn/end': turns += 1; break
      case 'step/end': steps += 1; break
      case 'tool/call': toolCalls += 1; break
      case 'tool/result':
        if (typeof event.data === 'object' && event.data !== null
          && (event.data as Record<string, unknown>)['isError'] === true) {
          toolErrors += 1
        }
        break
      case 'assistant/message': {
        const usage = (event.data as Record<string, unknown>)['usage']
        if (typeof usage === 'object' && usage !== null) {
          for (const value of Object.values(usage as Record<string, unknown>)) {
            if (typeof value === 'number') tokens += value
          }
        }
        break
      }
      default:
        break
    }
  }

  return { turns, steps, toolCalls, toolErrors, tokens, messages: deriveMessages(events).length }
}
```

#### 用 `let` 累加而不是 `reduce`

**五个计数器**用 `let` 声明，`switch` 里累加。

**为什么不用 `filter().length`？**

```ts
// 另一种写法
const steps = events.filter((e) => e.type === 'step/end').length
const toolCalls = events.filter((e) => e.type === 'tool/call').length
// ... 每个都遍历一遍
```

**那样要遍历 5 次**。**一次遍历数完更高效**，而且**代码集中在一处**。

**代价**：`let` 是可变的。**但在一个函数内部的局部累计是可接受的** —— 它不外泄。

#### `tokens` 的计算有个陷阱

```ts
for (const value of Object.values(usage as Record<string, unknown>)) {
  if (typeof value === 'number') tokens += value
}
```

**它对 `usage` 里的所有数字字段求和。**

**问题**：如果 `usage` 是

```json
{ "prompt_tokens": 30, "completion_tokens": 18, "total_tokens": 48 }
```

**求和会得到 30 + 18 + 48 = 96**，而真实消耗是 **48**（`total_tokens`）。

**演示 3 的输出就暴露了这一点**：

```
{ ..., "tokens": 360 }
```

我们构造的数据是 48 + 132 = 180（两次的 total_tokens），但输出是 360 —— **因为它把 prompt/completion/total 全都加了一遍**。

**这是一个真实的缺陷**（见 L9），而且**它是一个"看起来对但实际错"的错误** —— 正是最难发现的那类。

**正确做法**：优先取 `total_tokens`，没有才用 `prompt + completion`。

```ts
function usageToTokens(usage: unknown): number {
  if (typeof usage !== 'object' || usage === null) return 0
  const record = usage as Record<string, unknown>
  if (typeof record['total_tokens'] === 'number') return record['total_tokens']
  const prompt = typeof record['prompt_tokens'] === 'number' ? record['prompt_tokens'] : 0
  const completion = typeof record['completion_tokens'] === 'number' ? record['completion_tokens'] : 0
  return prompt + completion
}
```

**这个缺陷值得单独讲**（见 L9 缺陷 1），因为：

> **它不报错、不掉分、数字看起来合理** —— 只是**大了一倍**。
> **如果你用它算成本，会得到双倍的估算。**

#### `messages: deriveMessages(events).length`

**这一行让 `computeStats` 依赖 `deriveMessages`** —— 两个纯函数之间的组合。

**为什么把 `messages` 也算进统计？**

因为它**验证不变量的一个抓手**："日志派生的消息数"应该和"实际发给模型的消息数"一致。

### 3.11 `assertModelVisibleMatchesLog()`（第 355–380 行）

```ts
export function assertModelVisibleMatchesLog(
  session: Session,
  actual: readonly ChatMessage[],
): void {
  const derived = session.deriveMessages()

  if (derived.length !== actual.length) {
    throw new Error(
      `Model-visible 与日志不一致：日志派生 ${derived.length} 条消息，实际有 ${actual.length} 条`,
    )
  }

  for (let index = 0; index < derived.length; index += 1) {
    const a = derived[index]
    const b = actual[index]
    if (a === undefined || b === undefined) continue
    if (a.role !== b.role) {
      throw new Error(`Model-visible 与日志不一致：第 ${index} 条消息的角色是 ${b.role}，日志里是 ${a.role}`)
    }
    if (a.content !== b.content) {
      throw new Error(
        `Model-visible 与日志不一致：第 ${index} 条（role=${a.role}）内容不同\n日志：${a.content}\n实际：${b.content}`,
      )
    }
  }
}
```

#### 检查的三层

| 层 | 检查 | 发现什么问题 |
|---|---|---|
| 1 | 长度 | 有代码多推/少推了消息 |
| 2 | `role` | 消息顺序错乱 |
| 3 | `content` | 内容被篡改 |

**第 3 层是演示 6 抓到的**：

```
Model-visible 与日志不一致：第 0 条（role=user）内容不同
日志：帮我看看 src/kernel/llm.ts 有多少行
实际：（被偷偷改过的内容）
```

**注意错误信息里同时给出了两个值** —— **这是"错误信息要能直接定位"的最高形式**。

#### 为什么只比到 `content` 就停

**没有比 `toolCalls` 和 `toolCallId`。**

| 可以比的 | 为什么没比 |
|---|---|
| `toolCalls` | 要深比较数组，代码变长 |
| `toolCallId` | 同上 |
| `name` | 同上 |

**这是个"够用就好"的选择** —— 长度 + role + content 已经能抓住绝大多数"绕过日志"的错误。

**但如果有人只改了 `toolCallId`**（把结果挂到错误的调用上），**这个检查抓不到** —— 而那恰恰是"tool 消息配对"类 bug 的典型形态。

**写进 L9。**

#### `if (a === undefined || b === undefined) continue` 这一行

**为什么需要它？** 因为 TypeScript 的 `noUncheckedIndexedAccess` 没开时 `derived[index]` 的类型是 `ChatMessage`（不是 `| undefined`）。

**但为了防御越界**（长度检查已经保证不会越界），**加了这一行**。

**实际上它是死代码** —— 长度相等且循环在范围内，不可能 undefined。

**这是"防御性写法的代价"**：多两行不执行的代码，换来"即使前面的检查被改坏也不会崩"。

**判断标准**：**如果去掉它，崩溃的可能性有多大？** 这里很小（因为长度已检查）。

**所以它更像是"习惯动作"而非"必要防御"。**

---

## L4 运行与验证

### 4.1 怎么运行

```powershell
cd D:\agent-harness-lab
node src/demos/demo-session.ts
```

### 4.2 六组演示逐条解读

#### 演示 1 · 记录一次任务

```
--- 事件流（注意 seq 只增不跳）---
[ "0 turn/start", "1 user/message", "2 step/start", "3 assistant/message",
  "4 tool/call", "5 tool/result", "6 step/end", "7 step/start",
  "8 assistant/message", "9 step/end", "10 turn/end" ]
```

**要观察的四件事**：

| 观察 | 说明 |
|---|---|
| `seq` 从 0 连续到 10 | 没有跳号 |
| 一个 turn 包着两个 step | 结构清晰 |
| `tool/call` 在 `assistant/message` 之后 | 因为模型先"要求"，我们才"记录调用" |
| `tool/result` 在 `tool/call` 之后 | 时序正确 |

**注意第 3–5 条事件的顺序**：

```
assistant/message   ← 模型说"我要调用 read_file"
tool/call           ← 我们记录"开始调用"
tool/result         ← 我们记录"结果是..."
```

**为什么 `tool/call` 不和 `assistant/message` 合并？**

因为它们**回答不同的问题**：

| 事件 | 回答 |
|---|---|
| `assistant/message` | **模型说了什么** |
| `tool/call` | **我们真的去调用了**（可能被审批拦下、可能失败） |

**两者不一定一一对应** —— 如果审批拒绝了，就只有 `assistant/message` 没有 `tool/call`。

**这个区分的价值在第 10 步**（审批）会显现。

#### 演示 2 · 表面 vs 过程（★ 核心 ★）

```
--- 对比 ---
{ "事件总数": 11, "消息总数": 4,
  "差值说明": "差的就是过程事件（turn/start、step/start、tool/call…）—— 它们只用于记账" }
```

**要观察的**：**11 减 4 等于 7，这 7 个就是过程事件。**

**数一下**：

```
过程事件：turn/start, step/start, tool/call, step/end, step/start, step/end, turn/end = 7 个 ✓
表面事件：user/message, assistant/message, tool/result, assistant/message = 4 个 ✓
```

**这个对比是本篇最有说服力的一组** —— 它让"表面事件 vs 过程事件"这个抽象概念变成了两个数字。

#### 演示 3 · 统计（★ 与你科研对接 ★）

```
{ "turns": 1, "steps": 2, "toolCalls": 1, "toolErrors": 0, "tokens": 360, "messages": 4 }
```

**要观察的四件事**：

| 字段 | 值 | 对应什么 |
|---|---|---|
| `turns` | 1 | 一次任务 |
| **`steps`** | **2** | **"这道题花了 2 步"** |
| `toolCalls` | 1 | 调用了一次工具 |
| `tokens` | 360 | **⚠️ 这个数字有问题（见 L9）** |

**`tokens: 360` 是错的** —— 我们构造的两个 `usage` 是：

```ts
{ prompt_tokens: 30, completion_tokens: 18, total_tokens: 48 }    // 和 = 96
{ prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 }  // 和 = 264
```

**96 + 264 = 360** —— **它把 prompt/completion/total 全加了一遍**。

**真实的 token 消耗应该是 48 + 132 = 180。**

**这个缺陷是"演示帮我们发现的"** —— 如果我们没跑演示、只看代码，很容易认为"求和是对的"。

#### 演示 4 · 存盘与读回

```
--- 读回后的事件数 ---  11
--- 读回后的消息数与原来一致吗 ---  true
--- 读回后的统计 ---  { "turns": 1, "steps": 2, ... }
```

**要观察的**：**往返一致**（事件数、消息数、统计都对得上）。

**这验证了 JSONL 序列化的正确性。**

#### 演示 5 · 修复未闭合的 turn（★ 重要 ★）

```
--- 崩之前的最后一条事件 ---  user/message
--- 读回后的最后一条事件（应被补成 turn/end）---
{ "seq": 2, "time": ..., "type": "turn/end", "data": { "turn": 1, "reason": "error" } }
--- 修复后的统计（turns 应该是 1）---  { "turns": 1, "steps": 0, ... }
```

**要观察的三件事**：

| 观察 | 说明 |
|---|---|
| 崩之前最后是 `user/message` | **没有 turn/end** |
| 读回后多了一条 `turn/end` | **自动修复** |
| `reason: 'error'` | **不是正常结束** |
| `turns: 1` | 统计正确 |

**`steps: 0` 也值得注意** —— 因为这个 turn 崩在了第一步之前（只有 `user/message` 没有 `step/start`）。

**这说明统计能反映"崩在哪一步"**。

#### 演示 6 · 不变量检查（★ 核心 ★）

```
--- 一致的检查 ---  通过
--- 篡改被抓出来 ---
Model-visible 与日志不一致：第 0 条（role=user）内容不同
日志：帮我看看 src/kernel/llm.ts 有多少行
实际：（被偷偷改过的内容）
```

**要观察的三件事**：

| 观察 | 说明 |
|---|---|
| 正常的通过 | 没有误报 |
| 篡改的被抓出 | 检查有效 |
| **错误信息给了两个值** | 能直接看出差异 |

**第 3 条是"错误信息质量"的典范** —— 它不只说"不一致"，而是**把两个值都打出来**。

### 4.3 验收判据

| # | 判据 | 验证 |
|---|---|---|
| 1 | 六组演示全部符合上述输出 | 运行 |
| 2 | 演示 2 的数字是 11 与 4 | 看输出 |
| 3 | 演示 5 自动补了 `turn/end`，`reason` 是 `error` | 看输出 |
| 4 | 演示 6 抓出篡改且**给出两个值** | 看输出 |
| 5 | 你能说出"表面事件 vs 过程事件"的划分理由 | 口述 |
| 6 | 你能说出"为什么只提供 append" | 口述 |
| 7 | 你能说出"Model-visible ⟺ logged 消灭了哪类 bug" | 口述 |
| 8 | **关掉文档**能写出 `deriveMessages` | 见 L6 |

---

## L5 语法速查（本篇新增）

> 第 1–6 步的语法分别在 [`01`](01-llm.md#l5-本篇-typescript-语法速查) / [`02`](02-tools.md#l5-语法速查本篇新增) / [`03`](03-context.md#l5-语法速查本篇新增) / [`04`](04-events.md#l5-语法速查本篇新增) / [`05`](05-scope.md#l5-语法速查本篇新增) / [`06`](06-loader.md#l5-语法速查本篇新增) 里。

| 语法 | 例子 | 含义 | 注意 |
|---|---|---|---|
| `new Set<T>(array)` | `new Set<SessionEventType>([...])` | 从数组建集合 | 会去重 |
| **`ReadonlySet<T>`** | 导出只读集合 | 挡 add/delete | 运行时挡不住 |
| `Record<string, unknown>` 取值 | `record['x']` | 拿到 `unknown` | 用前收窄 |
| `Object.values` | 遍历对象的值 | 数组 | |
| **`Array.prototype.findLast`** | 从后往前找 | ES2023 | 我们用了 `reverse().find()` |
| `Math.max` | 恢复计数器 | | |
| `static` 方法 | `static async load(...)` | 类上的方法 | 通过类名调用 |
| `{ [K in T]: ... }` | 映射类型（**本篇未用，但值得知道**） | 遍历联合类型 | 比手写联合更紧凑 |
| `import { mkdir, readFile }` | 多个具名导入 | | |
| `text === '' ? '' : \`${text}\n\`` | 三元 + 模板 | 避免产生空行 | |

### 本篇新增的两条规则

**规则 21：`ReadonlySet` / `ReadonlyMap` 是"只读视图"类型**

```ts
let s: Set<number> = new Set([1])
const r: ReadonlySet<number> = s      // ✅ 可以赋值
r.add(2)                              // ❌ 编译报错
```

**它只挡编译期的写操作** —— 运行时还是同一个对象。

**规则 22：`Array.prototype.reverse()` 会改原数组**

（第 3 步讲过，这里再强调一次，因为本篇又用到了）

```ts
[...events].reverse().find(...)       // ✅ 先复制
events.reverse().find(...)            // ❌ 把原数组改了
```

---

## L6 关文档重写判据

### 必须能写出的部分

| 难度 | 要写的东西 | 通过标准 |
|---|---|---|
| ★ | `SessionEvent` | 四个字段 |
| ★ | `append` | **`seq = length`** |
| ★★ | `SURFACE_EVENT_TYPES` | **三个类型，且知道为什么 `tool/call` 不在里面** |
| ★★★ | **`deriveMessages`** | **过滤 + 三个 case + `asText` 收窄** |
| ★★★ | `computeStats` | 五个计数器 |
| ★★★ | `save` / `load` | **含目录创建 + 计数器恢复 + 修复** |
| ★★ | `assertModelVisibleMatchesLog` | 三层检查 |

### 卡住时的自检问题

| 卡在哪 | 问自己 |
|---|---|
| 表面事件的划分 | "`tool/call` 的信息在 `assistant/message` 里已经有了吗？" |
| `seq` 怎么算 | "怎么保证连续不跳号？" |
| `deriveMessages` 的过滤 | "过程事件应该变成什么消息？" |
| `load` 的计数器 | "如果忘了恢复 `#nextTurn`，会发生什么？" |
| 未闭合 turn 的修复 | "`reason` 该填什么？为什么？" |

### 分级判定

| 程度 | 判定 |
|---|---|
| 能写出 ★★ 及以下 | 不够 L3，重读 3.3 和 3.9 |
| 能写出 ★★★ 但漏了"恢复计数器" | 接近 L3 —— 想一下"读回来后第一次 startTurn 会分配几号" |
| 全部写出 | ✅ **达标** |

---

## L7 挑战题（不给答案）

### 挑战 1 · 修掉 `tokens` 的计算 bug

**缺陷**（L9 缺陷 1）：现在把所有 `usage` 字段求和，导致重复计算。

**要求**：

1. 写一个 `usageToTokens(usage)` 函数：优先取 `total_tokens`，没有才用 `prompt + completion`
2. 改 `computeStats` 用它
3. **重新跑演示 3**，确认 `tokens` 变成 **180**（而不是 360）

### 挑战 2 · 加 `seq` 完整性校验

`seq` 是"从 0 连续不跳号"的。**但现在的 `load` 不校验它。**

**要求**：

1. 在 `load` 里检查 `events[i].seq === i`
2. 不满足时抛错（说明日志被改过）
3. **思考**：这个校验能发现哪些篡改？发现不了哪些？

### 挑战 3 · 支持"撤回一条消息"

**目标**：能用 append-only 的方式表达"撤回了某条消息"。

**要求**：

1. 加事件类型 `message/retracted: { targetSeq: number }`
2. `deriveMessages` 派生时**跳过被撤回的消息**
3. **思考**：这和第 3 步的"撤销"（disposer）在思想上有什么共同点？

**这道题直接对应"事件溯源"模式。**

### 挑战 4 · 让 `stats` 支持"只要成功题的平均步数"

**问题**：`computeStats` 算的是单次会话。**但"平均完成步数"要跨多道题。**

**要求**：

1. 写一个 `aggregateStats(sessions: readonly Session[]): AggregateStats`
2. 输出：总数、成功率、**全部题平均步数**、**成功题平均步数**、总 token
3. "成功"的判据用什么？（提示：`turn/end.reason`）

**这题直接产出你的台账需要的数据。**

### 挑战 5 · 设计一个"最小可复现包"

**目标**：把一个会话导出成"别人能完全复现这次请求"的东西。

**要求**：说明这个包里要有哪些东西：

- 会话日志？
- 模型参数（provider / model / temperature / seed）？
- 工具定义（schema）？
- 环境信息（版本 / 工作目录）？

**并说明**：**缺哪一样会导致"无法复现"？**

**这道题是"可复现性完备性"的实践** —— 而它是你论文的硬要求。

---

## L8 自检清单

### 理解层（L1）

- [ ] ★ **我能完整解释 "Model-visible ⟺ logged" 以及它消灭了哪类 bug**
- [ ] 我能说出表面事件和过程事件的划分标准
- [ ] 我能说出"为什么 `tool/call` 不是表面事件"
- [ ] 我能解释"为什么只提供 append"
- [ ] 我能解释"为什么要修复未闭合的 turn"
- [ ] **我能说出"平均完成步数"从哪来，以及它的陷阱**

### 实现层（L3）

- [ ] 我关掉文档写出了 `deriveMessages`
- [ ] 我写出了 `SURFACE_EVENT_TYPES` 并知道 `tool/call` 为什么不在里面
- [ ] 我写出了 `load` 的三步（解析 / 恢复计数器 / 修复）
- [ ] 我写出了"从后往前找最后一个 turn/start"
- [ ] 我能解释 `asText` 为什么比 `as string` 好

### 语法层

- [ ] 我知道 `ReadonlySet` 只挡编译期
- [ ] 我知道 `reverse()` 会改原数组
- [ ] 我会用 `Record<string, unknown>` + 收窄取值

### 系统层（L4）

- [ ] 我能说出 `deriveMessages` 会被第 8 步怎么用
- [ ] 我能说出"重试"为什么依赖"日志不可变"
- [ ] **我能说出统计字段与导师问题的一一对应**

---

## L9 仍未解决

### 会被后续步骤解决的

| 遗留问题 | 哪一步 |
|---|---|
| 没有循环来产生事件 | 第 8 步 |
| 没有"每次请求前自动校验不变量"的调用点 | 第 8 步 |
| 会话日志没被包成插件（不在 `ctx` 上） | 第 8 步 |
| 没有压缩（日志会一直增长） | 第 10 步 |

### 当前实现的真实缺陷

#### 缺陷 1 · `tokens` 计算重复计数 ★ 最严重 ★

```ts
for (const value of Object.values(usage as Record<string, unknown>)) {
  if (typeof value === 'number') tokens += value
}
```

**问题**：把 `prompt_tokens` + `completion_tokens` + `total_tokens` **全加了一遍**。

**后果**：**数字大了一倍**（演示 3 的 `360` 应该是 `180`）。

**为什么这个缺陷最危险**：

| 特征 | 说明 |
|---|---|
| 不报错 | 它只是算出一个数 |
| 不掉分 | 数字"看起来合理" |
| **错了也不明显** | 除非你知道正确值 |
| **直接影响你的科研** | **成本估算会翻倍** |

**修法**：见挑战题 1。

**它的教训**：

> **"求和"这种朴素做法，在多字段字典上几乎总是错的。**
> **因为字典里常有"派生字段"（`total` 就是 `prompt + completion`）。**

#### 缺陷 2 · `data: unknown` 导致到处手动收窄

```ts
const data = event.data
if (typeof data !== 'object' || data === null) continue
const record = data as Record<string, unknown>
```

**问题**：**每一处消费事件的地方都要做这三行。**

**这是"`type` 和 `data` 没有类型联动"的代价**（3.4 节讲过）。

**更好的设计**是可辨识联合（映射类型），但会让代码复杂。

**代价要记住**：**`data: unknown` 让"事件数据"的类型安全退化成运行时检查。**

#### 缺陷 3 · `default: break` 静默忽略未处理的表面事件

```ts
switch (event.type) {
  case 'user/message': ...
  case 'assistant/message': ...
  case 'tool/result': ...
  default:
    // 不可达：SURFACE_EVENT_TYPES 已经过滤过了
    break
}
```

**问题**：**如果将来往 `SURFACE_EVENT_TYPES` 加类型但忘了改 `switch`** —— **静默不产生消息**。

**后果**：模型会看不到那类事件的内容，**而没有任何提示**。

**更好的做法**：

```ts
default:
  throw new Error(`未处理的表面事件类型：${event.type}`)
```

**或者至少 `console.warn`。**

**为什么没做**：因为当前三个类型正好对应三个 case，**"不可达"当前是真的**。

**但"当前不可达"不等于"永远不可达"** —— 这是"防御未来"的典型场景。

#### 缺陷 4 · `assertModelVisibleMatchesLog` 不检查 `toolCalls`

**问题**：只比了 `role` 和 `content`，**没比 `toolCalls` 和 `toolCallId`**。

**后果**：如果有人把 tool 结果挂到了错误的 `toolCallId` 上，**这个检查抓不到**。

**而"tool 消息配对错误"正是第 8 步最容易出的一类 bug**（第 1 步提过：assistant 带 N 个 tool_calls，后面必须跟 N 个 tool 消息）。

**修法**：加深度比较（可以只比 `id` 数组）。

**为什么没做**：要写深比较，代码变长。

**但考虑到第 8 步的风险**，**这一条应该在写第 8 步之前补上**。

#### 缺陷 5 · `load` 不校验 `seq` 连续性

**问题**：日志被手工改过（删了一行）时，**`seq` 会跳号但没人检查**。

**后果**：`seq` 的"可用于校验完整性"这个价值没被利用。

**修法**：见挑战题 2。

#### 缺陷 6 · 未知事件类型被静默保留

```ts
for (const line of text.split('\n')) {
  if (line.trim() === '') continue
  session.#events.push(JSON.parse(line) as SessionEvent)
}
```

**问题**：**完全不做类型检查** —— 任何 JSON 对象都被当作事件接受。

**后果**：

- 一个格式错误的行会被接受（只要它是合法 JSON）
- 未知事件类型会被保留（这**可能是好事**，见下）

**DSH 在这里是严格的**：

> 「`SessionEventMap` members are **required-on-read** by default — builds that do not know a type **refuse the log** unless the event carries the envelope's `ignorable: true`」

**它为什么严格？** 因为**"不认识就跳过"会导致静默的信息丢失** —— 你以为读了完整日志，其实少了东西。

**我们的选择更宽松**（认识的就用，不认识的跳过），**代价是"可能在不知情的情况下丢信息"**。

**这在科研里是危险的** —— **你的会话统计可能基于不完整的日志**。

#### 缺陷 7 · 没有并发保护

`#events.push(...)` 在单进程单线程的 Node 里是安全的（JS 是单线程的）。

**但如果日志文件被两个进程同时写**：

```
进程 A 写入 seq 0..10
进程 B 也写入 seq 0..5     ← 序号冲突
```

**后果**：日志错乱，`seq` 不再连续。

**修法**：文件锁 / 排他写 / 追加模式（`appendFile` 而不是 `writeFile`）。

**为什么没做**：单进程场景不需要。

**但注意 `save()` 用的是 `writeFile`（覆盖写）** —— **两次 save 会互相覆盖**。

**这在第 11 步的 CLI 里会成为问题**（如果支持多个会话并行）。

---

## L10 提问训练

### 本篇引出的 12 个好问题

**关于设计（L3 层）**

1. 为什么 `deriveMessages` 是独立的纯函数，而 `Session` 里还要包一层？
2. 为什么 `seq` 用 `length` 而不是时间戳或 UUID？
3. 为什么 `load` 要恢复 `#nextTurn` / `#nextStep`？忘了会怎样？
4. 为什么补的 `turn/end` 用 `reason: 'error'` 而不是 `'complete'`？
5. 为什么 `save` 要自己建目录，而不是要求调用方建？

**关于系统（L4 层）**

6. 第 8 步怎么用 `deriveMessages` 构造请求？**每一轮都重新派生吗？**
7. **如果有 10 万条事件，每次请求都重新派生会不会太慢？** 怎么优化？
8. 第 9 步的重试为什么依赖"日志不可变"？
9. **第 10 步的压缩应该"删事件"还是"加一个压缩后的事件"？**

**关于科研（L5 层）**

10. ★ **怎么从日志算"全部题平均步数"和"成功题平均步数"？"成功"用什么判据？**
11. ★ **如果日志能完整重建请求，那"最小可复现包"还缺什么？**（提示：模型参数、工具 schema、环境）
12. ★ **"干预 vs 自我修正"实验里，干预的触发能从日志的哪些事件看出来？**

### 问题升级练习

| 模糊问题 | 精确问题 | 提升在哪 |
|---|---|---|
| "为什么要日志？" | "如果没有日志，只有内存里的消息数组，**改了消息拼装逻辑之后，你能验证旧实验的结果还会一样吗？**" | 指向了**可复现性**这个具体需求 |
| "为什么不直接存消息？" | "如果同时存消息和日志，**某次改动只更新了一边**，你怎么发现？" | 指出了**不一致的不可发现性** |
| "统计有什么用？" | "导师问'平均完成步数'，**这个数字由哪些事件算出来？失败题的步数要不要算进去？**" | 要求**具体到事件类型和判据** |

> ### 你的练习
>
> 挑一个改写，发给我：
>
> 1. "日志为什么要 append-only？"
> 2. "派生是什么意思？"
> 3. ★ **"我的实验要统计'干预触发率'，能只靠现在的日志算出来吗？"**

---

## L11 系统影响回溯

### 11.1 三个预判的检验

| 第 0.5 节的问题 | 现在你应该能答的 |
|---|---|
| `tool/call` 的信息已有，为什么还单独记？ | **因为它让统计不用解析嵌套结构**；而且"模型要求"和"我们真的调用了"是两件事（见 4.2 演示 1） |
| 再加一个 `step/start`，两个数字各变成几？ | 事件总数 12；**消息数仍是 4**（`step/start` 是过程事件） |
| 要支持 fork，数据结构要做什么？ | 需要"从某个 seq 之后的事件"；`seq` 已经提供了这个能力 —— **但副本的策略要定**（复制全部还是引用前缀） |

**第 3 个问题值得展开**：

**`seq` 的存在让 fork 成为可能**：

```ts
function forkAt(session: Session, seq: number): Session {
  const child = new Session(`${session.id}-fork`)
  for (const event of session.events.slice(0, seq + 1)) {
    child.append(event.type as SessionEventType, event.data as never)
  }
  return child
}
```

**但这里有个问题**：`append` 会**重新分配 seq 和 time** —— 而 fork 应该**保留原事件的 seq/time**。

**所以需要另一个方法**（`loadFrom(events)`）—— **而 `load` 的实现里已经有这个逻辑了**（它直接 push）。

**这说明"从事件数组构造 Session"应该被抽成一个方法** —— 现在是 `load` 内部的私有逻辑。

**写进第 8 步的设计笔记**（因为 fork 是第 8 步的子 agent 需要的）。

### 11.2 本篇的"锚点"一句话

> **只存事实，其余全部算出来；事实只追加，永不修改。**

它在后面的影子：

| 哪一步 | 同一思想的再现 |
|---|---|
| 第 8 步 | 循环只做"append 事件 + 派生请求"，不维护内存状态 |
| 第 9 步 | 重试是"再 append 一次"，不是"修改上次的记录" |
| 第 10 步 | 压缩是"加一条压缩事件"，不是删事件 |
| 第 14 步 | 检索是在日志之上的索引，不改日志 |
| **第 15 步** | **诊断是从日志算出来的结论，不是另存一份** |
| **第 16 步** | **演化是"改配置 + 跑新的会话"，旧会话不变** |

**第 15、16 步和第 7 步是同一个模式** —— **"从事实算出结论，而不是维护结论"。**

### 11.3 通向第 8 步的桥

**第 7 步结束时，系统状态：**

```
✅ 日志能记录、派生、统计、持久化、校验
✅ 一切机制（插件/事件/隔离/配置/日志）都齐了
❌ 但没有"循环"：插件装好了，但没人驱动"请求 → 工具 → 再请求"
❌ 一次任务要手工 append 一堆事件
```

**第 8 步要解决"驱动"。** 带着这些问题进入：

1. 循环要做什么？**（提示：把 4.2 演示 1 的那段手工代码自动化）**
2. **什么时候算"结束"？** 有几种结束方式？
3. **一次模型请求要求多个工具时，怎么处理？** 顺序还是并发？
4. **assistant 消息带 N 个 `tool_calls`，后面必须跟 N 个 tool 消息** —— 这个规则怎么保证？
5. **如果模型一次都不调用工具（直接回答），循环应该走几步？**
6. ★ **循环应该在哪里调用 `assertModelVisibleMatchesLog`？** 每一次请求前都调吗？

**第 6 个问题是第 7 步缺陷 4 的直接延续** —— 因为第 8 步是最容易出"tool 消息配对错误"的地方。

---

## 本篇完结

| 检查项 | 应该达到 |
|---|---|
| **能完整解释 "Model-visible ⟺ logged"** | L1 |
| 能说出表面/过程事件的划分标准 | L1 |
| 能解释"为什么只提供 append" | L1 |
| **能关掉文档写出 `deriveMessages`** | **L3** |
| 能写出 `load` 的三步 | L3 |
| 能说出统计字段与导师问题的对应 | L4 |
| **能说出 `tokens` 计算的 bug 及其危害** | L4 |
| 能提出至少 3 个 L4/L5 层的问题 | L4 |

---

**读完这篇，请回答我三个问题：**

1. **`tokens` 的 bug**：演示 3 输出 360，正确值是 180。**你觉得这类"看起来对但错一倍"的 bug，在真实项目里应该怎么防？**（提示：可以用什么测试手段）

2. **缺陷 6**（未知事件类型被静默保留）：DSH 的选择是"**不认识就拒绝加载整个日志**"，我们的是"跳过"。**你倾向哪个？为什么？** 这个选择在科研场景下尤其重要。

3. **下一站**：`08-agent-loop.md`（循环 —— Phase 2 的核心），还是先补一补前面的？

**我建议直接进 `08-agent-loop.md`** —— 因为第 7 步的所有机制都准备好了，第 8 步是**把它们全部串起来**的那一步。**写完之后，你的 harness 就真的能跑任务了。**
# 第 9 步 · 重试

> **代码**：`src/kernel/retry.ts`（约 230 行） · **改动**：`agent.ts`（加重试）、`session.ts`（加 `assistant/attempt` 事件）
> **演示**：`src/demos/demo-retry.ts`
> **DSH 对应**：`packages/llm/llm-retry/src/index.ts`（挂在 `agent/request-error` 上）
> **本篇目标级别**：L3（关掉文档能从零重写）
> **预计阅读**：70–100 分钟 · **预计动手**：80 分钟

---

## 本篇新词

| 词 | 一句话 | 为什么必须懂 |
|---|---|---|
| **重试策略** | 决定"要不要重试、等多久、几次"的配置 | 三个问题的答案 |
| **有界重试（normal）** | 只重试列出的错误码，次数有限 | 默认模式 |
| **无界重试（always）** | 除取消除外都重试，没有次数上限 | 用于"必须成功"的场景 |
| **指数退避** | 每次等待时间翻倍 | 给服务端恢复时间 |
| **抖动（jitter）** | 在等待时间上加随机量 | 避免"惊群" |
| **`Retry-After`** | 服务端告诉你的等待时间 | 比本地猜测准 |
| **失败尝试** | 一次不成功的请求 | ★ **它也是持久事实，要进日志** ★ |

---

## 第 0 节 · 这一步的成品长什么样

### 0.1 你会写出什么

```
┌────────────────────────────────────────────────────────────────────┐
│  retry.ts（约 230 行，新增）                                        │
│                                                                    │
│  一、配置                                                          │
│    ① BackoffConfig / NormalRetryPolicy / AlwaysRetryPolicy         │
│    ② RetryPolicy / ResolvedRetryPolicy                            │
│                                                                    │
│  二、默认值                                                        │
│    ③ DEFAULT_RETRYABLE_CODES  ★ 第 1 步错误分类的落地               │
│    ④ 四个默认常量（5 次 / 500ms / 10s / ±10%）                      │
│                                                                    │
│  三、解析                                                          │
│    ⑤ resolveRetryPolicy()   填默认值                               │
│                                                                    │
│  四、三个决策                                                      │
│    ⑥ shouldRetry()          ★ 要不要重试                           │
│    ⑦ computeDelayMs()       ★ 等多久                               │
│                                                                    │
│  五、工具                                                          │
│    ⑧ errorCodeOf / retryAfterOf / messageOf                        │
│    ⑨ sleep()                ★ 可取消的等待                         │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  对前几步的改动                                                    │
│    session.ts  + 'assistant/attempt' 事件（★ 非表面）               │
│                + recordAttempt() / stats().attempts                │
│    agent.ts    + retryPolicy 选项                                  │
│                + #request()（重试循环）                             │
│                + run() 的取消语义修正                               │
└────────────────────────────────────────────────────────────────────┘
```

### 0.2 运行起来是什么样

```powershell
node src/demos/demo-retry.ts
```

关键输出：

```
--- 结果 ---                      {"status":"complete","steps":1,"text":"成功了（共尝试 3 次）"}
--- provider 实际被调用几次 ---     3
--- 事件流 ---
["0 turn/start","1 user/message","2 step/start","3 assistant/attempt",
 "4 assistant/attempt","5 assistant/message","6 step/end","7 turn/end"]

--- 统计（★ 注意 attempts）---
{"turns":1,"steps":1,"toolCalls":0,"toolErrors":0,"tokens":0,"attempts":2,"messages":2}

--- AUTH 立刻失败 ---
provider 被调用几次（应该是 1）--- 1

--- 取消打断退避 ---
{"status":"cancelled","steps":0,"text":""}
耗时（ms）—— 远小于 30000 说明取消打断了退避 --- 62
```

**三行最值得注意**：

| 观察 | 说明了什么 |
|---|---|
| **两条 `assistant/attempt`** | **失败的尝试进了日志** |
| **`attempts: 2`** | **"重试了几次"可统计** |
| **AUTH 只调用 1 次** | **第 1 步的错误分类在这里兑现** |

---

## 第 0.5 节 · 系统视角

### 你在哪里

```
                    ★ 第 8 步 agent 循环 ★
                              │
                              │ 在"请求模型"这一步插入
                              ▼
                    ┌─────────┴─────────┐
                    │ 【第 9 步】        │
                    │ 重试               │
                    │ ▶ 你在这里 ◀        │
                    └─────────┬─────────┘
                              │ 用第 1 步的错误分类
                              ▼
                    第 1 步 · LLMErrorCode
```

**这是第一个"插在循环上的机制"。**

**而那个"怎么插"的模式，会在第 10、15、16 步反复用到** —— **所以这一步的形式比它的内容更重要。**

### 下游：谁在用重试

| 第 9 步的产物 | 谁消费 | 用来做什么 | 依赖强度 |
|---|---|---|---|
| `shouldRetry` / `computeDelayMs` | 第 10 步（也可能要重试工具） | 复用它 | 🟡 中 |
| `sleep(ms, signal)` | 第 10 步的超时 | 可取消的等待 | 🟡 中 |
| `stats().attempts` | **你的台账** | **"重试了几次"** | 🔴 强 |
| `assistant/attempt` 事件 | 第 15 步的诊断 | 归因"失败是模型问题还是网络问题" | 🔴 强 |
| "插在循环上"的模式 | 第 10、15、16 步 | **设计模板** | 🔴 强 |

**第三行是给你的**：

> **"重试次数"是一个真实的研究指标** —— 比如"干预让重试次数下降了多少"。
> **而它只有在"失败的尝试也进日志"时才可统计。**

### 连锁影响分析

#### 连锁 1：如果不记"失败的尝试"

```
一次请求失败了 3 次才成功
   ↓
日志里只有最终成功的那一次
   ↓
★ 统计显示"尝试 1 次" ★
   ↓
你的台账里"重试次数"永远是 0
   ↓
★ 而"重试次数"恰恰是很多结论的关键变量 ★
```

**更隐蔽的后果**：

```
你想研究"干预是否减少了无效重试"
   ↓
但重试根本没被记录
   ↓
★ 这个研究问题无法回答 ★
```

**这就是我们加 `assistant/attempt` 的理由。**

#### 连锁 2：如果重试改变了请求内容

```
重试时重新派生了消息（而不是用原来那份）
   ↓
如果这期间日志变了（比如别的代码加了东西）
   ↓
★ 重试发的和第一次发的不是同一份 ★
   ↓
你无法说"这次重试是在同样的输入下进行的"
```

**我们的做法**：**`messages` 在 `#request` 之外派生一次，重试时原样重发。**

**演示 6 验证了这一点**：

```
--- 演示 1 的最终消息数 ---  2
--- 演示 1 的事件数 ---      8
    差值 = 过程事件 + 失败的尝试 —— 它们都不进模型历史。
```

**两条消息 = user + assistant**（失败的尝试没进历史）。

#### 连锁 3：如果取消不能打断退避

```
一次退避 30 秒
   ↓
用户在这期间按了 Ctrl+C
   ↓
如果 sleep 不响应 signal：要等完 30 秒才返回
   ↓
★ "取消"形同虚设 ★
```

**演示 5 验证了打断**：

```
--- 耗时（ms）—— 远小于 30000 说明取消打断了退避 --- 62
```

**62ms vs 30000ms。**

**实现的关键**：`sleep(ms, signal)` 监听 `abort` 事件并提前 resolve。

### 现在该建立的三个习惯

| 习惯 | 做法 | 训练什么 |
|---|---|---|
| **失败的尝试也是事实** | 记它（但要和"表面事实"分开） | 数据的完整性 |
| **重试必须发同一份请求** | 先派生，再重试循环 | 可复现性 |
| **任何等待都要可打断** | 传 signal 进 sleep | 响应性 |

> ### 停下来想一想（不给答案）
>
> 1. `assistant/attempt` **不是表面事件**，所以不进模型历史。**如果让它进呢？** 会有什么后果？
> 2. 演示 5 里取消返回了 `status: 'cancelled'`。**但此刻 provider 可能正在处理一个请求** —— 我们能确定它没被计费吗？
> 3. `sleep` 的取消是"提前 resolve"而不是"reject"。**这个选择有什么影响？**

---

## L0 要解决的问题

### 0.1 第 8 步留下的具体缺陷：**失败即抛**

```ts
// 第 8 步
const response = await this.#provider.chat(messages, this.#tools.schemas(), signal)
```

**一次 429 限流 → 整个任务失败。**

**具体现象**：

| 情况 | 第 8 步的行为 | 应该的行为 |
|---|---|---|
| 网络抖动一下 | **任务失败** | 重试一次就过了 |
| 服务端 503 | **任务失败** | 等几秒再来 |
| 命中了限流 | **任务失败** | 按 `Retry-After` 等 |
| 密钥错误 | 任务失败 | ✅ 对（不该重试） |

**只有第 4 种是对的。**

### 0.2 更重要的是：第 1 步埋下的种子终于要发芽

**回看第 1 步的原文**：

> 「**不知道错在哪一类，就不知道要不要重试。**」

**当时我们把错误分成了 8 类**，并标注了每类"该重试吗"。

**现在，那些标注要变成代码。**

### 0.3 这一步要回答的三个问题

| # | 问题 | 本篇位置 |
|---|---|---|
| 1 | **要不要重试？** | `shouldRetry`（1.2） |
| 2 | **等多久？** | `computeDelayMs`（1.3） |
| 3 | **最多几次？** | 策略配置（1.2） |

**外加两个"怎么做才对"的问题**：

| # | 问题 | 位置 |
|---|---|---|
| 4 | 重试发的是同一份请求吗？ | 1.4 |
| 5 | 失败的尝试要不要记？ | **1.5** |

---

## L1 设计与原理

### 1.1 三个问题，一个函数一个

```ts
shouldRetry(policy, error, attempt)          → 要不要重试
computeDelayMs(policy, attempt, retryAfter)  → 等多久
policy.maxRetries                            → 最多几次
```

**三个都是纯函数**（除了 `computeDelayMs` 有随机数）—— **可以单独测试**。

**这和前面的设计一致**：把"决策逻辑"抽成纯函数，把"执行"留在有状态的地方。

### 1.2 ★ 错误分类的兑现 ★

```ts
export const DEFAULT_RETRYABLE_CODES: readonly LLMErrorCode[] = [
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
]
```

**这五行就是第 1 步那张表的落地。**

**回看第 1 步的表格**：

| code | 该重试吗 | 为什么 |
|---|---|---|
| `RATE_LIMIT` | ✅ | 等一会儿服务端就恢复了 |
| `SERVER` | ✅ | 是服务端的临时问题 |
| `TIMEOUT` | ✅ | 网络抖动 |
| `TRANSPORT` | ✅ | 网络问题 |
| `EMPTY_RESPONSE` | ✅ | 网关抖动的常见表现 |
| `AUTH` | ❌ | key 错了，重试一万次也一样 |
| `INVALID_REQUEST` | ❌ | 你的请求有问题 |
| `UNKNOWN` | ❌（保守） | 没有信息 |

**而 `CANCELLED`（第 8 步加的）也不在里面** —— 下面单独讲。

#### `shouldRetry` 的三个判断

```ts
export function shouldRetry(policy, error, attempt): boolean {
  const code = errorCodeOf(error)

  // ★ 取消永远不重试 —— 无论什么模式
  if (code === 'CANCELLED') return false

  // always 模式：除了取消，什么都重试
  if (policy.mode === 'always') return true

  // normal 模式：先看预算，再看错误码
  if (attempt > policy.maxRetries) return false
  return code !== undefined && policy.retryableCodes.has(code)
}
```

**三个判断的顺序是有意的**：

| 顺序 | 判断 | 为什么排在这 |
|---|---|---|
| 1 | `CANCELLED` | **最高优先级** —— 它必须凌驾于所有模式之上 |
| 2 | `always` 模式 | 模式判断（不看重试码） |
| 3 | 预算 + 错误码 | normal 模式的两个条件 |

**第 1 条为什么必须在最前面？**

因为**它要覆盖 `always` 模式**：

```
always 模式的语义是"什么都重试"
   ↓
但如果用户取消了，还要重试吗？
   ↓
★ 不 —— 用户不要了 ★
```

**所以 `CANCELLED` 检查必须在 `always` 之前。**

**这是"特例优先于通例"的又一例**（第 1 步的 `codeForStatus` 里 429 要排在 4xx 前面，同一个道理）。

#### 一个容易被忽略的点：`UNKNOWN` 不可重试

```ts
return code !== undefined && policy.retryableCodes.has(code)
```

**如果错误没有 `code`（或 code 是 `UNKNOWN`）→ 不重试。**

**为什么？**

> **对不知道是什么的错误重试，是赌博。**

**代价**：可能错过一些"其实能重试"的情况。

**收益**：**不会对"永久性错误"做无意义的重复**。

**而 `always` 模式给了另一条路** —— 如果你确实想"什么都重试"，就用它。

### 1.3 退避：两条规则，优先级明确

```ts
export function computeDelayMs(policy, attempt, retryAfterMs?): number {
  // ① 服务端的建议优先 —— 但只在它不超出我们上限时
  if (retryAfterMs !== undefined && retryAfterMs <= policy.maxDelayMs) {
    return retryAfterMs
  }

  // ② 本地指数退避：initial × 2^(attempt-1)，封顶 maxDelayMs
  const exponential = policy.initialDelayMs * 2 ** Math.max(0, attempt - 1)
  const capped = Math.min(exponential, policy.maxDelayMs)

  // ③ 对称抖动 —— 避免大量客户端同时重试造成"惊群"
  const factor = 1 + (Math.random() * 2 - 1) * policy.jitterRatio
  return Math.max(0, Math.round(capped * factor))
}
```

#### ① 为什么"服务端的建议"要穿上限

```ts
if (retryAfterMs !== undefined && retryAfterMs <= policy.maxDelayMs) {
```

**为什么要判 `<= maxDelayMs`？**

因为**服务端可能给一个荒谬的值**：

```
Retry-After: 3600        ← 一小时
```

**如果无条件听它的，一次重试要等一小时** —— 而调用方可能只想要一个 10 秒的任务。

**所以"听服务端的，但不超过我自己的上限"。**

**这是"两个权威冲突时怎么选"的一个实例** —— 我们选"以本地策略为界"。

#### ② 指数退避的公式

```
delay = initialDelayMs × 2^(attempt - 1)
```

**展开**（initial = 500）：

| attempt | 2^(n-1) | 延迟 |
|---|---|---|
| 1 | 1 | 500ms |
| 2 | 2 | 1000ms |
| 3 | 4 | 2000ms |
| 4 | 8 | 4000ms |
| 5 | 16 | 8000ms |
| 6 | 32 | 16000 → **封顶 10000** |

**`Math.max(0, attempt - 1)`** 是为了处理 `attempt = 0`（虽然不该发生）。

**`Math.min(..., maxDelayMs)`** 是封顶。

**为什么指数？**

| 策略 | 问题 |
|---|---|
| 固定间隔 | 要么太急（又撞限流），要么太慢（浪费时间） |
| **指数** | **先快后慢** —— 短暂抖动快速恢复，持续故障不浪费 |
| 线性 | 增长太慢 |

#### ③ 抖动：为什么要随机

```ts
const factor = 1 + (Math.random() * 2 - 1) * policy.jitterRatio
```

**`Math.random() * 2 - 1`** 产生 `[-1, 1)` 的随机数。

**乘以 `jitterRatio`（默认 0.1）** 得到 `[-0.1, 0.1)`。

**加 1** 得到 `[0.9, 1.1)` —— **±10% 的对称抖动**。

**为什么需要？**

```
假设有 1000 个客户端同时被限流
   ↓
它们的退避时间都是 500ms
   ↓
★ 500ms 后它们同时重试 ★
   ↓
服务端又被瞬间打垮
   ↓
★ 无限循环 ★
```

**抖动让它们的重试时间分散开。**

**这个现象叫"惊群（thundering herd）"** —— 而抖动是标准解法。

#### `Math.round` 与 `Math.max(0, ...)`

```ts
return Math.max(0, Math.round(capped * factor))
```

| 操作 | 为什么 |
|---|---|
| `Math.round` | `setTimeout` 接受小数没问题，但取整更干净 |
| `Math.max(0, ...)` | **保证非负**（如果 jitterRatio > 1，factor 可能为负） |

**第二条是防御性的** —— 因为 `jitterRatio` 是配置，理论上可以配成大于 1。

**虽然 schema 应该挡住它，但这里多一层保护成本极低。**

### 1.4 ★ 重试发的是同一份请求 ★

**这是"可复现性"的要求。**

#### 实现

```ts
async #step(signal?: AbortSignal): Promise<string | undefined> {
  const step = this.#session.startStep()
  const messages = this.#session.deriveMessages()      // ← 只派生一次
  assertModelVisibleMatchesLog(this.#session, messages)
  const response = await this.#request(messages, signal)   // ← 传进去，重试时复用
  // …
}
```

**`messages` 在 `#request` **外面**派生，然后传进去。**

**`#request` 内部的重试循环不重新派生。**

#### 为什么不重新派生

**因为"重试"的语义是"把同一件事再做一次"。**

| 做法 | 语义 |
|---|---|
| **用同一份 messages** | ✅ "同样的请求，再发一次" |
| 重新派生 | ⚠️ "用最新的状态，再问一次" —— **那是另一个操作** |

**差别在什么时候显现？**

```
请求失败
   ↓
在退避等待期间，用户又发了一条消息（进了日志）
   ↓
如果重新派生 → 重试时会带上那条新消息
   ↓
★ 这次"重试"实际上是一个新请求 ★
```

**而我们用同一份** —— **失败重试和用户输入是两件事，不该混在一起。**

#### 演示 6 的验证

```
--- 演示 1 的最终消息数 ---  2
--- 演示 1 的事件数 ---      8
```

**8 个事件 = turn/start + user/message + step/start + 2×assistant/attempt + assistant/message + step/end + turn/end**

**而消息只有 2 条**（user + assistant）—— **两条失败的尝试没有进历史。**

**这就是"先派生、再重试"的直接结果。**

### 1.5 ★ 失败的尝试要进日志 ★

**这一节是本篇最重要的设计。**

#### 问题

**第 8 步的日志词汇表里，没有"一次失败的尝试"这个事件。**

**所以三次失败一次成功的请求，日志看起来像"一次成功"。**

#### 解法：加一个非表面事件

```ts
'assistant/attempt': { attempt: number; code: string; message: string }
```

**注意它不在 `SURFACE_EVENT_TYPES` 里**：

```ts
export const SURFACE_EVENT_TYPES: ReadonlySet<string> = new Set<SessionEventType>([
  'user/message',
  'assistant/message',
  'tool/result',
])      // ← 'assistant/attempt' 不在里面
```

**于是它：**

| 性质 | 值 |
|---|---|
| 进日志 | ✅ |
| 进模型历史 | ❌ |
| 可统计 | ✅（`stats().attempts`） |

#### 为什么"不进模型历史"是对的

**因为失败的尝试不是"对话的一部分"。**

```
如果让模型看到：
   assistant: （失败，无内容）
   assistant: （失败，无内容）
   assistant: "你好"
   ↓
★ 模型会困惑："我前面两次为什么什么都没说？" ★
```

**而日志的作用不是"给模型看"，是"给人看 / 给统计看"。**

#### 这正是 DSH 的做法

**回看第 7 步引用过的 DSH 文档**：

> 「`assistant/attempt` retains **settled failed, retried, cancelled, and stream-error attempts** without adding model history」

**完全一致的设计。**

**这说明"失败的尝试需要被记录，但不该进模型历史"是一个收敛的结论** —— 我们和 DSH 独立得出了同一个答案。

#### 这个改动对科研的价值

**它让三个新指标变得可算**：

| 指标 | 怎么算 |
|---|---|
| **重试次数** | `stats().attempts` |
| **重试成功率** | `attempts > 0 且 status === 'complete'` 的比例 |
| **重试分布** | 每个任务的 `attempts` 分布 |

**而"干预是否减少了无效重试"这类问题，就靠第一个指标。**

### 1.6 取消的三条路径：统一语义

**演示 5 暴露了一个不一致**，值得单独讲。

#### 问题

**"取消"可能发生在三个位置**：

| 位置 | 第 8 步的行为 |
|---|---|
| ① 循环开头的检查 | ✅ 返回 `status: 'cancelled'` |
| ② 退避等待期间 | ❌ **抛出错**（被当成 error） |
| ③ 请求进行中 | ❌ 抛 `CANCELLED` 错误，被当成 error |

**同一种"取消"，三种表现。**

#### 修正

**两处改动**：

**① `#request` 在取消时抛明确的 `CANCELLED`**

```ts
if (signal?.aborted === true) {
  throw new LLMError('CANCELLED', '请求在重试等待期间被取消')
}
```

**注意：不是抛原来那个错误（比如 `SERVER`）** —— 否则调用方无法区分。

**② `run` 的 catch 里识别取消**

```ts
if (signal?.aborted === true || errorCodeOf(error) === 'CANCELLED') {
  this.#session.endTurn(turn, 'cancelled')
  return { status: 'cancelled', steps: completedSteps, text: '' }
}
```

**为什么要判 `signal?.aborted`（而不只判错误码）？**

**因为"取消"的真相是"信号被中止了"，不是"错误码是 CANCELLED"。**

**错误码是二手证据，信号是一手证据。**

**两者都查 = 双保险。**

#### `steps` 语义的同步修正

**原实现有个不一致**：

```ts
// 循环开头取消
return { status: 'cancelled', steps: step - 1, text: '' }     // ← 当时算的
```

**而 catch 里拿不到 `step`。**

**修正**：用一个 `completedSteps` 变量：

```ts
let completedSteps = 0

for (let step = 1; step <= this.#maxSteps; step += 1) {
  // …
  const finalText = await this.#step(signal)
  completedSteps = step              // ← 这一步真的走完了
  // …
}
```

**于是三条路径都用 `completedSteps`，语义统一为"**完整走完的步数**"。**

**这个统一让"取消时走了几步"变得可解释** —— 而不是"看在哪取消的"。

> ### 停下来想一想（不给答案）
>
> 1. `shouldRetry` 里 `CANCELLED` 的检查在 `always` 判断**之前**。**如果放后面会怎样？**
> 2. 退避的抖动让"等待时间"变得**不可预测**。**这对复现实验有影响吗？** 怎么解决？
> 3. `assistant/attempt` 记了 `message`（错误信息）。**这段文字会不会有敏感信息？**（提示：API key 可能出现在错误里）

---

## L2 决策表

| # | 决策 | 我们的选择 | 替代方案 | 代价落在谁身上 |
|---|---|---|---|---|
| 1 | 重试判断依据 | **错误码** | 无条件重试 / 无条件不重试 | 依赖第 1 步分类的准确性 |
| 2 | 未知错误的默认 | **不重试** | 重试 | 可能错过可恢复的情况；换来不浪费在永久错误上 |
| 3 | `CANCELLED` | **永远不重试** | 按模式 | 无；纯正确性要求 |
| 4 | 退避形状 | **指数（2^n）** | 固定 / 线性 | 简单；换来"先快后慢"的适应性 |
| 5 | 抖动 | **±10% 对称** | 无抖动 / 只有正向 | 等待不可预测；换来避免惊群 |
| 6 | `Retry-After` | **优先，但穿上限** | 无条件听 / 忽略 | 两个权威冲突时要选一个 |
| 7 | 重试的请求 | **同一份 messages** | 重新派生 | 可能发出"过期"的请求；换来可复现 |
| 8 | 失败尝试 | **进日志（非表面）** | 不记 | 日志变大；换来可统计 |
| 9 | 重试位置 | **在 `#request` 内** | 装饰 Provider | 改了 agent；换来能记录尝试 |
| 10 | 等待 | **可取消的 sleep** | 普通 setTimeout | 多几行；换来取消防响应快 |

### 关于第 9 条的完整论证

**为什么不在 provider 层做重试（装饰器模式）？**

```ts
// 装饰器方案
class RetryingProvider implements Provider {
  constructor(private inner: Provider, private policy: RetryPolicy) {}

  async chat(messages, tools, signal) {
    // 重试循环
  }
}

// 用法
const agent = new Agent({ provider: new RetryingProvider(realProvider, policy), … })
```

**它更优雅**（对 Agent 透明，符合"插件"思想）。

**但它有个致命问题**：**provider 层不知道 `session`，所以无法记录失败的尝试。**

```
装饰器里的重试
   ↓
agent 只知道"最后成功了"
   ↓
★ `assistant/attempt` 无法被记录 ★
   ↓
★ 你失去了"重试了几次"这个指标 ★
```

**而"能记录"比"优雅"更重要**（对科研尤其）。

**所以我们现在选"在 agent 层重试"。**

**但注意**：**第 11 步之后，agent 会变成插件** —— **那时可以用"事件"把这个决策挂在延展点上**，既优雅又能记录。

**DSH 做的正是这个**：重试是挂在 `agent/request-error` 事件上的插件。

> **这是一个"当前方案会被未来取代"的例子 —— 而原因很清楚：我们还没有插件化的 Agent。**

### 关于第 8 条的完整性论证

**日志会变大多少？**

**一次成功的重试加一条 `assistant/attempt`。**

**如果 10% 的请求需要重试**，日志大约**增大 10%**。

**而它换来的信息是不可替代的。**

**另一个考虑**：`message` 字段可能很长（服务端返回的错误详情）。

**我们的 `messageOf` 原样取 `error.message`** —— 而第 1 步的 `LLMError` 里，HTTP 错误的 message 包含了服务端响应的前 800 字符。

**所以一次失败可能给日志加 800 字符。** 这是**要写进 L9 的**（可能需要截断）。

> ### 停下来想一想（不给答案）
>
> 1. 第 2 条说"未知错误不重试"。**如果某个 provider 的所有错误都没有 code，会怎样？**（提示：第 1 步的 `DeepSeekProvider` 有 code 吗？）
> 2. 第 5 条的抖动让等待时间随机。**如果做对照实验，两个组都用抖动，会不会引入噪声？**
> 3. **如果重试在 provider 层（装饰器），但同时也想记录 —— 有没有两全的办法？**

---

---

## L3 实现：逐行讲解

### 3.0 文件结构

```
┌─── 一、配置类型（30–90 行）    5 个接口 + 2 个联合
├─── 二、默认值（95–110 行）     ★ DEFAULT_RETRYABLE_CODES
├─── 三、解析（115–145 行）      resolveRetryPolicy
├─── 四、三个决策（150–200 行）  ★ shouldRetry / computeDelayMs
└─── 五、工具（205–265 行）      errorCodeOf / sleep ★
```

### 3.1 文件头注释：把第 1 步的原话引回来（第 1–20 行）

```ts
/**
 * 第 9 步 ｜ 重试：什么时候重试、等多久、最多几次
 *
 * 第 1 步埋下的那颗种子（`LLMErrorCode`）在这里**兑现**。
 *
 * 看第 1 步的原话：
 *   「不知道错在哪一类，就不知道要不要重试。」
 *
 * 现在这句话变成了代码：
 *   - `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT` / `EMPTY_RESPONSE` → **重试**
 *   - `AUTH` / `INVALID_REQUEST`                                       → **不重试**
 *   - `UNKNOWN`                                                        → **不重试**（保守）
 *   - ★ `CANCELLED`                                                     → **永不重试**
 *
 * ── 三个问题 ──────────────────────────────────────────────────────────
 *
 * ① **要不要重试？**  → 看错误码（`shouldRetry`）
 * ② **等多久？**      → 指数退避 + 抖动，服务端给了 `Retry-After` 就听它的（`computeDelayMs`）
 * ③ **最多几次？**    → 策略配置（normal 有上限，always 无上限）
 */
```

**这段注释最值得学的地方是：它把第 1 步的原话引回来了。**

> 「不知道错在哪一类，就不知道要不要重试。」

**这句话在第 1 步是一句"设计理由"；在这里它变成了"可直接对照的规则表"。**

**这让读者能立刻看到"那句话到底兑现成了什么"。**

**而且它把 8 个错误码按"重试/不重试"分成了两组** —— **这是全篇最实用的一段速查。**

### 3.2 配置类型（第 25–90 行）

```ts
/** 退避参数。 */
export interface BackoffConfig {
  /** 初始退避毫秒数（默认 500）。 */
  readonly initialDelayMs?: number
  /** 退避上限毫秒数（默认 10000）。 */
  readonly maxDelayMs?: number
  /** 对称抖动比例，0–1（默认 0.1 = ±10%）。 */
  readonly jitterRatio?: number
}

/** **有界**重试：只重试列出的错误码，次数有限。 */
export interface NormalRetryPolicy {
  readonly mode: 'normal'
  readonly maxRetries?: number
  readonly retryableCodes?: readonly LLMErrorCode[]
  readonly backoff?: BackoffConfig
}

/** **无界**重试：任何失败都重试（取消除外），直到成功或放弃。 */
export interface AlwaysRetryPolicy {
  readonly mode: 'always'
  readonly backoff?: BackoffConfig
}

export type RetryPolicy = NormalRetryPolicy | AlwaysRetryPolicy
```

#### 判别联合：用 `mode` 区分两种策略

```ts
export type RetryPolicy = NormalRetryPolicy | AlwaysRetryPolicy
//                         ↑ mode: 'normal'    ↑ mode: 'always'
```

**这是标准的"可辨识联合"** —— `mode` 字段是判别标签。

**在第 4 步的 `PatchItem` 里我们用的是 `'insert' in item`（用"有没有某字段"判别）；这里是"用某字段的值判别"。**

| 判别方式 | 适用 |
|---|---|
| **值判别**（`mode === 'always'`） | 两种变体都是对象、都有那个字段 |
| **字段存在性**（`'insert' in x`） | 两种变体的字段完全不同 |

**这里是值判别**（都有 `mode` 和 `backoff`）。

#### 为什么 `always` 模式**没有** `maxRetries` 和 `retryableCodes`

**这是类型即文档**：

```ts
interface AlwaysRetryPolicy {
  readonly mode: 'always'
  readonly backoff?: BackoffConfig
  // ★ 没有 maxRetries、没有 retryableCodes
}
```

**你不可能给 `always` 模式配一个"最多重试 3 次"** —— **编译器会报错。**

**对比"一个接口带可选字段"的写法**：

```ts
// 不采用
interface RetryPolicy {
  mode: 'normal' | 'always'
  maxRetries?: number          // ← always 模式下它有意义吗？
  retryableCodes?: string[]    // ← always 模式下它有意义吗？
}
```

**第二种写法下，"always 模式 + maxRetries"是一个"能编译但语义不明"的组合。**

**这是"用类型排除无效状态"的实践**（也叫 "make illegal states unrepresentable"）。

**DSH 的对应**：它的 `retryPolicy` 配置也是这种形态（`mode: 'normal'` 带 `maxRetries`/`retryableCodes`，`mode: 'always'` 不带）。

### 3.3 默认值（第 95–110 行）

```ts
export const DEFAULT_RETRYABLE_CODES: readonly LLMErrorCode[] = [
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
]

export const DEFAULT_MAX_RETRIES = 5
export const DEFAULT_INITIAL_DELAY_MS = 500
export const DEFAULT_MAX_DELAY_MS = 10_000
export const DEFAULT_JITTER_RATIO = 0.1
```

**五个常量，导出。**

**为什么导出常量而不是写死？**

| 理由 | 说明 |
|---|---|
| **测试可以引用** | 测试里断言"重试了 5 次"时，引用常量比写 `5` 好 |
| **可以对照 DSH** | 我们的默认值和 DSH 的 `[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]` **完全一致** |
| **文档可链接** | JSDoc 可以 `{@link}` 到它 |

**第二条特别有意思** —— **我们的默认值和 DSH 的完全一样**。

**这不是巧合**：

> **因为"哪些错误值得重试"这个问题有一个基于事实的答案**（限流会恢复、密钥错不会），
> **所以不同的设计者会得出同一个结论。**

**这又是一个"收敛的设计"** —— 可以类比第 7 步的"追加式 JSONL 做审计"。

### 3.4 `resolveRetryPolicy()`（第 115–145 行）

```ts
export function resolveRetryPolicy(config?: RetryPolicy): ResolvedRetryPolicy {
  const backoff = config?.backoff ?? {}
  const initialDelayMs = backoff.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  const maxDelayMs = backoff.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const jitterRatio = backoff.jitterRatio ?? DEFAULT_JITTER_RATIO

  if (config?.mode === 'always') {
    return {
      mode: 'always',
      maxRetries: Number.POSITIVE_INFINITY,
      retryableCodes: new Set(DEFAULT_RETRYABLE_CODES),
      initialDelayMs,
      maxDelayMs,
      jitterRatio,
    }
  }

  return {
    mode: 'normal',
    maxRetries: config?.maxRetries ?? DEFAULT_MAX_RETRIES,
    retryableCodes: new Set(config?.retryableCodes ?? DEFAULT_RETRYABLE_CODES),
    initialDelayMs,
    maxDelayMs,
    jitterRatio,
  }
}
```

#### 三步：取 backoff → 分模式 → 填默认值

**注意 `backoff` 三个值先统一取出来**（因为两种模式共用）。

**然后按模式分支。**

#### `maxRetries: Number.POSITIVE_INFINITY`

**`always` 模式的最大重试次数是**无穷**。

**为什么不写 `Infinity` 字面量？**

**两者等价**（`Infinity === Number.POSITIVE_INFINITY`），但**显式写法更清楚地表达"这是有意的无穷"**。

**而 `shouldRetry` 里的判断**：

```ts
if (attempt > policy.maxRetries) return false
```

**`attempt > Infinity` 永远是 `false`** —— 所以 always 模式永远不会因预算耗尽而停止。

**这是"用无穷表示无上限"的标准做法。**

**代价**：`attempt` 会一直增长，理论上可能溢出。

**但 `Number.MAX_SAFE_INTEGER` 是 9×10¹⁵** —— **跑到那个次数的重试是不可能的**（时间上）。

#### `retryableCodes` 为什么要转成 `Set`

```ts
retryableCodes: new Set(config?.retryableCodes ?? DEFAULT_RETRYABLE_CODES),
```

**因为 `shouldRetry` 要频繁查询**：

```ts
policy.retryableCodes.has(code)      // O(1)（Set）
```

**对比数组**：

```ts
policy.retryableCodes.includes(code)   // O(n)
```

**n 只有 5，所以差别可忽略** —— **但 `Set` 表达了"这是成员判断"的意图。**

**而且 `ResolvedRetryPolicy.retryableCodes` 的类型是 `ReadonlySet<string>`** —— 和第 7 步的 `SURFACE_EVENT_TYPES` 同样的手法。

#### `??` 链的读法

```ts
config?.maxRetries ?? DEFAULT_MAX_RETRIES
//      ↑ 可能没有 config    ↑ 可能没有 maxRetries     ↑ 兜底
```

**两层可选性**，用 `?.` 和 `??` 串起来。

**这正是这两个运算符存在的意义** —— 否则要写：

```ts
const maxRetries = config !== undefined && config.maxRetries !== undefined
  ? config.maxRetries
  : DEFAULT_MAX_RETRIES
```

**注意 `AlwaysRetryPolicy` 没有 `maxRetries` 字段**，所以 `config?.maxRetries` 只在 normal 分支里有意义。

**编译器能理解吗？**

**在 `if (config?.mode === 'always')` 之后，`config` 的类型被收窄成 `NormalRetryPolicy | undefined`** —— 所以 `config?.maxRetries` 通过类型检查。

**这是"判别标签让编译器收窄类型"的效果。**

### 3.5 `shouldRetry()`（第 150–175 行）★ 核心 ★

```ts
export function shouldRetry(
  policy: ResolvedRetryPolicy,
  error: unknown,
  attempt: number,
): boolean {
  const code = errorCodeOf(error)

  // ★ 取消永远不重试 —— 无论什么模式。
  //   用户不想要了，重试只会让"取消"变得不可靠。
  if (code === 'CANCELLED') return false

  // always 模式：除了取消，什么都重试
  if (policy.mode === 'always') return true

  // normal 模式：先看预算，再看错误码
  if (attempt > policy.maxRetries) return false
  return code !== undefined && policy.retryableCodes.has(code)
}
```

#### 三个判断的完整分析（1.2 节讲过顺序，这里讲**为什么每一条都必要**）

**① `CANCELLED` 检查**

**如果删掉它**：

```
always 模式下，用户取消 → 因为 always 返回 true → ★ 会重试 ★
   ↓
用户按了取消，但请求还在继续
   ↓
★ 取消失效 ★
```

**normal 模式下呢？** `CANCELLED` 不在 `DEFAULT_RETRYABLE_CODES` 里 → 不会重试。

**所以这一条主要是为 `always` 模式存在的。**

**但它也保护了"用户自定义了 `retryableCodes: ['CANCELLED', ...]`"这种情况**：

```
用户把 CANCELLED 加进可重试列表（可能是无意的）
   ↓
如果没有这一条 → normal 模式也会重试取消
   ↓
★ 而用户的本意绝不可能是"取消也重试" ★
```

**所以这一条是"无论配置怎么写，取消都不重试"的硬保证。**

> **这是"安全不变式优先于配置"的例子** —— 有些规则不该被配置覆盖。

**② `always` 模式**

```ts
if (policy.mode === 'always') return true
```

**注意它在"预算检查"之前** —— 因为 `always` 模式的 `maxRetries` 是 `Infinity`，那个检查本来就是 `false`。

**但提前返回更清楚**（读者不用去看 `maxRetries` 是什么）。

**③ 预算 + 错误码**

```ts
if (attempt > policy.maxRetries) return false
return code !== undefined && policy.retryableCodes.has(code)
```

**两个条件用 `&&` 连接**，其中第一个是"有 code"：

```ts
code !== undefined && policy.retryableCodes.has(code)
```

**为什么要判 `code !== undefined`？**

**因为 `Set.has(undefined)` 会返回 `false`**（除非集合里有 `undefined`）—— **所以严格说这个判断是冗余的**。

**但它让 TS 的类型收窄成立**：

```ts
code !== undefined && policy.retryableCodes.has(code)
//                                        ↑ 这里 code 是 string
```

**没有它，`code` 的类型是 `string | undefined`，而 `Set<string>.has` 要求 `string`** —— **编译报错。**

**所以这个判断是"为了让编译器满意"** —— 而且它顺便表达了"没有 code 就不重试"的语义。

> **这是"类型收窄顺带表达了业务规则"的例子。**

### 3.6 `computeDelayMs()`（第 180–200 行）★ 核心 ★

**（1.3 节已详讲两条规则，这里补三个实现细节）**

#### 细节 1：`2 ** Math.max(0, attempt - 1)`

```ts
const exponential = policy.initialDelayMs * 2 ** Math.max(0, attempt - 1)
```

**`2 ** n` 是 JavaScript 的幂运算符**（ES2016）。

**`Math.max(0, attempt - 1)`** 处理 `attempt = 0` 的情况：

| attempt | attempt - 1 | Math.max(0, …) | 2^ |
|---|---|---|---|
| 0 | -1 | **0** | 1 |
| 1 | 0 | 0 | 1 |
| 2 | 1 | 1 | 2 |
| 3 | 2 | 2 | 4 |

**`attempt = 0` 时也得到 `initialDelayMs`** —— **而不是 `initialDelayMs / 2`**（那会是小数）。

**虽然 `attempt` 从 1 开始（我们保证），但防御一下成本极低。**

#### 细节 2：抖动在"封顶之后"

```ts
const capped = Math.min(exponential, policy.maxDelayMs)
const factor = 1 + (Math.random() * 2 - 1) * policy.jitterRatio
return Math.max(0, Math.round(capped * factor))
```

**顺序是：指数 → 封顶 → 抖动。**

**为什么不是"指数 → 抖动 → 封顶"？**

| 顺序 | 效果 |
|---|---|
| **封顶后抖动（我们的）** | 结果在 `[max×0.9, max×1.1]` —— **可能略超 maxDelayMs** |
| 抖动后封顶 | 结果**严格不超过 maxDelayMs** |

**我们选了第一种** —— 因为它让"抖动"始终均匀。

**但代价是"最终延迟可能略超 `maxDelayMs`"** —— **而字段名说的是"退避上限"。**

**这是一个真实的不一致**（见 L9）：**`maxDelayMs` 是"退避上限"，但抖动后可能超过它 10%。**

**修法**：把抖动放在封顶之前。

#### 细节 3：`Math.round` vs `Math.floor`

```ts
return Math.max(0, Math.round(capped * factor))
```

**用 `round` 而不是 `floor`** —— 因为**抖动是围绕中心对称的**，`floor` 会让平均值偏低。

**代价**：结果可能比 `capped` 大一点点（最多 0.5ms）。**可忽略。**

### 3.7 三个取值函数（第 205–235 行）

```ts
export function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

export function retryAfterOf(error: unknown): number | undefined { /* 同上 */ }

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
```

#### 三个函数都是"从 unknown 安全取值"

**模式完全一样**：

```ts
if (typeof error !== 'object' || error === null) return undefined
const value = (error as { xxx?: unknown }).xxx
return typeof value === 'T' ? value : undefined
```

**这是处理 `unknown` 的标准三行**（第 2 步的 `asRecord` 也是同一个模式）。

**为什么不用 `instanceof LLMError`？**

```ts
// 另一种写法
if (error instanceof LLMError) return error.code
```

**它更精确，但有耦合问题**：

```
retry.ts 依赖 LLMError 类（值导入）
   ↓
如果将来有别的错误类型也带 code（比如工具错误）
   ↓
★ instanceof 会漏掉它们 ★
```

**用"结构化的鸭子类型"（有 `code` 字段就用）更宽松** —— **`LLMError` 和非 `LLMError` 都能工作。**

**代价**：可能误判一个"碰巧有 `code` 字段"的对象。

**但在我们的场景下，误判的后果很轻**（重试判断保守，不会造成严重错误）。

#### `messageOf` 用了 `instanceof Error`

**这里反而用了 `instanceof`** —— 为什么？

因为**要取 `.message`，而它只有 `Error` 有**。

**而且它有一个 `String(error)` 兜底**（处理"抛出的是字符串"的情况）。

**对比**：

```ts
// 结构化写法
const msg = (error as { message?: unknown }).message
return typeof msg === 'string' ? msg : String(error)
```

**也行**。**我们用了 `instanceof`，因为它更短且语义清楚。**

**两个函数用了两种风格** —— **这不一致，但每一处都是"当时更合适的选择"。**

**（这也是可以统一的地方，但不重要。）**

### 3.8 `sleep()`（第 240–265 行）★ 关键 ★

```ts
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    function onAbort(): void {
      clearTimeout(timer)
      resolve()
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
```

#### 三条路径

| 路径 | 行为 |
|---|---|
| 进入时已取消 | **立刻 resolve**（不等） |
| 正常等完 | `clearTimeout` 不需要（已经烧掉了），但要 **removeEventListener** |
| 等待中取消 | **`clearTimeout` + resolve** |

#### 为什么是 `resolve` 而不是 `reject`

**这是设计决策**：

| 选择 | 调用方看到 |
|---|---|
| `resolve`（我们选的） | sleep 正常结束 —— **取消与否由调用方自己查 signal** |
| `reject` | 抛一个 `AbortError` |

**为什么选 resolve？**

**因为 `sleep` 的职责是"等待"，不是"判断取消"。**

**如果它 reject，那调用方要多一层 try/catch** —— 而那层 catch 要做的事和"正常醒来后检查 signal"**完全一样**。

**所以"提前醒来 + 让调用方检查"更简单。**

**代价**：调用方**必须记得检查** —— 否则会在取消后继续（我们的 `#request` 就检查了）。

#### `removeEventListener` 的必要性

```ts
const timer = setTimeout(() => {
  signal?.removeEventListener('abort', onAbort)      // ← 这行
  resolve()
}, ms)
```

**如果正常等完，`onAbort` 监听器还挂在 signal 上。**

**后果**：**监听器泄漏**。

**具体**：如果这个 signal 长期存在（比如一个长会话的 signal），**每次 sleep 都会往它上面挂一个监听器**，永不清理。

**所以正常路径也要移除。**

**这是 `sleep` 实现里最容易漏的一行。**

#### `{ once: true }` 的作用

```ts
signal?.addEventListener('abort', onAbort, { once: true })
```

**它让监听器在被触发后自动移除** —— **省掉了 `onAbort` 里的 `removeEventListener`**。

**但正常路径（超时）仍要手动移除** —— 因为那次 `onAbort` 没被调用。

**（所以有 `{ once: true }` 也不够，必须两边都处理。）**

### 3.9 `agent.ts` 的 `#request()`（改动）

```ts
  async #request(messages: readonly ChatMessage[], signal?: AbortSignal): Promise<LLMResponse> {
    const policy = this.#retryPolicy
    let attempt = 0

    for (;;) {
      attempt += 1

      try {
        return await this.#provider.chat(messages, this.#tools.schemas(), signal)
      } catch (error) {
        // ① 先把失败记下来 —— 这是持久事实，先记再说
        this.#session.recordAttempt(attempt, errorCodeOf(error) ?? 'UNKNOWN', messageOf(error))

        // ② 决定要不要再试
        if (!shouldRetry(policy, error, attempt)) throw error

        // ③ 等一会儿（可被取消打断）
        await sleep(computeDelayMs(policy, attempt, retryAfterOf(error)), signal)

        // ④ 唤醒后如果已取消，抛明确的「取消」错误
        if (signal?.aborted === true) {
          throw new LLMError('CANCELLED', '请求在重试等待期间被取消')
        }
      }
    }
  }
```

#### `for (;;)` —— 无限循环，靠 `return`/`throw` 退出

**为什么不用 `while (true)`？**

**两者等价**。`for (;;)` 更短，且**在 lint 规则里通常不会触发"常量条件"警告**。

#### ① 先记录，再决策

```ts
this.#session.recordAttempt(attempt, errorCodeOf(error) ?? 'UNKNOWN', messageOf(error))
if (!shouldRetry(policy, error, attempt)) throw error
```

**顺序很重要**：**即使这次不重试（要抛错），尝试也要被记录。**

**因为"失败了但不重试"也是一个事实**（比如 `AUTH` 错误）。

**演示 2 验证了它**：

```
--- provider 被调用几次（应该是 1）--- 1
--- 尝试记录 --- 1
```

**AUTH 失败 → 记为 1 次尝试 → 不重试 → 抛出。**

**所以"尝试次数"是"所有尝试"，不只是"重试"。**

#### ② `?? 'UNKNOWN'`

```ts
errorCodeOf(error) ?? 'UNKNOWN'
```

**因为 `recordAttempt` 的 `code` 参数是 `string`（必填）** —— 所以要给一个兜底。

**为什么不在 `recordAttempt` 里兜底？**

**因为那样"日志里存的是什么"就不清楚了** —— **显式在调用处兜底，日志里的值就是明确的。**

#### ③ 可取消的等待

```ts
await sleep(computeDelayMs(policy, attempt, retryAfterOf(error)), signal)
```

**三个函数串联**：`retryAfterOf(error)` → `computeDelayMs(...)` → `sleep(..., signal)`。

**读起来像一句话**："算出该等多久，然后带着信号等它"。

#### ④ 醒来后的检查

```ts
if (signal?.aborted === true) {
  throw new LLMError('CANCELLED', '请求在重试等待期间被取消')
}
```

**这是 1.6 节的修正。**

**为什么抛新的 `CANCELLED` 而不是原来的 `error`？**

**因为此刻的"事实"是"被取消了"** —— 而原来的 `error` 是**上一次失败的原因**。

**两者是不同的东西。**

> **抛出的错误应该反映"当前为什么停止"，而不是"之前发生过什么"。**

---

## L4 运行与验证

### 4.1 怎么运行

```powershell
cd D:\agent-harness-lab
node src/demos/demo-retry.ts
```

### 4.2 六组演示逐条解读

#### 演示 1 · 重试成功（★ 核心 ★）

```
--- 结果 ---                  {"status":"complete","steps":1,"text":"成功了（共尝试 3 次）"}
--- provider 实际被调用几次 --- 3
--- 事件流 ---
["0 turn/start","1 user/message","2 step/start","3 assistant/attempt",
 "4 assistant/attempt","5 assistant/message","6 step/end","7 turn/end"]
--- 统计（★ 注意 attempts）---
{"turns":1,"steps":1,"toolCalls":0,"toolErrors":0,"tokens":0,"attempts":2,"messages":2}
```

**要观察的四件事**：

| 观察 | 说明 |
|---|---|
| **provider 被调用 3 次** | 2 次失败 + 1 次成功 |
| **2 条 `assistant/attempt`** | **失败的尝试进了日志** |
| **只有 1 条 `assistant/message`** | 成功的才进历史 |
| **`attempts: 2`** | **可统计** |

**第三行是关键**：**日志有 8 个事件，但只有 2 条消息** —— 失败的尝试没有污染模型历史。

#### 演示 2 · AUTH 不重试

```
--- 抛出的错误 ---                  第 1 次尝试失败（AUTH）
--- provider 被调用几次（应该是 1）--- 1
--- 尝试记录 ---                    1
```

**要观察的**：**只尝试了 1 次**。

**它验证了"错误分类决定要不要重试"** —— 而这是第 1 步那张表的直接兑现。

**注意"尝试记录 1"** —— **失败了但不重试，也记了一次。**

#### 演示 3 · 重试耗尽

```
--- 抛出的错误 ---                  第 3 次尝试失败（SERVER）
--- provider 被调用几次 ---          3
--- 日志里的失败尝试 ---
["第 1 次：SERVER","第 2 次：SERVER","第 3 次：SERVER"]
```

**要观察的**：

| 观察 | 说明 |
|---|---|
| **调用 3 次** | `maxRetries: 2` → 1 次原始 + 2 次重试 |
| **3 条 attempt** | 每次失败都记了 |

**"1 + maxRetries"这个关系要记牢** —— **`maxRetries: 2` 意味着总共最多 3 次尝试。**

#### 演示 4 · always 模式

```
--- 结果 ---                  {"status":"complete","steps":1,"text":"成功了（共尝试 4 次）"}
--- provider 被调用几次 ---   4
```

**要观察的**：**3 次失败后成功，没有触发上限**（因为 always 无上限）。

**如果 provider 永远失败，这个演示会一直跑下去** —— **所以 always 模式要慎用。**

#### 演示 5 · 取消打断退避（★ 关键 ★）

```
--- 结果 ---  {"status":"cancelled","steps":0,"text":""}
--- 耗时（ms）---  62
```

**要观察的**：**62ms，而不是 30000ms。**

**退避配的是 30 秒** —— **如果 `sleep` 不响应 signal，这个演示要等 30 秒。**

**结果 62ms 证明取消打断生效。**

**而且返回的是 `status: 'cancelled'`（不是抛错）** —— **这是 1.6 节那个修正的效果。**

#### 演示 6 · 重试发的是同一份消息

```
--- 演示 1 的最终消息数 ---  2
--- 演示 1 的事件数 ---      8
```

**要观察的**：**8 减 2 等于 6**，这 6 个是：

```
turn/start, step/start, 2×assistant/attempt, step/end, turn/end
```

**而两条 `assistant/attempt` 就是"失败尝试不进历史"的证据。**

### 4.3 验收判据

| # | 判据 | 验证 |
|---|---|---|
| 1 | 六组演示全部符合上述输出 | 运行 |
| 2 | 演示 1 有 2 条 `assistant/attempt` 和 1 条 `assistant/message` | 看输出 |
| 3 | 演示 2 只调用 1 次 | 看输出 |
| 4 | 演示 3 调用 3 次（1 + 2） | 看输出 |
| 5 | **演示 5 耗时远小于 30000ms，且返回 `cancelled`** | 看输出 |
| 6 | 你能说出"哪些错误码可重试" | 口述 |
| 7 | 你能说出"为什么失败尝试要进日志但不进历史" | 口述 |
| 8 | 你能说出"为什么重试用同一份 messages" | 口述 |
| 9 | **关掉文档**能写出 `shouldRetry` | 见 L6 |

---

## L5 语法速查（本篇新增）

> 第 1–8 步的语法见各篇的 L5 节。

| 语法 | 例子 | 含义 | 注意 |
|---|---|---|---|
| **幂运算符** | `2 ** n` | 2 的 n 次方 | ES2016 |
| `Number.POSITIVE_INFINITY` | 表示无上限 | | `x > Infinity` 永远 false |
| **`for (;;)`** | 无限循环 | 靠 return/throw 退出 | 等价 `while (true)` |
| 函数声明在块内 | `function onAbort() {}` | 提升 | 在 `sleep` 里用它 |
| `addEventListener(..., { once: true })` | 只触发一次 | | **超时路径仍要手动移除** |
| `??` 链 | `config?.x ?? DEFAULT` | 两层可选 | |
| 判别标签收窄 | `if (c?.mode === 'always')` | 之后 c 是 Always 类型 | |
| `Set<string>.has` | 成员判断 | O(1) | |

### 本篇新增的两条规则

**规则 25：`for (;;)` 是"无限循环"的惯用写法**

```ts
for (;;) { … }        // ✅
while (true) { … }    // 也对，但某些 lint 规则会警告"常量条件"
```

**规则 26：事件监听器在"正常路径"也要清理**

```ts
signal?.addEventListener('abort', onAbort, { once: true })
// 超时路径：onAbort 永远不会被调用 → 必须手动 removeEventListener
```

**`{ once: true }` 只处理"被触发"的情况，不处理"没被触发"。**

---

## L6 关文档重写判据

### 必须能写出的部分

| 难度 | 要写的东西 | 通过标准 |
|---|---|---|
| ★ | 五个默认常量 | **`DEFAULT_RETRYABLE_CODES` 的五个码** |
| ★★ | 三个配置类型 | **`always` 没有 `maxRetries`** |
| ★★★ | **`shouldRetry`** | **三个判断，顺序正确（CANCELLED 最前）** |
| ★★★ | **`computeDelayMs`** | 三条规则（服务端优先 / 指数 / 抖动） |
| ★★★ | **`sleep`** | **可取消 + 正常路径也移除监听器** |
| ★★ | `#request` 的循环 | 四步（记录 / 判断 / 等待 / 再检查取消） |

### 卡住时的自检问题

| 卡在哪 | 问自己 |
|---|---|
| 哪些错误可重试 | "第 1 步那张表里，哪几个是"等一会儿就好"的？" |
| `CANCELLED` 的位置 | "如果放在 `always` 判断后面会怎样？" |
| 指数公式 | "第 1 次等多久？第 3 次呢？" |
| 抖动的目的 | "1000 个客户端同时被限流，如果没有抖峰会怎样？" |
| `sleep` 的取消 | "如果只有 setTimeout，取消时要等多久？" |

### 分级判定

| 程度 | 判定 |
|---|---|
| 能写出 ★★ 及以下 | 不够 L3，重读 3.2–3.4 |
| 能写出 ★★★ 但 `CANCELLED` 位置错 | 回去想"always 模式下取消会怎样" |
| 全部写出 | ✅ **达标** |

---

## L7 挑战题（不给答案）

### 挑战 1 · 修掉 `maxDelayMs` 的抖动溢出

**缺陷**（L9 缺陷 1）：抖动在封顶之后，所以结果可能超过 `maxDelayMs` 10%。

**要求**：

1. 把抖动移到封顶之前
2. **验证**：`initialDelayMs: 1000, maxDelayMs: 1000, jitterRatio: 0.5` 时，结果不超过 1000
3. **思考**：改完之后，"抖动"还有什么意义吗？（提示：如果 exponential 远大于 max，抖动就完全没用了）

### 挑战 2 · 让 `sleep` 的抖动可复现

**问题**：`Math.random()` 让"等待时间"不可复现 —— **这对实验是个噪声源。**

**要求**：

1. 给 `ResolvedRetryPolicy` 加一个可选的 `seed`
2. 实现一个**确定性**的伪随机（比如线性同余）
3. **验证**：同样的 seed 两次跑出的延迟完全一样

**思考**：**为什么"实验可复现"和"避免惊群"会冲突？** 有没有两全的办法？

### 挑战 3 · 记录"这次重试最终成功了吗"

**当前**：`assistant/attempt` 只记录了"失败了一次"。

**但**：**你无法从日志直接看出"第 2 次尝试成功了"。**

**要求**：

1. 让 `recordAssistant` 也不带 attempt 编号…… 或者换一个思路：
2. **加一个字段**：成功的 `assistant/message` 记录它是"第几次尝试"成功的
3. 这样"重试成功率"就能直接算

**思考**：这算是"扩展事件"还是"扩展已有事件"？**哪个更符合第 7 步的设计？**

### 挑战 4 · 给工具执行也加重试

**场景**：`bash` 执行失败，可能是临时的（比如文件被占用）。

**要求**：

1. 给 `Tool` 加一个可选的 `retryPolicy`
2. 在 `agent.ts` 的工具循环里用上它
3. **思考**：工具重试和模型重试，**哪个更危险？**（提示：工具可能有副作用）

**这道题直接导向第 10 步的"守卫"** —— 因为**有副作用的工具重试前应该先检查**。

### 挑战 5 · 实现"熔断"

**场景**（第 8 步 L9 提到的思路）：如果一个 provider 连续失败 N 次，**应该停止重试一段时间**。

**要求**：

1. 实现一个 `CircuitBreaker`：连续失败 5 次 → 打开 30 秒
2. 打开期间**直接失败**（不尝试）
3. 30 秒后进入"半开"：允许一次尝试，成功则关闭

**思考**：熔断的价值是什么？（提示：不是省钱，是**快速失败**）

**这个思路来自 Claude Code 篇 L2.2 的一个转述**（连续压缩失败需要熔断）—— **虽然那个具体数字不可信，但问题是真的。**

---

## L8 自检清单

### 理解层（L1）

- [ ] 我能说出哪五个错误码可重试、哪两个不
- [ ] 我能解释"为什么 `CANCELLED` 永远不重试"
- [ ] 我能画出指数退避的曲线
- [ ] 我能解释抖动的目的（惊群）
- [ ] ★ **我能说出"为什么失败的尝试要进日志但不进历史"**
- [ ] ★ **我能说出"为什么重试用同一份 messages"**

### 实现层（L3）

- [ ] 我关掉文档写出了 `shouldRetry`
- [ ] 我写出了 `computeDelayMs` 的三条规则
- [ ] 我写出了 `sleep`（含正常路径的清理）
- [ ] 我写出了 `#request` 的四步
- [ ] 我能解释"为什么 `CANCELLED` 判断要在 `always` 之前"

### 语法层

- [ ] 我会写 `for (;;)`
- [ ] 我知道 `{ once: true }` 不够，还要处理超时路径
- [ ] 我会用判别标签让编译器收窄类型

### 系统层（L4）

- [ ] **我能说出这一步怎么反哺了第 7 步**（加了什么事件、为什么它不是表面事件）
- [ ] 我能说出 `stats().attempts` 这个指标怎么用
- [ ] 我能说出"插在循环上"的模式会怎么用在第 10 步

---

## L9 仍未解决

### 会被后续步骤解决的

| 遗留问题 | 哪一步 |
|---|---|
| 重试还没被"插件化"（现在写在 `Agent` 里） | 第 11 步之后 |
| 工具执行没有重试 | 第 10 步的思路 |
| 没有熔断 | 挑战题 5 |
| 重试策略还不能从配置来 | 第 6 步的配置系统（还没接上） |

### 当前实现的真实缺陷

#### 缺陷 1 · 抖动在封顶之后，可能超出 `maxDelayMs`

```ts
const capped = Math.min(exponential, policy.maxDelayMs)
const factor = 1 + (Math.random() * 2 - 1) * policy.jitterRatio
return Math.max(0, Math.round(capped * factor))
```

**问题**：`capped * factor` 最大是 `maxDelayMs × 1.1`。

**后果**：字段名叫"退避上限"，但实际可能超它 10%。

**修法**：把抖动移到 `Math.min` 之前。

**为什么没做**：写的时候没想清楚"抖动应该在封顶前还是后"。

**这是一个"命名与行为不一致"的缺陷** —— **比纯粹的功能 bug 更隐蔽**（因为它看起来对）。

#### 缺陷 2 · `assistant/attempt` 的 `message` 可能很长 ★

```ts
this.#session.recordAttempt(attempt, errorCodeOf(error) ?? 'UNKNOWN', messageOf(error))
```

**问题**：`messageOf(error)` 取的是 `error.message`，而第 1 步的 `LLMError` 里，HTTP 错误的 message **包含服务端响应的前 800 字符**。

**后果**：**一次失败可能给日志加 800+ 字符。**

```
一个任务重试 5 次
   ↓
日志多 4000 字符
   ↓
★ 日志膨胀 ★
```

**修法**：截断（比如 200 字符），或者只存 code 不存 message。

**但"不存 message"会丢失诊断信息** —— **所以截断更好。**

**这个缺陷是"日志设计"里的通用问题** —— **任何"原样记错误信息"的地方都有它。**

#### 缺陷 3 · 重试不区分"第一次尝试"和"重试"

**日志里的 `assistant/attempt` 只有 `attempt` 编号。**

**问题**：**"attempt: 1" 是一次原始失败**，`"attempt: 2"` 才是"重试后的失败"。

**使用时要自己推断。**

**更清楚的记录**：加一个 `isRetry: boolean`，或者干脆用两个事件类型。

**为什么没做**：`attempt` 编号已经能推断出来（`attempt > 1` 就是重试）。

**但"能推断"和"直接可读"是两件事** —— 尤其对**人读日志**而言。

#### 缺陷 4 · `sleep` 的取消是"静默成功"

```ts
function onAbort(): void {
  clearTimeout(timer)
  resolve()          // ← 不是 reject
}
```

**问题**：**调用方必须自己记得检查 `signal.aborted`。**

**如果忘了**：会在取消后继续执行（比如开始下一次尝试）。

**我们的 `#request` 检查了**，但**这是一个"依赖调用方做对事"的接口**。

**更安全的设计**：让 `sleep` 在取消时 reject，或者返回一个"是否被取消"的标记。

**权衡见 3.8 节。**

#### 缺陷 5 · 没有"重试总时长上限"

```ts
retryPolicy: { mode: 'normal', maxRetries: 5, backoff: { initialDelayMs: 500, maxDelayMs: 10_000 } }
```

**最坏情况的总等待**：`500 + 1000 + 2000 + 4000 + 8000 = 15500ms`（约 15.5 秒）。

**加上每次请求本身的时间**，**一个任务可能被重试拖到一分钟以上**。

**问题**：**有些任务有硬时限**（比如"这道题最多给 60 秒"）。

**修法**：加一个 `maxTotalDelayMs`，超过就停止重试。

**为什么重要**：**你的科研要控制"单题时间预算"** —— 而重试会破坏它。

**这一条直接影响实验设计。**

#### 缺陷 6 · `always` 模式没有"逃生舱"

```ts
if (policy.mode === 'always') return true
```

**如果 provider 永远失败**，`always` 模式会**无限重试**。

**唯一的退出是"取消"或"进程结束"。**

**问题**：**如果调用方忘了传 signal，就是死循环。**

**更安全的设计**：`always` 模式也应该有一个"极大但有限"的上限（比如 1000 次）。

**为什么没做**：`always` 的语义就是"无限"。

**但"无限"在一个可能无人值守的系统里是危险的。**

---

## L10 提问训练

### 本篇引出的 12 个好问题

**关于设计（L3 层）**

1. 为什么 `CANCELLED` 的判断必须在 `always` 之前？
2. 为什么 `always` 模式在类型上**没有** `maxRetries` 字段？
3. 为什么抖动放在封顶之后？（以及这可能有什么问题）
4. 为什么 `sleep` 取消时是 `resolve` 而不是 `reject`？
5. 为什么 `#request` 里"先记录再判断"，而不是"先判断再记录"？

**关于系统（L4 层）**

6. **如果重试在 provider 层（装饰器），怎么才能同时记录失败尝试？**
7. **`assistant/attempt` 会长到什么程度？** 需要截断吗？
8. **重试该怎么和第 6 步的配置系统接上？**（配置文件里怎么写）
9. **如果工具也要重试，应该复用 `shouldRetry` 吗？**

**关于科研（L5 层）**

10. ★ **`stats().attempts` 能支持哪些研究问题？**
11. ★ **"重试"是不是一种"自我修正"？** 它和"模型自己改"有什么区别？
12. ★ **如果干预机制减少了重试次数，这算"改善"吗？** 还是只是"掩盖了问题"？

**第 12 个问题特别值得想**：

> **重试次数下降可能是"网络变好了"，也可能是"问题被掩盖了"。**
> **你怎么区分？**（提示：看最终成功率，而不是看重试次数）

### 问题升级练习

| 模糊问题 | 精确问题 | 提升在哪 |
|---|---|---|
| "重试怎么做的？" | "**如果 provider 每次失败都没有 `code`，`shouldRetry` 会怎么做？为什么？**" | 指向**边界行为** |
| "为什么要抖动？" | "**1000 个客户端同时被限流、退避都是 500ms —— 500ms 后会发生什么？**" | 要求**推演并发场景** |
| "失败尝试为什么要记？" | "**不记它的话，'重试了几次'这个指标从哪来？**" | 指向**数据来源** |

> ### 你的练习
>
> 挑一个改写，发给我：
>
> 1. "重试是干什么的？"
> 2. "为什么有退避？"
> 3. ★ **"我要研究'干预是否减少了无效重试'，需要哪些数据？现在的日志够吗？"**

---

## L11 系统影响回溯

### 11.1 三个预判的检验

| 第 0.5 节的问题 | 现在你应该能答的 |
|---|---|
| `assistant/attempt` 如果进历史会怎样？ | 模型会看到一堆"无内容的 assistant 消息"，**困惑于"我前面为什么没说话"** |
| 取消时 provider 可能正在处理 —— 能确定没计费吗？ | **不能**。`AbortSignal` 只中止本地等待，**服务端可能已经处理了** |
| `sleep` 提前 resolve 的影响？ | 调用方**必须自己检查 signal** —— 忘了就会在取消后继续 |

**第 2 个问题很重要**：

> **取消不等于"服务端没做事"。**
> **所以成本统计不能假设"取消了就不花钱"。**

**而这对你的实验有影响**：**取消了也是成本。**

### 11.2 本篇的"锚点"一句话

> **重试的每一个决策都来自错误分类；而失败的尝试本身也是要记的事实。**

它在后面的影子：

| 哪一步 | 同一思想的再现 |
|---|---|
| 第 10 步 | 守卫的决策来自"工具的可逆性分类" |
| 第 15 步 | 诊断的决策来自"失败分类" |
| 第 16 步 | 演化的门控来自"统计检验" |
| 第 12 步 | 记忆的"要不要记"来自"值不值得"的判断 |

**"先分类，再决策"是第 1 步就定下的方法论** —— 而它在每一步都以不同形式出现。

### 11.3 通向第 10 步的桥

**第 9 步结束时，系统状态：**

```
✅ 请求失败会重试（按分类决策）
✅ 失败的尝试被记录
✅ 取消能打断退避
❌ 但工具执行没有任何保护 —— 危险操作直接执行
❌ 超长工具结果会撑爆上下文
❌ 没有审批
```

**第 10 步要解决"工具的安全与节制"。** 带着这些问题进入：

1. **什么样的操作该先问人？** 判据是什么？
2. **超长的工具结果怎么办？** 直接塞进消息？
3. **如果一个工具卡住了？** 谁来超时？
4. ★ **如果守卫说"不许做"，模型会知道吗？** 它该怎么反应？
5. ★ **第 2 步设计的 `sideEffect` 字段还没实现 —— 第 10 步需要它吗？**

**第 5 个问题是关键** —— **因为"该不该审批"的判据就是"这个操作可不可逆"**。

---

## 本篇完结

| 检查项 | 应该达到 |
|---|---|
| 能说出哪些错误码可重试 | L1 |
| **能解释"失败尝试进日志但不进历史"** | L1 |
| **能解释"重试用同一份 messages"** | L1 |
| 能解释取消的三条路径如何统一 | L1 |
| **能关掉文档写出 `shouldRetry` 和 `computeDelayMs`** | **L3** |
| 能写出可取消的 `sleep` | L3 |
| **能说出这一步反哺了第 7 步什么** | L4 |
| 能提出至少 3 个 L4/L5 层的问题 | L4 |

---

**读完这篇，请回答我三个问题：**

1. **`sleep` 的取消语义**：选 `resolve` 还是 `reject`？**你倾向哪个？** 各自的代价是什么？

2. **缺陷 5**（没有总时长上限）：如果你的实验设了"单题 60 秒"，**而重试最坏要 15 秒 —— 这个预算怎么算才准？**

3. **下一站**：`10-guard.md`（守卫与审批）？

**我建议继续 `10-guard.md`** —— 因为它是**第 2 步那个 `sideEffect` 字段终于要实现的地方**，也是**"插在循环上"这个模式的第二次应用**。
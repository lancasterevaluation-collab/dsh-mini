# 第 4 步 · 事件、waterfall 与依赖注入

> **代码**：`src/framework/events.ts`（新文件，110 行）+ `src/framework/context.ts`（改造，新增约 90 行）
> **演示**：`src/demos/demo-events.ts`
> **DSH 对应**：`vendor/cordis/src/events.ts` + `registry.ts`（`inject`）
> **本篇目标级别**：L3（关掉文档能从零重写）
> **预计阅读**：80–110 分钟 · **预计动手**：90 分钟

---

## 本篇新词

> 全部术语在 [`glossary.md`](glossary.md)。先花 90 秒扫一遍。

| 词 | 一句话 | 为什么必须懂 |
|---|---|---|
| **event（事件）** | "某件事发生了"的通知，插件挂在上面等出手 | 插件之间唯一的**介入**方式 |
| **listener（监听器）** | 挂在某类事件上的处理函数 | 插件"等在某个时刻出手"的手段 |
| **emit / dispatch（分发）** | "这件事发生了，通知所有监听器" | 触发链路 |
| **waterfall（瀑布式分发）** | 一串处理函数依次相连，每个自己决定交给下一个还是到此为止 | ★ **本篇最核心的概念** ★ |
| **next()** | 监听器里调用它 = "我处理完了，交给下一个" | **不调就是短路** |
| **short-circuit（短路）** | 某个监听器处理了，后面的全部不执行 | 重试插件靠它拦下失败 |
| **serial / bail** | 两种分发语义：全都执行 / 有人处理就停 | 观察类与拦截类事件必须区分 |
| **inject（声明依赖）** | 插件声明"我需要 `llm` 和 `tools`" | 让装载顺序不再需要人工保证 |
| **pending（挂起）** | 依赖不齐时的状态：已登记但未启动 | 依赖一出现自动激活 |
| **声明合并** | TypeScript 允许在不同文件往同一个接口加成员 | 插件自己加事件，不用改框架 |
| **微任务（microtask）** | 当前同步代码跑完后立刻执行的任务 | 同步 `provide` 触发异步启动靠它 |

---

## 第 0 节 · 这一步的成品长什么样

### 0.1 你会新增什么、修改什么

```
┌────────────────────────────────────────────────────────────────────┐
│  events.ts（新增，110 行）—— 事件系统                               │
│                                                                    │
│    ① EventMap       事件名 → payload 类型（可扩展）                 │
│    ② Listener<P>    监听器签名 (payload, next) => ...              │
│    ③ Dispatcher<P>  一类事件的分发器                                │
│         on()       挂监听器，返回撤销函数                          │
│         emit()     waterfall 分发                                  │
│         size       监听器数量（排查用）                             │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  context.ts（改造）—— 新增约 90 行                                  │
│                                                                    │
│    ① Plugin.inject?          插件声明依赖（可选字段）                │
│    ② #dispatchers            事件名 → 分发器（共享，同注册表）        │
│    ③ #pending / #waiting     挂起等待依赖的容器（共享 + 实例）        │
│    ④ on() / emit()           挂监听器 / 分发                         │
│    ⑤ eventNames()            有哪些事件已被监听                       │
│    ⑥ plugin() 改：inject 检查 + 挂起                                │
│    ⑦ provide() 改：末尾触发唤醒                                      │
│    ⑧ #wakePending()          依赖齐了唤醒挂起的插件                   │
│    ⑨ #startSilently()        唤醒路径下的启动（无人接异常）           │
└────────────────────────────────────────────────────────────────────┘
```

### 0.2 对第 3 步代码的修改清单

**第 4 步改了第 3 步的文件。** 这是正常的演进，但你要知道改了哪里：

| 改动 | 原因 |
|---|---|
| 顶部加 `import` | 要用 `Dispatcher` |
| `Plugin` 加 `inject?` 字段 | 声明依赖 |
| 加 4 个私有字段 | 分发器、挂起集合、等待中的插件、启动标志 |
| 构造函数加 3 行 | 共享 `#dispatchers` 和 `#pending` |
| 加 `on` / `emit` / `eventNames` / `#dispatcherFor` | 事件 API |
| `provide()` 末尾加 3 行 | 触发通知与唤醒 |
| `plugin()` 改造 | inject 检查 + 挂起 + 唤醒 |
| 加 `#wakePending` / `#startSilently` | 唤醒逻辑 |

**注意：`03-context.md` 里的行号是"第 4 步之前"的版本。** 两份文档的行号会有一处偏差 —— 这是分步演进的必然结果。

### 0.3 运行起来是什么样

```powershell
node src/demos/demo-events.ts
```

关键输出：

```
--- 调用顺序（= 注册顺序）---
[ "① 看到 demo-service", "② 看到 demo-service", "③ 看到 demo-service" ]

--- 短路的结果 ---
[ "第一级：放行", "第二级：我处理了，不再往下传" ]
   ↑ 第三级没有出现 —— 短路生效

--- 装载 consumer 之后 ---
[ "挂起：plugin-consumer（缺 llm）" ]
--- 此时 answer 存在吗 ---
false

--- 提供 llm 之后 ---
[ "挂起：plugin-consumer（缺 llm）", "启动：plugin-consumer" ]
--- answer 的内容 ---
我拿到了 llm，模型是 deepseek-chat
```

**第 4 组是本篇重点**：依赖 `llm` 的插件在 `llm` 还没出现时**挂起而不报错**，`llm` 一出现它**自动启动**。

---

## 第 0.5 节 · 系统视角

### 你在哪里

```
                    ★ 能力层（第 7–16 步）★
         session / agent-loop / retry / guard / memory / diagnose
                              ▲
                              │ 全部靠事件互相介入
                              │
                    ┌─────────┴─────────┐
                    │ 【第 4 步】        │
                    │ 事件 + inject      │
                    │ ▶ 你在这里 ◀        │
                    └─────────┬─────────┘
                              │ 建立在第 3 步之上
                              ▼
                        第 3 步 · ctx 容器
```

### 下游：谁在用事件系统

| 第 4 步的产物 | 谁消费 | 用来做什么 | 依赖强度 |
|---|---|---|---|
| `Dispatcher` | 第 5–16 步的一切 | 挂监听器 | 🔴 极强 |
| `EventMap` | 全部插件 | 声明自己的事件 | 🔴 极强 |
| `ctx.on()` | 第 9 步 retry、第 10 步 guard | **拦截**请求与工具调用 | 🔴 极强 |
| `ctx.emit()` | 第 8 步循环、第 7 步会话 | 广播事实 | 🔴 强 |
| `Plugin.inject` | 第 7–16 步所有插件 | 声明依赖，自动排序 | 🔴 强 |
| `#wakePending` 机制 | 第 6 步装载器 | 支持任意装载顺序 | 🔴 强 |
| `eventNames()` | 调试 | 看有哪些事件被监听 | 🟢 可选 |

### 连锁影响分析

#### 连锁 1：如果把"不调 next()"改成"返回值判断短路"

```
有人改成："监听器的返回值如果是 truthy 就短路"
   ↓
第 9 步的 retry 插件返回 { kind: 'retry' }
   ↓
它必须判断"返回值是不是 truthy"
   ↓
某天某个插件返回 0 / '' / false（合法的业务值）
   ↓
★ 意外短路，后面的监听器全部不执行 ★
   ↓
表现为"某个功能时灵时不灵"，且极难复现
```

**"显式调用 `next()`"避免了整类问题** —— 短路是一个**动作**，不是一个**值的副作用**。

#### 连锁 2：如果 `inject` 检查改成"缺依赖就抛错"

```
插件装载时缺依赖 → 直接抛错
   ↓
第 6 步的装载器按配置顺序装载插件
   ↓
如果配置里 agent-loop 排在 llm 前面
   ↓
★ 启动失败 ★
   ↓
用户被迫手工调整配置顺序
   ↓
★ "配置即组合"的价值大打折扣 ★
```

**第 3 步的 `require` 就是这个行为**（取用时抛错）。第 4 步的 `inject` 把它变成"**等待**"。

| | 第 3 步 `require` | 第 4 步 `inject` |
|---|---|---|
| 时机 | 取用时 | 装载时 |
| 缺依赖 | **抛错** | **挂起等待** |
| 适用 | 该服务必须已存在 | 该服务可能稍后出现 |

**两者都存在，各有用途 —— 这是"两个工具"，不是"替换"。**

#### 连锁 3：如果 `#wakePending` 里的启动是同步的

```
provide() 是同步方法
   ↓
唤醒时同步调用 plugin.apply(child)
   ↓
但 apply 可能是 async（要读文件、连数据库）
   ↓
★ 没法在同步方法里 await 它 ★
   ↓
强行同步调用：apply 返回的 Promise 被丢弃 → 错误无人接
```

**解法是"同步方法 + 微任务"**，并且**专门为唤醒路径写了 `#startSilently`** —— 它自己 catch 错误并上报，因为**唤醒路径上没有任何人能接住异常**。

### 现在该建立的三个习惯

| 习惯 | 做法 | 训练什么 |
|---|---|---|
| **区分"动作"和"值的副作用"** | 短路要写成"调用一个动作"，不依赖返回值真值性 | API 设计直觉 |
| **同步触发异步时，想清楚错误去哪** | `void promise` 前先问"它 reject 了谁接" | 异步错误处理 |
| **同一机制的多种调用路径要分别设计** | 直接启动 vs 唤醒启动，错误处理不同 | 路径分析 |

> ### 停下来想一想（不给答案）
>
> 1. 如果 `Dispatcher.emit()` 不分发**快照**，某个监听器在分发过程中卸载了自己，会发生什么？
> 2. 演示 5 里 `eventNames()` 仍返回 `["service/provided"]` —— 这说明什么？
> 3. 插件 A 和 B 都依赖 `llm`，`llm` 出现时它们的**启动顺序**是什么？

---

## L0 要解决的问题

### 0.1 第 3 步留下的两个缺陷

**缺陷 1：插件能"提供"能力，但不能"观察/拦截"彼此。**

现在 `retry` 插件想插手"模型请求失败"，唯一办法是改循环代码：

```ts
// 这是我们要消灭的写法
const result = await this.llm.chat(messages)
if (result.error && config.retryEnabled) { ... }
```

**`config.retryEnabled` 一出现，就意味着循环必须知道重试的存在。** 功能越多，这种 `if` 越多，最终变成没人敢动的泥球。

**缺陷 2：没有依赖注入，插件装载顺序全靠人工保证。**

如果 `agent-loop` 在 `llm` 之前装载，`ctx.require('llm')` 直接抛错。而真实系统里装载顺序由**配置文件**决定 —— **框架必须容忍顺序错乱**。

### 0.2 这一步要回答的四个问题

| # | 问题 | 本篇位置 |
|---|---|---|
| 1 | 插件怎么在不认识彼此的情况下**介入**？ | 事件系统（1.1–1.3） |
| 2 | 一条事件有多个监听器时，谁说了算？ | **waterfall 语义**（1.2） |
| 3 | 插件怎么**声明依赖**并等待？ | `inject` + 状态机（1.4） |
| 4 | 同步的 `provide` 怎么触发异步的启动？ | 微任务（1.5） |

**第 2 个问题最容易搞错。**

---

## L1 设计与原理

### 1.1 两种分发语义

| 语义 | 行为 | 典型用途 |
|---|---|---|
| **serial（广播）** | 每个监听器都被调用，返回值被收集 | 观察类：`tool/result`（只读通知） |
| **waterfall（瀑布）** | 链式调用，**每个监听器决定是否把控制权交给下一个** | 拦截类：`agent/request-error`、`tools/pre-execute` |

**我们只实现 waterfall** —— 它是更复杂、更需要理解的那个。serial 可以用"每个监听器都返回 `next()`"模拟。

### 1.2 waterfall 的执行模型（必须彻底搞懂）

#### 写法

```ts
ctx.on('service/provided', async (payload, next) => {
  if (payload.name === 'llm') return { intercepted: true }   // ← 不调 next() = 短路
  return await next()                                        // ← 调 next() = 放行
})
```

#### 执行模型

```
监听器1 ──next()──► 监听器2 ──next()──► 监听器3 ──next()──► 默认处理器
   │                    │                    │
   └─ 返回 {…}          └─ 返回 next()       └─ 返回 next()
      ↑ 短路：监听器2、3 都不会执行
```

#### 实现

```ts
async emit(payload: P): Promise<unknown> {
  const listeners = [...this.#listeners]      // ① 快照

  let index = -1
  const next = async (): Promise<unknown> => {
    index += 1
    const listener = listeners[index]
    if (listener === undefined) return undefined   // ② 默认处理器
    return await listener(payload, next)            // ③ 把 next 交给监听器
  }

  return await next()
}
```

**逐行**：

| 行 | 作用 |
|---|---|
| ① 快照 | 防止分发过程中监听器增删导致索引错乱 |
| ② 默认处理器 | 链走完了 —— 什么都不做，返回 `undefined` |
| ③ 传递 `next` | **关键**：监听器拿到的是"继续往下"的能力 |

**注意 `index` 是闭包变量**：

```ts
let index = -1
const next = async () => {
  index += 1          // ← 每次调用都推进
  ...
}
```

**同一个 `next` 函数被传给每一级监听器**，靠闭包里的 `index` 记住"走到哪了"。

**为什么用"闭包游标"而不是"递归传剩余数组"？**

| 方案 | 复杂度 |
|---|---|
| 闭包游标（我们用的） | O(n) |
| 递归传剩余（每次 `slice`） | O(n²) |

**而且游标版本更接近 Koa 中间件的实现** —— 你以后读 Koa 或 Cordis 源码时会认出来。

#### 三条必须记住的规则

**规则 1：不调 `next()` 就是短路**（设计意图，不是副作用）

**规则 2：调了 `next()` 必须 `return` 它的结果**

```ts
// ✅ 正确
return await next()

// ❌ 错误：链断了
await next()          // 执行了下游，但返回值被丢弃
return 'something'    // 上层拿到的是 'something'，不是下游的结果
```

**为什么错了还不报错？** 因为下游**确实执行了**，只是返回值丢了。现象是"功能正常，但返回值不对" —— **很难查。**

**规则 3：顺序由注册顺序决定**

```ts
ctx.on('x', A)      // 先注册 → 先被调用
ctx.on('x', B)      // 后注册 → 后被调用
```

**所以排序有意义** —— 第 9 步的重试策略顺序、第 10 步的守卫顺序都依赖它。

#### 「短路」和「抛异常」的区别

| | 短路 | 抛异常 |
|---|---|---|
| 后续监听器 | 不执行 | 不执行 |
| 调用方 | **拿到返回的值** | **收到异常** |
| 语义 | "我处理了" | "出错了" |

**演示 2 验证**：

```
--- 短路的结果 ---
[ "第一级：放行", "第二级：我处理了，不再往下传" ]
```

**第三级完全没有出现。**

### 1.3 类型化事件与声明合并

#### 事件表

```ts
export interface EventMap {
  'service/provided': { name: string; owner: string }
  'service/removed': { name: string; owner: string }
  'plugin/started': { name: string }
  'plugin/pending': { name: string; missing: readonly string[] }
}
```

#### `on` / `emit` 的泛型签名

```ts
on<K extends keyof EventMap>(name: K, listener: Listener<EventMap[K]>): Disposer
emit<K extends keyof EventMap>(name: K, payload: EventMap[K]): Promise<unknown>
```

| 片段 | 作用 |
|---|---|
| `<K extends keyof EventMap>` | `K` 必须是事件名之一 |
| `listener: Listener<EventMap[K]>` | **payload 类型由 `K` 决定** |

**效果**：

```ts
ctx.on('plugin/pending', (payload, next) => {
  payload.missing            // ✅ 编译器知道是 string[]
  payload.nonexistent        // ❌ 编译报错
})
```

#### 声明合并：插件自己加事件

`EventMap` 是**可扩展**的。插件在自己的文件里加事件，**不用改 `events.ts`**：

```ts
// 某个插件文件里
declare module '../framework/events.ts' {
  interface EventMap {
    'llm/retry': { attempt: number; reason: string }
  }
}
```

**写完之后，`ctx.on('llm/retry', ...)` 在整个项目里都能通过类型检查，且 `payload` 类型正确。**

| 方案 | 后果 |
|---|---|
| 每个新事件都改 `events.ts` | 框架文件被所有插件依赖 → **中心化瓶颈** |
| **声明合并** | 插件自治，**框架不知道插件的事件** |

**这正是"插件化"的核心承诺：框架不需要知道插件有什么。**

**DSH 的规范要求区分两类联合类型**：

> 「Closed unions end in `assertNever`; **merge-extensible unions fall through a documented default**.」

| 类型 | 处理 |
|---|---|
| `JsonSchema['type']`（**封闭**） | `assertNever`（第 2 步） |
| `EventMap`（**可扩展**） | 泛型 + 声明合并 |

**判断标准**：**我们自己能穷举全部成员吗？**

### 1.4 依赖注入的状态机

```ts
const consumer: Plugin = {
  name: 'plugin-consumer',
  inject: ['llm'],          // ← 声明：我需要 llm
  apply(ctx) { ... },
}
```

```
            ┌──────────────┐
   装载 ──► │   pending    │  依赖不齐：只登记，不 apply
            └──────┬───────┘
                   │ 依赖全部就绪（provide 触发）
                   ▼
            ┌──────────────┐
            │   started    │  apply 已执行，注册已生效
            └──────────────┘
```

**`plugin()` 的分叉**：

```ts
const deps = plugin.inject ?? []
const missing = deps.filter((name) => !this.#registry.has(name))

if (missing.length > 0) {
  child.#waiting = plugin
  this.#pending.add(child)
  void this.emit('plugin/pending', { name: plugin.name, missing })
} else {
  child.#started = true
  try {
    await plugin.apply(child)
  } catch (error) {
    child.dispose()
    throw error
  }
  void this.emit('plugin/started', { name: plugin.name })
}
```

**注意"挂起"分支里没有 try/catch** —— 因为**没有执行任何代码，就不会失败**。

#### 唤醒：`#wakePending()`

```ts
#wakePending(): void {
  for (const child of [...this.#pending]) {
    const plugin = child.#waiting
    if (plugin === undefined) continue

    const deps = plugin.inject ?? []
    if (!deps.every((name) => this.#registry.has(name))) continue

    this.#pending.delete(child)
    child.#waiting = undefined
    queueMicrotask(() => {
      void child.#startSilently(plugin)
    })
  }
}
```

| 片段 | 作用 |
|---|---|
| `[...this.#pending]` | **快照** —— 循环里会 `delete` |
| `deps.every(...)` | **全部**依赖就绪（不是"部分"） |
| `delete` + 清空 `#waiting` | 从挂起集合移除（避免重复唤醒） |
| `queueMicrotask` | 异步启动（见 1.5） |

**关于快照**：JavaScript 的 `Set` 迭代器能容忍"删除当前元素"，但**我们选择快照，因为不依赖这条细则** —— 更不容易出错。

**演示 6 验证了"挂起后被卸载不会幽灵启动"**：

```
--- 启动记录（应为空）---
[]
--- should-not-exist 存在吗（应为 false）---
false
```

**关键是卸载函数里的这一行**：

```ts
this.#pending.delete(child)      // ← 从挂起集合移除
```

**没有它，一个已经卸载的插件会在依赖到来时被启动。**

### 1.5 ★ 同步的 `provide` 怎么触发异步的启动 ★

**这是本篇最难的一处设计。**

#### 矛盾

```ts
provide<T>(name: string, value: T): Disposer      // ← 同步方法
async apply(ctx: Context): Promise<void>          // ← 可能是异步的
```

**同步方法里没法 `await` 异步函数。**

#### 三种方案

| 方案 | 代价 |
|---|---|
| **A** 把 `provide` 改成 `async` | ★ **破坏性改动**：所有调用方都要 `await`，包括第 3 步已有的代码 |
| **B** 同步调用 `apply`，丢弃 Promise | ★ 错误无人接：reject 变成 unhandled rejection |
| **C** **用微任务延后启动** | 启动发生在 `provide` 返回之后 |

**我们选 C。**

```ts
queueMicrotask(() => {
  void child.#startSilently(plugin)
})
```

**`queueMicrotask` 是什么？**

```ts
console.log('1')
queueMicrotask(() => console.log('3'))
console.log('2')
// 输出：1 2 3
```

**对比 `setTimeout(fn, 0)`**：微任务在**当前宏任务结束前**执行；`setTimeout` 在**下一轮事件循环**。**微任务更快、更准时。**

#### 为什么专门写 `#startSilently`

```ts
async #startSilently(plugin: Plugin): Promise<void> {
  if (this.#started || this.#disposed) return
  this.#started = true
  try {
    await plugin.apply(this)
    void this.emit('plugin/started', { name: this.name })
  } catch (error) {
    this.dispose()                          // 回滚
    this.#onDisposeError?.(error, this.name) // 上报
  }
}
```

**两条路径的错误处理不同**：

| 路径 | 出错时 |
|---|---|
| `plugin()` 直接启动 | **有 `await` 的调用方** → 原样抛出 |
| 唤醒启动 | **没有任何人能接** → 自己回滚 + 上报 |

**"silently"这个名字其实是反的** —— 它指"没有人接异常"，所以它自己处理得**更彻底**。**这个命名值得反思**（见 L9）。

#### ★ 这个设计的一个重要副作用 ★

演示 4 里用了 `await tick()`（等一轮定时器）来观察结果：

```ts
root4.provide('llm', { model: 'deepseek-chat' })
await tick()      // ← 必须等一下
show('answer 的内容', root4.get('answer'))
```

**因为启动是异步的，`provide` 返回时它还没跑完。**

**这意味着**：如果你的代码在 `provide` 之后**立刻**去读被唤醒插件提供的服务，**可能读不到**。

**这是异步设计的固有代价。** 三种应对：

| 应对 | 代价 |
|---|---|
| 用事件监听 `plugin/started` | 要改调用方的写法 |
| 提供 `await ctx.ready()` 之类的信号 | 要额外 API |
| **接受它，文档里写清** | 使用方要小心（我们选这个） |

### 1.6 为什么这一步是「DSH 级」的分水岭

| 能力 | 第 3 步后 | 第 4 步后 |
|---|---|---|
| 加一个新功能 | **改循环代码** | **挂一个监听器** |
| 关掉一个功能 | 加 `if` 开关 | **卸载那个插件** |
| 插件装载顺序 | 必须人工保证 | **框架自动处理** |
| 两个插件协作 | 互相 `import` | **各自监听事件** |
| 插件加新事件类型 | 要改框架 | **声明合并，框架不知道** |

**第 3 步让插件能"提供"，第 4 步让插件能"介入"。**

**而"介入而不修改"正是 DSH 那 307 个包能共存的原因** —— 每个包只关心自己监听什么事件。

> ### 停下来想一想（不给答案）
>
> 1. 如果 `emit` 不复制快照，某个监听器在分发时 `off()` 了自己，会怎样？（提示：`index` 会指向谁？）
>
> 2. `provide` 之后立刻 `get` 被唤醒插件注册的服务可能拿不到。**要保证拿得到，有几种改法？各自代价是什么？**
>
> 3. 如果两个插件互相 `inject` 对方的服务，会发生什么？

---

## L2 决策表

| # | 决策 | 我们的选择 | 替代方案 | 代价落在谁身上 |
|---|---|---|---|---|
| 1 | 短路机制 | **不调 `next()`** | 返回特殊标记 `{stop:true}` | 更隐晦；换来与 Koa/Cordis 一致的心智模型 |
| 2 | `next` 实现 | 闭包游标 | 递归传剩余数组 | 无；游标 O(n)，递归 O(n²) |
| 3 | 分发前快照 | 复制监听器数组 | 直接用原数组 | 多一次复制；换来分发中增删安全 |
| 4 | 事件类型 | `EventMap` + 泛型 + **声明合并** | 一个全局字符串枚举 | 要维护一张表；换来插件自治 |
| 5 | 缺依赖 | **挂起等待** | 立刻抛错 | 多一个状态机；换来装载顺序自由 |
| 6 | 唤醒时机 | **微任务** | 同步调用 / 下一轮事件循环 | 有时序延迟；换来不破坏同步 API |
| 7 | 唤醒路径的错误 | 自己回滚 + 上报 | 丢弃（`void promise`） | 多写一个方法；换来错误不静默 |
| 8 | 唤醒后的服务可读性 | **不保证立即可读** | 提供 `ready()` 信号 | 使用方要小心时序；换来 API 简洁 |
| 9 | 分发器管理 | 按需创建，**不回收** | 空了就从 Map 删 | 空分发器累积（见 L9 缺陷 1） |

### 关于第 1 条的完整论证

**为什么不用"返回值判断短路"？**

```ts
const result = await listener(payload)
if (isStop(result)) return result      // ← 框架判断要不要停
```

**看起来更简洁，但有个致命问题**：**监听器的返回值有了双重身份** —— 既是"处理结果"，又是"控制指令"。

- 想返回一个"看起来像停止标记"的业务值时，会**意外短路**
- 想短路时，必须**知道**那个标记的形状

**"调用 `next()`"把这个动作显式化了。**

**DSH 的规范里有一条正是这个**：

> 「Waterfall listeners MUST call `next()` to delegate; returning without it short-circuits the chain」

**它被写成强制规则，因为搞错它的后果很严重。**

### 关于第 5 条的完整性论证

**`inject` 和 `require` 并存，不是重复**：

| | 什么时候用 |
|---|---|
| `require('llm')` | **我的服务一旦启动就必须有它**，没有就是配置错了 |
| `inject: ['llm']` | **它可能稍后才出现**，我要等 |

```ts
// 场景 A：日志服务随时可能被加进来
const toolPlugin: Plugin = { name: 'plugin-tool', inject: ['logger'], apply(ctx) {} }

// 场景 B：agent 循环必须有一个 LLM，没有就是配置错误
const loopPlugin: Plugin = {
  name: 'plugin-agent-loop',
  apply(ctx) { const llm = ctx.require('llm') },
}
```

> **一个反直觉的结论**：`inject` 并不总是比 `require` 好。
> 如果一个依赖**必须**存在，用 `require` 让它**立刻炸**，比"静默挂起等着一个永远不会来的服务"更好。

### 关于第 9 条（空分发器累积）

**这是我在跑演示时实际观察到的**：

```
--- root5 现在还有监听器的事件 ---
[ "service/provided" ]
```

监听器已经被卸载了，但 `#dispatchers` 里的空分发器还在。

**后果**：长时间运行的进程里这个 Map 会缓慢增长（上限是"曾经出现过的事件名数量"）。

**修法**：`on` 返回的撤销函数里，如果分发器空了就从 Map 删掉。

**这个缺陷很轻，但它是个好的教学例子**：`eventNames()` 这个诊断方法**恰好暴露了它** —— 没有这个方法你根本不会注意到。

> **好的诊断工具会暴露你没注意到的泄漏。**

---

---

## L3 实现：逐行讲解

### 3.0 两个文件的分工

```
events.ts（110 行）—— 纯机制，不认识 Context
  ├─ EventMap       事件名 → payload 类型
  ├─ Listener<P>    监听器签名
  └─ Dispatcher<P>  一类事件的分发器（on / emit / size）

context.ts（改造）—— 把事件挂进容器
  ├─ #dispatchers   事件名 → 分发器（共享，同注册表）
  ├─ on / emit      对外 API
  ├─ inject 支持     挂起 + 唤醒
  └─ provide 末尾    触发通知
```

**注意 `events.ts` 只 `import type { Disposer }`** —— 类型导入在擦除后完全消失，所以**两个文件之间没有运行时循环依赖**。

### 3.1 `events.ts` 的文件头（第 1–25 行）

```ts
/**
 * 第 4 步 ｜ 事件：让插件在不认识彼此的情况下互相介入
 *
 * 第 3 步解决了「插件怎么互相发现」—— 靠服务名查表。
 * 但那只解决了「取用」，没解决「介入」：
 *
 *   如果 retry 插件想插手「模型请求失败」，它需要在哪里写代码？
 *     第 3 步的答案：改主循环 —— 那是我们最想避免的事。
 *     第 4 步的答案：挂一个监听器。
 *
 * ── waterfall（瀑布式分发）──────────────────────────────────────────────
 *
 * 一串监听器依次相连，每个处理完自己决定「交给下一个」还是「到此为止」：
 *
 *     监听器1 ──next()──► 监听器2 ──next()──► 监听器3 ──next()──► 默认处理器
 *        │                    │                    │
 *        └─ 返回 {kind:'retry'} └─ 返回 next()      └─ 返回 next()
 *           ↑ 短路：2、3 都不会执行
 *
 * 名字来自「水从台阶流下」—— 每一级都能拦住水。
 *
 * 三条必须记住的规则：
 *   1. 不调 next() 就是短路 —— 后面的监听器全部不执行
 *   2. 调了 next() 必须 return 它的结果 —— 写成 `next(); return x` 会让链断裂
 *   3. 顺序由注册顺序决定 —— 谁先 on() 谁先被调用
 */
```

**这段注释值得学的地方**：

| 做法 | 为什么好 |
|---|---|
| 用**第 3 步的缺口**引入（"那只解决了取用，没解决介入"） | 让读者知道**为什么要有这个文件** |
| 用**具体问题**举例（"retry 插件想插手请求失败"） | 抽象的机制有了具体的动机 |
| **ASCII 图**画出执行模型 | 一张图胜过三段文字 |
| **把三条规则列出来** | 读者不会漏掉关键约束 |

**注意第 2 条规则**："写成 `next(); return x` 会让链断裂" —— 这是**一个真实的坑**，写在文件头能让每个读这个文件的人都看到。

### 3.2 `EventMap`（第 34–44 行）

```ts
export interface EventMap {
  /** 某个服务被注册了。 */
  'service/provided': { name: string; owner: string }
  /** 某个服务被移除了。 */
  'service/removed': { name: string; owner: string }
  /** 某个插件完成了装载。 */
  'plugin/started': { name: string }
  /** 某个插件因为依赖不齐而挂起。 */
  'plugin/pending': { name: string; missing: readonly string[] }
}
```

#### 事件名的命名风格

```ts
'service/provided'      // ← 领域/动作
'plugin/started'
```

**用 `斜杠` 分隔"领域"和"动作"**，这是**事件命名的通用惯例**（DSH 里是 `agent/pre-step`、`tools/pre-execute`、`llm/stream`）。

**好处**：

| 好处 | 说明 |
|---|---|
| **可分组** | 一眼看出 `service/*` 都是服务相关 |
| **可通配** | 将来可以做 `on('service/*')` 这样的批量订阅 |
| **避免冲突** | 不同插件用不同前缀（`llm/retry`、`tools/denied`） |

#### 为什么 `missing` 是 `readonly string[]`

```ts
'plugin/pending': { name: string; missing: readonly string[] }
```

**`readonly`** 表示"监听器不应该修改这个数组" —— 因为它是**发出去的事实**，改它会影响其他监听器。

**注意 `EventMap` 的成员没有 `readonly`**（`name` 和 `owner` 不是 readonly）：

**这是个不一致，但不是 bug** —— 因为 `readonly` 在**对象字面量类型**里只影响赋值，而事件 payload 是**交给监听器读的**。

**如果要更严格**，可以写成 `Readonly<{...}>`。**我们没做，是因为它会让类型定义变得啰嗦，而收益很小。**

### 3.3 `Listener<P>`（第 46–54 行）

```ts
export type Listener<P> = (payload: P, next: () => Promise<unknown>) => unknown | Promise<unknown>
```

#### 三个部分

| 部分 | 含义 |
|---|---|
| `payload: P` | 事件数据，类型由调用方指定 |
| `next: () => Promise<unknown>` | **继续往下**的能力 |
| 返回值 `unknown \| Promise<unknown>` | 可以是同步或异步，值类型不定 |

#### 为什么 `next` 的类型是 `() => Promise<unknown>`

**`next` 不接受参数**（事件数据是共享的，不用再传）。

**返回 `Promise<unknown>`** —— 因为下游可能是异步的，而调用方必须能 `await` 它。

**为什么是 `unknown` 而不是 `void`？**

因为**下游的返回值要能一路传回给最初的调用方**：

```
监听器1 return await next()  ← 拿到监听器2的返回值
监听器2 return await next()  ← 拿到监听器3的返回值
监听器3 return { handled: true }   ← 最终值
```

**所以 `next()` 必须返回"下游的结果"。**

#### 返回类型 `unknown | Promise<unknown>`

**允许同步返回**（`return { handled: true }`）**也允许异步**（`return await next()`）。

**调用方用 `await` 统一处理** —— `await` 对非 Promise 值是安全的。

#### 为什么不用 `async` 强制全部异步

```ts
export type Listener<P> = (payload: P, next: () => Promise<unknown>) => Promise<unknown>
//                                                                        ↑ 强制 Promise
```

**那样更统一，但强迫同步监听器也写 `async`**：

```ts
// 强制版本要这么写
ctx.on('x', async (payload, next) => {
  console.log('我只想打印一行')
  return await next()        // ← 必须 await
})
```

**允许 `unknown | Promise<unknown>` 让简单的监听器更简单。**

### 3.4 `Dispatcher.on()`（第 68–84 行）

```ts
  on(listener: Listener<P>): Disposer {
    this.#listeners.push(listener)

    let removed = false
    return (): void => {
      // 幂等：重复撤销只生效一次
      if (removed) return
      removed = true
      const index = this.#listeners.indexOf(listener)
      if (index >= 0) this.#listeners.splice(index, 1)
    }
  }
```

#### 逐部分

```ts
this.#listeners.push(listener)
```

**直接 push，不检查重复。**

**为什么允许同一个监听器注册两次？**

因为它确实是合法的：

```ts
const handler = () => {}
ctx.on('x', handler)
ctx.on('x', handler)      // ← 注册两次，会被调用两次
```

**大多数框架允许这样**（因为"同一个函数注册两次"通常是刻意的）。

**代价**：撤销时需要 `indexOf` 找到**第一个**匹配的位置 —— 所以两次注册各自撤销一次是**正确**的（第一次撤销删第一个，第二次撤销删剩下的那个）。

#### 撤销函数的三个细节

```ts
let removed = false
return (): void => {
  if (removed) return
  removed = true
  const index = this.#listeners.indexOf(listener)
  if (index >= 0) this.#listeners.splice(index, 1)
}
```

| 细节 | 理由 |
|---|---|
| `removed` 标志 | **幂等**：重复撤销只生效一次 |
| `indexOf` 而不是缓存索引 | 因为数组会变（其他监听器增删），**缓存的索引会失效** |
| `if (index >= 0)` | 找不到就不删（已经被别处删过了） |

**第二点很关键**：

```ts
// 如果缓存索引（错的）
const index = this.#listeners.length
this.#listeners.push(listener)
return () => {
  this.#listeners.splice(index, 1)     // ← 如果前面删过一个元素，这里删错人
}
```

**用 `indexOf` 每次都重新找** —— 慢一点（O(n)），但**永远正确**。

**这个取舍在这里是值得的**，因为监听器数量通常很少（几个到几十个）。

### 3.5 `Dispatcher.emit()`（第 86–106 行）★ 核心 ★

```ts
  async emit(payload: P): Promise<unknown> {
    // 先快照：监听器在分发过程中可能增删（比如某个监听器卸载了自己）
    const listeners = [...this.#listeners]

    let index = -1
    const next = async (): Promise<unknown> => {
      index += 1
      const listener = listeners[index]
      // 走完了 —— 这就是「默认处理器」：什么都不做
      if (listener === undefined) return undefined
      return await listener(payload, next)
    }

    return await next()
  }
```

#### 逐行

**① 快照**

```ts
const listeners = [...this.#listeners]
```

**为什么必须快照？**

**场景**：监听器 A 在处理时调 `off()` 卸载了监听器 B。

```
不快照的情况：
  this.#listeners = [A, B, C]
  分发：index=0 → 调 A
  A 内部卸载了 B → this.#listeners = [A, C]
  index=1 → this.#listeners[1] → C     ← ★ B 被跳过了？不，是 C 被提前了 ★
  index=2 → this.#listeners[2] → undefined  ← 结束
  ★ 结果：C 被调用了，但 B 没有 —— 而且顺序乱了 ★
```

**快照后**：

```
listeners = [A, B, C]（副本，不受 #listeners 变化影响）
index=0 → A
index=1 → B（虽然它已经从 #listeners 移除了，但快照里还在）
index=2 → C
★ 结果：三个都被调用，顺序稳定 ★
```

**注意**：**快照意味着"分发期间卸载的监听器，本次仍会被调用"。** 这是**有意的** —— 保证"一次分发看到一致的监听器列表"。

**另一种可能的语义**是"卸载立即生效"，但那会让分发行为难以预测。

#### ② 游标与默认处理器

```ts
let index = -1
const next = async (): Promise<unknown> => {
  index += 1
  const listener = listeners[index]
  if (listener === undefined) return undefined
  return await listener(payload, next)
}
```

**`index` 从 `-1` 开始，第一次 `next()` 后变成 `0`。**

**为什么不在外面先调一次？**

因为**最后一行 `return await next()` 就是第一次调用**。

**`listener === undefined` 的两种含义**：

| 情况 | 含义 |
|---|---|
| `index >= length` | 链走完了 |
| 数组里真有 `undefined` | 不可能（`push` 的都是函数） |

**所以这个判断等价于"还有没有下一个"。** 用 `=== undefined` 而不是 `index >= listeners.length` 是因为**它同时兼容了两种边界**（第 2 步的 `toToolCall` 里也用了同样的技巧）。

#### ③ 递归点

```ts
return await listener(payload, next)
```

**这一行是整个 waterfall 的核心。**

**它把 `next` 交给监听器** —— 监听器只要调用它，就会回到这里、推进游标、调用下一个。

**注意 `await`**：因为监听器可能是异步的。

**为什么用 `return await` 而不是 `return`？**

| 写法 | 区别 |
|---|---|
| `return await f()` | 在这个函数里**捕获 f 的异常**（栈里多一帧） |
| `return f()` | 异常直接穿透（栈少一帧） |

**在 waterfall 里，`return await` 让错误堆栈包含每一级监听器** —— **排查时更有用。**

**代价**：多一帧栈、略慢。**换来可诊断性**（第 15 步会用到）。

#### ④ 启动

```ts
return await next()
```

**第一级从这里开始。**

### 3.6 `context.ts` 的新增字段（改造点 1）

```ts
  /** 事件名 → 分发器。和第 3 步的注册表一样，由根容器持有、全树共享。 */
  #dispatchers: Map<string, Dispatcher>
  /** 第 4 步新增：全部「依赖未齐、等待启动」的插件容器。共享。 */
  #pending: Set<Context>
  /** 第 4 步新增：本容器挂起时记住的插件（依赖齐了才能启动它）。 */
  #waiting: Plugin | undefined
  /** 第 4 步新增：本容器是否已经启动过。 */
  #started = false
```

#### 四个字段，两个共享、两个私有

| 字段 | 共享？ | 理由 |
|---|---|---|
| `#dispatchers` | ✅ 共享 | 事件是全树的 |
| `#pending` | ✅ 共享 | 任何人都可能触发唤醒（`provide` 在任意容器上） |
| `#waiting` | ❌ 私有 | 每个容器记自己的插件 |
| `#started` | ❌ 私有 | 每个容器记自己的启动状态 |

**"共享"的实现方式还是第 3 步那一招** —— 构造函数里 `parent.#x`。

**注意 `#started = false` 用内联初始化**（不依赖参数），而 `#waiting` **没有初始化**（它是 `Plugin | undefined`，默认就是 `undefined`）。

**等等** —— TypeScript 里 `#waiting: Plugin | undefined` 如果不赋值，**运行时这个属性根本不存在**（类型擦除！）。

**那读 `child.#waiting` 会怎样？**

返回 `undefined`（因为属性不存在时访问得到 `undefined`）。

**所以功能上是对的** —— 但**属性不存在**和**属性值是 undefined** 在 `'#waiting' in child` 这类检查下会不同。

**我们的代码只用 `child.#waiting` 读值**，所以没问题。

**但这是一个值得注意的细节**：**类型擦除下，"声明了但没初始化"的私有字段在运行时不存在。**

### 3.7 构造函数的改动（改造点 2）

```ts
    this.#registry = parent === undefined ? new Map() : parent.#registry
    this.#dispatchers = parent === undefined ? new Map() : parent.#dispatchers
    this.#pending = parent === undefined ? new Set() : parent.#pending
    this.#onDisposeError = onDisposeError ?? (parent === undefined ? undefined : parent.#onDisposeError)
```

**三行"共享"逻辑，模式完全一样：根创建，子继承。**

**这三行可以抽成一个辅助函数吗？**

```ts
function shared<T>(parent: Context | undefined, make: () => T): T { ... }
```

**可以，但没必要** —— 因为泛型和私有字段访问让抽象变复杂，而**重复只有三行**。

**"三次法则"在这里不适用** —— 因为这三行的**语义各不相同**（注册表、分发器、挂起集合），只是因为同一个模式而写法相似。

**如果将来加到十行，就该抽了。**

### 3.8 `on` / `emit` / `eventNames` / `#dispatcherFor`（改造点 3）

```ts
  on<K extends keyof EventMap>(name: K, listener: Listener<EventMap[K]>): Disposer {
    this.#assertAlive()
    const dispatcher = this.#dispatcherFor(name) as Dispatcher<EventMap[K]>

    const off = dispatcher.on(listener)
    // 监听器的移除也是一项副作用：容器卸载时自动生效
    this.effect(() => {
      off()
    })
    return off
  }
```

#### 逐个细节

**① `#assertAlive()`** —— 和第 3 步的 `provide`/`effect` 一样：卸载后不能再注册。

**② 类型断言 `as Dispatcher<EventMap[K]>`**

```ts
const dispatcher = this.#dispatcherFor(name) as Dispatcher<EventMap[K]>
```

**为什么需要断言？**

因为 `#dispatcherFor` 返回的是 `Dispatcher`（即 `Dispatcher<unknown>`），而这里的 `listener` 是 `Listener<EventMap[K]>`。

**两者类型不匹配** —— `Dispatcher<unknown>.on()` 接受 `Listener<unknown>`，而 `Listener<unknown>` 的参数是 `unknown`（比 `EventMap[K]` 更宽）。

**这是泛型容器的经典问题**：`Map<string, Dispatcher<任何>>` 无法表达"每个键对应不同的类型参数"。

**类型安全在这里有一个缺口**：

```ts
ctx.on('plugin/started', (payload: { name: string }) => {})
// 如果内部错误地把它挂到了 'plugin/pending' 的分发器上……
```

**运行时不会有任何检查** —— 因为 `Map` 的键是字符串，值都是 `Dispatcher`。

**这是"类型化事件表"的固有代价**，写进 L9。

**③ 双重登记**

```ts
const off = dispatcher.on(listener)
this.effect(() => { off() })
return off
```

**两个目的**：

| 动作 | 谁用 |
|---|---|
| `this.effect(...)` | 容器卸载时**自动**移除监听器 |
| `return off` | 调用方可以**主动**提前移除 |

**这和 `provide` 的模式完全一样**（第 3 步的 1.4 节）。

**注意 `this.effect(() => { off() })` 而不是 `this.effect(off)`**：

**两者等价**（`off` 本身就是 `() => void`）。**但包一层更明确地表达了意图** —— "这里要执行的是 off"。

**实际上 `this.effect(off)` 更简洁，而且避免了一次函数分配。** 这是个**风格选择**，不是对错问题。

#### `emit`

```ts
  async emit<K extends keyof EventMap>(name: K, payload: EventMap[K]): Promise<unknown> {
    const dispatcher = this.#dispatchers.get(name)
    // 没人监听 → 直接返回，不创建空的分发器
    if (dispatcher === undefined) return undefined
    return await dispatcher.emit(payload)
  }
```

**注意"没人监听就返回"这个优化** —— 它避免了**为没人关心的事件创建空分发器**。

**但注意它并不能完全避免空分发器**：`on()` 会创建，而 `emit()` 不会。

**这就是缺陷 1 的成因**：`on` 创建的分发器，在最后一个监听器被移除后**不会回收**。

#### `#dispatcherFor`

```ts
  #dispatcherFor(name: string): Dispatcher {
    const existing = this.#dispatchers.get(name)
    if (existing !== undefined) return existing
    const created = new Dispatcher()
    this.#dispatchers.set(name, created)
    return created
  }
```

**标准的"取或创建"模式（get-or-create）**。

**注意它是私有的** —— 外部只能用 `on` / `emit`，不能直接操作分发器。

**这保证了不变式**：分发器一定是从 `on` 创建的，不会有人绕过。

### 3.9 `provide()` 的改动（改造点 4）

```ts
    this.#effects.push(remove)

    // 第 4 步：服务出现了 —— 通知监听器，并唤醒在等它的插件。
    // 注意这里是同步方法里的「发射后不管」：emit 是异步的，我们不阻塞 provide。
    void this.emit('service/provided', { name, owner: this.name })
    this.#wakePending()

    return remove
  }
```

#### `void this.emit(...)` 的含义

**`void` 前缀表示"我知道这是 Promise，我不关心它的结果"。**

**它做两件事**：

| 作用 | 说明 |
|---|---|
| **对读者**：明示"这是刻意的 fire-and-forget" | 不是忘了 `await` |
| **对 lint 工具**：抑制"未处理的 Promise"警告 | 常见规则 |

**但 `void` 不能阻止错误**。如果 `emit` 内部 reject，**仍然是 unhandled rejection**。

**我们的 `emit` 会 reject 吗？** 会 —— 如果某个监听器抛错，`dispatcher.emit` 会把它冒泡上来。

**这是一个真实的缺陷**，写进 L9：

```
void this.emit(...)  →  监听器抛错  →  unhandled rejection  →  可能让进程崩溃
```

**修法**：

```ts
void this.emit('service/provided', {...}).catch((error) => {
  this.#onDisposeError?.(error, this.name)     // 或专门的错误通道
})
```

**为什么没做**：提供事件通知是"附加信息"，我们选择了简化。**但代价是真实的。**

#### `this.#wakePending()` 是同步的

**注意它没有 `void`** —— 因为它的返回类型是 `void`（同步函数）。

**它内部用 `queueMicrotask` 处理异步启动。**

**所以 `provide` 返回时**：

```
✅ 'service/provided' 事件已开始分发（异步）
✅ 挂起插件的唤醒已判定（同步）
❌ 被唤醒插件的 apply 还没执行（微任务里）
```

**这个时序必须记住。**

### 3.10 `plugin()` 的改动（改造点 5）★

```ts
    // 第 4 步：检查依赖是否就绪
    const deps = plugin.inject ?? []
    const missing = deps.filter((name) => !this.#registry.has(name))

    if (missing.length > 0) {
      // 依赖不齐 —— 挂起。等 provide() 唤醒（见 #wakePending）
      child.#waiting = plugin
      this.#pending.add(child)
      void this.emit('plugin/pending', { name: plugin.name, missing })
    } else {
      child.#started = true
      try {
        await plugin.apply(child)
      } catch (error) {
        child.dispose()
        throw error
      }
      void this.emit('plugin/started', { name: plugin.name })
    }
```

#### `plugin.inject ?? []`

**处理"没声明 inject"的情况。**

**为什么不用 `plugin.inject?.length ?? 0 > 0` 之类的？**

因为我们要**具体哪些缺失**（用于事件通知）。所以先归一化成数组。

#### `const missing = deps.filter((name) => !this.#registry.has(name))`

**注意用 `#registry.has()` 而不是 `this.has()`** —— 两者等价（`has` 就是转发到 registry），但**直接用 registry 更直接**。

**也不是 `this.get(name) === undefined`** —— 因为**服务值本身可能是 `undefined`**（第 3 步 3.8 节讲过这个陷阱）。

#### 挂起分支

```ts
child.#waiting = plugin
this.#pending.add(child)
void this.emit('plugin/pending', { name: plugin.name, missing })
```

**三步：记住插件、加入挂起集合、广播。**

**注意 `child.#waiting` 和 `this.#pending.add(child)` 是分开的**：

| 存哪 | 存什么 |
|---|---|
| `child.#waiting` | **哪个插件**（用于后续启动） |
| `#pending`（共享） | **哪些容器**（用于扫描） |

**为什么不把 `{ child, plugin }` 存进 `#pending`？**

**因为 `#pending` 需要按容器查找/删除**（卸载时要 `delete(child)`）。用 `Set<Context>` 让删除是 O(1)。

**代价**：需要两处同步维护（容器和它的插件分开存）。**如果不同步就会出 bug**（比如 `#pending` 里有容器但它的 `#waiting` 是 undefined）。

**我们的 `#wakePending` 里有 `if (plugin === undefined) continue`** —— 这正是对"不同步"的防御。

#### 启动分支

```ts
child.#started = true
try {
  await plugin.apply(child)
} catch (error) {
  child.dispose()
  throw error
}
void this.emit('plugin/started', { name: plugin.name })
```

**`child.#started = true` 放在 `apply` 之前。**

**为什么？** 防止 `apply` 内部的某些操作触发重入（比如 `apply` 里又装载了同一个插件）。

**代价**：如果 `apply` 失败回滚，`#started` 仍然是 `true`。**这个容器不能再被启动了。**

**这是对的** —— 因为 `child.dispose()` 已经把它标记成 disposed，再启动也没意义。

#### 卸载函数的改动

```ts
return (): void => {
  if (unloaded) return
  unloaded = true
  this.#pending.delete(child)      // ← 第 4 步新增
  this.#children = this.#children.filter((candidate) => candidate !== child)
  child.dispose()
}
```

**`#pending.delete(child)` 是"防止幽灵启动"的关键。**

**演示 6 验证了它**（挂起 → 卸载 → 依赖到来 → 不启动）。

### 3.11 `#wakePending()`（改造点 6）★

```ts
  #wakePending(): void {
    for (const child of [...this.#pending]) {
      const plugin = child.#waiting
      if (plugin === undefined) continue

      const deps = plugin.inject ?? []
      if (!deps.every((name) => this.#registry.has(name))) continue

      this.#pending.delete(child)
      child.#waiting = undefined
      queueMicrotask(() => {
        void child.#startSilently(plugin)
      })
    }
  }
```

#### 三个 `continue` 条件

| 条件 | 含义 |
|---|---|
| `plugin === undefined` | 这个容器没有等待的插件（理论上不该发生，防御性） |
| `!deps.every(...)` | 依赖还没齐 |
| （隐式）循环结束 | 全部处理完 |

#### `deps.every(...)` 是"全部"不是"部分"

**`every` 返回 true 当且仅当所有元素都满足。**

```ts
['llm', 'tools'].every((n) => registry.has(n))
// 两个都有才 true
```

**如果用 `some`** —— 只要有一个就绪就启动，那是**错的**（插件可能需要两个一起用）。

#### `delete` + 清空 `#waiting`

```ts
this.#pending.delete(child)
child.#waiting = undefined
```

**两处都要清** —— 因为它们是一对（3.10 节讲的"需要同步维护"）。

**`child.#waiting = undefined` 而不是 `delete child.#waiting`**：

**类型擦除下，`#waiting` 可能本来就不存在**（如果从未挂起过）。**赋 undefined 是安全的**，而 `delete` 语法上也可以但没必要。

#### `queueMicrotask` + `void`

```ts
queueMicrotask(() => {
  void child.#startSilently(plugin)
})
```

**为什么 `void`？** 因为 `#startSilently` 返回 Promise，而我们**有意不 await**（在同步函数里没法 await）。

**`#startSilently` 内部自己 catch 所有错误** —— 所以这个 Promise **永远不会 reject**。

**这就是为什么 `void` 在这里是安全的**（而 `provide` 里的 `void this.emit(...)` 不安全，见 3.9）。

**同一个 `void`，一个安全一个危险** —— 区别在于**被调用的函数是否自己处理了错误**。

### 3.12 `#startSilently()`（改造点 7）

```ts
  async #startSilently(plugin: Plugin): Promise<void> {
    if (this.#started || this.#disposed) return
    this.#started = true
    try {
      await plugin.apply(this)
      void this.emit('plugin/started', { name: this.name })
    } catch (error) {
      // 启动失败：回滚已注册的部分，并上报 —— 绝不能静默
      this.dispose()
      this.#onDisposeError?.(error, this.name)
    }
  }
```

**逐行**：

| 行 | 作用 |
|---|---|
| `if (this.#started \|\| this.#disposed) return` | **双保险**：已启动过或已卸载，都不启动 |
| `this.#started = true` | 先标记（防重入） |
| `await plugin.apply(this)` | 执行装载 |
| `void this.emit('plugin/started', ...)` | 广播成功 |
| `catch` → `dispose()` + 上报 | **失败时回滚并上报** |

**`if (this.#started || this.#disposed) return` 这两个条件分别挡什么？**

| 条件 | 挡什么 |
|---|---|
| `#started` | 重复唤醒（比如两次 `provide` 都触发了同一个容器） |
| `#disposed` | **幽灵启动**（挂起期间被卸载了） |

**第二个条件是必要的第二道防线** —— 虽然卸载函数已经 `#pending.delete(child)` 了，但如果在"删除"和"微任务执行"之间有别的路径……

**实际上，卸载函数删除了它就够**。但**多一层检查成本极低**，而漏掉的后果（启动一个已卸载的插件）很严重。

**这是"深度防御"（defense in depth）**。

---

---

## L4 运行与验证

### 4.1 怎么运行

```powershell
cd D:\agent-harness-lab
node src/demos/demo-events.ts
```

### 4.2 六组演示逐条解读

#### 演示 1 · 调用顺序 = 注册顺序

```
--- 调用顺序（= 注册顺序）---
[ "① 看到 demo-service", "② 看到 demo-service", "③ 看到 demo-service" ]
```

**要观察的**：三个监听器**全部执行**（因为每个都 `return await next()`）。

**这一组验证了规则 3：顺序由注册顺序决定。**

**它为什么重要？** 因为第 9 步的重试策略、第 10 步的守卫都依赖"谁先注册谁先说话"。

#### 演示 2 · 短路（★ 本篇最重要的一组 ★）

```
--- 短路的结果 ---
[ "第一级：放行", "第二级：我处理了，不再往下传" ]
```

**第三级完全没有出现。**

**要观察的三件事**：

| 观察 | 说明 |
|---|---|
| 第一级执行了 | 它 `return await next()`，放行 |
| 第二级执行了 | 它**没有**调 `next()`，直接返回 `{handled: true}` |
| **第三级不出现** | 短路生效 |

**这一组是第 9 步 retry 插件的预演**：

```ts
ctx.on('agent/request-error', async (payload, next) => {
  if (canRetry(payload.error)) return { kind: 'retry' }   // ← 就像这里的"第二级"
  return await next()
})
```

#### 演示 3 · 卸载监听器

```
--- 记录（b 不该出现）---
[ "监听器收到 a" ]
```

**要观察的**：`off()` 之后提供的 `b` **没有触发监听器**。

**注意这里用的是"主动撤销"（返回值）**，不是"容器卸载"（effect）。

**两者的区别**（第 3 步 1.4 节讲过）：

| 路径 | 触发方式 |
|---|---|
| `off()` | 调用方主动 |
| 容器 `dispose()` | 框架自动（通过 effect） |

#### 演示 4 · inject 挂起与唤醒（★ 核心 ★）

```
--- 装载 consumer 之后 ---
[ "挂起：plugin-consumer（缺 llm）" ]

--- 此时 answer 存在吗 ---
false

--- 提供 llm 之后 ---
[ "挂起：plugin-consumer（缺 llm）", "启动：plugin-consumer" ]

--- answer 的内容 ---
我拿到了 llm，模型是 deepseek-chat
```

**五个观察点**：

| 观察 | 说明了什么 |
|---|---|
| 装载 consumer **没有抛错** | `inject` 把"缺依赖"从错误变成了"等待" |
| 有 `plugin/pending` 事件 | 挂起是可观察的（不是静默的） |
| `answer` 不存在 | 因为 `apply` **还没执行** |
| 提供 `llm` 后有 `plugin/started` | 唤醒成功 |
| `answer` 有内容了 | `apply` 执行了，且 `require('llm')` 拿到了值 |

**注意演示里的 `await tick()`**：

```ts
root4.provide('llm', { model: 'deepseek-chat' })
await tick()      // ← 必须等一下
```

**因为启动在微任务里**（1.5 节）。**没有这个 `tick()`，`answer` 会是 `undefined`。**

**这个细节是"异步设计的固有代价"的现场演示。**

#### 演示 5 · 监听器随插件卸载

```
--- 记录（b 不该出现，因为插件已卸载）---
[ "plugin-listener 收到 a" ]

--- root5 现在还有监听器的事件 ---
[ "service/provided" ]
```

**第一段验证了 effect 机制**：插件卸载 → 它的监听器自动移除。

**第二段暴露了一个缺陷**（见 L9 缺陷 1）：**分发器还在**，只是空了。

**如果只有下面这行代码**：

```ts
show('root5 现在还有监听器的事件', root5.eventNames())
```

**你根本不会注意到这个泄漏。** 是 `eventNames()` 这个诊断方法把它暴露出来的。

#### 演示 6 · 挂起的插件被卸载

```
--- 启动记录（应为空）---
[]

--- should-not-exist 存在吗（应为 false）---
false
```

**要观察的**：插件挂起 → 被卸载 → 依赖后来出现 → **不会被启动**。

**这验证了卸载函数里的 `this.#pending.delete(child)`。**

**如果没有那一行**，输出会是：

```
--- 启动记录 ---
[ "启动：plugin-waiting" ]      ← 幽灵启动
--- should-not-exist 存在吗 ---
true                             ← 一个已卸载的插件提供着服务
```

### 4.3 验收判据

| # | 判据 | 验证 |
|---|---|---|
| 1 | 六组演示全部符合上述输出 | 运行 |
| 2 | 演示 2 里第三级**不出现** | 看输出 |
| 3 | 演示 4 里装载后 `answer` 是 `false`、提供后是字符串 | 看输出 |
| 4 | 演示 6 的启动记录为空 | 看输出 |
| 5 | 你能说出 waterfall 的三条规则 | 口述 |
| 6 | 你能说出"为什么短路要写成调用 `next()` 而不是返回值判断" | 口述 |
| 7 | 你能说出 `queueMicrotask` 为什么是必要的 | 口述 |
| 8 | 你能说出直接启动和唤醒启动的**错误处理差异** | 口述 |
| 9 | **关掉文档**能写出 `Dispatcher.emit` | 见 L6 |

---

## L5 语法速查（本篇新增）

> 第 1–3 步的语法分别在 [`01`](01-llm.md#l5-本篇-typescript-语法速查) / [`02`](02-tools.md#l5-语法速查本篇新增) / [`03`](03-context.md#l5-语法速查本篇新增) 里。

| 语法 | 例子 | 含义 | 注意 |
|---|---|---|---|
| **泛型约束** | `<K extends keyof EventMap>` | K 必须是那些键之一 | 索引访问类型的常见搭配 |
| **索引访问类型** | `EventMap[K]` | 取 K 对应的值类型 | 泛型里的"查表" |
| **闭包游标** | `let index = -1; const next = () => { index++ }` | 用闭包记住进度 | waterfall 的实现基础 |
| `queueMicrotask` | `queueMicrotask(() => ...)` | 排到微任务队列 | 比 `setTimeout(0)` 更快 |
| `void` 前缀 | `void promise` | 明示"不关心结果" | **不阻止错误** |
| `Set` | `new Set<Context>()` | 不重复的集合 | 删除是 O(1) |
| `Set.every`（数组的） | `deps.every(...)` | 全部满足才 true | 对比 `some` |
| `declare module` | 模块扩容 | 给已有接口加成员 | 纯类型，会被擦除 |
| **联合返回类型** | `unknown \| Promise<unknown>` | 同步或异步 | 调用方统一 `await` |
| `as` 在泛型上 | `x as Dispatcher<EventMap[K]>` | 类型断言 | **运行时无检查** |

### 本篇新增的三条规则

**规则 14：`void promise` 不处理错误**

```ts
void someAsync()          // ← 如果它 reject → unhandled rejection
void someAsync().catch(handle)   // ✅ 安全
```

**判断标准**：**被调用的函数自己处理了所有错误吗？** 是 → `void` 安全；否 → 必须接。

**规则 15：`declare module` 是纯类型，会被擦除**

```ts
declare module './events.ts' {
  interface EventMap { 'my/event': { x: number } }
}
```

**它在运行时什么都不做** —— 只是让编译器多认识一个事件名。**所以它必须与真实的字符串字面量一致**（写错不会有运行时错误，只会有类型错误）。

**规则 16：`Array.prototype.every` vs `some`**

```ts
[].every(f)     // true  ← 空数组时 every 是 true（容易踩）
[].some(f)      // false
```

**空数组的 `every` 返回 `true`** —— 这在"检查依赖是否齐全"时是**正确的**（没有依赖 = 依赖齐全）。

---

## L6 关文档重写判据

### 必须能写出的部分

| 难度 | 要写的东西 | 通过标准 |
|---|---|---|
| ★ | `EventMap` 和 `Listener<P>` | 四个事件 + 监听器签名 |
| ★★ | `Dispatcher.on` | **幂等 + `indexOf` 查找（不能缓存索引）** |
| ★★★ | **`Dispatcher.emit`** | **快照 + 闭包游标 + 传递 next** |
| ★★★ | `Context.on` / `emit` | 双重登记（effect + 返回） |
| ★★★ | `plugin()` 的 inject 分叉 | 挂起 vs 启动 |
| ★★★★ | `#wakePending` | 快照 + 三个 continue 条件 + 微任务 |
| ★★★★ | `#startSilently` | **自己 catch 并回滚** |

### 卡住时的自检问题

| 卡在哪 | 问自己 |
|---|---|
| `emit` 的快照 | "如果某个监听器在分发时卸载了自己，游标会指向谁？" |
| `next` 的实现 | "怎么让每一级监听器都能'继续往下'？" |
| `on` 的撤销 | "为什么不能缓存索引？" |
| inject 分支 | "依赖不齐时，我应该抛错还是等待？" |
| `#wakePending` | "同步的 `provide` 怎么启动一个异步的 `apply`？" |
| `#startSilently` | "唤醒路径上，`apply` 失败了谁接？" |

### 分级判定

| 程度 | 判定 |
|---|---|
| 能写出 ★★ 及以下 | 不够 L3，重读 3.4–3.5 |
| 能写出 ★★★ | 接近 L3，重点补 `#wakePending` |
| 全部写出（**`emit` 的快照必须写对**） | ✅ **达标** |

---

## L7 挑战题（不给答案）

### 挑战 1 · 实现 serial（广播）分发

现在只有 waterfall。加一个 `Dispatcher.broadcast()`：**每个监听器都被调用，返回值收集成数组。**

**要求**：

1. 加方法 `broadcast(payload): Promise<unknown[]>`
2. `on` 保持一样（同一个监听器列表）
3. 演示：三个监听器都执行，且能拿到三个返回值

**思考**：如果一个监听器抛错，其余还要执行吗？两种选择的代价各是什么？

### 挑战 2 · 加一个"监听器出错"的事件

**当前问题**（见 L9 缺陷 2）：监听器抛错会变成 unhandled rejection。

**要求**：

1. 让 `emit` 捕获监听器错误
2. 触发一个 `'listener/error'` 事件（含错误和监听器信息）
3. 如果没人监听这个事件，把错误**重新抛出**（不能静默）

**思考**：这和第 9 步的"重试"是什么关系？**失败本身也应该是一个事件吗？**

### 挑战 3 · 修掉空分发器的泄漏

**当前缺陷**（L9 缺陷 1）：`on` 创建的分发器在监听器全部移除后不回收。

**要求**：

1. 在 `on` 返回的撤销函数里，检查分发器是否已空
2. 空则从 `#dispatchers` 删掉

**思考**：如果在分发过程中删除了分发器，会不会有问题？（提示：`emit` 已经有快照了）

### 挑战 4 · 让 `inject` 支持"部分依赖"

现在的语义是"**全部**依赖就绪才启动"。

**问题**：

1. 有没有需要"依赖 A 或 B 任一就绪即可"的场景？
2. 如果有，接口应该怎么设计？（提示：`inject: ['a']` vs `inject: { any: ['a','b'] }`）
3. **这个需求是真实的还是过度设计？**

**这道题考察的是"抵抗过度设计的诱惑"。**

### 挑战 5 · 让依赖唤醒"可等待"

**当前缺陷**（L9 缺陷 5）：`provide` 之后立刻读被唤醒插件的服务可能读不到。

**要求**：

设计一个 API 让调用方能等待"所有挂起插件处理完毕"。

**三种方案的代价对比**：

| 方案 | 做法 |
|---|---|
| A | `await ctx.settle()` —— 等挂起集合清空 |
| B | 返回 `provide` 的 Promise，改成异步 |
| C | 提供 `ctx.on('plugin/started')` 让调用方自己等 |

**你选哪个？为什么？**

---

## L8 自检清单

### 理解层（L1）

- [ ] 我能说出 waterfall 的执行模型（能画出来）
- [ ] 我能说出**三条规则**，尤其是"必须 return next()"
- [ ] 我能解释"为什么短路是调用 `next()`，不是返回值判断"
- [ ] 我能说出 `inject` 和 `require` 的区别与各自适用场景
- [ ] 我能解释 `queueMicrotask` 为什么必要
- [ ] 我能说出直接启动和唤醒启动的**错误处理差异**
- [ ] 我能说出"声明合并"为什么让插件自治

### 实现层（L3）

- [ ] 我关掉文档写出了 `Dispatcher.emit`（**含快照和游标**）
- [ ] 我关掉文档写出了 `plugin()` 的 inject 分叉
- [ ] 我关掉文档写出了 `#wakePending`
- [ ] 我关掉文档写出了 `#startSilently`（含自己 catch）
- [ ] 我能解释 `on` 里为什么不能缓存索引

### 语法层

- [ ] 我知道 `void promise` 不处理错误
- [ ] 我知道 `[].every()` 返回 `true`
- [ ] 我会写泛型约束 `<K extends keyof T>`
- [ ] 我知道 `declare module` 会被擦除

### 系统层（L4）

- [ ] 我能说出"加一个新功能从改循环变成挂监听器"意味着什么
- [ ] 我能说出第 9 步的 retry 插件会挂在哪、怎么写
- [ ] 我能说出挂起机制对第 6 步装载器的价值

---

## L9 仍未解决

### 会被后续步骤解决的

| 遗留问题 | 哪一步 |
|---|---|
| 没有隔离：事件全树可见 | 第 5 步（scope） |
| 插件靠代码手工装载 | 第 6 步 |
| 没有"事件发生时的顺序保证"（除了注册顺序） | 第 10 步会用守卫处理 |
| 没有日志：事件分发不可观测 | 第 7 步 |

### 当前实现的真实缺陷

#### 缺陷 1 · 空分发器不回收（演示 5 实测发现）★

```ts
#dispatcherFor(name: string): Dispatcher {
  const existing = this.#dispatchers.get(name)
  if (existing !== undefined) return existing
  const created = new Dispatcher()
  this.#dispatchers.set(name, created)      // ← 只创建，从不删除
  return created
}
```

**现象**：监听器全部卸载后，分发器仍留在 Map 里。演示 5 的 `eventNames()` 直接暴露了它。

**后果**：Map 缓慢增长（上限是"曾经出现过的事件名数量"）。

**严重性**：低（有上限），**但它是"泄漏"这个类别的第一个实例**。

**修法**：见挑战题 3。

**为什么写文档时才发现**：因为我运行了演示，而且**恰好写了 `eventNames()` 这个诊断方法**。

> **教训：诊断方法的缺失会让你看不见缺陷。**

#### 缺陷 2 · `void this.emit(...)` 可能产生 unhandled rejection

```ts
void this.emit('service/provided', { name, owner: this.name })
```

**问题**：如果某个监听器抛错，`dispatcher.emit` 会冒泡，而这个 Promise **没有任何 `.catch`**。

**后果**：

- Node 默认行为：**打印警告**（`UnhandledPromiseRejection`）
- 某些配置下：**进程崩溃**
- 更糟：如果这是在一个 `catch` 块里，错误会**掩盖原本的错误**

**修法**：

```ts
void this.emit('service/provided', {...}).catch((error) => {
  this.#onDisposeError?.(error, this.name)
})
```

**为什么没做**：为了让代码简洁。

**但这个取舍是有问题的** —— 因为"事件通知"是框架的核心机制，它的错误不该被丢弃。

**它和缺陷 1 是同一类**：**"次要路径"上的错误处理被简化了**。

#### 缺陷 3 · 类型断言让跨事件名的类型安全有缺口

```ts
const dispatcher = this.#dispatcherFor(name) as Dispatcher<EventMap[K]>
```

**问题**：`Map<string, Dispatcher>` **无法表达"每个键对应不同的类型参数"**，所以必须断言。

**后果**：如果 `#dispatcherFor` 内部实现有 bug（返回了错误的分发器），**编译器不会发现**。

**这是"类型化事件表"的固有代价。**

**DSH 的做法**：它的类型系统（`typert` 包）有完整的类型图生成，能表达更复杂的关系。**那是几十个包的工程量。**

**我们的取舍**：用断言换简洁。**代价是"类型的可信度依赖实现的正确性"。**

#### 缺陷 4 · `#startSilently` 的名字与行为相反

```ts
async #startSilently(plugin: Plugin): Promise<void>
```

**它其实一点都不"silent"** —— 它 catch 错误、回滚、并**上报**给 `onDisposeError`。

**"silently"的实际含义是**："没有调用方能接住异常，所以我自己处理"。

**更准确的名字**：`#startOrRollback` 或 `#startUnattended`。

**为什么这是个"缺陷"而不是"小瑕疵"**：**名字会误导读者**。看到 `Silently` 的人会以为"出错了不管"，而实际行为完全相反。

**修法**：改名。

#### 缺陷 5 · 唤醒后服务不保证立即可读

```ts
ctx.provide('llm', value)
const x = ctx.get('answer')      // ← 可能还是 undefined！
```

**因为启动在微任务里。**

**后果**：使用方必须知道这个时序，或者用 `await tick()`。

**这是异步设计的固有代价**，但**我们的文档必须在显眼位置写明**（本篇 1.5 节和 4.2 节都提到了）。

**三种修法的代价对比见挑战题 5。**

#### 缺陷 6 · 挂起插件没有超时

```ts
inject: ['never-comes']      // ← 这个依赖永远不会出现
```

**后果**：插件**永远挂起**，既不启动也不报错。**没有任何机制告诉你"它永远不会启动"**。

**修法**：

| 方案 | 说明 |
|---|---|
| 加超时 | `injectTimeout` 配置 —— 超时后报错或警告 |
| 装载完成后检查 | 第 6 步装载器在最后扫一遍 `#pending`，把残留的报出来 |
| 提供诊断 API | `ctx.pendingPlugins()` 让调用方查询 |

**DSH 的做法接近第二种** —— 它在装配结束后会报告"未满足的依赖"。

**为什么现在不做**：第 6 步的装载器才是"装载完成"的判定者，**那时加最合适**。

**这一条也写进第 6 步的设计笔记。**

---

## L10 提问训练

### 本篇引出的 12 个好问题

**关于设计（L3 层）**

1. 为什么 `Dispatcher.emit` 要快照？不做快照会出现什么具体现象？
2. 为什么 `next` 用"闭包游标"而不是"递归传剩余数组"？
3. 为什么 `on` 的撤销函数用 `indexOf` 而不是缓存索引？
4. 为什么 `#wakePending` 用 `queueMicrotask` 而不是同步调用？
5. 为什么 `#startSilently` 和 `plugin()` 里的启动要分开写？

**关于系统（L4 层）**

6. 第 9 步的 retry 插件挂在哪个事件上？它怎么做到"不调 `next()` 就短路"？
7. 第 10 步的守卫如果用事件实现，怎么保证"拒绝不可翻案"？
8. 如果第 5 步要做事件隔离，`Dispatcher` 需要改哪里？
9. **挂起机制对第 6 步的装载器意味着什么？**（提示：装载顺序自由了）

**关于科研（L5 层）**

10. **如果把"每次事件分发"都记录下来，能得到什么科研数据？**（提示：干预机制被触发的完整链路）
11. **"干预 vs 自我修正"能不能用事件系统建模？** —— 自我修正 = 模型自己处理错误；干预 = 一个监听器拦截了错误
12. **挂起/唤醒机制能否用来做"分层消融"实验？**（装载不同的插件组合，其他条件不变）

### 问题升级练习

| 模糊问题 | 精确问题 | 提升在哪 |
|---|---|---|
| "为什么要快照？" | "如果 `emit` 不分发快照，第一个监听器卸载了自己，第二个监听器还会被调用吗？游标会指向谁？" | 要求**推演具体执行过程** |
| "`inject` 有什么用？" | "如果没有 `inject`，配置里把 `agent-loop` 排在 `llm` 前面会怎样？用户必须怎么解决？" | 给出了**具体场景和用户代价** |
| "为什么要用微任务？" | "如果把 `queueMicrotask` 改成直接调用 `child.#startSilently(plugin)`，`provide` 返回后 `answer` 能读到吗？为什么？" | 要求**判断时序后果** |

> ### 你的练习
>
> 挑一个改写，发给我：
>
> 1. "为什么事件要分 waterfall 和 serial？"
> 2. "挂起机制有什么代价？"
> 3. **"如果我要做'分层消融'实验，事件系统能支持吗？"**

---

## L11 系统影响回溯

### 11.1 三个预判的检验

| 第 0.5 节的问题 | 现在你应该能答的 |
|---|---|
| 不复制快照会怎样？ | `index` 会跳过或重复调用监听器 —— 因为 `this.#listeners` 在分发中被修改了，而 `index` 是按**旧顺序**推进的 |
| `eventNames()` 仍返回 `["service/provided"]` 说明什么？ | **分发器没被回收** | 
| A、B 都依赖 `llm`，启动顺序是什么？ | **取决于 `#pending` 的迭代顺序**（即它们被挂起的顺序 = 装载顺序）。**我们的实现没有额外排序保证。** |

**第 3 个问题的答案值得展开**：

我们用的是 `Set`，它**保证插入顺序**。所以唤醒顺序 = 挂起顺序。

**但这是"实现细节"还是"接口保证"？**

**我们没有在文档里承诺它** —— 所以使用者**不应该依赖**这个顺序。

**如果要保证顺序**，需要：

```ts
const ready = [...this.#pending].filter(...).sort(bySomeRule)
```

**而"按什么规则排序"是个设计问题**（按插件名？按优先级声明？）。

**这说明：接口设计时的"不承诺"也是一种决策。** 不承诺 = 以后可以改。

### 11.2 本篇的"锚点"一句话

> **插件通过"挂在事件上"来介入，而不是通过"修改别人的代码"；不调 `next()` 就是到此为止。**

它在后面的影子：

| 哪一步 | 同一思想的再现 |
|---|---|
| 第 5 步 | 作用域是"查找链多一层"，事件仍是全局的 |
| 第 6 步 | 装载器靠 `inject` 支持任意顺序 |
| 第 9 步 | **重试插件 = 一个监听 `request-error` 的监听器，短路返回 `{kind:'retry'}`** |
| 第 10 步 | **守卫 = 监听 `tools/pre-execute` 的监听器** |
| 第 15 步 | 诊断也挂在事件上，观察每次失败 |
| 第 16 步 | 演化监听"门控失败"事件 |

**第 9、10 两步是本篇的直接产物** —— 它们加起来大约只有 200 行，因为**机制已经在第 4 步建好了**。

### 11.3 通向第 5 步的桥

**第 4 步结束时，系统状态：**

```
✅ 插件能提供能力（第 3 步）
✅ 插件能监听事件、声明依赖（第 4 步）
❌ 但一切仍然是全局的：事件、服务都是全树共享
❌ 不同 agent 无法有不同的工具集
```

**第 5 步要解决"隔离"。** 带着这些问题进入：

1. 现在 `ctx.get('tools')` 返回的是**唯一一个**工具注册表。两个 agent 想要不同的工具集，怎么办？
2. 第 3 步选的是"全局命名空间 + owner 记账"。**要加隔离，是改这个决定，还是叠加一层？**
3. 如果加了局部层，**查找顺序**应该是什么？
4. **事件要不要也做隔离？** 如果要，`Dispatcher` 要怎么改？

**第 2 个问题是第 5 步的核心** —— 而它的答案在第 3 步就已经埋好了（1.8 节说的"扩展是叠加，不是改写"）。

**第 4 个问题我们可能不解决**（列入已知限制），因为**事件隔离的复杂度远高于服务隔离**。

---

## 本篇完结

| 检查项 | 应该达到 |
|---|---|
| 能画出 waterfall 的执行模型 | L1 |
| 能复述三条规则 | L1 |
| 能说出 `inject` 与 `require` 的区别 | L1 |
| 能解释 `queueMicrotask` 为什么必要 | L1 |
| **能关掉文档写出 `Dispatcher.emit`** | **L3** |
| **能关掉文档写出 `#wakePending`** | **L3** |
| 能说出"加功能从改循环变成挂监听器"的意义 | L4 |
| 能提出至少 3 个 L4/L5 层的问题 | L4 |

---

**读完这篇，请回答我三个问题：**

1. **那三条规则**里，"调了 `next()` 必须 `return`"这条 —— 你能想到它会导致什么**具体症状**吗？（提示：功能正常但返回值不对）
2. **缺陷 2**（`void emit` 的错误无人接）：你觉得"事件通知"的错误应该**上报给谁**？这算框架错误还是插件错误？
3. **下一站**：`05-scope.md`（作用域隔离），还是先写你科研最需要的 `07-session.md`？
# 第 3 步 · 上下文容器（ctx）

> **代码**：`src/framework/context.ts`（251 行） · **演示**：`src/demos/demo-context.ts`
> **DSH 对应**：`vendor/cordis/src/context.ts` + `service.ts` + `fiber.ts`（三合一）
> **本篇目标级别**：L3（关掉文档能从零重写）
> **预计阅读**：80–110 分钟 · **预计动手**：90 分钟

---

## 本篇新词

> 全部术语在 [`glossary.md`](glossary.md)。先花 90 秒扫一遍。

| 词 | 一句话 | 为什么必须懂 |
|---|---|---|
| **plugin（插件）** | 一段能独立装卸的功能代码，拿到专属容器 | 本课程里一切功能都是插件 |
| **context / ctx（容器）** | 负责登记服务、查找服务、装载插件的对象 | 插件靠它发现彼此，**不靠 import** |
| **service（服务）** | 挂在容器上的具名能力（`tools`、`llm`） | 插件交出能力的唯一方式 |
| **DI（依赖注入）** | "我声明需要什么，由容器给我"，而非自己 `new` | 没有它就无法替换和测试 |
| **effect（副作用登记）** | "我做了这个改动，卸载时记得撤销" | 没有它就会服务泄漏 |
| **disposer（撤销函数）** | 调用它撤销某个注册 | 精细控制撤销范围 |
| **idempotent（幂等）** | 重复执行效果不变 | 卸载可能被触发多次 |
| **lifecycle（生命周期）** | 创建 → 激活 → 卸载的全过程 | 回答"这个服务现在还在不在" |
| **fiber** | Cordis 里"一个插件的装载单元" | 就是我们说的插件子容器 |
| **closure（闭包）** | 函数记住了它被创建时的环境 | 撤销函数靠它记住该删哪个名字 |
| **fail loud（响亮失败）** | 出错立刻抛，不静默降级 | 让 bug 在装载期暴露 |
| **shadowing（遮蔽）** | 内层盖住外层的同名东西 | 第 5 步 scope 的基础 |

---

## 第 0 节 · 这一步的成品长什么样

### 0.1 最终你会写出什么

**一个文件，251 行，但它改变了整个项目的组织方式。**

```
┌────────────────────────────────────────────────────────────────────┐
│  context.ts —— 插件容器                                            │
│                                                                    │
│  类型层                                                            │
│    ① Disposer          撤销函数类型                                │
│    ② Plugin            插件接口（name + apply）                     │
│    ③ ServiceEntry      服务记录（owner + value）← 关键              │
│                                                                    │
│  Context 类                                                        │
│    服务     provide / get / require / has / serviceNames / ownerOf  │
│    副作用   effect                                                 │
│    插件     plugin()  ← 装载，返回卸载函数                          │
│    生命周期 dispose() / #assertAlive()                              │
│    调试     parent / children / tree()                              │
└────────────────────────────────────────────────────────────────────┘
```

### 0.2 运行起来是什么样

```powershell
node src/demos/demo-context.ts
```

关键输出：

```
--- 每个服务是谁注册的 ---
[ "config ← plugin-config", "greeting ← plugin-greeter" ]

--- 容器树的形状 ---
root1[plugin-config plugin-greeter]

--- require 抛出的错误 ---
[root1] 找不到服务 "nonexistent"；当前可用：config, greeting

--- 撤销顺序（注意是倒过来的） ---
[ "③ 被撤销", "② 被撤销", "① 被撤销" ]

--- half-broken 留下的服务（应该是空的） ---
[]

--- 后来的插件被拒绝 ---
[plugin-rival] 服务重复注册："config"（已被容器 "plugin-config" 注册）
```

**注意最后三条**：撤销是逆序的、装载失败回滚干净、重名报错**指出是谁占的**。

### 0.3 这一步在整个课程里的位置

```
第 1 步          第 2 步           第 3 步（你在这里）    第 4–6 步
 模型层    ──►    工具层     ──►    ctx 容器      ──►    事件/scope/装载器
"能说话"         "能做事"          "能装卸"            "能组合"
```

**前三步做完，你手里有三个"能力"，但它们还是硬连线的。** 从第 3 步起，它们变成**插件**。

---

## 第 0.5 节 · 系统视角

### 你在哪里

```
                    ⑦ 入口层（第 11 步）
                            ▲
                    ⑥ 组合层（第 6 步）
                            ▲
        ┌───────────────────┼───────────────────┐
        │                   │                   │
   ⑤ framework/        ④ plugins/         ⑤ evolution/
    ★ 你在这里 ★        （第 7–10 步）      （第 12–16 步）
   ctx / 事件 / scope
        │                   │                   │
        └───────────────────┼───────────────────┘
                            ▼
                  ③ kernel/（第 1–2 步）
                  模型层 + 工具层
```

**第 3 步是"框架层"的第一块砖。** 它之上的一切都将以"插件"的形态存在。

### 下游：谁在用 ctx 的东西

| 第 3 步的产物 | 谁消费 | 用来做什么 | 依赖强度 |
|---|---|---|---|
| `Context` 类 | **后面每一步的每一个插件** | 注册服务、装载插件 | 🔴 极强 |
| `Plugin` 接口 | 第 7–16 步的所有插件 | 定义插件形状 | 🔴 极强 |
| `Disposer` 类型 | 第 4 步事件监听、第 7 步日志订阅 | 统一的"可撤销"表示 | 🔴 强 |
| `provide/get/require` | 第 7–10 步的服务装配 | 插件间通信 | 🔴 强 |
| `effect()` | 第 4 步的事件注册、第 7 步订阅 | 自动回滚 | 🔴 强 |
| `plugin()` 返回的卸载函数 | 第 6 步装载器 | 卸载整棵子树 | 🔴 强 |
| `tree()` | 第 6 步 `dump-config` | 打印实际装载的树 | 🟡 弱（调试用） |

### 连锁影响分析

#### 连锁 1：如果服务注册进"插件自己的子容器"（★ 真实发生过 ★）

```
provide() 把服务写进 this（插件子容器）
   ↓
兄弟插件查不到它（查找路径是"自己 → 父 → 根"，跨不过兄弟分支）
   ↓
★ 报错：[plugin-greeter] 找不到服务 "config"；当前可用：(无) ★
   ↓
如果就这么发布：插件之间永远无法协作
   ↓
★ 整个"插件化"失去意义 —— DSH 那 307 个包也建不起来 ★
```

**这不是假设，是我写第 3 步时真的踩到的坑**，完整复盘见 L1 的 1.2 节。

**它最可怕的地方**：报错信息（"找不到服务"）**指向消费者，而问题在提供者**。你会去查 `greeter` 写错了什么，而真正的问题在 `provide` 的实现里。

#### 连锁 2：如果卸载不是逆序

```
按注册顺序执行撤销
   ↓
某插件先注册 llm，再注册依赖 llm 的 agent-loop
   ↓
正序：先拆 llm
   ↓
再拆 agent-loop 时，它的撤销逻辑需要 llm
   ↓
★ 撤销过程本身抛错 ★
   ↓
若这个错误被 catch 并忽略 → 该插件的一部分注册永久残留（服务泄漏）
```

**这就是"先脱外套再脱衬衫"的道理** —— 顺序错了，动作就做不下去。

#### 连锁 3：如果装载失败不回滚

```
插件装载到一半抛错（先 provide 了一个服务，然后校验配置失败）
   ↓
不回滚：那个服务名被一个"半死的插件"占着
   ↓
下一次尝试装载同一个插件
   ↓
★ 报错："服务重复注册" —— 一个和真实原因毫无关系的错误 ★
   ↓
你会去查注册逻辑，而真正的问题在三次之外的装载失败
```

**"半个插件"是最难查的一类 bug，因为它把错误伪装成另一个错误。**

### 现在该建立的三个习惯

| 习惯 | 做法 | 训练什么 |
|---|---|---|
| **给错误信息带上"是谁"** | `已被容器 "plugin-config" 注册`，而不是"已被注册" | 缩短排查路径 |
| **想到"撤销也要有顺序"** | 任何"申请-释放"配对都问一句顺序 | 资源管理直觉 |
| **区分"真失败"和"伪装失败"** | 报错说的事**往往不是真正的问题** | 反误导能力 |

> ### 停下来想一想（不给答案）
>
> 1. 如果 `provide` 允许**更后面的覆盖先前的**（后来的赢），连锁 1 的问题会被"掩盖" —— 但会带来什么新问题？
> 2. 连锁 3 里，"半个插件"占着的那个服务名，除了导致"重复注册"，还可能造成什么其他症状？
> 3. 如果第 5 步要加"局部遮蔽"，查找逻辑该怎么改，才能**同时**满足"兄弟可见"和"内层优先"？

---

## L0 要解决的问题

### 0.1 第 2 步结束时，代码是「硬连线」的

```ts
// 到第 2 步为止，一切都这么搭起来
const registry = new ToolRegistry()
for (const tool of builtinTools) registry.register(tool)
const provider = new DeepSeekProvider({ apiKey })
const ctx = { workspace }
```

**三个问题，越往后越痛：**

| 问题 | 具体后果 |
|---|---|
| **换任何一个部件都要改调用方** | 想用 `MockProvider` 做测试 → 改 `main.ts` |
| **关功能没有统一办法** | 想关掉重试 → 给主循环加 `if (config.retryEnabled)` |
| **依赖关系靠 import 表达** | 循环 import、测试要连坐加载一整条链 |

### 0.2 目标形态

```
现在（硬连线）                          目标（插件树）

main.ts                                 loader
  └─ new Agent()                          └─ 装载 profile
       ├─ new DeepSeekProvider()                ├─ plugin-llm      → ctx.llm
       └─ new ToolRegistry()                    ├─ plugin-tools    → ctx.tools
                                                ├─ plugin-retry    → 监听事件
想换 Provider？                                  └─ plugin-guard    → 监听事件
改 main.ts 的代码
                                        想换 Provider？
                                        改 profile.json，代码零改动
```

### 0.3 这一步要回答的三个问题

| # | 问题 | 本篇的位置 |
|---|---|---|
| 1 | 插件怎么把自己的能力**交出去**？ | 服务的注册与查找 |
| 2 | 卸载一个插件时，它注册的东西**怎么全部撤销**？ | effect + 子容器归属 |
| 3 | 插件之间怎么**协作**，而不互相 import？ | 共享命名空间（1.2 节） |

**第 3 个问题最难，也是我踩过坑的地方。**

---

## L1 设计与原理

### 1.1 三个概念，一句话各一个

```
┌──────────┬──────────────────────────────────────────────────────────┐
│ 服务      │ 挂在 ctx 上的能力，别人用 ctx.get('名字') 取                │
│ 副作用    │ 任何注册都要能被撤销 —— 卸载时自动回滚                     │
│ 插件      │ 一段装载逻辑，拿到专属子容器                               │
└──────────┴──────────────────────────────────────────────────────────┘
```

**三者构成一个闭环：**

```
插件装载 → 往自己的子容器登记服务/副作用 → 卸载时全部逆序回滚
   ▲                                              │
   └──────────────────────────────────────────────┘
```

### 1.2 ★ 服务归属规则：这一步最关键的决策（含完整踩坑记录）★

#### 第一版设计（错的）

**直觉上最自然的写法**：服务注册进**插件自己的子容器**。

```ts
// 错误的第一版
provide<T>(name: string, value: T): void {
  this.#services.set(name, value)      // ← 写进 this（也就是插件子容器）
}
```

**这个设计看起来无懈可击**：每个插件管好自己的东西，卸载时清空自己的表。

#### 实际运行结果

演示 1 直接崩了：

```
Error: [plugin-greeter] 找不到服务 "config"；当前可用：(无)
```

`config` 明明注册过了，`greeter` 却说"一个都没有"。

#### 为什么

画出容器树就清楚了：

```
    root1
     ├── plugin-config    ← 'config' 注册在【这一层】
     └── plugin-greeter   ← 查 'config' 时向上找：自己 → root1 → 找不到
```

**`greeter` 的查找路径是"自己 → root1"，而 `config` 躺在兄弟分支里 —— 两条路径永不相交。**

#### 为什么这个设计会让框架彻底失去意义

**这不是"少写一行"，而是架构性错误。**

> 如果插件之间互相看不见对方提供的服务，那"插件化"就没有任何价值。

**现实证据**：DSH 里 `dsh-llm` 插件提供 `ctx.llm`，**所有**其他插件都要能用它。按第一版设计：

```
dsh-llm 提供 ctx.llm
   ↓
只有 dsh-llm 自己看得到
   ↓
dsh-agent-loop 拿不到 llm → 无法发请求
   ↓
★ 整个 harness 跑不起来 ★
```

**而 DSH 有 307 个包** —— 每个包都要用别人的服务。这个设计会让 307 个包全部失效。

#### 修正后的规则

> **服务注册进全树共享的唯一命名空间；每条记录记下"谁注册的"，卸载时按归属精确移除。**

```ts
/** 共享注册表里的一条服务记录。 */
interface ServiceEntry {
  /** 谁注册的。卸载那个容器时，这条记录会被精确移除。 */
  readonly owner: Context
  readonly value: unknown
}

provide<T>(name: string, value: T): Disposer {
  const existing = this.#registry.get(name)
  if (existing !== undefined) {
    // 报错信息里带上「是谁占的」—— 这条信息在排查时价值极高
    throw new Error(`[${this.name}] 服务重复注册："${name}"（已被容器 "${existing.owner.name}" 注册）`)
  }

  this.#registry.set(name, { owner: this, value })
  // ...
}
```

**修正后运行结果**：

```
--- 每个服务是谁注册的 ---
[ "config ← plugin-config", "greeting ← plugin-greeter" ]
```

**`ownerOf()` 就是为排查而生的** —— 它能回答"这东西到底谁挂上来的"。

#### 代价必须说清

**这个设计默认没有隔离。** 一个进程里，服务名是全局唯一的。

| 后果 | 说明 |
|---|---|
| 两个插件不能提供同名服务 | 会直接报错（这反而是好事） |
| 不同 agent 无法用不同的 `tools` | ❌ **这是真限制** |

**第 5 步的 scope 会补上显式隔离层。** 这是**取舍，不是疏忽**。

#### 这个坑教给我们的三件事

| 教训 | 推广 |
|---|---|
| **直觉设计可能整体错误** | 写代码前先画"数据怎么流动"的图 |
| **报错指向的位置可能不是问题所在** | "找不到服务"报在消费者，问题在提供者 |
| **要用极端情况检验设计** | "如果有 307 个包互相依赖，这个设计成立吗？" |

### 1.3 为什么插件拿到的是「专属子容器」

```ts
async plugin(plugin: Plugin): Promise<Disposer> {
  const child = new Context(plugin.name, this)   // ← 新建子容器
  this.#children.push(child)
  await plugin.apply(child)                      // ← 插件只拿到 child
  // ...
}
```

**对比：如果直接把 `this` 交给插件会怎样？**

```
root
 └── （所有插件都往 root 上注册）

卸载插件 A 时：
  要删掉 A 注册的东西 —— 但 root 上混着 A、B、C 的注册
  ★ 分不清哪些是 A 的 ★
```

**后果二选一：**

| 做法 | 后果 |
|---|---|
| 保守（少删） | **服务泄漏**：A 卸载了，它的服务还挂在 root 上 |
| 激进（多删） | **误删 B 的注册** → B 崩溃 |

**归属清晰，是卸载安全的前提。**

### 1.4 `Disposer` 与 `effect` 为什么两者都要

```ts
const remove = (): void => {
  const current = this.#registry.get(name)
  if (current !== undefined && current.owner === this) {
    this.#registry.delete(name)
  }
}
this.#effects.push(remove)   // ① 登记进副作用列表
return remove                // ② 也返回给调用方
```

| 谁 | 什么时候用 | 场景 |
|---|---|---|
| **effects 列表** | 插件卸载时，**框架**自动清理 | 插件不需要记得清理 |
| **返回的 `Disposer`** | 插件**主动**想提前撤销某项 | 动态换一个 Provider |

**演示 3 验证了 ① 在起作用**：

```
--- 卸载前可见服务 ---  [ "config", "greeting" ]
--- 卸载后可见服务 ---  [ "config" ]
--- config 还在吗（它属于另一个插件） ---  true
```

**`unloadGreeter()` 一调，`greeting` 自动消失，而 `config`（属于另一个插件）安然无恙。**

### 1.5 卸载必须逆序

```ts
for (const disposer of [...this.#effects].reverse()) {
```

**演示 4 的输出**：

```
--- 撤销顺序（注意是倒过来的） ---
[ "③ 被撤销", "② 被撤销", "① 被撤销" ]
```

**为什么？后注册的东西可能依赖先注册的。**

```
某插件：
  ① provide('llm', ...)                ← 先注册
  ② provide('agentLoop', 用 llm 构造)   ← 后注册，依赖 ①

正序撤销（错）：先拆 llm → 再拆 agentLoop 时它正需要 llm → 抛错
逆序撤销（对）：先拆 agentLoop → 再拆 llm → 干净
```

**两个实现细节**：

```ts
for (const disposer of [...this.#effects].reverse()) {
//                     ▲ 先复制
  try {
    disposer()
  } catch (error) {
    this.#onDisposeError?.(error, this.name)   // ← 单项失败不阻断其余
  }
}
```

| 细节 | 理由 |
|---|---|
| `[...this.#effects]` 先复制 | `reverse()` **原地修改数组**；复制一份避免改到内部状态 |
| 单项失败只上报不中断 | 一个坏插件的撤销失败，不该让整个卸载卡死 |

**但"不中断"不等于"吞掉"** —— 通过 `#onDisposeError` 上报出去。

**这就是"空 catch 必须命名错误并说明为什么"的实践**（DSH 的仓库规范明确要求这一点）。

### 1.6 fail loud：`require` 为什么不返回 `undefined`

```ts
require<T>(name: string): T {
  if (!this.has(name)) {
    const available = this.serviceNames().join(', ')
    throw new Error(`[${this.name}] 找不到服务 "${name}"；当前可用：${available === '' ? '(无)' : available}`)
  }
  return this.get<T>(name) as T
}
```

**演示 2 的输出**：

```
--- require 抛出的错误 ---
[root1] 找不到服务 "nonexistent"；当前可用：config, greeting

--- 用 get 查（自己判空，不抛错） ---
undefined
```

**两个方法，两种语义：**

| 方法 | 行为 | 什么时候用 |
|---|---|---|
| `require` | 找不到就**抛错** | **声明式依赖** —— 装载时就要炸 |
| `get` | 找不到返回 `undefined` | **探测式查询** —— 可选依赖 |

**为什么不都用 `get`？**

因为"缺少依赖"是一个**必须在装载时就暴露**的错误：

```
用 get：
  const llm = ctx.get('llm')        // → undefined
  ... 50 行之后 ...
  llm.chat(...)                     // ★ TypeError: Cannot read properties of undefined ★
  → 你看到的错误和真实原因隔了 50 行

用 require：
  const llm = ctx.require('llm')    // ★ 立刻炸，并告诉你「当前可用：config, greeting」★
  → 一眼看出是装载顺序或服务名写错了
```

**这是"让错误在最早的可能点暴露"。**

**DSH 的规范里有一条对应**：

> 「Misconfiguration fails loud at load when self-contained, otherwise at the earliest resolvable point; **never silently skip a missing referent**.」

**注意后半句**：绝不静默跳过缺失的引用。

### 1.7 装载失败必须回滚

```ts
try {
  await plugin.apply(child)
} catch (error) {
  // 装载到一半失败：必须把已注册的部分撤干净，否则会留下「半个插件」——
  // 它占着服务名，让下一次重试直接报「重复注册」，非常难查。
  child.dispose()
  throw error
}
```

**演示 5 验证了它**：

```
--- 装载失败的报错 ---
插件装载到一半，突然失败

--- half-broken 留下的服务（应该是空的） ---
[]
```

**为什么这 2 行至关重要？**

**"半个插件"的特征是：它把错误伪装成另一个错误。**

```
真实原因：装载失败（可能是一次配置错误）
    ↓ 若不留回滚
遗留：服务名被占用
    ↓ 下次装载时
你看到的：★ "服务重复注册" ★
    ↓
你的排查方向：去查注册逻辑（错的方向）
```

**这叫"错误伪装"** —— 它让排查成本从"看一行日志"变成"翻三层代码"。

### 1.8 查找链的演进：为什么第 5 步还能加隔离

**现在是"一张全局表"**：

```ts
get<T>(name: string): T | undefined {
  const entry = this.#registry.get(name)
  return entry === undefined ? undefined : (entry.value as T)
}
```

**第 5 步会变成"两层"**：

```
ctx.get('tools')
   │
   ├─ ① 沿容器树向上找「局部覆盖表」  ← 作用域自己提供的（命中就返回）
   │
   └─ ② 全局注册表                  ← 默认的、共享的
```

**这两个设计会冲突吗？不会，因为它们是叠加的：**

| 层 | 可见范围 | 用途 |
|---|---|---|
| 全局注册表（第 3 步） | 全树 | 共享服务：`llm`、`session`、`logger` |
| 局部覆盖表（第 5 步） | 该子树 | 隔离服务：每个 agent 自己的 `tools` |

**关键**：**局部层是"可选的额外层"，不是替换全局层。**

**所以第 3 步的代码在第 5 步只需要"加一条查找路径"，不需要重构。**

**这是好分层的标志 —— 扩展是叠加，不是改写。**

> ### 停下来想一想（不给答案）
>
> 1. 如果 `provide` 允许**静默覆盖**（后来的赢），连锁 1 的问题会被"掩盖" —— 但会带来什么新问题？
> 2. `effects` 数组在 `dispose()` 后设为 `[]`。如果**不设**会怎样？
> 3. `require` 的错误信息里列出了"当前可用"的服务。这个列表在什么情况下会**误导**你？

---

## L2 决策表

| # | 决策 | 我们的选择 | 替代方案 | 代价落在谁身上 |
|---|---|---|---|---|
| 1 | 服务归属 | 全局命名空间 + owner 记账 | 注册进插件私有容器 | **默认无隔离**；换来插件间可协作（后者已证明会崩） |
| 2 | 重复注册 | 报错并**指出占用者** | 静默覆盖 / 不检查 | 插件冲突会失败；换来"调 A 跑 B"绝迹 |
| 3 | 插件容器 | 新建子容器 | 直接传 `this` | 多一层对象；换来卸载时归属清晰 |
| 4 | `Disposer` | 既登记 effect 又返回 | 只返回 / 只登记 | 多一行；换来两种用法都能满足 |
| 5 | 卸载顺序 | **逆序** | 正序 | 无代价，纯正确性要求 |
| 6 | 撤销失败 | 不阻断，但上报 | 中断卸载 / 静默吞掉 | 需要 `onDisposeError`；换来卸载总能完成且可诊断 |
| 7 | 缺依赖 | `require` 抛错 | `get` 返回 undefined | 调用方要选对方法；换来 bug 不飘远 |
| 8 | 装载失败 | **回滚已注册部分** | 留着不管 | 多 2 行；换来不留"半个插件" |
| 9 | 插件名 | 必填且用于报错 | 可选 | 每个插件多写一个字段；换来报错可读 |
| 10 | 卸载函数 | 幂等（`unloaded` 标志） | 直接执行 | 多一个布尔；换来重复卸载无害 |
| 11 | 隔离 | **本步不做** | 现在就做 | 留一个已知限制；换来不与第 5 步冲突 |

### 关于第 10 条的完整论证

```ts
let unloaded = false
return (): void => {
  if (unloaded) return
  unloaded = true
  this.#children = this.#children.filter((candidate) => candidate !== child)
  child.dispose()
}
```

**为什么"卸载"要幂等？**

因为**调用方可能不小心调两次**：

```ts
const unload = await ctx.plugin(p)
unload()           // 主动卸载
root.dispose()     // 整体卸载时又会遍历子容器
// → 如果没有保护，child.dispose() 会被调用两次
```

**`Context.dispose()` 本身也幂等**（第一行 `if (this.#disposed) return`），所以这里有**双重保护**。

**为什么需要双重？** 它们挡的是不同场景：

| 保护 | 挡什么 |
|---|---|
| `unloaded` 标志 | 同**一个**卸载函数被调用多次 |
| `#disposed` 标志 | **不同路径**都试图卸载同一个容器（插件自己调了 `child.dispose()`，之后父容器又调一次） |

### 关于第 11 条（本步不做隔离）

**这是一个"故意留的缺口"。**

| 选项 | 后果 |
|---|---|
| 现在做隔离 | 会与第 5 步的设计冲突（第 5 步才是想清楚隔离语义的地方） |
| **先不做，留已知限制** | ✅ 本步聚焦"插件能协作"，隔离单独一步想清楚 |

**这种"分步决策"很重要**：不要在还没想清楚的地方仓促设计。**把它写进 L9 的已知缺陷，比仓促实现好。**

---

## L3 实现：逐行讲解

> 每小节先给**完整代码**（与源文件一字不差），再逐行/逐块解释。

### 3.0 全文件的四节结构

```
┌─── 类型层（34–56 行）    Disposer / Plugin / DisposeErrorHandler / ServiceEntry
├─── 字段与构造（71–91 行） 七个私有字段 + 构造函数（★ 注册表共享在这里）
├─── 只读视图（93–112 行）  parent / disposed / children / tree
└─── 行为（114–251 行）    服务 / 副作用 / 插件 / 卸载
```

---

### 3.1 文件头注释（第 1–32 行）

```ts
/**
 * 第 3 步 ｜ 上下文容器（ctx）：整个框架的心脏
 *
 * 在这之前，我们的代码是「硬连线」的：
 *     main.ts → new Agent() → new DeepSeekProvider() → new ToolRegistry()
 * 想换掉其中任何一个，都必须改 main.ts 的代码。
 *
 * 从这一步开始改成「插件树」：
 *     每个插件拿到一个专属的子容器，把能力**注册**上去；
 *     别人要用，就按名字**查找**。
 *     谁注册了什么、谁依赖谁，全部通过 ctx 中转 —— 没有任何两段代码直接 import 彼此。
 *
 * ┌──────────┬──────────────────────────────────────────────────────────┐
 * │ 服务      │ 挂在 ctx 上的能力，别人用 ctx.get('名字') 取                │
 * │ 副作用    │ 任何注册都要能被撤销 —— 卸载时自动回滚                     │
 * │ 插件      │ 一段装载逻辑，拿到专属子容器                               │
 * └──────────┴──────────────────────────────────────────────────────────┘
 *
 * ── 服务归属规则（这一步最关键的决策）─────────────────────────────────────
 *
 * 服务注册进**全树共享的唯一命名空间**，但每条记录都记下「是哪个容器注册的」。
 * 为什么不能让它只在自己那个子容器里可见？因为那样兄弟插件就互相看不见了：
 *
 *     root
 *      ├── plugin-config   ← 在这里注册 'config'
 *      └── plugin-greeter  ← 它查 'config' 时会向上找到 root，永远查不到兄弟的
 *
 * 结果就是「插件之间无法协作」，框架直接失去意义。
 * 所以：**注册写到共享表，归属记在注册者身上，卸载时按归属精确移除。**
 *
 * （代价：默认没有隔离。第 5 步会用 scope 补上显式的隔离层。）
 */
```

**这段注释有 32 行，比很多函数都长。它值得吗？值得。**

#### 逐段拆解它的结构

| 段落 | 内容 | 作用 |
|---|---|---|
| 第 1 段 | "在这之前，我们的代码是硬连线的" + 具体例子 | **交代历史**：说明这个文件解决了什么 |
| 第 2 段 | "从这一步开始改成插件树" + 三条规则 | **交代目标**：现在的组织方式 |
| ASCII 框 | 三个概念的一句话定义 | **速查表**：读者随时回来看 |
| "服务归属规则"段 | **完整的决策记录 + 反例图 + 代价** | ★ **最有价值的一段** ★ |
| 最后一行 | "代价：默认没有隔离，第 5 步会补" | **诚实标注限制** |

#### 第四段为什么最有价值

它记录的是**一个曾经的错误设计以及为什么错**：

```
root
 ├── plugin-config   ← 在这里注册 'config'
 └── plugin-greeter  ← 它查 'config' 时会向上找到 root，永远查不到兄弟的
```

**这段注释的存在，是为了让下一个改这个文件的人不要重蹈覆辙。**

**对比两种写法的价值**：

| 写法 | 下一个人会做什么 |
|---|---|
| 只写"服务注册进共享命名空间" | 可能想"为什么要共享？改成私有更干净"，然后重新踩坑 |
| **写明"私有会导致兄弟不可见，框架失去意义"** | 知道这条路走不通，不会再试 |

**这是"记录被否决的方案"的实践。** DSH 里有对应的机制 —— 每个包里都可以链接到 `.agents/notes/` 下的决策记录。

#### 注释里的代码示例也是代码

注意这段：

```ts
 *     main.ts → new Agent() → new DeepSeekProvider() → new ToolRegistry()
```

**它用箭头画出了"硬连线"的形态。** 一个图胜过三句话。

**写注释时可以用 ASCII 图** —— 只要它比散文更清楚。

---

### 3.2 `Disposer` 与 `Plugin`（第 34–46 行）

```ts
/** 撤销函数：调用它，对应的注册就消失。必须幂等（重复调用无害）。 */
export type Disposer = () => void

/** 一个插件。 */
export interface Plugin {
  /** 插件名。会出现在日志和报错里，必须唯一且可读。 */
  readonly name: string
  /**
   * 装载逻辑。
   * @param ctx 这个插件的**专属子容器**；它在这里登记的一切都挂在这个子容器上
   */
  apply(ctx: Context): void | Promise<void>
}
```

#### `Disposer` 是最简单也最重要的类型

```ts
export type Disposer = () => void
```

**一行。但它规定了整个框架的"撤销协议"。**

| 谁返回 `Disposer` | 撤销什么 |
|---|---|
| `provide()` | 移除一个服务 |
| `effect()` 登记的东西 | 由插件自定义 |
| `plugin()` | 卸载整个插件子树 |
| 第 4 步的 `ctx.on()` | 移除一个监听器 |

**统一成一个类型的好处**：

```ts
// 所有可撤销的东西放进同一个数组，用同样的方式处理
const disposers: Disposer[] = []
disposers.push(provider.provide('llm', x))
disposers.push(ctx.effect(...))
for (const d of disposers.reverse()) d()
```

**如果没有统一类型**，每种的撤销方式不同，卸载逻辑就要写一堆 `if`。

#### 注释里那句"必须幂等"是**契约**

```ts
/** 撤销函数：调用它，对应的注册就消失。必须幂等（重复调用无害）。 */
```

**这不是建议，是要求。** 因为框架可能从多条路径调用它：

```
插件主动卸载 → 调一次
父容器 dispose() → 又调一次
```

**如果实现者违反了这条契约**（比如撤销函数里做了累加计数），就会出问题。

**把契约写在类型注释里，是让它出现在每个使用者的编辑器提示里。**

#### `Plugin` 的 `apply` 返回值：`void | Promise<void>`

```ts
apply(ctx: Context): void | Promise<void>
```

**为什么允许两种？**

| 插件类型 | 写法 | 例子 |
|---|---|---|
| **同步** | `apply(ctx) { ctx.provide('x', 1) }` | 简单注册 |
| **异步** | `async apply(ctx) { await someInit() }` | 需要读文件/连数据库的插件 |

**调用方怎么处理？** 用 `await`：

```ts
await plugin.apply(child)     // 同步返回 undefined，await 也没问题
```

**`await` 对非 Promise 值是安全的**（直接返回它）。所以**统一用 `await`，不需要判断**。

#### `apply` 的参数注释里那句强调

```
@param ctx 这个插件的**专属子容器**；它在这里登记的一切都挂在这个子容器上
```

**为什么要强调"专属"？**

因为**这是插件的核心契约** —— 它决定了两件事：

1. 插件可以**放心地**往 `ctx` 上注册，不用担心污染别人
2. 插件**不应该**把 `ctx` 存起来之后在别处用（因为卸载后它就失效了）

**第二条是个隐患**，我们的 `#assertAlive()` 会挡住"卸载后注册"，但挡不住"卸载后读"。

**这一条要写进 L9。**

---

### 3.3 `DisposeErrorHandler` 与 `ServiceEntry`（第 48–56 行）

```ts
/** 卸载时的错误上报。单项失败不该阻断整体卸载，但也不能悄悄吞掉。 */
export type DisposeErrorHandler = (error: unknown, contextName: string) => void

/** 共享注册表里的一条服务记录。 */
interface ServiceEntry {
  /** 谁注册的。卸载那个容器时，这条记录会被精确移除。 */
  readonly owner: Context
  readonly value: unknown
}
```

#### `DisposeErrorHandler` 的两个参数

```ts
(error: unknown, contextName: string) => void
//      ▲ 第一个              ▲ 第二个
```

| 参数 | 类型 | 为什么 |
|---|---|---|
| `error` | `unknown` | **`catch` 捕获到的东西类型是 `unknown`**（TS 4.4+ 的默认） |
| `contextName` | `string` | **哪个容器的撤销失败了** —— 有了它才能定位 |

**为什么 `error` 是 `unknown` 而不是 `Error`？**

因为 JavaScript **允许抛出任何东西**：

```ts
throw new Error('正常')     // Error
throw '一个字符串'           // string
throw { code: 42 }          // 对象
```

**TS 强制你把 `catch` 参数当作 `unknown`**，这样你就不会写出 `error.message` 这种在字符串上会得到 `undefined` 的代码。

**处理方式**（第 1 步见过同样的模式）：

```ts
const reason = cause instanceof Error ? cause.message : String(cause)
```

#### `ServiceEntry` 是**私有接口**（没有 `export`）

```ts
interface ServiceEntry { ... }      // ← 注意没有 export
```

**为什么？** 因为它是**实现细节**：

- 外部不需要知道"服务是怎么存的"
- 如果导出，外部可能依赖它的结构 → 将来改存储方式就破坏了兼容性

**判断标准**：**外部真的需要构造或读取它吗？** 不需要 → 不导出。

#### `owner` 的类型是 `Context`（不是 `string`）

```ts
readonly owner: Context       // ← 不是 name
```

**为什么存对象而不是名字？**

因为撤销时要判断"这条记录是不是我的"：

```ts
if (current !== undefined && current.owner === this) {
```

**比较对象引用（`===`）比比较字符串名字更可靠** —— 两个插件可能同名（虽然我们不鼓励），但对象引用一定唯一。

**代价**：`ServiceEntry` 持有 `Context` 的引用，形成**循环引用**（Context 持有 registry，registry 里存着 Context）。

**循环引用在 JS 里不是问题**（垃圾回收器能处理），但如果将来要序列化这个结构（比如 `dump-config`），**必须先解引用**：

```ts
owner: entry.owner.name      // 序列化时转成名字
```

**这就是 `ownerOf()` 存在的原因之一。**

---

### 3.4 `Context` 类的七个字段（第 71–78 行）

```ts
export class Context {
  readonly name: string
  #parent: Context | undefined
  #registry: Map<string, ServiceEntry>
  #children: Context[] = []
  #effects: Disposer[] = []
  #disposed = false
  #onDisposeError: DisposeErrorHandler | undefined
```

#### 逐个字段

| 字段 | 类型 | 可变性 | 作用 |
|---|---|---|---|
| `name` | `string` | `readonly` + `public` | 报错和调试用 |
| `#parent` | `Context \| undefined` | 私有可写 | 指向上级（根容器为 undefined） |
| `#registry` | `Map<string, ServiceEntry>` | 私有可写 | **共享注册表**（关键） |
| `#children` | `Context[]` | 私有可写，**内联初始化** | 子容器列表 |
| `#effects` | `Disposer[]` | 私有可写，内联初始化 | 待撤销的动作 |
| `#disposed` | `boolean` | 私有可写，内联 `false` | 生命周期标志 |
| `#onDisposeError` | `DisposeErrorHandler \| undefined` | 私有可写 | 错误上报回调 |

#### `name` 为什么是 `readonly` 且**公开**

```ts
readonly name: string        // ← 没有 # 也没用 private
```

**它需要被外部读取**：

- 报错信息里要写 `[${this.name}]`
- `tree()` 要显示它
- `ownerOf()` 返回它

**但不需要被修改** —— 所以 `readonly`。

#### 三个字段的初始化方式不同，为什么

```ts
#children: Context[] = []                        // ← 内联初始化
#effects: Disposer[] = []                        // ← 内联初始化
#disposed = false                                // ← 内联初始化
#parent: Context | undefined                     // ← 构造函数里
#registry: Map<string, ServiceEntry>             // ← 构造函数里（因为依赖 parent）
#onDisposeError: DisposeErrorHandler | undefined // ← 构造函数里
```

| 分组 | 特征 | 例子 |
|---|---|---|
| **内联初始化** | 值不依赖构造参数 | 空数组、`false` |
| **构造函数里赋值** | 值依赖参数 | `parent`、`registry`、`onDisposeError` |

**`#disposed = false` 的写法值得注意**：

```ts
#disposed = false        // ← TS 能推断出类型是 boolean
```

**不需要写 `#disposed: boolean = false`** —— 因为给了初始值，**类型可以推断**。

**但注意**：在某些情况下 TS 推断的类型会**过窄**：

```ts
#x = null                // 推断成 null，后面赋 1 会报错
#y: number | null = null // 明确写出
```

**我们这里 `false` 不会有这个问题**（`boolean` 是它自然的推断）。

#### `#registry` 是关键字段（下一个节详讲）

**注意它的类型里带 `ServiceEntry`，并且是 `Map`** —— 这意味着：

- 有顺序（`Map` 保证插入顺序）
- 有 `.has()` / `.get()` / `.set()` / `.delete()` / `.keys()` / `.values()`

**为什么用 `Map` 而不是普通对象？**（第 2 步讲过同样的理由）

| 特性 | `Map` | 对象 |
|---|---|---|
| 键任意类型 | ✅ | ❌ 只能 string/symbol |
| 保证插入顺序 | ✅ 规范保证 | ⚠️ 大部分实现保证，非规范 |
| 原型污染 | ✅ 无 | ❌ `__proto__` 等键有风险 |
| 获取大小 | `.size` | `Object.keys().length` |

**`serviceNames()` 用 `[...this.#registry.keys()]`** —— 因为 `Map.keys()` 返回迭代器，数组化后才能返回给调用方（第 2 步讲过同样的坑）。

---

### 3.5 构造函数（第 80–91 行）★ 注册表共享在这里 ★

```ts
  /**
   * @param name 容器名，用于报错和排查
   * @param parent 父容器；不给就是根容器（它负责创建共享注册表）
   * @param onDisposeError 撤销失败时的上报函数；不给就继承父容器的
   */
  constructor(name: string, parent?: Context, onDisposeError?: DisposeErrorHandler) {
    this.name = name
    this.#parent = parent
    // 根容器新建注册表；子容器直接继承，所以要保证“同一张表”
    this.#registry = parent === undefined ? new Map() : parent.#registry
    this.#onDisposeError = onDisposeError ?? (parent === undefined ? undefined : parent.#onDisposeError)
  }
```

#### 参数与字段的对应

| 参数 | 属性 | 可选性 |
|---|---|---|
| `name: string` | `this.name` | 必填 |
| `parent?: Context` | `this.#parent` | 可选（不给 = 根容器） |
| `onDisposeError?: DisposeErrorHandler` | `this.#onDisposeError` | 可选（不给 = 继承） |

#### ★ 核心：`#registry` 的共享机制 ★

```ts
this.#registry = parent === undefined ? new Map() : parent.#registry
//                ──────────┬─────────          ───────┬───────
//             根容器：新建一张表              子容器：直接拿父容器那张表
```

**这一行是整个"共享命名空间"的实现。**

```
root（没有任何 parent）
  → 新建 Map A

plugin-config（parent = root）
  → 拿 root 的 Map A

plugin-greeter（parent = root）
  → 也拿 root 的 Map A          ← 同一个对象！

★ 所以 greeter 能查到 config 注册的服务 ★
```

**如果用 `new Map()` 而不是 `parent.#registry`**，就退回到那个会崩的错误设计了。

#### 一个 TS 细节：**在类内部可以访问别的实例的私有字段**

```ts
parent.#registry
//     ▲ 访问另一个 Context 实例的私有字段
```

**这在 TypeScript（和 JavaScript）里是合法的** —— **前提是"同一个类"**。

| 写法 | 合法？ |
|---|---|
| `this.#x` | ✅ |
| `otherContext.#x`（同类实例） | ✅ |
| `someObject.#x`（不同类型） | ❌ 语法错误 |

**这条规则经常被误以为不行**，但实际上**私有字段是"类级别私有"，不是"实例级别私有"**。

**它带来的便利**：不用为了共享注册表而加一个公开的 getter。

**它带来的风险**：如果将来 `Context` 被继承，子类也能访问父类的私有字段 —— **但继承的 Context 是另一个类，反而不行**。

**我们不做继承**，所以没有这个问题。

#### `#onDisposeError` 的继承链

```ts
this.#onDisposeError = onDisposeError ?? (parent === undefined ? undefined : parent.#onDisposeError)
```

**逐部分**：

```ts
onDisposeError                                    // ① 显式传入的优先
??                                                // ② 没有则
(parent === undefined ? undefined : parent.#onDisposeError)   // ③ 继承父容器的
```

**效果**：子容器不传 `onDisposeError` 时，**自动继承父容器的**。

```
root（传了 handler）
  ├── plugin-a（没传）→ 继承 root 的 handler
  └── plugin-b（传了自己的）→ 用自己的
```

**为什么需要这个继承？**

因为**错误上报应该由"根"统一处理**（比如写日志），插件不该关心它。但**也要允许局部覆盖**（测试时可以插一个收集器）。

**这个模式叫"配置继承 + 局部覆盖"**，在框架里很常见。

**注意三元表达式里那个 `parent === undefined ? undefined : ...`**：

**为什么不直接写 `parent?.#onDisposeError`？**

- `parent?.#onDisposeError` 语法**是合法的**
- 但可读性差（可选链 + 私有字段组合）

**我们选择显式三元** —— 因为这段代码要被人读懂，不是炫技。

---

### 3.6 四个只读视图（第 93–112 行）

```ts
  /** 父容器。根容器返回 undefined。 */
  get parent(): Context | undefined {
    return this.#parent
  }

  /** 这个容器是否已经卸载。 */
  get disposed(): boolean {
    return this.#disposed
  }

  /** 子容器列表。 */
  get children(): readonly Context[] {
    return this.#children
  }

  /** 容器树的形状，便于排查「哪个插件挂在哪」。 */
  tree(): string {
    if (this.#children.length === 0) return this.name
    return `${this.name}[${this.#children.map((child) => child.tree()).join(' ')}]`
  }
```

#### 三个 getter 的共同点

```ts
get parent(): Context | undefined { return this.#parent }
```

**getter 让你用属性语法访问私有字段**：

```ts
ctx.parent        // ← 像属性，实际是函数
ctx.parent()      // ❌ 会报错
```

**为什么用 getter 而不是公开字段？**

| 写法 | 外部可读 | 外部可写 | 内部可变 |
|---|---|---|---|
| `readonly parent` | ✅ | ❌ | ❌（构造后不能改） |
| `get parent()` | ✅ | ❌ | ✅（`#parent` 可写） |
| `parent`（公开） | ✅ | ✅ | ✅ |

**我们需要"外部只读、内部可变"**（比如 `#disposed` 在 `dispose()` 里会变），**getter 正好满足**。

#### `children` 返回 `readonly Context[]`

```ts
get children(): readonly Context[] {
  return this.#children
}
```

**注意它返回的是内部数组本身，不是副本**（对比第 2 步的 `list()` 返回 `[...]`）。

| | 第 2 步 `ToolRegistry.list()` | 第 3 步 `children` |
|---|---|---|
| 返回 | 副本 `[...]` | **原数组** |
| 理由 | 防止调用方修改影响内部 | `readonly` 已经挡住了 |

**`readonly Context[]` 的类型标注会挡住 `push`**：

```ts
ctx.children.push(x)      // ❌ 编译报错（readonly）
```

**但挡不住运行时绕过**：

```ts
(ctx.children as Context[]).push(x)    // 绕过了
```

**这是我们接受的** —— TS 的类型只在编译期，**同进程的调用信任类型**（这是 DSH 的明确规范）。

#### `tree()` 的递归实现

```ts
tree(): string {
  if (this.#children.length === 0) return this.name
  return `${this.name}[${this.#children.map((child) => child.tree()).join(' ')}]`
}
```

**输出格式**：

```
root1[plugin-config plugin-greeter]
```

**如果有嵌套**：

```
root[plugin-a plugin-b[agent#1 agent#2]]
```

**逐部分**：

| 片段 | 作用 |
|---|---|
| `if (length === 0) return this.name` | **递归基准**：叶子节点就是自己的名字 |
| `.map((child) => child.tree())` | **递归**：每个子容器算出自己的字符串 |
| `.join(' ')` | 用空格连起来 |
| `` `${this.name}[...]` `` | 包上自己的名字和方括号 |

**这个函数的用途是"调试"** —— 当你不确定"某个服务是谁挂上来的"，打印树形结构能立刻看出来。

**对应的生产系统做法**：DSH 的 `dsh --profile web --dump-config` 打印装载的插件树。

**这里第一次出现"递归"**（第 2 步的 `validateValue` 也是递归）。**理解递归的关键仍是"递归信任"**：不看每一层，只确认"这一层做对了、且递归调用是对的"。

---

### 3.7 `provide()`（第 116–144 行）★ 最核心的方法 ★

```ts
  /**
   * 注册一个服务。
   * @param name 服务名，**全树唯一**
   * @param value 服务实例
   * @returns 撤销函数（同时也登记进了副作用列表，卸载时会自动执行）
   * @throws 这个名字已经被注册过时（报错信息里会指出是被谁占的）
   */
  provide<T>(name: string, value: T): Disposer {
    this.#assertAlive()

    const existing = this.#registry.get(name)
    if (existing !== undefined) {
      throw new Error(
        `[${this.name}] 服务重复注册："${name}"（已被容器 "${existing.owner.name}" 注册）`,
      )
    }

    this.#registry.set(name, { owner: this, value })

    const remove = (): void => {
      // 只移除「还是自己的」那条 —— 万一后来被同名服务顶替过，不能误删别人的
      const current = this.#registry.get(name)
      if (current !== undefined && current.owner === this) {
        this.#registry.delete(name)
      }
    }
    this.#effects.push(remove)
    return remove
  }
```

#### 第 1 行：生命周期检查

```ts
this.#assertAlive()
```

**为什么第一步就检查？**

因为**卸载后注册会污染一个已死的容器**：

```
容器 A 卸载
   ↓
某个还没停的异步任务调 A.provide('x', ...)
   ↓
如果不检查：服务被注册进共享表，但没有任何人会撤销它
   ↓
★ 永久泄漏 ★
```

**`#assertAlive()` 让这种错误立刻暴露。**

#### 第 2–7 行：重复检查

```ts
const existing = this.#registry.get(name)
if (existing !== undefined) {
  throw new Error(
    `[${this.name}] 服务重复注册："${name}"（已被容器 "${existing.owner.name}" 注册）`,
  )
}
```

**注意错误信息的三个部分**：

| 片段 | 作用 |
|---|---|
| `[${this.name}]` | **谁想注册** |
| `"${name}"` | **想注册什么名字** |
| `（已被容器 "${existing.owner.name}" 注册）` | ★ **被谁占着** ★ |

**第三部分是最有价值的。** 对比：

```
// 只说"重复了"
服务重复注册："config"

// 说清"谁占的"
服务重复注册："config"（已被容器 "plugin-config" 注册）
```

**第二种让你直接去找 `plugin-config`，第一种你只能全局搜索。**

**这是"错误信息要包含行动线索"的原则。**

#### 第 9 行：写入共享表

```ts
this.#registry.set(name, { owner: this, value })
```

**这一行同时做了两件事**：

1. 注册服务（能被查到）
2. **记下归属**（`owner: this`）

**注意 `owner: this` 而不是 `owner: this.name`** —— 存对象引用（前面 3.3 节讲过理由）。

**这也是"服务归属规则"的落地处。**

#### 第 11–17 行：撤销函数

```ts
const remove = (): void => {
  // 只移除「还是自己的」那条 —— 万一后来被同名服务顶替过，不能误删别人的
  const current = this.#registry.get(name)
  if (current !== undefined && current.owner === this) {
    this.#registry.delete(name)
  }
}
```

**这三行有个关键判断：`current.owner === this`。**

**它在防什么？**

```
① 插件 A 注册了 'x'            → registry: { x: {owner: A} }
② 插件 A 被卸载，调 remove      → registry: { x: 被删 }
③ 插件 B 注册了 'x'            → registry: { x: {owner: B} }
④ ...但 A 的 remove 又被调了一次（比如另一条卸载路径）
   → 如果不检查 owner，就会把 B 的 'x' 删掉 ★
```

**这就是"幂等"要求的实现方式**：

- 第二次调用时，`current.owner` 是 `B`，不等于 `this`（A）→ **不删**

**注意这不是简单的"忘了就跳过"** —— 它是**"确认这条记录还是我的，才删"**。

**这个模式叫"带所有权检查的删除"**，在并发/多路径场景下非常重要。

**对应到 DSH**：它的 `provide` 返回的 disposer 也做同样的检查，因为插件热重载时会反复注册/撤销同一个服务名。

#### 第 18–19 行：登记 + 返回

```ts
this.#effects.push(remove)
return remove
```

**两件事都要做**（1.4 节讲过）：

| 动作 | 谁用 |
|---|---|
| `push` 进 effects | **框架**在卸载时自动调 |
| `return` | **插件**想主动撤销时用 |

**它们指向同一个函数对象**，所以不会有"两个不同的撤销逻辑"的问题。

#### 泛型 `<T>` 在这里的作用

```ts
provide<T>(name: string, value: T): Disposer
```

**`T` 由调用方推断**：

```ts
ctx.provide('config', { a: 1 })
// T 推断为 { a: number }

ctx.provide<string>('name', 'hello')
// 显式指定 T
```

**但注意 `Disposer` 的签名里没有 `T`** —— 因为撤销不需要知道值的类型。

**对比 `get<T>`**：

```ts
const cfg = ctx.get<{ a: number }>('config')    // T 必须显式给
```

**为什么 `get` 必须显式，而 `provide` 可以推断？**

| 方法 | 类型信息来源 |
|---|---|
| `provide` | **值就在参数里** → 能推断 |
| `get` | **只有名字** → 无从推断 |

**这类"一个给值、一个靠猜"的接口对，在服务定位器模式里很常见。**

**代价**：`get<T>` 的类型断言是**不可靠的**（你写了什么类型就是什么类型，运行时没有检查）。**这是服务定位器模式的固有代价**，写进 L9。

---

### 3.8 `get` / `require` / `has` / `serviceNames` / `ownerOf`（第 146–180 行）

```ts
  /** 查服务。找不到返回 undefined。 */
  get<T>(name: string): T | undefined {
    const entry = this.#registry.get(name)
    return entry === undefined ? undefined : (entry.value as T)
  }

  /**
   * 查服务，找不到就**抛错**。
   *
   * 为什么不返回 undefined 让调用方自己判？
   * 因为「缺少依赖」是必须在**装载时**就炸出来的错误。
   * 如果它变成 undefined 继续往下飘，你会在几百行之外看到一个莫名其妙的 TypeError。
   */
  require<T>(name: string): T {
    if (!this.has(name)) {
      const available = this.serviceNames().join(', ')
      throw new Error(`[${this.name}] 找不到服务 "${name}"；当前可用：${available === '' ? '(无)' : available}`)
    }
    return this.get<T>(name) as T
  }

  /** 这个服务名是否已注册。 */
  has(name: string): boolean {
    return this.#registry.has(name)
  }

  /** 当前已注册的全部服务名。 */
  serviceNames(): string[] {
    return [...this.#registry.keys()]
  }

  /** 这个服务是谁注册的。用于排查“这东西到底谁挂上来的”。 */
  ownerOf(name: string): string | undefined {
    return this.#registry.get(name)?.owner.name
  }
```

#### `get` 的那个三元表达式

```ts
return entry === undefined ? undefined : (entry.value as T)
```

**为什么不写 `return entry?.value as T`？**

两者等价，但**显式三元的类型更清楚**：

| 写法 | TS 推断的返回类型 |
|---|---|
| `entry?.value as T` | `T \| undefined`（靠 `?` 推断） |
| `entry === undefined ? undefined : (entry.value as T)` | 同上，但**显式** |

**我们选显式** —— 因为这里有个类型断言的坑需要注意（见下）。

#### `as T` 是不可靠的（必须记住）

```ts
const entry = this.#registry.get(name)     // ServiceEntry | undefined
return entry.value as T                     // ← 骗编译器
```

**`entry.value` 的类型是 `unknown`**（看 `ServiceEntry` 的定义）。

**`as T` 告诉编译器"它就是 T"** —— 但**运行时没有任何检查**。

```ts
ctx.provide('config', { a: 1 })
const bad = ctx.get<string>('config')       // ← 你写了 string
console.log(bad.length)                     // ← 运行时：undefined（对象没有 length）
```

**编译器全程不报错。**

**这是服务定位器模式的固有代价** —— 因为服务表是 `Map<string, unknown>`，类型信息在存进去的时候丢了。

**替代方案**（更安全但更繁琐）：用一个类型化的服务注册表：

```ts
interface Services {
  config: { a: number }
  llm: Provider
}
get<K extends keyof Services>(name: K): Services[K] | undefined
```

**那需要维护一张集中式的服务类型表。** DSH 用的是更接近后者的方式（每个服务有自己的 Service Definition 类型）。

**我们用宽松版**，代价写进 L9。

#### `require` 为什么先 `has` 再 `get`

```ts
require<T>(name: string): T {
  if (!this.has(name)) { throw ... }
  return this.get<T>(name) as T
}
```

**为什么不用 `const v = this.get(name); if (v === undefined) throw`？**

**因为服务值本身可能就是 `undefined`。**

```ts
ctx.provide('x', undefined)       // 合法的（虽然少见）

// 用 get 检查：
const v = ctx.get('x')
if (v === undefined) throw ...    // ← 误判：服务存在，只是值是 undefined

// 用 has 检查：
if (!ctx.has('x')) throw ...      // ✅ 正确：检查的是"注册没注册"
```

**这个区别叫"存在性 vs 值"** —— 用 `Map.has()` 检查存在性，用 `Map.get()` 取值。

**这是个经典陷阱**，在很多语言里都有对应（比如 Python 的 `dict.get(k, default)` vs `k in dict`）。

#### `require` 的错误信息里的"当前可用"

```ts
const available = this.serviceNames().join(', ')
throw new Error(`[${this.name}] 找不到服务 "${name}"；当前可用：${available === '' ? '(无)' : available}`)
```

**`available === '' ? '(无)' : available`** —— 和第 2 步的"未知工具"处理同样的空集合情况。

**为什么列全部服务名？**

因为**拼错名字是最常见的原因**：

```
找不到服务 "tool"
当前可用：config, tools, llm
                       ▲ 一眼看出应该是复数
```

**这比"找不到服务 tool"有价值得多。**

**但要小心它的误导性**（见 L1 末尾的"停下来想一想"）：

**如果服务名是对的，只是装载顺序不对**，那么"当前可用"列表里**不会**有它 —— 你会误以为"名字拼错了"，而真问题是"它还没被装载"。

**这是错误信息的固有局限：它只能告诉你"现在是什么状态"，不能告诉你"为什么是这个状态"。**

#### `ownerOf` 的 `?.` 链

```ts
ownerOf(name: string): string | undefined {
  return this.#registry.get(name)?.owner.name
}
```

**逐部分**：

| 片段 | 作用 |
|---|---|
| `this.#registry.get(name)` | `ServiceEntry \| undefined` |
| `?.` | 如果 undefined，整个表达式短路成 undefined |
| `.owner.name` | 否则取 owner 的名字 |

**注意返回类型是 `string | undefined`** —— 因为服务可能不存在。

**这个方法的存在意义**：**排查"这东西谁挂上来的"**。

**演示 1 用到它**：

```ts
show('每个服务是谁注册的', root1.serviceNames().map((name) => `${name} ← ${root1.ownerOf(name)}`))
```

**输出**：

```
[ "config ← plugin-config", "greeting ← plugin-greeter" ]
```

**这类"诊断辅助方法"看起来可有可无，但在系统复杂后价值极高。**

**DSH 的对应**：它的每个服务都能追溯到注册它的插件，而且 `--dump-config` 会显示整个装载树。

---

### 3.9 `effect()`（第 184–192 行）

```ts
  /**
   * 登记一个副作用。
   * 卸载时按登记的**逆序**执行 —— 后注册的东西可能依赖先注册的，所以要先拆后注册的。
   * @param disposer 撤销动作，必须幂等
   */
  effect(disposer: Disposer): void {
    this.#assertAlive()
    this.#effects.push(disposer)
  }
```

**四行，但它是"可撤销框架"的另一半。**

#### 与 `provide` 的关系

**`provide` 内部也调用了 `effect` 的逻辑**（但它是直接 `push`，没有走 `effect()`）：

```ts
// provide 里
this.#effects.push(remove)
```

**为什么不调 `this.effect(remove)`？**

因为 `effect()` 里有 `#assertAlive()` 检查，而 `provide()` 的开头**已经检查过了**。**重复检查虽然无害，但多一次函数调用。**

**这是"微小性能考虑"，不是架构原因。** 写成 `this.effect(remove)` 也完全可以。

#### `#assertAlive()` 在这里的作用

**如果容器已卸载，往里面登记副作用是危险的**：

```
容器卸载 → effects 已清空（`this.#effects = []`）
   ↓
某个迟到的异步任务调 effect(...)
   ↓
如果不检查：这个 disposer 被 push 进一个永远不会再被遍历的数组
   ↓
★ 那个副作用永远不会被撤销 ★
```

**这就是"泄漏"的一种形态**，而 `#assertAlive()` 把它变成"立刻可见的错误"。

#### 注释里的"逆序"说明

```
卸载时按登记的**逆序**执行 —— 后注册的东西可能依赖先注册的，所以要先拆后注册的。
```

**注意它写清了"为什么"**，而不只是"是什么"。

**对比**：

| 注释 | 效果 |
|---|---|
| "卸载时逆序执行" | 读者知道要逆序，但不知道为什么 → 可能改成正序 |
| **"后注册的东西可能依赖先注册的，所以要先拆后注册的"** | 读者知道改成正序会破坏什么 |

**这就是"注释要写理由"的价值。**

---

### 3.10 `plugin()`（第 196–226 行）★ 第二核心 ★

```ts
  /**
   * 装载一个插件。
   *
   * 插件拿到的不是 this，而是一个**新建的子容器**。这样它注册的服务有了明确的归属，
   * 卸载它时只回滚它自己的东西，不会误伤别的插件。
   * @param plugin 要装载的插件
   * @returns 卸载函数（幂等：重复调用只生效一次）
   * @throws 插件装载过程中抛出的错误（此时已经注册的部分会被回滚干净）
   */
  async plugin(plugin: Plugin): Promise<Disposer> {
    this.#assertAlive()
    const child = new Context(plugin.name, this)
    this.#children.push(child)

    try {
      await plugin.apply(child)
    } catch (error) {
      // 装载到一半失败：必须把已注册的部分撤干净，否则会留下「半个插件」——
      // 它占着服务名，让下一次重试直接报「重复注册」，非常难查。
      child.dispose()
      throw error
    }

    let unloaded = false
    return (): void => {
      if (unloaded) return
      unloaded = true
      this.#children = this.#children.filter((candidate) => candidate !== child)
      child.dispose()
    }
  }
```

#### 五段结构

```
① 生命周期检查            this.#assertAlive()
② 创建子容器并挂到树上      new Context(plugin.name, this) + push 到 children
③ 执行装载（含失败回滚）    try { apply } catch { dispose; throw }
④ 制造幂等卸载函数          let unloaded = false; return () => {...}
⑤ 卸载时：摘出树 + 卸载自己  filter + dispose
```

#### ① 为什么先检查

**和 `provide`/`effect` 同样的理由**：已卸载的容器不能再装载插件。

**但多一层意义**：装载插件会创建子容器。**如果父容器已死，子容器会成为孤儿**（没有任何路径能撤销它）。

#### ② `new Context(plugin.name, this)`

**注意传的是 `this`（当前容器）作为 parent。**

**效果**：

```
root.plugin(A)  →  childA（parent = root）
    ↓ A 里面又装载 B
childA.plugin(B) → childB（parent = childA）
```

**形成嵌套结构** —— 这也是为什么 `tree()` 能打印出层次。

**`this.#children.push(child)` 紧跟着创建** —— 保证"创建即入树"，**没有中间状态**。

**如果先 apply 再 push 会怎样？** 装载过程中如果发生错误，子容器还没入树，但 `child.dispose()` 仍然能清干净 —— **两种顺序都能工作**，但"先入树"更符合直觉。

#### ③ 失败回滚（1.7 节讲过，这里补一个细节）

```ts
} catch (error) {
  child.dispose()
  throw error
}
```

**注意 `throw error` 是原样重抛，没有包装。**

**为什么？**

| 做法 | 后果 |
|---|---|
| `throw new Error('插件装载失败：' + error.message)` | 丢失原始堆栈，丢失原始类型 |
| **`throw error`（原样）** | 保留一切，调用方能按原类型处理 |

**这一条在 DSH 的规范里有对应**：

> 「`throw` after disposing startup resources; **cleanup failures retain the original error**」

**翻译**：清理时如果又出错，**原始错误不能被覆盖**。

**我们的实现里，`child.dispose()` 本身不会抛**（它内部 catch 了所有撤销错误），所以不存在这个问题。**但如果将来 `dispose` 会抛，就要用 `AggregateError` 把两个错误都保住。**

#### ④ 幂等卸载函数

```ts
let unloaded = false
return (): void => {
  if (unloaded) return
  unloaded = true
  this.#children = this.#children.filter((candidate) => candidate !== child)
  child.dispose()
}
```

**注意 `this.#children = ...` 是重新赋值，不是原地修改。**

| 写法 | 效果 |
|---|---|
| `this.#children = this.#children.filter(...)` | ✅ 换成新数组（我们的写法） |
| `this.#children.splice(index, 1)` | 原地修改 |

**为什么用 `filter` 返回新数组？**

- **不可变更安全**：如果有代码持有旧数组的引用，它不会被中途改变
- **一行表达意图**：`filter` 直接说明"排除这一个"

**`filter((candidate) => candidate !== child)`** —— 用**对象引用比较**（不是名字），所以同名的两个插件互不影响。

#### ⑤ 关于 `#children` 的类型

```ts
#children: Context[] = []
```

**它不是 `readonly`**（要能重新赋值），但**对外通过 getter 只读**。

**注意 `children` getter 返回的是 `readonly Context[]`，而内部是 `Context[]`** —— TypeScript 允许把 `T[]` 赋给 `readonly T[]`（安全的协变）。

#### 这个方法的完整生命周期图

```
ctx.plugin(P)
   │
   ├─ 创建 child = new Context(P.name, ctx)
   ├─ ctx.#children.push(child)
   ├─ await P.apply(child)
   │     ├─ 成功 → 继续
   │     └─ 失败 → child.dispose()（回滚）→ 抛出
   │
   └─ 返回 unload 函数
         │
         └─ 调用 unload()
              ├─ 从 ctx.#children 摘除 child
              └─ child.dispose()（逆序执行 child 的全部 effects）
```

**注意：卸载是"整棵子树"的** —— `child.dispose()` 会撤销 child 注册的一切。**但 child 自己的子容器呢？**

**这是个问题** —— `child.dispose()` **不会递归卸载 child 的子容器**！

**如果一个插件在 `apply` 里装载了子插件，卸载父插件时子插件不会被卸载。**

**这是当前实现的一个真实缺陷**，写进 L9。

---

### 3.11 `dispose()`（第 230–245 行）

```ts
  /** 卸载：逆序执行全部副作用（包括移除自己注册的服务），然后禁止再注册。幂等。 */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true

    for (const disposer of [...this.#effects].reverse()) {
      try {
        disposer()
      } catch (error) {
        // 一个坏插件的撤销失败，不该让整个卸载流程卡死
        this.#onDisposeError?.(error, this.name)
      }
    }

    this.#effects = []
  }
```

#### 第 1–2 行：幂等保护

```ts
if (this.#disposed) return
this.#disposed = true
```

**`#disposed = true` 放在最前面**（在遍历 effects 之前）。

**为什么？**

因为**遍历过程中如果又有代码调 `dispose()`**，第二次会立刻返回 —— **避免递归/重入**。

**如果放在最后会怎样？**

```
dispose() 开始
  → 遍历 effects
  → 某个 disposer 内部又调了 this.dispose()
      → #disposed 还是 false → 再次遍历 effects
          → 无限递归 ★
```

**"先把状态改掉，再做事"是防重入的标准手法。**

#### 第 4–10 行：逆序 + 容错

```ts
for (const disposer of [...this.#effects].reverse()) {
  try {
    disposer()
  } catch (error) {
    this.#onDisposeError?.(error, this.name)
  }
}
```

**三个细节**：

| 细节 | 理由 |
|---|---|
| `[...this.#effects]` | `reverse()` 原地改，复制一份 |
| `.reverse()` | 逆序（1.5 节） |
| `try/catch` 包住单次调用 | 一个失败不阻断其余 |

**注意 `catch` 里的 `this.#onDisposeError?.(error, this.name)` 用了 `?.`** —— 因为 handler 可能是 `undefined`（没传也没得继承）。

**如果 `onDisposeError` 为 undefined，这个错误就被静默丢弃了。** 这是**有意的**：

- 框架层不该强制要求一个错误处理器
- 但提供了接口让使用方接管

**代价**：默认情况下撤销失败无声无息。**这是一个要在 L9 里指出的问题** —— 至少在开发模式下应该有默认的 console.error。

#### 第 12 行：清空 effects

```ts
this.#effects = []
```

**为什么要清空？**

| 理由 | 说明 |
|---|---|
| **释放引用** | 数组里的 disposer 可能闭包着大对象，清空后能被 GC 回收 |
| **防止重复执行** | 虽然 `#disposed` 已经挡住了，但清空是"双保险" |
| **让状态可观察** | 卸载后 `#effects.length === 0`，调试时更清楚 |

**注意它没有清空 `#registry`** —— 因为注册表是**共享的**，每个容器只清理自己注册的那几条（通过各自的 `remove` disposer）。

**如果在这里 `this.#registry.clear()` 会怎样？**

```
★ 卸载一个插件会清空全树的注册表 ★
   → 其他所有插件的服务全部消失
```

**这是一个危险的错误**，而它之所以不会发生，是因为**设计上已经通过 owner 归属精确移除了**。

**代码里没有 `clear()` 这件事本身，就是设计的体现。**

#### 四个状态迁移图

```
创建 ──► 活跃 ──►（dispose）──► 已卸载
         │                        │
         │ provide/effect/plugin  │ 全部抛错
         │ 都合法                  │（#assertAlive）
         └────────────────────────┘
```

**`#disposed` 是单向的** —— 没有"重新激活"。**要重新激活就新建一个容器**（这也是为什么 `plugin()` 每次创建新的 child，而不是复用）。

---

### 3.12 `#assertAlive()`（第 247–251 行）

```ts
  #assertAlive(): void {
    if (this.#disposed) {
      throw new Error(`[${this.name}] 容器已卸载，不能再注册`)
    }
  }
```

#### 私有方法（`#` 前缀）

```ts
#assertAlive(): void {
```

**为什么私有？** 因为它是内部不变式检查，**外部不需要调用它**（外部只能通过注册方法间接触发）。

#### 为什么叫 `assert`（断言）而不是 `check`（检查）

| 名字 | 语义 |
|---|---|
| `check` | "检查一下，不满足就做点什么" |
| **`assert`** | **"我断言这里一定成立，不成立就是 bug"** |

**断言失败 = 编程错误**，不是"运行时情况"。

**命名传达了"这是不该发生的事"** —— 帮助读者理解它的性质。

#### 三个调用点

```ts
provide()  → this.#assertAlive()
effect()   → this.#assertAlive()
plugin()   → this.#assertAlive()
```

**注意 `get` / `has` / `serviceNames` 等查询方法没有它。**

**为什么？**

| 操作 | 需要检查吗 | 理由 |
|---|---|---|
| 注册（`provide`/`effect`/`plugin`） | ✅ 需要 | 会产生**永久残留** |
| 查询（`get`/`has`） | ❌ 不需要 | **只读，无副作用** |

**卸载后读一个服务**是安全的（虽然可能返回 `undefined`）—— **强行报错反而会让清理代码难以编写**。

**这是"只对危险操作设防"的原则。**

**但注意**：如果卸载后 `get` 到一个已被撤销的服务，返回 `undefined` 而不是报错，**调用方可能误以为"服务不存在"而不是"容器已死"**。

**这又是一个"错误信息的局限"**（和 3.8 节末尾讲的同一类问题）。**写进 L9。**

---

### 3.13 全文件回顾：251 行分成了什么

| 行范围 | 内容 | 行数 |
|---|---|---|
| 1–32 | 文件头注释（含决策记录） | 32 |
| 34–56 | 四个类型定义 | 23 |
| 58–70 | `Context` 类的文档注释 | 13 |
| 71–78 | 七个字段声明 | 8 |
| 80–91 | 构造函数（★ 注册表共享） | 12 |
| 93–112 | 四个只读视图 | 20 |
| 114–180 | 六个服务方法（★ `provide`） | 67 |
| 182–192 | `effect()` | 11 |
| 194–226 | `plugin()`（★ 核心） | 33 |
| 228–245 | `dispose()` | 18 |
| 247–251 | `#assertAlive()` | 5 |

**注释和文档占了 45 行（18%）** —— 这个比例在框架代码里是正常的，甚至偏低。

**DSH 的框架文件注释比例更高**，因为每个公开 API 都要写清契约。

---

## L4 运行与验证

### 4.1 怎么运行

```powershell
cd D:\agent-harness-lab
node src/demos/demo-context.ts
```

### 4.2 六组演示逐条解读

#### 演示 1 · 注册与跨插件查找

```
--- root1 上能看见的服务 ---
[ "config", "greeting" ]

--- 每个服务是谁注册的 ---
[ "config ← plugin-config", "greeting ← plugin-greeter" ]

--- 容器树的形状 ---
root1[plugin-config plugin-greeter]

--- greeting 的内容 ---
你好，工作目录是 D:/agent-harness-lab，模型是 deepseek-chat
```

**四个观察点**：

| 观察 | 说明了什么 |
|---|---|
| **两个服务都可见** | 共享命名空间生效（**这正是修正前会崩的地方**） |
| `ownerOf` 指出各自归属 | 服务记录带 owner |
| `tree()` 显示扁平树 | 两个插件都是 root1 的直接子容器 |
| `greeting` 的内容里含 config 的值 | **greeter 读到了 config 插件提供的服务**（跨插件协作成功） |

**最后一条是整个演示的重点。**

#### 演示 2 · fail loud

```
--- require 抛出的错误 ---
[root1] 找不到服务 "nonexistent"；当前可用：config, greeting

--- 用 get 查（自己判空，不抛错） ---
undefined
```

**要观察的**：

1. `require` 的错误信息里有 **`[root1]`（哪个容器）** 和 **"当前可用"列表**
2. `get` 静默返回 `undefined`

**两者语义的区别就是 1.6 节讲的"声明式 vs 探测式"。**

#### 演示 3 · 卸载的正确定界

```
--- 卸载前可见服务 ---  [ "config", "greeting" ]
--- 卸载后可见服务 ---  [ "config" ]
--- config 还在吗（它属于另一个插件） ---  true
```

**这一组验证了"归属记账"的核心价值**：

- `greeter` 卸载 → `greeting` 消失 ✓
- `config` **不受影响**（属于另一个插件）✓

**如果归属记错了**（比如卸载时清空整张表），第二行会变成 `[]`，第三行会变成 `false`。

#### 演示 4 · 逆序撤销

```
--- 撤销顺序（注意是倒过来的） ---
[ "③ 被撤销", "② 被撤销", "① 被撤销" ]
```

**要观察的**：注册顺序是 ①②③，撤销顺序是 ③②①。

**怎么造出这个演示的**：

```ts
ctx.effect(() => { order.push('① 被撤销') })
ctx.effect(() => { order.push('② 被撤销') })
ctx.effect(() => { order.push('③ 被撤销') })
```

**三个 effect 都往同一个数组里 push** —— 于是数组的顺序就是执行顺序。

**这是个很好用的测试技巧**：**用一个数组记录"事情发生的顺序"。**

#### 演示 5 · 装载失败回滚

```
--- 装载失败的报错 ---
插件装载到一半，突然失败

--- half-broken 留下的服务（应该是空的） ---
[]
```

**要观察的**：`half-broken` 插件先 `provide('good-service', ...)` 再抛错，**最后 `serviceNames()` 是空的**。

**这验证了 `child.dispose()` 那一行。**

**如果把它删掉**，输出会变成：

```
--- half-broken 留下的服务 ---
[ "good-service" ]    ← 泄漏
```

#### 演示 6 · 服务名冲突

```
--- config 是谁注册的 ---
plugin-config

--- 后来的插件被拒绝 ---
[plugin-rival] 服务重复注册："config"（已被容器 "plugin-config" 注册）

--- config 还是原来那个吗 ---
{ "workspace": "D:/agent-harness-lab", "model": "deepseek-chat" }
```

**要观察的三件事**：

1. **报错指出了占用者**（`已被容器 "plugin-config" 注册`）
2. `plugin-rival` 装载失败，**但没有污染系统**
3. 原来的 `config` 完好无损

**第 2 条是"装载失败回滚"的第二次验证**（演示 5 是第一次）。

### 4.3 验收判据

| # | 判据 | 验证 |
|---|---|---|
| 1 | 六组演示全部符合上述输出 | 运行 |
| 2 | 演示 3 里 `config` 卸载后仍在 | 看输出 |
| 3 | 演示 4 的撤销顺序是倒的 | 看输出 |
| 4 | 演示 5 的 `serviceNames()` 为空 | 看输出 |
| 5 | 演示 6 的报错**指出了占用者** | 看输出 |
| 6 | 你能说出"服务注册在哪个容器"及其理由 | 口述 |
| 7 | 你能说出"为什么卸载要逆序" | 口述 |
| 8 | 你能说出"装载失败为什么必须回滚" | 口述 |
| 9 | **关掉文档**能写出 `provide` 和 `plugin` 的骨架 | 见 L6 |

---

## L5 语法速查（本篇新增）

> 第 1、2 步的语法分别在 [`01-llm.md`](01-llm.md#l5-本篇-typescript-语法速查) 和 [`02-tools.md`](02-tools.md#l5-语法速查本篇新增) 里。

| 语法 | 例子 | 含义 | 注意 |
|---|---|---|---|
| **真私有字段** | `#parent: Context \| undefined` | JS 原生私有 | **擦除后依然私有** |
| **私有字段跨实例访问** | `parent.#registry` | 同类实例间可访问 | 不同类型不行 |
| `get` 访问器 | `get parent(): Context \| undefined` | 属性语法调用函数 | 外部只读、内部可写 |
| **类字段内联初始化** | `#disposed = false` | 声明时给初值 | 类型可推断 |
| 泛型方法 | `provide<T>(name, value: T)` | 类型参数 | 从参数推断 |
| **泛型显式指定** | `ctx.get<{ a: number }>('config')` | 手动给 T | get 无法推断 |
| `void \| Promise<void>` | `apply(...): void \| Promise<void>` | 两种返回 | `await` 都能处理 |
| `readonly T[]` 返回值 | `get children(): readonly Context[]` | 挡 push | 运行时挡不住 |
| `Map` 的 keys/values | `[...this.#registry.keys()]` | 迭代器转数组 | **必须转** |
| `?.` 深链 | `this.#registry.get(name)?.owner.name` | 安全取嵌套 | 任何一环空则整体空 |
| `?.` 调用 | `this.#onDisposeError?.(...)` | 存在才调用 | **注意不是 `?.()` 而是 `?.(...)`** |
| 数组 `filter` 重赋值 | `this.#x = this.#x.filter(...)` | 生成新数组 | 不是原地改 |
| `reverse()` | `[...arr].reverse()` | **原地反转** | 必须先复制 |
| `AggregateError` | 多错误打包（本步未用） | ES2021 | 第 10 步会用到 |
| 类型断言 `as T` | `entry.value as T` | 骗编译器 | **运行时无检查** |

### 本篇新增的四条规则

**规则 10：私有字段是"类级私有"，不是"实例级私有"**

```ts
class A {
  #x = 1
  peek(other: A) { return other.#x }    // ✅ 合法！同类实例可互访
}
```

**好处**：不用为共享内部状态开公开 getter。**我们用它实现注册表共享。**

**规则 11：`array.reverse()` 会修改原数组**

```ts
const a = [1, 2, 3]
const b = a.reverse()
// ★ a 也变成了 [3, 2, 1] ★
```

**安全写法**：`[...a].reverse()` 或 `a.toReversed()`（ES2023）。

**规则 12：`get` 访问器对外看起来是属性**

```ts
class C { get x() { return 1 } }
const c = new C()
c.x        // 1
c.x()      // ❌ TypeError: c.x is not a function
```

**规则 13：可选链调用要写 `?.(...)` 而不是 `?.()`**

```ts
this.#handler?.(error)      // ✅ 存在就调用，参数是 error
this.#handler?.()           // 也是合法语法，只是没传参
```

**这两个看起来像同一个东西，但第二个是"无参调用"。**

---

## L6 关文档重写判据

### 必须能写出的部分

| 难度 | 要写的东西 | 通过标准 |
|---|---|---|
| ★ | `Disposer` 和 `Plugin` 类型 | `apply` 的返回类型要写对 |
| ★ | `Context` 的七个字段 | **`#registry` 的类型是 `Map<string, ServiceEntry>`** |
| ★★ | `ServiceEntry` | **必须有 `owner: Context`** |
| ★★ | 构造函数 | **`parent.#registry` 那一行**（★ 最关键） |
| ★★ | `get` / `has` / `require` | `require` 先 `has` 再 `get` |
| ★★★ | `provide` | **重复检查 + owner 记账 + 撤销时检查 owner** |
| ★★★ | `dispose` | **幂等 + 逆序 + 单项容错** |
| ★★★★ | `plugin` | **子容器 + 失败回滚 + 幂等卸载** |

### 卡住时的自检问题

| 卡在哪 | 问自己 |
|---|---|
| 构造函数 | "子容器怎么才能查到兄弟注册的服务？" |
| `provide` 的撤销函数 | "同名的服务被别人重新注册了，我的撤销该不该删它？" |
| `dispose` 的顺序 | "如果一个服务的构造依赖另一个服务，该怎么拆？" |
| `plugin` 的错误处理 | "装载到一半失败，已注册的东西留着会怎样？" |
| `require` 的实现 | "如果服务值本身就是 undefined，用 `get` 检查会怎样？" |

### 分级判定

| 程度 | 判定 |
|---|---|
| 能写出 ★★ 及以下 | 不够 L3，重读 3.4–3.8 |
| 能写出 ★★★ | 接近 L3，重点补 `plugin` |
| 全部写出（**构造函数那行必须是 `parent.#registry`**） | ✅ **达标** |

**特别提示**：如果重写时你在构造函数里写了 `new Map()`，说明你**没有理解连锁影响 1**。回去重读 1.2 节。

---

## L7 挑战题（不给答案）

### 挑战 1 · 让 `dispose()` 递归卸载子容器

**当前缺陷**（见 L9 第 1 条）：`child.dispose()` **不会**卸载 child 的子容器。

**要求**：

1. 修改 `dispose()` 让它先递归卸载所有子容器，再执行自己的 effects
2. **思考顺序**：是"先卸载子容器再撤销自己的"，还是反过来？为什么？
3. 演示：一个插件在 `apply` 里装载了子插件，卸载父插件时子插件的服务也消失

**这道题有一个陷阱**：`plugin()` 返回的卸载函数会从 `#children` 里摘除自己。如果 `dispose()` 遍历 `#children` 时子容器又被摘除，会怎样？

### 挑战 2 · 加一个"服务变更通知"

现在 `provide` 只写注册表，**没有任何人能"知道"服务出现了**。

**要求**：

1. 给 `Context` 加一个 `onProvide(listener)` 和 `onDispose(listener)`
2. 用一个数组记录监听器，`provide`/`remove` 时触发
3. 演示"服务出现时打印一行日志"

**思考**：这个能力**正是第 4 步"依赖注入"的基础** —— 声明 `inject: ['llm']` 的插件，怎么知道 `llm` 什么时候出现？

**做完这题你就提前实现了第 4 步的一半。**

### 挑战 3 · 区分"服务不存在"和"容器已死"

**当前缺陷**（见 L9 第 4 条）：卸载后 `get` 返回 `undefined`，与"服务不存在"无法区分。

**问题**：

1. 改成卸载后 `get` 抛错，会破坏什么？（提示：想想清理代码）
2. 有没有第三种方案？（提示：返回一个"三态"结果，或者提供 `isAlive` 查询）
3. **这个决策会影响第 7 步的清理路径吗？**

### 挑战 4 · 让 `require` 的错误信息更聪明

现在的信息是：

```
[root1] 找不到服务 "llm"；当前可用：config, tools
```

**问题**：

1. 如果 `llm` 其实**已经被注册过又被卸载了**，能提示出来吗？
2. 如果 `llm` 是**被某个还没装载的插件提供的**（第 4 步的场景），能提示出来吗？
3. 要实现 2，需要什么额外信息？（提示：插件可以声明"我将提供什么"）

**这道题直接导向第 4 步的 `inject` 设计。**

### 挑战 5 · 给服务增加"生命周期钩子"

**问题**：如果一个服务需要在**被使用之前**做初始化（比如连数据库），现在怎么办？

**三种方案**：

| 方案 | 做法 |
|---|---|
| A | `provide` 之前自己 await 初始化 |
| B | 服务对象带 `start()` 方法，框架在装载后统一调用 |
| C | 懒初始化（第一次 `get` 时初始化） |

**分析三种方案的代价**，并说明你选哪个。

（DSH 的做法接近 B —— 它有服务的 `start`/`stop` 生命周期。）

---

## L8 自检清单

### 理解层（L1）

- [ ] 我能说出"服务/副作用/插件"三个概念的关系
- [ ] ★ **我能复述服务归属规则以及它为什么不能改成"私有容器"**
- [ ] 我能说出 "半个插件" 的两种危害
- [ ] 我能解释为什么卸载必须逆序
- [ ] 我能解释 `Disposer` 为什么要"既登记又返回"
- [ ] 我能解释 `require` 和 `get` 的区别与适用场景
- [ ] 我能解释 `#assertAlive()` 为什么只在"写操作"里调
- [ ] 我能说出"默认无隔离"这个代价会在第几步被解决

### 实现层（L3）

- [ ] 我关掉文档写出了 `provide`（含 owner 记账和撤销时的检查）
- [ ] 我关掉文档写出了 `plugin`（含失败回滚）
- [ ] 我关掉文档写出了构造函数（**注册表共享那行写对了**）
- [ ] 我关掉文档写出了 `dispose`（幂等 + 逆序 + 容错）
- [ ] 我能解释为什么撤销函数里要判断 `current.owner === this`

### 语法层

- [ ] 我知道私有字段可以跨实例访问（同类）
- [ ] 我知道 `reverse()` 会改原数组
- [ ] 我会用 `?.(...)` 做可选调用
- [ ] 我知道 `get` 访问器不能用 `()` 调用

### 系统层（L4）

- [ ] 我能说出改 `provide` 的语义会影响哪几步
- [ ] 我能说出第 5 步加隔离时，`get` 要怎么改（**叠加而不是改写**）
- [ ] 我能说出 `dispose` 不递归卸载子容器会导致什么

---

## L9 仍未解决

### 会被后续步骤解决的

| 遗留问题 | 哪一步 |
|---|---|
| 插件不能"声明依赖、等依赖就绪" | 第 4 步（`inject`） |
| 插件不能"观察/拦截"彼此 | 第 4 步（事件） |
| 没有隔离：全局唯一命名空间 | 第 5 步（scope） |
| 插件靠代码手工 `plugin()` 装载 | 第 6 步（配置装载） |
| 插件没有配置 | 第 6 步（profile/bundle） |
| 没有日志：装载/卸载不可观测 | 第 4 步顺带 |

### 当前实现的真实缺陷

#### 缺陷 1 · `dispose()` 不递归卸载子容器 ★ 最严重 ★

```ts
dispose(): void {
  // ...
  for (const disposer of [...this.#effects].reverse()) { ... }
  this.#effects = []
}
```

**问题**：`#children` 里的子容器**完全没被处理**。

**后果**：

```
插件 A 在 apply 里装载了插件 B
   ↓
卸载 A（调 A 的 unload）
   ↓
A 的 child.dispose() 执行
   ↓
★ 但 B 的子容器还在 root 的树里，B 的服务全部残留 ★
```

**这会导致服务泄漏**，而且**树结构会显示一个已经不存在的插件**。

**为什么这么写**：`plugin()` 的卸载函数**手动**从 `#children` 摘除了 child，所以"正常路径"下没有残留。**但只要有一处没走那个卸载函数，就会泄漏。**

**修法**：见挑战题 1。

**这是"依赖调用方做对事"的设计缺陷** —— 框架应该保证正确性，而不是要求调用方记得。

#### 缺陷 2 · `#onDisposeError` 默认为 undefined → 撤销失败静默丢弃

```ts
this.#onDisposeError?.(error, this.name)
```

**问题**：如果没人提供 handler，**撤销失败完全没有痕迹**。

**后果**：一个坏插件的撤销异常被吞掉，你以为卸载干净了。

**修法**：给一个默认的 handler（至少 `console.error`）。

**为什么这么写**：框架层不想强制依赖 console。

**但这不符合 DSH 规范里的"空 catch 必须命名错误"精神** —— 我们**上报了**错误，但**默认没人接**。

#### 缺陷 3 · `get<T>` 的类型断言不可靠

```ts
get<T>(name: string): T | undefined {
  const entry = this.#registry.get(name)
  return entry === undefined ? undefined : (entry.value as T)
}
```

**问题**：`as T` **运行时没有任何检查**。

```ts
ctx.provide('config', { a: 1 })
const bad = ctx.get<string>('config')    // 编译通过
bad.length                                // 运行时 undefined
```

**这是服务定位器模式的固有代价**（因为服务表是 `Map<string, unknown>`）。

**DSH 的做法**：每个服务有独立的 Service Definition 类型，服务访问是 `ctx.llm` 这样的**具名属性**而不是字符串查表。

**修法**（如果要改进）：用类型化的服务映射表（见 3.8 节的替代方案）。

**为什么不改**：教学项目，服务数量少，且字符串查表更直观地展示了"服务定位器"的原理。

#### 缺陷 4 · 卸载后 `get` 返回 `undefined`，与"服务不存在"无法区分

```ts
ctx.dispose()
ctx.get('llm')       // → undefined，和"从没注册过"一样
```

**后果**：清理代码里可能误判"服务不存在"，而真原因是"容器已死"。

**修法**：加一个 `isAlive` 查询，或者让 `get` 在已卸载时抛错。

**为什么没做**：卸载后读服务是**清理路径上的常见操作**，抛错会让清理代码难写。

**这是个真实的权衡**，不是疏忽 —— 但代价要记下来。

#### 缺陷 5 · `children` 的 getter 返回内部数组（不是副本）

```ts
get children(): readonly Context[] {
  return this.#children        // ← 原数组
}
```

**问题**：`readonly` 只在编译期有效，运行时可以绕过。

```ts
(ctx.children as Context[]).push(fakeChild)     // 污染了内部状态
```

**对比第 2 步的 `ToolRegistry.list()`** 返回的是副本。

**不一致的原因**：第 2 步那个是"数据快照"（每次调用都可以不同），这里是"结构视图"（应该反映实时状态）。

**两种都有道理，但项目内不一致本身就是个问题** —— 读者要记住哪个返回副本哪个不返回。

**修法**：统一 —— 要么都返回副本，要么都标注说明。

#### 缺陷 6 · `tree()` 不显示"已卸载但未摘除"的容器

**相关于缺陷 1**：如果某个子容器没被正确摘除，`tree()` 会**照常显示它**。

**后果**：调试工具会给出**误导性的信息** —— 显示树上有某个插件，但它其实已经死了。

**修法**：`tree()` 里跳过 `disposed` 的容器，或者把它们标出来（比如 `plugin-a(dead)`）。

**这是个好的例子**：**调试工具本身也可能有 bug，而且它的 bug 会让你更困惑。**

---

## L10 提问训练

### 本篇引出的 12 个好问题

**关于设计（L3 层）**

1. 为什么服务记录要存 `owner: Context` 而不是 `owner: string`（名字）？
2. 为什么 `provide` 的撤销函数里要检查 `current.owner === this`？
3. 为什么 `require` 用 `has()` 而不是 `get() === undefined` 来检查存在性？
4. 为什么 `#disposed = true` 要放在遍历 effects **之前**？
5. 为什么 `plugin()` 每次创建新的子容器，而不是复用？

**关于系统（L4 层）**

6. 第 5 步加隔离时，`get` 要怎么改才能**不改动现有行为**？
7. 第 4 步的 `inject`（依赖注入）需要 `provide` 提供什么额外能力？
8. 如果第 6 步的装载器要"按配置卸载一个插件"，用现在哪个 API？
9. 卸载一个插件时，如果有**别的插件持有它的服务引用**，会发生什么？

**关于科研（L5 层）**

10. 这个容器模型能否用来做"**不同 harness 配置的 A/B 实验**"？怎么隔离两个实验组？
11. `ownerOf` / `tree()` 这类诊断能力，对**失败归因**（第 15 步）有什么价值？
12. **如果把"插件装载/卸载"当成事件记录下来，能得到什么科研数据？**（提示：装载失败的次数、哪些插件的生命周期最短）

### 问题升级练习

| 模糊问题 | 精确问题 | 提升在哪 |
|---|---|---|
| "为什么服务是全局的？" | "如果服务改为插件私有，一个插件如何访问另一个插件的服务？那条查找路径会经过哪些容器？" | 要求**具体化查找路径** |
| "为什么要回滚？" | "如果装载失败不回滚，下一次装载同一个插件时会报什么错？这个错为什么会误导排查方向？" | 指出了**具体症状和误导机制** |
| "隔离怎么加？" | "第 5 步加局部覆盖层时，`get` 的查找顺序是什么？这个改动需要修改第 3 步的哪些代码？" | 要求**改动范围分析** |

> ### 你的练习
>
> 挑一个改写，发给我：
>
> 1. "为什么 `Disposer` 要幂等？"
> 2. "容器树有什么用？"
> 3. **"如果我要做两个 harness 配置的对照实验，这个容器够用吗？"**

---

## L11 系统影响回溯

### 11.1 三个预判的检验

| 第 0.5 节的问题 | 现在你应该能答的 |
|---|---|
| 允许静默覆盖会掩盖连锁 1 的问题，但带来什么新问题？ | **"调 A 跑 B"** —— 你以为调用的是 A 的功能，实际执行了 B 的。而且**不报错**（第 2 步的决策表第 6 条讲过同样的问题） |
| "半个插件"占着服务名，还有什么其他症状？ | 它占着名字 → 真正的插件无法装载；如果它注册了别的服务，那些服务也残留在系统里被误用；(第 7 步后还会)在日志里出现来自一个"已卸载插件"的事件 |
| 第 5 步怎么同时满足"兄弟可见"和"内层优先"？ | **两层查找**：先沿树向上找局部覆盖表，再回落到全局表。第 3 步的全局表**依然是兜底**，所以已实现的行为不变 |

### 11.2 本篇的"锚点"一句话

> **插件之间通过容器发现彼此，不通过 import；每一项注册都必须能被精确撤销。**

它在后面的影子：

| 哪一步 | 同一思想的再现 |
|---|---|
| 第 4 步 | 事件注册也是 effect —— 卸载时监听器自动消失 |
| 第 5 步 | 作用域是"查找链上多一层"，不是替换 |
| 第 6 步 | 装载器批量 `plugin()`，卸载时整树回滚 |
| 第 7 步 | 会话日志的订阅也是 effect |
| 第 10 步 | 守卫注册成 effect —— 卸载守卫 = 关掉检查，循环代码不动 |

**最后一条就是"DSH 级"的核心承诺**：**关掉一个功能 = 卸载一个插件，而不是加 `if`。**

### 11.3 通向第 4 步的桥

**第 3 步结束时，系统的状态：**

```
✅ 插件能提供能力和被卸载
✅ 插件之间能通过服务名互相发现
❌ 但插件不能"观察/拦截"彼此 —— retry 想插手"请求失败"必须改循环
❌ 插件不能"声明依赖、等依赖就绪" —— 装载顺序错了就崩
```

**第 4 步要补上这两块。** 带着这些问题进入：

1. 如果 `retry` 插件想插手"模型请求失败"，它需要改哪里的代码？**能不改循环做到吗？**
2. 如果 `agent-loop` 在 `llm` **之前**装载，`ctx.require('llm')` 会抛错。怎么让它"等一等"？
3. `ctx.on('事件名', 处理函数)` 应该返回什么？
4. 如果同一个事件有 3 个监听器，第 2 个处理完了，第 3 个还要执行吗？**谁来决定？**

**第 4 个问题就是"waterfall 语义"** —— 第 4 步最核心的概念。

---

## 本篇完结

| 检查项 | 应该达到 |
|---|---|
| 能复述服务归属规则及其反例 | L1 |
| 能解释逆序卸载和失败回滚的必要性 | L1 |
| **能关掉文档写出 `provide` 和 `plugin`** | **L3** |
| **构造函数里写了 `parent.#registry`** | **L3（关键）** |
| 能说出"默认无隔离"会在第几步解决 | L4 |
| 能说出 `dispose` 不递归卸载子容器的后果 | L4 |
| 能提出至少 3 个 L4/L5 层的问题 | L4 |

---

**读完这篇，请回答我三个问题：**

1. **那个 bug**：1.2 节的踩坑记录，对你理解"为什么要画数据流图"有帮助吗？
2. **缺陷 1**（`dispose` 不递归卸载）：你觉得框架应该**自动保证**，还是**信任调用方**？这个取舍在真实系统里怎么定？
3. **下一站**：`04-events.md`（事件 + waterfall + 依赖注入）还是先跳到你最需要的 `07-session.md`？
# 第 2 步 · 工具注册表

> **代码**：`src/kernel/tools.ts`（282 行）+ `src/kernel/builtin-tools.ts`（约 130 行）
> **演示**：`src/demos/demo-tools.ts`
> **DSH 对应**：`packages/core/tools/src/`（`ctx.tools` 服务）
> **本篇目标级别**：L3（关掉文档能从零重写）
> **预计阅读**：70–100 分钟 · **预计动手**：70 分钟

---

## 本篇新词

> 全部术语在 [`glossary.md`](glossary.md)。先花 90 秒扫一遍。

| 词 | 一句话 | 为什么必须懂 |
|---|---|---|
| **tool（工具）** | 模型能调用的一个能力 = 名字 + 描述 + 参数说明书 + 执行函数 | 少任何一样模型都用不了它 |
| **schema（结构描述）** | "参数长什么样"的机器可读描述 | 模型靠它才知道怎么填参数 |
| **JSON Schema** | 描述 JSON 结构的标准格式（我们只用小子集） | 各厂商的通用语言 |
| **validation（校验）** | 检查输入是否符合预期 | **模型给的参数必须先校验再用** |
| **registry（注册表）** | "名字 → 东西"的表 | 替代一堆 `if (name === 'x')` |
| **tool call / tool result** | 模型的调用请求 / 我们回灌的执行结果 | 循环里的基本单位 |
| **truncate（截断）** | 超长输出砍中间、留头尾 | 不截断一条结果就能撑爆上下文 |
| **isError** | 结果里的"失败"标志 | 失败是**返回值**，不是异常 |
| **递归（recursion）** | 函数自己调用自己 | 嵌套参数的校验靠它 |
| **穷尽检查（exhaustiveness）** | 漏掉分支就编译报错 | 防止加类型时忘改某处 |
| **幂等（idempotent）** | 重复执行效果相同 | 重试安全的前提 |
| **副作用可逆性** ★ | 这个工具做的事能不能撤销 | **本篇新增字段**，见 1.8 |

---

## 第 0 节 · 这一步的成品长什么样

### 0.1 最终你会写出什么

两个文件，职责分明：

```
┌────────────────────────────────────────────────────────────────┐
│  tools.ts（282 行）—— 框架                                     │
│                                                                │
│  ① JsonSchema              参数说明书的类型                     │
│  ② ToolResult + ok/fail    统一的结果形状                       │
│  ③ Tool                    一个工具的定义                       │
│  ④ validateValue()         递归参数校验器                       │
│  ⑤ truncate()              结果截断                             │
│  ⑥ ToolRegistry            注册表：注册/查找/生成schema/执行     │
│                                                                │
│  这个文件**不碰任何真实 IO** —— 所以它天然可测试                  │
└────────────────────────────────────────────────────────────────┘
                              ▲
                              │ 框架 vs 插件
                              ▼
┌────────────────────────────────────────────────────────────────┐
│  builtin-tools.ts —— 骨架里"装"的三个具体工具                    │
│                                                                │
│  read_file    读文件（带行号）                                  │
│  write_file   写文件（覆盖）                                    │
│  list_dir     列目录                                            │
│                                                                │
│  + resolveInsideWorkspace()  路径越权检查                       │
└────────────────────────────────────────────────────────────────┘
```

### 0.2 运行起来是什么样

```powershell
node src/demos/demo-tools.ts
```

关键输出片段：

```
--- 模型能看到哪些工具 ---
[ "read_file", "write_file", "list_dir", "big_output", "set_level" ]

--- 缺少必填字段 ---
isError: true
工具 read_file 的参数不合法：
- 参数.path 是必填字段，但没有提供
请修正参数后重新调用。

--- 字段类型错 ---
isError: true
工具 read_file 的参数不合法：
- 参数.path 期望 string，实际是 number

--- enum 取值越界 ---
isError: true
工具 set_level 的参数不合法：
- 参数.level 只能是 "low" / "high"，实际是 "medium"

--- 工具内部抛异常（越权路径） ---
isError: true
工具 read_file 执行失败：Error: 路径越权："../../../Windows/win.ini" 不在工作目录内
```

**注意最后一条**：工具**内部抛了异常**，但 agent 没有崩 —— 它变成了一条 `isError: true` 的结果。

**这是本篇最重要的设计。**

### 0.3 这一步在整个课程里的位置

```
第 1 步              第 2 步（你在这里）        第 3 步
 模型层       ──►      工具层          ──►      ctx 容器
"能跟模型说话"        "能执行工具"            "能装插件"
```

**第 1 步给了"要求"，第 2 步给了"执行"。**

---

## 第 0.5 节 · 系统视角

### 你在哪里

```
                    ★ 能力层（第 7–10 步）★
                    session / agent-loop / retry / guard
                              ▲
                              │ 循环要生成 schema、要执行工具
                              │
                    ┌─────────┴─────────┐
                    │ 【第 2 步】        │
                    │ 工具层 tools.ts    │
                    │ ▶ 你在这里 ◀        │
                    └─────────┬─────────┘
                              │ 用 ToolCall（第 1 步的产物）
                              ▼
                        第 1 步 · 模型层
```

### 下游：谁在用工具层的东西

| 第 2 步的产物 | 谁消费 | 用来做什么 | 依赖强度 |
|---|---|---|---|
| `Tool` 接口 | 每个具体工具、第 5 步 scope | 定义/裁剪工具集 | 🔴 强依赖 |
| `ToolRegistry.schemas()` | 第 8 步 agent 循环 | 生成发给模型的说明书 | 🔴 强依赖 |
| `ToolRegistry.execute()` | 第 8 步 agent 循环 | 真正执行调用 | 🔴 强依赖 |
| `ToolResult.isError` | 第 8 步回灌、第 15 步诊断 | 判断这一步成没成 | 🔴 强依赖 |
| `validateArgs()` 错误文本 | 与第 1 步 `parseError` 同一套路 | 让模型自我纠正 | 🟡 弱 |
| `truncate()` | 所有会输出长文本的地方 | 防止上下文爆炸 | 🟡 弱 |
| ★ `Tool.sideEffect` | 第 10 步的守卫 | **判断能不能事前拦截** | 🔴 强依赖（待加） |

### 连锁影响分析

#### 连锁 1：如果 `execute()` 抛异常而不是返回 `fail`

```
execute() 抛异常
   ↓
第 8 步的循环没有 try/catch 包住它
   ↓
整个 agent 进程崩溃
   ↓
★ 用户看到"程序崩了"，而不是"模型不会用这个工具" ★
   ↓
第 15 步的诊断层拿不到任何可归因的数据（进程都死了）
```

**更糟的是**：这类崩溃往往发生在**最不该崩的时候** —— 工具被拒绝、路径非法。这些是**预期内的情况**，却导致了系统性失败。

#### 连锁 2：如果参数不校验，直接传给工具

```
模型给的 { path: 123 } 直接进 readFile(123)
   ↓
Node 抛出 TypeError（可能在很深的调用栈里）
   ↓
变成"工具执行失败：TypeError: ..."
   ↓
模型看到"路径 TypeError"，但它不知道自己给的是数字
   ↓
★ 模型可能重复同样的错误 ★
```

**对比我们的做法**：错误信息是

```
参数.path 期望 string，实际是 number
```

**模型看到"实际是 number"，立刻知道自己错了。**

**所以校验的价值不只是"挡住"，更是"说清为什么挡"。**

#### 连锁 3：如果不做截断

```
模型读了一个 10 万行的日志文件
   ↓
工具返回 10 万行文本
   ↓
它被拼进消息数组，进入下一轮请求
   ↓
★ 上下文窗口爆掉，或 token 成本暴涨 ★
```

**而且这个错误是"累积的"**：一次超长结果会影响**之后每一轮**的请求（因为历史是重复发送的）。

### 现在该建立的三个习惯

| 习惯 | 做法 |
|---|---|
| **失败要"说清为什么"** | 报错带上"实际是什么"，而不只是"错了" |
| **校验放在边界** | 外部来的数据必须校验；内部同进程调用信任类型 |
| **想着"这条数据会被重复发送"** | 任何会进消息数组的东西，都要算它的体积成本 |

> ### 停下来想一想（不给答案）
>
> 1. 为什么 `tools.ts` **故意不碰任何真实 IO**？如果把 `read_file` 的实现直接写进 `ToolRegistry.execute()`，会失去什么？
> 2. 连锁 2 里，我们花力气生成详细的参数错误 —— 是为了"挡住"还是为了"教会模型"？这两个目标会冲突吗？
> 3. 如果一个工具**执行成功但结果没用**（比如读了一个空文件），`isError` 应该是 `true` 还是 `false`？

---

## L0 要解决的问题

### 0.1 第 1 步留下的三个具体缺口

| 缺口 | 后果 |
|---|---|
| 没有"有哪些工具"的清单 | 无法生成说明书 → **模型根本不知道该调用什么** |
| 没有"名字 → 代码"的映射 | 拿到 `name` 也不知道该跑哪段 |
| 模型给的参数**不可信** | 直接塞进 `readFile()` 会抛出奇怪错误，甚至读到工作目录外 |

### 0.2 第三条最容易被忽略：模型会瞎编参数

**这不是异常，是日常。** 具体形态：

```jsonc
// ① 漏了必填字段
{ }                                     // 调 read_file 但没给 path

// ② 类型错
{ "path": 123 }                         // 给了数字

// ③ 编了一个不存在的工具
{ "name": "delete_everything" }

// ④ 编了一个不存在的取值
{ "level": "medium" }                   // 只接受 low / high

// ⑤ 路径越权
{ "path": "../../../Windows/win.ini" }

// ⑥ 编造字段名
{ "file_path": "a.txt" }                // 正确字段名是 path
```

**其中 ⑤ 是安全问题** —— 不是"模型想攻击你"，而是它**不知道边界在哪**，所以你要主动划出来。

### 0.3 一个超出预期的发现：错误还有"可逆性"维度

**这一节来自你的提问。** 它改变了本篇的设计，我完整记录这个过程。

#### 事件经过

我在第 1 步的 L10 节里问过：

> "如果把第 1 步的 8 个错误码，对应到你实验里'一次任务失败的原因'，你会怎么分类？"

你的回答是：

> **"需要回滚错误和重规划可纠正错误（实现方法问题而不是原理问题）"**

#### 为什么这个回答有分量

第 1 步的错误分类，维度是**时间**：

```
RATE_LIMIT  → 暂时的问题，等一会儿能好
AUTH        → 永久的问题，永远好不了
```

**你说的分类，维度完全不同 —— 是「可逆性」**：

```
重规划可纠正   → 还没造成副作用，换个路子就行
需回滚纠正     → 已经改了东西，必须先撤销
不可纠正       → 副作用收不回来了
```

**这两个维度是正交的。** 一个错误可以"瞬时且可逆"（网络抖动，重试即可），也可以"永久且不可逆"（误发了对外消息）。

#### 它暴露了本篇设计的一个真实缺口

看我们现在的 `Tool` 接口：

```ts
export interface Tool {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchema
  readonly handler: (args, ctx) => Promise<ToolResult>
  readonly maxOutputChars?: number
}
```

**它能回答"这个工具怎么用"，但不能回答"这个工具会不会做出收不回来的事"。**

而"能不能收回来"是**事前拦截的唯一依据**：

- `list_dir` / `read_file` → **只读，永远可逆** → 不需要拦截
- `write_file` → **改了文件，但可回滚** → 需要检查点
- `send_email` / `rm -rf` / `git push` → **不可逆** → ❗**必须事前拦截**

**没有这个字段，守卫就只能靠硬编码的工具名白名单** —— 脆弱且不可扩展。

#### 所以要补的字段

```ts
/** 工具执行后产生的影响，能否被撤销。 */
export type SideEffect =
  /** 不改变任何外部状态。可以随便调用。 */
  | 'none'
  /** 改变了可恢复的状态（文件、暂存区）。配合检查点可回滚。 */
  | 'reversible'
  /** 产生不可撤销的外部影响（对外发送、支付、删除）。**必须事前拦截**。 */
  | 'irreversible'

export interface Tool {
  // ... 现有字段 ...
  /**
   * 这个工具的副作用**在当前执行环境下**的可逆性。
   * 缺省视为 'none'；但只读工具应该**显式声明**，避免读者猜测。
   */
  readonly sideEffect?: SideEffect
}
```

**这个字段会在三处被使用**：

| 哪里 | 怎么用 |
|---|---|
| 第 8 步的循环 | 有 `irreversible` 调用时，先做检查点 |
| 第 10 步的守卫 | `irreversible` 必须过审批才能执行 |
| 第 15 步的诊断 | 按可逆性给失败分类（A/B/C） |

#### 诚实说明

**它是"设计先行"的产物** —— 我把它写进文档，但**代码还没改**。

标记：**本篇 L9 会把"`sideEffect` 尚未实现"列为已知缺陷**，并在挑战题里让你来实现它。

**同时请记住**：

> **一个好的提问，会改掉设计。**
> 你这个问题让第 2、10、15 步都多了一个字段和一个机制。

---

## L1 设计与原理

### 1.1 一个工具 = 四样东西 + 一样可选

```ts
export interface Tool {
  readonly name: string                                            // ① 名字
  readonly description: string                                     // ② 什么时候用它
  readonly parameters: JsonSchema                                  // ③ 参数说明书
  readonly handler: (args, ctx) => Promise<ToolResult>             // ④ 执行函数
  readonly maxOutputChars?: number                                 // ⑤ 结果上限（可选）
}
```

**缺任何一样会怎样**：

| 缺 | 后果 |
|---|---|
| `name` | 模型无法调用它 |
| `description` | 模型不知道**什么时候**该用 → 该用时不用，不该用时乱用 |
| `parameters` | 模型不知道参数怎么填 → 大概率填错 |
| `handler` | 注册表知道它存在，执行时却无事可做 |
| `maxOutputChars` | 用默认值（2 万字符），够用 |

### 1.2 关键认知：`description` 和 `parameters` 是**写给模型看的**

下面这段不是文档，是**真正会被塞进模型 prompt 的东西**：

```json
{
  "type": "function",
  "function": {
    "name": "read_file",
    "description": "读取工作目录内的一个文本文件，返回带行号的内容。改动文件前先用它看清原文。",
    "parameters": {
      "type": "object",
      "properties": {
        "path": { "type": "string", "description": "相对工作目录的文件路径" },
        "maxLines": { "type": "integer", "description": "最多返回多少行，默认 200" }
      },
      "required": ["path"]
    }
  }
}
```

**逐句分析它在做什么**：

| 文字 | 作用 |
|---|---|
| "读取工作目录内的一个文本文件" | 划定边界：不能读二进制、不能读目录、不能读工作目录外 |
| "返回带行号的内容" | 告知结果格式，避免模型困惑"为什么前面有数字" |
| **"改动文件前先用它看清原文"** | **行为纪律** —— 这一句在教模型工作流程 |
| "相对工作目录的文件路径" | 消除歧义：不是绝对路径 |
| "最多返回多少行，默认 200" | 说明默认值，让模型知道不传会怎样 |

**三条推论**：

1. **每个字都在花 token** → 说明书要精炼
2. **每个字都在影响行为** → 描述含糊，模型就误用
3. **工具越多，prompt 越长** → 这是第 5 步 scope 隔离的动机

**DSH 的做法**：`packages/core/system-prompt/` 专门管理"按顺序组装 prompt 段落 + 工具 schema"，因为这是一项独立且重要的职责。

### 1.3 JSON Schema：只用最小子集

```ts
export interface JsonSchema {
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array'
  readonly description?: string
  readonly properties?: Record<string, JsonSchema>
  readonly required?: readonly string[]
  readonly items?: JsonSchema
  readonly enum?: readonly (string | number)[]
}
```

**完整规范有几十个关键字。我们只用 6 个。**

**为什么"少即是好"？**

| 理由 | 说明 |
|---|---|
| **token 成本** | 每个字段都要发进 prompt，乘以工具数就是可观开销 |
| **模型理解成本** | 多一个关键字，就多一处模型可能理解错的地方 |
| **实现成本** | 校验器要为每个关键字写检查逻辑 |

**我们砍掉了什么（以及为什么现在不需要）**：

| 关键字 | 作用 | 为什么先不做 |
|---|---|---|
| `oneOf` / `anyOf` / `allOf` | 复杂组合 | 模型很难填对，好的工具设计应该避开这种参数 |
| `minimum` / `maximum` | 数值范围 | 可在 `handler` 里检查（第 10 步会有统一守卫） |
| `pattern`（正则） | 格式约束 | 同上 |
| `$ref` | 引用复用 | 我们的 schema 都很小 |
| `additionalProperties` | 禁止多余字段 | 我们选择**忽略**多余字段而不是报错 |

### 1.4 参数校验：递归 + 详细报错

#### 签名

```ts
export function validateValue(schema: JsonSchema, value: unknown, path: string): string[]
```

| 参数 | 为什么需要 |
|---|---|
| `schema` | 声明的结构 |
| `value` | 待检查的值（`unknown` —— 它来自模型，什么都可能是） |
| `path` | **当前位置**，用于错误信息（如 `参数.range.from`） |

**返回值是 `string[]` 而不是 `boolean`**：我们要**收集所有问题**，而不是遇到第一个就停。

#### 设计点 1：类型不对就不要往下挑了

```ts
if (!matchesType(schema.type, value)) {
  problems.push(`${path} 期望 ${schema.type}，实际是 ${typeNameOf(value)}`)
  return problems        // ← 提前返回
}
```

**为什么提前返回？**

假设 schema 声明 `path` 是对象且要求 `path.from`，但模型给了字符串。

**如果不提前返回**，你还会检查 `path.from` —— 而字符串的 `['from']` 是 `undefined`，于是产生两条错误：

```
参数.path 期望 object，实际是 string
参数.path.from 是必填字段，但没有提供     ← 噪音：因为 path 根本不是对象
```

**只有第一条是真实的。** 第二条会让模型困惑"我明明给了 path"。

**这是"报错要报根因，不要报连锁反应"。**

#### 设计点 2：路径是递归攒出来的

```ts
for (const [key, child] of Object.entries(schema.properties ?? {})) {
  if (value[key] === undefined) continue
  problems.push(...validateValue(child, value[key], `${path}.${key}`))
}
```

**注意 `${path}.${key}`** —— 每递归一层，路径长一段。于是嵌套参数的报错能精确到字段：

```
参数.range.from 期望 integer，实际是 string
```

**那个 `continue` 的含义**：字段不存在就跳过 —— "是否必填"已在上面检查过了，**这里检查的是"如果给了，类型对不对"**。

#### 设计点 3：`assertNever` 做穷尽检查

```ts
function matchesType(schemaType: JsonSchema['type'], value: unknown): boolean {
  switch (schemaType) {
    case 'string':  return typeof value === 'string'
    case 'number':  return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'array':   return Array.isArray(value)
    case 'object':  return isRecord(value)
  }
  return assertNever(schemaType)
}

function assertNever(value: never): never {
  throw new Error(`未处理的分支：${String(value)}`)
}
```

**`switch` 覆盖全部 6 种 type，没有 `default`。走到 `assertNever` 说明有人加了第 7 种类型却忘了在这里处理。**

**`value: never` 是关键**：

- `switch` 覆盖完整 → 走到这里时 `schemaType` 已收窄成 `never` → 编译通过
- 漏了分支 → `schemaType` 是"漏掉的那些字面量"→ **传不进 `assertNever`（要求 `never`）→ 编译报错**

**这就是"让编译器逼你处理新情况"。**

**DSH 的同类规范**：「closed unions end in `assertNever`；merge-extensible unions fall through a documented default」。

| 类型 | 结尾 | 理由 |
|---|---|---|
| **封闭**联合（我们知道全部成员） | `assertNever` | 加成员时必须改到这里 |
| **可扩展**联合（插件会加成员） | 有文档说明的 `default` | 不能因为别人加了成员就编译失败 |

**第 4 步的事件类型是"可扩展"的**（插件会加事件），所以那里要用 `default` + 文档说明。

### 1.5 核心设计：**失败不是异常，失败是正常返回值**

```ts
export interface ToolResult {
  readonly content: string      // 回灌给模型看的文字
  readonly isError: boolean     // 是否失败
}

export function ok(content: string): ToolResult   { return { content, isError: false } }
export function fail(content: string): ToolResult { return { content, isError: true } }
```

#### `execute()` 的完整结构（本步最重要的一段）

```ts
async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  // ① 未知工具
  const tool = this.#tools.get(name)
  if (tool === undefined) {
    const known = this.names().join(', ')
    return fail(`未知工具 "${name}"。可用工具：${known === '' ? '(无)' : known}`)
  }

  // ② 参数不合法
  const problems = validateArgs(tool.parameters, args)
  if (problems.length > 0) {
    return fail(`工具 ${name} 的参数不合法：\n- ${problems.join('\n- ')}\n请修正参数后重新调用。`)
  }

  // ③ 执行，任何异常都转成失败结果
  try {
    const result = await tool.handler(args, ctx)
    const limit = tool.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
    return { content: truncate(result.content, limit), isError: result.isError }
  } catch (cause) {
    const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
    return fail(`工具 ${name} 执行失败：${message}`)
  }
}
```

**三条失败路径，全部返回 `fail(...)`，没有一个 `throw`。**

> **抛异常会打断整个循环**（agent 死掉，用户看到崩溃）；
> **返回失败结果则让模型看到"我错在哪"，然后自己改。**

#### 每条失败信息的写法

| 路径 | 错误信息 | 模型能读出什么 |
|---|---|---|
| 未知工具 | `未知工具 "delete_everything"。可用工具：read_file, write_file, ...` | "我编了个不存在的工具，**真实可用的有这些**" |
| 参数不合法 | `工具 read_file 的参数不合法：\n- 参数.path 是必填字段...\n请修正参数后重新调用。` | "具体哪个字段错了，**而且要我重试**" |
| 执行失败 | `工具 read_file 执行失败：Error: 路径越权：...` | "这个操作不被允许，**换个路径**" |

**三条信息都遵循同一模式：说清事实 + 给出下一步。**

**"请修正参数后重新调用"这句很重要** —— 它显式告诉模型"重试是被允许的"。没有它，模型可能以为"这个工具坏了"而放弃。

### 1.6 结果截断：头 80% + 尾 20%

```ts
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = Math.floor(limit * 0.8)
  const tail = limit - head
  const removed = text.length - limit
  return `${text.slice(0, head)}\n\n...（中间省略 ${removed} 个字符）...\n\n${text.slice(text.length - tail)}`
}
```

**为什么留尾巴？**

> **报错信息、失败原因几乎总在末尾。** 只留开头等于把最有用的部分扔了。

**实测**：`big_output` 产出 500 字符、上限 200 时，结果是 224 字符：

```
160（头，80%）+ 24（"...（中间省略 300 个字符）..."） + 40（尾，20%） = 224  ✓
```

**为什么省略信息里写"多少字符"？** 因为读者需要知道**丢了多大的量**。"省略了一部分"没有信息量，"省略了 300 个字符"能让人判断"要不要换别的方式看完整内容"。

**DSH 的对应实现**：`compaction-tool-result-pruner`，配置 `thresholdChars: 8192, headChars: 4096, tailChars: 1024`。

**注意它的阈值比我们小得多** —— 因为 DSH 会把超长结果存到别处（`spill` 机制），模型需要时再去取。我们没做 spill，只能靠截断。

### 1.7 路径安全：最小防线

```ts
function resolveInsideWorkspace(ctx: ToolContext, raw: unknown): string {
  const input = typeof raw === 'string' ? raw : String(raw ?? '.')
  const absolute = resolve(ctx.workspace, input)

  const rel = relative(ctx.workspace, absolute)
  if (rel === '') return absolute
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`路径越权：${JSON.stringify(input)} 不在工作目录内`)
  }
  return absolute
}
```

**关键的三行**：

```ts
const rel = relative(ctx.workspace, absolute)
if (rel === '') return absolute
if (rel.startsWith('..') || isAbsolute(rel)) { throw ... }
```

| 情况 | `rel` | 判定 |
|---|---|---|
| 目标在工作目录下 | `'notes/hello.txt'` | ✅ |
| 目标就是工作目录 | `''` | ✅（提前返回） |
| 目标在上一层 | `'../secret.txt'` | ❌ 以 `..` 开头 |
| **目标在另一个盘（Windows）** | `'D:\\other\\x.txt'` | ❌ **`isAbsolute(rel)` 为真** |

**第二个判断为什么必须有？**

因为 **Windows 上跨盘符时，`relative()` 会返回绝对路径**（它没法用相对路径描述跨盘的位置）。

**这是个只在 Windows 上出现的坑** —— 只判 `startsWith('..')` 的话，`read_file({path: 'D:\\秘密.txt'})` 会**绕过检查**。

**为什么用 `throw` 而不是返回 `fail`？**

因为 `resolveInsideWorkspace` 是**工具内部的分工函数**，不是注册表接口。**它抛错，由注册表的 `catch` 统一转成 `fail`。**

**这是"分层错误处理"**：内层用异常（表达"我这里出问题了"），最外层统一转成返回值（表达"这次调用失败了"）。

**这条经验在 DSH 里同样成立**：仓库规范要求"空 catch 必须命名错误并说明为什么"、"try 只包一条语句" —— 都是为了不让异常处理的边界变模糊。

### 1.8 副作用可逆性（来自你的提问）

前面 0.3 节讲了为什么需要它。这里讲**怎么设计**。

#### 三种取值与分类

```ts
export type SideEffect = 'none' | 'reversible' | 'irreversible'
```

| 工具 | `sideEffect` | 判据 |
|---|---|---|
| `read_file` / `list_dir` | `'none'` | 只读，调用一万次效果一样 |
| `write_file` | `'reversible'` | 改了文件，但可以从备份/版本控制恢复 |
| `bash`（任意命令） | ❗ `'irreversible'` | **你无法静态判断它做了什么**，保守按最坏情况算 |
| `send_email` / `http_post` | `'irreversible'` | 消息已经发出去了 |
| `todo_write` | `'none'` | 只改内部状态 |

**`bash` 那一行是设计里最难的部分：**

> **一个能执行任意命令的工具，它的可逆性无法静态判定。**

| 策略 | 说明 |
|---|---|
| **保守默认** | 按 `irreversible` 处理，每次都审批（安全但烦） |
| **命令分析** | 解析命令，识别只读命令（`ls`、`cat`、`git status`）放行 |

**DSH 是两者结合**：`sandbox` + `approval` 两层，且 `bash` 在沙箱内执行 —— **沙箱限制了它能碰什么，所以"不可逆"的范围被缩小了**。

#### 由此得到一个更准确的结论

> **`sideEffect` 不是工具的固有属性，它取决于执行环境。**

- 在**全权限**环境里，`write_file` 是 `irreversible`（可能覆盖重要文件且没有回收站）
- 在**有检查点**的环境里，它是 `reversible`

所以字段注释必须写清"**在当前执行环境下**"，否则读者会以为它是绝对的。

#### 缺省值：安全 vs 便利的权衡

| 缺省值 | 后果 |
|---|---|
| `'none'`（宽松） | 忘记声明的危险工具会被放行 ❗ |
| `'irreversible'`（保守） | 忘记声明的只读工具会触发审批，很烦但安全 |

**工业界惯例是保守：默认最严，显式放宽。**

**我们的选择是可选字段 + 文档规定"只读工具应显式声明 `none`"**，理由：教学项目、工具少、都是自己写的。

**代价**：将来接入第三方工具时，这个缺省值是**安全隐患**。**这一条要写进 L9。**

#### 这个设计的"下一层"问题（属于第 10、15 步）

有了 `sideEffect` 之后，守卫逻辑是：

```
irreversible → 必须审批
reversible   → 需要检查点（自动打点，不打断）
none         → 放行
```

**但还有两个开放问题**：

1. **多步组合的可逆性**：单个工具都是 `reversible`，但"删掉 A 然后写 B"这个**组合**可能不可逆
2. **可逆性随状态变化**：第一次 `write_file` 是 `reversible`（文件还不存在，删掉即可），但文件已有内容时就需要先备份

**这两个问题现在不解决，但要记住它们存在** —— 它们是"实现方法问题"的典型例子（原理明白，实现要设计）。

> ### 停下来想一想（不给答案）
>
> 1. 1.2 节说"每个字都在花 token"。如果一个工具的 `description` 从 20 字扩到 200 字，**模型行为**会怎么变？**成本**会怎么变？这两个变化方向一致吗？
> 2. `bash` 的 `sideEffect` 应该是哪个值？如果你选 `irreversible`，用户体验会怎样？有折中方案吗？
> 3. 如果 `truncate` 的头上限从 80% 改成 100%（只留头），第 8 步会发生什么？
> 4. **【系统题】** 加上 `sideEffect` 后，第 2 步的哪些文件要改？第 10、15 步各要加什么？

---

## L2 决策表

| # | 决策 | 我们的选择 | 替代方案 | 代价落在谁身上 |
|---|---|---|---|---|
| 1 | 工具查找 | `Map` 注册表 | agent 里写 `if (name === 'x')` | 多一个类；换来工具集可按场景裁剪（第 5 步） |
| 2 | Schema | 手写 JSON Schema 子集 | 从 TS 类型自动生成 | 要手写；换来可见、可控、零工具链 |
| 3 | 参数校验 | 手写递归校验器 | 引入 `zod` / `ajv` | 少 200 行代码换**零依赖**；真实项目该用库 |
| 4 | 校验失败 | 返回**全部**问题 | 遇错即停 | 多一次遍历；换来模型一次看全所有错误 |
| 5 | 失败处理 | 返回 `isError` 结果 | 抛异常 | 调用方要判断 `isError`；换来循环不被打断 |
| 6 | 重名注册 | 直接报错 | 静默覆盖 | 插件冲突会失败；换来"调 A 跑 B"绝迹 |
| 7 | 输出上限 | 头 80% + 尾 20% | 只留开头 | 略复杂；换来错误信息不被截掉 |
| 8 | 路径校验 | 工具内部各写一份 | 抽成公共守卫 | 重复 8 行；换来第 10 步能统一收编 |
| 9 | 路径越权 | `throw` → 注册表转 `fail` | 工具自己返回 `fail` | 内层要抛错；换来工具实现更简洁 |
| 10 | `sideEffect` 缺省 | `'none'`（宽松） | `'irreversible'`（保守） | **第三方工具接入时是安全隐患** |
| 11 | 校验器覆盖 | 只查 6 个关键字 | 实现完整 JSON Schema | 表达力受限；换来实现小、模型容易填对 |

### 关于第 3 条的完整论证

**为什么不用 `zod` / `ajv`？**

| 方案 | 优点 | 缺点 |
|---|---|---|
| 手写（我们的选择） | 零依赖；实现完全可见；能按需要裁剪 | 200 行代码；覆盖的关键字有限 |
| `zod` | 类型推断强；生态好 | 需要 install（本机 npm 不可用） |
| `ajv` | 完整 JSON Schema 规范 | 体积大；错误信息格式要额外处理 |

**真实项目的正确选择是 `zod` 或 `ajv`** —— 我们不用的唯一原因是**本机 npm 不可用**（第 0 节验证过）。

**这不是"手写更好"，是"环境限制下的选择"。** 这个区别要在心里分清。

### 关于第 6 条的代价

静默覆盖看起来"更宽容"，但它会导致一类**极难排查的 bug**：

```
插件 A 注册了 read_file（带权限检查）
插件 B 也注册了 read_file（没检查）→ 静默覆盖
模型调用 read_file → 跑了 B 的版本
★ 你以为有权限检查，实际没有 ★
```

**而且它不会报错。** 这正是"沉默型问题"的典型。

---

## L3 实现：逐行讲解

> 每小节先给**完整代码**（与源文件一字不差），再逐行/逐块解释。

### 3.0 全文件的六节结构

```
┌─── 第 1 节（17–36 行）   JsonSchema —— 参数说明书
├─── 第 2 节（42–58 行）   ToolResult + ok/fail —— 统一的结果形状
├─── 第 3 节（64–85 行）   ToolContext + Tool —— 工具定义与运行环境
├─── 第 4 节（91–175 行）  参数校验（5 个函数）
├─── 第 5 节（181–191 行） 结果截断
└─── 第 6 节（197–282 行） ToolSchema + ToolRegistry
```

**建议阅读顺序**：先读第 6 节的 `ToolRegistry`（它是"这个文件有什么用"的答案），再回头读其它节（它们都是为它服务的）。

---

### 3.1 文件头注释（第 1–11 行）

```ts
/**
 * 第 2 步 ｜ 工具注册表
 *
 * 模型能「要求」调用工具，但要真正执行它，需要三样东西：
 *   1. 一张表       —— 名字 → 工具定义
 *   2. 一份说明书    —— 转成 JSON Schema 发给模型，它才知道有哪些工具、参数怎么填
 *   3. 一道关卡     —— 模型给的参数不可信，用之前必须校验
 *
 * 这个文件只做框架，不碰任何真实 IO —— 所以它天然可测试。
 * 具体工具（读文件、写文件）在 builtin-tools.ts 里。
 */
```

**这段注释的结构值得学**：

| 部分 | 作用 |
|---|---|
| "三样东西" | **用编号列出职责**，读者一眼知道这个文件管几件事 |
| "这个文件只做框架，不碰任何真实 IO" | **划清边界**，并给出理由（"所以它天然可测试"） |
| "具体工具在 builtin-tools.ts 里" | **指向另一处**，避免读者在这里找不到 `read_file` 而困惑 |

**"所以它天然可测试"这句话是因果，不是口号。**

- 因为不碰 IO → 不需要真实文件系统 → 可以用纯数据测试
- 对比：如果校验逻辑写在 `read_file` 里面，你要测它就得先创建一个文件

**这个原则在 DSH 里叫「Source plane vs artifact plane」**：静态检查解析源码，运行时测试跑真实文件，两者不混。

---

### 3.2 `JsonSchema`（第 17–36 行）

```ts
export interface JsonSchema {
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array'
  /** 这个字段是干什么用的。**这是写给模型看的**，写清楚能显著减少填错。 */
  readonly description?: string
  /** 仅 type='object' 使用：每个字段名 → 它的 schema。 */
  readonly properties?: Record<string, JsonSchema>
  /** 仅 type='object' 使用：哪些字段必须提供。 */
  readonly required?: readonly string[]
  /** 仅 type='array' 使用：数组元素的结构。 */
  readonly items?: JsonSchema
  /** 限定取值只能是这几个之一。 */
  readonly enum?: readonly (string | number)[]
}
```

#### 三个细节

**细节 1：`properties` 是递归的**

```ts
readonly properties?: Record<string, JsonSchema>
//                                    ▲ 自己引用自己
```

这叫**递归类型**。它让 JSON Schema 能描述任意深度的嵌套结构：

```ts
{
  type: 'object',
  properties: {
    range: {                                   // 第一层
      type: 'object',
      properties: {
        from: { type: 'integer' },             // 第二层
        to:   { type: 'integer' },
      },
    },
  },
}
```

**TS 完全支持递归类型**（不像某些语言需要前置声明）。这直接决定了校验器也必须是递归的。

**细节 2：每个可选字段的注释都写了"仅 type=xxx 使用"**

```ts
/** 仅 type='object' 使用：每个字段名 → 它的 schema。 */
readonly properties?: Record<string, JsonSchema>
```

**为什么这么写？** 因为 `JsonSchema` 是**一个接口描述 6 种形态**（string / number / object / array / …），而其中三个字段只在特定类型下有意义。

**替代方案**是把它拆成 6 个接口组成的联合类型：

```ts
type JsonSchema = StringSchema | NumberSchema | ObjectSchema | ArraySchema | ...
```

**那更严格**，但我们不用，因为：

- 校验器要写 6 次类型收窄，代码量翻倍
- 写 schema 时每次都要确认"我写的是哪种"

**代价**：编译器不会阻止你给 `type: 'string'` 加 `properties`。**换来**：写法简单。

**这是"在合适的地方放松类型"的例子** —— 判断标准是：**放松的收益（写法简单）是否大于风险（写错不报错）**。

这里风险低，因为 schema 都是我们自己写的、数量少、且有运行时的 `matchesType` 兜底。

**细节 3：`enum` 的值类型是 `string | number`**

```ts
readonly enum?: readonly (string | number)[]
```

**为什么不用 `unknown[]` 或 `readonly string[]`？**

| 类型 | 问题 |
|---|---|
| `readonly string[]` | 不支持数字枚举（如 `level: 1 \| 2 \| 3`） |
| `unknown[]` | 太宽松，`includes()` 比较时类型对不上 |
| **`(string \| number)[]`** | ✅ 覆盖了实际会用到的两种 |

**布尔值为什么不在里面？** 因为 `enum: [true, false]` 就等于 `type: 'boolean'`，没必要。对象和数组做枚举值也不实际。

---

### 3.3 `ToolResult` 与 `ok` / `fail`（第 42–58 行）

```ts
/** 一次工具执行的结果。 */
export interface ToolResult {
  /** 回灌给模型看的文字。 */
  readonly content: string
  /** 是否是「失败」。注意：失败**不是**异常，它是正常返回值的一种。 */
  readonly isError: boolean
}

/** 造一个成功结果。 */
export function ok(content: string): ToolResult {
  return { content, isError: false }
}

/** 造一个失败结果。 */
export function fail(content: string): ToolResult {
  return { content, isError: true }
}
```

#### `ok` / `fail` 这两个两行函数值得存在吗

**值得，理由有三**：

| 理由 | 说明 |
|---|---|
| **可读性** | `return ok('已写入')` 比 `return { content: '已写入', isError: false }` 短一半 |
| **防止笔误** | 手写对象时容易把 `isError` 写成 `iserror` 或漏掉；用函数不会 |
| **改造成本** | 将来 `ToolResult` 加字段（比如 `durationMs`），只改这两个函数 |

**第三条最重要。** 假设三个月后你要给每个结果加耗时：

```ts
// 用函数（改 2 处）
export function ok(content: string): ToolResult { return { content, isError: false, durationMs: 0 } }

// 不用函数（要改几十处 —— 每个 handler 里的 return）
```

**这叫"把构造逻辑收口"。** 判断标准：**同一个对象的构造是否出现在 3 处以上**。

注意 `ok` / `fail` 的签名里 `content` 是**必填**（没有 `?`）—— 空结果也要写 `ok('')`。

**为什么不给默认值 `content = ''`？**

因为**"返回了空内容"通常是个信号**（比如工具没找到东西）。强制写出来，能让作者多想一想"我真的要返回空吗"。

---

### 3.4 `ToolContext`（第 64–68 行）

```ts
/** 工具运行时拿到的环境信息。 */
export interface ToolContext {
  /** 工作目录。所有相对路径都以它为基准。 */
  readonly workspace: string
}
```

**只有一个字段。** 但它是**整个文件里最容易被低估的设计**。

#### 为什么工具需要它

`handler` 的签名是：

```ts
readonly handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
//                                               ▲ 这个
```

**为什么不像这样**：

```ts
readonly handler: (args: Record<string, unknown>, workspace: string) => Promise<ToolResult>
```

**因为 `workspace` 只是一个开始。** 后面会需要更多：

| 第几步 | `ToolContext` 会加什么 | 用来做什么 |
|---|---|---|
| 第 7 步 | `sessionId` | 把工具产生的持久事实记到正确的会话里 |
| 第 8 步 | `signal: AbortSignal` | 用户取消时要中断正在跑的工具 |
| 第 10 步 | `approval` 通道 | 工具内部发起审批（比如 bash 要确认命令） |
| 第 15 步 | `stepId` / `traceId` | 把工具调用和轨迹关联起来做归因 |

**如果一开始写成第二个参数就是一个字符串，这些都要改签名 —— 而签名改了，所有工具实现都要改。**

**所以：把"运行环境"打包成一个对象，从一开始就留出扩展空间。**

**这在 DSH 里体现得更彻底**：工具的 `execute()` 拿到的是一个**很厚的上下文**（`ToolExecution`），包含工作区、权限、会话、取消信号、日志等。它的注释是：

> "ToolDefinition, ToolExecution, ToolExecutionResult, guard and decision types"

#### 一个诚实的说明

**当前 `ToolContext` 只有一个字段，看起来"过度设计"。**

**这是对的判断 —— 它现在确实很薄。** 但"薄"和"错"是两件事：

- 如果将来需要加，改签名 = 改所有工具（成本高）
- 现在就打包，将来加字段 = 只改用到新字段的工具（成本低）

**代价**：现在每个 handler 都要写 `ctx` 参数，即使不用它。

**判断标准**：**这个"环境"类的东西，未来确定会增长吗？** 会 → 现在就打包。

---

### 3.5 `Tool` 接口与常量（第 70–85 行）

```ts
/** 一个工具 = 名字 + 描述 + 参数说明书 + 执行函数。 */
export interface Tool {
  /** 工具名。模型就是靠这个名字调用的，必须唯一。 */
  readonly name: string
  /** 一句话说清「什么时候该用它」。这行字直接进模型的 prompt。 */
  readonly description: string
  /** 参数说明书。 */
  readonly parameters: JsonSchema
  /** 真正干活的函数。收参数、干活、返回 ToolResult。 */
  readonly handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
  /** 单次结果最多保留多少字符，超出截断。默认 {@link DEFAULT_MAX_OUTPUT_CHARS}。 */
  readonly maxOutputChars?: number
}

/** 结果默认的字符上限。 */
export const DEFAULT_MAX_OUTPUT_CHARS = 20_000
```

#### 逐字段

**`name: string`** —— 唯一性由注册表保证（`register` 时检查），不在类型里表达。

**`description` 的注释里写「这行字直接进模型的 prompt」** —— 这是个**关键提醒**。写这段代码的人必须时刻意识到：这不是给人看的文档。

**`handler` 的三个部分**：

```ts
(args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
//        ▲ 注意这里                      ▲ 环境         ▲ 一定是 Promise
```

| 部分 | 说明 |
|---|---|
| `args: Record<string, unknown>` | **不是泛型！** 参数类型不在编译期检查，靠**运行时校验** |
| `ctx: ToolContext` | 运行环境（见 3.4） |
| `Promise<ToolResult>` | **即使工具是同步的，也必须返回 Promise** |

**第一点值得展开**：为什么 `args` 是 `Record<string, unknown>` 而不是泛型 `T`？

**泛型版本**看起来更安全：

```ts
interface Tool<TArgs> {
  handler: (args: TArgs, ctx: ToolContext) => Promise<ToolResult>
}
```

**但它解决不了实际问题**：

```ts
// 参数从哪里来？从模型的 JSON 来。
const raw: unknown = JSON.parse(modelOutput)      // ← 运行时的东西
const tool = registry.get(name)                   // ← Tool<unknown>（注册表里类型被擦掉了）
await tool.handler(raw as SomeType, ctx)          // ← 这个 as 是骗人的
```

**因为参数来自模型的 JSON 字符串，编译器无法验证它。** 泛型只会给你一个**虚假的安全感**（`as SomeType` 一句就绕过去了）。

**正确的做法**：参数用 `Record<string, unknown>`（诚实承认"我不知道里面是什么"），然后**在运行时校验**（`validateArgs`）。

**这个决策的深层逻辑**：

> **编译期的类型安全，只对"同进程、由我们自己构造的数据"有效。**
> **跨边界的输入（模型的 JSON、网络响应、文件内容）必须在运行时校验。**

**DSH 的仓库规范里有一条正是这个**：

> 「Trust TypeScript at typed same-process boundaries. Do not add runtime validation... solely for values the static interface requires; **validate at parser/config, queued, model/tool JSON, durable/file, worker, process, and wire boundaries**.」

翻译：**同进程信任类型，边界处必须校验。** 模型给的 JSON 正是"model/tool JSON boundary"。

**`maxOutputChars?: number` 是可选的，默认值是从常量来的**：

```ts
const limit = tool.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
```

**为什么默认值是一个导出的常量而不是字面量 `20000`？**

| 理由 | 说明 |
|---|---|
| **可被测试引用** | 测试里可以写 `expect(result.length).toBeLessThanOrEqual(DEFAULT_MAX_OUTPUT_CHARS + 100)` |
| **JSDoc 能链接** | 上面注释用了 `{@link DEFAULT_MAX_OUTPUT_CHARS}`，编辑器能跳转 |
| **语义明确** | 变量名本身说明了这个数字是什么 |

**数字字面量散在代码里叫"魔法数字"** —— 看到 `20000` 你要猜它是超时？是长度？是重试次数？

---

### 3.6 `isRecord` 与 `typeNameOf`（第 91–101 行）

```ts
/** 判断一个值是不是「字符串键的对象」。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 给人看的类型名。 */
function typeNameOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}
```

#### `isRecord` 的返回类型是类型谓词

```ts
function isRecord(value: unknown): value is Record<string, unknown> {
//                              ▲ 注意这里
```

**`value is Record<string, unknown>` 叫「类型谓词」**。它告诉 TypeScript：

> **"如果这个函数返回 true，那么 `value` 就是 `Record<string, unknown>`。"**

**效果**：

```ts
if (isRecord(value)) {
  value['anyKey']        // ✅ 编译通过 —— 编译器知道它是对象了
}
```

**对比没有类型谓词**：

```ts
function isRecord(value: unknown): boolean { ... }   // ← 返回 boolean

if (isRecord(value)) {
  value['anyKey']        // ❌ 编译报错 —— 编译器不知道 value 是什么
}
```

**这是"把运行时的检查结果告诉编译器"的机制。**

**三个判断缺一不可**：

| 判断 | 挡掉什么 |
|---|---|
| `typeof value === 'object'` | 字符串、数字、布尔、undefined、function |
| `value !== null` | **`typeof null === 'object'`** —— 不加这个，`null` 会被当成对象 |
| `!Array.isArray(value)` | **`typeof [] === 'object'`** —— 不加这个，数组会被当成对象 |

**第 2、3 条正是第 1 步 L5 里"最容易踩的两条规则"** —— 现在你看到它们在真实代码里的应用了。

#### `typeNameOf` 为什么单独一个函数

**因为 `typeof` 给出的名字会误导**：

```ts
typeof null       // 'object'   ← 误导
typeof []         // 'object'   ← 误导
typeof 'x'        // 'string'   ← 正确
typeof 123        // 'number'   ← 正确
```

**所以要先排除两种特殊情况，再退回 `typeof`。**

**为什么叫 `typeNameOf` 而不是 `getType` 或 `describe`？**

因为它的用途**只有一个**：**生成错误信息里的类型名**。注释里写的是"给人看的类型名" —— 明确它是给人（模型）读的。

**命名要反映用途**，而不只是"它做了什么"。

---

### 3.7 `assertNever` 与 `matchesType`（第 103–129 行）

```ts
function assertNever(value: never): never {
  throw new Error(`未处理的分支：${String(value)}`)
}

function matchesType(schemaType: JsonSchema['type'], value: unknown): boolean {
  switch (schemaType) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isRecord(value)
  }
  // 走到这里 schemaType 已经是 never —— 说明上面漏了分支
  return assertNever(schemaType)
}
```

#### `JsonSchema['type']` —— 索引访问类型

```ts
function matchesType(schemaType: JsonSchema['type'], ...)
//                               ▲ 这是"取 JsonSchema 的 type 属性类型"
```

**写成 `JsonSchema['type']` 而不重新写一遍联合类型**，好处是：

- **`JsonSchema.type` 改了，这里自动跟着改**
- 不能出现"两处定义不一致"

**这是"单一来源"原则在类型层面的应用。**

#### `number` 与 `integer` 的区别

```ts
case 'number':
  return typeof value === 'number' && Number.isFinite(value)
case 'integer':
  return typeof value === 'number' && Number.isInteger(value)
```

| 检查 | 挡掉什么 |
|---|---|
| `Number.isFinite` | `NaN`、`Infinity`、`-Infinity` |
| `Number.isInteger` | `1.5`、`NaN`、`Infinity` |

**为什么 `number` 要排除 `NaN` 和 `Infinity`？**

因为 JSON **不支持**它们。但经过 `JSON.parse` 后不可能是 `NaN`……那什么时候会遇到？

**当参数不是来自 JSON，而是我们自己构造的时候**（比如第 8 步内部调用工具）。**防御性写法。**

**而且 `Number.isFinite` 比 `!Number.isNaN` 更严格** —— 后者放过了 `Infinity`。

#### `assertNever` 的 `never` 双重身份

```ts
function assertNever(value: never): never {
//                    ▲ 参数类型  ▲ 返回类型
```

| 位置 | 含义 |
|---|---|
| 参数 `never` | **只有 `never` 类型的值能传进来** —— 这就是穷尽检查的机制 |
| 返回 `never` | **这个函数永远不会正常返回**（它一定抛错） |

**返回 `never` 的用处**：让 `return assertNever(x)` 能出现在任何需要返回值的上下文里 —— 因为它"符合任何类型"（`never` 是所有类型的子类型）。

#### 空 `switch` 后面没有 `default` 是有意的

**如果写 `default: return false`**，那么：

- 加了新类型 → 编译器**不报错** → 新类型的参数**静默失败**（永远返回 false）

**不写 `default`**，那么：

- 加了新类型 → **编译报错** → 你被迫去处理它

**"让编译器发现问题"比"运行时静默失败"好得多。**

---

### 3.8 `validateValue`（第 131–170 行）

```ts
export function validateValue(schema: JsonSchema, value: unknown, path: string): string[] {
  const problems: string[] = []

  if (!matchesType(schema.type, value)) {
    problems.push(`${path} 期望 ${schema.type}，实际是 ${typeNameOf(value)}`)
    // 类型都不对，就不要继续往下挑了，否则会报一堆噪音
    return problems
  }

  if (schema.type === 'object' && isRecord(value)) {
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) problems.push(`${path}.${key} 是必填字段，但没有提供`)
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (value[key] === undefined) continue
      problems.push(...validateValue(child, value[key], `${path}.${key}`))
    }
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items !== undefined) {
    const itemSchema = schema.items
    for (const [index, item] of value.entries()) {
      problems.push(...validateValue(itemSchema, item, `${path}[${index}]`))
    }
  }

  if (schema.enum !== undefined && !schema.enum.includes(value as string | number)) {
    const allowed = schema.enum.map((item) => JSON.stringify(item)).join(' / ')
    problems.push(`${path} 只能是 ${allowed}，实际是 ${JSON.stringify(value)}`)
  }

  return problems
}
```

#### 结构总览：四个检查块，顺序有意

```
① 类型对不对？         不对就 return（不再往下）
② 如果是对象：查必填 + 递归查每个字段
③ 如果是数组：递归查每个元素
④ 有 enum 吗？值在不在里面
```

**① 必须最先，且必须提前返回**（理由见 L1 的 1.4）。

**②③ 互斥**（一个值不可能既是对象又是数组），所以用 `if` 而不是 `else if` 也没问题 —— 但写 `else if` 语义更清楚。

**④ 是独立的** —— 任何类型都可以有 `enum`。

#### 逐块精讲

**块 ①：类型检查与提前返回**

```ts
if (!matchesType(schema.type, value)) {
  problems.push(`${path} 期望 ${schema.type}，实际是 ${typeNameOf(value)}`)
  return problems
}
```

**注意 `return problems` 而不是 `return []`** —— 因为 `problems` 里**已经有**刚 push 的那条。两种写法等价（此时它只有一个元素），但 `return problems` 更不容易出错。

**错误信息的格式**：`参数.path 期望 string，实际是 number`

**这个模式值得记住**：

```
<位置> 期望 <期望值>，实际是 <实际值>
```

**三段齐全**，模型才知道：改哪里、改成什么、现在是什么。

**块 ②：对象检查**

```ts
if (schema.type === 'object' && isRecord(value)) {
```

**为什么是 `&&` 而不是只用 `schema.type === 'object'`？**

因为 `matchesType` 已经确认了类型，但 **TypeScript 不知道**（它不会从"调用了 matchesType 且返回 true"推断出 `value` 是对象）。

**所以需要 `isRecord(value)` 这个类型谓词来收窄类型** —— 这样 `value[key]` 才能编译通过。

**这是"运行时已确认，但要再给编译器一个证据"的典型场景。**

```ts
for (const key of schema.required ?? []) {
  if (value[key] === undefined) problems.push(`${path}.${key} 是必填字段，但没有提供`)
}
```

**`schema.required ?? []`**：`required` 是可选字段，没写就当作空数组（= 没有必填项）。

**为什么判断 `=== undefined` 而不是 `!(key in value)`？**

| 判断 | `{path: undefined}` 时 |
|---|---|
| `value[key] === undefined` | 视为"没提供" ✅ |
| `!(key in value)` | 视为"提供了"（因为键存在） |

**`{path: undefined}` 在 JSON 里不可能出现**（JSON 没有 undefined），但**在内部构造的对象里可能出现**。**我们选择把它当作"没提供"** —— 这更符合直觉。

```ts
for (const [key, child] of Object.entries(schema.properties ?? {})) {
  if (value[key] === undefined) continue
  problems.push(...validateValue(child, value[key], `${path}.${key}`))
}
```

**`Object.entries()` 返回 `[键, 值][]`**，配合解构 `[key, child]` 遍历。

**`if (value[key] === undefined) continue`**：

- **跳过不存在的字段**（必填性已在上面查过）
- 如果字段存在，继续往下校验它的类型

**`problems.push(...validateValue(...))`**：

**`...` 是展开运算符**，把递归返回的**数组展开成一个个参数** push 进去。

```ts
// 等价于
const sub = validateValue(child, value[key], `${path}.${key}`)
for (const p of sub) problems.push(p)
```

**为什么这么写？** 因为 `push` 接受多个参数，展开后一次调用即可。**（对超大数组要小心 `apply`/展开的参数个数上限，但校验问题不会有几百条。）**

**`${path}.${key}`** —— 路径拼接。**这就是"报错能定位到嵌套字段"的实现。**

**块 ③：数组检查**

```ts
if (schema.type === 'array' && Array.isArray(value) && schema.items !== undefined) {
  const itemSchema = schema.items
  for (const [index, item] of value.entries()) {
    problems.push(...validateValue(itemSchema, item, `${path}[${index}]`))
  }
}
```

**`const itemSchema = schema.items`** —— 为什么要多一个局部变量？

因为 `schema.items` 的类型是 `JsonSchema | undefined`。虽然上一行判断了 `!== undefined`，但**在闭包/循环里，TS 可能不保留这个收窄**。

**提前取出来赋给 `const`，类型就被钉死成 `JsonSchema` 了。** 这是绕过"类型收窄在回调里失效"的标准手法。

**`value.entries()`** 返回 `[索引, 元素]` 迭代器 —— 所以路径是 `${path}[${index}]`（数组用方括号）。

**块 ④：enum 检查**

```ts
if (schema.enum !== undefined && !schema.enum.includes(value as string | number)) {
  const allowed = schema.enum.map((item) => JSON.stringify(item)).join(' / ')
  problems.push(`${path} 只能是 ${allowed}，实际是 ${JSON.stringify(value)}`)
}
```

**`schema.enum.includes(value as string | number)`** —— 这里用了一个 `as`。

**为什么需要？** 因为 `value` 是 `unknown`，而 `Array<string|number>.includes()` 要求参数是 `string | number`。

**这个 `as` 安全吗？**

**不安全。** 如果 `value` 是对象，`includes` 会返回 `false`（因为对象不在 enum 里），然后生成一条错误 —— **结果是正确的**。

**但严格说，用 `as` 是在骗编译器。** 更严谨的写法：

```ts
const candidate = typeof value === 'string' || typeof value === 'number' ? value : undefined
if (schema.enum !== undefined && (candidate === undefined || !schema.enum.includes(candidate))) {
```

**为什么我们没这么写？** 因为**结果一样**（非 string/number 一定不在 enum 里），而上面的写法更啰嗦。

**这是"结果正确但表达不够严谨"的取舍** —— 要写进 L9 吗？

**不必** —— 因为它不会导致错误行为。**但要意识到它的存在**，因为这正是"什么时候可以放松"的边界案例。

**`JSON.stringify` 包住每个取值**：

```ts
schema.enum.map((item) => JSON.stringify(item)).join(' / ')
// → '"low" / "high"'
```

**为什么包引号？** 因为**要让模型看清"这是个字符串"**：

```
参数.level 只能是 "low" / "high"，实际是 "medium"
```

对比不包引号：

```
参数.level 只能是 low / high，实际是 medium
```

**第一种更容易被理解为"取值"，第二种容易被理解为"描述文字"。**

#### 这个函数的复杂度

**它是本篇最复杂的函数（40 行），但结构只有 4 块。** 复杂性来自**递归** —— 理解递归的关键是：

> **不要试图在脑子里展开每一层。只看"这一层做什么"，假设"递归调用会正确完成它的工作"。**

具体到这里：**这一层负责"检查当前这个值的类型 + 如果是容器就检查它的每个子项"**，而"子项怎么检查"由递归负责。

**这叫"递归信任"。** 是理解递归最重要的思维方式。

---

### 3.9 `validateArgs`（第 172–175 行）

```ts
/** 校验一组调用参数。 */
export function validateArgs(schema: JsonSchema, args: Record<string, unknown>): string[] {
  return validateValue(schema, args, '参数')
}
```

**三行的包装函数。存在的理由只有一个：把初始路径固定成 `参数`。**

```ts
// 用包装
validateArgs(schema, args)                       // 错误信息：参数.path 期望...

// 不用包装
validateValue(schema, args, '参数')              // 每个调用方都要记得传这个字符串
```

**如果把它内联，每个调用点都要写 `'参数'`** —— 一旦有人写成 `'arguments'` 或 `'params'`，错误信息的格式就不一致了。

**这叫"把约定的细节收口到一个地方"。**

---

### 3.10 `truncate`（第 181–191 行）

```ts
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = Math.floor(limit * 0.8)
  const tail = limit - head
  const removed = text.length - limit
  return `${text.slice(0, head)}\n\n...（中间省略 ${removed} 个字符）...\n\n${text.slice(text.length - tail)}`
}
```

**逐行**：

```ts
if (text.length <= limit) return text
```

**快路径**：不超限就原样返回（**不复制、不修改**）。

```ts
const head = Math.floor(limit * 0.8)
const tail = limit - head
```

**`Math.floor` 必要吗？** `limit * 0.8` 可能是小数（比如 `200 * 0.8 = 160` 是整数，但 `201 * 0.8 = 160.8`）。`slice` 接受小数会自动取整，但**显式 `Math.floor` 让意图清楚，且保证 `head + tail === limit` 精确成立**。

```ts
const removed = text.length - limit
```

**算的是"丢掉多少"**，用于省略提示。

```ts
return `${text.slice(0, head)}\n\n...（中间省略 ${removed} 个字符）...\n\n${text.slice(text.length - tail)}`
```

**注意尾部用 `text.length - tail` 而不是 `-tail`**：

```ts
text.slice(-tail)              // ← 也能工作（负索引表示从末尾数）
text.slice(text.length - tail) // ← 我们用的写法
```

**两者等价**，但第二种**显式**（读者不用知道"负索引"这个规则）。

**这种"显式优于隐式"的选择贯穿整个项目。**

---

### 3.11 `ToolSchema`（第 197–205 行）

```ts
/** 发给模型的工具声明（OpenAI 兼容的线格式）。 */
export interface ToolSchema {
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: JsonSchema
  }
}
```

**这就是第 1 步说的"wire format"在工具侧的对应物。**

**为什么不复用 `Tool`？**

因为 `Tool` 有 `handler`，而 **`handler` 绝不能发给模型**：

```ts
// 如果直接把 Tool 发给模型
JSON.stringify({ name, description, parameters, handler, maxOutputChars })
//                                          ▲ 函数 —— 序列化后会丢失或报错
//                                                       ▲ 内部配置，模型不需要知道
```

**所以必须有一个"只包含该发出去的部分"的类型。**

**对比第 1 步的 `toWireMessages`**：那里是"翻译"，这里是"裁剪 + 重命名"。

| | 第 1 步 | 第 2 步 |
|---|---|---|
| 转换函数 | `toWireMessages()` | `ToolRegistry.schemas()` |
| 做了什么 | 字段改名（camelCase → snake_case） | **挑选字段**（丢掉 handler） |
| 共同点 | **厂商/协议细节只出现在一处** | 同 |

**`type: 'function'` 是字面量类型**（不是 `string`）—— 因为它目前只有一个合法值。这可以防止写成 `'func'`。

---

### 3.12 `ToolRegistry` 的五个方法（第 216–252 行）

```ts
export class ToolRegistry {
  #tools = new Map<string, Tool>()

  register(tool: Tool): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`工具名重复："${tool.name}" 已经注册过了`)
    }
    this.#tools.set(tool.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name)
  }

  list(): readonly Tool[] {
    return [...this.#tools.values()]
  }

  names(): string[] {
    return [...this.#tools.keys()]
  }

  schemas(): ToolSchema[] {
    return this.list().map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
  }
}
```

#### `#tools = new Map<string, Tool>()` —— 内联初始化

**在字段声明处直接初始化**，不需要写构造函数。

**为什么用 `Map` 而不是普通对象 `{}`？**

| 特性 | `Map` | 普通对象 |
|---|---|---|
| 键的类型 | 任意 | 只能是 string/symbol |
| 顺序 | **保证插入顺序** | 大部分情况保证，但不规范 |
| 原型污染 | 无 | `__proto__` 等键有风险 |
| 大小 | `.size` | `Object.keys().length` |

**`names()` 和 `list()` 依赖插入顺序**（"按注册顺序"），所以 `Map` 更可靠。

**原型污染**这条也实际：如果工具名叫 `constructor`，普通对象会出问题。

#### `register` 为什么抛错而不是返回布尔

```ts
throw new Error(`工具名重复："${tool.name}" 已经注册过了`)
```

**这是"编程错误"而不是"运行时错误"。**

| 类型 | 例子 | 处理方式 |
|---|---|---|
| **编程错误** | 注册了同名工具 | **抛异常**（应该在上线前发现） |
| **运行时错误** | 模型给了坏参数 | **返回 fail 结果**（日常情况） |

**DSH 的规范把这条写得很明确**：「Misconfiguration fails loud at load when self-contained」。

**注册是装载期的事，所以它"自包含"（不依赖外部输入）→ 应该立刻失败。**

#### `list()` 为什么返回副本

```ts
list(): readonly Tool[] {
  return [...this.#tools.values()]
}
```

**`[...map.values()]` 把 Map 的值迭代器转成数组。**

**为什么必须转？** 因为 `Map.values()` 返回的是**迭代器**，不是数组 —— 它**只能遍历一次**，而且**反映了 Map 的实时状态**。

**如果直接返回迭代器**：

```ts
const tools = registry.list()      // 拿到迭代器
registry.register(another)          // 注册新工具
for (const t of tools) { }          // ← 遍历时可能包含新注册的（取决于实现）
```

**返回快照数组**，语义清晰：**"这是你调用那一刻的全部工具"**。

**`readonly Tool[]` 的类型标注**：告诉调用方"别改这个数组"（改了也不会影响内部，但会让人困惑）。

#### `schemas()` 的位置

**注意它是从 `list()` 构造的，不是直接遍历 `#tools`。**

```ts
schemas(): ToolSchema[] {
  return this.list().map(...)      // ← 复用了 list()
}
```

**好处**：如果将来 `list()` 加了过滤逻辑（比如"排除被禁用的工具"），`schemas()` 自动继承。

**这叫"让方法之间形成层次"，避免多处重复同一逻辑。**

---

### 3.13 `ToolRegistry.execute()`（第 254–282 行）

前面 L1 的 1.5 节已经讲过结构。这里补充**两个实现细节**。

#### 细节 1：未知工具的错误信息里列出全部可用工具

```ts
const known = this.names().join(', ')
return fail(`未知工具 "${name}"。可用工具：${known === '' ? '(无)' : known}`)
```

**`known === '' ? '(无)' : known`** —— 处理"一个工具都没注册"的情况。

**如果不处理**，错误信息会是：

```
未知工具 "x"。可用工具：
```

**一个悬空的冒号**，看起来像 bug。写 `(无)` 明确表达"确实没有"。

**这类"空集合的显示"是容易被忽略的细节**，但它出现在每个错误路径上。

#### 细节 2：执行结果也要过一遍 `truncate`

```ts
const result = await tool.handler(args, ctx)
const limit = tool.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
return { content: truncate(result.content, limit), isError: result.isError }
```

**注意：`truncate` 在 `execute` 里做，不在工具里做。**

**为什么？**

| 位置 | 好处 | 坏处 |
|---|---|---|
| 在 `execute` 里（我们选的） | **所有工具自动获得截断**，工具作者不用管 | 工具无法自己控制（除了 `maxOutputChars`） |
| 在工具里 | 工具能定制 | **每个工具都要记得写** → 一定会有人忘 |

**这是"把横切关注点放在统一入口"的应用。** 第 10 步的守卫、审批、超时，都会用同样的思路挂在 `execute` 上（那时它会变成一个真正的管线）。

**注意 `isError` 被原样保留**：

```ts
return { content: truncate(...), isError: result.isError }
```

**截断不改变"成功/失败"的判定。** 一个成功的超长输出，截断后仍然是成功。

**这里有个真实的隐患**：如果失败信息本身超长，截断可能把关键的失败原因切掉……

**但我们的 `truncate` 保留尾部 20%** —— 而失败原因通常在末尾。**这个设计在这里恰好救了场。**

**这不是巧合** —— 它是"留尾巴"这个决策的第二个收益（第一个是便于人阅读）。

---

### 3.14 `builtin-tools.ts` 的三个工具（简讲）

具体工具的实现比较直白，只讲**三个值得注意的设计**。

#### 设计 1：`resolveInsideWorkspace` 是所有工具共用的

```ts
function resolveInsideWorkspace(ctx: ToolContext, raw: unknown): string {
  const input = typeof raw === 'string' ? raw : String(raw ?? '.')
  const absolute = resolve(ctx.workspace, input)
  const rel = relative(ctx.workspace, absolute)
  if (rel === '') return absolute
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`路径越权：${JSON.stringify(input)} 不在工作目录内`)
  }
  return absolute
}
```

**它在 `builtin-tools.ts` 里，不在 `tools.ts` 里。**

**为什么？** 因为**它是一条"策略"，不是"框架"**：

- 框架（`tools.ts`）不知道"工作目录"这个概念对工具意味着什么
- 策略（`builtin-tools.ts`）决定"这些工具必须限制在工作目录内"

**第 10 步会把这个策略提升为"守卫"** —— 那时它从"每个工具内部调用"变成"统一挂在执行前"。**这就是"策略从实现里抽出来"的演进路径。**

#### 设计 2：`read_file` 为什么带行号

```ts
const numbered = shown
  .map((line, index) => `${String(index + 1).padStart(4, ' ')}│ ${line}`)
  .join('\n')
```

**`String(index + 1).padStart(4, ' ')`** 把行号右对齐到 4 位：

```
   1│ 第一行
  12│ 第十二行
 999│ ...
```

**`padStart(4, ' ')`** 是 ES2017 的字符串方法：**不够 4 位就在左边补空格。**

**为什么必须带行号？**

因为**后面的改写工具要靠行号定位**。模型说"改第 12 行"，必须能找到它。

**这是"读"和"写"之间的接口约定** —— 一个典型的"接口设计"细节：**读的格式决定了写能怎么做。**

（DSH 的 `str-replace-editor` 用的是 `old_string` 精确匹配而不是行号，因为行号在文件被改动后会失效。**两种设计各有代价**：行号易读但脆弱，字符串匹配稳健但要求模型抄准。这可以作为一个挑战题。）

#### 设计 3：`write_file` 用 `TextEncoder` 算字节数

```ts
const bytes = new TextEncoder().encode(content).byteLength
return ok(`已写入 ${String(args.path)}（${bytes} 字节）`)
```

**为什么不用 `content.length`？**

因为 `content.length` 是**字符数**，而中文字符在 UTF-8 下占 3 个字节：

```
'你好'.length                      // 2（字符数）
new TextEncoder().encode('你好').byteLength   // 6（字节数）
```

**报"字节数"比"字符数"更有信息量**（它反映真实写入量、磁盘占用、以及部分 API 的限制）。

**为什么不直接用 Node 的 `Buffer.byteLength()`？**

因为 **`Buffer` 是 Node 专有的类型**，需要 `@types/node` 才有类型。而 `TextEncoder` 是 **Web 标准**，在所有 JS 运行时里都有。

**这个选择让 `builtin-tools.ts` 少依赖一个类型包。** 对教学项目（零依赖）来说值得。

---

**到此，`tools.ts` 的 282 行和 `builtin-tools.ts` 的关键部分已经讲完。**

---

## L4 运行与验证

### 4.1 怎么运行

```powershell
cd D:\agent-harness-lab
node src/demos/demo-tools.ts
```

**会在系统临时目录里真实读写文件**，路径会打印出来，随时可删。

### 4.2 六组演示逐条解读

#### 演示 1 · 模型能看到什么

```
--- 模型能看到哪些工具 ---
[ "read_file", "write_file", "list_dir", "big_output", "set_level" ]
```

**要观察的**：**三个是内置工具，两个是演示专用**（`big_output` 测截断、`set_level` 测 enum）。

**这个观察引出一个系统问题**：演示专用的工具和真实工具**混在同一张表里**。第 5 步的 scope 就是解决"不同场景看不同工具"的。

#### 演示 2 · 正常执行链

```
list_dir 空目录      → (空目录)
write_file 写文件    → 已写入 notes/hello.txt（30 字节）
list_dir 再列一次     → notes/
read_file 读回来      →    1│ 第一行
                          2│ 第二行
                          3│ 第三行
                          4│ 
```

**要观察三件事**：

| 观察 | 说明 |
|---|---|
| 空目录显示 `(空目录)` | 不是空白 —— 明确的信号 |
| 写入报的是**字节数**（30） | `'第一行\n第二行\n第三行\n'` 的 UTF-8 字节数 |
| 读回来**带行号** | 为后续改写工具预留的接口 |

**第 4 行是空行** —— 因为原始内容以 `\n` 结尾，`split('\n')` 会产生一个尾部空串。**这是正确的**（文件确实有 4 行，最后一行是空的）。

#### 演示 3 · 四种调用错误

```
未知工具 "delete_everything"。可用工具：read_file, write_file, list_dir, big_output, set_level
参数.path 是必填字段，但没有提供
参数.path 期望 string，实际是 number
参数.level 只能是 "low" / "high"，实际是 "medium"
```

**四种错误，四种不同的"修正方向"**：

| 错误 | 模型应该学会什么 |
|---|---|
| 未知工具 | "我编的，**真实的叫这些名字**" |
| 缺必填 | "我漏了 `path`" |
| 类型错 | "我给的是数字，**要字符串**" |
| 取值越界 | "`medium` 不在允许集合里，**只有 low/high**" |

**注意 `isError: true` 但程序没崩** —— 这正是 1.5 节的设计。

#### 演示 4 · 越权路径（**最重要的一组**）

```
工具 read_file 执行失败：Error: 路径越权："../../../Windows/win.ini" 不在工作目录内
```

**要观察的三件事**：

1. **工具内部抛了异常**（`resolveInsideWorkspace` 抛的）
2. **注册表捕获了它**，转成 `isError: true`
3. **agent 没崩**

**这验证了"分层错误处理"**：内层用异常，最外层统一转成返回值。

**同时它验证了安全防线的有效性** —— 模型无法读到工作目录之外。

#### 演示 5 · 截断

```
--- 输出长度（字符） ---
224

--- 被截断后的样子 ---
行行行...行 ... 行行行行
```

**224 = 160（头）+ 24（省略提示）+ 40（尾）** —— 前面 1.6 节算过。

**要观察的**：**省略提示里写了"300 个字符"**，而不是含糊地说"省略了一部分"。

#### 演示 6 · 重名注册被拒绝

```
工具名重复："read_file" 已经注册过了
```

**注意它是 `throw`（不是 `fail`）** —— 演示里用 `try/catch` 捕获。

**为什么注册冲突抛异常而不是返回失败结果？** 见 3.12 的"编程错误 vs 运行时错误"。

### 4.3 验收判据

| # | 判据 | 怎么验证 |
|---|---|---|
| 1 | 六组演示全部跑通，输出符合上述描述 | 运行 |
| 2 | 演示 3 的四种错误信息**都能指出"实际是什么"** | 看输出 |
| 3 | 演示 4 里工具抛异常但 agent 未崩 | 看 `isError: true` |
| 4 | 演示 5 的输出长度 = 224 | 看输出 |
| 5 | 你能解释"为什么校验失败要返回全部问题" | 口述 |
| 6 | 你能解释"为什么 `execute` 里没有 `throw`" | 口述 |
| 7 | 你能解释"`args` 为什么不用泛型" | 口述 |
| 8 | **关掉文档**能写出 `Tool` 接口和 `ToolRegistry.execute` 的骨架 | 见 L6 |

---

## L5 语法速查（本篇新增）

> 第 1 步的语法在 [`01-llm.md`](01-llm.md#l5-本篇-typescript-语法速查) 里，这里只列**本篇新出现的**。

| 语法 | 例子 | 含义 | 注意 |
|---|---|---|---|
| **类型谓词** | `value is Record<string, unknown>` | 告诉编译器"返回 true 时它是什么类型" | 写在函数**返回类型**的位置 |
| **索引访问类型** | `JsonSchema['type']` | 取某个属性的类型 | 单一来源，不会不一致 |
| **递归类型** | `properties?: Record<string, JsonSchema>` | 类型引用自己 | TS 原生支持 |
| `never` | `assertNever(value: never)` | 不可能存在的值 | 用于穷尽检查 |
| `Map` | `new Map<string, Tool>()` | 键值对表 | 保证插入顺序 |
| `map.values()` | 返回迭代器 | 遍历值 | **只能遍历一次**，要用 `[...]` 转数组 |
| `Object.entries()` | `[['a', 1], ['b', 2]]` | 对象转键值对数组 | 配合解构 |
| `Array.entries()` | 返回 `[索引, 元素]` 迭代器 | 带索引遍历 | 数组专用 |
| **展开到函数参数** | `problems.push(...arr)` | 把数组展开成多个参数 | 数量大时慎用 |
| `??=` / `??` | `schema.required ?? []` | 空值合并 | 只在 null/undefined 时用右边 |
| `padStart` | `'1'.padStart(4, ' ')` | 左侧补字符 | `'   1'` |
| `join` | `arr.join(' / ')` | 数组转字符串 | |
| `String(x)` | `String(index + 1)` | 转字符串 | 比 `x.toString()` 安全（null/undefined 也work） |
| `Number.isFinite` | 排除 NaN/Infinity | | |
| `Number.isInteger` | 排除小数 | | |
| 类型断言 `as` | `value as string \| number` | 强行指定类型 | **运行时无检查** |

### 本篇新增的三条规则

**规则 7：类型谓词必须写在返回类型位置**

```ts
function isRecord(v: unknown): v is Record<string, unknown> { ... }   // ✅
function isRecord(v: unknown): boolean { ... }                        // ❌ 收窄失效
```

**规则 8：`Map.values()` 返回迭代器，不是数组**

```ts
const values = map.values()
values.length          // ❌ 迭代器没有 length
[...map.values()]      // ✅ 先转数组
```

**规则 9：回调函数里的类型收窄会失效**

```ts
if (schema.items !== undefined) {
  // 在这里 schema.items 是 JsonSchema
  for (const item of arr) {
    validateValue(schema.items, item, path)   // ⚠️ 在某些情况下会被判回 undefined
  }
}
// 安全写法：提前取出
const itemSchema = schema.items    // ← 类型被钉死
```

**原因**：TS 不知道 `schema.items` 在循环期间会不会被改（比如被别的代码改）。**提前取到 `const` 就消除了这种可能性。**

---

## L6 关文档重写判据

### 必须能写出的部分

| 难度 | 要写的东西 | 通过标准 |
|---|---|---|
| ★ | `ToolResult` + `ok`/`fail` | 两行函数也要写对 |
| ★ | `Tool` 接口 | 五个字段，`handler` 签名要准 |
| ★★ | `JsonSchema` | 6 个关键字，`properties` 要递归 |
| ★★ | `truncate` | **头 80% 尾 20%**，省略提示含字符数 |
| ★★★ | `isRecord` 类型谓词 | **三个判断缺一不可** |
| ★★★ | `matchesType` + `assertNever` | switch 覆盖 6 种，末尾用 `assertNever` |
| ★★★★ | `validateValue` | **四个检查块 + 提前返回 + 递归路径拼接** |
| ★★★★ | `ToolRegistry.execute` | **三条失败路径全部返回 `fail`** |

### 卡住时的自检问题

| 卡在哪 | 问自己 |
|---|---|
| `validateValue` | "如果类型都不对还要继续检查子字段吗？" |
| `isRecord` | "`typeof null` 是什么？`typeof []` 是什么？" |
| `execute` 的错误处理 | "工具失败之后，agent 应该继续跑还是停下来？" |
| `truncate` | "报错信息通常在哪一段？" |
| `Tool` 的 `args` 类型 | "参数是编译期就知道的还是运行时才拿到的？" |

### 分级判定

| 程度 | 判定 |
|---|---|
| 能写出 ★★ 及以下 | 不够 L3，重读 3.1–3.7 |
| 能写出 ★★★ | 接近 L3，重点补 `validateValue` |
| 全部写出（允许小错） | ✅ **达标** |

---

## L7 挑战题（不给答案）

### 挑战 1 · 实现 `sideEffect` 字段

按 0.3 节和 1.8 节的设计，给 `Tool` 加 `sideEffect` 字段。

**要求**：

1. 加类型定义
2. 给三个内置工具标注正确的值
3. 在 `ToolRegistry.execute()` 里加一条检查：`irreversible` 的工具**默认拒绝执行**（模拟"必须审批"）
4. 演示能展示"读文件放行、写文件警告、不可逆工具被拒"

**思考**：`write_file` 你标成 `reversible` 还是 `irreversible`？**你的理由是什么？这个选择会让用户体验变好还是变差？**

### 挑战 2 · 加一个数值范围校验

给 `JsonSchema` 加 `minimum` / `maximum`，并在 `matchesType` 之后加检查。

**要求**：

1. 类型定义加两个字段
2. `validateValue` 里加检查（记住：**只在类型正确时才检查**）
3. 错误信息格式：`参数.count 最小是 1，实际是 0`

**思考**：这会让 `matchesType` 和 `validateValue` 的职责边界变模糊吗？要不要单独一个 `validateRange`？

### 挑战 3 · 处理"多余字段"

现在模型给了 `{ path: 'a.txt', extra: 1 }`，多余字段被**静默忽略**。

**问题**：

1. 改成报错会怎样？（考虑：模型有时会加它"以为需要"的字段）
2. 改成警告（在结果里提示一句）会怎样？
3. 三种策略各自的**代价**是什么？

**思考**：这和第 1 步 `parseArguments` 对数组的宽松处理，是不是同一类问题？

### 挑战 4 · 设计"工具超时"

某个工具可能跑很久（比如 `bash` 执行一条慢命令）。

**问题**：

1. 超时应该在哪一层实现？（工具内部 / `execute` 里 / 包一层 wrapper）
2. 超时后应该**中断**正在跑的工具，还是只**返回超时结果**让它继续跑？
3. 如果中断，怎么让工具知道要停？（提示：第 1 步学过 `AbortSignal`）

**这是第 10 步 `tools/execute` 环绕的预演。**

### 挑战 5 · 对比行号 vs 字符串匹配

`read_file` 现在返回**带行号**的内容。

**问题**：如果后续要做一个"改动第 N 行"的工具，用行号定位有什么风险？DSH 的 `str-replace-editor` 用"旧字符串精确匹配"，代价是什么？

**这道题没有标准答案，但你的分析会决定第 10 步要不要做改写工具。**

---

## L8 自检清单

### 理解层（L1）

- [ ] 我能说出"一个工具 = 四样东西"，以及缺每样的后果
- [ ] 我能解释 `description` 是写给**模型**看的，并举例说明它怎么影响行为
- [ ] 我能说出 JSON Schema 我们用了哪 6 个关键字、砍掉了什么
- [ ] 我能解释"类型不对就不往下挑了"为什么是必要的
- [ ] 我能解释 `assertNever` 的穷尽检查原理
- [ ] 我能说出"失败不是异常"的三个理由
- [ ] 我能解释截断为什么留尾巴
- [ ] 我能解释 `args` 为什么用 `Record<string, unknown>` 而不是泛型
- [ ] 我能说出 `ToolContext` 为什么打包成一个对象
- [ ] ★ 我能复述 `sideEffect` 这个字段是怎么被提出来的

### 实现层（L3）

- [ ] 我关掉文档写出了 `Tool` 接口
- [ ] 我关掉文档写出了 `isRecord`（三个判断全对）
- [ ] 我关掉文档写出了 `validateValue` 的四个检查块
- [ ] 我关掉文档写出了 `ToolRegistry.execute` 的三条失败路径
- [ ] 我能解释为什么 `execute` 里的 `truncate` 不放在工具内部

### 语法层

- [ ] 我会写类型谓词（`value is T`）
- [ ] 我知道 `Map.values()` 返回迭代器
- [ ] 我知道回调里的类型收窄会失效、要用 `const` 提前取出
- [ ] 我会用 `Object.entries()` 和 `Array.entries()`

### 系统层（L4）

- [ ] 我能说出改 `ToolResult` 会影响哪几步
- [ ] 我能说出如果不加 `sideEffect`，第 10 步会遇到什么困难
- [ ] 我能说出"参数校验"和"路径校验"分别在防什么

---

## L9 仍未解决

### 会被后续步骤解决的

| 遗留问题 | 哪一步 |
|---|---|
| 没有循环去驱动"执行 → 回灌 → 再请求" | 第 8 步 |
| 工具集全局共享，无法按 agent 裁剪 | 第 5 步 |
| 没有超时：工具卡住就永远卡住 | 第 10 步 |
| 没有审批：危险操作直接执行 | 第 10 步 |
| 路径校验写在工具内部，无法统一策略 | 第 10 步（提升为守卫） |
| 工具是硬编码 import，不是插件 | 第 3、6 步 |
| 没有并行：多个工具调用只能顺序执行 | 第 8 步 |

### 当前实现的真实缺陷

#### 缺陷 1：`sideEffect` 字段尚未实现 ★

```ts
export interface Tool {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchema
  readonly handler: ...
  readonly maxOutputChars?: number
  // sideEffect 在哪？ ← 没有
}
```

**后果**：第 10 步的守卫**无法判断**哪些工具需要事前拦截，只能靠硬编码工具名白名单。

**修法**：见挑战题 1。

**为什么不现在改**：因为它是"设计先行"的产物 —— 我在写文档时才发现这个缺口。**代码要等设计稳定后再改。**

#### 缺陷 2：`sideEffect` 的缺省值是宽松的

即使实现了，`sideEffect?: SideEffect` 缺省是 `'none'`（**最不安全的那一档**）。

**后果**：将来接入第三方工具时，忘记声明 = 被当作安全的。

**修法**：缺省改 `'irreversible'`（保守），或者**强制必填**。

**为什么当初选宽松**：教学项目、工具少、都是自己写的。**但这个理由在接入第三方时不成立。**

#### 缺陷 3：`validateValue` 对 enum 的类型断言不严谨

```ts
if (schema.enum !== undefined && !schema.enum.includes(value as string | number)) {
```

`value as string | number` 是**骗编译器**（`value` 可能是对象）。

**后果**：**行为正确**（对象一定不在 enum 里），但表达不严谨。

**修法**：先收窄再判断。

**为什么不修**：结论相同，且更啰嗦。**但你要知道它在那里。**

#### 缺陷 4：`resolveInsideWorkspace` 用 `throw` 而不是返回失败

```ts
if (rel.startsWith('..') || isAbsolute(rel)) {
  throw new Error(`路径越权：${JSON.stringify(input)} 不在工作目录内`)
}
```

**后果**：每次调用都要走 `execute` 里的 `try/catch`。**性能上可忽略，但语义上"异常"被用于正常流程控制。**

**另一种观点**：这正是"分层错误处理"的正确用法 —— 内层表达"我这里出问题"，外层统一转换。

**这是风格争议，不是 bug。** 但要意识到：**如果第 10 步的管线里有多个环节都靠 `catch` 转换，异常就变成了"控制流交通工具"。** 那时应该改成显式返回值。

#### 缺陷 5：没有区分"工具本来就没结果"和"工具失败了"

```ts
read_file 读到一个空文件 → ok('')     // isError: false
read_file 读一个不存在的文件 → fail('ENOENT...')  // isError: true
```

**这个区分是清楚的。** 但考虑另一种情况：

```
list_dir 列一个空目录 → ok('(空目录)')   // 我们造的字符串
```

**`(空目录)` 是"内容"还是"状态提示"？** 它被当作 `content` 返回给模型 —— 模型可能把它当成"目录里有个叫 (空目录) 的东西"。

**更好的设计**可能是给 `ToolResult` 加一个 `kind: 'content' | 'notice' | 'error'` 字段。

**这是"用一个布尔值表达三态"的典型问题** —— `isError: boolean` 只有两态，但我们实际有三种情况。

**DSH 的处理**：它的工具结果有更丰富的结构（`ToolResult` 带 `content` 块数组 + 各种元数据）。

**为什么不现在改**：两态够用，加三态会让所有工具实现变复杂。**记下它。**

---

## L10 提问训练

### 本篇引出的 12 个好问题

**关于设计（L3 层）**

1. 为什么 `ToolResult` 只有 `content` 和 `isError` 两个字段？
2. 为什么 `ok`/`fail` 要单独抽成函数，而不是到处写对象字面量？
3. 为什么 `execute()` 里没有 `throw`，而 `resolveInsideWorkspace` 里却抛异常？
4. 为什么 `truncate` 放在 `execute` 里而不是每个工具内部？
5. 为什么 `ToolContext` 只有一个字段，却要打包成对象？

**关于系统（L4 层）**

6. 加 `sideEffect` 之后，第 10 步的守卫逻辑长什么样？
7. 如果第 5 步要做 scope 隔离，`ToolRegistry` 需要改哪里、怎么改？
8. 如果第 8 步要并行执行多个工具调用，`execute()` 是线程安全的吗？
9. `validateArgs` 的错误信息格式被第 8 步回灌给模型 —— 这个格式算"接口"吗？改它会影响什么？

**关于科研（L5 层）**

10. 如何用"参数校验失败率"作为"模型工具使用能力"的一个指标？
11. **干预实验里，A/B/C 三类失败在工具层的表现分别是什么？**
12. **`sideEffect` 这个字段能否用来构造"可逆性梯度"的实验？**（同一批任务，只改变工具的不可逆程度）

### 问题升级练习

| 模糊问题 | 精确问题 | 提升在哪 |
|---|---|---|
| "为什么校验这么麻烦？" | "如果我把参数校验从 `execute` 里去掉，只在工具内部检查，最终的错误信息会变成什么样？" | 指出了**替代方案的具体后果** |
| "`sideEffect` 有什么用？" | "没有 `sideEffect` 时，第 10 步的守卫要靠什么判断该不该拦截？那种做法在什么情况下会失效？" | 指出了**替代方案 + 失效条件** |
| "工具失败为什么不能抛异常？" | "如果 `execute` 抛异常，第 8 步的循环需要在哪里捕获才能在崩溃前把失败**写进会话日志**？这样改的代价是什么？" | 加上了**具体场景和代价** |

> ### 你的练习
>
> 挑一个改写，发给我：
>
> 1. "`isError` 为什么不多几种状态？"
> 2. "为什么 `name` 的唯一性不写在类型里？"
> 3. **"`sideEffect` 到底解决了什么问题？"**

---

## L11 系统影响回溯

### 11.1 三个预判的检验

| 第 0.5 节的问题 | 现在你应该能答的 |
|---|---|
| 为什么 `tools.ts` 不碰 IO？ | 因为"框架"要能在无文件系统的情况下测试；工具是"插件"，各自管自己的 IO |
| 校验是"挡住"还是"教会模型"？ | **主要是教会**。挡住只是副作用 —— 错误信息里"实际是 number"对模型才有价值 |
| 空文件结果 `isError` 该是什么？ | **`false`** —— 它成功了，只是内容为空。但见 L9 缺陷 5：两态表达不够 |

### 11.2 本篇的"锚点"一句话

> **模型给的参数一律不可信 —— 校验它，并且把"为什么不合格"说清楚，让它自己改。**

这句话在后面的影子：

| 哪一步 | 同一思想的再现 |
|---|---|
| 第 1 步 | `parseError` —— 同一套"说清原因让模型改" |
| 第 7 步 | 落盘的消息要能被校验（因为从文件读回来 = 又一次跨边界） |
| 第 10 步 | 守卫 + 审批 —— 校验升级为**可插拔的策略** |
| 第 15 步 | **失败归因** —— "说清为什么失败"推到任务层 |

### 11.3 通向第 3 步的桥

**第 2 步结束时，系统状态：**

```
✅ 能跟模型说话
✅ 能校验并执行工具
❌ 但所有东西还是硬连线的：new ToolRegistry()、new DeepSeekProvider()
❌ 没有循环去驱动"执行 → 回灌 → 再请求"
❌ 工具集全局唯一，无法按场景裁剪
```

**第 3 步要解决"硬连线"。** 带着这些问题进入：

1. 如果 `retry` 插件想插手"模型请求失败"，它需要改哪里的代码才能做到？**能不改循环做到吗？**
2. 如果两个 agent 需要不同的工具集，`ToolRegistry` 现在的设计够吗？
3. 卸载一个功能，怎么保证它注册的东西**全部**被撤销？

**第 3 步的答案是"插件容器"，而那个容器的核心机制（服务归属 + 撤销）正是为了回答第 3 个问题。**

---

## 本篇完结

| 检查项 | 应该达到 |
|---|---|
| 能说出"一个工具 = 四样东西" | L1 |
| 能解释 `args` 为什么不用泛型 | L1 |
| 能说出 `sideEffect` 是怎么被提出来的 | L1 + 系统思维 |
| **能关掉文档写出 `validateValue`** | **L3** |
| **能关掉文档写出 `execute` 的三条失败路径** | **L3** |
| 能说出加 `sideEffect` 会波及哪几步 | L4 |
| 能提出至少 3 个 L4/L5 层的问题 | L4 |

---

**读完这篇，请回答我三个问题：**

1. **粒度**：L3 的 3.8 节（`validateValue` 逐行）和 3.13 节（`execute` 逐行），密度合适吗？
2. **`sideEffect`**：你觉得它应该**必填**还是**可选 + 默认值**？为什么？
3. **下一站**：你想先看 `03-context.md`（继续按顺序），还是 `07-session.md`（你科研里最需要的会话日志）？
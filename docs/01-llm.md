# 第 1 步 · 模型层

> **代码**：`src/kernel/llm.ts`（419 行） · **演示**：`src/demos/demo-llm.ts`（170 行）
> **DSH 对应**：`packages/llm/llm/src/`（`ctx.llm` 服务）· `packages/llm/llm-deepseek/`
> **本篇目标级别**：L3（关掉文档能从零重写）
> **预计阅读**：60–90 分钟 · **预计动手**：60 分钟

---

## 本篇新词

> 全部 118 个术语在 [`glossary.md`](glossary.md)。第一次读到这里，先花 90 秒扫一遍。

| 词 | 一句话 | 为什么必须懂 |
|---|---|---|
| **LLM** | 大语言模型。对我们来说它**只是一个 HTTP 接口**：发一段文本，回一段文本 | 不懂这个，就会以为模型"记得"上一轮 |
| **prompt（提示词）** | 发给模型的那一整段输入。不只是用户那句话 | 它包含系统设定、全部历史、工具说明书 |
| **completion（补全）** | 模型给出的回应 | 所有结果都从这里取 |
| **role（角色）** | 消息身份：`system` / `user` / `assistant` / `tool` | 拼错角色服务端直接 400 |
| **Provider** | 对"模型服务"的抽象接口 | 换厂商不用改代码，全靠它 |
| **Adapter** | Provider 的具体实现类 | DeepSeekProvider 就是 DeepSeek 的 Adapter |
| **function calling** | 模型不回答，而是说"请调用 `read_file`，参数是…" | **agent 能做事的唯一机制** |
| **wire format（线格式）** | 真正在网络上传输的 JSON 长什么样 | 内部结构 vs 传输格式必须分开 |
| **token（词元）** | 模型眼里的"一个字"，也是计费与长度单位 | "上下文超限"和"花了多少钱"靠它 |
| **usage（用量）** | 一次调用消耗的 token 统计 | 科研里必须记录的字段 |
| **temperature（温度）** | 控制随机性。0 最确定 | 做实验必须固定 |
| **seed（随机种子）** | 让随机性可复现的起点 | 不固定就无法复现实验 |
| **context window** | 模型一次能看的最大长度 | 长任务突然崩掉的原因 |
| **mock** | 假实现：按脚本返回，不联网不花钱 | 把"我的代码对不对"和"模型行不行"分开 |
| **streaming（流式）** | 一边生成一边吐字 | 本步**故意不做**，理由见 L2 |
| **ReAct** | 思考→调用工具→看结果→再思考 | 整个 agent 的形状 |
| **agent loop** | 把 ReAct 实现出来的那个 while 循环 | 项目的心脏 |
| **turn（轮次）** | 从收到用户输入到"没有欠账"的全过程 | 任务边界 |
| **step（步）** | 一次模型请求 + 它触发的工具调用 | 导师问的"平均完成步数"就是它 |
| **type erasure（类型擦除）** | Node 直接删掉 TS 类型标注后当 JS 跑 | 所以本课程零依赖、不用编译 |
| **ESM** | 现代 JS 模块系统（`import`/`export`） | 要 `"type": "module"` 才启用 |
| **async / await** | 异步等待：暂停本函数、让别的代码先跑 | 网络请求必须用它 |
| **Promise** | "未来会有个值"的凭据 | 带 await 的函数返回它 |

---

## 第 0 节 · 这一步的成品长什么样

### 0.1 最终你会写出什么

一个叫 `llm.ts` 的文件（419 行），它做三件事：

```
┌──────────────────────────────────────────────────────────────┐
│  llm.ts                                                      │
│                                                              │
│  ① 定义数据形状                                              │
│     消息是什么、工具调用是什么、响应是什么、错误怎么分类        │
│                                                              │
│  ② 定义接口                                                  │
│     Provider：一个 chat() 方法                               │
│                                                              │
│  ③ 给出两个实现                                              │
│     MockProvider      —— 按脚本返回，离线、免费、确定          │
│     DeepSeekProvider  —— 真实 HTTP 调用                       │
└──────────────────────────────────────────────────────────────┘
```

**它不认识 agent、不认识工具、不认识循环** —— 那些是后面 15 步的事。

### 0.2 运行起来是什么样

```powershell
node src/demos/demo-llm.ts
```

你会看到五组演示。其中最关键的输出片段：

```
--- 第 1 轮：模型要调用的工具 ---
[
  {
    "id": "call_0",
    "name": "read_file",
    "arguments": { "path": "src/llm.ts" },
    "rawArguments": "{\"path\":\"src/llm.ts\"}",
    "parseError": ""
  }
]

--- 坏参数时的 toolCall ---
{
  "id": "call_0",
  "name": "read_file",
  "arguments": {},
  "rawArguments": "{\"path\": \"src/llm.ts\",}",
  "parseError": "arguments 不是合法 JSON：Expected double-quoted property name in JSON at position 22"
}

--- 捕获到的 LLMError.code ---
EMPTY_RESPONSE
```

**注意第二段**：`arguments` 有**三份** —— 解析好的对象、原始字符串、失败原因。这是本步最重要的设计之一，后面会详细讲为什么。

### 0.3 这一步在整个课程里的位置

```
第 1 步（你在这里）        第 2 步              第 3 步
   模型层          ──►     工具层        ──►    ctx 容器
"能跟模型说话"           "能执行工具"        "能装插件"
       │
       │ ① 产出的类型（ChatMessage / ToolCall / LLMResponse）
       │    后面每一步都在用
       │
       │ ② 产出的错误分类（LLMErrorCode）
       │    第 9 步的重试策略直接建在它上面
       │
       │ ③ 产出的 Provider 接口
       │    第 3 步会把它挂成 ctx.llm 服务
       ▼
```

**这一步的三个产出会一直用到最后一步**，所以要学扎实。

---

## 第 0.5 节 · 系统视角：这一步在整台机器的哪个位置

> 这一节回答的不是"这一步做什么"，而是"**它凭什么必须存在**"。
> 每篇文档都有这一节。**读完 16 篇后，把这 16 节连起来读一遍，你会得到整台机器的图纸。**

### 你在哪里

```
                          ┌──────────────────────────────────────┐
                          │ ⑦ 入口层   apps/cli.ts （第 11 步）    │
                          └──────────────────┬───────────────────┘
                                             │ 启动
                          ┌──────────────────▼───────────────────┐
                          │ ⑥ 组合层   profile/bundle（第 6 步）   │
                          └──────────────────┬───────────────────┘
                                             │ 装载插件
        ┌────────────────────────────────────┼────────────────────────────────────┐
        ▼                                    ▼                                    ▼
┌──────────────────┐              ┌──────────────────┐              ┌──────────────────┐
│ ⑤ 框架层          │              │ 能力层            │              │ 进化层            │
│ ctx / 事件 / scope│◄────────────►│ session / loop   │◄────────────►│ memory / skill   │
│ （第 3–5 步）     │              │ retry / guard    │              │ diagnose / evolve│
│                  │              │ （第 7–10 步）    │              │ （第 12–16 步）   │
└────────┬─────────┘              └────────┬─────────┘              └────────┬─────────┘
         │                                 │                                 │
         └─────────────────────────────────┼─────────────────────────────────┘
                                           │  全都建立在它上面
                                           ▼
                    ┌──────────────────────────────────────────────┐
                    │  ★ 基础层（第 1–2 步）★                       │
                    │    模型层  src/kernel/llm.ts                  │
                    │    工具层  src/kernel/tools.ts                │
                    │    ▶ 你现在在这里 ◀                            │
                    └──────────────────────────────────────────────┘
```

**这张图告诉你一件重要的事**：第 1 步是**最底层**。上面所有层都在用它的产物。

**底层设计的错误，会被上面每一层放大。**

### 下游：谁在用你的东西（完整清单）

| 第 1 步的产物 | 谁消费 | 用来做什么 | 依赖强度 |
|---|---|---|---|
| `Provider` 接口 | 第 8 步 agent 循环 | 发请求 | 🔴 强依赖 |
| `ChatMessage` | 第 7 步会话日志 | 落盘 + 派生历史 | 🔴 强依赖 |
| `ToolCall` | 第 2 步工具注册表 | 按名字查表并执行 | 🔴 强依赖 |
| `ToolCall.rawArguments` | 第 8 步历史回灌 | 原样发回给服务端 | 🟡 弱（可退化） |
| `LLMResponse` | 第 7 步日志、第 15 步诊断 | 记录事实 + 归因 | 🔴 强依赖 |
| `LLMErrorCode` | **第 9 步重试策略** | **决定要不要重试** | 🔴 **强依赖** |
| `LLMError.retryAfterMs` | 第 9 步退避计算 | 更准的等待时间 | 🟡 弱（可退化） |
| `parseArguments` | 第 2 步参数校验 | 复用同一套解析 | 🟢 可选 |

**"依赖强度"这一列是系统思维的核心**：

- 🔴 **强依赖** = 改了它，下游必崩，必须同步改
- 🟡 **弱依赖** = 改了它，下游退化但不崩
- 🟢 **可选** = 下游可以不用

**任何时候你打算改一个类型或接口，先看这张表。**

### 连锁影响分析：三个"改错会炸到哪"的例子

这不是理论，是真实的传导链。

#### 连锁 1：如果 `ToolCall` 不存 `rawArguments`

```
ToolCall 少一个字段
   ↓
第 8 步回灌历史时，只能用 JSON.stringify(call.arguments) 重新生成
   ↓
生成的字符串与模型当初给的可能不一致（键顺序、空格、数字格式）
   ↓
服务端看到"和上次不完全一样的请求"
   ↓
KV cache 无法命中
   ↓
长对话的每次请求都全量计费 → 成本显著上升
```

**注意**：这个错误**不会报错、不会崩溃**。它只是悄悄让你多花钱。

**这类"沉默的成本型错误"是最难发现的** —— 也是为什么底层数据结构要多留一份原始信息。

#### 连锁 2：如果 `LLMErrorCode` 不区分 `AUTH`

```
错误分类里没有 AUTH
   ↓
第 9 步的重试策略把它放进可重试集合
   ↓
密钥错误 → 重试 5 次 → 全部失败
   ↓
每次重试都真的发出请求、真的计费
   ↓
浪费钱 + 浪费 30 秒 + 最终仍然失败
```

**更糟的情况**：如果第 9 步选了 `mode: always`（无限重试），**它会永远重试下去**。

**这就是为什么"错误分类"必须在这一步就做** —— 它不是"以后再说"的细节，而是重试策略的**唯一依据**。

#### 连锁 3：如果 `Provider` 不做抽象

```
只有 DeepSeekProvider，agent 循环直接调用它
   ↓
第 7 步：测试"日志能否正确派生消息"时，必须真的调 API
   ↓
第 15 步：做失败归因实验时，无法区分"失败是模型造成的"还是"我的循环造成的"
   ↓
实验结果不可复现（每次调用模型返回都不同）
   ↓
★ 你的科研结论站不住 ★
```

**这一条直接连到你的实际处境。** mock 不只是"测试方便"，它是**做对照实验的前提**。

### 现在就该建立的三个习惯

| 习惯 | 做法 | 训练什么 |
|---|---|---|
| **改前查下游** | 动一个类型前，先问"谁在用、依赖有多强" | 避免连锁破坏 |
| **区分"沉默的成本"和"响亮的错误"** | 前者要主动找（缓存失效、token 浪费），后者会自己报 | 发现隐性代价 |
| **问"如果这一层不存在，上层要怎么写"** | 反证这一层的存在价值 | 理解分层的必要性 |

> ### 停下来想一想（不给答案）
>
> 1. 如果去掉 `Provider` 接口，第 8 步的循环要怎么写，才能同时支持 mock 和真实调用？**先写出你的方案，第 3 步会给出它的答案。**
> 2. 上面那张"下游清单"里，哪个产物被最多的地方消费？为什么是它？
> 3. 三个连锁影响里，哪一个**不会报错**？为什么这类错误最危险？
> 4. 如果把第 1 步和第 2 步合成一个文件，会失去什么？

---

## L0 要解决的问题

### 0.1 一个新手会怎么写

任何人第一次写 agent，代码大概都是这样：

```ts
const res = await fetch('https://api.deepseek.com/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
  },
  body: JSON.stringify({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: '你好' }],
  }),
})

const data = await res.json()
const text = data.choices[0].message.content
console.log(text)
```

**这段代码是能跑的。** 我不打算说它是"错的" —— 它在第 0 天是完全合理的选择。

但它埋下了四个坑。我把每个坑的**爆发时间**标出来，你会看到它们不是"风格问题"，而是**必然会在后面某一步拦住你**。

### 0.2 四个坑，以及它们各自何时爆炸

#### 坑 1：没有抽象 → 测试必须联网

**现在看起来**：没什么问题，反正能用。

**爆炸时刻：第 2 步。**

你要写工具注册表，逻辑是"模型要求调用 `read_file`，我就执行它"。你想验证这个逻辑对不对。

但你怎么造出"模型要求调用 `read_file`"这个场景？

- 你得真的调一次 API，还得祈祷模型**真的**愿意调用 `read_file`
- 想测"参数是坏 JSON"的情况？**根本造不出来** —— 你没法命令模型吐一个坏 JSON
- 想测"模型要求调用一个不存在的工具"？同样造不出来

**结果**：你会写出一个测试不了的循环，只能靠"跑一次看看"来验证。

#### 坑 2：直接吃厂商字段名 → 换一家要改几十处

**现在看起来**：`data.choices[0].message.content` 挺直观的。

**爆炸时刻：第 6 步（配置装载）。**

当你要让配置决定"用哪家模型"时，你会发现厂商字段名已经渗进了整个程序：

| 厂商 | 工具调用字段 | 参数位置 |
|---|---|---|
| DeepSeek / OpenAI | `tool_calls` | `function.arguments` |
| Anthropic | `content[].tool_use` | `input`（**已经是对象**） |
| 某些本地模型 | `function_call` | `arguments` |

**你的代码里到处都是 `.choices[0]`、`.tool_calls`、`.function.arguments`** —— 换一家要改的是一整个代码库。

#### 坑 3：失败了只有 `Error`，不分类型 → **第 9 步直接卡死**

**这是四个坑里最致命的。**

**爆炸时刻：第 9 步（重试）。**

你的代码遇到失败时，拿到的是一个普通的 `Error`，或者干脆是一个 HTTP 状态码。于是你写重试逻辑时面对的问题是：

```
问题 1：这次失败该重试吗？
   - 429 限流    → 应该重试
   - 500 服务端  → 应该重试
   - 401 密钥错  → 重试一万次也没用
   
   但你的代码只知道"失败了"。

问题 2：该等多久？
   - 服务端给了 Retry-After: 3，但你把它扔了
   - 只能瞎猜

问题 3：重试几次？
   - 不知道错误类型，就没法定预算
```

**你会被迫在重试函数里重新解析错误** —— 而那意味着错误信息要一路从 HTTP 层穿到重试层，中间每一层都可能把它丢掉。

#### 坑 4：以为 `arguments` 是对象 → 第 2 步第一次接工具就崩

**现在看起来**：没接触过工具调用，根本不知道有这回事。

**爆炸时刻：第 2 步。**

模型返回的工具调用长这样：

```json
{
  "choices": [{
    "message": {
      "tool_calls": [{
        "id": "call_abc123",
        "type": "function",
        "function": {
          "name": "read_file",
          "arguments": "{\"path\": \"src/llm.ts\"}"
        }
      }]
    }
  }]
}
```

**盯着 `arguments` 后面那对引号。** 它是**字符串**，不是对象。

所以：

```ts
const args = data.choices[0].message.tool_calls[0].function.arguments
console.log(args.path)        // ← undefined！
```

因为 `args` 是 `'{"path": "src/llm.ts"}'` 这个字符串，字符串没有 `.path`。

**你必须 `JSON.parse` 它。** 而模型**经常把它写坏**（多一个逗号、少一个引号、用了单引号）。写坏了 `JSON.parse` 会抛异常 —— 如果你直接让它抛，**整个 agent 就死了**。

### 0.3 把四个坑归纳成四个"必须"

| 坑 | 必须做的事 | 在第 1 步怎么解决 |
|---|---|---|
| 1 | 把"调模型"关进一个窄接口后面 | 定义 `Provider` 接口 + 写 `MockProvider` |
| 2 | 把厂商字段名集中到一个翻译函数里 | `toWireMessages()` |
| 3 | 失败必须分类，且分类要能穿到上层 | `LLMErrorCode` + `LLMError` |
| 4 | 参数解析失败不能抛，要变成可回灌的反馈 | `parseArguments()` + `parseError` 字段 |

**第 1 步的全部内容，就是这四件事。**

---

## L1 设计与原理

### 1.1 第一原理：模型没有记忆

这是整门课最重要的一条事实。不懂它，后面每一步都会理解错。

#### 事实

模型（LLM）本身是**无状态**的。它不记得你上一次问了什么。

所谓"多轮对话"，实际发生的是：

```
第 1 轮请求发给模型的内容：
  [ {role: system,  content: "你是一个助手"},
    {role: user,    content: "你好"} ]
模型返回：
  {role: assistant, content: "你好！有什么可以帮你的？"}

第 2 轮请求发给模型的内容（注意：全部重发）：
  [ {role: system,    content: "你是一个助手"},
    {role: user,      content: "你好"},
    {role: assistant, content: "你好！有什么可以帮你的？"},
    {role: user,      content: "1+1 等于几"} ]
模型返回：
  {role: assistant, content: "等于 2。"}
```

**模型每次都看到完整历史，它才显得"有记忆"。**

#### 三个直接推论

**推论 1：消息数组就是 agent 的全部状态。**

如果你想不起来"这个 agent 现在处于什么状态"，答案是：**看它的消息数组**。

这一条会直接导出第 7 步的设计 —— 那时我们会把这个数组换成"从会话日志派生出来"，但本质不变：**消息数组是唯一的状态载体**。

**推论 2：一条消息拼错，后面所有轮次都错。**

因为历史是累积发送的。第 3 轮拼错一条 `tool` 消息，第 4、5、6 轮全都带着这个错误。

**推论 3：token 成本随轮次线性增长。**

第 10 轮的请求包含了前 9 轮的全部内容。这就是为什么需要"上下文压缩"（第 10 步）和"历史检索"（第 14 步）。

#### 一个常见误解

> "但 ChatGPT 明明记得我上周说过的话啊？"

那**不是模型记得**，是产品在数据库里存了历史，每次请求时把相关的部分拼进去。记忆在**应用层**，不在模型里。

**这正是 Hermes 的"记忆系统"在做的事**（第 12 步），也是你科研里"长期记忆"这个方向的技术本质。

---

### 1.2 四种角色（role）

```ts
export type Role = 'system' | 'user' | 'assistant' | 'tool'
```

这是**联合类型**：`Role` 只能取这四个字符串之一。写成 `'System'`（大写 S）编译器立刻报错。

#### 逐个说明

**`system` —— 程序给的设定**

不是用户说的话，是**你的程序**放的。它定义身份、环境、纪律：

```
你是一个编码 agent，工作目录是 D:\project。
可用工具：read_file, write_file, list_dir。
改动文件前先用 read_file 看清原文。
```

**为什么它重要**：模型对 `system` 的服从度最高。工具说明书、行为纪律都放这里。

**注意**：DSH 把系统提示也当成会话历史的一部分来管理（第 7 步会用到这个思想）。

**`user` —— 人说的话**

用户的输入。也包括**框架以人的身份注入的内容**（比如第 10 步的"工具被拒绝了"提示）。

**`assistant` —— 模型说的话**

**这是唯一由模型产生的角色。** 它包含两部分：

```
1. content     —— 模型的自然语言
2. toolCalls   —— 模型要求调用的工具（可能为空）
```

关键认知：**这两件事不一定同时发生。**

| 情况 | content | toolCalls |
|---|---|---|
| 模型直接回答 | 有内容 | 空数组 |
| 模型决定调工具 | **常常是空串** | 非空 |
| 模型一边说一边调 | 有内容 | 非空 |

**第 2 种情况最容易让人困惑**：你看到模型返回了一堆东西，`toolCalls` 有值，但 `content` 是空的，会以为出错了。**没出错，这是正常的。**

**`tool` —— 工具的执行结果**

我们执行完工具后，把结果包装成这个角色发回去。

它必须带一个字段：`toolCallId`。

**为什么？** 因为模型可能**一次要求调用多个工具**：

```json
"tool_calls": [
  { "id": "call_1", "function": { "name": "read_file", "arguments": "{\"path\":\"a.txt\"}" } },
  { "id": "call_2", "function": { "name": "read_file", "arguments": "{\"path\":\"b.txt\"}" } }
]
```

如果我们回灌结果时不带 id，模型就分不清哪个结果对应哪个请求：

```
tool 消息 1: "a 文件的内容是..."
tool 消息 2: "b 文件的内容是..."
        ↑ 模型不知道哪个是哪个
```

带上 id 就清楚了：

```
tool 消息 1: tool_call_id = "call_1", "a 文件的内容是..."
tool 消息 2: tool_call_id = "call_2", "b 文件的内容是..."
```

**这个 id 是模型的"收据"。** 它发出请求时给个编号，我们回结果时把编号带上。

**DSH 里对应的设计**：`core/tools/src/types.ts` 里的 `ToolCallId`，以及一条硬规则 —— **assistant 消息带 N 个 tool_calls，后面必须跟 N 个 tool 消息**（少一条服务端直接 400）。这条规则第 8 步会详细讲。

---

### 1.3 Provider 抽象

#### 先看没有抽象会怎样

```ts
// 调用方（将来的 agent 循环）
const data = await fetch('https://api.deepseek.com/chat/completions', {...})
const text = data.choices[0].message.content
```

问题在于：**调用方知道了太多东西**。它知道要用 fetch、知道 URL、知道字段路径。

想测试？得连网。想换模型？改这里。

#### 抽象之后

```ts
export interface Provider {
  chat(
    messages: readonly ChatMessage[],
    tools?: readonly Record<string, unknown>[],
  ): Promise<LLMResponse>
}
```

**一个方法、两个入参、一个返回值。** 就这么多。

#### 逐部分解释

**`messages: readonly ChatMessage[]`**

- `readonly` 表示"这个方法保证不修改你传进来的数组"
- 为什么重要：调用方传的是自己的历史数组，如果 Provider 偷偷改了它，调用方无法察觉

**`tools?: readonly Record<string, unknown>[]`**

- 末尾的 `?` 表示**可选参数**：可以不传
- 不传 = "这轮不给模型任何工具"
- 类型是 `Record<string, unknown>[]` 而不是具体类型，因为这就是**要发给服务端的 schema 结构**，属于线格式范畴（第 2 步会生成它）

**`Promise<LLMResponse>`**

- 因为网络请求是异步的
- `await provider.chat(...)` 会等到有结果才继续

#### 两个实现，一个接口

```
                    Provider（接口）
                          │
          ┌───────────────┴───────────────┐
          ▼                               ▼
   MockProvider                    DeepSeekProvider
   ─────────────                   ────────────────
   按脚本返回                       真实 HTTP 调用
   离线、免费、100% 确定             需要网络、要花钱、可能失败
   用于：测试、演示、教学            用于：真跑任务
   用于：分诊 bug 在哪一层
```

**关键**：第 8 步的 agent 循环只会拿到一个 `Provider`，**它不知道背后是哪个**。这就是"依赖抽象而非实现"。

#### MockProvider 的隐藏价值：分诊

假设你的 agent 行为异常。你可以：

```
把 DeepSeekProvider 换成 MockProvider，bug 还在吗？
  ├─ 还在    → 问题在你的代码（循环、消息拼接）
  └─ 没了    → 问题在模型交互（提示词、参数、模型行为）
```

**这一步把"哪里出问题"的概率空间砍掉一半。** 这是所有工程领域通用的手法：

| 领域 | 手法 |
|---|---|
| 数据库 | 换内存数据库，看 bug 还在不在 |
| 网络 | 换本地 mock server |
| 时间 | 换成可控时钟 |
| **agent** | **换 MockProvider** |

---

### 1.4 线格式：厂商细节只准出现在一个函数里

#### 问题

我们在程序内部想要干净的字段名（`toolCallId`，驼峰），但发出去必须是厂商要求的名字（`tool_call_id`，下划线）。

而且这不只是大小写问题。对比一下：

| 概念 | 我们的内部结构 | OpenAI 兼容格式 | Anthropic 格式 |
|---|---|---|---|
| 工具调用 | `message.toolCalls` | `message.tool_calls` | `message.content[].tool_use` |
| 参数 | `call.arguments`（对象） | `call.function.arguments`（**字符串**） | `call.input`（对象） |
| 结果回灌 | `{role:'tool', toolCallId}` | `{role:'tool', tool_call_id}` | `{role:'user', content:[{type:'tool_result', tool_use_id}]}` |

**差别大到没法"兼容处理"，只能翻译。**

#### 解法

```ts
export function toWireMessages(messages: readonly ChatMessage[]): Record<string, unknown>[]
```

**一个函数，负责全部的翻译工作。**

```
        程序内部                          网络传输
   ┌─────────────────┐              ┌─────────────────┐
   │  ChatMessage    │  ────────►   │  wire format    │
   │  camelCase      │ toWireMessages│  snake_case     │
   │  干净、厂商无关   │              │  厂商要求的样子   │
   └─────────────────┘              └─────────────────┘
```

**为什么必须集中在一处？**

想象另一种做法：不翻译，程序内部直接用厂商字段名。那么：

- `agent.ts` 里会写 `message.tool_calls`
- `session.ts` 里会写 `message.tool_call_id`
- `retry.ts` 里会写 `call.function.arguments`
- ...几十个文件

**将来要接 Anthropic**，这些地方全部要改，而且**你无法确认有没有漏**。

集中在 `toWireMessages` 里，改动点就**只有一个函数**。

**DSH 的做法**：`packages/llm/llm/src/` 里有一整套 `assembler.ts`（组装器）做类似的事，而且更复杂（要处理系统提示的增量更新、图片引用解析等）。第 7 步我们会看到更完整的形式。

---

### 1.5 `arguments` 是字符串 —— 本步最大的坑

#### 真实的响应长什么样

```json
{
  "id": "chatcmpl-abc",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "",
      "tool_calls": [{
        "id": "call_00_abc123",
        "type": "function",
        "function": {
          "name": "read_file",
          "arguments": "{\"path\":\"src/llm.ts\"}"
        }
      }]
    },
    "finish_reason": "tool_calls"
  }],
  "usage": { "prompt_tokens": 30, "completion_tokens": 18, "total_tokens": 48 }
}
```

**请看 `arguments` 的值**：`"{\"path\":\"src/llm.ts\"}"`

最外层那对引号说明 —— **它整个是一个字符串**。里面的 `\"` 是转义后的引号。

#### 为什么设计成这样？

因为工具参数可以是任意 JSON（对象、数组、数字……），而有的模型（早期）会**流式输出**参数。用字符串最灵活。

**但代价是：你必须自己解析。**

#### 直接使用会怎样

```ts
const call = data.choices[0].message.tool_calls[0]
console.log(call.function.arguments.path)     // undefined
console.log(call.function.arguments)          // '{"path":"src/llm.ts"}'  —— 只是个字符串
typeof call.function.arguments                // 'string'
```

#### 而且模型会写坏

这是**日常现象**，不是异常情况。模型会产出：

```jsonc
// ① 多余的逗号
'{"path": "src/llm.ts",}'

// ② 单引号
"{'path': 'src/llm.ts'}"

// ③ 缺少闭合括号
'{"path": "src/llm.ts"'

// ④ 参数嵌在解释文字里
'好的，我来读取这个文件：{"path": "src/llm.ts"}'

// ⑤ 用自然语言代替 JSON
'path=src/llm.ts'
```

**第 ① 种在前面的演示输出里出现过：**

```
parseError: "arguments 不是合法 JSON：Expected double-quoted property name in JSON at position 22"
```

#### 两种处理策略

**策略 A：直接抛异常**

```ts
const args = JSON.parse(call.function.arguments)    // 坏了就抛
```

后果：**整个 agent 死掉**，用户看到崩溃。而且模型永远不知道自己错在哪。

**策略 B：把失败变成给模型的反馈** ← 我们选这个

```ts
/**
 * @returns value 是解析结果（失败时为空对象）；error 非空表示失败原因。
 */
export function parseArguments(raw: unknown): { value: Record<string, unknown>; error: string }
```

三种结果：

| 情况 | value | error |
|---|---|---|
| 解析成功 | 参数对象 | `''`（空串 = 无错误） |
| JSON 坏了 | `{}` | `"arguments 不是合法 JSON：Expected double-quoted... at position 22"` |
| 不是对象（是数组/null/数字） | `{}` | `"arguments 必须是 JSON 对象，实际是 array"` |
| 本来就是对象 | 原样 | `''` |

**为什么返回 `error` 字符串而不是布尔值？**

因为这段文字要**回灌给模型看**。第 2 步的循环会把它变成一条消息：

```
tool 消息: "工具 read_file 的参数不合法：arguments 不是合法 JSON：
Expected double-quoted property name at position 22。请修正参数后重新调用。"
```

**模型看到"第 22 个字符处写坏了"，通常会自己改对。** 这就是一个**最小的自我纠正回路**。

**这在你的科研方向上是核心机制** —— harness 干预 vs 模型自我修正，这个"把失败原因说清楚让模型自己改"就是最基础的自我修正形态。

#### 于是 `ToolCall` 存了三份信息

```ts
export interface ToolCall {
  readonly id: string                            // 调用编号（回灌时必须带上）
  readonly name: string                          // 工具名
  readonly arguments: Record<string, unknown>    // ① 解析好的对象（失败时空对象）
  readonly rawArguments: string                  // ② 原始字符串（回灌时原样返还）
  readonly parseError: string                    // ③ 失败原因（非空 = 解析失败）
}
```

**为什么 `rawArguments` 也要留？**

因为回灌历史时，我们应该**原样把模型当初给的字符串还回去**，而不是我们自己重新 `JSON.stringify` 一遍。原因：

- 模型看到的和它自己说过的一致，行为更稳定
- 重新序列化可能改变格式（键顺序、空格），某些服务端会认为"这不是我发出去的"，影响缓存匹配

**代价**：多存一份数据（内存占用）。**换来**：回灌保真 + 可调试。

---

### 1.6 错误分类：第 9 步的地基

#### 定义

```ts
export type LLMErrorCode =
  | 'RATE_LIMIT'       // 限流
  | 'SERVER'           // 服务端 5xx
  | 'TIMEOUT'          // 超时
  | 'TRANSPORT'        // 网络层失败
  | 'AUTH'             // 密钥无效/无权限
  | 'INVALID_REQUEST'  // 请求本身非法
  | 'EMPTY_RESPONSE'   // 200 但没内容
  | 'UNKNOWN'
```

#### 一张表记住它

| code | 什么情况 | 该重试吗 | 为什么 |
|---|---|---|---|
| `RATE_LIMIT` | HTTP 429 | ✅ 是 | 等一会儿服务端就恢复了 |
| `SERVER` | HTTP 5xx | ✅ 是 | 是服务端的临时问题 |
| `TIMEOUT` | 超过我们设定的时限 | ✅ 是 | 网络抖动 |
| `TRANSPORT` | DNS 失败、连接被重置 | ✅ 是 | 网络问题 |
| `EMPTY_RESPONSE` | HTTP 200 但 `choices` 空 | ✅ 是 | 网关抖动的常见表现 |
| `AUTH` | HTTP 401 / 403 | ❌ **否** | key 错了，重试一万次也一样 |
| `INVALID_REQUEST` | HTTP 4xx 其它 | ❌ **否** | 你的请求有问题，重试还是有问题 |
| `UNKNOWN` | 其它 | ⚠️ 看情况 | 没有信息 |

**这一列"该重试吗"就是第 9 步的全部依据。**

DSH 里对应的配置项是 `retryPolicy.retryableCodes`，默认值正是：

```yaml
retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]
```

**注意它排除了 `AUTH` 和 `INVALID_REQUEST`** —— 和我们上面的表完全一致。

#### `LLMError` 类

```ts
export class LLMError extends Error {
  readonly code: LLMErrorCode
  readonly status: number | undefined
  readonly retryAfterMs: number | undefined
  // ...
}
```

三个额外字段各自的用途：

| 字段 | 用途 | 谁会用 |
|---|---|---|
| `code` | 决定"要不要重试" | 第 9 步的重试策略 |
| `status` | HTTP 状态码，用于日志和排查 | 第 7 步的会话日志、第 15 步的诊断 |
| `retryAfterMs` | 服务端指定的等待时间 | 第 9 步的退避计算 |

**`retryAfterMs` 值得单独说。**

服务端限流时会返回：

```
HTTP/1.1 429 Too Many Requests
Retry-After: 3
```

意思是"3 秒后再来"。**这比我们自己瞎猜退避时间准确得多。**

我们自己猜：500ms 起步、翻倍、加抖动 —— 猜错了要么白等，要么又撞一次限流。

服务端告诉我们：等 3 秒。

**所以第 9 步的策略是：优先用 `retryAfterMs`，只有当服务端没给、或者给的超出我们的上限时，才用自己算的退避。**

**这就是为什么在第 1 步就要把这个字段存下来** —— 它是 HTTP 响应头里的信息，`fetch` 拿到响应时才有；一旦这个响应对象被丢弃，信息就永远丢了。

#### `cause` 字段

```ts
super(message, extra.cause === undefined ? undefined : { cause: extra.cause })
```

这是 ES2022 给 `Error` 加的能力：**把底层错误挂在身上**。

为什么要挂？

```
LLMError: 连接失败：fetch failed
  └── cause: Error: connect ECONNREFUSED 127.0.0.1:443
        └── cause: Error: ...
```

**没有 `cause`**：你只看到"fetch failed"，不知道是 DNS 问题、连接被拒、还是证书问题。

**有 `cause`**：一层层往下追，能追到根因。

**这是"可诊断性"的基础** —— 第 15 步的诊断层要归因失败，靠的就是这种"错误链条完整"。

---

## L2 决策表

每一项都是"决定 + 为什么 + 替代方案 + 代价"。

| # | 决策 | 我们的选择 | 替代方案 | 代价落在谁身上 |
|---|---|---|---|---|
| 1 | 抽象粒度 | 定义 `Provider` 接口 | 直接 `fetch` 裸调 | 多一个文件、多一层间接；换来离线测试 + 可替换厂商 |
| 2 | 内部消息结构 | camelCase + `toWireMessages` 翻译 | 内部直接用厂商格式 | 多一个函数、每次请求多一次遍历；换来厂商解耦 |
| 3 | 参数解析失败 | **不抛错**，存进 `parseError` | 抛异常终止 | 多两个字段、调用方要判断；换来模型自我纠正的机会 |
| 4 | 错误表示 | 分类成 8 个 `code` 的 `LLMError` | 一个笼统的 `Error` | 多写 30 行；第 9 步的重试策略直接受益 |
| 5 | `Retry-After` | 解析并保存为 `retryAfterMs` | 忽略它，自己算退避 | 多一个字段、一个解析函数；换来更准的等待时间 |
| 6 | 流式输出 | **先不做**（非流式） | 一开始就做 SSE 流式 | 用户要多等几秒；换来前 3 步数据流清晰可见 |
| 7 | 超时控制 | `AbortSignal.timeout()` | 手写 `setTimeout` + `controller.abort()` | 无代价；顺带教会 AbortSignal |
| 8 | mock 的解析路径 | 复用 `toToolCall`（与真实响应同路径） | mock 自己造对象 | 多一次序列化；换来"演示里出现的结构一定是真的" |
| 9 | 返回值的可变性 | 全部 `readonly` | 普通字段 | 写起来啰嗦；换来不会被下游偷偷改 |
| 10 | `arguments` 存三份 | 对象 + 原串 + 错误 | 只存对象 | 内存多占一点；换来回灌保真 + 可诊断 |

### 关于第 6 条（不做流式）的完整论证

这是我替你做的取舍，理由要讲透：

**流式的好处**：用户能边生成边看到文字，体验好。DSH 和所有商业产品都用它。

**流式的代价**：

1. 一次调用从"一个返回值"变成"一串事件"（`start` / `chunk` × N / `end`），你要处理：
   - 分片可能在任意位置断开（连 JSON 都可能被切成两半）
   - 中途出错时，**已经吐出去的内容怎么办**（DSH 的答案是"保留已交付文本"，见 `agent/assistant-stream`）
   - 流式下的工具调用参数是**分片累积**的，要拼完才能解析
2. 你会同时面对两个新概念（流式 + 工具调用），而它们互相纠缠

**结论**：在你还没分清 `assistant` 和 `tool` 角色之前引入流式，是自找混乱。

**什么时候补**：第 7 步做完会话日志后。那时"已交付的文本"有了稳妥的落盘位置，流式变成自然扩展而不是额外负担。

---

## L3 实现：逐行讲解

> **阅读方式**：每一小节先给**完整代码**（与 `src/kernel/llm.ts` 一字不差），再逐行/逐块解释。
> 代码块里带行号的是原文行号，方便你对照真实文件。

### 3.0 全文件的五段结构

```
┌─── 第 1 节（16–56 行）  消息与响应：数据形状
├─── 第 2 节（62–104 行） 错误分类：重试的地基
├─── 第 3 节（110–139 行）线格式翻译
├─── 第 4 节（145–195 行）参数解析
└─── 第 5 节（201–419 行）Provider 接口 + 两个实现 + 辅助函数
```

**建议的阅读顺序**：先读第 5 节（Provider 是什么），再回头读第 1 节（它用到的类型），然后第 3、4 节（实现细节），最后第 2 节（错误分类）。

原因：`Provider` 是这份文件的**中心**，其他都是为了支撑它。

---

### 3.1 文件头注释（第 1–10 行）

```ts
/**
 * 第 1 步 ｜ 模型层：把「一个 HTTP 接口」包装成「可替换的 Provider」
 *
 * 这一层只做一件事：把一组消息发给模型，拿回一条响应。
 * 它不知道 agent、不知道工具、不知道循环 —— 那些是后面几步的事。
 *
 * 为什么值得单独一个文件？
 *   因为「调用模型」是整个 agent 里唯一必须联网、必须花钱、必须可能失败的动作。
 *   把它关进一个窄接口后面，后面的所有代码都可以脱网测试。
 */
```

**逐句解释**：

| 句子 | 作用 |
|---|---|
| "把「一个 HTTP 接口」包装成「可替换的 Provider」" | 一句话说清这个文件的本质 |
| "它不知道 agent、不知道工具、不知道循环" | **负向定义**：明确说它不做什么。这比说它做什么更重要 |
| "唯一必须联网、必须花钱、必须可能失败的动作" | 给出**为什么要隔离它**的理由 |
| "后面的所有代码都可以脱网测试" | 隔离带来的具体收益 |

**为什么要写这么详细的文件头？**

因为三个月后你回来看这个文件，第一个问题是"这个文件管到哪一步"。文件头直接回答。

**DSH 的做法**：每个源文件的 JSDoc 都要说明**它拥有什么**，而且有一条仓库级规范 —— 注释要写"完整的契约和上下文"，不要写"推理过程"。

---

### 3.2 `Role` 类型（第 16–17 行）

```ts
/** 消息的四种角色。这是「联合类型」：只能取这四个字符串之一，写错立刻报错。 */
export type Role = 'system' | 'user' | 'assistant' | 'tool'
```

#### 逐部分

| 片段 | 含义 |
|---|---|
| `/** ... */` | JSDoc 注释。**编辑器会把它显示成提示** |
| `export` | 导出，别的文件可以 `import { Role } from './llm.ts'` |
| `type` | 定义**类型别名**（不是运行时值） |
| `Role` | 类型名，惯例是首字母大写 |
| `'system' \| 'user' \| ...` | 联合类型：取其中之一。`\|` 是"或" |

#### 为什么用 `type` 而不是 `interface`

| | `type` | `interface` |
|---|---|---|
| 能表示联合类型 | ✅ | ❌ |
| 能被"声明合并"扩展 | ❌ | ✅ |
| 能描述对象 | ✅ | ✅ |

**规则**：联合类型、函数类型、简单别名用 `type`；对象结构用 `interface`。

#### 变成"字符串"会怎样

```ts
export type Role = string        // ← 不要这样
```

那就失去了全部保护。你可以写出 `role: 'sytem'`（拼错）而编译器不管，等到服务端返回 400 你才发现。

**用联合类型，`role: 'System'` 在保存文件的那一刻就标红。**

#### 一个必须知道的细节：它会被完全擦除

`Role` 是**纯类型**。Node 跑起来后，这个文件里**根本没有 `Role` 这个东西**。

验证方法：

```powershell
node --input-type=module -e "import('./src/kernel/llm.ts').then(m => console.log(Object.keys(m)))"
```

输出里不会有 `Role`、`ToolCall`（interface 也会被擦）、`LLMUsage`。

**这会带来一个实际影响**：你不能在运行时检查"这个字符串是不是合法的 Role"。要检查必须自己写数组：

```ts
const ROLES = ['system', 'user', 'assistant', 'tool'] as const
```

**第 7 步**会在解析持久化的会话日志时遇到这个问题（从文件读出来的东西要在运行时校验）。

---

### 3.3 `ToolCall` 接口（第 19–31 行）

```ts
/** 模型要求调用的一个工具。 */
export interface ToolCall {
  /** 本次调用的唯一编号。回灌结果时必须原样带回，模型才知道这是哪次调用的结果。 */
  readonly id: string
  /** 工具名，必须和工具注册表里的名字完全一致。 */
  readonly name: string
  /** 参数（已解析成对象）。解析失败时是空对象。 */
  readonly arguments: Record<string, unknown>
  /** 服务端给的原始参数字符串。解析失败时原样回灌，让模型自己改对。 */
  readonly rawArguments: string
  /** 非空表示参数解析失败，内容是失败原因（回灌给模型看）。 */
  readonly parseError: string
}
```

#### 逐字段

**`readonly id: string`**

- `readonly` = 创建后不能重新赋值
- `id` 是**模型的收据编号**。回灌结果时必须带上，否则模型分不清哪个结果对应哪个请求
- `string` 而不是 `number`：服务端给的就是字符串（如 `"call_00_abc123"`）

**`readonly name: string`**

- 工具名。第 2 步的注册表会用它查表
- 注意注释里那句"必须和工具注册表里的名字完全一致" —— 这是**跨文件契约**，写在字段注释里，读代码的人一眼就能看到

**`readonly arguments: Record<string, unknown>`**

逐部分：

| 片段 | 含义 |
|---|---|
| `Record<K, V>` | TS 内置的泛型类型，等价于"键是 K、值是 V 的对象" |
| `string`（键） | 对象的键必须是字符串 |
| `unknown`（值） | 值可以是任何东西，但**用之前必须先检查** |

**为什么值用 `unknown` 而不是 `any`？**

```ts
// 用 any：
const n = args.count
console.log(n.toFixed(2))      // 编译通过；如果 n 是字符串，运行时崩

// 用 unknown：
const n = args.count
console.log(n.toFixed(2))      // ✗ 编译报错：必须先判断 typeof n === 'number'
```

**`unknown` 强制你做检查。这是"把错误提前到编译期"的最直接手段。**

**`readonly rawArguments: string`**

原始字符串。为什么要留一份？前面 1.5 节讲过：回灌保真、避免重新序列化改变格式。

**`readonly parseError: string`**

**用空串表示"没有错误"，而不是 `string | undefined` 或者 `boolean`。**

为什么？

```ts
// 写法 A：用可选字段
if (call.parseError !== undefined) { ... }

// 写法 B：用空串
if (call.parseError !== '') { ... }
```

两者都行，选 B 的理由是：**`parseError` 的内容本身要回灌给模型**，所以它必须是字符串。既然已经是字符串了，再用 `undefined` 表示"没有"就是两套状态，不如统一成"空串 = 没有"。

**代价**：不能写 `if (call.parseError)` 这种简写（空串是 falsy，能工作，但语义不够明确）。我们统一写 `!== ''`。

#### `interface` vs 字面量对象

为什么定义一个 `interface`，而不是到处用 `{ id: string; name: string; ... }`？

1. **改名/加字段时只改一处**
2. **类型名本身是文档** —— 看到 `ToolCall` 就知道说的是什么
3. **可以被别的类型引用**（比如 `LLMResponse.toolCalls` 是 `ToolCall[]`）

---

### 3.4 `LLMUsage`（第 33–34 行）

```ts
/** token 用量。不同厂商字段名不同，所以用「字符串→数字」的开放字典。 */
export type LLMUsage = Record<string, number>
```

**为什么不是固定字段？**

各家的字段名不一样：

```jsonc
// OpenAI / DeepSeek
{ "prompt_tokens": 30, "completion_tokens": 18, "total_tokens": 48 }

// Anthropic
{ "input_tokens": 30, "output_tokens": 18 }

// 有的还会加
{ "prompt_cache_hit_tokens": 20, "prompt_cache_miss_tokens": 10 }
```

**用开放字典**：什么字段都收下，将来加统计（成本核算、缓存命中率）不用改类型。

**代价**：字段名没有编译期检查。所以**第 7 步**在算"这周花了多少 token"时，要写一个映射函数把各家的名字统一。

---

### 3.5 `LLMResponse`（第 36–44 行）

```ts
/** 一次模型调用的结果。 */
export interface LLMResponse {
  /** 模型的自然语言输出。只说工具调用时可能是空串。 */
  readonly content: string
  /** 模型要求执行的工具调用。正常回答时是空数组。 */
  readonly toolCalls: readonly ToolCall[]
  /** token 用量，可能为空字典。 */
  readonly usage: LLMUsage
}
```

**三个字段的两个设计要点**：

**要点 1：`content` 用空串而不是 `undefined`**

和 `parseError` 同样的理由：统一成"空串表示没有"。注释里明确写了"只说工具调用时可能是空串" —— 这是**提前告诉读者不要惊慌**。

**要点 2：`readonly toolCalls: readonly ToolCall[]` —— 两个 `readonly`**

这是全篇最容易看漏的地方。两个 `readonly` 管的是**不同的事**：

```ts
readonly toolCalls: readonly ToolCall[]
//  ↑ ①                ↑ ②
```

| # | 位置 | 禁止什么 |
|---|---|---|
| ① | 属性前 | `response.toolCalls = [...]` ← 不能换掉整个数组 |
| ② | 数组类型前 | `response.toolCalls.push(...)` ← 不能往里加东西 |

**为什么两个都要？**

因为"不可变"要贯彻到数据结构内部。只写 ① 的话，别人依然能：

```ts
const calls = response.toolCalls
calls.push(newCall)        // ← 修改了"只读"的响应内部
```

**为什么我们这么在意不可变？**

因为第 8 步的循环会把 `LLMResponse` 的内容拼进消息数组，然后当历史发出去。如果某个插件在中间偷偷往 `toolCalls` 里塞了一个调用，模型就会看到它从没要求过的工具调用 —— **行为不可解释**。

**不可变 = 数据流可追溯。**

---

### 3.6 `ChatMessage`（第 46–56 行）

```ts
/** agent 内部使用的消息结构：camelCase，不绑定任何厂商。 */
export interface ChatMessage {
  role: Role
  content: string
  /** 仅 assistant 使用：模型这一轮要求调用的工具。 */
  toolCalls?: readonly ToolCall[]
  /** 仅 tool 使用：这条结果对应哪次调用。 */
  toolCallId?: string
  /** 仅 tool 使用：工具名。部分厂商的接口需要它。 */
  name?: string
}
```

**注意：这里 `role` 和 `content` 没有 `readonly`，而可选字段有。**

这个不一致是**故意的**，理由是：

- 消息在构造阶段需要能改（先 `{role, content}`，处理完再补 `toolCalls`）
- 但 `toolCalls` 一旦定下来就不该变（它代表"模型说过什么"，是历史事实）

**代价**：不彻底。真正的做法是分开"可变的消息构造器"和"不可变的消息"，但那是过度设计。

**三个可选字段的语义**（注意注释里都写了"仅 xxx 使用"）：

| 字段 | 什么时候有 | 为什么需要 |
|---|---|---|
| `toolCalls` | role 是 `assistant` 且模型要求调工具 | 让模型记得"我要求过什么" |
| `toolCallId` | role 是 `tool` | 让模型知道这个结果对应哪次请求 |
| `name` | role 是 `tool` | 部分厂商要求带上工具名 |

**为什么用可选字段（`?`）而不是"四种角色各定义一个接口"？**

后者看起来更严格：

```ts
interface SystemMessage { role: 'system'; content: string }
interface UserMessage { role: 'user'; content: string }
type ChatMessage = SystemMessage | UserMessage | ...
```

这叫**可辨识联合**，确实是更严格的写法。**我们不用它的理由**：

1. 第 8 步的循环要在一个数组里混放各种消息、动态构造它们，联合类型会让每次构造都要写类型收窄
2. 服务端本身接受"缺字段"的形式（缺了就当没有）

**代价**：编译器不会阻止你给 `user` 消息加 `toolCallId`。**换来**：代码好写得多。

（DSH 的选择相反：它的持久化事件用了严格的联合类型，因为**落盘的数据必须严格**。我们第 7 步会看到区别。）

---

### 3.7 `LLMErrorCode`（第 62–82 行）

```ts
export type LLMErrorCode =
  | 'RATE_LIMIT'
  | 'SERVER'
  | 'TIMEOUT'
  | 'TRANSPORT'
  | 'AUTH'
  | 'INVALID_REQUEST'
  | 'EMPTY_RESPONSE'
  | 'UNKNOWN'
```

前面 1.6 节已经讲了每个 code 的含义。这里补充**三个实现细节**：

**细节 1：为什么每个成员前都写 `|`？**

纯风格选择。也可以写成一行：

```ts
export type LLMErrorCode = 'RATE_LIMIT' | 'SERVER' | 'TIMEOUT' | ...
```

竖排的好处：**每行的 JSDoc 注释能贴上去**（原文件里每个成员都有注释说明）。这是 DSH 的风格。

**细节 2：`| 'UNKNOWN'` 为什么必须存在？**

因为 `codeForStatus()` 可能遇到没覆盖的状态码。**没有兜底值，函数就必须抛错或者返回 `undefined`** —— 两者都更糟。

**这里体现一条原则**：分类系统必须有一个"其它"桶。没有它，遇到新情况时你只能二选一：崩溃，或者假装认识。

**细节 3：这个类型会驱动第 9 步的配置**

第 9 步的重试策略配置长这样：

```json
{ "mode": "normal", "retryableCodes": ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"] }
```

`retryableCodes` 的取值就是这里面的一部分。**类型和配置是同一个词汇表** —— 这是好设计的标志。

---

### 3.8 `LLMError` 类（第 84–104 行）

```ts
/** 模型层统一抛出的错误。里面的 code 就是上面的分类。 */
export class LLMError extends Error {
  readonly code: LLMErrorCode
  /** HTTP 状态码；不是 HTTP 失败时是 undefined。 */
  readonly status: number | undefined
  /** 服务端通过 Retry-After 指定的等待毫秒数；没给就是 undefined。 */
  readonly retryAfterMs: number | undefined

  constructor(
    code: LLMErrorCode,
    message: string,
    extra: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause })
    this.name = 'LLMError'
    this.code = code
    this.status = extra.status
    this.retryAfterMs = extra.retryAfterMs
  }
}
```

#### 逐部分讲解

**`export class LLMError extends Error`**

- `class` 是**运行时真正存在的东西**（不像 interface）
- `extends Error` 表示继承内置的 `Error` 类
- **为什么要继承**：这样它才有 `message`、`stack`，才能被 `throw` / `catch`，才能用 `instanceof` 判断

**`readonly code: LLMErrorCode`**

**这三个字段声明在类型层面是"声明"，但它们同时也在运行时创建了属性吗？**

**不。** 这是关键细节：

```ts
class LLMError extends Error {
  readonly code: LLMErrorCode      // ← 只有类型，运行时不存在
}
```

在 Node 的类型擦除下，这行**被完全删掉**。属性是**构造函数里的赋值语句**创建的：

```ts
this.code = code                  // ← 这行才真正创建属性
```

**所以：如果你声明了一个字段但忘了在构造函数里赋值，运行时这个属性就是 `undefined`。**

这是类型擦除模式下最常见的一类坑。**记住这条规则：`class` 里的字段声明只是"承诺"，构造函数里的赋值才是"兑现"。**

**`readonly status: number | undefined`**

`number | undefined` 是联合类型 —— 要么是数字，要么是 `undefined`。

**为什么不用 `status?: number`？**

两者在读取时行为几乎一样，但有细微区别：

| 写法 | 含义 | 能否省略传参 |
|---|---|---|
| `status?: number` | 可选属性，可以不存在 | — |
| `status: number \| undefined` | **必须存在**，但值可以是 undefined | — |

我们用后者，理由是：**构造函数里总是显式赋值**（`this.status = extra.status`），所以属性一定存在，只是值可能是 `undefined`。

这保证了**对象形状一致** —— 无论有没有 status，`'status' in error` 都是 `true`。某些情况下（比如序列化）这很重要。

**构造函数签名**

```ts
constructor(
  code: LLMErrorCode,
  message: string,
  extra: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
)
```

**`extra` 这个"选项对象"模式**，逐部分：

```ts
extra: { status?: number; retryAfterMs?: number; cause?: unknown } = {}
//     └────────────────── 一个匿名对象类型 ──────────────────┘  └─ 默认值
```

- 三个字段都是可选（`?`）：调用时想给几个给几个
- `= {}` 是**默认参数**：不传就是空对象

**为什么用选项对象而不是位置参数？**

对比两种调用：

```ts
// 位置参数（假设签名是 (code, message, status?, retryAfterMs?, cause?)）
throw new LLMError('RATE_LIMIT', '限流', 429, undefined, cause)
//                                    ↑ 只想给 cause，却必须先塞一个 undefined 占位

// 选项对象
throw new LLMError('RATE_LIMIT', '限流', { status: 429, cause })
//                                        ↑ 想给什么就给什么，名字一目了然
```

**代码里实际的三次调用正好展示了这个好处**（第 337、351、370 行），每次给的可选字段都不同。

**`cause` 类型为什么是 `unknown` 而不是 `Error`？**

因为 `catch (cause)` 捕获到的东西在 TS 里类型是 `unknown` —— **抛出的东西可以是任何值**（字符串、数字、对象都行）。所以传进来时也只能是 `unknown`。

**`super(message, extra.cause === undefined ? undefined : { cause: extra.cause })`**

这一行有点绕，逐部分拆：

```ts
super(
  message,                                                  // ① 第一个参数：错误信息
  extra.cause === undefined                                 // ② 三元判断
    ? undefined                                             //    没给 cause → 传 undefined
    : { cause: extra.cause },                               //    给了 → 包装成对象
)
```

**为什么要判断一下，不直接写 `super(message, { cause: extra.cause })`？**

因为 `Error` 的第二个参数如果传了对象、但 `cause` 是 `undefined`，某些 Node 版本下 `error.cause` 会**存在且为 undefined**，和"从没设过 cause"在行为上不一致（比如 `util.inspect` 的输出会多一行）。

**这是一个防御性写法**。代价是啰嗦，收益是错误对象的形状一致。

**`this.name = 'LLMError'`**

**为什么必须手动设？**

因为 `Error` 的 `name` 默认是 `'Error'`。你继承之后不设，所有 `LLMError` 实例的 `name` 都还是 `'Error'` —— 打印出来根本分不清是什么错误。

**这是个非常常见的疏漏。** 继承内置错误类时，`name` 一定要自己设。

---

### 3.9 `toWireMessages()`（第 110–139 行）

```ts
export function toWireMessages(messages: readonly ChatMessage[]): Record<string, unknown>[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
    }
    if (message.role === 'assistant' && message.toolCalls !== undefined && message.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: call.rawArguments !== '' ? call.rawArguments : JSON.stringify(call.arguments),
          },
        })),
      }
    }
    return { role: message.role, content: message.content }
  })
}
```

#### 函数签名

```ts
export function toWireMessages(
  messages: readonly ChatMessage[],      // 输入：内部消息数组
): Record<string, unknown>[] {           // 输出：线格式对象数组
```

**为什么返回 `Record<string, unknown>[]` 而不是定义一个 `WireMessage` 类型？**

**这是一个有意的"故意不求精确"**。理由：

1. 线格式是**外部规范**，不是我们的数据模型。它可能随时加字段
2. 定义成严格类型会给人"这是我们的数据结构"的错觉
3. `Record<string, unknown>` 明确表达"这是个待序列化的普通对象"

**代价**：写错了字段名编译器不报错（比如把 `tool_call_id` 写成 `tool_call_ID`）。

**换来**：不会误以为它是内部结构。

**这是"在边界处故意放松类型"的典型应用。** 边界 = 与外部系统交互的地方。

#### 主体：`messages.map(...)`

```ts
return messages.map((message) => { ... })
```

- `.map()` 遍历数组，对每个元素调用函数，**用返回值组成一个新数组**
- 原数组不变（这正是我们要的：不修改调用方的历史）

**对比 `.forEach()`**：`forEach` 只遍历、不收集返回值。我们要产出新数组，所以用 `map`。

#### 分支 1：`tool` 消息

```ts
if (message.role === 'tool') {
  return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
}
```

**这里发生了字段名翻译**：

```
内部：toolCallId       （驼峰）
  ↓
线格式：tool_call_id    （下划线）
```

**并注意排在第一个判断**：为什么 `tool` 要在 `assistant` 之前判断？

因为 `tool` 消息没有 `toolCalls`，它的分支最简单，提前返回能让后面的判断少一层嵌套。

**这里有个隐患值得指出**：`message.toolCallId` 的类型是 `string | undefined`（可选字段）。如果它是 `undefined`，序列化后：

```json
{ "role": "tool", "content": "..." }
```

`tool_call_id` 字段会**直接消失**（`JSON.stringify` 会跳过值是 `undefined` 的属性）。

服务端收到就会报错。**但我们不做检查** —— 因为"tool 消息必须有 toolCallId"是**构造消息时就该保证的契约**，在这里检查属于重复防御。

**第 8 步**会在拼消息时保证这一点。

#### 分支 2：带工具调用的 `assistant` 消息

```ts
if (message.role === 'assistant' && message.toolCalls !== undefined && message.toolCalls.length > 0) {
```

**这个判断有三个条件，每个都有理由**：

| 条件 | 为什么需要 |
|---|---|
| `role === 'assistant'` | 只有模型的消息才可能带工具调用 |
| `toolCalls !== undefined` | 该字段是可选的，可能没有 |
| `toolCalls.length > 0` | **空数组也不该走这个分支** |

**第三个条件最容易漏。** 如果只判断 `!== undefined`，那么一个 `toolCalls: []` 的普通回答消息也会被套上 `tool_calls: []` 字段发给服务端 —— 多数服务端会接受，但有些会报错，而且这是**无意义的字段**。

**注意判断写法**：`message.toolCalls !== undefined` 而不是 `message.toolCalls`。

为什么不写简写？因为空数组 `[]` 是 truthy，所以两者在这里**行为相同**。但写显式的 `!== undefined` 表达了"我在判断它是否存在"，而不是"我在判断它是不是真值"——**意图更清楚**。

#### 分支 2 的返回

```ts
return {
  role: 'assistant',
  content: message.content,
  tool_calls: message.toolCalls.map((call) => ({
    id: call.id,
    type: 'function',
    function: {
      name: call.name,
      arguments: call.rawArguments !== '' ? call.rawArguments : JSON.stringify(call.arguments),
    },
  })),
}
```

**逐字段**：

| 线格式字段 | 来源 | 说明 |
|---|---|---|
| `role` | 固定 `'assistant'` | |
| `content` | 原样 | 可能是空串 |
| `tool_calls` | `toolCalls` 翻译 | 大小写 + 下划线 |
| `.id` | `call.id` | 原样 |
| `.type` | 固定 `'function'` | OpenAI 的判别字段，目前只有这一种 |
| `.function.name` | `call.name` | |
| `.function.arguments` | **条件表达式** | 见下 |

**`arguments` 那一行的条件表达式：**

```ts
arguments: call.rawArguments !== '' ? call.rawArguments : JSON.stringify(call.arguments)
```

读法：**原串非空就用原串，否则把对象序列化**。

**为什么要"优先用原串"？**

场景：模型上次给的是 `'{"path":"a.txt"}'`（无空格）。我们解析成对象 `{path: 'a.txt'}`，现在要把这条历史发回去。

| 做法 | 发出去的内容 |
|---|---|
| 重新 `JSON.stringify` | `'{"path":"a.txt"}'` —— 恰好一样，但不保证 |
| **用原串** | `'{"path":"a.txt"}'` —— **一定一模一样** |

差别在复杂情况下会显现：

- 键顺序：`JSON.stringify` 按插入顺序，重新构造可能改变
- 数字精度：`1.0` 序列化后会变成 `1`
- 空白：原串可能有空格，重新序列化没有

**服务端做 KV cache 匹配时，请求内容一模一样才可能命中缓存。** 改写一个字符就可能导致缓存失效 —— 这在长对话里意味着**多花很多钱**。

**什么时候会用 `JSON.stringify` 那一边？**

当 `rawArguments` 是空串时。这发生在：**我们自己构造的消息**（比如第 8 步要把一条历史消息重新发出去，但没有原串）。

#### 分支 3：其它消息

```ts
return { role: message.role, content: message.content }
```

`system` 和 `user` 走这里。字段名和内部完全一样，**不需要翻译** —— 这也是为什么这两个角色最省事。

#### 这个函数的一个隐含契约

**它只为"发给服务端"服务，不用于持久化。**

第 7 步的会话日志要存的是**内部结构**（camelCase），不是线格式。因为内部结构才是我们的领域模型。

**判断一个结构该不该翻译，标准是：它是"我们的"还是"外部的"。**

---

### 3.10 `parseArguments()`（第 145–173 行）

```ts
export function parseArguments(raw: unknown): { value: Record<string, unknown>; error: string } {
  if (raw === undefined || raw === null || raw === '') {
    return { value: {}, error: '' }
  }
  if (typeof raw === 'object') {
    return { value: raw as Record<string, unknown>, error: '' }
  }
  if (typeof raw !== 'string') {
    return { value: {}, error: `arguments 既不是字符串也不是对象，而是 ${typeof raw}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    return { value: {}, error: `arguments 不是合法 JSON：${reason}` }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const actual = Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed
    return { value: {}, error: `arguments 必须是 JSON 对象，实际是 ${actual}` }
  }
  return { value: parsed as Record<string, unknown>, error: '' }
}
```

**这是全篇最值得逐行读的函数。**

#### 参数用 `unknown` 而不是 `string`

```ts
export function parseArguments(raw: unknown)
```

**为什么？** 因为调用方给的东西**不确定**：

- 真实的 DeepSeek 响应：是字符串
- 某些厂商（Anthropic）：已经是对象
- 我们自己构造的 mock：可能是对象
- 服务端异常时：可能是 `null`

**用 `unknown` 强迫这个函数处理所有情况。** 如果用 `string`，调用方就得先自己判断类型，那判断逻辑会散落在多处。

#### 第一层：三种"没什么可解析"的情况

```ts
if (raw === undefined || raw === null || raw === '') {
  return { value: {}, error: '' }
}
```

**这三种都返回"空对象 + 无错误"。**

**为什么空值不算错误？** 因为**"模型调用了一个不需要参数的工具"是完全合法的**：

```
模型：请调用 list_dir，参数：{}
```

所以 `undefined` / `null` / `''` 都视为"没有参数"，而不是"解析失败"。

**注意这里用了 `''`（空串）**，而不是 `'{}'`。服务端有时候会给空串表示无参数。

#### 第二层：已经是对象

```ts
if (typeof raw === 'object') {
  return { value: raw as Record<string, unknown>, error: '' }
}
```

**`typeof raw === 'object'` 这个判断有陷阱：**

```ts
typeof {}        // 'object'  ✓
typeof []        // 'object'  ← 数组也是 object！
typeof null      // 'object'  ← 这是 JS 的历史遗留 bug！
```

**但这里不用管**，因为上一行已经排除了 `null`，而数组到了这里……**确实会漏过去**。

**这是个真实的小缺陷。** 如果调用方直接传一个数组进来，会被当作合法参数对象接受。

**为什么留在这里不修？**

因为**这个函数的输入来自我们自己的解析路径**（`toToolCall`），源头是 JSON 字符串，走到这里时数组的情况已经被后面那层检查处理了（在 `JSON.parse` 之后）。

**这是"信任类型化的同进程调用"的应用** —— 我们不对自己内部传的数据做重复防御。**但代价是**：如果将来有人直接调用 `parseArguments([1,2])`，会得到一个"成功"的假象。

**修法**（如果你要改）是把判断收紧成：

```ts
if (typeof raw === 'object' && !Array.isArray(raw)) { ... }
```

#### 第三层：不是字符串也不是对象

```ts
if (typeof raw !== 'string') {
  return { value: {}, error: `arguments 既不是字符串也不是对象，而是 ${typeof raw}` }
}
```

到这里 `raw` 只可能是 `number` / `boolean` / `bigint` / `symbol` / `function`。

**注意错误信息的写法**：`而是 ${typeof raw}`。

**报错时说出"实际是什么"，是最有价值的信息。** 对比：

| 写法 | 你看到 | 你要做什么 |
|---|---|---|
| `"参数类型错误"` | 只有"错了" | 回去翻代码，加 `console.log` |
| `"既不是字符串也不是对象，而是 number"` | 明确是 number | 立刻知道模型给了个数字 |

**这个习惯要贯穿整个项目。** 第 2 步的参数校验器会把这个思想做到极致（连"期望 string 实际是 number"都写出来）。

#### 第四层：真正的 JSON 解析

```ts
let parsed: unknown
try {
  parsed = JSON.parse(raw)
} catch (cause) {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return { value: {}, error: `arguments 不是合法 JSON：${reason}` }
}
```

**注意 `let parsed: unknown` 声明在 `try` 外面。**

**为什么？** 因为在 `try` 里声明的变量，出了 `try` 就不可见了。我们要在 `try/catch` 之后继续用它，所以必须先在外面声明。

**`catch (cause)` 里 `cause` 的类型是 `unknown`。**

TS 从 4.4 起，`catch` 拿到的默认是 `unknown`（不是 `any`）。所以要用它必须先判断：

```ts
const reason = cause instanceof Error ? cause.message : String(cause)
```

- 是 Error → 取 `.message`
- 不是（可能是字符串或别的）→ `String()` 强转

**`JSON.parse` 抛出的错误是 `SyntaxError`（是 Error 的子类）**，所以正常情况走第一支。

**错误信息里拼上了 V8 给的原始消息**：

```
arguments 不是合法 JSON：Expected double-quoted property name in JSON at position 22 (line 1 column 23)
```

**这段原始消息里包含了"第 22 个字符处出错"** —— 模型看到这个位置提示，能更准地改对。

**这就是"把错误信息原样透传"的价值。** 如果你自己重新组织错误信息（比如只写"JSON 格式错误"），就丢掉了最有用的那部分。

#### 第五层：解析结果必须是对象

```ts
if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
  const actual = Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed
  return { value: {}, error: `arguments 必须是 JSON 对象，实际是 ${actual}` }
}
```

**这一层在挡什么？**

`JSON.parse` 能成功解析出任何 JSON 值：

```
'null'      → null
'[]'        → []
'[1,2,3]'   → [1,2,3]
'"hello"'   → "hello"
'123'       → 123
'true'      → true
'{"a":1}'   → {a:1}   ← 只有这个是我们想要的
```

**工具参数必须是对象**，因为第 2 步的校验器会按字段名查找（`args.path`）。如果拿到的是数组或数字，后面全乱。

**那行 `actual` 的计算**：

```ts
const actual = Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed
```

**嵌套三元表达式**，展开读：

```ts
let actual
if (Array.isArray(parsed)) {
  actual = 'array'
} else if (parsed === null) {
  actual = 'null'
} else {
  actual = typeof parsed
}
```

**为什么要单独判 `null` 和 `array`？** 因为 `typeof null === 'object'`、`typeof [] === 'object'`，直接 `typeof` 会给出误导性的 `'object'`。

**注意这个写法是有点丑的**（嵌套三元不容易读）。**如果你重写，可以改成 if/else 链** —— 这不影响功能，是风格取舍。

#### 最后一层：成功

```ts
return { value: parsed as Record<string, unknown>, error: '' }
```

**`as Record<string, unknown>` 是类型断言。**

**为什么需要它？** 因为在上一行我们刚确认 `parsed` 不是 null、是 object、不是数组，但 **TypeScript 不会记住这些**（它不做跨行的类型收窄，除非写成类型守卫函数）。

所以我们要**手动告诉编译器**："我保证它是字符串键的对象"。

**`as` 的风险要在心里记住**：

```ts
const x = something as Record<string, unknown>    // 运行时不做任何检查
```

**它不会验证任何东西。** 如果判断写错了，`as` 不会救你，只会让错误延后到使用 `x.foo` 时才爆发。

**这是本项目里为数不多的 `as` 用法之一**，而且都紧跟在显式检查之后。**其他地方的 `as` 都要警惕。**

#### 这个函数的返回值设计

```ts
{ value: Record<string, unknown>; error: string }
```

**为什么返回对象而不是抛异常？**

前面 1.5 节讲过：**错误要变成可以回灌给模型的反馈，而不是中断程序**。

**为什么是 `{value, error}` 而不是 `[value, error]`（元组）？**

```ts
const [value, error] = parseArguments(raw)          // 元组：位置敏感
const { value, error } = parseArguments(raw)        // 对象：名字自解释
```

元组更短，但**调用方必须记住顺序**。对象解构读起来更清楚。

**为什么不用 `null` 表示失败？**

```ts
const result = parseArguments(raw)
if (result === null) { ... }        // 丢失了失败原因
```

我们需要**失败原因本身**（要回灌给模型），所以必须返回它。

---

### 3.11 `toToolCall()` 与 `asRecord()`（第 175–195 行）

```ts
/** 把线格式里的一条 tool_call 转成内部 ToolCall。越界输入在这里被挡住。 */
function toToolCall(item: unknown, index: number): ToolCall {
  const record = asRecord(item)
  const fn = asRecord(record.function)
  const id = typeof record.id === 'string' && record.id !== '' ? record.id : `call_${index}`
  const name = typeof fn.name === 'string' ? fn.name : ''
  const raw = typeof fn.arguments === 'string' ? fn.arguments : ''
  const parsed = parseArguments(fn.arguments)
  return {
    id,
    name,
    arguments: parsed.value,
    rawArguments: raw !== '' ? raw : JSON.stringify(parsed.value),
    parseError: parsed.error,
  }
}

/** 把 unknown 收窄成「字符串键的对象」；不是对象就给空对象。 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}
```

#### 为什么这两个函数不导出（没有 `export`）

**它们只在 `llm.ts` 内部使用。** 不导出意味着：

- 外部无法依赖它们（将来重构可以随意改）
- 文件对外暴露的 API 更小

**这是"最小暴露面"原则。** 判断标准：**外部真的需要它吗？**

`parseArguments` 导出了（因为第 2 步的工具层可能想复用），`toToolCall` 没导出（因为只有解析响应时才需要）。

#### `asRecord`：一个两行的"安全收窄器"

```ts
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}
```

**这是处理 `unknown` 的标准手法**：检查 → 不满足就给一个安全的默认值。

**注意它排除了 `null`**（因为 `typeof null === 'object'`），**但没排除数组**。这是有意的：数组在 JSON 里能被当对象用（只不过键是 `"0"`, `"1"`...），而且这个函数主要是给"响应结构解析"用的，宽松处理能避免不必要的失败。

**这个函数在文件里被调用了 4 次**（第 177、178、390、400、415 行），所以值得抽出来。

**这就是"三次法则"**：同一个模式写第三遍时，就该抽成函数。

#### `toToolCall` 逐行

```ts
const record = asRecord(item)
const fn = asRecord(record.function)
```

两级解构：先拿到 tool_call 对象，再拿到它的 `function` 子对象。

**调用链长这样：**

```
item = { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '...' } }
         ↓ asRecord
record = { id, type, function }
         ↓ asRecord(record.function)
fn = { name, arguments }
```

**为什么要逐层 `asRecord` 而不是直接写 `item.function.name`？**

因为 `item` 是 `unknown`，直接访问属性编译就报错。而且**运行时可能是任意结构**（服务端返回畸形数据时）。

`asRecord` 的好处：**任何一层缺失或类型不对，都退化成空对象**，不会抛错。

```ts
const id = typeof record.id === 'string' && record.id !== '' ? record.id : `call_${index}`
```

**这一行做了三件事**：

1. 判断 `record.id` 是字符串
2. 判断它不是空串
3. 都不是就用**兜底值** `` `call_${index}` ``

**为什么要兜底？**

因为 `id` 是回灌时必须带的（否则模型分不清结果对应哪次调用）。**如果服务端没给 id，我们自己造一个。** 用 `index` 造，保证同一次响应里唯一。

**模板字符串 `` `call_${index}` ``** —— 反引号包裹，`${}` 里放表达式。

```ts
const name = typeof fn.name === 'string' ? fn.name : ''
```

**没有名字的工具调用是无意义的，但也不该崩。** 给空串，第 2 步的注册表会报"未知工具 ""。可用工具：..." —— **一个清楚的错误，而不是崩溃**。

```ts
const raw = typeof fn.arguments === 'string' ? fn.arguments : ''
```

**先把原始字符串抓出来**（如果它是字符串的话）。

**注意**：`raw` 在这里只是"原串的副本"，稍后判断要不要用它。

```ts
const parsed = parseArguments(fn.arguments)
```

**注意传的是 `fn.arguments`（原始的 unknown），不是 `raw`。**

**为什么？** 因为 `parseArguments` 自己会处理"不是字符串"的情况（比如 Anthropic 直接给对象）。如果传 `raw`，那些情况就全变成空串了。

```ts
return {
  id,
  name,
  arguments: parsed.value,
  rawArguments: raw !== '' ? raw : JSON.stringify(parsed.value),
  parseError: parsed.error,
}
```

最后一个字段值得说：

```ts
rawArguments: raw !== '' ? raw : JSON.stringify(parsed.value)
```

**逻辑**：原串非空就用原串；原串是空的（说明参数本来就是对象），就把解析出的对象序列化成字符串存起来。

**为什么要这么做？** 为了让 `rawArguments` **永远是一个可用的字符串** —— 这样 `toWireMessages` 里那句 `call.rawArguments !== '' ? ... : ...` 在大多数情况下都会走"用原串"分支。

**这是一条"降低下游分支复杂度"的技巧**：上游多做一个归一化，下游就少一个分支。

---

### 3.12 小结：到这里你已经读完了一半

到这里，你已经读完：

```
✅ 第 1 节  消息与响应的全部类型        （3.2 – 3.6）
✅ 第 2 节  错误分类与 LLMError 类      （3.7 – 3.8）
✅ 第 3 节  线格式翻译 toWireMessages   （3.9）
✅ 第 4 节  参数解析 parseArguments     （3.10 – 3.11）
⬜ 第 5 节  Provider 与两个实现          （3.13 – 3.16，接着往下）
```

**在继续之前，请先做一件事**：把 `src/kernel/llm.ts` 打开，从第 1 行开始往下读，**一边读一边和上面的讲解对照**。

如果某一段你读了讲解也不明白，**停下来**告诉我 —— 不要带着疑问往下走。后面的每一步都建立在这一步之上。

---

### 3.13 `Provider` 接口（第 197–209 行）

```ts
/** 任何模型后端的统一接口。agent 只认这个接口，不认具体厂商。 */
export interface Provider {
  /**
   * 发一轮请求。
   * @param messages 到目前为止的全部对话（模型本身是无状态的，每次都全发）。
   * @param tools 模型可用的工具 schema 列表；不传表示这轮不给工具。
   */
  chat(messages: readonly ChatMessage[], tools?: readonly Record<string, unknown>[]): Promise<LLMResponse>
}
```

**这是整个文件、乃至整个项目最重要的 13 行。**

#### 逐部分拆解签名

```ts
chat(
  messages: readonly ChatMessage[],                          // 参数 1
  tools?: readonly Record<string, unknown>[],                // 参数 2（可选）
): Promise<LLMResponse>                                      // 返回值
```

**参数 1：`messages: readonly ChatMessage[]`**

- 为什么是数组而不是单个字符串：因为模型无状态，每次要发**全部历史**
- 为什么 `readonly`：Provider 不该修改调用方的历史

**参数 2：`tools?: readonly Record<string, unknown>[]`**

`?` 表示可选。**这个参数的存在本身就是设计决策**：

| 传法 | 含义 |
|---|---|
| 不传 | 这轮不给模型任何工具（纯对话） |
| 传 `[]`（空数组） | 同上，但显式写了 |
| 传 `[{type:'function', function:{...}}]` | 给这些工具 |

**返回值：`Promise<LLMResponse>`**

- `Promise<T>` = "将来会有一个 T"
- 必须异步，因为网络请求

#### 为什么接口里只有一个方法

**因为这一层只负责一件事：把消息发出去，把响应拿回来。**

对比一下如果接口设计成大而全：

```ts
interface Provider {          // ← 不要这样
  chat(...): Promise<LLMResponse>
  chatStream(...): AsyncIterable<Chunk>      // 流式
  embed(...): Promise<number[]>              // 向量化
  countTokens(...): number                   // 数 token
  listModels(): Promise<string[]>            // 列模型
}
```

问题：

1. **每个实现都要实现全部方法**，即使它不支持（比如 mock 不需要 `listModels`）
2. **接口变成"厂商能力清单"**，而不是"agent 需要什么"
3. 加一个能力就要改所有实现

**原则：接口应该由"消费者需要什么"决定，不由"提供者有什么"决定。**

DSH 里对应的是 `ctx.llm` 服务，它的接口比我们大（有 `prepareCall`、流式等），但那些都是 **agent 循环真正需要的**，不是"厂商有什么就塞什么"。

#### `@param` 注释里的那句话很重要

```
@param messages 到目前为止的全部对话（模型本身是无状态的，每次都全发）。
```

**这句话是在提醒读者模型的第一原理。** 一个不了解"模型无状态"的人，可能会写出"只发最新一条消息"的代码，然后奇怪为什么模型不记得上下文。

**注释要写"容易搞错的契约"，不是"重复代码"。**

---

### 3.14 `MockStep` 与 `MockProvider`（第 211–267 行）

```ts
/** 脚本里的一步：模型这一轮「打算」做什么。 */
export interface MockStep {
  content?: string
  toolCalls?: { name: string; arguments?: Record<string, unknown> | string }[]
  usage?: LLMUsage
}

export class MockProvider implements Provider {
  #script: MockStep[]
  /** 每次调用收到的消息快照。用来断言「模型到底看到了什么」。 */
  readonly seenMessages: ChatMessage[][] = []
  /** 每次调用收到的工具 schema。 */
  readonly seenTools: Record<string, unknown>[][] = []

  constructor(script: readonly MockStep[]) {
    this.#script = [...script]
  }

  async chat(
    messages: readonly ChatMessage[],
    tools?: readonly Record<string, unknown>[],
  ): Promise<LLMResponse> {
    this.seenMessages.push(messages.map((message) => ({ ...message })))
    this.seenTools.push([...(tools ?? [])])

    const step = this.#script.shift()
    if (step === undefined) {
      throw new LLMError('EMPTY_RESPONSE', 'mock 脚本已用完，但 agent 还在请求下一步')
    }

    // mock 也走和真实响应完全相同的解析路径，这样演示里出现的结构一定是真的。
    const wireToolCalls = (step.toolCalls ?? []).map((call) => ({
      id: '',
      function: {
        name: call.name,
        arguments: typeof call.arguments === 'string'
          ? call.arguments
          : JSON.stringify(call.arguments ?? {}),
      },
    }))

    return {
      content: step.content ?? '',
      toolCalls: wireToolCalls.map((item, index) => toToolCall(item, index)),
      usage: step.usage ?? {},
    }
  }
}
```

#### `MockStep`：让人写脚本的"友好格式"

```ts
export interface MockStep {
  content?: string                                                    // 说什么
  toolCalls?: { name: string; arguments?: Record<string, unknown> | string }[]   // 调什么
  usage?: LLMUsage                                                    // 用量
}
```

**注意 `arguments` 的类型：`Record<string, unknown> | string`**

**它接受两种形式**：

```ts
// 形式 A：给对象（人写起来舒服）
{ name: 'read_file', arguments: { path: 'a.txt' } }

// 形式 B：给字符串（用来测试"坏 JSON"场景！）
{ name: 'read_file', arguments: '{"path": "a.txt",}' }    // ← 故意的坏 JSON
```

**形式 B 是关键**：它让你能**构造出真实世界里会发生的失败**，来测试你的错误处理。

这正是第 0.2 节说的"坑 1"的解法 —— **没有这个能力，你根本没法测"参数解析失败"的分支**。

#### 三个私有/只读字段

```ts
#script: MockStep[]
readonly seenMessages: ChatMessage[][] = []
readonly seenTools: Record<string, unknown>[][] = []
```

**`#script` 用 `#` 前缀（真私有）**

```ts
#script: MockStep[]        // ← 外部访问 p.#script 会被语法拒绝
```

对比 TS 的 `private` 关键字：

| 写法 | 运行时保护 | 类型擦除后 |
|---|---|---|
| `private script` | ❌ 无（编译期检查） | 属性依然存在、可访问 |
| `#script` | ✅ 有（JS 原生） | **依然私有** |

**为什么这里必须用 `#`？** 因为 `#script` 会被**消费**（`shift()` 会改变它）。用 `private` 的话，运行时任何人还是能改它，破坏 mock 的确定性。

**`seenMessages` 和 `seenTools` 是 `readonly` 公有字段**

它们**故意公开** —— 因为这是 mock 的核心价值：

```ts
this.seenMessages.push(...)       // 内部写入
// 外部读取：
provider.seenMessages[0]          // 第一次调用时，模型看到了什么
```

**这两个字段是"可断言的事实"。** 第 8 步会用它们来验证：

```
断言：第 2 次请求时，模型应该看到 4 条消息（system + user + assistant + tool）
      provider.seenMessages[1].length === 4
```

**这就是"可测试性"的具体形态** —— 不是一个抽象的美德，而是一个具体字段。

#### 构造函数：为什么要复制数组

```ts
constructor(script: readonly MockStep[]) {
  this.#script = [...script]
}
```

**`[...script]` 是浅拷贝。**

**为什么不做 `this.#script = script`？**

因为 `#script` 会被 `shift()` 修改。如果直接赋值，就会**修改调用方传进来的那个数组**：

```ts
const script = [{ content: 'a' }, { content: 'b' }]
const provider = new MockProvider(script)     // 如果不拷贝
await provider.chat([])                       // 内部 shift() 一次
console.log(script.length)                    // → 1 ！调用方的数组被改了
```

**这类 bug 极其难查**：你的脚本变量在别处被悄悄消费掉了。

**`[...script]` 一行代码解决。代价：一次复制（对几十个元素的数组而言可忽略）。**

#### `chat()` 逐行

```ts
this.seenMessages.push(messages.map((message) => ({ ...message })))
```

**逐个拆**：

| 片段 | 作用 |
|---|---|
| `messages.map(...)` | 遍历消息数组，产出新数组 |
| `({ ...message })` | **展开运算符**：复制这条消息的所有字段 |
| 外层 `push(...)` | 把复制后的数组存进 `seenMessages` |

**为什么每条消息也要复制（`{ ...message }`）？**

因为调用方在后续轮次里**会继续改它的消息数组**。如果不复制，`seenMessages[0]` 里存的其实是"那个数组的第 0 个元素当时的样子"——而对象是引用，后续被改的话，你回头看的"快照"就变了。

**这是"快照"的完整含义**：不只是数组结构，元素本身也要复制。

**注意这是浅拷贝**：如果某条消息的 `toolCalls` 数组被改，快照还是会变。**要完全隔离需要深拷贝**，但我们接受浅拷贝 —— 因为工具调用一旦确定不会被改（这正是前面 `readonly` 要保证的事）。

```ts
this.seenTools.push([...(tools ?? [])])
```

- `tools ?? []`：`??` 是**空值合并运算符** —— 只在左边是 `null` 或 `undefined` 时用右边
- 为什么不写 `tools || []`：`||` 会把**空数组**（truthy）也正确保留，但会把 `''`、`0` 这类值当假。这里两者等价，但 `??` 表达的是"没有就用空数组"，语义更准

```ts
const step = this.#script.shift()
if (step === undefined) {
  throw new LLMError('EMPTY_RESPONSE', 'mock 脚本已用完，但 agent 还在请求下一步')
}
```

**`Array.prototype.shift()` 从数组头部取出并移除一个元素。**

**为什么用 `shift` 而不是 `[index]` 加计数器？**

因为脚本是**按顺序消费**的。`shift` 天然表达"取走下一个"。

**注意 `if (step === undefined)` 这个检查是必须的** —— 因为 `TS` 下 `shift()` 返回 `MockStep | undefined`（数组可能为空）。

**这里抛的错误很讲究**：

```
'EMPTY_RESPONSE', 'mock 脚本已用完，但 agent 还在请求下一步'
```

**为什么用 `EMPTY_RESPONSE` 这个 code？**

因为它本质上是"请求了但没有内容可给"。更重要的是：**它让"脚本写短了"这个测试错误，表现得和真实 API 的一种失败（服务端返回空）一模一样** —— 于是你可以顺便测试第 9 步的重试逻辑对它的反应。

**报错信息 "但 agent 还在请求下一步" 说明了什么？**

说明**是 agent 请求太多了**（而不是 mock 坏了）。这句话直接指向问题所在：你写的脚本步数不够。

```ts
const wireToolCalls = (step.toolCalls ?? []).map((call) => ({
  id: '',
  function: {
    name: call.name,
    arguments: typeof call.arguments === 'string'
      ? call.arguments
      : JSON.stringify(call.arguments ?? {}),
  },
}))
```

**这段是在"伪造服务端返回的结构"。**

**注意 `id: ''`（空串）。**

为什么给空串而不是直接生成 `call_0`？

因为**后面的 `toToolCall` 会兜底生成**（`record.id !== '' ? record.id : \`call_${index}\``）。**让兜底逻辑也走一遍真实路径** —— 这样 mock 和真实的差异更小。

**`arguments` 的三元表达式**：

```ts
typeof call.arguments === 'string'
  ? call.arguments                          // 字符串 → 原样传（保留坏 JSON！）
  : JSON.stringify(call.arguments ?? {})    // 对象 → 序列化
```

**第一支是关键**：如果脚本里给的是坏 JSON 字符串，**原样传给 `toToolCall`**，于是会走真实的解析失败路径。

**这就实现了"mock 与真实走同一条解析路径"** —— 注释里那句「这样演示里出现的结构一定是真的」就是这个意思。

**为什么这条很重要？**

如果 mock 自己造解析好的对象，那么：

- 演示里看到的 `parseError` 字段永远是空的
- 你在 mock 环境测不出参数解析的 bug
- **mock 通过 ≠ 真实环境通过**

**"测试替身必须走真实路径"是测试设计的一条铁律。**

```ts
return {
  content: step.content ?? '',
  toolCalls: wireToolCalls.map((item, index) => toToolCall(item, index)),
  usage: step.usage ?? {},
}
```

**三处 `?? `**：把可选字段的 `undefined` 归一化成"空值"，保证返回的对象形状固定：

| 字段 | 归一化 |
|---|---|
| `content` | `undefined` → `''` |
| `usage` | `undefined` → `{}` |
| `toolCalls` | 由 `wireToolCalls` 保证是数组 |

**为什么要归一化？** 因为**下游不该处理 `undefined`**。让"上游多写三行"换"下游少写一堆判断"。

（注意：`toolCalls` 已经通过 `step.toolCalls ?? []` 保证是数组了。）

---

### 3.15 `DeepSeekProviderOptions`（第 273–285 行）

```ts
export interface DeepSeekProviderOptions {
  /** API key。绝不写进代码，从环境变量读。 */
  apiKey: string
  /** 接口根地址。默认官方地址。 */
  baseUrl?: string
  /** 模型名。 */
  model?: string
  /** 采样温度。0 最确定，适合 agent。 */
  temperature?: number
  /** 单次请求超时毫秒数。 */
  timeoutMs?: number
}
```

**只有 `apiKey` 是必填（没有 `?`），其余都有默认值。**

**为什么这么设计？**

| 参数 | 必填的理由 |
|---|---|
| `apiKey` | **没有它一定失败**，让它必填能在编译期就拦住"忘记传 key" |

其余的都是"有合理默认值"的配置项。

**注意 `apiKey` 注释里那句「绝不写进代码，从环境变量读」。**

这是**安全纪律写在类型定义旁边** —— 读到这里的人会看到，而不是去翻文档。

**`baseUrl` 存在的意义**：可以指向自建代理、兼容网关、或者本地模型。

---

### 3.16 `DeepSeekProvider`（第 287–355 行）

```ts
export class DeepSeekProvider implements Provider {
  #apiKey: string
  #baseUrl: string
  #model: string
  #temperature: number
  #timeoutMs: number

  constructor(options: DeepSeekProviderOptions) {
    this.#apiKey = options.apiKey
    // rstrip 掉结尾斜杠，避免拼出 //chat/completions
    this.#baseUrl = (options.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '')
    this.#model = options.model ?? 'deepseek-chat'
    this.#temperature = options.temperature ?? 0
    this.#timeoutMs = options.timeoutMs ?? 120_000
  }

  async chat(
    messages: readonly ChatMessage[],
    tools?: readonly Record<string, unknown>[],
  ): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.#model,
      messages: toWireMessages(messages),
      temperature: this.#temperature,
    }
    if (tools !== undefined && tools.length > 0) {
      body.tools = tools
      // auto：让模型自己决定这轮是回答问题还是调用工具。
      body.tool_choice = 'auto'
    }

    let response: Response
    try {
      response = await fetch(`${this.#baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify(body),
        // AbortSignal.timeout 到点自动中断请求，抛出的错误 name 是 TimeoutError。
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch (cause) {
      throw toTransportError(cause, this.#timeoutMs)
    }

    const text = await response.text()
    if (!response.ok) {
      throw new LLMError(
        codeForStatus(response.status),
        `HTTP ${response.status} ${response.statusText} <- ${this.#baseUrl}/chat/completions\n${text.slice(0, 800)}`,
        {
          status: response.status,
          retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
        },
      )
    }

    let data: unknown
    try {
      data = JSON.parse(text)
    } catch (cause) {
      throw new LLMError('INVALID_REQUEST', `响应不是合法 JSON：${text.slice(0, 400)}`, { cause })
    }
    return parseCompletion(data)
  }
}
```

#### 五个私有字段与构造函数

```ts
#apiKey: string
#baseUrl: string
#model: string
#temperature: number
#timeoutMs: number
```

**全部用 `#`（真私有）**。理由：这些是**实现细节**，外部只能通过 `chat()` 使用它们。

**记住前面说过的规则**：这些声明在运行时会被擦除，属性由构造函数里的赋值创建。

**构造函数里的四行归一化**：

```ts
this.#baseUrl = (options.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '')
```

**两个操作**：

1. `?? 'https://api.deepseek.com'` —— 没给就用官方地址
2. `.replace(/\/+$/, '')` —— 去掉结尾的一个或多个斜杠

**正则 `/\/+$/` 逐部分**：

| 片段 | 含义 |
|---|---|
| `/` | 正则开始 |
| `\/` | 匹配字符 `/`（转义，因为 `/` 在正则里有特殊含义） |
| `+` | 前面的字符出现一次或多次 |
| `$` | 字符串结尾 |
| `/` | 正则结束 |

**为什么要去掉结尾斜杠？**

因为下面拼接时是 `` `${this.#baseUrl}/chat/completions` ``。如果用户传了 `https://api.deepseek.com/`，会拼出：

```
https://api.deepseek.com//chat/completions
//                     ↑ 双斜杠
```

**多数服务端能容忍，但有些会 404。** 一行代码消除不确定性。

**注意 `120_000` 的数字分隔符** —— JS 允许用 `_` 分隔数字提高可读性。等于 `120000`（120 秒）。

**为什么默认超时这么长？** 因为 LLM 生成可能很慢（尤其是长回答 + 高 reasoning effort）。

#### `chat()` 的四段

**第一段：组装请求体**

```ts
const body: Record<string, unknown> = {
  model: this.#model,
  messages: toWireMessages(messages),      // ← 这里用了翻译函数
  temperature: this.#temperature,
}
if (tools !== undefined && tools.length > 0) {
  body.tools = tools
  body.tool_choice = 'auto'
}
```

**注意几点**：

1. **类型标注 `Record<string, unknown>` 是必须的** —— 否则 TS 会把 `body` 推断成 `{model: string; messages: ...; temperature: number}`，那么后面 `body.tools = tools` 就会报错（该对象没有 `tools` 属性）

2. **`tools` 的两个条件**：不为 undefined **且** 非空数组。只判 undefined 的话，传空数组也会加上 `tools: []` 和 `tool_choice: 'auto'` —— 有些服务端对 `tool_choice: 'auto'` + 空 `tools` 会报错

3. **`tool_choice: 'auto'` 的含义**：让模型**自己决定**这轮是回答问题还是调用工具。其它取值：`'none'`（禁止调用）、`'required'`（必须调用）、或者指定具体某个函数

**第二段：发请求**

```ts
let response: Response
try {
  response = await fetch(`${this.#baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.#apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(this.#timeoutMs),
  })
} catch (cause) {
  throw toTransportError(cause, this.#timeoutMs)
}
```

**`let response: Response` 声明在外面** —— 和 `parseArguments` 里 `let parsed: unknown` 同样的理由：要在 `try` 外面用。

**四个请求参数**：

| 参数 | 值 | 说明 |
|---|---|---|
| `method` | `'POST'` | 必须大写字符串 |
| `headers` | 三个 | `Content-Type` 告诉服务端 body 是 JSON；`Authorization` 是 `Bearer <key>` 格式 |
| `body` | `JSON.stringify(body)` | **`fetch` 的 body 必须是字符串**（或 FormData 等），不能直接给对象 |
| `signal` | `AbortSignal.timeout(ms)` | **超时机制** |

**`AbortSignal.timeout()` 值得单独讲。**

它在指定毫秒后自动"中止"这个请求。抛出的错误 `name` 是 `'TimeoutError'`。

**它为什么比手写 `setTimeout` 好？**

```ts
// 手写版（不要这样）
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), ms)
try {
  await fetch(url, { signal: controller.signal })
} finally {
  clearTimeout(timer)      // ← 必须记得清理，否则计时器泄漏
}
```

手写版要管三件事：创建 controller、设计时器、**清理计时器**。忘记 `clearTimeout` 会导致进程无法退出（计时器还挂着）。

`AbortSignal.timeout()` **一行搞定，且不需要清理**。这是 Node 18+ 的标准能力。

**`Authorization: \`Bearer ${this.#apiKey}\``**

模板字符串拼接。`Bearer ` 后面**有一个空格**，这是 HTTP 认证的标准格式。

**`catch (cause) { throw toTransportError(cause, this.#timeoutMs) }`**

**注意这里把原始错误"翻译"了一遍**，而不是直接往上抛。

**为什么要翻译？** 因为 `fetch` 抛的错误对上层没有意义：

```
TypeError: fetch failed
  cause: Error: connect ECONNREFUSED
```

上层要的是"这是 `TRANSPORT` 类错误，可以重试"。**翻译就是把技术错误变成领域错误。**

**第三段：检查 HTTP 状态**

```ts
const text = await response.text()
if (!response.ok) {
  throw new LLMError(
    codeForStatus(response.status),
    `HTTP ${response.status} ${response.statusText} <- ${this.#baseUrl}/chat/completions\n${text.slice(0, 800)}`,
    {
      status: response.status,
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
    },
  )
}
```

**`await response.text()` 而不是 `response.json()`。**

**为什么？** 因为**失败响应不一定是 JSON**（可能是 HTML 错误页、纯文本、甚至是空的）。如果直接 `.json()`，解析失败会抛出和 HTTP 错误无关的异常，掩盖真正的问题。

**先拿文本，再判断状态，成功时才 `JSON.parse`** —— 这个顺序能保证错误信息里带着服务端的原始响应。

**`if (!response.ok)`** —— `ok` 是 `status` 在 200–299 之间的布尔值。

**错误信息三段拼接**：

```
HTTP 429 Too Many Requests <- https://api.deepseek.com/chat/completions
{"error":{"message":"Rate limit reached...","type":"rate_limit_error"}}
```

| 片段 | 作用 |
|---|---|
| `HTTP 429 Too Many Requests` | 状态码 + 短语，一眼看出什么问题 |
| `<- https://...` | **哪个地址**失败了（有多 provider 时很重要） |
| `\n${text.slice(0, 800)}` | 服务端说的原话，截取前 800 字符 |

**`text.slice(0, 800)` 为什么要截断？**

因为错误信息最终可能被放进日志或显示给用户，**不确定长度的文本很危险**（有的服务端会返回几十 KB 的 HTML 错误页）。

800 是个经验值：足够包含服务端的错误说明，又不会失控。

**第四个参数（选项对象）**：

```ts
{
  status: response.status,                                  // 状态码
  retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),   // 服务端建议的等待
}
```

**`response.headers.get('retry-after')`** 返回 `string | null`。

注意 HTTP 头名**大小写不敏感**，但 `Headers.get()` 会帮你处理，写小写就行。

**第四段：解析成功响应**

```ts
let data: unknown
try {
  data = JSON.parse(text)
} catch (cause) {
  throw new LLMError('INVALID_REQUEST', `响应不是合法 JSON：${text.slice(0, 400)}`, { cause })
}
return parseCompletion(data)
```

**注意类型是 `let data: unknown`** —— JSON.parse 返回 `any`，但我们立刻标注成 `unknown`，**强制后续必须显式收窄**（交给 `parseCompletion` 处理）。

**这里的 code 用 `INVALID_REQUEST` 其实不太准确**（服务端返回坏 JSON 不是"我们的请求有问题"）。**更好的选择是 `UNKNOWN` 或新加一个 `MALFORMED_RESPONSE`。**

**这是代码里一个真实的小瑕疵**，我在 L9 会再提一次。**你可以在重写时改掉它。**

---

### 3.17 四个辅助函数（第 357–419 行）

```ts
/** HTTP 状态码 → 失败分类。这张表就是「重试有没有意义」的判据。 */
function codeForStatus(status: number): LLMErrorCode {
  if (status === 429) return 'RATE_LIMIT'
  if (status === 401 || status === 403) return 'AUTH'
  if (status >= 500) return 'SERVER'
  if (status >= 400) return 'INVALID_REQUEST'
  return 'UNKNOWN'
}
```

**注意判断顺序是有讲究的**：

```
429  → RATE_LIMIT         （先判，因为它是 4xx 里的特例）
401/403 → AUTH            （再判，也是 4xx 特例）
>=500 → SERVER            （服务端问题）
>=400 → INVALID_REQUEST   （其余客户端问题）
其它 → UNKNOWN
```

**如果顺序写反**（先判 `>=400` 再判 `429`），429 会被归成 `INVALID_REQUEST` —— 于是**限流不会被重试**。

**这类"顺序敏感的判定链"是最容易埋 bug 的地方。** 判断标准：**特例必须排在通例前面。**

**`if` 后面不写 `else`** —— 因为每个分支都 `return` 了，`else` 是多余的（也叫"卫语句"风格）。

```ts
/** 网络层异常 → 失败分类。 */
function toTransportError(cause: unknown, timeoutMs: number): LLMError {
  const name = cause instanceof Error ? cause.name : ''
  if (name === 'TimeoutError') {
    return new LLMError('TIMEOUT', `请求超过 ${timeoutMs}ms 未完成`, { cause })
  }
  if (name === 'AbortError') {
    return new LLMError('TRANSPORT', '请求被中止', { cause })
  }
  return new LLMError('TRANSPORT', `连接失败：${cause instanceof Error ? cause.message : String(cause)}`, { cause })
}
```

**为什么判断 `name` 而不是用 `instanceof`？**

因为 `TimeoutError` 和 `AbortError` 是 **DOMException**（Web 标准的错误类型）。在 Node 里它们存在，但：

- 不同 Node 版本、不同运行时（浏览器/Node/Deno）里，
  它们可能来自不同的构造函数
- `instanceof` 在某些边界情况下不可靠（比如多个 realm）

**判断 `name` 字符串是最稳的做法。**

**`TimeoutError` 和 `AbortError` 的区别**：

| name | 谁抛的 | 语义 |
|---|---|---|
| `TimeoutError` | `AbortSignal.timeout()` 到点 | 超时，**应该重试** |
| `AbortError` | 手动的 `controller.abort()` | 用户/程序主动取消，**不该重试** |

**我们把 AbortError 归成 `TRANSPORT` 是权宜之计** —— 严格说"被取消"不该重试。

**正确做法**：加一个 `CANCELLED` code，第 9 步的重试策略把它排除在可重试集合外。

**这是第二个真实瑕疵**，L9 会列出。

```ts
/** 解析 Retry-After 响应头。它可能是秒数，也可能是 HTTP 日期。 */
function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000))
  const at = Date.parse(header)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - Date.now())
}
```

**这个函数处理 HTTP 规范里的两种情况**：

```
Retry-After: 3                              ← 秒数
Retry-After: Wed, 21 Oct 2015 07:28:00 GMT  ← HTTP 日期
```

**逐行**：

```ts
const seconds = Number(header)
```

- `Number('3')` → `3`
- `Number('Wed, 21 Oct...')` → **`NaN`**（不是数字）

```ts
if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000))
```

- `Number.isFinite`：检查是不是有限数字（排除 `NaN`、`Infinity`）
- `Math.round(seconds * 1000)`：秒 → 毫秒
- `Math.max(0, ...)`：**保证不返回负数**

**为什么要有 `Math.max(0, ...)`？** 服务端可能返回 `0` 或负数（bug 或恶意），负的等待时间会导致 `setTimeout` 立即执行，可能引发重试风暴。

```ts
const at = Date.parse(header)
if (Number.isNaN(at)) return undefined
return Math.max(0, at - Date.now())
```

- `Date.parse` 解析日期字符串成毫秒时间戳
- 解析不出来 → `NaN` → 返回 `undefined`（让上层用自己的退避）
- 成功 → `目标时间 - 当前时间` = 还要等多久

**`Math.max(0, ...)` 在这里更重要**：如果服务端给的日期**已经过去了**，差值会是负数。

**这个函数总共 8 行，处理了：空值、秒数、日期、负数、无法解析。** 这是"边界情况的完整覆盖"的范例。

```ts
/** 把 /chat/completions 的响应体解析成 LLMResponse。 */
function parseCompletion(data: unknown): LLMResponse {
  const record = asRecord(data)
  const choices = record.choices
  if (!Array.isArray(choices) || choices.length === 0) {
    const error = record.error
    throw new LLMError(
      'EMPTY_RESPONSE',
      error === undefined ? '响应缺少 choices 字段' : `服务端返回错误：${JSON.stringify(error)}`,
    )
  }

  const message = asRecord(asRecord(choices[0]).message)
  const rawContent = message.content
  const content = typeof rawContent === 'string' ? rawContent : ''
  const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []

  return {
    content,
    toolCalls: rawToolCalls.map((item, index) => toToolCall(item, index)),
    usage: toUsage(message.usage),
  }
}
```

**为什么单独一个函数？** 因为它处理的是"响应体结构"这个独立关注点，而且很复杂（十几行判断）。放在 `chat()` 里会让主流程难读。

**`if (!Array.isArray(choices) || choices.length === 0)`**

**两种情况都算失败**：

1. `choices` 不是数组（字段缺失或类型错）
2. `choices` 是空数组

**注意这里给出了两种错误消息**：

```ts
error === undefined ? '响应缺少 choices 字段' : `服务端返回错误：${JSON.stringify(error)}`
```

因为**"没有 choices"可能是因为服务端在 `error` 字段里放了错误信息**：

```json
{ "error": { "message": "Invalid API key", "type": "authentication_error" } }
```

把这段透传出来，比只说"缺少 choices"有用得多。

**`const message = asRecord(asRecord(choices[0]).message)`**

**这一行连着两次 `asRecord`**，读法是从内到外：

```
choices[0]                      → 第一个候选结果（unknown）
asRecord(choices[0])            → 当作对象
asRecord(...).message           → 取 message 字段（unknown）
asRecord(...)                   → 再当作对象
```

**任何一层缺失都会退化成空对象**，后面读 `.content` 得到 `undefined`，被下一个判断处理成 `''`。**整条链路不会抛错。**

```ts
const rawContent = message.content
const content = typeof rawContent === 'string' ? rawContent : ''
```

**为什么要多一个中间变量？**

因为 `message.content` 的类型是 `unknown`，直接用需要类型收窄。分两步写，收窄更清楚。

**这个判断在挡什么？** 某些服务端（旧版 OpenAI、部分兼容实现）会返回**内容数组**：

```json
"content": [{ "type": "text", "text": "你好" }]
```

严格处理应该把数组的文本拼起来。**我们的实现直接丢弃（变成空串）** —— 这会让"模型明明有回答但我们看到空"。

**这是第三个真实瑕疵。** 修法是加一个归一化分支。**DSH 的实现处理了这种情况**（它的 `content` 解析更完整）。

```ts
const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
```

**归一化成数组**，保证下面 `.map` 不会崩。

```ts
return {
  content,
  toolCalls: rawToolCalls.map((item, index) => toToolCall(item, index)),
  usage: toUsage(message.usage),
}
```

**注意 `map` 传了 `index`。** 因为 `toToolCall` 需要它来兜底生成 id。

```ts
/** 只保留数字字段的用量字典。 */
function toUsage(value: unknown): LLMUsage {
  const out: LLMUsage = {}
  for (const [key, entry] of Object.entries(asRecord(value))) {
    if (typeof entry === 'number') out[key] = entry
  }
  return out
}
```

**`Object.entries()` 把对象变成 `[键, 值][]`**，配合 `for...of` 遍历。

**为什么用 `for...of` 而不是 `.reduce()` 或 `.forEach()`？**

因为这里**有副作用**（往 `out` 里写）。用 `reduce` 也可以，但读起来更绕。`for...of` 最直白。

**`if (typeof entry === 'number')` 这一行在过滤什么？**

有些服务端会在 `usage` 里放非数字字段（比如嵌套的详情对象）：

```json
"usage": {
  "prompt_tokens": 30,
  "completion_tokens": 18,
  "prompt_tokens_details": { "cached_tokens": 20 }    ← 对象，会被过滤掉
}
```

**过滤保证 `LLMUsage`（`Record<string, number>`）的类型承诺成立** —— 否则运行时会混进对象，后面做数值累加就会得到 `NaN`。

**这是"在边界处校验，保证内部类型诚实"的例子。**

---

## L4 运行与验证

### 4.1 怎么运行

```powershell
cd D:\agent-harness-lab
node src/demos/demo-llm.ts
```

**不需要联网**（演示 5 会尝试联网，但没 key 时自动跳过）。

### 4.2 五组演示逐条解读

#### 演示 1 · 普通问答

```ts
const talker = new MockProvider([
  { content: '你好，我是被 mock 出来的模型。', usage: { prompt_tokens: 12, completion_tokens: 9 } },
])
const answer = await talker.chat(askWhat)
```

**你会看到**：

```json
{
  "content": "你好，我是被 mock 出来的模型。",
  "toolCalls": [],
  "usage": { "prompt_tokens": 12, "completion_tokens": 9 }
}
```

**要观察的三件事**：

1. `toolCalls` 是**空数组**（不是 `undefined`）—— 验证了归一化
2. `usage` 原样带出来了
3. **整个对象的结构和真实 API 返回的一模一样**（因为走的是同一条解析路径）

#### 演示 2 · 模型要求调用工具

```ts
const caller = new MockProvider([
  { content: '', toolCalls: [{ name: 'read_file', arguments: { path: 'src/llm.ts' } }] },
  { content: '这个文件一共 300 行。' },
])
const firstTurn = await caller.chat(wantToRead)
```

**你会看到**：

```json
{
  "id": "call_0",
  "name": "read_file",
  "arguments": { "path": "src/llm.ts" },
  "rawArguments": "{\"path\":\"src/llm.ts\"}",
  "parseError": ""
}
```

**要观察的四件事**：

| 观察点 | 说明了什么 |
|---|---|
| `id` 是 `"call_0"` | 脚本没给 id，`toToolCall` 用 index 兜底生成了 |
| `arguments` 是**对象** | 解析成功 |
| `rawArguments` 是**字符串** | 原始串被保留下来了 |
| `parseError` 是**空串** | "无错误"的表示方式 |

**注意 `content` 是空串** —— 因为脚本里写的是 `content: ''`。这正是"模型决定调工具时常常不写正文"的还原。

#### 演示 3 · 坏 JSON（**最重要的一组**）

```ts
const broken = new MockProvider([
  { toolCalls: [{ name: 'read_file', arguments: '{"path": "src/llm.ts",}' }] },
])
```

**注意脚本里 `arguments` 传的是字符串** `'{"path": "src/llm.ts",}'` —— **结尾多了一个逗号**。

**你会看到**：

```json
{
  "arguments": {},
  "rawArguments": "{\"path\": \"src/llm.ts\",}",
  "parseError": "arguments 不是合法 JSON：Expected double-quoted property name in JSON at position 22 (line 1 column 23)"
}
```

**要观察的三件事**：

1. `arguments` 是空对象（解析失败）
2. **`rawArguments` 保留了坏 JSON 原文**（回灌时要用）
3. `parseError` 里**带着出错位置**（`position 22`）

**这组演示证明了整个设计闭环**：

```
坏输入 → 不崩溃 → 存下原文 → 记下原因 → 可以回灌给模型自我纠正
```

**如果你要做科研对比实验**（干预 vs 自我修正），这一组就是你最基础的"自我修正"素材。

#### 演示 4 · 错误分类

```ts
const empty = new MockProvider([])
try { await empty.chat(askWhat) } catch (cause) { /* ... */ }
```

**空脚本意味着第一次调用就会抛**。你会看到：

```
code:    EMPTY_RESPONSE
message: mock 脚本已用完，但 agent 还在请求下一步
```

**要观察的**：错误是**带分类的**（`code` 不是笼统的字符串）。

**如果第 9 步接上重试**，这个错误会被判定为"可重试"，于是重试 5 次 —— 这就是**用测试错误类型验证重试逻辑**的方法。

#### 演示 5 · 真实调用

没配 key 时会跳过并打印提示：

```
未检测到 DEEPSEEK_API_KEY，跳过。
想跑通这一步，先设置环境变量（PowerShell）：
  $env:DEEPSEEK_API_KEY = "sk-你的key"
  node src/demos/demo-llm.ts
```

**配了 key 的话**，它会真实调用并打印 `content` 和 `usage`。

**注意这段代码的写法**：

```ts
const apiKey = process.env.DEEPSEEK_API_KEY
if (apiKey === undefined || apiKey === '') {
  console.log('未检测到 DEEPSEEK_API_KEY，跳过。')
  // ... 返回
  return
}
```

**先判断再使用** —— 这样 TS 在后面就知道 `apiKey` 一定是 `string`（类型收窄）。

**如果写成 `const apiKey = process.env.DEEPSEEK_API_KEY!`（非空断言）**，那么没配 key 时会真的去调 API，报一个"401 未授权"—— **一个和真实原因（你没配 key）无关的错误**。

#### 最后那段"证明模型看到了什么"

```ts
show('MockProvider 记录下来的第 1 次请求消息数', talker.seenMessages[0]?.length ?? 0)
show('MockProvider 看到的第 1 条消息', talker.seenMessages[0]?.[0])
```

**输出**：

```
--- MockProvider 记录下来的第 1 次请求消息数 ---
2

--- MockProvider 看到的第 1 条消息 ---
{ "role": "system", "content": "你是一个简洁的助手。" }
```

**这一段是本步最有价值的断言**：

> **模型看到的 = 我们发出去的那两条消息。**

`2` 这个数字不是随便的：演示 1 里 `askWhat` 有两条消息（system + user）。**如果这个数字变成 1 或 3，说明消息拼接有 bug。**

**注意 `?.` 和 `??`**：

```ts
talker.seenMessages[0]?.length ?? 0
```

- `seenMessages[0]` 可能是 `undefined`（数组为空）
- `?.length` 安全取长度，不抛错
- `?? 0` 兜底成 0

**这两个运算符的组合是"安全读取嵌套属性"的标准写法。**

### 4.3 验收判据

**逐条自查，全部通过才算学完这一步：**

| # | 判据 | 怎么验证 |
|---|---|---|
| 1 | 演示能跑通，五组输出符合上面的描述 | `node src/demos/demo-llm.ts` |
| 2 | 演示 3 的 `parseError` 非空且带位置信息 | 看输出 |
| 3 | 演示 4 捕获到 `LLMError` 且 `code === 'EMPTY_RESPONSE'` | 看输出 |
| 4 | `seenMessages[0].length === 2` | 看输出 |
| 5 | 你能说出"为什么 `arguments` 存了三份" | 口述 1 分钟 |
| 6 | 你能说出"为什么参数解析失败不抛异常" | 口述 1 分钟 |
| 7 | 你能说出"哪几个 `code` 可重试、为什么" | 口述 2 分钟 |
| 8 | 你能说出"`toWireMessages` 为什么必须存在" | 口述 1 分钟 |

**第 5–8 条是 L1 检验，第 9–10 条才是 L3：**

| # | 判据 | 怎么验证 |
|---|---|---|
| 9 | **关掉文档**，你能写出 `Provider` 接口和 `MockProvider` 的骨架 | 见 L6 |
| 10 | **关掉文档**，你能写出 `parseArguments` 的全部分支 | 见 L6 |

---

## L5 本篇 TypeScript 语法速查

**本篇出现的全部语法，一次查清。**

| 语法 | 例子 | 含义 | 注意 |
|---|---|---|---|
| `type` 别名 | `type Role = 'a' \| 'b'` | 定义类型 | 运行时被擦除 |
| 联合类型 | `'system' \| 'user'` | 取其中之一 | 常配合字面量 |
| `interface` | `interface ToolCall { ... }` | 对象结构 | 运行时被擦除 |
| 可选属性 | `name?: string` | 可能不存在 | 用前判断 |
| `readonly`（属性） | `readonly id: string` | 不能重新赋值 | 编译期 |
| `readonly`（数组） | `readonly T[]` | 不能 push | 和上面不是一回事 |
| `Record<K,V>` | `Record<string, number>` | 字典类型 | 键值类型都要给 |
| `unknown` | `value: unknown` | 未知类型 | **必须先检查** |
| `any` | `value: any` | 任意类型 | **本项目禁止** |
| `T[]` / `Array<T>` | `ChatMessage[]` | 数组 | 两种写法等价 |
| `string \| undefined` | `status: number \| undefined` | 可能是 undefined | 必须显式处理 |
| `class` | `class LLMError extends Error` | 类 | **运行时存在** |
| `extends` | `class A extends B` | 继承 | |
| `#field` | `#script: MockStep[]` | 真私有字段 | **运行时也私有** |
| `constructor` | `constructor(x: T) { }` | 构造函数 | |
| `implements` | `class A implements Provider` | 实现接口 | 编译期检查 |
| `export` | `export function f()` | 导出 | |
| `export type` | 同上但用于类型 | | 用 `import type` 导入 |
| `async` | `async chat(...)` | 异步函数 | 返回 Promise |
| `await` | `await fetch(...)` | 等待 | 只能在 async 内 |
| `Promise<T>` | `Promise<LLMResponse>` | 未来的值 | |
| `try/catch` | 见 `parseArguments` | 异常处理 | catch 参数是 `unknown` |
| `instanceof` | `cause instanceof Error` | 类型判断 | 作用在**值**上 |
| `typeof` | `typeof raw === 'string'` | 值的类型 | 返回字符串 |
| `as` | `raw as Record<...>` | 类型断言 | **运行时无检查** |
| `?? ` | `a ?? b` | 空值合并 | 仅 null/undefined |
| `?.` | `a?.b` | 可选链 | 空则整体为空 |
| `!` | `a!` | 非空断言 | **本项目尽量避免** |
| `...` 展开 | `{ ...msg }` / `[...arr]` | 浅拷贝 | |
| 模板字符串 | `` `call_${i}` `` | 插值 | 反引号 |
| 三元 | `a ? b : c` | 条件表达式 | 可嵌套（但别太深） |
| 箭头函数 | `(x) => x * 2` | 函数简写 | |
| 解构 | `const { a, b } = obj` | 取字段 | |
| `for...of` | `for (const [k,v] of entries)` | 遍历 | 数组/Map/entries |
| `Array.map` | `arr.map(f)` | 映射成新数组 | 不改原数组 |
| `Array.shift` | `arr.shift()` | 取头部元素并移除 | **会改原数组** |
| `Number.isFinite` | 判断有限数 | 排除 NaN/Infinity | |
| `Number.isNaN` | 判断 NaN | | |
| `Math.max` | `Math.max(0, x)` | 下界保护 | |
| 数字分隔符 | `120_000` | 提高可读性 | 等于 120000 |
| 正则 | `/\/+$/` | 匹配结尾斜杠 | |
| 正则替换 | `str.replace(re, '')` | 替换 | |

### 六条最容易踩的规则

**规则 1：`typeof null === 'object'`**

```ts
typeof null          // 'object'  ← JS 的历史 bug
```

所以判断对象必须写：

```ts
typeof x === 'object' && x !== null
```

**规则 2：`typeof [] === 'object'`**

数组也是 object。要单独判：

```ts
Array.isArray(x)
```

**规则 3：类型擦除下，`class` 的字段声明不创建属性**

```ts
class A {
  readonly x: string       // ← 运行时不存在
  constructor() {
    // 忘了 this.x = ...    → 访问 a.x 得到 undefined，不报错
  }
}
```

**规则 4：`readonly` 有两个位置，管两件事**

```ts
readonly items: readonly string[]
//  ↑ ①            ↑ ②
// ① 不能换数组   ② 不能 push
```

**规则 5：`never`/`unknown`/`any` 的区别**

| 类型 | 能赋什么给它 | 能用它做什么 |
|---|---|---|
| `any` | 任何值 | 任何操作（**放弃检查**） |
| `unknown` | 任何值 | 必须先收窄 |
| `never` | 什么都不能 | 只能抛出 |

**规则 6：`==` 和 `===`**

```ts
1 == '1'      // true   ← 类型转换，几乎总是错的
1 === '1'     // false  ← 严格比较
null == undefined   // true
null === undefined  // false
```

**本项目一律用 `===`／`!==`。** 唯一例外是判断 `== null`（同时覆盖 null 和 undefined）—— 但我们也不用，统一写显式的 `=== undefined`。

---

## L6 关文档重写判据（L3 检验）

**这是唯一能证明你"学会了"的检验。**

### 检验方式

```
1. 关掉 docs/ 目录和 src/kernel/llm.ts
2. 新建一个空文件 rewrite-llm.ts
3. 从零写出下面列出的部分
4. 写完再打开原文件对照
```

**允许**：查 `glossary.md`（术语不算作弊）
**禁止**：看 `src/kernel/llm.ts` 或 `docs/01-llm.md`

### 必须能写出的部分（按难度递增）

| 难度 | 要写的东西 | 通过标准 |
|---|---|---|
| ★ | `Provider` 接口 | 签名完全一致（参数类型、可选性、返回 Promise） |
| ★ | `Role` 类型 | 四个字面量的联合 |
| ★★ | `ToolCall` 接口 | **五个字段全对**，且说出每个为什么存在 |
| ★★ | `LLMError` 类 | 继承 Error、三个字段、构造函数设 `name` |
| ★★★ | `parseArguments` | **五个分支全对**，包括"必须是对象"那层 |
| ★★★ | `MockProvider` | 脚本消费、`seenMessages` 快照、**复用 `toToolCall`** |
| ★★★★ | `toWireMessages` | 三个分支、字段名翻译、`arguments` 的优先用原串 |
| ★★★★ | `DeepSeekProvider.chat` | 四段结构、超时、错误翻译、状态检查顺序 |

### 卡住时的自检问题

如果你卡在某一处，问自己：

| 卡在哪 | 问自己 |
|---|---|
| `parseArguments` 的分支 | "如果模型给的是 `null` 呢？给的是数组呢？给的是数字呢？" |
| `MockProvider` 的设计 | "我要怎么测试'参数是坏 JSON'这个场景？" |
| `toWireMessages` | "如果我在内部直接用 `tool_call_id`，将来换厂商要改几个文件？" |
| `DeepSeekProvider` 的错误处理 | "上层要判断'该不该重试'，它需要知道什么？" |

**答得出这些问题的答案，就说明你理解了设计；答不出，说明你在背代码。**

### 分级判定

| 写出来的程度 | 判定 | 下一步 |
|---|---|---|
| 能写出 ★★ 及以下 | 还不够 L3 | 重读 3.1–3.11，然后再试一次 |
| 能写出 ★★★ | 接近 L3 | 重点补 `toWireMessages` 和 `DeepSeekProvider.chat` |
| 全部写出（允许小错） | ✅ **达标** | 进入第 2 步 |

---

## L7 挑战题（不给答案）

**做不出来不要紧，但要想过。**

### 挑战 1 · 让 mock 支持"流式"

给 `MockProvider` 加一个 `chatStream()` 方法，把一条完整回复拆成多个分片依次返回。

**要求**：
- 用 `AsyncGenerator`（`async function*`）
- 分片之间有小延迟（模拟真实流式）
- `content` 拼接后等于原来那条完整回复

**思考**：为什么真实的流式下，`tool_calls` 的 `arguments` 会更难处理？

### 挑战 2 · 给 `ToolCall` 加"重试计数"

假设你要记录"这个工具调用被重试了几次"。

**问题**：
- 这个字段该加在 `ToolCall` 上吗？为什么？
- 如果加，它算"模型说过的事实"还是"我们的运行状态"？
- 第 7 步的会话日志会怎么处理这种字段？

**提示**：回到 1.5 节 —— `ToolCall` 代表的是"模型要求做什么"，不是"我们做了什么"。

### 挑战 3 · 修掉 L9 列出的三个瑕疵

不改接口，修掉下面三个问题（在 L9 有详细描述）：
1. 服务端返回 `content` 数组时的丢弃
2. `AbortError` 被归成 `TRANSPORT`
3. `parseArguments` 对数组的宽松

**要求**：每个修复都要说明"为什么原来的实现会出问题"，以及"修复引入了什么新代价"。

### 挑战 4 · 设计一个"成本预算"接口

假设你要给 Provider 加"这轮最多花多少 token"的限制。

**问题**：
- 加在 `Provider.chat()` 的参数里？还是包一层？
- 超预算时应该抛错，还是返回一个特殊的 `LLMResponse`？
- 这个决策和第 9 步的重试策略会不会冲突？

**这一题没有标准答案，它是第 9、10 步的预演。**

---

## L8 自检清单

**学完这一步，逐条打勾：**

### 理解层（L1）

- [ ] 我能说出"模型无状态"的三个推论
- [ ] 我能说出四种 role 各自的作用和"仅 xxx 使用"的字段
- [ ] 我能解释"为什么 `toolCallId` 必须有"
- [ ] 我能说出 `Provider` 抽象带来的两个具体好处
- [ ] 我能解释 `toWireMessages` 为什么必须存在、不集中会怎样
- [ ] 我能说出 `arguments` 存三份的理由
- [ ] 我能说出哪几个错误码可重试、为什么
- [ ] 我能解释 `retryAfterMs` 为什么值得单独存一个字段
- [ ] 我能解释 `cause` 链的作用

### 实现层（L3）

- [ ] 我关掉文档写出了 `Provider` 接口
- [ ] 我关掉文档写出了 `parseArguments` 的全部分支
- [ ] 我关掉文档写出了 `MockProvider`（含 `seenMessages` 快照）
- [ ] 我关掉文档写出了 `toWireMessages`
- [ ] 我能解释 `MockProvider` 为什么复用 `toToolCall`

### 语法层

- [ ] 我知道 `typeof null === 'object'` 这个坑
- [ ] 我知道 `readonly` 有两个位置、管两件事
- [ ] 我知道类型擦除下 `class` 字段声明不创建属性
- [ ] 我知道 `unknown` 和 `any` 的区别、为什么用前者
- [ ] 我会用 `?.` 和 `??` 做安全读取

### 工程层

- [ ] 我能说出"分诊"手法（换 mock 判断 bug 在哪层）
- [ ] 我知道为什么 mock 要"走真实解析路径"
- [ ] 我知道为什么构造函数要 `[...script]` 拷贝

---

## L9 仍未解决

**诚实列出这一步留下的坑。** 有些是"后面会解决"，有些是"当前实现的真实缺陷"。

### 会被后续步骤解决的

| 遗留问题 | 哪一步解决 |
|---|---|
| 模型可以"要求调用工具"，但**没有任何东西能执行它** | 第 2 步 |
| 没有重试：429 之后直接失败 | 第 9 步 |
| 没有流式：长回答要整段等 | 第 7 步之后评估 |
| 只有一个 provider 写死在代码里 | 第 6 步用配置选择 |
| 没有 token 计数与成本控制 | 第 10 步压缩时 |
| 每次请求都重新拼全部历史，没有缓存 | 不做（DSH 有 KV cache 优化，属性能范畴） |
| `EMPTY_RESPONSE` 也可能来自"脚本写短了"（测试场景），二者无法区分 | 第 9 步可以给 mock 换一个专门的 code |

### 当前实现的真实缺陷（你可以自己修）

**缺陷 1：`content` 是数组时被丢弃**

```ts
const content = typeof rawContent === 'string' ? rawContent : ''
```

某些服务端返回结构化内容：

```json
"content": [{ "type": "text", "text": "你好" }]
```

**后果**：模型明明有回答，我们却看到空串。

**修法**：加一个分支，把数组里各段的 `text` 拼起来。

**为什么当初没做**：我们只对接 DeepSeek，它返回字符串。**这是"针对单一 provider 做的简化"。**

**缺陷 2：`AbortError` 被归成 `TRANSPORT`**

```ts
if (name === 'AbortError') {
  return new LLMError('TRANSPORT', '请求被中止', { cause })
}
```

**问题**：用户主动取消（Ctrl+C）会走到这里，被标成"可重试"。

**后果**：第 9 步可能对一个"用户明确不要了"的请求重试。

**修法**：加 `CANCELLED` 错误码，并在重试策略里排除它。

**缺陷 3：`parseArguments` 对数组宽松**

```ts
if (typeof raw === 'object') {
  return { value: raw as Record<string, unknown>, error: '' }
}
```

数组也会走到这里，被当成合法参数对象。

**后果**：如果有人直接调 `parseArguments([1,2,3])`，会得到一个"成功"的假象，后面 `args.path` 是 `undefined`。

**为什么不修**：当前调用链里数组的情况已被上一层挡掉。**这是"信任同进程类型化调用"的选择。**

**但它是脆的** —— 将来有人从别处调用这个函数，就会踩坑。

**缺陷 4：`INVALID_REQUEST` 用在"响应不是合法 JSON"上**

```ts
throw new LLMError('INVALID_REQUEST', `响应不是合法 JSON：${text.slice(0, 400)}`, { cause })
```

**问题**：服务端返回坏 JSON 是**服务端的问题**，不是"我们的请求非法"。

**后果**：第 9 步会把它归为"不可重试"—— 但**服务端的临时故障其实值得重试**。

**修法**：用 `UNKNOWN` 或者新增 `MALFORMED_RESPONSE`。

### 关于这些缺陷的态度

**它们不是"我写错了"，而是"针对当前目标做的简化"。**

每一处我都写清了：后果是什么、怎么修、当初为什么不做。

**这种"已知缺陷清单"是专业代码的标志。** DSH 的每个包 README 里都有一个 `## Known Limitations and Deferred Work` 章节 —— 这是仓库级的强制规范。

**你的重写版本可以修掉它们，但你必须先说清"原来的实现为什么这么选"。**

---

## L10 提问训练

> **这一节的目的不是讲知识，是训练一项能力：把"我看不懂"变成"一个能自己找到答案的问题"。**

### 10.1 为什么这件事值得单独练

你现在遇到的困境里，有一个是"**想不全应该了解的点**"。它的另一面是：**该问的问题问不出来。**

对比两种状态：

| 状态 | 你说的话 | 后果 |
|---|---|---|
| 不会提问 | "这里我不太懂。" | 对方不知道从哪讲起，只能重讲一遍 |
| 会提问 | "`MockProvider` 为什么要把参数再序列化成字符串走一遍 `toToolCall`，而不是直接造好对象？" | 对方一句话就能答：为了让 mock 走真实解析路径 |

**第二种问法有两个好处**：
1. **对方立刻知道你的理解到了哪一层**
2. **你自己在组织语言的过程中，往往就找到了答案**

### 10.2 问题的五个层次

**先看你问的是哪一层的。层次越高，越需要自己推。**

| 层次 | 问什么 | 例子 | 去哪找答案 |
|---|---|---|---|
| **L1 事实** | 这是什么 | "`Provider` 是什么？" | 术语表 |
| **L2 机制** | 它怎么工作 | "`MockProvider` 怎么保证和真实路径一致？" | 本篇 L3 |
| **L3 设计** | 为什么这么选 | "为什么坏参数不抛异常？" | 本篇 L1 / L2 |
| **L4 系统** | 它在整体中的位置和影响 | "改 `ToolCall` 会波及哪几步？" | 本篇 0.5 + 你自己的推理 |
| **L5 科研** | 它能支撑什么实验 | "怎么用它做干预 vs 自修正的对照？" | **你自己的判断** |

**L1–L3 是学习者的功课，L4–L5 是研究者的功课。**

**你导师问你的那些问题** —— "平均完成步数多少""最高多少分""这个提升显著吗" —— **全部是 L5 层**。而它们答不上来的根源，往往是 L4 层没想清楚（不知道哪个数字能从系统里取出来）。

### 10.3 五种提问模板（可直接套用）

| 模板 | 句式 | 用在本篇的例子 |
|---|---|---|
| **① 反问设计** | 为什么是 A，而不是 B？ | "为什么参数解析失败返回错误字符串，而不是抛异常让上层捕获？" |
| **② 反事实** | 如果不做 X 会怎样？ | "如果 `toWireMessages` 不存在，直接发内部结构会怎样？" |
| **③ 探边界** | 它在什么情况下会失效？ | "`MockProvider` 在什么情况下给出和真实环境不同的行为？" |
| **④ 问关系** | 它和 Y 是什么关系？ | "`LLMErrorCode` 和 `Provider` 是什么关系？谁依赖谁？" |
| **⑤ 提改造** | 我想实现 Z，该改哪里、代价是什么？ | "我想记录每次调用的耗时，应该加在 `Provider` 里还是包一层？" |

**② 和 ⑤ 是最有价值的两种** —— 它们强迫你做反事实推理和影响分析，正是系统思维的训练。

### 10.4 本篇引出的 12 个好问题

**这些不是练习题，是"读完这篇你应该能问出来的问题"。** 如果你一个都问不出来，说明还没读进去。

**关于设计（L3 层）**

1. 为什么 `ToolCall` 要同时存 `arguments`（对象）和 `rawArguments`（字符串）？
2. 为什么 `parseError` 用空串表示"无错误"，而不是 `undefined` 或 `boolean`？
3. 为什么 `Provider` 只有一个方法？如果加流式，应该加方法还是换接口？
4. 为什么 `LLMError` 要继承 `Error`，而不是一个普通类？

**关于系统（L4 层）**

5. 如果第 9 步的重试策略要新增一种"可重试"错误，应该改哪里？
6. 第 7 步要把消息落盘时，该存 `ChatMessage` 还是 `toWireMessages` 的结果？为什么？
7. 如果将来要支持三个 provider，`LLMUsage` 的字段名不一致该怎么统一？谁来做这件事？
8. 第 1 步为什么**没有**定义一个 `StreamingProvider` 接口，即使 DSH 有流式？

**关于科研（L5 层）**

9. 如何用 `MockProvider` + `seenMessages` 验证"我的循环确实把完整历史发给了模型"？
10. 如果我要比较"两种重试策略"的效果，`MockProvider` 能提供什么、不能提供什么？
11. 演示 3 的坏 JSON 场景，能否作为"模型自我纠正能力"的最小实验？需要什么额外设计？
12. 我有 30 道题、每组跑 1 次，`n ≈ 4/Δ²` 告诉我能检测多大的差异？这个实验值得跑吗？

### 10.5 问题升级练习

**这是本节的核心训练。** 把左边改写成右边。

| 模糊问题 | 精确问题 | 提升在哪 |
|---|---|---|
| "这里为什么这么写？" | "为什么参数解析失败要返回错误字符串，而不是抛异常让上层捕获？" | 指出了**具体的替代方案** |
| "这个能改吗？" | "如果我把 `Provider.chat` 拆成 `chat` 和 `chatStream` 两个方法，第 8 步的循环要改几处？" | 给出了**具体改法和影响范围** |
| "这样做对吗？" | "在只对接一个 provider 的前提下，省掉 `content` 数组的归一化，风险是什么？" | 加上了**前提条件**（"只对接一个 provider"） |
| "为什么这么麻烦？" | "多存一份 `rawArguments` 换来的 KV cache 命中率提升，值得那份内存吗？怎么测？" | 变成了**可权衡的量化问题** |
| "我不懂 mock。" | "`MockProvider` 复用了 `toToolCall`，如果我不这么做，会漏掉哪些真实场景？" | 从"不懂"变成**可回答的问题** |

**改写的三个动作**：

1. **补上替代方案**（"而不是……"）
2. **补上前提条件**（"在……的前提下"）
3. **补上可验证的判据**（"怎么测"）

> ### 你的练习（现在做）
>
> 从下面挑一个，按上面三个动作改写，然后**发给我**，我来判断你改得够不够精确：
>
> 1. "`LLMErrorCode` 为什么要分这么多类？"
> 2. "为什么第 1 步不做流式？"
> 3. "如果我不写 `MockProvider` 会怎样？"

---

## L11 系统影响回溯

> **读完全篇后，回到第 0.5 节，看看你当时的判断被推翻了哪些。**

### 11.1 三个预判的检验

第 0.5 节末尾让你想了四个问题。现在对照一下：

| 当时的问题 | 现在你应该能给出的答案 | 如果你答不上来 |
|---|---|---|
| 去掉 `Provider` 接口，第 8 步要怎么写？ | 循环里要写 `if (provider instanceof MockProvider)` 之类的分支，或把 mock 塞进真实 provider 里 | 重读 1.3 + 第 0.5 节连锁 3 |
| 哪个产物被最多地方消费？ | `ChatMessage`（第 7、8 步）+ `LLMErrorCode`（第 9、15 步）都算高频 | 回看"下游清单"表 |
| 哪个连锁影响不会报错？ | **连锁 1（KV cache 失效）** —— 它只让你多花钱 | 重读连锁 1 |
| 合并第 1、2 步会失去什么？ | 失去"纯粹性"：模型层不该知道工具怎么执行；合并后要联网才能测工具注册表 | 重读 1.3 |

### 11.2 这一步在整个系统里的"锚点"是什么

**如果你只能记住这一篇的一句话，应该是这句：**

> **把"必须联网、必须花钱、必须可能失败"的动作关闭在一个窄接口后面；并且给失败分类，因为分类是后续所有决策的前提。**

这一句会在后面反复出现：

| 后面哪一步 | 重复出现同一个思想 |
|---|---|
| 第 3 步 | 把"服务"关闭在 `ctx` 后面（同样的隔离思想） |
| 第 9 步 | **直接用本篇的错误分类做重试决策**（分类的价值兑现） |
| 第 10 步 | 把"能不能做"关闭在守卫后面（隔离 + 分类） |
| 第 15 步 | 把"失败"分类到组件（分类思想推到极致） |

**第 15 步的"失败归因"本质上就是本篇"错误分类"的放大版**：
- 本篇分类的是"一次请求为什么失败"
- 第 15 步分类的是"整个任务为什么失败，且归到哪个组件"

### 11.3 通向第 2 步的桥

**第 1 步结束时，系统处于一个明确的状态：**

```
✅ 能跟模型说话
✅ 能识别"模型要求调用工具"
❌ 但没有任何东西能执行它
❌ 也没有循环去驱动"执行 → 回灌 → 再请求"
```

**第 2 步要补上"执行"这一半。** 带着这些问题进入第 2 步：

1. `ToolCall.name` 是一个字符串，怎么变成一段可执行的代码？
2. 模型给的参数不可信，怎么校验？校验失败怎么让模型知道？
3. 工具执行很久怎么办？执行崩了怎么办？
4. 工具返回的内容太长（比如读了一个 10 万行的文件），塞进消息里会怎样？
5. 模型只应该看见"它被允许用的工具" —— 这个"被允许"由谁决定？

**第 5 个问题在第 5 步（scope）才会真正解决**，但第 2 步就要把接口留出来。

---

## 本篇完结

**你已经读完课程的第一篇。核对一下你的状态：**

| 检查项 | 应该达到 |
|---|---|
| 能解释 `Provider` 抽象的两大收益 | L1 |
| 能说出四个"必须做"分别对应哪个坑 | L1 |
| 能解释三份 `arguments` 各自的用途 | L1 |
| 能说出哪几个错误码可重试 | L1 |
| **能关掉文档写出 `parseArguments` 的全部分支** | **L3** |
| **能关掉文档写出 `MockProvider`** | **L3** |
| 能说出改 `ToolCall` 会影响哪几步 | L4 |
| 能提出至少 5 个 L3/L4 层的问题 | L4 |

**任何一条打不了勾，回对应的节重读 —— 不要往下走。**

---

**读完这篇，请回答我三个问题：**

1. **粒度**：3.10 那节（`parseArguments` 逐行）的密度，是**刚好 / 太啰嗦 / 还要更细**？
2. **系统视角**：第 0.5 节的"连锁影响分析"对你**有用吗**？你还想看哪种类型的连锁分析？
3. **提问训练**：10.5 节的"问题升级练习"你**做了吗**？做不出来是卡在哪一步？

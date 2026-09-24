# 第 6 步 · 配置装载（profile / bundle / patch）

> **代码**：`src/framework/loader.ts`（约 250 行）
> **配置**：`bundles/*.json`（2 个）、`profiles/*.json`（3 个）、`patches/*.json`（2 个）
> **插件**：`src/plugins/*.ts`（3 个演示插件）
> **演示**：`src/demos/demo-loader.ts`
> **DSH 对应**：`packages/boot/app-boot/` + `apps/cli/src/profile-boot.ts` + `packages/bundle/`
> **本篇目标级别**：L3（关掉文档能从零重写）
> **预计阅读**：90–120 分钟 · **预计动手**：100 分钟

---

## 本篇新词

> 全部术语在 [`glossary.md`](glossary.md)。先花 90 秒扫一遍。

| 词 | 一句话 | 为什么必须懂 |
|---|---|---|
| **profile（组合单）** | 一份具名配置：装哪些 bundle、自己再覆盖什么 | "启动哪套配置"的答案 |
| **bundle（积木包）** | 一组插件行，可被上层覆盖 | 配置复用的单位 |
| **patch（补丁）** | 一组"按 id 定位的修改" | 复用之后还能定制 |
| **composition（组合）** | 把若干配置层叠成最终配置 | 本课程的核心思想之一 |
| **loader（装载器）** | 执行"层叠 + 装载"的程序 | 把纸面组合变成可运行系统 |
| **dump-config** | 打印"最终生效的配置" | ★ **配置系统唯一可调试的手段** ★ |
| **整段替换** | patch 覆盖 config 时整体换掉，不是逐字段合并 | 决定"会不会有隐式继承" |
| **动态 import** | 运行时按路径加载模块 | 插件不在编译期确定 |
| **幂等装载** | 同一个插件装两次会怎样 | 触发"服务重复注册" |

---

## 第 0 节 · 这一步的成品长什么样

### 0.1 你会新增什么

```
┌────────────────────────────────────────────────────────────────────┐
│  loader.ts（新增，约 250 行）                                       │
│                                                                    │
│  数据格式                                                          │
│    ① PluginRow      一行 = id + 插件路径 + config + disabled        │
│    ② BundleFile     一个 bundle = 一组行                            │
│    ③ PatchEntry     修改某行（config / disabled）                    │
│    ④ InsertEntry    插入新行                                        │
│    ⑤ ProfileFile    一个 profile = bundle 列表 + 自己的 patch        │
│                                                                    │
│  函数                                                              │
│    ⑥ composeRows()  层叠（★ 核心逻辑）                              │
│    ⑦ loadProfile()  读文件 + 层叠 + 装载 + 提供 dump                │
│    ⑧ readJson / readPatchLayer  读文件（含格式校验）                 │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  配置文件（7 个）                                                   │
│    bundles/   base.json  reversed.json                              │
│    profiles/  base-only.json  dev.json  reversed.json               │
│    patches/   cli-override.json  bad-id.json                        │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  演示插件（3 个）                                                   │
│    demo-config.ts         提供 config 服务                          │
│    demo-greeter.ts        inject config，提供 greeting              │
│    demo-named-service.ts  服务名由配置决定（★ 见 1.7）               │
└────────────────────────────────────────────────────────────────────┘
```

### 0.2 对第 3–5 步代码的修改

**一处小改动：`Plugin.apply` 加了一个 `config` 参数。**

```ts
// 第 3 步
apply(ctx: Context): void | Promise<void>

// 第 6 步
apply(ctx: Context, config?: Record<string, unknown>): void | Promise<void>
```

**连带改动**（都在 `context.ts` 里）：

| 改动 | 原因 |
|---|---|
| `Plugin.apply` 加 `config?` | 配置要有地方去 |
| `Context.plugin(plugin, config?)` | 传递配置 |
| 加 `#waitingConfig` 字段 | **挂起的插件也要记住配置**（唤醒时要传） |
| `#wakePending` / `#startSilently` 加 config 参数 | 同上 |

**注意第三行** —— 这是"新功能要照顾到所有既有路径"的典型例子：

> **挂起机制（第 4 步）是"稍后启动"，那么"稍后"要用到的东西必须一起存下来。**

### 0.3 运行起来是什么样

```powershell
node src/demos/demo-loader.ts
```

关键输出：

```
--- config（来自 bundle）---
{"workspace":"D:/agent-harness-lab","model":"mock"}

--- config（被 patch 覆盖）---
{"workspace":"D:/lab-dev","model":"deepseek-chat"}

--- config（★ 注意 workspace 丢了）---
{"workspace":"（未指定）","model":"overridden-by-cli"}

--- patch 指向不存在的 id ---
patch 指向不存在的行 id："does-not-exist"；当前有：config, greeter, legacy-extra
```

**第三行是最重要的一组**：它演示了"**整段替换**"的后果 —— patch 只写了 `model`，于是 `workspace` **丢了**。

---

## 第 0.5 节 · 系统视角

### 你在哪里

```
                    ⑦ 入口层（第 11 步）
                            ▲
                    ┌───────┴───────┐
                    │ 【第 6 步】    │
                    │ 配置装载       │
                    │ ▶ 你在这里 ◀   │
                    └───────┬───────┘
                            │ 用前面所有的机制
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
   第 3 步 ctx        第 4 步 事件/inject   第 5 步 作用域
   （装载插件）        （顺序自由）          （隔离）
```

**第 6 步是"框架层"的最后一块。** 它不提供新机制，而是**把前五步的能力用配置组织起来**。

### 下游：谁在用配置系统

| 第 6 步的产物 | 谁消费 | 用来做什么 | 依赖强度 |
|---|---|---|---|
| `loadProfile()` | 第 11 步的 CLI | 启动一个 profile | 🔴 极强 |
| `PluginRow` 格式 | 所有能力插件 | 被配置引用 | 🔴 强 |
| `Plugin.apply(ctx, config)` | 第 7–16 步所有插件 | **接收配置** | 🔴 强 |
| `dump()` | 排查 | 看实际生效的配置 | 🔴 强（调试） |
| `composeRows()` | 第 16 步的实验对照 | **生成不同的配置组合** | 🔴 强（科研） |

**最后一行与你的科研直接相关**：

> **第 16 步的"演化"本质上就是在改动这份配置** —— 改某个插件的 `config`，然后跑对照实验。
> **没有配置系统，"自动演化"就只能改代码 —— 那是不可回滚的操作。**

### 连锁影响分析

#### 连锁 1：如果 patch 是"深合并"而不是"整段替换"

```
patch: { "id": "config", "config": { "model": "new" } }
   ↓ 深合并
config 变成 { "workspace": "旧值", "model": "new" }   ← workspace 保留
   ↓
看起来更"友好" —— 但：
   ↓
① 你没法**删掉**一个已有字段（深合并只能加不能删）
② "这个 workspace 的值是从哪一层来的？" —— 要逐层追溯
③ 三个 patch 层各写一半字段时，最终结果**无法心算**
④ 前一层删掉了某字段，后一层又"继承"了它 —— 出现幽灵值
```

**DSH 的注释写得很直接**：

> 「A patch replaces the targeted row's whole `config` rather than merging into it」

**代价**：patch 必须写全你想要的字段。**换来**：**看到的就是最终值，没有隐式继承。**

**演示 3 的 `workspace: "（未指定）"` 就是这个代价的现场。**

#### 连锁 2：如果 patch 指向不存在的 id 时静默忽略

```
patch: { "id": "confg", "config": {...} }     ← 拼错了
   ↓ 静默忽略
★ 没有报错，但配置也没生效 ★
   ↓
你的现象：改了配置，行为没变
   ↓
你的排查方向：去查插件实现（错的方向）
   ↓
★ 花半小时才发现是 id 拼错了 ★
```

**这是"改了没生效"最经典的成因**，而它**只需要一次"未知 id 报错"就能消灭**。

**演示 5 验证了报错**：

```
patch 指向不存在的行 id："does-not-exist"；当前有：config, greeter, legacy-extra
```

**注意它还列出了当前有哪些 id** —— 这是"错误信息要包含行动线索"。

#### 连锁 3：如果没有 `dump()`

```
配置改了没生效
   ↓
你有三个可能的怀疑对象：bundle？profile patch？命令行 patch？
   ↓
没有 dump：只能逐个文件读，然后在脑子里做层叠推演
   ↓
★ 而且推演经常错 ★（因为层叠规则里有"整段替换"这种反直觉的语义）
```

**dump 把"推演"变成"观察"。**

**演示 1、3 的输出都包含 dump**，你能直接看到最终值：

```
生效的行：
  config             ../src/plugins/demo-config.ts
                     config: {"model":"overridden-by-cli"}      ← 最终值
  greeter            ../src/plugins/demo-greeter.ts
                     config: {"prefix":"【开发模式】"}
  legacy-extra       ../src/plugins/demo-named-service.ts       ← 被启用
  extra-plugin       ../src/plugins/demo-named-service.ts       ← 新插入
```

**"改了配置没生效"这类故障，80% 靠 dump 就能当场定位。**

### 现在该建立的三个习惯

| 习惯 | 做法 | 训练什么 |
|---|---|---|
| **配置改动要能"看到最终值"** | 提供 dump / explain 类能力 | 可调试性优先 |
| **未知引用必须报错** | 拼错的 id 要比"没生效"好 | 错误信息价值 |
| **选简单语义，即使它不"友好"** | 整段替换 > 深合并 | 抵抗"贴心"的诱惑 |

> ### 停下来想一想（不给答案）
>
> 1. 演示 3 里 `workspace` 变成了 `"（未指定）"`。**这是 bug 还是设计？** 怎么让用户避免它？
> 2. 如果 patch 允许**删除一整行**（而不只是禁用），要加什么字段？和 `disabled` 有什么区别？
> 3. **如果两个 bundle 里有同 id 的行，谁赢？** 我们的实现是怎么定的？合理吗？

---

## L0 要解决的问题

### 0.1 第 5 步留下的具体缺陷：装配还在代码里

```ts
// 到第 5 步为止，装配必须这么写
const root = new Context('root')
await root.plugin(llmPlugin)
await root.plugin(toolsPlugin)
root.isolate('tools', readOnly)
```

**三个问题：**

| 问题 | 后果 |
|---|---|
| 想换一个 provider 的配置 | **改代码** |
| 想加一个插件 | **改代码、改顺序** |
| 想把"开发模式"和"生产模式"分开 | **写两套 main.ts** |

### 0.2 目标形态

```
现在（代码里装配）                      目标（配置装配）

main.ts                                 cli.ts
  ├─ new Context()                        └─ loadProfile('profiles/dev.json')
  ├─ await plugin(llm)                         ├─ 读 bundle
  ├─ await plugin(tools)                       ├─ 应用 patch 层
  ├─ root.isolate('tools', 只读)                ├─ 层叠成最终 rows
  └─ ...                                       └─ 逐行装载 + 可 dump

想换配置？改代码                          想换配置？改 JSON
```

### 0.3 这一步要回答的四个问题

| # | 问题 | 本篇位置 |
|---|---|---|
| 1 | 配置用什么数据结构？ | 数据格式（L3 的 3.2–3.6） |
| 2 | 多层配置**怎么叠加**？ | `composeRows`（1.2–1.3） |
| 3 | 覆盖时是"合并"还是"替换"？ | **整段替换**（1.3） |
| 4 | 改了没生效怎么排查？ | **dump**（1.6） |

**第 3 和第 4 个问题分别决定了"语义是否可预测"和"系统是否可调试"。**

---

## L1 设计与原理

### 1.1 三个概念

| 概念 | 是什么 | 类比 |
|---|---|---|
| **bundle** | 一组插件行（可被上层覆盖） | 一块积木 |
| **profile** | 具名组合：装哪些 bundle + 自己的覆盖 | 一份装配单 |
| **patch** | 一组按 `id` 定位的覆盖项 | 一张修正贴纸 |

**为什么要分成三个？**

| 概念 | 解决的问题 |
|---|---|
| bundle | **复用** —— 多个 profile 共享同一组插件 |
| profile | **具名** —— "启动哪套配置"有个名字 |
| patch | **定制** —— 复用之后还能改 |

### 1.2 层叠顺序

```
启动 profile 时：

  ① bundles 顺序           profile 里列出的 bundles，按列表顺序
  ② profile 自己的 patch    profile 的 patch 段
  ③ 机器级 patch            ~/.harness/patch.json      ← 我们没实现
  ④ 命令行 --patch <file>   按 argv 顺序，可重复

  ────────────────────────────────────────────────►
  优先级递增：后面的覆盖前面的
```

**我们的实现支持 ①②④**，③（机器级）没做 —— 它只是"再插一层"，见 L9。

**注意 `④` 可以给多个文件**：

```ts
loadProfile('profiles/dev.json', ['patches/a.json', 'patches/b.json'])
//                                 ↑ 先应用      ↑ 后应用（后者赢）
```

### 1.3 按 `id` 定位，**整段替换 config**

#### 规则

```jsonc
// bundle 里的一行
{ "id": "config", "plugin": "...", "config": { "workspace": "D:/a", "model": "mock" } }

// patch
{ "id": "config", "config": { "model": "new" } }

// 结果
{ "id": "config", "plugin": "...", "config": { "model": "new" } }
//                                              ↑ workspace 没了（整段替换）
```

#### 为什么不用深合并

| 理由 | 说明 |
|---|---|
| **可预测** | 你看到的就是最终值，不存在"某个字段从哪继承来"的追溯问题 |
| **可删除** | 深合并删不掉已有字段，整段替换天然可以 |
| **可心算** | 三层 patch 各写一半字段时，深合并的最终结果无法在脑子推演 |
| **与 DSH 一致** | DSH 明确选择整段替换 |

**代价**：patch 要写全。**这个代价是故意的** —— 它换来"没有隐式继承"。

**演示 3 现场演示了这个代价**：

```
--- config（★ 注意 workspace 丢了）---
{"workspace":"（未指定）","model":"overridden-by-cli"}
```

**这不是 bug，是设计。用户要避免它，就得在 patch 里写全字段。**

#### 实现细节

```ts
byId.set(item.id, {
  ...existing,
  ...(item.config !== undefined ? { config: item.config } : {}),
  ...(item.disabled !== undefined ? { disabled: item.disabled } : {}),
})
```

**注意两个条件展开**：

```ts
...(item.config !== undefined ? { config: item.config } : {})
```

**含义**："patch 里**写了** config 就替换，**没写**就保留原来的"。

**为什么不能直接写 `config: item.config`？**

因为那样 `config: undefined` 会**覆盖掉原值**：

```ts
{ ...existing, config: undefined }      // ← config 变成 undefined
```

**所以必须区分"没写这个字段"和"写了但值是 undefined"。**

**这个模式可以记成**：

> **可选字段的覆盖：`...(cond ? { key: value } : {})`**

### 1.4 行的三种操作

```jsonc
{
  "patch": [
    { "id": "config", "config": { ... } },              // ① 覆盖某行的 config
    { "id": "legacy", "disabled": false },              // ② 启用/禁用某行
    { "insert": [ { "id": "extra", "plugin": "..." } ] } // ③ 插入新行
  ]
}
```

**`disabled` 而不是删除**：

| | 删除 | 禁用 |
|---|---|---|
| 行还在吗 | 不在 | **在** |
| dump 能看到吗 | 不能 | **能** |
| 排查"为什么这个功能没生效" | 要翻历史 | **看 dump 就知道** |

**演示 1 的 dump 里就有一行被禁用的**：

```
  legacy-extra       ../src/plugins/demo-named-service.ts  [已禁用]
                     config: {"serviceName":"legacy","value":"（备用插件）"}
```

**这一行"存在但没生效"** —— 正是排查时最需要的信息。

### 1.5 为什么是 JSON

| 格式 | 优点 | 缺点 |
|---|---|---|
| **YAML**（DSH 的选择） | 可读、能写注释 | 需要解析器（本机零依赖做不到）；缩进陷阱多 |
| **JSON**（我们的选择） | 零解析成本、就是数据 | 不能写注释、手写啰嗦 |
| TypeScript | 类型安全、能写表达式 | **不再是数据** —— 无法被程序化覆盖 |

**决定性理由是"可被覆盖"**：

> patch 机制要求配置是**能被机器读写的数据**。TS 文件做不到 —— 要执行它才知道内容。

**JSON 不能写注释的缺点，我们用"文档 + 额外字段"补上。**

### 1.6 dump 为什么是必须的

**这一节是全篇最重要的设计论点。**

配置系统有四种典型故障，**每一种都靠 dump 定位**：

| 故障 | 没有 dump 时 | 有 dump 时 |
|---|---|---|
| "改了没生效" | 逐个文件读 + 脑内推演层叠 | **看最终值** |
| "为什么这个插件没装" | 翻 bundle 定义 | **看 `[已禁用]` 标记** |
| "这个值是哪层来的" | 逐层追溯 | dump 输出 + 层信息 |
| "命令行 patch 生效了吗" | 不确定 | **对比两次 dump** |

**"改了配置但没生效"是配置系统最经典的故障，而 dump 是唯一的解药。**

**这就是 DSH 有 `dsh --profile web --dump-config` 的原因** —— 而且它还有两个变体：

```sh
dsh --profile web --dump-default-config   # 不含用户层，只打印 bundle 层
dsh --profile web --dump-config-schema    # 打印每个插件的配置 JSON Schema
```

**第三个变体最有意思**：它需要**每个插件声明自己的配置 schema**。我们没做（见 L9）。

### 1.7 ★ 两个实测发现 ★

写这一步时我跑出了两个**没预料到的行为**，都很有教学价值。

#### 发现 1：`await` 之间的间隙会跑完微任务

演示 4 本想演示"装载顺序相反时插件挂起"，但实际输出是：

```
--- 装载完成后 greeting（已经就绪）---
【顺序相反】｜工作目录 D:/reversed｜模型 mock
```

**装载完成时它已经启动了**，没有停在挂起状态。

**为什么？**

```ts
// loadProfile 内部的装载循环
for (const row of rows) {
  unloads.push(await ctx.plugin(plugin, row.config))     // ← 每次都有 await
}
```

```
① await ctx.plugin(greeter, cfg)
     → greeter inject config，config 还没装载 → 挂起 + queueMicrotask
② ★ await 让出控制权 —— 微任务队列被执行（但 config 还没出现，唤醒不成立）★
③ await ctx.plugin(config, cfg)
     → config 被 provide → #wakePending() → queueMicrotask(启动 greeter)
④ ★ 这个 await 又让出控制权 —— 微任务跑完，greeter 启动 ★
⑤ 循环结束，loadProfile 返回
```

**所以在 `loadProfile` 返回时，greeter 已经启动了。**

**这是个好消息** —— 说明挂起机制在"多步 await"的流程里几乎是无缝的。

**但它也修正了一个表述**：第 4 步文档说"`provide` 之后立刻读可能读不到" —— **那是对的，但只在同步上下文里成立**；在 `await` 之间通常已经跑完了。

#### 发现 2：同一个插件装载两次会冲突

演示 3 第一次运行时崩了：

```
Error: [demo-greeter] 服务重复注册："greeting"（已被容器 "demo-greeter" 注册）
```

**原因**：patch 里 `insert` 了一个新行，而它用的插件和已有的一行**是同一个**（`demo-greeter.ts`）。

**那个插件硬编码提供 `greeting`** —— 而全局命名空间唯一 → 第二次装载报错。

**这不是 loader 的 bug，是插件设计的问题**：

> **一个可能被执行两次的插件，不该硬编码它提供的服务名。**

**所以我加了第三个演示插件 `demo-named-service.ts`**，它的服务名**来自配置**：

```ts
apply(ctx, config) {
  const serviceName = typeof config?.['serviceName'] === 'string' ? config['serviceName'] : 'unnamed'
  ctx.provide(serviceName, value)
}
```

**然后同一个插件可以装载任意多次**：

```
  legacy-extra       ../src/plugins/demo-named-service.ts
                     config: {"serviceName":"legacy", ...}
  extra-plugin       ../src/plugins/demo-named-service.ts
                     config: {"serviceName":"extra", ...}
```

**两个不同的服务名（`legacy` / `extra`），互不冲突。**

**这条经验写进了那个插件的文件注释**：

> **插件不该假设"只有一个我"。**

> ### 停下来想一想（不给答案）
>
> 1. 如果一个插件**必须**提供固定名字的服务（比如 `llm`），那它就不能被装载两次。**这是限制还是合理约束？**
> 2. 发现 1 里，如果装载循环**没有 `await`**（比如用 `void` 并发装载），挂起窗口会不会变大？
> 3. **`dump` 应该显示"这个值来自哪一层"吗？** 如果要，数据结构要改什么？

---

## L2 决策表

| # | 决策 | 我们的选择 | 替代方案 | 代价落在谁身上 |
|---|---|---|---|---|
| 1 | 配置格式 | **JSON** | YAML / TypeScript | 不能写注释；换来零依赖 + 可程序化覆盖 |
| 2 | 覆盖语义 | **整段替换 config** | 深合并 | patch 要写全字段；换来无隐式继承 |
| 3 | 禁用方式 | **`disabled: true` 保留行** | 从列表删除 | 列表变长；换来可 dump、可排查 |
| 4 | 未知 id | **报错并列出已有 id** | 静默忽略 | 拼错会失败；换来"改了没生效"绝迹 |
| 5 | `insert` 重名 | **报错** | 覆盖已有行 | 不能"用 insert 覆盖"；但覆盖有专门语法 |
| 6 | 插件标识 | **相对路径** | npm 包名 | 不能复用第三方包；换来零依赖 |
| 7 | 插件导出 | **`default` 导出** | 具名导出 | 约定更严格；换来装载器简单 |
| 8 | 装载顺序 | **配置里的书写顺序** | 拓扑排序（按依赖） | 与 inject 无关（挂起会处理）；换来可预测 |
| 9 | dump 能力 | **提供** | 不提供 | 多写几十行；换来配置可调试 |
| 10 | 机器级 patch | **不做** | 实现 `~/.harness/patch.json` | 少一个层；换来实现简单 |

### 关于第 4 条的完整性论证

**报错信息里为什么要列出现有 id？**

```
patch 指向不存在的行 id："confg"；当前有：config, greeter, legacy-extra
```

**对比**：

```
// 只说"不存在"
patch 指向不存在的行 id："confg"

// 列出已有的
patch 指向不存在的行 id："confg"；当前有：config, greeter, legacy-extra
                          ↑ 你立刻看出少写了一个 i
```

**这是"错误信息要包含行动线索"的第三次实践**（前两次：第 2 步的"可用工具有这些"、第 3 步的"已被容器 X 注册"）。

### 关于第 5 条的论证

**为什么 `insert` 重名要报错，而不是"覆盖已有行"？**

因为**覆盖已经有专门的语法**：

```jsonc
{ "id": "config", "config": {...} }        // ← 这才是覆盖
{ "insert": [ { "id": "config", ... } ] }  // ← 这是插入，重名就是错误
```

**两种操作语义不同**，混起来会让"我到底改的是哪一行"变得不可预测。

**这是"同一种效果只保留一条路径"的原则。**

### 关于第 8 条的说明

**为什么不用拓扑排序保证"被依赖的先装载"？**

因为**第 4 步的 `inject` 已经处理了这个问题**：依赖不齐就挂起，依赖出现就唤醒。

**装载顺序因此变成"无所谓"的** —— 带来两个好处：

| 好处 | 说明 |
|---|---|
| 配置**可读** | 不用为了依赖关系打乱书写顺序 |
| 配置**可组合** | 一个 bundle 里的插件顺序，不会影响另一个 bundle 的插件 |

**如果用了拓扑排序**，那么"两个 bundle 合起来"时可能要重新排序 —— **那就破坏了"叠加"的设计哲学**。

> ### 停下来想一想（不给答案）
>
> 1. 第 8 条说"装载顺序无所谓"。**但如果有两个插件依赖同一个服务，谁先启动？** 这重要吗？
> 2. 如果 `dump` 要显示"每个值的来源层"，数据结构该怎么改？
> 3. **`insert` 的行能不能被后面的 patch 层再修改？** 我们的实现是怎样的？

---

---

## L3 实现：逐行讲解

### 3.0 文件结构

```
┌─── 一、数据格式（30–80 行）     5 个接口 + 2 个联合类型
├─── 二、层叠（86–150 行）        composeRows ★
├─── 三、读文件（156–180 行）     readJson / readPatchLayer
└─── 四、装载（186–250 行）       loadProfile ★ + dump
```

**这个文件比前几步的都长（250 行），但结构简单** —— 一段数据定义、一个核心算法、一个总的装载流程。

### 3.1 文件头注释（第 1–18 行）

```ts
/**
 * 第 6 步 ｜ 配置装载器：把「装哪些插件」从代码变成数据
 *
 * 到第 5 步为止，装配还是写在代码里：
 *
 *     const root = new Context('root')
 *     await root.plugin(llmPlugin)
 *     await root.plugin(toolsPlugin)
 *     root.isolate('tools', readOnly)
 *
 * 想换一个 provider 的配置、想加一个插件、想把「开发模式」和「生产模式」分开
 * —— 全都要改代码。
 *
 * 这一步做三件事：
 *   ① 定义数据格式（bundle / profile / patch）
 *   ② 把层叠规则实现出来（后写覆盖先写，按 id 定位，**整段替换 config**）
 *   ③ 提供 dump —— 打印最终生效的配置
 *
 * 第 ③ 件最容易被忽略，但它决定了这个配置系统**可不可调试**：
 * 「改了配置但没生效」是配置系统最经典的故障，而 dump 是唯一的解药。
 */
```

**"这一步做三件事"这个结构很好用** —— 读者一眼知道这个文件的规模。

**而第 ③ 件的强调**（"最容易被忽略"）**是在教读者"什么才是重点"** —— 因为大多数实现配置系统的人只做 ①②，不做 ③。

### 3.2 `PluginRow` 与 `BundleFile`（第 30–52 行）

```ts
/** 配置里的一行：一个插件 + 它的配置。 */
export interface PluginRow {
  /** 行 id。**全树唯一**，patch 就是靠它定位的。 */
  readonly id: string
  /** 插件模块路径，相对于 profile 文件所在目录。 */
  readonly plugin: string
  /** 传给插件 apply 的配置。 */
  readonly config?: Record<string, unknown>
  /** 为 true 时**不装载**，但这一行仍然出现在 dump 里。 */
  readonly disabled?: boolean
}

/** 一个 bundle 文件：一组插件行。 */
export interface BundleFile {
  readonly id: string
  readonly rows: readonly PluginRow[]
}
```

#### 四个字段的设计

| 字段 | 必填？ | 理由 |
|---|---|---|
| `id` | ✅ | patch 靠它定位，没有它就无法覆盖 |
| `plugin` | ✅ | 没有它不知道装载什么 |
| `config` | ❌ | 有的插件不需要配置 |
| `disabled` | ❌ | 缺省即启用 |

**注意 `disabled` 的注释**：

```
为 true 时**不装载**，但这一行仍然出现在 dump 里。
```

**这解释了"为什么用 disabled 而不是删除"** —— 而它写在字段的注释里，**读这个字段的人立刻知道设计意图**。

**`plugin` 的注释里写明了路径基准**：

```
插件模块路径，相对于 profile 文件所在目录。
```

**这个"相对于谁"是必需的** —— 因为我第一次就写错了（写成了 `../plugins/` 而不是 `../src/plugins/`），**如果注释里写明基准，我能当场发现**。

### 3.3 patch 的两个变体（第 54–72 行）

```ts
/** patch 里的一条：修改某个已有行。 */
export interface PatchEntry {
  readonly id: string
  /** 给定就**整段替换**原有 config（不是深合并）。 */
  readonly config?: Record<string, unknown>
  /** 给定就覆盖原有 disabled。 */
  readonly disabled?: boolean
}

/** patch 里的一条：插入新行。 */
export interface InsertEntry {
  readonly insert: readonly PluginRow[]
}

/** patch 层里的一条。 */
export type PatchItem = PatchEntry | InsertEntry
```

#### 为什么用"联合类型"而不是"一个接口带可选字段"

**方案 B（不采用）**：

```ts
interface PatchItem {
  id?: string
  config?: Record<string, unknown>
  disabled?: boolean
  insert?: readonly PluginRow[]
}
```

**它能工作，但有个致命问题**：**"有哪些字段合法"取决于"是哪一种操作"**。

```
有 id        → 是修改操作 → 不能有 insert
有 insert    → 是插入操作 → 不能有 id
两者都有      → ★ 语义不明 ★
两者都没有    → ★ 语义不明 ★
```

**用联合类型**：

```ts
type PatchItem = PatchEntry | InsertEntry
```

**编译器保证**：要么有 `id`，要么有 `insert`。

**判别方式**（在 `composeRows` 里）：

```ts
if ('insert' in item) { ... }      // ← 用 'in' 运算符判别
```

**这叫"可辨识联合"（discriminated union）的变体** —— 严格说需要一个字面量判别字段（比如 `kind`），但这里用"有没有某个字段"也能判别。

**DSH 的规范里有一条正对应**：

> 「**Switch on discriminant tags.** Closed unions end in `assertNever`; merge-extensible unions fall through a documented default.」

**我们的 `PatchItem` 是"封闭"的（只有两种）**，所以 `'insert' in item` 判断后，**else 分支必然是 `PatchEntry`**。

### 3.4 `composeRows()`（第 86–150 行）★ 核心算法 ★

```ts
export function composeRows(
  bundles: readonly BundleFile[],
  layers: readonly PatchLayer[],
): PluginRow[] {
  const byId = new Map<string, PluginRow>()
  const order: string[] = []

  const put = (row: PluginRow): void => {
    // 只有第一次出现时才记录顺序 —— 后面的覆盖不改变位置
    if (!byId.has(row.id)) order.push(row.id)
    byId.set(row.id, row)
  }

  // ① bundle 之间：后面的覆盖前面的
  for (const bundle of bundles) {
    for (const row of bundle.rows) put(row)
  }

  // ② 依次应用 patch 层
  for (const layer of layers) {
    for (const item of layer) {
      if ('insert' in item) {
        for (const row of item.insert) {
          if (byId.has(row.id)) {
            throw new Error(`insert 的行 id 已经存在："${row.id}"`)
          }
          put(row)
        }
        continue
      }

      const existing = byId.get(item.id)
      if (existing === undefined) {
        throw new Error(`patch 指向不存在的行 id："${item.id}"；当前有：${order.join(', ')}`)
      }

      // ★ 整段替换 config，而不是深合并
      byId.set(item.id, {
        ...existing,
        ...(item.config !== undefined ? { config: item.config } : {}),
        ...(item.disabled !== undefined ? { disabled: item.disabled } : {}),
      })
    }
  }

  const result: PluginRow[] = []
  for (const id of order) {
    const row = byId.get(id)
    if (row !== undefined) result.push(row)
  }
  return result
}
```

#### 为什么需要**两个**数据结构

```ts
const byId = new Map<string, PluginRow>()    // ← 按 id 快速查找
const order: string[] = []                    // ← 记住出现顺序
```

**只有 `Map`**：能查不能保证顺序（虽然 `Map` 有插入序，但"覆盖"时 `set` 不会改变位置 —— 这其实够用）。

**只有数组**：查找要 O(n)。

**两个一起用**：`Map` 负责查找，`order` 负责顺序。

**等等** —— `Map` 本身保证插入顺序，而且 `set` 已存在的键**不改变位置**。**那 `order` 是不是多余？**

**严格说，是的** —— 最后可以直接 `[...byId.values()]`。

**但我们保留了 `order`**，理由：

| 理由 | 说明 |
|---|---|
| **显式** | `order` 的名字直接说明"这是顺序"，读者不用知道 `Map` 的顺序语义 |
| **`byId` 只负责查找** | 职责分离：一个管查，一个管序 |
| **错误信息需要它** | `patch 指向不存在的行 id："x"；当前有：${order.join(', ')}` |

**第三条是实际用途。**

**这也是一个"两个数据结构只有一个必要"的例子** —— **但我们有具体理由保留它，而且代价极小（一个字符串数组）。**

> **要区分"冗余"和"有理由的重复"** —— 前者是技术债，后者是可读性投资。

#### `put` 函数的三行

```ts
const put = (row: PluginRow): void => {
  if (!byId.has(row.id)) order.push(row.id)      // ← 只在首次出现时记录顺序
  byId.set(row.id, row)                           // ← 覆盖（或新增）
}
```

**`if (!byId.has(...))` 这一行实现了"覆盖不改变位置"**：

```
bundle A: [x, y]
bundle B: [y, z]

put(x) → order=[x],        byId={x}
put(y) → order=[x,y],      byId={x,y}
put(y) → order=[x,y]（不变）, byId={x,y'}     ← y 被覆盖但位置不变
put(z) → order=[x,y,z],    byId={x,y',z}

结果顺序：x, y, z
```

**如果用 `order.push(row.id)` 无条件**：

```
结果顺序：x, y, y, z      ← 重复！
```

**所以那个 `if` 是必须的。**

#### 三处错误检查

| 检查 | 位置 | 错误信息 |
|---|---|---|
| `insert` 的 id 已存在 | insert 分支 | `insert 的行 id 已经存在："${row.id}"` |
| patch 指向不存在的 id | 修改分支 | `patch 指向不存在的行 id："${item.id}"；当前有：...` |
| （隐含）bundle 之间同 id | **不报错** | **后面的覆盖前面的**（这是设计） |

**注意第三行** —— **bundle 之间的同 id 是允许的**（覆盖），**而 `insert` 的同 id 是禁止的**。

**两个不同的规则，理由在 L2 的第 5 条讲了**。

#### "整段替换"的实现细节

```ts
byId.set(item.id, {
  ...existing,
  ...(item.config !== undefined ? { config: item.config } : {}),
  ...(item.disabled !== undefined ? { disabled: item.disabled } : {}),
})
```

**逐行**：

| 行 | 作用 |
|---|---|
| `...existing` | 保留 `id` 和 `plugin`（patch 不能改它们） |
| 条件展开 config | **写了就整段替换，没写就保留** |
| 条件展开 disabled | 同上 |

**注意 patch 不能改 `id` 和 `plugin`** —— 因为**它们是定位的依据**。

**如果想换插件呢？** 那就删掉这一行、insert 一个新的。**这是"定位字段不可变"的设计。**

（DSH 的 patch 也遵循同样的原则 —— patch 按 id 定位，不能通过 patch 改 id。）

### 3.5 `readJson` 与 `readPatchLayer`（第 156–180 行）

```ts
/** 读一个 JSON 文件。 */
async function readJson<T>(path: string): Promise<T> {
  const text = await readFile(path, 'utf8')
  try {
    return JSON.parse(text) as T
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`不是合法的 JSON：${path}\n${reason}`)
  }
}
```

**注意几点**：

| 点 | 说明 |
|---|---|
| `readFile(path, 'utf8')` | 必须指定编码，否则返回 Buffer |
| `try/catch` 包住 `JSON.parse` | **这是"边界处校验"** —— 文件内容是外部输入 |
| 错误信息里带上**路径和原因** | 否则 JSON 语法错误无法定位 |
| `as T` | 泛型断言 —— **运行时无检查**（缺陷，见 L9） |

**`readPatchLayer` 兼容两种格式**：

```ts
async function readPatchLayer(path: string): Promise<PatchLayer> {
  const data = await readJson<unknown>(path)

  if (Array.isArray(data)) return data as PatchLayer

  if (typeof data === 'object' && data !== null) {
    const patch = (data as { patch?: unknown }).patch
    if (Array.isArray(patch)) return patch as PatchLayer
  }

  throw new Error(`patch 文件格式不对：${path}（应为数组，或 { "patch": [...] }）`)
}
```

**为什么兼容两种？**

```jsonc
// 格式 A：纯数组（很简洁）
[ { "id": "config", "config": {...} } ]

// 格式 B：带 patch 字段（可扩展，比如将来加 "description"）
{ "patch": [ { "id": "config", "config": {...} } ] }
```

**profile 内嵌的 patch 用的是格式 A**（因为它已经在 `patch` 字段里了），**独立文件两种都接受**。

**第三个分支错误信息写清了"应该是什么"**：

```
patch 文件格式不对：x.json（应为数组，或 { "patch": [...] }）
```

**这比"格式错误"有用得多** —— 用户立刻直到该怎么改。

### 3.6 `loadProfile()`（第 186–250 行）★ 主流程 ★

```ts
export async function loadProfile(
  profilePath: string,
  patchFiles: readonly string[] = [],
  options: LoadProfileOptions = {},
): Promise<LoadedProfile> {
  const absoluteProfile = resolve(profilePath)
  const baseDir = dirname(absoluteProfile)

  const profile = await readJson<ProfileFile>(absoluteProfile)

  // ① 读全部 bundle
  const bundles: BundleFile[] = []
  for (const relative of profile.bundles) {
    bundles.push(await readJson<BundleFile>(resolve(baseDir, relative)))
  }

  // ② 组装 patch 层：profile 自己的 → 命令行给的
  const layers: PatchLayer[] = []
  if (profile.patch !== undefined) layers.push(profile.patch)
  for (const file of patchFiles) {
    layers.push(await readPatchLayer(resolve(file)))
  }

  // ③ 层叠成最终配置
  const rows = composeRows(bundles, layers)

  // ④ 逐行装载
  const ctx = options.root ?? new Context(profile.name)
  const unloads: Disposer[] = []
  for (const row of rows) {
    if (row.disabled === true) continue

    const modulePath = resolve(baseDir, row.plugin)
    const url = pathToFileURL(modulePath).href
    const mod = (await import(url)) as { default?: unknown }
    const plugin = mod.default as Plugin | undefined
    if (plugin === undefined || typeof plugin.apply !== 'function') {
      throw new Error(`插件模块缺少 default 导出（或它不是插件）：${row.plugin}（行 "${row.id}"）`)
    }

    unloads.push(await ctx.plugin(plugin, row.config))
  }

  return { ctx, rows, unloadAll, dump }
}
```

#### ① 读 bundle

```ts
const absoluteProfile = resolve(profilePath)
const baseDir = dirname(absoluteProfile)
```

**`baseDir` 是"路径解析的基准"** —— 后面所有的相对路径都相对它。

**注意它取的是 profile 的目录，不是 bundle 的目录**：

```
profiles/dev.json
  bundles: ["../bundles/base.json"]

  bundle 里的 plugin: "../src/plugins/x.ts"
       ↓ 相对于 baseDir（profiles/）
  <root>/src/plugins/x.ts
```

**为什么用 profile 的目录而不是 bundle 的？**

| 方案 | 后果 |
|---|---|
| **相对 profile（我们的选择）** | bundle 换位置时路径不用改 |
| 相对 bundle | bundle 挪到别的目录就要改里面的路径 |

**第一种更稳定** —— 因为 **profile 是"入口"，bundle 是"被引用的库"**。

（类比：Node 的 `node_modules` 解析也是从"使用者的位置"出发，不是从被引用模块的位置。）

#### ② 组装 patch 层

```ts
const layers: PatchLayer[] = []
if (profile.patch !== undefined) layers.push(profile.patch)
for (const file of patchFiles) {
  layers.push(await readPatchLayer(resolve(file)))
}
```

**顺序就是优先级**：数组后面的覆盖前面的。

```
layers[0] = profile 自己的 patch     ← 优先级低
layers[1] = patches/cli-override.json ← 优先级高
```

**注意 `patchFiles` 里的路径 `resolve(file)` 是相对 `process.cwd()`**（不是 baseDir）。

**这是有意的** —— 命令行参数应该是"相对于你运行命令的目录"。

**两种路径基准并存，容易混淆** —— 见 L9 缺陷。

#### ③ 层叠

**一行。**

**这就是"把复杂逻辑抽成纯函数"的好处**：主流程读起来清爽，而且 `composeRows` 可以**脱离文件系统单独测试**。

#### ④ 逐行装载（本步最容易出错的地方）

```ts
const modulePath = resolve(baseDir, row.plugin)
const url = pathToFileURL(modulePath).href
const mod = (await import(url)) as { default?: unknown }
```

**三行做了三件事**：

| 行 | 作用 |
|---|---|
| `resolve(baseDir, row.plugin)` | 相对路径 → 绝对路径 |
| `pathToFileURL(...).href` | **绝对路径 → file:// URL** |
| `await import(url)` | 动态导入 |

**第二行是必须的** —— 因为 **Windows 上动态 `import()` 需要 `file://` URL**：

```ts
await import('D:/x/y.ts')          // ❌ Windows 上会失败
await import('file:///D:/x/y.ts')  // ✅
```

**`pathToFileURL` 处理了 Windows 的盘符和反斜杠。**

**这一行的缺失是最常见的"动态 import 报错"成因。**

#### 插件导出检查

```ts
const plugin = mod.default as Plugin | undefined
if (plugin === undefined || typeof plugin.apply !== 'function') {
  throw new Error(`插件模块缺少 default 导出（或它不是插件）：${row.plugin}（行 "${row.id}"）`)
}
```

**两个检查**：

| 检查 | 挡什么 |
|---|---|
| `plugin === undefined` | 忘了 `export default` |
| `typeof plugin.apply !== 'function'` | 导出的东西不是插件 |

**第二个检查很重要** —— 它挡住了"导出一个对象但忘了实现 `apply`"的情况。

**错误信息里带上了"行 id"** —— 因为**同一个模块可能被多行引用**，光有路径不够定位。

#### 卸载函数

```ts
unloadAll: (): void => {
  for (const unload of [...unloads].reverse()) unload()
}
```

**逆序卸载** —— 和第 3 步的 `dispose` 同样的理由（后装的先卸）。

**注意它复制了数组再 `reverse`** —— `reverse` 原地改，不复制会破坏 `unloads`。

### 3.7 `dump()`（第 240–252 行）

```ts
dump: (): void => {
  console.log(`profile：${profile.name}（${absoluteProfile}）`)
  console.log(`bundle：${profile.bundles.join(' → ')}`)
  console.log('生效的行：')
  for (const row of rows) {
    const mark = row.disabled === true ? '  [已禁用]' : ''
    console.log(`  ${row.id.padEnd(18)} ${row.plugin}${mark}`)
    if (row.config !== undefined && Object.keys(row.config).length > 0) {
      console.log(`  ${''.padEnd(18)} config: ${JSON.stringify(row.config)}`)
    }
  }
}
```

**三个设计点**：

| 点 | 说明 |
|---|---|
| **先打印 profile 和 bundle** | 让读者知道"这是什么组合" |
| `row.id.padEnd(18)` | 对齐，便于扫读 |
| **config 单独一行** | 不然行会太长 |

**`padEnd(18)` 的作用**：

```
  config             ../src/plugins/demo-config.ts
  greeter            ../src/plugins/demo-greeter.ts
  legacy-extra       ../src/plugins/demo-named-service.ts  [已禁用]
```

**没有对齐的话**：

```
  config ../src/plugins/demo-config.ts
  greeter ../src/plugins/demo-greeter.ts
  legacy-extra ../src/plugins/demo-named-service.ts  [已禁用]
```

**第二种难扫读**。**对齐是低成本高收益的可读性投资。**

### 3.8 配置文件（逐个说明）

#### `bundles/base.json`

```json
{
  "id": "base",
  "rows": [
    { "id": "config", "plugin": "../src/plugins/demo-config.ts",
      "config": { "workspace": "D:/agent-harness-lab", "model": "mock" } },
    { "id": "greeter", "plugin": "../src/plugins/demo-greeter.ts",
      "config": { "prefix": "你好" } },
    { "id": "legacy-extra", "plugin": "../src/plugins/demo-named-service.ts",
      "disabled": true, "config": { "serviceName": "legacy", "value": "（备用插件）" } }
  ]
}
```

**第三行演示了 `disabled`** —— **它存在于 bundle 里但默认不装载**，靠上层 patch 启用。

#### `profiles/dev.json`

```json
{
  "name": "dev",
  "bundles": ["../bundles/base.json"],
  "patch": [
    { "id": "config", "config": { "workspace": "D:/lab-dev", "model": "deepseek-chat" } },
    { "id": "greeter", "config": { "prefix": "【开发模式】" } }
  ]
}
```

**两处 patch 都是"整段替换"** —— 注意 `config` 的 patch 写了**两个字段**（因为不写就会丢）。

#### `patches/cli-override.json`

```json
{
  "patch": [
    { "id": "config", "config": { "model": "overridden-by-cli" } },
    { "id": "legacy-extra", "disabled": false },
    { "insert": [ { "id": "extra-plugin", "plugin": "../src/plugins/demo-named-service.ts",
                    "config": { "serviceName": "extra", "value": "（新插入的插件）" } } ] }
  ]
}
```

**三种操作各一个** —— 这就是演示 3 的内容。

**注意 `config` 的 patch 只写了 `model`** —— **这是故意的，为了演示"整段替换导致 workspace 丢失"**。

### 3.9 演示插件（三个）

#### `demo-config.ts` —— 从 config 读值

```ts
const plugin: Plugin = {
  name: 'demo-config',
  apply(ctx, config) {
    const workspace = typeof config?.['workspace'] === 'string' ? config['workspace'] : '（未指定）'
    const model = typeof config?.['model'] === 'string' ? config['model'] : 'mock'
    ctx.provide('config', { workspace, model })
  },
}
```

**注意它没有直接 `config['workspace'] as string`** —— 而是**做了类型检查**。

**为什么？** 因为 **config 来自外部 JSON 文件** —— 那是**边界**。

**"在边界处校验"的原则**（第 2 步讲过）在这里的应用。

**`config?.['workspace']`** —— 用了 `?.` 和**方括号访问**：

```ts
config?.['workspace']      // ✅ 方括号
config?.workspace          // ✅ 点号（但 TS 下 `config` 是 Record，点号也能用）
```

**两者在 `Record<string, unknown>` 上等价**。**方括号更明确地表达"这是字典查找"。**

#### `demo-greeter.ts` —— 声明依赖

```ts
const plugin: Plugin = {
  name: 'demo-greeter',
  inject: ['config'],
  apply(ctx, config) {
    const cfg = ctx.require<{ workspace: string; model: string }>('config')
    const prefix = typeof config?.['prefix'] === 'string' ? config['prefix'] : '你好'
    ctx.provide('greeting', `${prefix}｜工作目录 ${cfg.workspace}｜模型 ${cfg.model}`)
  },
}
```

**`inject: ['config']` + `require('config')` 一起用** —— 看起来重复，**但语义不同**：

| 机制 | 作用 |
|---|---|
| `inject` | **等它出现**（装载时不报错） |
| `require` | **取它**（此时必然存在） |

**为什么 `require` 能确定存在？** 因为 `inject` 保证了——**依赖齐了才会调 `apply`。**

**这是"声明依赖"和"取用依赖"的分工。**

#### `demo-named-service.ts` —— 服务名由配置决定

```ts
const plugin: Plugin = {
  name: 'demo-named-service',
  apply(ctx, config) {
    const serviceName = typeof config?.['serviceName'] === 'string' ? config['serviceName'] : 'unnamed'
    const value = typeof config?.['value'] === 'string' ? config['value'] : `我是 ${serviceName}`
    ctx.provide(serviceName, value)
  },
}
```

**它的存在理由写在了文件注释里**（见 1.7 的发现 2）：

> **插件不该假设"只有一个我"。**

**这个插件的名字 "named-service" 直接说明了它的特点** —— **名字来自配置**。

---

## L4 运行与验证

### 4.1 怎么运行

```powershell
cd D:\agent-harness-lab
node src/demos/demo-loader.ts
```

**必须在项目根目录运行** —— 因为 profile 路径是相对于当前目录的。

### 4.2 五组演示逐条解读

#### 演示 1 · base-only

```
--- config（来自 bundle）---        {"workspace":"D:/agent-harness-lab","model":"mock"}
--- greeting ---                    你好｜工作目录 D:/agent-harness-lab｜模型 mock
--- legacy-extra 装载了吗 ---        false
```

**要观察的三件事**：

| 观察 | 说明 |
|---|---|
| config 是 bundle 里的值 | 没有 patch 时，bundle 原样生效 |
| greeting 有值 | `inject` 的依赖已就绪，正常启动 |
| `legacy` 不存在 | **`disabled: true` 生效**（它的服务名是 `legacy`） |

**第三行验证了"禁用 = 不装载"。**

**同时 dump 里能看到它**：

```
  legacy-extra       ../src/plugins/demo-named-service.ts  [已禁用]
```

#### 演示 2 · dev profile

```
--- config（被 patch 覆盖）---      {"workspace":"D:/lab-dev","model":"deepseek-chat"}
--- greeting（前缀也被覆盖）---     【开发模式】｜工作目录 D:/lab-dev｜模型 deepseek-chat
```

**要观察的**：**两处 patch 都生效了** —— config 和 greeter 的 config 都被替换。

**而且 greeting 的内容跟着变了** —— 因为 greeter 读的是 config 服务的值。

**这演示了"配置 → 插件行为"的传导链**。

#### 演示 3 · 加命令行 patch（★ 最重要 ★）

```
--- config（★ 注意 workspace 丢了）---
{"workspace":"（未指定）","model":"overridden-by-cli"}

--- 新启用的插件 ---    （备用插件）
--- 新插入的插件 ---    （新插入的插件）
```

**三件事同时发生**：

| 观察 | 对应的 patch 操作 |
|---|---|
| `model` 变成 `overridden-by-cli`，**`workspace` 丢了** | **整段替换**（①） |
| `legacy` 出现了 | `disabled: false`（②） |
| `extra` 出现了 | `insert`（③） |

**第一行是本篇最重要的演示** —— 它让"整段替换"这个抽象规则**变成了看得见的后果**。

**如果当初选深合并**，第一行会是：

```
{"workspace":"D:/lab-dev","model":"overridden-by-cli"}      ← workspace 保留
```

**看起来"更好"，但代价是"你无法删除字段" + "值来源不可追溯"。**

#### 演示 4 · 装载顺序相反

```
--- 装载完成后 greeting（已经就绪）---
【顺序相反】｜工作目录 D:/reversed｜模型 mock

说明：greeter 排在 config 前面，装载它时依赖未就绪 → 挂起；
      但两行 await 之间的间隙让唤醒的微任务跑完了，
      所以 loadProfile 返回时它已经启动完毕。
```

**这一组原本想演示"挂起"，结果演示了"挂起几乎无缝"**（1.7 节的发现 1）。

**修正后的说明比原计划更有价值** —— 因为它揭示了 `await` 与微任务的交互。

**要观察的**：**顺序相反也能工作** —— 这是第 4 步 `inject` 的价值兑现。

#### 演示 5 · patch 指向不存在的 id

```
--- 被拒绝 ---
patch 指向不存在的行 id："does-not-exist"；当前有：config, greeter, legacy-extra
```

**要观察的**：**报错而不是静默忽略**，而且**列出了当前可用的 id**。

### 4.3 验收判据

| # | 判据 | 验证 |
|---|---|---|
| 1 | 五组演示全部符合上述输出 | 运行 |
| 2 | 演示 3 里 `workspace` 变成 `"（未指定）"` | 看输出 |
| 3 | 演示 3 里 `legacy` 和 `extra` 都出现 | 看输出 |
| 4 | 演示 5 的报错**列出了当前 id** | 看输出 |
| 5 | 你能说出"为什么是整段替换而不是深合并" | 口述 |
| 6 | 你能说出"没有 dump 会出什么问题" | 口述 |
| 7 | 你能说出"为什么动态 import 需要 `pathToFileURL`" | 口述 |
| 8 | **关掉文档**能写出 `composeRows` 的骨架 | 见 L6 |

---

## L5 语法速查（本篇新增）

> 第 1–5 步的语法分别在 [`01`](01-llm.md#l5-本篇-typescript-语法速查) / [`02`](02-tools.md#l5-语法速查本篇新增) / [`03`](03-context.md#l5-语法速查本篇新增) / [`04`](04-events.md#l5-语法速查本篇新增) / [`05`](05-scope.md#l5-语法速查本篇新增) 里。

| 语法 | 例子 | 含义 | 注意 |
|---|---|---|---|
| **`'key' in obj`** | `if ('insert' in item)` | 判别联合类型的变体 | 运行时也有效 |
| **条件展开** | `...(cond ? { k: v } : {})` | 只在条件成立时覆盖字段 | 区分"没写"和"写了 undefined" |
| `resolve` / `dirname` | `dirname(absoluteProfile)` | 路径处理 | `node:path` |
| **`pathToFileURL`** | `pathToFileURL(path).href` | 路径 → file:// URL | **Windows 动态 import 必需** |
| **动态 `import()`** | `await import(url)` | 运行时加载模块 | 返回命名空间对象 |
| `mod.default` | 取默认导出 | | `export default` 对应 |
| `Array.isArray` | 判别数组 | | |
| `(x as { k?: unknown }).k` | 从 `unknown` 取字段 | | 需要断言 |
| 泛型函数 | `readJson<T>(path): Promise<T>` | 调用方指定类型 | `as T` 无运行时检查 |
| 可选参数 + 默认值 | `patchFiles = []` | 默认值 | |
| 对象方法简写 | `{ dump(): void { ... } }` | 在对象字面量里写方法 | |

### 本篇新增的两条规则

**规则 19：Windows 上动态 `import()` 必须用 `file://` URL**

```ts
await import('D:/x/y.ts')                 // ❌ Windows 失败
await import(pathToFileURL('D:/x/y.ts').href)   // ✅
```

**规则 20：条件展开是"可选覆盖"的标准写法**

```ts
// ✅ 只在 patch 里写了这个字段时才覆盖
{ ...existing, ...(item.config !== undefined ? { config: item.config } : {}) }

// ❌ 没写时会把原值覆盖成 undefined
{ ...existing, config: item.config }
```

---

## L6 关文档重写判据

### 必须能写出的部分

| 难度 | 要写的东西 | 通过标准 |
|---|---|---|
| ★ | `PluginRow` / `BundleFile` / `ProfileFile` | 字段完整 |
| ★★ | 判别联合 `PatchItem` | **用 `'insert' in item` 判别** |
| ★★★ | **`composeRows`** | **`put` 函数的"覆盖不改位置" + 三处错误检查** |
| ★★★ | 条件展开 | **区分"没写"和"写了 undefined"** |
| ★★★ | `loadProfile` 的装载循环 | **`resolve` + `pathToFileURL` + 导出检查** |
| ★★ | `dump` | 包含被禁用的行 |

### 卡住时的自检问题

| 卡在哪 | 问自己 |
|---|---|
| `composeRows` 的顺序 | "同一个 id 被覆盖后，它应该排到后面去吗？" |
| 整段替换 | "patch 里没写某个字段，那个字段应该保留还是清掉？" |
| 错误检查 | "patch 指向不存在的 id 时，静默忽略会有什么后果？" |
| 装载循环 | "Windows 上 `import('D:/x.ts')` 会成功吗？" |
| `dump` | "为什么被禁用的行也要打印？" |

### 分级判定

| 程度 | 判定 |
|---|---|
| 能写出 ★★ 及以下 | 不够 L3，重读 3.4 |
| 能写出 ★★★ 但条件展开写错 | **回去想"没写这个字段"和"写了 undefined"的区别** |
| 全部写出 | ✅ **达标** |

---

## L7 挑战题（不给答案）

### 挑战 1 · 让 dump 显示"每个值来自哪一层"

现在的 dump 只显示最终值，**不显示它是从哪一层来的**。

**要求**：

1. 在 `composeRows` 里记录每一行的"来源层"
2. dump 输出类似：`config  [base] [dev.patch] [cli.patch]`
3. **思考**：这会让 `PluginRow` 类型变复杂吗？值不值得？

### 挑战 2 · 加"机器级 patch"

第 6 步的层叠顺序里，③（`~/.harness/patch.json`）没实现。

**要求**：

1. 实现它——在 profile patch 和命令行 patch 之间插一层
2. **思考**：为什么它比 profile patch 优先级**更高**？（提示：个人偏好 vs 项目配置）
3. 如果这个文件不存在，应该报错还是跳过？

### 挑战 3 · 加插件配置的 schema 校验

现在插件的 config 是 `Record<string, unknown>`，**写错字段名不会被发现**。

**要求**：

设计一个方案，让插件能声明自己的配置 schema，装载器在装载前校验。

**三种思路**：

| 思路 | 做法 |
|---|---|
| A | 插件导出 `configSchema`（JSON Schema 子集，复用第 2 步的 `JsonSchema`） |
| B | 插件导出一个 `validateConfig` 函数 |
| C | 不做 —— 让插件自己在 apply 里检查 |

**分析三者代价**。DSH 的做法是 A（它用一个叫 schemastery 的库）。

### 挑战 4 · 让 `insert` 也能被后续 patch 修改

现在：`insert` 的行如果后面还有 patch 层，**能不能被改**？

**去验证**（提示：看 `composeRows` 的循环顺序）。

**然后思考**：这个行为是"恰好如此"还是"有意设计"？如果要明确支持，需要改什么？

### 挑战 5 · 并发装载

现在的装载是**串行**的（`await` 每个插件）。

**问题**：

1. 能不能并发装载（`Promise.all`）？
2. 如果并发，**依赖注入会怎样**？（提示：挂起机制的触及时机）
3. 并发装载的**收益和风险**分别是什么？

**这道题考察的是"能不能正确评估并发的代价"。**

---

## L8 自检清单

### 理解层（L1）

- [ ] 我能说出 bundle / profile / patch 三者的分工
- [ ] 我能说出完整的层叠顺序
- [ ] ★ **我能论证"整段替换 > 深合并"**
- [ ] 我能说出"为什么用 `disabled` 而不是删除"
- [ ] **我能说出"没有 dump 会出什么故障、为什么难查"**
- [ ] 我能说出"为什么装载顺序可以无所谓"

### 实现层（L3）

- [ ] 我关掉文档写出了 `composeRows`
- [ ] 我写出了"覆盖不改变位置"的 `put`
- [ ] 我写出了条件展开（区分"没写"和"写了 undefined"）
- [ ] 我写出了装载循环（含 `pathToFileURL`）
- [ ] 我能解释"为什么错误信息要列出当前 id"

### 语法层

- [ ] 我会用 `'key' in obj` 判别联合类型
- [ ] 我知道 Windows 动态 import 需要 `file://`
- [ ] 我会写条件展开做可选覆盖

### 系统层（L4）

- [ ] 我能说出配置系统在第 16 步"演化"里的角色
- [ ] 我能说出 `dump` 对"改了没生效"的诊断价值
- [ ] 我能说出"插件不该假设只有一个我"的原因

---

## L9 仍未解决

### 会被后续步骤解决的

| 遗留问题 | 哪一步 |
|---|---|
| 没有端到端入口（要手工调 `loadProfile`） | 第 11 步（CLI） |
| 装载后没有 agent 可跑（只有服务） | 第 8 步 |
| 配置里没有"agent 声明" | 第 8 步 |

### 当前实现的真实缺陷

#### 缺陷 1 · `readJson` 的类型断言无运行时校验 ★

```ts
async function readJson<T>(path: string): Promise<T> {
  const text = await readFile(path, 'utf8')
  try {
    return JSON.parse(text) as T      // ← 只保证是合法 JSON，不保证结构对
  } catch (cause) { ... }
}
```

**问题**：`as T` 让编译器闭嘴，但**运行时只检查了"是不是合法 JSON"**，没检查结构。

**后果**：一个 `profile.json` 里 `bundles` 写成了字符串（而不是数组）：

```json
{ "name": "x", "bundles": "../bundles/base.json" }     ← 少了方括号
```

**装载器会在 `for (const relative of profile.bundles)` 那里崩**，错误信息是：

```
TypeError: profile.bundles is not iterable
```

**一个和真实原因（配置写错）隔了一层的信息。**

**修法**：对读进来的结构做校验（至少检查必填字段和数组类型）。

**为什么不修**：校验要写不少代码，而我们只读自己写的几个文件。

**但在真实项目里这是必须的** —— 因为配置文件是**用户写的**。

#### 缺陷 2 · 两套路径基准并存

```ts
// bundle 和插件的路径：相对 profile 目录
bundles.push(await readJson<BundleFile>(resolve(baseDir, relative)))
const modulePath = resolve(baseDir, row.plugin)

// 命令行 patch 的路径：相对 cwd
layers.push(await readPatchLayer(resolve(file)))
```

**问题**：**同一个函数里有两个不同的路径基准**，而且**没有在文档/签名里标出来**。

**后果**：用户困惑 —— "为什么 bundle 里的路径是相对 profile 的，而 `--patch` 是相对当前目录的？"

**两种基准都有理由**（见 3.6 节的论证），**但混在一起容易出错**。

**修法**：

| 方案 | 说明 |
|---|---|
| A | 统一为相对 profile 目录 | 命令行参数就不方便了 |
| B | 统一为相对 cwd | bundle 挪位置就坏 |
| **C** | 保持两种，但**在 dump 里打印解析后的绝对路径** | ✅ **推荐** |

**C 的价值**：**dump 是"观察实际生效的东西"的地方，路径也算"生效的东西"。**

#### 缺陷 3 · 没有循环依赖检测

```
bundle A 引用 bundle B
bundle B 引用 bundle A
   ↓
loadProfile 会怎样？
```

**现在的行为**：bundle 之间**不能互相引用**（profile 只列 bundle 文件，bundle 不列子 bundle），所以**这个问题不存在**。

**但如果将来支持嵌套 bundle**，就需要检测。

**记下来**，因为**"叠加"的设计哲学很可能导致"想支持嵌套"的需求**。

#### 缺陷 4 · 插件模块没有缓存

```ts
const mod = (await import(url)) as { default?: unknown }
```

**Node 的 `import` 有模块缓存** —— 同一个 URL 只加载一次。

**这对我们是有利的**（同一个插件被多行引用时，模块只执行一次），**但要注意**：

> **模块级状态会被共享。**

如果某个插件在模块顶层写了可变状态：

```ts
// 插件文件里
let counter = 0      // ← 模块级状态

const plugin: Plugin = {
  apply(ctx) { counter++; ctx.provide('n', counter) }
}
```

**两次装载会共享 `counter`** —— 因为它们用的是同一个模块实例。

**这是"同一个模块装载两次"的隐藏陷阱**，而**我们的 `demo-named-service` 恰好演示了它的反面**（无状态，服务名从配置来）。

**修法**：文档里写明"插件不该有模块级可变状态"。

#### 缺陷 5 · `unloadAll` 的幂等性没保证

```ts
unloadAll: (): void => {
  for (const unload of [...unloads].reverse()) unload()
}
```

**问题**：**调用两次会怎样？**

- `ctx.plugin()` 返回的卸载函数**是幂等的**（第 3 步实现了）
- 所以第二次调用 `unload()` 是无害的

**所以 `unloadAll` 实际上是幂等的** —— 但它**不是通过自己的逻辑保证的**，而是**依赖了每个 `unload` 的幂等性**。

**这是"隐式依赖"** —— 如果将来某个 `unload` 不幂等，`unloadAll` 就会出问题。

**修法**：加一个标志位（和它依赖的东西一样）。

#### 缺陷 6 · 没有"必需服务"的检查

**装载完成后，没有任何机制检查"这套配置是不是完整的"。**

比如：

```
某个 profile 只装了 greeter，没装 config
   ↓
greeter 挂起（等 config）
   ↓
★ 永远挂着，没有任何提示 ★
```

**这正是第 4 步缺陷 6 说的问题**（挂起插件没有超时）。

**而第 6 步是"装载完成"的判定者**，**所以这里是最合适的检查点**：

```ts
// 装载循环之后
const stillPending = ctx.pendingPluginNames()     // ← 需要新 API
if (stillPending.length > 0) {
  throw new Error(`以下插件的依赖未被满足：${stillPending.join(', ')}`)
}
```

**为什么没做**：需要给 `Context` 加一个查询挂起插件的方法（第 4 步没预留）。

**这一条明确写进第 8 步的设计笔记** —— 因为第 8 步的 agent 装载会用到这里。

> **这是"跨步骤的缺陷传递"** —— 第 4 步留下的口子，到这里变成必须解决的问题。

---

## L10 提问训练

### 本篇引出的 12 个好问题

**关于设计（L3 层）**

1. 为什么 `composeRows` 用 `Map` + 数组两个结构？只用 `Map` 行不行？
2. 为什么"覆盖不改变位置"？如果改成"覆盖后移到后面"会怎样？
3. 为什么 `baseDir` 取 profile 的目录而不是 bundle 的？
4. 为什么命令行 patch 的路径基准和 bundle 的不一样？
5. 为什么 `dump` 要打印被禁用的行？

**关于系统（L4 层）**

6. **`composeRows` 是纯函数（不碰 IO）—— 这对测试有什么价值？**
7. 第 8 步要在配置里加"agent 声明"，应该加在哪一层？（bundle / profile / 新概念）
8. 第 16 步的"演化"要改配置，**它应该改哪一层的 patch？**为什么？
9. **装载完成后怎么检测"配置不完整"？**（提示：缺陷 6）

**关于科研（L5 层）**

10. **配置系统能否用来定义"实验组"？** 一个 profile = 一个实验配置？
11. **"分层消融"实验里，每一层的配置应该怎么组织？**（bundle 复用 + patch 差异）
12. **如果要自动化"配置搜索"（比如找最优的 retry 参数），配置系统需要提供什么能力？**

### 问题升级练习

| 模糊问题 | 精确问题 | 提升在哪 |
|---|---|---|
| "为什么要分层？" | "如果没有 patch 层，'dev 和 prod 只差一个 model 参数'该怎么配置？要维护几份文件？" | 指出了**替代方案的具体成本** |
| "整段替换有什么问题？" | "如果 patch 里只写了 model，那 workspace 会变成什么？用户怎么避免？" | 要求**推演具体后果** |
| "dump 有什么用？" | "配置改了没生效时，没有 dump 你要读几个文件、在脑子里做几步推演？" | 量化了**没有它的成本** |

> ### 你的练习
>
> 挑一个改写，发给我：
>
> 1. "为什么要用 JSON 不用 YAML？"
> 2. "bundle 和 profile 有什么区别？"
> 3. **"我的实验需要一个'实验组配置'，用 profile 表达合适吗？"**

---

## L11 系统影响回溯

### 11.1 三个预判的检验

| 第 0.5 节的问题 | 现在你应该能答的 |
|---|---|
| `workspace` 变成"（未指定）"是 bug 还是设计？ | **设计**（整段替换的代价）。避免方式：patch 里写全字段 |
| 如果允许 patch **删除**整行，要加什么字段？ | 加 `remove: true` 或者用 `insert` 的反面操作。**和 `disabled` 的区别**：删除后 dump 看不到，禁用能看到 |
| 两个 bundle 同 id 谁赢？合理吗？ | **后面的赢**（`put` 的实现）。合理 —— 因为 bundle 列表是"有序的层" |

**第 3 个问题值得展开**：

**"后面的赢"和 patch 的"后面的赢"是同一条规则** —— **整个系统只有一个覆盖方向：向后覆盖**。

**这条统一性很重要** —— 如果 bundle 是"前面的赢"而 patch 是"后面的赢"，用户就要记两套规则。

> **一致性比"某个选择更合理"更重要。**

### 11.2 本篇的"锚点"一句话

> **把装配变成数据，并且让"最终生效的配置"随时可打印。**

它在后面的影子：

| 哪一步 | 同一思想的再现 |
|---|---|
| 第 7 步 | 会话日志是"数据的层" —— 原始事件不变，投影可重算 |
| 第 11 步 | CLI 就是"读 profile + 装载 + 跑任务" |
| 第 15 步 | 诊断结果也是"可打印的数据" |
| **第 16 步** | **演化 = 改配置 + 跑对照 + 看 dump 对比** |

**第 16 步是这份配置系统的最终用户** —— 因为**"自动演化"就是"程序化地生成 patch"**。

**这也解释了为什么配置必须是 JSON**：**第 16 步要能程序化地读写它。**

### 11.3 通向第 7 步的桥

**第 6 步结束时，系统状态：**

```
✅ 插件能提供能力、监听事件、声明依赖、隔离
✅ 配置能从文件装载整套系统
❌ 但没有"记忆"：跑一次任务，过程就没了
❌ 没有循环：插件装好了，但没人驱动"请求 → 工具 → 再请求"
❌ 没有会话：无法回答"上次这个配置跑出过什么问题"
```

**第 7 步要解决"记忆"。** 带着这些问题进入：

1. 现在一次任务的过程**只存在于内存里**。进程一退，什么都没了。**怎么让它持久？**
2. 如果直接把消息数组存成文件，**能回答"这次为什么失败"吗？**（提示：只存结果不够，要存过程）
3. **"模型看到的历史"和"存下来的日志"应该是两份数据吗？** 如果不是，它们的关系是什么？
4. 如果日志要能"从某个历史点重新开始"（fork），**数据结构要怎么设计？**
5. **你的科研要"平均完成步数" —— 这个数字从日志的哪个部分能算出来？**

**第 3 个问题是第 7 步的核心** —— 它的答案就是 DSH 那条最重要的不变量：

> **Model-visible ⟺ logged。**

---

## 本篇完结

| 检查项 | 应该达到 |
|---|---|
| 能说出三个概念的分工与层叠顺序 | L1 |
| **能论证"整段替换 > 深合并"** | L1 |
| 能说出 dump 的诊断价值 | L1 |
| **能关掉文档写出 `composeRows`** | **L3** |
| 能写出条件展开做可选覆盖 | L3 |
| 能说出"配置系统与演化层的关系" | L4 |
| 能提出至少 3 个 L4/L5 层的问题 | L4 |

---

**读完这篇，请回答我三个问题：**

1. **"整段替换"这个选择**：你觉得它对你的实验配置管理是**帮助**还是**负担**？（可以联系你实际的实验场景）
2. **缺陷 6**（配置不完整检测）：如果装载完成后有插件还挂着，应该**报错**、**警告**，还是**静默**？为什么？
3. **下一站**：`07-session.md`（会话日志 —— 你科研最需要的那个），还是先补 Phase 1 的收尾？

**我建议下一站是 `07-session.md`** —— 因为它是 Phase 2 的地基，而且**它的代码量最大、与你科研的关联最直接**（"平均完成步数从哪来"的答案就在那里）。
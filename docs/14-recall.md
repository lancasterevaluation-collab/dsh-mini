# 第 14 步 · 用户建模 + 历史检索

> **产出文件**：`src/evolution/user-model.ts`（约 210 行）、`src/evolution/recall.ts`（约 250 行）
> **DSH 对应**：`packages/session-query/`（DSH 有会话浏览与导出，没有 FTS 索引；用户建模无对应物）
> **目标级别**：L3（关掉本文，能用 FTS5 建一个可检索的历史索引）
> **验收判据**：FTS5 检索到指定历史事件；用户偏好是**派生结论**而不是存下来的原文

---

## L0 要解决的问题

第 12、13 步给了我们"记住结论"和"存下流程"的能力。但还有一个东西没有归宿：**过去发生过什么**。

会话日志里有全部事实 —— 问题是**拿不回来**：

```
"上次那个报 ENOENT 的是哪个文件？"
"我们什么时候决定用 pnpm 的？"
"这个工具失败过几次？"
```

翻日志文件（JSONL）当然能找到，但那是人的动作，不是 agent 的动作。agent 要能自己回答这些问题，才谈得上"从历史里学习"。

另有一个更隐蔽的问题：**"记住用户是谁"最容易做错**。直觉做法是存档对话：

```
用户: 你好，帮我看看这个项目
用户: 顺便把 README 更新一下
用户: 简单点
```

存原文有三个代价，每一个都会在真实使用里咬人：

| 代价 | 现象 |
|---|---|
| **不可用** | 下次任务开始时，要么全塞进上下文（贵），要么不塞（白存） |
| **不可纠** | 用户改主意了，旧原文还在，"以哪句为准"没有答案 |
| **不可信** | 原文里一次性的口误，会被当成长期偏好 |

## L1 设计与原理

### 1.1 检索：为什么选 FTS5 而不是向量

| 维度 | FTS5（我们选的） | 向量检索 |
|---|---|---|
| 依赖 | SQLite 内置（`node:sqlite`） | 需要编码器（本地模型或 API） |
| 可解释 | 命中就是命中了，能指出词 | 相似度是一个数，说不出为什么 |
| 精确匹配 | 搜 `pathGuard` 天然准 | 标识符的向量往往很怪 |
| 语义 | 弱（同义改写搜不到） | 强 |

而**日志检索的真实查询几乎都是字面题**："找那句话 / 那个文件 / 那个错误码"。所以选 FTS5：零依赖、可解释、对标识符友好。

**中文必须用 trigram 分词器**：

```sql
CREATE VIRTUAL TABLE events_fts
USING fts5(session_id UNINDEXED, seq UNINDEXED, type UNINDEXED, text, tokenize='trigram')
```

默认的 `unicode61` 把连续 CJK 当**一个 token** —— "读取文件失败了"整体成为一个词，搜"读取"搜不到。`trigram` 按 3 字符滑窗建索引，中文可检索；代价是**查询至少要有 3 个字符**，更短的走 LIKE 回退。

这个"回退"不是补丁，而是**接口的一部分**：

```ts
const MIN_MATCH_LENGTH = 3
if (trimmed.length < MIN_MATCH_LENGTH) return this.#searchLike(trimmed, limit)
```

### 1.2 只索引"有语义的那部分"

```ts
export function searchableTextOf(type: string, data: unknown): string
```

为什么不让调用方把整个 `data` JSON 化？因为那会把**字段名**也塞进索引 —— 于是搜 `id` 命中一切，搜 `name` 命中一切。索引的可用性直接取决于"索引里放的是什么"。

`toolCallId`、`isError` 这类字段对检索毫无价值；有价值的是工具名 + 内容、错误码 + 消息。

### 1.3 用户建模：派生结论，不存原文

```ts
export interface UserConclusion {
  readonly id: string
  readonly kind: 'preference' | 'constraint' | 'topic'
  readonly text: string                 // 提炼后的说法，不是原文
  readonly evidence: readonly MemorySource[]   // 它凭什么（指回具体事件）
  readonly observations: number          // 被观察到几次
  readonly confidence: number            // 由 observations 算出
}
```

三样东西缺一不可：

- **text** 是结论，不是原文 → 可以直接注入上下文，成本可控
- **evidence** 指回事件 → 用户问"你凭什么认为我偏好简短回答"，能给出命中的那句话
- **observations** → 一次是噪声，重复出现才是偏好

### 1.4 ★ 置信度是"次数"的函数，不是模型自报的 ★

```ts
export function confidenceOf(observations: number): number {
  return 1 - 1 / (observations + 1)
}
```

一次 0.50、两次 0.67、三次 0.75、五次 0.83、九次 0.90。

**为什么不让模型自报"我有 0.8 的把握"？** 因为它的把握既不校准也不可比较 —— 同一个模型在不同任务上说的 0.8 含义不同。

而"同一个结论在 5 次任务里出现过"是一个**可验证的事实**。这个函数单调、有界、可解释，而且不需要模型配合。

### 1.5 提取信号用规则，而不是让模型总结

```ts
export function extractSignals(task: string, source: MemorySource): readonly UserSignal[]
```

规则会漏，但漏的代价（少一条偏好）远小于误判的代价（错误的长期约束）。

更重要的理由是**可解释**：用户问"你凭什么认为我禁止修改"，规则能给出命中的那句话；模型总结只能给出"我觉得"。

## L2 决策表

| # | 决策 | 我们的选择 | 替代方案 | 代价落在谁身上 |
|---|---|---|---|---|
| 1 | 检索技术 | SQLite FTS5 + trigram | 向量检索 / 全表 LIKE | **语义召回**：同义改写搜不到；换来零依赖与可解释 |
| 2 | 短查询 | LIKE 回退 | 拒绝执行 / 提示"至少 3 字符" | **实现复杂度**：两条路径要维护；换来"2 个字符也能搜" |
| 3 | 索引内容 | 只索引语义字段 | 整条事件 JSON | **召回范围**：搜不到字段名；换来索引不被噪声淹没 |
| 4 | 存储位置 | 默认内存，可传路径 | 强制落盘 | **持久性**：进程退出即丢；换来演示与测试的简单 |
| 5 | 用户建模单位 | 结论 + 出处 + 次数 | 存原文 / 只存结论 | **存储**：结论可能被认为"丢失了细节"；换来可注入、可反驳 |
| 6 | 置信度来源 | 观测次数 | 模型自报 | **表达力**：无法表达"这一条特别重要"；换来不依赖模型配合 |
| 7 | 信号提取 | 规则（正则） | 让模型抽取 | **召回**：漏掉没写进规则的表达；换来可解释与零成本 |
| 8 | 注入阈值 | 置信度 ≥ 0.6 才注入 | 全部注入 | **覆盖**：只出现一次的偏好不会进上下文（这是有意的） |

**关于第 8 条**：阈值 0.6 意味着"至少出现两次"。这是一条**判断**，不是推导 —— 它的依据是"一次出现更可能是口误"。阈值可由 `brief(minConfidence)` 的调用方覆盖。

## L3 实现与验证

### 3.1 文件清单

| 文件 | 职责 | 关键点 |
|---|---|---|
| `evolution/recall.ts` | FTS5 索引 | trigram / 短查询回退 / `searchableTextOf` |
| `evolution/user-model.ts` | 结论模型 | 信号提取 / 证据累积 / 置信度 / 摘要 |
| `plugins/evolution.ts` | 接线 | `session/event` → 索引 + 观察 |

### 3.2 关键代码

**短语查询要转义引号**

```ts
const phrase = `"${trimmed.replace(/"/g, '""')}"`
```

FTS5 的 MATCH 语法里引号是短语定界符。不转义的话，用户输入一个引号就让查询变成语法错误 —— 而 `try/catch` 兜底成 LIKE 又会让"高级查询"静默失效。转义比兜底更正确。

**索引走事务**

```ts
indexMany(events) {
  this.#db.exec('BEGIN')
  try { for (const event of events) this.index(event); this.#db.exec('COMMIT') }
  catch (error) { this.#db.exec('ROLLBACK'); throw error }
}
```

SQLite 逐条提交每个 INSERT 都要一次 fsync，几百条会慢一个数量级。

**结论的合并是"累加证据"而不是"新增一条"**

```ts
const existing = this.#conclusions.find((item) => item.kind === signal.kind && item.text === signal.text)
if (existing === undefined) { /* 新建，observations = 1 */ }
else { /* observations += 1，confidence 重算 */ }
```

### 3.3 运行验证

```powershell
node src/demos/demo-recall.ts
```

真实输出（节选）：

```
======== 演示 2：中文与标识符都能搜到 ========

查询 "读取文件失败" → 1 条
  [s-1#7] tool/result  分数=1.1422
      read_file 读取文件失败：ENOENT: no such file or directory

查询 "pnpm" → 2 条
  [s-2#5] assistant/message  分数=1.0850
      这个项目用 pnpm，workspace 配置在 pnpm-workspace.yaml
  [s-2#2] user/message  分数=1.0254
      检查 pnpm 的 workspace 配置

查询 "pathGuard" → 1 条
  [s-2#9] tool/guard  分数=1.5311
      pathGuard 路径越界：../outside.txt

======== 演示 3：短查询走 LIKE 回退 ========
--- 查询 "pn"（2 字符） ---
[ "检查 pnpm 的 workspace 配置", "这个项目用 pnpm，workspace 配置在 pnpm-workspace." ]
```

用户建模（节选）：

```
======== 演示 6：同一结论观察到多次，置信度上升 ========
--- 三次之后 ---
[
  { "text": "用户偏好简短的回答", "observations": 3, "置信": "0.750", "证据数": 3 }
]

★ 置信度是"次数"的函数，不是模型自报的：
  1 次 → 0.500
  2 次 → 0.667
  3 次 → 0.750
  5 次 → 0.833
  9 次 → 0.900

======== 演示 8：每条结论都能回到原始事件 ========
{ "id": "user-1", "kind": "preference", "text": "用户偏好简短的回答",
  "evidence": [ {"sessionId":"s-1","seq":3}, {"sessionId":"s-2","seq":1}, {"sessionId":"s-3","seq":2} ],
  "observations": 3, "confidence": 0.75 }
```

### 3.4 验收判据

| 判据 | 怎么验 | 期望 |
|---|---|---|
| 中文可检索 | `search('读取文件失败')` | 命中对应的 `tool/result` |
| 标识符可检索 | `search('pathGuard')` | 命中 `tool/guard` |
| 短查询可用 | `search('pn')` | 走 LIKE 回退仍有结果 |
| 按类型取最近 | `recent('assistant/attempt')` | 按 seq 降序 |
| 结论有出处 | 任取一条 `UserConclusion` | `evidence` 非空且能指回事件 |
| 置信度随次数上升 | 3 次观测 | ≈ 0.75 |
| 一次观测不注入 | `brief(0.8)` | 返回空串 |

## L4 仍未解决

| 缺陷 | 后果 | 修法 | 当初为什么这么选 |
|---|---|---|---|
| **索引不持久** | 进程重启后历史检索为空（演示用内存库） | 传 `recallPath` 到 `localStorage`；`plugins/evolution.ts` 已经支持落盘 | 默认内存让演示与测试无副作用 |
| **没有增量删除** | 日志是 append-only 所以暂时没需求，但一旦支持"删会话"就会留下幽灵条目 | 加 `deleteBySession(id)` | 当前无删除语义 |
| **信号规则偏少** | 只有 5 条偏好 + 3 条约束 + 路径主题 | 按用户真实表达逐步补（这正是"读者提问优先"的用法） | 宁可漏，不可误判 |
| **证据只有坐标没有片段** | 要复核得自己按 `seq` 去翻日志 | `evidence` 里带 `quote: string`（前 40 字） | 担心存储膨胀，但 40 字 × 10 条也很小 —— **这条其实该改** |
| **没有冲突检测** | 先后出现"用 pnpm"和"用 npm"两条约束会共存，模型每次都要自己挑 | 同 `kind` + 高词重叠 + 文本相反时标为冲突，交给第 16 步门控裁定 | 需要"相反"的判定，属难点 |
| **`brief()` 的排序只按置信度** | 一条 `constraint`（禁止改某文件）可能排在 `topic` 后面被截掉 | 按 kind 加权：constraint > preference > topic | 现在最多 5 行，还没暴露；**已知隐患** |
| **检索不到"多轮之间"的模式** | "最近三次都在同一个文件上失败"这类跨事件查询做不到 | 在 FTS 之上加聚合查询接口 | 那是分析层（第 15 步的领域），不在本步 |

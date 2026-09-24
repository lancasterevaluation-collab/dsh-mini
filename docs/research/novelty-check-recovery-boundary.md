# 新颖性核查：可恢复性边界选题已被大量覆盖

> 核查时间：2026-09
> 核查方法：3 轮并行检索，按"失败分类学 / 类型×干预匹配 / 可恢复性测量 / 回滚合法性"四个线索查
> **结论：我提的每个设计点都有人做过。但"问题存在"现在有强证据。**

---

## 1. 直答两个问题

| 问题 | 答案 |
|---|---|
| **这有人做过么？** | ❌ **做过，而且很多**（下面 4 组共 12+ 篇） |
| **确定问题存在么？** | ✅ **确定存在**，而且证据比之前强得多（见 §3） |

---

## 2. 重合度核查：我提的每个设计点 ↔ 已有工作

| 我在方案里的设计 | 已有工作 | 重合度 |
|---|---|---|
| **失败类型分类学**（T₁能力不足/T₂有能力未做/T₃不可逆） | **"Failure as a Process"**（1,184 轨迹）：**Epistemic 57.9% / Competence 32.8% / Environment 9.4%** | ★ **几乎一样** |
| 同上 | **AgentErrorTaxonomy**（UIUC, arXiv 2509.25370）：memory/reflection/planning/action/system | 高 |
| 同上 | **MAST**（Cemri et al., arXiv 2503.13657）：**3 类 14 种失败模式** | 高 |
| 同上 | **ToolScan**（arXiv 2411.13547, ICLR 2025 Workshop）：**7 种工具调用错误** | 高 |
| **类型 × 干预的匹配矩阵** | **`triage` 框架**（PyPI `triage-agent`，PyCon JP 2026 演讲 *"Retry Is Not a Strategy"*）：**9 类失败 → FailurePolicy 字段一一映射** | ★★ **就是这个矩阵** ★★ |
| 同上 | **failure-aware routing matrix**（arXiv 2605.10057）：MISS **80.8%** / FAIL **51.7%** / BLOCK **63.2%** 恢复率 | ★★ **已是恢复率矩阵** ★★ |
| **按类型测恢复成本** | **ACM 10.1145/3816046.3816225**：Execution-State Corruption **5.0 turns** / Semantic Misalignment **2.08** / Pragmatic Failure **1.0** | ★★ **已做** ★★ |
| **可恢复性指标** | **PALADIN**（arXiv 2509.25238）：定义 **RR / TSR / CSR / ES** 四个恢复指标 | ★★ **已定义** ★★ |
| **不可逆性是 harness 属性（我的 H3）** | **DART**（arXiv 2605.23311）：形式化 **semantic recoverability**，证明"回滚跨越**不可逆效果边界**"时局部回滚语义无效 | ★★ **已形式化** ★★ |
| **等算力对照（防重采样混淆）** | **SYMTRACE**（*Repair or Resample?*, arXiv 2608.25920）：用 **execution replay** 区分"真修复"与"随机重采样" | ★★ **已解决** ★★ |
| **agent 恢复失败的证据** | **Hell or High Water**（**COLM 2025**, JHU-CLSP, arXiv 2508.11027） | ★★★ **正是这个选题** ★★★ |

### ★ 最接近的一篇：Hell or High Water ★

| 项 | 值 |
|---|---|
| 标题 | *Hell or High Water: Evaluating Agentic Recovery from External Failures* |
| venue | **COLM 2025** ✅ 确认 |
| 团队 | **JHU-CLSP**（Wang, Hager, Asija, Khashabi, Andrews）—— 与 Feedback Friction 同组 |
| 代码 | `github.com/JHU-CLSP/hell-or-high-water` |
| 研究问题 | **agent 的计划因外部原因失败时，它们多会找替代方案？** |
| 设计 | 4,450 个函数的大动作空间 + 语义检索工具；**注入外部失败但保证任务仍可解** |
| **失败分类学** | **① search failures ② ID failures ③ chaining failures ④ tool-use failures** |
| 核心发现 | ① 模型**能找到正确工具，却无法从失败中适应**；② **search failures 占 53–66%**；③ **scaling 不解决这个 gap，且不是涌现能力** |

**它和我的方案在"研究问题 + 分类学 + 度量"三层都重合。**

---

## 3. ✅ ★ "问题存在"现在有强证据 —— 这是本次核查最大的收获 ★

**你问的第二件事，答案从"部分能证明"升级为"确定存在"。**

| 证据 | venue | 结论 |
|---|---|---|
| **Hell or High Water** | **COLM 2025** | 模型能找到工具但**无法从外部失败恢复**；**scaling 不解决** |
| **Feedback Friction** | **NeurIPS 2025** | 即使**近乎完美的反馈**也被系统性抵抗 |
| **Roig 2025**（900 traces） | arXiv 2512.07497 | ★ **"recovery capability — not initial correctness — is the dominant predictor of agentic task success"** ★ |
| **"Failure as a Process"** | arXiv 2607.09510（1,184 轨迹） | ★ **"agents fail more by misusing available information than by lacking capability"**（Epistemic 57.9%）★ |
| **ACM 恢复成本研究** | 10.1145/3816046.3816225 | **Execution-State Corruption 恢复延迟 5.0 turns，且有一例不可恢复** |
| **R06 / Stechly / Kamoi** | ICLR 2024–2025 / TACL | 自助校正不可靠 |

### ★ 这两句话可以直接回答导师 ★

> **① "recovery capability — not initial correctness — is the dominant predictor of agentic task success."**
> —— **恢复能力**比初始正确率更能预测任务成功（Roig 2025, 900 traces）
>
> **② "agents fail more by misusing available information than by lacking capability."**
> —— **agent 的失败更多是"误用了已有信息"，而不是"能力不足"**（Failure as a Process, 1,184 轨迹，Epistemic 57.9%）

**第 ② 句 ≈ 直接说"类型②（有能力未做）占主导"** —— 这正是"干预有空间"的证据。

**导师问"问题存在么"，你现在可以回答**：

> **"存在，而且有三重独立证据：COLM 2025 的恢复实验、NeurIPS 2025 的反馈抵抗、以及 1,184 条真实轨迹里 58% 的错误属于'误用已有信息'。**
> **并且 Roig 2025 证明'恢复能力'比'初始正确率'更能预测成功。"**

---

## 4. 这个赛道的拥挤时间线

```
2024-11  ToolScan（7 种工具错误）                    ICLR 2025 Workshop
2025-03  MAST（3 类 14 种多智能体失败）              arXiv
2025-06  Feedback Friction                           NeurIPS 2025
2025-08  Hell or High Water                          COLM 2025
2025-09  AgentErrorBench + AgentDebug（UIUC）        ICML 2026 列表
2025-09  PALADIN（训练恢复能力，RR 33%→90%）         arXiv
2025-12  Roig（恢复能力是主预测因子）                arXiv
2026-01  "Recoverability Has a Law: ERR Measure"     arXiv
2026-05  failure-aware routing matrix（恢复率）      arXiv
2026-05  DART（semantic recoverability 形式化）      arXiv
2026-06  ToolMaze / ROBOBRIDGE                       arXiv
2026-07  "Failure as a Process"（1,184 轨迹）        arXiv
2026-08  SYMTRACE（Repair or Resample?）             arXiv
2026-09  RIR / Rollback-Induced Reflection           arXiv
```

**★ 从 2025-08 开始，几乎每月都有新工作。这个方向已经是红海。★**

**⚠️ 注意**：2026 的编号（2601/2605/2606/2607/2608/2609）多为未来日期预印本，等级不可核实（同前几轮的警告）。

---

## 5. 出路：三个重定位方向

### 方向 A · 验证现有的策略匹配表（★ 我认为最可行 ★）

**观察**：

```
工程界已经给出了匹配表（triage 的 FailurePolicy）
   ├── WRONG_TOOL_CALLED     → retry_with_tool_manifest
   ├── SCHEMA_MISMATCH       → retry_with_tool_manifest(max=2)
   ├── EXTERNAL_FAULT        → backoff_and_retry(max=5)
   ├── CONSTRAINT_IGNORED    → replan(hint=...)
   ├── HALLUCINATED_STATE    → rollback_to_checkpoint()
   └── ...
   ↓
★ 但这张表是工程经验，没有实验证据支撑 ★
```

**候选研究问题**：

> **"Retry Is Not a Strategy" —— 这句话对么？
> 现有的失败→策略匹配表，在受控实验下成立吗？**

**为什么可行**：
- **空白真实**（那张表没有实验验证）
- **完全不需要训练** ✅
- **大样本是优势**（要测 9×5 的矩阵）
- ✅ **和已有工作互补而非重复**（它们提出/分类，你验证）

**风险**：**可能被质疑"只是验证别人"** —— 但如果结论是"那张表有一半是错的"，**这本身是高价值发现**。

### 方向 B · 换一个已有工作没覆盖的维度

| 已有工作覆盖的 | **可能没覆盖的** |
|---|---|
| 恢复**率** | **恢复的副作用**（恢复动作本身引入的新失败） |
| 单次失败 | **级联失败**（多步积累后的恢复） |
| 恢复能力 | **恢复能力随步数的衰减曲线** |
| 分数 | **恢复的 token 成本**（性价比） |

**"恢复的副作用"我认为最有意思** —— 因为：

> **很多"恢复"动作本身会污染上下文**（Feedback Friction 提到 context pollution 变体）。

**但这一条也需要先查重。**

### 方向 C · 换选题

**如果 A 和 B 的查重也不乐观**，那就该换方向了。

**可能的新方向**（需查重）：
- 从**课程角度**：harness 的**结构**（而非策略）如何影响恢复
- 从**交互角度**：**人类介入**的时点与效果
- 从**验证角度**：**验证器可靠性**如何决定恢复上限（R73 那条线）

---

## 6. 诚实的评估

| 项 | 评估 |
|---|---|
| "问题存在" | ✅ **确定**（三重独立证据，含 COLM 2025 + NeurIPS 2025） |
| 我原提的选题 | ❌ **已被覆盖**（Hell or High Water 几乎完全重合） |
| 我的 H3（不可逆性是 harness 属性） | ❌ **已被 DART 形式化** |
| 我的"等算力对照" | ❌ **SYMTRACE 已用 execution replay 解决** |
| **可挽救的部分** | ✅ **"验证现有匹配表"这个角度** |
| **可复用的资产** | ✅ **三类失败的操作定义、P0 协议、路线 A 的推理架构全部可复用** |

**教训**：**选题前必须先查"是不是有人已经给了答案"** —— 这次查得太晚，代价是方案要重做。
**以后的规则**：**任何选题，先用 3 轮检索做查重，再写方案。**

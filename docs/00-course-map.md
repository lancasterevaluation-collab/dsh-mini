# 课程总纲

> **目标**：从零手搓一个 **DSH（DeepSeek Harness）级插件化 agent**，并接上 **Hermes 式学习进化闭环**。
> **形态**：TypeScript + Node，**零依赖**（本机 npm 不可用，全部自研）。
> **对象**：默认读者没有任何 agent / 插件框架经验。

---

## 一、这门课的定位

三个事实先摆清楚：

| 事实 | 数据 | 含义 |
|---|---|---|
| DSH 的框架本体极小 | `vendor/cordis/src/` 只有 **9 个文件** | 「DSH 级」的门槛不高，我们可以达到 |
| DSH 的能力层极大 | **307 个包 / 1932 个源文件** | 我们不可能、也不应该复刻 |
| DSH 没有学习进化闭环 | 只有 `extensions/`（运行时改插件）和 `skill/`（加载技能） | **这是我们的差异化** |

所以本课的定位是：

> **DSH 的架构骨架 + Hermes 的进化闭环 —— 一个 DSH 自己都没有的组合。**

不复刻的：Web GUI、Desktop、SDK、HTTP 网关、远程沙箱、LSP、浏览器自动化、多端协议。
复刻的：**框架机制**（插件树 / DI / 事件 / effect / 配置组合）与**核心能力**（模型 / 工具 / 会话 / 循环 / 重试 / 校验）。

---

## 二、16 步总览

| 步 | 阶段 | 主题 | 产出文件 | 验收判据 |
|---|---|---|---|---|
| 1 | Phase 0 基础 | 模型层 | `kernel/llm.ts` | 5 组演示，含参数解析失败与错误分类 |
| 2 | | 工具注册表 | `kernel/tools.ts`、`kernel/builtin-tools.ts` | 6 组演示，含三类参数错误 + 越权 + 截断 |
| 3 | Phase 1 框架 | ctx 容器 | `framework/context.ts` | 6 组演示，含卸载回滚与装载失败回滚 |
| 4 | | 事件 + waterfall + inject | `framework/events.ts` | 3 个监听器顺序执行 + 短路 + 依赖就绪自动启动 |
| 5 | | scope 隔离 | `framework/scope.ts` | 两个 agent 各自看到不同的工具集 |
| 6 | | profile / bundle 装载 | `framework/loader.ts`、`profiles/`、`bundles/` | 按 id 覆盖一个插件配置并生效 |
| 7 | Phase 2 能力 | 会话日志 | `plugins/session.ts`、`kernel/session-types.ts` | 从日志派生的消息 == 实际请求的消息 |
| 8 | | agent 循环 | `plugins/agent-loop.ts` | mock 脚本驱动 3 轮，消息数组演变可见 |
| 9 | | 重试 | `plugins/retry.ts` | 前 2 次失败第 3 次成功，且日志可重建 |
| 10 | | 校验与审批 | `plugins/guard.ts` | 越权调用被拒且模型收到原因；审批可拒绝 |
| 11 | | CLI 端到端 | `apps/cli.ts` | `node src/apps/cli.ts "任务"` 跑通真实任务 |
| 12 | Phase 3 进化 | 有界记忆 + Nudge | `evolution/memory.ts`、`evolution/nudge.ts` | 写满后 add 失败并要求合并 |
| 13 | | 技能库 + Curator | `evolution/skills.ts`、`evolution/curator.ts` | 渐进披露生效；长期不用的技能转 archived |
| 14 | | 用户建模 + 检索 | `evolution/user-model.ts`、`evolution/recall.ts` | FTS5 检索到历史；派生结论而非存原文 |
| 15 | | 诊断 | `evolution/diagnose.ts` | 失败归因到组件，报 Macro-F1 与 κ |
| 16 | | 演化 + 审计 | `evolution/evolve.ts`、`evolution/audit.ts` | 提议→门控→回滚；每次自改留证据链 |

---

## 三、依赖图

```
① 模型层 ──┐
② 工具层 ──┤
           ├──► ③ ctx 容器 ──► ④ 事件/inject ──► ⑤ scope ──► ⑥ 装载器
           │                                                      │
           └──────────────────────────────────────────────────────┤
                                                                  ▼
                                     ⑦ 会话日志 ──► ⑧ 循环 ──► ⑨ 重试
                                                       │      └► ⑩ 校验审批
                                                       ▼
                                                    ⑪ CLI 端到端
                                                       │
                                                       ▼
                                          ⑫ 记忆 ─► ⑬ 技能 ─► ⑭ 检索
                                                       │
                                                       ▼
                                                ⑮ 诊断 ─► ⑯ 演化审计
```

**读法**：箭头左边是右边的**前提**。例如第 8 步的循环必须建立在第 7 步的会话日志上，因为循环要从日志派生请求。

---

## 四、每篇文档的固定结构

借用 MotiPro 课程的 L0–L4 契约：

| 节 | 要求 |
|---|---|
| **L0 要解决的问题** | 上一步留下什么**具体可观察**的缺陷。不喊口号，给现象。 |
| **L1 设计与原理** | 为什么这么设计；关键概念定义；必要处给图。 |
| **L2 决策表** | 决策 × 我们的选择 × 替代方案 × **代价落在谁身上**。 |
| **L3 实现与验证** | 文件清单、关键代码、运行命令、验收判据。 |
| **L4 仍未解决** | 这一步留下的坑，与下一步的动机闭环。 |

---

## 五、三条贯穿始终的主线

### 主线 1：依赖只能单向

```
apps → plugins → framework
              → kernel（kernel 不认识任何人）
```

任何时候你发现 `kernel/llm.ts` 里出现了 `import ... from '../framework/context.ts'`，就是架构被破坏了。

### 主线 2：行为挂在扩展点上，不写死在调用链里

反面：`if (config.retryEnabled) { ... }` 写在循环里。
正面：`retry` 是一个监听 `agent/request-error` 的插件，卸载它 = 关掉重试，循环代码一行不改。

**这就是「DSH 级」和「玩具」的唯一实质差别。**

### 主线 3：每个设计都要能回答三问

1. **为什么这么设计？** 不这么写会出什么问题。
2. **替代方案是什么？** 为什么不选。
3. **代价落在谁身上？** 复杂度、token、延迟、可测试性。

---

## 六、与 DSH 的对应

| 本课 | DSH 对应 | 简化程度 |
|---|---|---|
| `framework/context.ts` | `vendor/cordis/src/context.ts` + `service.ts` + `fiber.ts` | 🔶 合并为 1 个文件 |
| `framework/events.ts` | `vendor/cordis/src/events.ts` + `registry.ts` | 🔶 合并 |
| `framework/scope.ts` | `packages/core/scope/` | 🔶 简化 |
| `framework/loader.ts` | `packages/boot/app-boot/` + `apps/cli/src/profile-boot.ts` | 🔶 大幅简化（JSON 而非 YAML，无 pnpm 解析） |
| `plugins/llm.ts` | `packages/llm/` | 🔶 单 provider |
| `plugins/tools.ts` | `packages/core/tools/` | 🔶 无 PTC、无 UI 呈现 |
| `plugins/session.ts` | `packages/core/session/` | 🔶 无版本迁移链 |
| `plugins/agent-loop.ts` | `packages/core/agent-loop/` | 🔶 简化 inbox / 无并行工具池 |
| `plugins/retry.ts` | `packages/llm/llm-retry/` | ✅ 语义对齐 |
| `plugins/guard.ts` | `packages/guard/` + `tools/pre-execute` + `ctx.approval` | 🔶 简化 |
| `evolution/*` | **DSH 无等价物** | 🌟 对齐 Hermes |

详细到文件级的映射见 [`reference/dsh-file-map.md`](reference/dsh-file-map.md)。

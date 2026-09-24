# DSH 文件 → 小 dsh 文件 映射表

> 目标：把 `D:\deepseek-harness` 的**每个文件**的用途解析清楚，并对应到 `D:\agent-harness-lab` 的具体文件。
> 规模：307 个包 / 1932 个 src 文件 / 347 篇文档。**一次性列完是几十万字，因此分批交付。**

## 映射规则

每个文件给出三列：

- **用途**：这个文件负责什么（取自它自己的 JSDoc / 模块说明，不是我编的）
- **小 dsh**：对应我们哪个文件
- **处置**：`✅ 已实现` / `⬜ 计划中（第 N 步）` / `🔶 简化` / `❌ 不做`

`❌ 不做` 不是"不重要"，而是**与本项目目标（教学 + 单机 CLI）无关**，例如 Web GUI、多端协议、远程沙箱。

## 批次计划

| 批 | 范围 | 文件数 | 状态 |
|---|---|---|---|
| **B1** | `vendor/cordis/`（框架本体） | 9 | ✅ 本批交付 |
| **B2** | `apps/cli/`（入口） | 8 | ✅ 本批交付 |
| **B3** | `packages/boot/`（启动与组合） | 19+ | ✅ 本批交付 |
| **B4** | `packages/core/`（核心能力） | 45 | ✅ 本批交付 |
| B5 | `packages/llm/` `guard/` `interaction/` `fs/` | ~30 | ⬜ 下一批 |
| B6 | `packages/session/` `session-query/` `storage/` | ~35 | ⬜ |
| B7 | `packages/skill/` `compaction/` `subagent/` `hooks/` `extensions/` | ~30 | ⬜ |
| B8 | 其余 40 个组（含 client/host/api/typert 等，多为 ❌） | ~1700 | ⬜ 汇总表 |

---

# B1 —— 框架本体 `vendor/cordis/src/`（9 个文件）

**这批最重要**：它定义了"DSH 级"的真实门槛 —— 全部只有 9 个文件。

| DSH 文件 | 用途 | 小 dsh | 处置 |
|---|---|---|---|
| `context.ts` | Public shape of a Cordis context | `src/framework/context.ts` | ✅ 已实现（服务注册 + 插件装载 + 副作用） |
| `service.ts` | Base class for services that expose a named API on `ctx` | 并入 `src/framework/context.ts` | 🔶 简化（我们用 `provide/get` 而非服务基类） |
| `events.ts` | Return whether an event result should stop a bail-style dispatch | `src/framework/events.ts` | ⬜ 第 4 步 |
| `fiber.ts` | 插件的装载/卸载生命周期单元 | 即 `context.ts` 里的「插件子容器」 | ✅ 已实现 |
| `registry.ts` | Service dependency declaration accepted by plugins（`inject`） | `src/framework/events.ts` | ⬜ 第 4 步 |
| `reflect.ts` | Read a service from the store without the inject requirement | — | ❌ 不做（教学不需要绕过 inject） |
| `logger.ts` | 日志 | `src/framework/logger.ts` | ⬜ 第 4 步顺带 |
| `utils.ts` | 工具函数 | — | ❌ 不做（用原生即可） |
| `index.ts` | 导出面 | 各文件直接导出 | 🔶 简化 |

---

# B2 —— 入口 `apps/cli/src/`（8 个文件）

| DSH 文件 | 用途 | 小 dsh | 处置 |
|---|---|---|---|
| `bin.ts` | Command-line entry for dsh | `src/apps/cli.ts` | ⬜ 第 11 步 |
| `args.ts` | Commander adapter for the `dsh` command line；只解析启动器自己的 flag，其余原样交给内层 app | `src/apps/cli.ts`（内联） | 🔶 简化（不拆文件，不用 commander） |
| `profile-boot.ts` | Shared profile boot for every `dsh` surface：解析 profile → 叠补丁 → 挂载 → 失败即退 | `src/framework/loader.ts` | ⬜ 第 6 步 |
| `dump-config.ts` | `dsh --profile <name> --dump-config`：打印组装后的树 | `src/apps/dump-config.ts` | ⬜ 第 6 步 |
| `dump-config-schema.ts` | 打印每个插件的配置 JSON Schema | — | 🔶 简化（我们的 patch 就是 JSON，本身可读） |
| `plugin.ts` | `dsh plugin --profile <name> add <pkg>`：转发给包管理器 | — | ❌ 不做（零依赖，无包管理） |
| `process-shutdown.ts` | 有界退出：SIGINT/SIGTERM 时排空资源 | `src/apps/cli.ts`（内联） | 🔶 简化（`ctx.dispose()` 即为退出路径） |
| `startup-diagnostics.ts` | 启动失败的诊断报告 | — | 🔶 简化（直接打印错误） |

---

# B3 —— 启动与组合 `packages/boot/`

## `boot/app-boot/src/`（框架装载器，对应我们的第 6 步）

| DSH 文件 | 用途 | 小 dsh | 处置 |
|---|---|---|---|
| `index.ts` | Shared boot glue for `dsh` profiles | `src/framework/loader.ts` | ⬜ 第 6 步 |
| `profile.ts` | Profile discovery, initialization, and patch-layer composition | `src/framework/loader.ts` | ⬜ 第 6 步 |
| `profile-context.ts` | 传给插件的 profile 上下文（home、bundles、cwd…） | `src/framework/loader.ts` | ⬜ 第 6 步 |
| `profile-plugins.ts` | profile 声明里要装载的插件行 | `src/framework/loader.ts` | ⬜ 第 6 步 |
| `profile-sanitize.ts` | 备份 profile 补丁，只保留调用方的恢复 bundle | — | ❌ 不做（无恢复场景） |
| `package-meta.ts` | 读包元信息 | — | ❌ 不做 |
| `profile-resolution/service.ts` | 解析 profile 的模块解析与依赖 | 简化为「按 `bundles/*.json` 里的路径 import」 | 🔶 简化 |
| `profile-resolution/resolver.ts` | 解析路径 | 同上 | 🔶 简化 |
| `profile-resolution/legacy-links.ts` | pkg 虚拟文件系统检测 | — | ❌ 不做 |
| `profile-resolution/worker-bootstrap.ts` | worker 引导 | — | ❌ 不做 |
| `config-schema/index.ts` | 生成 JSON Schema（不挂载插件、不求值表达式） | — | ❌ 不做 |
| `config-schema/collect.ts` | 收集各插件的 schema | — | ❌ 不做 |
| `config-schema/document.ts` | 组装 schema 文档 | — | ❌ 不做 |
| `config-schema/native.ts` | Schemastery 协议识别 | — | ❌ 不做 |
| `config-schema/pattern.ts` | schema 模式匹配 | — | ❌ 不做 |
| `config-schema/projector.ts` | schema 投影 | — | ❌ 不做 |
| `config-schema/types.ts` | schema 类型 | — | ❌ 不做 |

## `packages/boot/` 其余包

| DSH 包 / 文件 | 用途 | 小 dsh | 处置 |
|---|---|---|---|
| `cmdline/index.ts` | 启动器交给 app 的命令行快照 | `src/apps/cli.ts`（内联） | 🔶 简化 |
| `hmr/`（3 文件） | 配置热重载 | — | ❌ 不做 |
| `config-editor/index.ts` | 配置文件的可视化编辑 | — | ❌ 不做 |
| `plugin-manager/`（10 文件） | 用 pnpm 给 profile 装/卸插件、失败分类、注册表顺序 | — | ❌ 不做（零依赖） |

---

# B4 —— 核心能力 `packages/core/`（45 个文件）

## `core/agent/`（9 文件）—— Agent 服务与类型

| DSH 文件 | 用途 | 小 dsh | 处置 |
|---|---|---|---|
| `index.ts` | Agent service: live registry, factory delegation | `src/framework/`（服务注册即够） | 🔶 简化 |
| `types.ts` | Durable agent session-event vocabulary | `src/kernel/session-types.ts` | ⬜ 第 7 步 |
| `runtime-types.ts` | Public agent types and live-runtime events | `src/kernel/session-types.ts` | ⬜ 第 7 步 |
| `dispatch.ts` | Agent-scoped dispatch and prompt assembly helpers | `src/plugins/agent-loop.ts` | ⬜ 第 8 步 |
| `model-selection.ts` | Agent-scoped model selection | `src/plugins/llm.ts` | ⬜ 第 7 步 |
| `consumed-work.ts` | 一个 agent 日志如何记账它消耗的工作 | — | ❌ 不做 |
| `projection.ts` | agent 状态投影 | `src/plugins/session.ts` | ⬜ 第 7 步 |
| `archive-admission.ts` | Workspace 注册表的归档准入 | — | ❌ 不做 |
| `invariant.ts` | 包自有的运行时不变量检查 | `src/plugins/*.invariant.ts` | ⬜ 第 8 步 |

## `core/agent-loop/`（8 文件）—— **默认 Agent 驱动（最重要的一批）**

| DSH 文件 | 用途 | 小 dsh | 处置 |
|---|---|---|---|
| `index.ts` | Concrete agent-loop plugin：创建 scoped ReactLoopAgent 并发布 | `src/plugins/agent-loop.ts` | ⬜ 第 8 步 |
| `agent.ts` | **Default Agent driver over queued turns and step-boundary input** | `src/plugins/agent-loop.ts` | ⬜ 第 8 步 |
| `inbox.ts` | Driver-owned durable agent inbox projection and command facade | `src/plugins/agent-loop.ts`（简化：单个队列） | 🔶 简化 |
| `tool-calls.ts` | **Schedules one assistant step's tool calls. Exclusive calls form barriers** | `src/plugins/agent-loop.ts` | ⬜ 第 8 步 |
| `runtime-context.ts` | 两条 loop 自有 surface message 的持久投影 | — | ❌ 不做 |
| `assistant-stream.ts` | 流式助手增量 | `src/kernel/llm.ts`（非流式） | 🔶 简化（第 4 步后再评估） |
| `constants.ts` | 常量（`DEFAULT_MAX_PARALLEL_TOOL_CALLS`） | `src/plugins/agent-loop.ts` | ⬜ 第 8 步 |
| `invariant.ts` | 请求可从日志重建的不变量 | `src/plugins/agent-loop.invariant.ts` | ⬜ 第 8 步 |

## `core/session/`（10 文件）—— **会话日志（唯一真相）**

| DSH 文件 | 用途 | 小 dsh | 处置 |
|---|---|---|---|
| `index.ts` | **Event-sourced session service: append-only log + in-memory store** | `src/plugins/session.ts` | ⬜ 第 7 步 |
| `types.ts` | 事件词汇类型 | `src/kernel/session-types.ts` | ⬜ 第 7 步 |
| `surface.ts` | Surface layer：日志之上的有序视图 | `src/plugins/session.ts`（派生函数） | ⬜ 第 7 步 |
| `known-event-types.ts` | 已生成的事件类型目录 | — | ❌ 不做（我们手写联合类型） |
| `request-header.ts` | 从 `request/header` 重建请求头 | — | ❌ 不做 |
| `fork.ts` | 按事件前缀构造 fork 种子 | — | ❌ 不做 |
| `repair.ts` | 尾部 turn 未闭合时的合成收尾事件 | `src/plugins/session.ts` | ⬜ 第 7 步 |
| `preparation.ts` | 未发布 Session 的所有权 | — | ❌ 不做 |
| `seq-ranges.ts` | 把连续区间压缩成对 | — | ❌ 不做 |
| `invariant.ts` | 日志的关系型不变量 | `src/plugins/session.invariant.ts` | ⬜ 第 7 步 |

## `core/tools/`（10 文件）—— **工具注册表与执行管线**

| DSH 文件 | 用途 | 小 dsh | 处置 |
|---|---|---|---|
| `index.ts` | **Tool registry, presentation modes, and pre/guard/around/post/result pipeline** | `src/kernel/tools.ts` + `src/plugins/tools.ts` | ✅ 基础已实现，管线 ⬜ 第 10 步 |
| `types.ts` | Durable Tool event vocabulary | `src/kernel/tools.ts` | ✅ 部分 |
| `json-schema.ts` | Enforced JSON Schema subset | `src/kernel/tools.ts`（`JsonSchema`） | ✅ 已实现 |
| `schema.ts` | schema 辅助 | `src/kernel/tools.ts` | ✅ 已实现 |
| `presentation.ts` | 工具渲染意图词汇（UI 用） | — | ❌ 不做（无 GUI） |
| `testing.ts` | 工具测试助手 | `src/kernel/tools.test.ts` | ⬜ 第 11 步 |
| `ptc.ts` | PTC 模式 `run_code` 传输 | — | ❌ 不做 |
| `py-types.ts` | PTC 代码生成（Python 侧） | — | ❌ 不做 |
| `ts-types.ts` | PTC 代码生成（TypeScript 侧） | — | ❌ 不做 |
| `invariant.ts` | 工具事件不变量 | `src/plugins/tools.invariant.ts` | ⬜ 第 10 步 |

## `core/` 其余包

| DSH 文件 | 用途 | 小 dsh | 处置 |
|---|---|---|---|
| `system-prompt/index.ts` | **Registry for ordered system sections, dynamic context, tool schemas, and prompt variables** | `src/plugins/system-prompt.ts` | ⬜ 第 8 步 |
| `system-prompt/invariant.ts` | prompt 组装不变量 | — | 🔶 简化 |
| `scope/index.ts` | **Scoped-context primitive：给注册打 agent 标记** | `src/framework/scope.ts` | ⬜ 第 5 步 |
| `scope/store.ts` | Shared insertion-ordered storage and effect ownership | `src/framework/scope.ts` | ⬜ 第 5 步 |
| `scope/scoped-events.generated.ts` | 生成的 scoped 事件路由 | — | ❌ 不做 |
| `scope/invariant.ts` | scope 不变量 | — | 🔶 简化 |
| `agent-default-model/index.ts` | Agent 的默认模型选择 | `profiles/*.json` 里的一行配置 | 🔶 简化 |
| `agent-tool-presentation/index.ts` | agent 预设携带的展示行选择器 | — | ❌ 不做 |

---

# 组级总表（307 包 → 处置）

| 处置 | 组数 | 说明 |
|---|---|---|
| ✅ **完整对应** | 10 | `core` `llm` `guard` `session` `bundle` `boot` `util` `interaction` `fs` `skill` |
| 🔶 **简化对应** | 16 | `shell` `subprocess` `sandbox` `compaction` `subagent` `credentials` `settings` `identity` `attachment` `spill` `document` `jobs` `todo` `plan` `goal` `schedule` |
| ⚠️ **只取一个机制** | 2 | `hooks`（取前置钩子）、`session-query`（取 FTS 检索） |
| ❌ **不做** | 22 | `client` `host` `api` `typert` `sdk` `acp` `web` `mcp` `lsp` `terminal` `ptc-runtime` `browser-use` `computer-use` `ssh` `feedback` `deliverables` `workspace` `webhook` `experimental` `runtime-diagnostics` `test-support` `document` |

**结论：我们的目标是复刻 307 个包中的约 26 个组、约 60 个等价文件。**

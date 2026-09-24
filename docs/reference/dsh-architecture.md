# DeepSeek Harness 架构图（参考文档）

> 本文是对 `D:\deepseek-harness` 的架构测绘，作为小 dsh（`D:\agent-harness-lab`）的对照基准。
> 数据均为本机实测，非估算。

## 0. 规模基线（实测）

| 指标 | 数值 |
|---|---|
| 包数量（`packages/*/*/package.json`） | **307** |
| `packages/**/src/**/*.ts` 源文件 | **1932** |
| `apps/**/src/**/*.ts` 源文件 | **68** |
| `docs/**/*.md` 文档 | **347** |
| **框架本体 `vendor/cordis/src/`** | **9 个文件** |

最后一行是关键：**DSH 的"架构级别"来自它的能力层和组织纪律，不来自框架本体的体量。**
Cordis 只有 9 个文件，却支撑起 307 个包。

---

## 1. 六层结构

```
╔═══════════════════════════════════════════════════════════════════════════╗
║ L6 应用层   apps/                                                          ║
║   cli/  web/  desktop/  desktop-host/                                     ║
║   职责：把 profile 启动起来，其余什么都不做                                  ║
╠═══════════════════════════════════════════════════════════════════════════╣
║ L5 组合层   packages/bundle/  +  packages/boot/app-boot/                  ║
║   base / web-app / headless / sdk-app / acp-app / sdk-minimal             ║
║   职责：把「一堆插件」打包成分发单元；按层叠加、按 id 覆盖                     ║
╠═══════════════════════════════════════════════════════════════════════════╣
║ L4 能力层   packages/{core,llm,tools,fs,shell,subagent,...}  （约 250 包）  ║
║   职责：产品能力。每个能力可能是「Service Definition + Provider + Consumer」 ║
╠═══════════════════════════════════════════════════════════════════════════╣
║ L3 框架层   vendor/cordis/   （9 个文件）                                   ║
║   context.ts  service.ts  events.ts  fiber.ts  registry.ts                ║
║   reflect.ts  logger.ts  utils.ts  index.ts                               ║
║   职责：服务注册 / 依赖注入 / 类型化事件 / 可撤销副作用 / 生命周期            ║
╠═══════════════════════════════════════════════════════════════════════════╣
║ L2 协议层   packages/typert/ + packages/api/ + packages/sdk/ + python/     ║
║   职责：跨进程/跨语言的类型与 RPC（TypeScript ↔ Python ↔ Web ↔ Desktop）    ║
╠═══════════════════════════════════════════════════════════════════════════╣
║ L1 数据层   packages/session/ + storage/ + session-query/ + attachment/    ║
║   职责：append-only 会话日志、投影、全文检索、二进制附件                     ║
╚═══════════════════════════════════════════════════════════════════════════╝
```

---

## 2. 包组地图（按 `packages/README.md` 的权威角色表）

| 组 | 职责 | 小 dsh 是否对应 |
|---|---|---|
| `core/` | 产品 API 主干：session、prompt、tools、agent、loop | ✅ 核心对应 |
| `llm/` | LLM 能力族：抽象服务 + provider 适配器 | ✅ 对应 |
| `guard/` | 循环卫生守卫：重复调用提醒 + 工具超时 | ✅ 对应 |
| `session/` | 持久会话数据面：持久化 seam + 后端 + 投影 | ✅ 对应 |
| `bundle/` | 可安装的 `dsh --profile` 补丁层 | ✅ 对应 |
| `boot/` | 应用启动胶水（app-boot、plugin-manager、hmr） | ✅ 对应 |
| `util/` | 零依赖工具（`Branded<B>`、home/path、timeout） | ✅ 对应 |
| `interaction/` | 人机协作面：审批/交互 seam、权限预设、命令 | ✅ 对应 |
| `fs/` | 文件系统能力族：seam + 本地实现 + 文件工具 | ✅ 对应 |
| `shell/` `subprocess/` | Bash 执行 seam + 进程族 | ⚠️ 简化（我们只做工具级） |
| `sandbox/` | 进程隔离（bwrap/Landlock/Seatbelt） | ⚠️ 简化（只做路径越权检查） |
| `compaction/` | 上下文压缩 | ⚠️ 简化 |
| `subagent/` | 子 agent 委派 | ⚠️ 简化 |
| `skill/` | 技能能力族：provider + 本地实现 + 目录/加载工具 | ✅ **对应 Hermes 技能层** |
| `web/` `mcp/` | 网络访问 / MCP 外部工具 | ❌ 不做 |
| `lsp/` `terminal/` `ptc-runtime/` | LSP / 持久终端 / PTC 代码执行 | ❌ 不做 |
| `browser-use/` `computer-use/` | 浏览器 / 桌面操作 | ❌ 不做 |
| `ssh/` | 远程 POSIX 连接 | ❌ 不做 |
| `client/` `host/` | Web GUI 前后端（59 + 9 包） | ❌ 不做 |
| `api/` `typert/` `sdk/` `acp/` | 远程 BFF / 类型图 / SDK / ACP | ❌ 不做 |
| `session-query/` | 会话检索：谱系、语义过滤、SQLite 全文检索 | ✅ **对应 Hermes recall** |
| `credentials/` `settings/` `identity/` | 凭据 / 设置 / 匿名身份 | ⚠️ 简化 |
| `attachment/` `spill/` `document/` | 附件 / 溢出 / 文档转换 | ⚠️ 简化（我们做截断） |
| `jobs/` `todo/` `plan/` `goal/` `schedule/` `workflow/` | 后台任务 / 待办 / 计划 / 目标 / 调度 / 工作流 | ⚠️ 少量 |
| `hooks/` | Claude Code / Codex hooks 桥 | ✅ 对应（我们的 guard 前置钩子） |
| `feedback/` `deliverables/` `workspace/` `webhook/` | 反馈 / 交付物 / 工作区 / webhook | ❌ 不做 |
| `extensions/` | agent 运行时自我修改 | ✅ **对应我们的 evolve 层** |
| `experimental/` | 预稳定原型（agent-team、auto-review 等） | ❌ 不做 |
| `runtime-diagnostics/` | 运行时不变量检查 | ⚠️ 简化（我们的断言） |
| `test-support/` | 测试基础设施 | ⚠️ 我们自己写 |

---

## 3. 一次任务的完整生命周期

```
用户输入
   │
   ▼
[apps/cli] bin.ts → args.ts → profile-boot.ts
   │
   ▼
[boot/app-boot] 按 profile 组装 patch 层 → Cordis Loader 挂载
   │
   ▼
[core/agent] ctx.agents.create()  ← 创建 Agent
   │
   ▼
[core/agent-loop] 驱动 turn（一个 turn = 零或多个 step）
   │
   ├─ turn/start
   ├─ 认领输入
   ├─ [core/system-prompt] 组装 prompt 段落 + 工具 schema
   ├─ agent/pre-step      ← waterfall：可拒绝/改写输入
   ├─ step/start
   ├─ agent/request       ← waterfall：可改写请求
   ├─ ctx.llm.prepareCall()  ← 解析路由（provider/model）
   ├─ 落盘 system/message、user/message、request/header
   ├─ 从日志派生并冻结请求
   ├─ llm/stream          ← waterfall：流式返回
   │    └─ 失败 → agent/request-error ← ★ retry 插件挂在这里
   ├─ 落盘 assistant/message 或 assistant/attempt
   ├─ [core/tools] 工具调用
   │    ├─ tool/call
   │    ├─ tools/pre-execute   ← waterfall：allow/deny/ask
   │    ├─ 单调守卫             ← guard 不可翻案
   │    ├─ ctx.approval         ← 人工审批
   │    ├─ tools/execute        ← 环绕：timeout/retry/metrics
   │    ├─ 工具本体
   │    ├─ tools/post-execute   ← 检查/替换结果
   │    ├─ finalizeContent
   │    ├─ tools/result
   │    └─ tool/result
   ├─ step/end
   └─ agent/turn-stopping ← 串行终局检查点
   │
   ▼
[core/session] 全程：一切事实 append 到日志（唯一真相）
```

**核心不变量：Model-visible ⟺ logged。** 任何能进模型请求的东西，都必须能从日志重建。

---

## 4. 框架本体 Cordis（`vendor/cordis/src/`，9 个文件）

| 文件 | 职责 | 小 dsh 对应 |
|---|---|---|
| `context.ts` | Cordis context 的公开形状：注册服务、装载插件 | ✅ `framework/context.ts` |
| `service.ts` | 服务基类：在 `ctx` 上暴露具名 API | ✅ 并入 `framework/context.ts` |
| `events.ts` | 事件分发（含 bail/waterfall 语义） | ⬜ `framework/events.ts`（第 4 步） |
| `fiber.ts` | 生命周期单元：一个插件的装载/卸载边界 | ✅ 即我们的"插件子容器" |
| `registry.ts` | 服务依赖声明（插件声明 `inject`） | ⬜ `framework/events.ts`（第 4 步） |
| `reflect.ts` | 不触发 inject 要求地读取服务 | ⬜ 暂不需要 |
| `logger.ts` | 日志 | ⬜ 暂不需要 |
| `utils.ts` | 工具函数 | ⬜ 暂不需要 |
| `index.ts` | 导出面 | — |

**→ 我们已完成 9 个中的 3 个的等价物。这就是"DSH 级"的真实门槛：不高的。**

---

## 5. 四个核心机制

### 5.1 Capability seam（能力接缝）

一个能力拆成三种角色，**缺一不成 seam**：

| 角色 | 含义 | 例子 |
|---|---|---|
| Service Definition | 声明接口 | `ctx.llm` 的抽象服务 |
| Service Provider | 实现接口 | `dsh-llm-deepseek` 适配器 |
| Consumer | 使用接口 | 模型可见的工具、agent loop |

`packages/README.md` 的纪律：**扩展插件只能依赖 Service Definition，绝不能依赖具体 Provider。**
这就是为什么换一个 provider 能改变整个产品，而不需要 fork。

### 5.2 Effect —— 一切注册皆可撤销

```
ctx.effect(disposer)          // 登记
ctx.plugin(X) → 返回卸载函数   // 卸载时自动逆序回滚 X 的全部注册
```

小 dsh 第 3 步已实现。

### 5.3 Waterfall —— 不调 `next()` 就是短路

```ts
ctx.on('agent/request-error', async (event, next) => {
  if (canRetry(event.error)) return { kind: 'retry' }   // ← 短路，不调 next()
  return next()                                          // ← 放行给下一个监听器
})
```

DSH 的 `agent/pre-step`、`agent/request`、`llm/stream`、`tools/*` 都是 waterfall。
小 dsh 第 4 步实现。

### 5.4 Session log —— 唯一真相

- append-only，每个事实一个事件
- 模型历史是从日志**派生**的（`deriveMessages()`），不是独立状态
- 有版本号与相邻迁移链（`vN → vN+1`），已提交的代永不改名/删除
- 事件类型是**读时必须**的：不认识的类型会拒绝加载整个日志

小 dsh 第 7 步实现（简化版：不做版本迁移链）。

---

## 6. 组合：profile / bundle / patch

```
启动一个 profile 时的层叠顺序（后写覆盖先写，按行 id 定位）：

  1. profile 声明的 bundles，按列表顺序
       dsh-base → dsh-web-app / dsh-headless / ...
  2. profile 自己的 cordis.patch.yml
  3. $DSH_HOME/cordis.patch.yml          （机器级偏好）
  4. --patch <file> 覆盖层（可重复，按 argv 顺序）
```

补丁按 **row id** 定位，**整段替换** `config`（不是深合并）。

```sh
dsh --profile web --dump-config          # 看真实装载的树
dsh --profile web --dump-config-schema   # 看每个插件的 JSON Schema
```

小 dsh 第 6 步实现（JSON 格式）。

---

## 7. 多端形态

| 端 | 入口 | 说明 |
|---|---|---|
| CLI | `apps/cli` | `dsh --profile <name>`，唯一允许启动 Node 应用的方式 |
| Web | `apps/web` + `packages/bundle/web-app` | 浏览器 GUI（59 个 client 包 + 9 个 host 包） |
| Desktop | `apps/desktop` + `apps/desktop-host` | Electron，携带完整 dsh 运行时 |
| SDK | `packages/sdk` + `python/` | JSON-RPC 跨进程 |
| ACP | `packages/acp` | 自动化专用协议 |

**纪律**：只有 `dsh` profile 能启动受支持的 Node 应用；包级 bin、demo、SDK argv 逃逸都被 `verify-application-entrypoints` 拒绝。

小 dsh 只做 CLI 一端。

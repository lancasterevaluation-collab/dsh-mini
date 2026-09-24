# dsh-mini

> 用**零依赖**的 TypeScript，从零实现一个 DSH（DeepSeek Harness）级的插件化 agent harness，并在它上面接一条 Hermes 式的学习进化闭环。

![Node](https://img.shields.io/badge/node-%E2%89%A522.18-3C873A?logo=node.js&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-strip--types-3178C6?logo=typescript&logoColor=white)
![Acceptance](https://img.shields.io/badge/acceptance-18%2F18-success)
![License](https://img.shields.io/badge/license-MIT-blue)

不需要 `npm install`，不需要编译，不需要构建工具 —— `node src/apps/cli.ts "任务"` 就能跑。

---

## 目录

- [这是什么](#这是什么)
- [与 DSH 的关系](#与-dsh-的关系)
- [核心特性](#核心特性)
- [架构](#架构)
- [目录结构](#目录结构)
- [快速开始](#快速开始)
- [用法](#用法)
- [16 步路线图](#16-步路线图)
- [验收](#验收)
- [关键设计决策](#关键设计决策)
- [文档](#文档)
- [常见问题](#常见问题)
- [项目状态与局限](#项目状态与局限)
- [开发约定](#开发约定)
- [参与贡献](#参与贡献)
- [许可证](#许可证)
- [致谢](#致谢)

---

## 这是什么

一个**完整可运行的 agent harness**：它自己会调模型、调工具、记日志、重试、拒绝危险操作，
并且在任务失败后能自我诊断、自我调整。

它的价值不在"能跑通一次对话"——那是几十行代码的事。它的价值在于：**整个系统没有一处是写死的**。

```
想关掉重试？     卸载 retry 插件。循环代码一行不改。
想换模型？       改 profile 里的一行配置。
想让两个 agent 看到不同的工具集？  给它们各自一个作用域。
想让 agent 记住上次的教训？       它自己会在下一轮任务开头看到提醒。
```

这正是 DSH 这类生产级 harness 与"玩具 agent"的实质差别，也是这个项目想复现的东西。

代码规模（真实统计）：

| 层 | 文件 | 行数 | 内容 |
| --- | --- | --- | --- |
| `kernel/` | 8 | 2462 | 纯能力：模型、工具、会话日志、循环、重试、守卫、检查点 |
| `framework/` | 4 | 981 | 插件容器、waterfall 事件、作用域隔离、配置层叠装载器 |
| `plugins/` | 10 | 1336 | 把 kernel 的能力包成插件，并定义扩展点 |
| `evolution/` | 9 | 1916 | 记忆、提醒、技能、用户建模、历史检索、诊断、演化门控、审计 |
| `apps/` | 2 | 301 | CLI 入口 + 一键验收 |
| `demos/` | 16 | 2464 | 每一步的可运行演示 |
| **合计** | **49** | **9460** | 零运行时依赖 |

另有 34 篇课程文档、22 个类型化事件（4 个框架级 + 18 个由插件用声明合并扩展）、
5 个 profile、4 个 bundle、3 个 patch 示例。

## 与 DSH 的关系

[DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 是一个 307 个包、
1932 个源文件的全插件化 agent 框架。本项目**不是它的复刻**，而是它的**架构骨架**：

| | DSH | dsh-mini |
| --- | --- | --- |
| 框架本体 | `vendor/cordis/src/`（9 文件） | `framework/`（4 文件） |
| 能力层 | 307 个包 | 6 个核心插件 |
| 外围能力（Web / LSP / 浏览器 / 沙箱） | 约 150 个文件 | ❌ 不做 |
| 多端（GUI / 桌面 / SDK / RPC） | 约 700 个文件 | ❌ 不做 |
| 学习进化闭环 | ❌ 无等价物 | ✅ `evolution/`（本项目独有的部分） |

复刻的是**机制**：插件树、依赖注入、waterfall 事件、副作用回滚、配置组合。
没做的是**量**：那些外围能力全部属于"在框架上新增插件"，会了框架就能自己加。

## 核心特性

| 特性 | 说明 |
| --- | --- |
| 🔌 **一切皆插件** | 模型、工具、会话、循环、重试、守卫都是插件；装卸即开关行为 |
| 🪝 **22 个类型化事件** | waterfall 分发，插件之间不需要互相认识；插件可声明合并扩展事件表 |
| 🎯 **作用域隔离** | 同一进程里两个 agent 可以共享模型服务、却看到不同的工具集 |
| 📜 **日志是唯一真相** | `Model-visible ⟺ logged`：模型看到的历史是从日志**算出来**的，不可能不一致 |
| 🛡️ **守卫链 + 单调性** | 拦截发生在副作用之前；后注册的规则翻不了早先裁决的案 |
| 🔁 **可插拔重试** | 重试是监听 `agent/request-error` 的插件，不是循环里的 `if` |
| 🧠 **有界记忆** | 写满即拒绝并要求合并 —— 记忆不会无限膨胀，也不会偷偷丢弃最旧的那条 |
| 💡 **Nudge 提醒** | 上一次跑得糟（重试多、工具连续失败、守卫拦下）会变成下一次任务开头的一句话 |
| 📚 **技能库** | 两级暴露：目录永远可见，全文按需读取（实测目录/全文比 7×） |
| 🔍 **历史检索** | 基于 `node:sqlite` 的 FTS5 + trigram 分词，中文与标识符都能搜 |
| 📊 **失败归因** | 把失败归因到组件，并给出 Macro-F1 / Cohen's κ / 95% bootstrap 置信区间 |
| 🚦 **演化门控** | 自改提案必须通过回归基线；会让已通过任务退化的改动被拒绝并回滚 |
| 🔗 **审计链** | 哈希链记录每次自改（改了什么 / 凭什么 / 结果如何），可验证、可复算 |

## 架构

```
应用层    apps/          选 profile → 装载 → 跑任务 → 报告
组合层    profiles/      配置即组合：bundle 分层覆盖，patch 整段替换
框架层    framework/     容器 · 事件(waterfall) · 作用域 · 副作用回滚 · 装载器
能力层    plugins/       llm · tools · session · agent-loop · retry · guard
进化层    evolution/     记忆 · Nudge · 技能 · Curator · 用户建模 · 检索 · 诊断 · 演化 · 审计
纯能力层  kernel/        模型 · 工具 · 日志 · 循环 · 重试 · 守卫 · 检查点
```

**依赖只能单向**：

```
apps → plugins → framework
              → kernel（kernel 不认识任何人）
```

任何时候 `kernel/llm.ts` 里出现 `import ... from '../framework/context.ts'`，架构就被破坏了。
这个约束是可验证的 —— `kernel/` 里的每一个文件都不 import 框架层的任何东西。

两条贯穿全项目的原则：

1. **行为挂在扩展点上，不写死在调用链里。** 发现自己在循环里写 `if (config.retryEnabled)`，
   说明扩展点没留对。
2. **依赖单向。** 底层不认识上层，能力不认识装配。

## 目录结构

```
dsh-mini/
├── src/
│   ├── kernel/                    纯能力模块，不依赖框架
│   │   ├── llm.ts                 Provider 接口 + MockProvider + DeepSeekProvider + 错误分类
│   │   ├── tools.ts               工具注册表 + JSON Schema + 递归参数校验 + 截断
│   │   ├── builtin-tools.ts       read_file / write_file / list_dir / delete_file
│   │   ├── session.ts             append-only 日志 + deriveMessages() + 统计
│   │   ├── agent.ts               turn / step 状态机（含 3 条结束路径）
│   │   ├── retry.ts               错误分类 + 指数退避 + 抖动
│   │   ├── guard.ts               守卫链 + 单调性 + 审批 + 内置规则
│   │   └── checkpoint.ts          快照与回滚
│   ├── framework/                 插件容器（相当于 DSH 的 vendor/cordis）
│   │   ├── context.ts             服务注册 · 副作用回滚 · 依赖注入 · 插件装载
│   │   ├── events.ts              类型化事件 + waterfall 分发器
│   │   ├── scope.ts               作用域：遮蔽 / 派生 / 可观测
│   │   └── loader.ts              bundle / profile / patch 层叠装载
│   ├── plugins/                   能力插件（把 kernel 挂上框架）
│   │   ├── llm.ts  tools.ts  session.ts  retry.ts  guard.ts  agent-loop.ts
│   │   ├── evolution.ts           进化层接线（监听事件、注入提醒、暴露服务）
│   │   └── demo-*.ts              3 个教学用最小插件（第 3–6 步的示例）
│   ├── evolution/                 学习进化层 —— DSH 没有对应物
│   │   ├── memory.ts              有界记忆（写满即拒绝 + 合并建议）
│   │   ├── nudge.ts               提醒规则引擎
│   │   ├── skills.ts              技能库（目录 / 全文两级）
│   │   ├── curator.ts             技能生命周期（上游技能不可归档）
│   │   ├── user-model.ts          用户建模（派生结论 + 出处）
│   │   ├── recall.ts              FTS5 历史检索
│   │   ├── diagnose.ts            失败归因 + 指标与置信区间
│   │   ├── evolve.ts              演化门控（白名单 / 保护名单 / 回归 / 回滚）
│   │   └── audit.ts               审计链（哈希链）
│   ├── apps/
│   │   ├── cli.ts                 唯一入口：装载 → dump → 跑任务 → 报告
│   │   └── verify.ts              一键验收：16 个演示 + 2 个端到端检查
│   └── demos/                     16 个演示，每一步一个
├── bundles/                       core.json（能力层）/ evolution.json（进化层）
├── profiles/                      agent.json（离线）/ evolution.json（含进化层）等
├── patches/                       命令行覆盖示例
├── skills/                        技能库落盘形式（.md）
├── workspace/                     agent 的沙箱工作目录
├── docs/                          34 篇课程与研究文档
├── package.json                   scripts（npm 可用时可直接 `npm run verify`）
└── tsconfig.json                  只为编辑器与 `tsc --noEmit` 准备，运行不需要
```

## 快速开始

### 环境要求

- **Node.js ≥ 22.18**（本项目在 v24.12.0 上开发）。需要它内置的 **TypeScript 类型擦除**：
  直接从源码运行 `.ts` 文件，不经过编译。
- 不需要 npm / pnpm / yarn，不需要联网（默认用 `MockProvider`）。

### 30 秒跑通

```bash
git clone https://github.com/lancasterevaluation-collab/dsh-mini.git
cd dsh-mini

# 一键验收：16 个演示 + 2 个端到端检查
node src/apps/verify.ts

# 跑一个真实任务（离线 mock 模型，会真的读写 workspace/ 里的文件）
node src/apps/cli.ts "看看这个目录里有什么，然后读一下 README"
```

第二条命令的真实输出（节选）：

```
[llm] 已装载：mock（model=mock-offline）
[tools] 已装载：workspace=...\dsh-mini\workspace；工具=read_file, list_dir, write_file, delete_file
[retry] 已装载：mode=normal maxRetries=3 budget=6
[guard] 已装载：规则=loop, irreversible, quota, path；自动批准=(无，一律问人)
[agent-loop] 已装载：maxSteps=8；retry=已装；guard=已装；checkpoints=...

======== 事件流 ========
  #1 用户：看看这个目录里有什么，然后读一下 README
  #3 模型：(无文本) → 要调用 1 个工具
  #4   调用 list_dir
  #5   结果 ✓ README.md
  #9   调用 read_file
  #13 模型：（mock 模型）我先列了目录，再读了 README.md。任务完成。

======== 结果 ========
  状态        complete
  步数        3
  工具调用    2（失败 0）
  消息数      6（这就是模型看到的全部）
```

## 用法

### 跑一个任务

```bash
node src/apps/cli.ts "任务描述"
```

任务描述是位置参数，所有非开关的词会被拼成一句话。

### 换 profile

profile 决定装载哪些插件：

```bash
# 默认：能力层（离线 mock）
node src/apps/cli.ts "任务"

# 带进化层：记忆 / 提醒 / 技能 / 检索 / 诊断 / 审计
node src/apps/cli.ts --profile profiles/evolution.json "任务"
```

### 覆盖配置

patch 按行 `id` 定位，并**整段替换**该行的 config（不是深合并）：

```bash
# 放开 delete_file 的自动批准
node src/apps/cli.ts --patch patches/allow-delete.json "删掉 workspace/important.txt"
```

### 看最终生效的配置

"改了配置但没生效"是这类系统最经典的故障，所以 dump 排在执行之前：

```bash
node src/apps/cli.ts --profile profiles/evolution.json --dump "任意"
```

```
======== 生效的配置 ========
profile：evolution（.../profiles/evolution.json）
bundle：../bundles/core.json → ../bundles/evolution.json
生效的行：
  llm                ../src/plugins/llm.ts
  tools              ../src/plugins/tools.ts
  session            ../src/plugins/session.ts
  retry              ../src/plugins/retry.ts
  guard              ../src/plugins/guard.ts
  agent-loop         ../src/plugins/agent-loop.ts
  evolution          ../src/plugins/evolution.ts
```

### 接真实模型

`DeepSeekProvider` 走 OpenAI 兼容的 `/chat/completions`。配一个 patch 把 provider 换掉：

```bash
export DEEPSEEK_API_KEY=sk-...
node src/apps/cli.ts --patch patches/use-deepseek.json "任务"
```

缺 key 时会在**装载阶段**就报错，而不是等到第一次请求 —— 这是刻意的：
"缺依赖"必须在装载时炸，不能飘到几百行之外变成一个莫名其妙的 `TypeError`。

### 跑单个演示

每一步都有独立可跑的演示，全部脱网：

```bash
node src/demos/demo-context.ts          # 第 3 步：ctx 容器与装载回滚
node src/demos/demo-retry.ts            # 第 9 步：前 2 次失败第 3 次成功
node src/demos/demo-guard.ts            # 第 10 步：守卫、审批、检查点回滚
node src/demos/demo-evolution-loop.ts   # 第 12–16 步：完整进化闭环
```

## 16 步路线图

| 阶段 | 步 | 内容 | 产出 | 状态 |
| --- | --- | --- | --- | --- |
| **Phase 0** 基础 | 1 | 模型层（Provider / 错误分类 / 线格式） | `kernel/llm.ts` | ✅ |
| | 2 | 工具层（注册表 / schema / 校验 / 执行） | `kernel/tools.ts`、`builtin-tools.ts` | ✅ |
| **Phase 1** 框架 | 3 | ctx 容器 + 服务注册 + 副作用回滚 | `framework/context.ts` | ✅ |
| | 4 | 类型化事件 + waterfall + 依赖注入 | `framework/events.ts` | ✅ |
| | 5 | 作用域隔离 | `framework/scope.ts` | ✅ |
| | 6 | profile / bundle 组合装载器 | `framework/loader.ts` | ✅ |
| **Phase 2** 能力 | 7 | 会话日志（append-only + 派生 + 落盘） | `plugins/session.ts`、`kernel/session.ts` | ✅ |
| | 8 | agent 循环（turn / step 状态机） | `plugins/agent-loop.ts`、`kernel/agent.ts` | ✅ |
| | 9 | 重试（错误分类 → 退避 → 挂扩展点） | `plugins/retry.ts`、`kernel/retry.ts` | ✅ |
| | 10 | 校验与审批（守卫链 + 单调性 + 检查点） | `plugins/guard.ts`、`kernel/guard.ts` | ✅ |
| | 11 | CLI 端到端 | `apps/cli.ts` | ✅ |
| **Phase 3** 进化 | 12 | 有界记忆 + Nudge | `evolution/memory.ts`、`nudge.ts` | ✅ |
| | 13 | 技能库 + 渐进式披露 + Curator | `evolution/skills.ts`、`curator.ts` | ✅ |
| | 14 | 用户建模 + 历史检索（FTS5） | `evolution/user-model.ts`、`recall.ts` | ✅ |
| | 15 | 诊断（失败归因 + Macro-F1 + κ） | `evolution/diagnose.ts` | ✅ |
| | 16 | 演化门控 + 审计链 | `evolution/evolve.ts`、`audit.ts` | ✅ |

## 验收

```bash
node src/apps/verify.ts
```

```
======== 验收：逐条跑演示与端到端检查 ========

✅ demo-agent.ts              135 ms
✅ demo-context.ts            119 ms
✅ demo-diagnose.ts           171 ms
... （16 个演示）
✅ cli --dump                 205 ms
✅ cli 任务                   207 ms

======== 汇总 ========
  18/18 项通过
```

每一个演示都**带期望输出**：只检查退出码会让"什么都没跑"也算通过，
所以 `verify.ts` 还会在输出里找那句"它确实跑到了结论"的标记。

## 关键设计决策

这几条是项目里最值得看的取舍。每条都给出**代价**——说得出代价才算真懂。

### 1. 服务注册写到共享表，归属记在注册者身上

插件 A 注册的服务，兄弟插件 B 能看见。为什么不让它只在自己子容器里可见？
因为那样 `root` 下的两个兄弟插件就永远找不到彼此，"插件之间无法协作"，框架直接失去意义。

**代价**：默认没有隔离。所以第 5 步补了**显式**的 `isolate()` ——
出问题时那一行就在 diff 里。

### 2. 重试是插件，不是循环里的 `if`

```
retry 是一个监听 agent/request-error 的插件；
卸载它 = 关掉重试，循环代码一行不改。
```

实现方式是给 `Agent` 留一个 `requestErrorHook` —— 一个**普通函数类型**，
所以 kernel 依然不认识框架；把钩子接到 `ctx.emit` 上的动作发生在 `plugins/` 层。

**代价**：多一层间接（要读插件才知道重试策略是什么）。

### 3. 每个工具调用都必须产生一条结果，包括被拒绝的

`assistant` 消息带 N 个 `tool_calls`，后面就必须跟 N 个 `tool` 消息，少一条服务端直接 400。
所以守卫拦下一个调用时，正确的做法不是"跳过它"，而是**同样返回一条失败结果**，内容换成拒绝理由。

**代价**：模型会看到"我想做的事被拦了，原因是……"——这是特性不是缺陷，
否则它会一直重试同一个被拦的动作。

### 4. 记忆写满即拒绝，而不是淘汰最旧

淘汰最旧在缓存里是对的，在记忆里是错的：**最旧的那条可能正是"用户从一开始就强调的约束"**。
所以容量是硬上限，满了就抛 `MemoryFullError`，并给出"该合并哪几条"的建议。

**代价**：模型必须真的去合并（多一次工具调用），而合并需要它判断两条记忆是不是同一件事。

### 5. 提醒走任务入口，不插进会话中间

会话是 append-only 的事实记录。往里塞一句"系统觉得你该少试几次"，
会让模型看到的历史混进**不是模型产生、也不是用户说的**内容，
而这条日志的核心不变量是"模型看到的都能从日志重建"。

所以 nudge 在下一次任务开始前拼进**任务文本**，并因此留下两条可查证据：
`agent/task-ready` 事件的改写，以及日志里那条真实的 `user/message`。

**代价**：提醒只能在 turn 边界生效，一次 turn 内部的自我修正机会享受不到。

### 6. 自改只能改数据，不能改机制

演化门控默认保护整个 `src/`。一个能改自己源码的 agent，
它的审计链就失去意义了——记录说"我改的是记忆"，而实际动作可以改掉记录本身。

**代价**：想调整机制得人来做，摩擦是有意保留的。

## 文档

`docs/` 有 34 篇文档。最重要的一篇是课程总纲，它解释这 16 步为什么这么排：

| 文档 | 内容 |
| --- | --- |
| [`docs/00-course-map.md`](docs/00-course-map.md) | **课程总纲**：16 步总览、依赖图、三条主线 |
| [`docs/00-graduation.md`](docs/00-graduation.md) | **能力矩阵与毕业标准**：31 项能力、五级定义、5 项毕业检验 |
| [`docs/glossary.md`](docs/glossary.md) | 术语表，118 个词条（白话解释 + "没有它会怎样" + 首次出现步骤） |
| [`docs/01-llm.md`](docs/01-llm.md) | 第 1 步 · 模型层（140 KB，完整逐行讲解，可作范文） |
| … | 第 2–10 步同样为完整结构（32–94 KB 每篇） |
| [`docs/11-cli.md`](docs/11-cli.md) | 第 11 步 · 端到端（精简结构） |
| [`docs/16-evolve.md`](docs/16-evolve.md) | 第 16 步 · 演化与审计（精简结构，含结课总结） |
| [`docs/reference/dsh-architecture.md`](docs/reference/dsh-architecture.md) | DSH 完整架构图与包组地图 |
| [`docs/reference/dsh-file-map.md`](docs/reference/dsh-file-map.md) | DSH 文件 → dsh-mini 文件映射表 |

> **文档形态的诚实说明**：`01`–`10` 是完整结构（16 节 + 逐行讲解，面向零基础）；
> `11`–`16` 是精简结构（保留论证、决策表、真实输出与真实缺陷，但不逐行讲代码）。
> 把后者扩成完整结构是后续可做的工作，当前没有假装已经做完。

## 常见问题

**Q：为什么零依赖？不装依赖不是很麻烦吗？**

三个具体原因：这台机器上 npm 不可用；依赖会掩盖"哪些能力是框架必需的"这个问题
（比如"日志检索"用 `node:sqlite` 就够了，不需要装一个数据库客户端）；
以及 9 千行代码里你能读懂每一行。

`node:sqlite` 是 Node 内置的实验性 API，会打印一条 `ExperimentalWarning` ——
这是零依赖的直接后果。代码里用 `--disable-warning=ExperimentalWarning` 屏蔽它。

**Q：为什么不用 TypeScript 编译器？**

Node ≥ 22.18 内置类型擦除，直接把 `.ts` 当脚本跑。代价是有三条硬约束：

1. 相对导入**必须带 `.ts`**：`import { x } from './y.ts'`
2. 不能写 `enum`、`namespace`、构造函数参数属性
3. 只导入类型时必须 `import type { X } from './y.ts'`

`tsconfig.json` 里的 `erasableSyntaxOnly: true` 就是这三条的开关
（装了 TypeScript 时可以 `npx tsc --noEmit` 做类型检查，运行不需要它）。

**Q：跑完任务后，数据落在哪？**

| 位置 | 内容 |
| --- | --- |
| `workspace/` | agent 的工作目录（沙箱） |
| `workspace/.sessions/*.jsonl` | 会话日志，每次 turn 结束落盘一行一事件 |
| `workspace/.checkpoints/` | 有副作用调用之前的文件快照 |

三者都进了 `.gitignore`。想清理：

```bash
rm -rf workspace/.sessions workspace/.checkpoints workspace/guard-demo
# Windows PowerShell 等价写法：
# Remove-Item -Recurse -Force workspace/.sessions, workspace/.checkpoints, workspace/guard-demo
```

**Q：`node src/apps/cli.ts` 报"找不到服务 xxx"？**

那说明某个插件没装载，或者装载顺序让依赖没就绪。
先 `--dump` 看生效的配置里有没有那一行 —— 这是这类故障的第一诊断步骤。

**Q：真的能连真实模型吗？**

能，`DeepSeekProvider` 已实现（OpenAI 兼容协议）。但这台开发机上没有 key，
所以**所有演示与验收都跑在 `MockProvider` 上** —— 这一点没有含糊：
仓库里没有任何"假装调用过真实模型"的输出。

## 项目状态与局限

**已完成**：16 步全部实现并通过验收（18/18）。

**没有做的，以及为什么**：

| 未覆盖 | 原因 | 补齐路径 |
| --- | --- | --- |
| Web GUI / Electron 桌面 | 需要前端工程技能，与架构正交 | 另开一门课 |
| 跨语言 SDK / RPC 协议 | 需要协议设计与代码生成 | 读 `docs/reference/dsh-architecture.md` |
| OS 级沙箱（bwrap / Landlock） | 需要系统编程 | 本项目只做策略层（`guard`） |
| LSP / PTY 终端 / 浏览器自动化 | 属于"能力插件"，不属于架构 | 会了框架后按 DSH 的 `packages/README.md` 逐个看 |
| CI 门禁 / 快照测试体系 | 工程实践 | `verify.ts` 是可接入 CI 的第一步 |
| 会话格式版本迁移链 | 复杂的向后兼容工程 | 需要真实的格式变更历史 |

**已知的真实缺陷**（每个模块的文件头与 `docs/` 的 L4 章节都列了，这里挑几个）

- `kernel/agent.ts` 的工具调用是**串行**的，没有并行工具池。
- 用户建模的信号提取是**正则规则**：会漏掉同义表达（"简洁"匹配不到"简短"那条规则）。
- `diagnose.ts` 的规则只看"有没有"、不看"多少"：一次工具失败和十次归因相同。
- 审计链只在内存里，进程退出即丢（`AuditLog.toJSON()` 已经可用，接落盘即可）。
- 演化门控的回归用例是 3 条内置探针，覆盖太窄，发现不了大部分退化。

## 开发约定

### 加一个新能力（4 步）

1. **先问挂在哪，再问怎么写。** 如果答案是"要在 agent-loop 里加个 `if`"，
   那么真正的答案是**没有合适的扩展点**——先去补扩展点。
2. 建 `src/plugins/<名字>.ts`，导出 `default` 一个 `Plugin`，在 `apply` 里注册服务。
3. 在 `bundles/*.json` 里加一行（`plugin` 路径相对 bundle 文件所在目录）。
4. `node src/apps/cli.ts --dump` 能看到这一行；卸载它（`"disabled": true`）后行为回到原样。

### 两条最容易踩的坑

| 坑 | 后果 | 规矩 |
| --- | --- | --- |
| 监听器忘了 `return next()` | 后面的监听器**全部静默失效** | waterfall 里不调 `next()` 就是短路 |
| 插件里 `import` 另一个插件 | 依赖方向被打乱 | 要拿别的能力用 `ctx.require(name)` |

### 改代码前先读

- `docs/00-course-map.md` 的"三条贯穿始终的主线"——它定义了什么叫"改对了"。
- 对应模块的文件头注释——每个文件开头都写了它解决什么问题、为什么这么设计。

## 参与贡献

欢迎 issue 与 PR。三条要求：

1. **先跑验收**：`node src/apps/verify.ts` 必须 18/18 通过，新增演示要在
   `verify.ts` 的 `expectations` 里登记期望输出。
2. **改动分层不能倒**：`kernel/` 不许 import `framework/`，`plugins/` 不许 import `apps/`。
3. **缺陷要坦白**：新增模块的文件头要写清它的真实缺陷，不要写"以后会做"来冒充。

## 许可证

[MIT](LICENSE)

## 致谢

- 架构参照 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 与它内置的
  [Cordis](https://github.com/cordiverse/cordis) 插件框架。
- 进化层的设计参照 Hermes 式 agent 的学习闭环思路。
- 第 15 步的失败分类（反馈抗拒 / 反馈质量）参照 *Feedback Friction: LLMs Struggle to
  Fully Incorporate External Feedback*（NeurIPS 2025）的错误分类体系；
  相关笔记见 [`docs/papers/feedback-friction.md`](docs/papers/feedback-friction.md)。

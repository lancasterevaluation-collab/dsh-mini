/**
 * 第 2 步 ｜ 三个真实工具：read_file / write_file / list_dir
 * 第 10 步 ｜ 新增 delete_file，并给每个工具贴上**副作用等级**
 *
 * 这些是「插件」，注册表是「框架」。区分它们的理由：
 * 换一套工具（比如接数据库、调 API）不需要动 tools.ts 一行。
 *
 * ── 第 10 步为什么必须新增 delete_file ───────────────────────────────
 *
 * 因为 A/B/C 三分法里的 **C 类（不可逆）** 需要一个**真实的**不可逆动作才能演示。
 * 原来的三个工具里没有：读是无副作用的，写是可逆的（能被回滚覆盖）。
 *
 * 这个新增不是"为了演示硬凑" —— 它暴露了一个真实规律：
 * ★ 一个只提供 read/write 的 harness，**结构上不可能产生 C 类失败** ★，
 * 所以它的守卫可以很松；而一旦接入了 `rm` / `git push` / 发消息 / 支付，
 * 同一套 harness 就必须有事前拦截。**工具集决定了你需要多强的守卫。**
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { ok } from './tools.ts'
import type { Tool, ToolContext } from './tools.ts'

/**
 * 把模型给的路径解析成绝对路径，并挡住越权访问。
 *
 * 模型给的路径**不可信** —— 它完全可能拼出 `../../../Windows/win.ini`。
 * 这里只做最基础的一道防线；第 10 步的 `pathGuard` 会在**执行前**再筛一次 ——
 * 两层拦截的时机不同，不是冗余（见 guard.ts 里 `pathGuard` 的说明）。
 * @throws 路径跑出工作目录时抛出，由注册表转成失败结果
 */
function resolveInsideWorkspace(ctx: ToolContext, raw: unknown): string {
  const input = typeof raw === 'string' ? raw : String(raw ?? '.')
  const absolute = resolve(ctx.workspace, input)

  // relative 算出「从工作目录到目标」怎么走；以 .. 开头就说明跑出去了
  const rel = relative(ctx.workspace, absolute)
  if (rel === '') return absolute
  // Windows 上跨盘符时 relative 会返回绝对路径，所以额外判一次 isAbsolute
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`路径越权：${JSON.stringify(input)} 不在工作目录内`)
  }
  return absolute
}

/** 读取工作目录内的文本文件，带行号返回。 */
export const readFileTool: Tool = {
  name: 'read_file',
  description: '读取工作目录内的一个文本文件，返回带行号的内容。改动文件前先用它看清原文。',
  // 只读 —— 不改变任何状态，失败后随便重试
  sideEffect: 'none',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对工作目录的文件路径' },
      maxLines: { type: 'integer', description: '最多返回多少行，默认 200' },
    },
    required: ['path'],
  },
  async handler(args, ctx) {
    const path = resolveInsideWorkspace(ctx, args.path)
    const maxLines = typeof args.maxLines === 'number' ? args.maxLines : 200

    const text = await readFile(path, 'utf8')
    const lines = text.split('\n')
    const shown = lines.slice(0, maxLines)

    // 行号很重要：模型读到的行号要和后续「改第 N 行」对得上
    const numbered = shown
      .map((line, index) => `${String(index + 1).padStart(4, ' ')}│ ${line}`)
      .join('\n')

    if (lines.length <= maxLines) return ok(numbered)
    return ok(`${numbered}\n...（文件共 ${lines.length} 行，这里只显示前 ${maxLines} 行）`)
  },
}

/** 写入（覆盖）工作目录内的文件。 */
export const writeFileTool: Tool = {
  name: 'write_file',
  description: '把内容写入工作目录内的文件。文件不存在则创建（父目录一并创建），存在则整体覆盖。',
  // ★ 可逆：旧内容虽然被覆盖了，但检查点里还留着，能写回去
  sideEffect: 'reversible',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对工作目录的文件路径' },
      content: { type: 'string', description: '要写入的完整内容' },
    },
    required: ['path', 'content'],
  },
  async handler(args, ctx) {
    const path = resolveInsideWorkspace(ctx, args.path)
    const content = typeof args.content === 'string' ? args.content : String(args.content ?? '')

    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')

    // 用 TextEncoder 而不是 Buffer：字节数才是真正写进磁盘的量，且不依赖 Node 专有类型
    const bytes = new TextEncoder().encode(content).byteLength
    return ok(`已写入 ${String(args.path)}（${bytes} 字节）`)
  },
}

/** 列目录。 */
export const listDirTool: Tool = {
  name: 'list_dir',
  description: '列出工作目录内某个目录下的条目。目录名会带 / 后缀。不确定项目结构时先用它。',
  // 只读
  sideEffect: 'none',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对工作目录的目录路径，默认 "."（工作目录本身）' },
    },
  },
  async handler(args, ctx) {
    const path = resolveInsideWorkspace(ctx, args.path ?? '.')
    const entries = await readdir(path, { withFileTypes: true })

    if (entries.length === 0) return ok('(空目录)')

    const lines = entries
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort()
    return ok(lines.join('\n'))
  },
}

/**
 * 删除工作目录内的一个文件。★ 第 10 步新增，C 类的典型代表 ★
 *
 * 为什么把它标成 `irreversible` 而不是 `reversible`？
 * 因为**在这个 harness 里**确实不可逆 —— 没有回收站、没有 git、没有备份。
 *
 * ★ 但请注意：这个判断是**相对于当前 harness 能力**的 ★。
 * 如果工作目录是一个 git 仓库，删除内容还能从 git 里取回，
 * 那时它就该被标成 `reversible`。
 *
 * 这正是 error-taxonomy.md 里那条主张的落点：
 * **"不可逆"不是任务的客观属性，而是「动作 × harness 能力」的联合属性。**
 */
export const deleteFileTool: Tool = {
  name: 'delete_file',
  description: '删除工作目录内的一个文件。此操作无法撤销，请只在确认该文件确实不再需要时使用。',
  sideEffect: 'irreversible',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要删除的文件路径' },
    },
    required: ['path'],
  },
  async handler(args, ctx) {
    const path = resolveInsideWorkspace(ctx, args.path)
    await rm(path, { force: true })
    return ok(`已删除 ${String(args.path)}`)
  },
}

/** 全部内置工具。注册顺序就是它们出现在模型 prompt 里的顺序。 */
export const builtinTools: readonly Tool[] = [
  readFileTool,
  writeFileTool,
  listDirTool,
  deleteFileTool,
]

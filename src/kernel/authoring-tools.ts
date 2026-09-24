/**
 * 创造模式的工具：让 agent 写技能与插件
 *
 * 对照 DSH 的 Creator preset —— "通过对话定制 DSH：让 agent 写插件加功能，
 * 或组合工具与提示词创造自己的模式"。
 *
 * ── ★ 两个工具的危险等级刻意不同 ★ ────────────────────────────────────
 *
 * | 工具 | sideEffect | 后果 |
 * |---|---|---|
 * | `write_skill` | `reversible` | 写 `skills/*.md` —— 技能是**数据**，改错了删掉即可 |
 * | `write_plugin` | `irreversible` | 写 `src/plugins/*.ts` —— **改的是机制本身** |
 *
 * 这不是随手标的：第 10 步的 `irreversibleGuard` 会自动对后者要求人工审批。
 * 于是默认配置下**技能可以自己长，源码不能自己改** —— 而"改机制"这件事
 * 恰好是第 16 步演化门控里被保护名单挡住的同一类动作。
 *
 * 想让 agent 真的写插件，得显式放开（`approve: ["write_plugin"]`）。
 * 这个摩擦是有意的：把"让 AI 改自己的源码"变成一个**要说出口的决定**。
 *
 * ── 为什么写进去还要"重新装载" ★ ──────────────────────────────────────
 *
 * 因为插件是**装载期**确定的（第 3 步的取舍：注册写进服务表、依赖在装载时校验）。
 * 热插拔一个插件需要一套"卸载旧树 + 装载新树 + 让运行中的 agent 安全迁移"的机制，
 * DSH 用 revision 保留做到了（见它的 agent-preset note），本项目不做。
 * 所以这里的语义是：**写进磁盘 ≠ 立即生效** —— 工具返回里会明说这一点，
 * 免得模型以为写完就完事了。
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fail, ok } from './tools.ts'
import type { Tool, ToolResult } from './tools.ts'

/** 项目根目录（`src/kernel/` 往上两级）。 */
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 技能目录。 */
export const SKILLS_DIR = join(PROJECT_ROOT, 'skills')

/** 插件目录。 */
export const PLUGINS_DIR = join(PROJECT_ROOT, 'src', 'plugins')

/** 模式目录。 */
export const MODES_DIR = join(PROJECT_ROOT, 'modes')

/**
 * 校验一个"文件基名"，防止写出到目录之外。
 *
 * `../../etc/passwd` 这种输入必须被挡住 —— 而它可能来自模型。
 * @param name 候选名字
 * @param suffix 期望的后缀（如 `.md`）
 * @returns 合法时返回归一化后的名字
 * @throws 非法时
 */
export function safeFileName(name: string, suffix: string): string {
  const trimmed = name.trim()
  if (trimmed === '') throw new Error('名字不能为空')
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    throw new Error(`名字里不能有路径分隔符或 ".."：${name}`)
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) {
    throw new Error(`名字只能是字母、数字、点、下划线、连字符：${name}`)
  }
  return trimmed.endsWith(suffix) ? trimmed : `${trimmed}${suffix}`
}

/** 断言目标路径确实在允许的目录内（双保险：基名校验之外再做一次解析校验）。 */
function assertInside(target: string, allowedDir: string): void {
  const normalized = resolve(target)
  if (!normalized.startsWith(resolve(allowedDir) + sep)) {
    throw new Error(`拒绝写入到允许目录之外：${normalized}`)
  }
}

/** `write_skill` 工具：把一段流程写成技能文件。 */
export const writeSkillTool: Tool = {
  name: 'write_skill',
  description:
    '把一个可复用的流程写成技能文件（skills/<名字>.md）。' +
    '技能是数据、可随时覆盖或删除，不需要审批。' +
    '文件格式：第一行 `# 一句话描述`，第二行 `triggers: 触发词1, 触发词2`，其余是正文。',
  sideEffect: 'reversible',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '技能名（会成为文件名，如 debugging-waterfall）' },
      description: { type: 'string', description: '一句话描述 —— 这是渐进披露里唯一永远可见的部分' },
      triggers: {
        type: 'array',
        description: '触发词：任务里出现这些词时这条技能值得被读',
        items: { type: 'string' },
      },
      body: { type: 'string', description: '技能正文（markdown）' },
    },
    required: ['name', 'description', 'body'],
  },
  async handler(args): Promise<ToolResult> {
    try {
      const fileName = safeFileName(String(args.name ?? ''), '.md')
      const target = join(SKILLS_DIR, fileName)
      assertInside(target, SKILLS_DIR)

      const description = String(args.description ?? '').trim()
      const triggers = Array.isArray(args.triggers) ? args.triggers.map((item) => String(item)) : []
      const body = String(args.body ?? '')

      const existed = await readFile(target, 'utf8').then(() => true, () => false)
      const content = [
        `# ${description}`,
        '',
        triggers.length > 0 ? `triggers: ${triggers.join(', ')}` : '',
        '',
        body.trim(),
        '',
      ].join('\n')

      await mkdir(SKILLS_DIR, { recursive: true })
      await writeFile(target, content, 'utf8')

      return ok(
        `已${existed ? '覆盖' : '写入'}技能 skills/${fileName}（${Buffer.byteLength(content, 'utf8')} 字节）。` +
          '重新装载后它就会出现在技能目录里（`catalog()` 只暴露名字与描述）。',
      )
    } catch (error) {
      return fail(`写技能失败：${error instanceof Error ? error.message : String(error)}`)
    }
  },
}

/** `write_plugin` 工具：把一段插件源码写进 src/plugins/。 */
export const writePluginTool: Tool = {
  name: 'write_plugin',
  description:
    '把一个能力插件的源码写进 src/plugins/<名字>.ts。' +
    '**这会修改系统本体**，属不可逆操作，必须经过人工审批。' +
    '源码必须遵守项目约定：相对导入带 .ts、默认导出 Plugin、监听器要 return next()。' +
    '写完之后不会自动生效 —— 需要重新装载。',
  sideEffect: 'irreversible',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '插件名（会成为文件名，如 token-budget）' },
      source: { type: 'string', description: '插件源码全文（TypeScript）' },
    },
    required: ['name', 'source'],
  },
  async handler(args): Promise<ToolResult> {
    try {
      const fileName = safeFileName(String(args.name ?? ''), '.ts')
      const target = join(PLUGINS_DIR, fileName)
      assertInside(target, PLUGINS_DIR)

      const source = String(args.source ?? '')
      if (source.trim() === '') return fail('source 不能为空。')
      if (!source.includes('export default')) {
        // 装载器要求 default 导出 —— 早发现比"装不上才知道"好
        return fail('插件源码缺少 `export default`（装载器要求默认导出插件对象）。')
      }

      const existed = await readFile(target, 'utf8').then(() => true, () => false)
      await mkdir(PLUGINS_DIR, { recursive: true })
      await writeFile(target, source, 'utf8')

      return ok(
        `已${existed ? '覆盖' : '写入'}插件 src/plugins/${fileName}（${Buffer.byteLength(source, 'utf8')} 字节）。\n` +
          '★ 它**还没有生效**：插件在装载期确定，需要重新装载才会被加载。\n' +
          '要让它装进某个模式，还得在 modes/*.json（或 bundles/*.json）里加一行。',
      )
    } catch (error) {
      return fail(`写插件失败：${error instanceof Error ? error.message : String(error)}`)
    }
  },
}

/** 列出当前有哪些技能与插件（给创造模式看"现在有什么"）。 */
export const listAuthoringTool: Tool = {
  name: 'list_authoring',
  description: '列出当前已有的技能文件、插件文件与模式文件。动手改造系统之前先用它看清现状。',
  sideEffect: 'none',
  parameters: { type: 'object', properties: {} },
  async handler(): Promise<ToolResult> {
    const list = async (dir: string, suffix: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
        .map((entry) => entry.name)
        .sort()
    }

    const [skills, plugins, modes] = await Promise.all([
      list(SKILLS_DIR, '.md'),
      list(PLUGINS_DIR, '.ts'),
      list(MODES_DIR, '.json'),
    ])

    return ok([
      `项目根：${PROJECT_ROOT}`,
      '',
      `技能（skills/，共 ${skills.length} 个）：`,
      ...skills.map((name) => `  · ${name}`),
      '',
      `插件（src/plugins/，共 ${plugins.length} 个）：`,
      ...plugins.map((name) => `  · ${name}`),
      '',
      `模式（modes/，共 ${modes.length} 个）：`,
      ...modes.map((name) => `  · ${name}`),
    ].join('\n'))
  },
}

/** 创造模式的全部工具。 */
export const authoringTools: readonly Tool[] = [writeSkillTool, writePluginTool, listAuthoringTool]

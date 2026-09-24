/**
 * 第 2 步演示：注册表到底做了什么。
 *
 * 运行：  node src/demos/demo-tools.ts
 * 联网：  不需要。
 *
 * 这个演示会在系统临时目录里真实读写文件，路径会打印出来，你随时可以删掉。
 */

import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { builtinTools } from '../kernel/builtin-tools.ts'
import { ToolRegistry, ok } from '../kernel/tools.ts'
import type { ToolResult } from '../kernel/tools.ts'

/** 打印结构化的东西，方便逐字段核对。 */
function show(title: string, value: unknown): void {
  console.log(`\n--- ${title} ---`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

/** 统一打印一次工具执行结果。 */
function showResult(label: string, result: ToolResult): void {
  console.log(`\n--- ${label} ---`)
  console.log(`isError: ${result.isError}`)
  const lines = result.content.split('\n')
  const preview = lines.slice(0, 12).join('\n')
  console.log(lines.length > 12 ? `${preview}\n（...共 ${lines.length} 行）` : preview)
}

async function main(): Promise<void> {
  // 演示用的工作目录
  const workspace = join(tmpdir(), 'agent-harness-lab-demo')
  await rm(workspace, { recursive: true, force: true })
  await mkdir(workspace, { recursive: true })
  console.log(`演示工作目录：${workspace}`)

  const registry = new ToolRegistry()
  for (const tool of builtinTools) {
    registry.register(tool)
  }

  // 两个只用于演示的工具：
  //   1. big_output —— 故意产出超长文本，看截断
  //   2. set_level  —— 带 enum，看取值校验
  registry.register({
    name: 'big_output',
    description: '产出一段超长文本，仅用于演示截断。',
    parameters: { type: 'object', properties: {} },
    maxOutputChars: 200,
    async handler() {
      return ok('行'.repeat(500))
    },
  })

  registry.register({
    name: 'set_level',
    description: '设置日志级别，仅用于演示 enum 校验。',
    parameters: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['low', 'high'], description: '级别，只能是 low 或 high' },
      },
      required: ['level'],
    },
    async handler(args) {
      return ok(`已设为 ${String(args.level)}`)
    },
  })

  // ==========================================================
  // 演示 1：发给模型的说明书长什么样
  // ==========================================================
  console.log('\n======== 演示 1：工具名列表 + 完整 schema ========')
  show('模型能看到哪些工具', registry.names())
  show('read_file 的完整 schema（这就是进 prompt 的东西）', registry.schemas()[0])

  // ==========================================================
  // 演示 2：正常执行
  // ==========================================================
  console.log('\n======== 演示 2：正常执行 ========')

  const ctx = { workspace }

  showResult('list_dir 空目录', await registry.execute('list_dir', {}, ctx))
  showResult(
    'write_file 写文件',
    await registry.execute('write_file', {
      path: 'notes/hello.txt',
      content: '第一行\n第二行\n第三行\n',
    }, ctx),
  )
  showResult('list_dir 再列一次', await registry.execute('list_dir', {}, ctx))
  showResult('read_file 读回来（注意行号）', await registry.execute('read_file', { path: 'notes/hello.txt' }, ctx))

  // ==========================================================
  // 演示 3：三种「调用方式不对」，全都被挡下
  // ==========================================================
  console.log('\n======== 演示 3：调用方式不对 ========')

  showResult('未知工具', await registry.execute('delete_everything', {}, ctx))
  showResult('缺少必填字段', await registry.execute('read_file', {}, ctx))
  showResult('字段类型错', await registry.execute('read_file', { path: 123 }, ctx))
  showResult('enum 取值越界', await registry.execute('set_level', { level: 'medium' }, ctx))

  // ==========================================================
  // 演示 4：工具执行时自己炸了
  // ==========================================================
  console.log('\n======== 演示 4：工具内部抛异常（越权路径） ========')

  showResult(
    'read_file 尝试读工作目录之外',
    await registry.execute('read_file', { path: '../../../Windows/win.ini' }, ctx),
  )

  // ==========================================================
  // 演示 5：超长输出被截断
  // ==========================================================
  console.log('\n======== 演示 5：超长输出截断 ========')

  const big = await registry.execute('big_output', {}, ctx)
  show('输出长度（字符）', big.content.length)
  show('被截断后的样子', `${big.content.slice(0, 60)} ... ${big.content.slice(-60)}`)

  // ==========================================================
  // 演示 6：重名注册
  // ==========================================================
  console.log('\n======== 演示 6：重名注册 ========')

  try {
    registry.register({
      name: 'read_file',
      description: '故意和内置工具重名，用来触发注册表的重名检查。',
      parameters: { type: 'object', properties: {} },
      async handler() {
        return ok('这条工具本该覆盖掉内置的 read_file —— 如果真的注册成功，那就是 bug。')
      },
    })
  } catch (cause) {
    show('覆盖注册被拒绝', cause instanceof Error ? cause.message : String(cause))
  }

  console.log('\n演示结束。工作目录保留着，你可以去看：')
  console.log(`  ${workspace}`)
}

await main()

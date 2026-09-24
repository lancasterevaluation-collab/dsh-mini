/**
 * 验收程序：一条命令跑完全部演示与端到端检查。
 *
 * 运行：  node src/apps/verify.ts
 *
 * ── 为什么需要一个"跑全部"的应用，而不是在 CI 里写一串命令？──────────
 *
 * 因为这份课程的验收判据是**每一步的演示**（16 个 demo + 1 个 CLI）。
 * 把它们写进一个脚本，验收就从"我记得跑过"变成"退出码是 0"。
 *
 * ★ 注意它是**子进程**跑每个 demo，而不是 import 它们：
 *   每个 demo 都用顶层 await 且会打印大量内容，import 会把它们的输出
 *   与验收报告混在一起，而且其中一个抛错会中断整轮 ——
 *   那样"第 12 个 demo 挂了"就看不到后面的结果。
 *   子进程隔离让每个检查独立失败、独立报告。
 */

import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** 一次检查的结果。 */
interface CheckResult {
  readonly name: string
  readonly code: number
  readonly ms: number
  /** 完整输出（用于判定）。 */
  readonly output: string
  /** 失败时保留的尾部（用于显示）。 */
  readonly tail: string
}

/** 本文件所在目录（`src/apps`）。 */
const HERE = import.meta.dirname
const ROOT = resolve(HERE, '../..')

/**
 * 跑一条命令，收集退出码与输出。
 * @param args 命令行参数
 * @param stdin 要写进子进程标准输入的内容（给交互式程序用；写完即关闭）
 * @returns 结果
 */
function run(args: readonly string[], stdin?: string): Promise<CheckResult> {
  const started = Date.now()
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [...args], {
      cwd: ROOT,
      // 屏蔽 node:sqlite 的实验性警告 —— 零依赖用内置能力是有意为之
      env: { ...process.env, NODE_OPTIONS: '--disable-warning=ExperimentalWarning' },
    })

    // ★ 交互式程序的验收就靠这里：把输入当成"用户在敲"，
    //   所以 repl.ts 必须用 line 事件而不是 question()（见它的文件头）。
    if (stdin !== undefined) {
      child.stdin.write(stdin)
      child.stdin.end()
    }

    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })

    child.on('close', (code) => {
      resolvePromise({
        name: args[args.length - 1] as string,
        code: code ?? 1,
        ms: Date.now() - started,
        output,
        tail: output.split('\n').slice(-6).join('\n'),
      })
    })
  })
}

/**
 * 一条命令能跑出预期输出才算通过 —— 只看退出码会让"什么都没跑"也通过。
 * @param result 子进程结果
 * @param mustContain 输出里必须出现的串（空数组表示不检查）
 * @returns 是否通过
 */
function passes(result: CheckResult, mustContain: readonly string[]): boolean {
  if (result.code !== 0) return false
  for (const needle of mustContain) {
    if (!result.output.includes(needle)) return false
  }
  return true
}

async function main(): Promise<void> {
  const demoDir = join(ROOT, 'src', 'demos')
  const demos = (await readdir(demoDir))
    .filter((name) => name.endsWith('.ts'))
    .sort()

  /** 每个 demo 至少要看到的一个"它确实跑到了结论"的标记。 */
  const expectations: Record<string, readonly string[]> = {
    'demo-llm.ts': ['演示'],
    'demo-tools.ts': ['演示'],
    'demo-context.ts': ['演示'],
    'demo-events.ts': ['演示'],
    'demo-scope.ts': ['所有容器已卸载'],
    'demo-loader.ts': ['生效的行'],
    'demo-session.ts': ['演示'],
    'demo-agent.ts': ['说明'],
    'demo-retry.ts': ['说明'],
    'demo-guard.ts': ['说明'],
    'demo-memory.ts': ['取走之后 pending 清空'],
    'demo-skills.ts': ['剩余技能'],
    'demo-recall.ts': ['结论与它的全部出处'],
    'demo-diagnose.ts': ['长度不一致被拒绝'],
    'demo-evolve.ts': ['回滚记录'],
    'demo-evolution-loop.ts': ['审计链校验'],
    'demo-modes.ts': ['同一份 profile、同一套内核', '这就是 PTC 的核心收益', '这个摩擦是有意的'],
  }

  console.log('======== 验收：逐条跑演示与端到端检查 ========\n')

  const results: { readonly label: string; readonly ok: boolean; readonly detail: string }[] = []

  for (const demo of demos) {
    const result = await run([join('src', 'demos', demo)])
    const ok = passes(result, expectations[demo] ?? [])
    results.push({ label: demo, ok, detail: `${result.ms} ms` })
    console.log(`${ok ? '✅' : '❌'} ${demo.padEnd(26)} ${result.ms} ms`)
    if (!ok) console.log(`   退出码 ${result.code}\n${result.tail.split('\n').map((line) => `   ${line}`).join('\n')}`)
  }

  // 端到端：CLI 的配置 dump 与一次真实任务
  const dump = await run([join('src', 'apps', 'cli.ts'), '--profile', join('profiles', 'evolution.json'), '--dump', '占位任务'])
  const dumpOk = passes(dump, ['生效的行', 'agent-loop', 'evolution'])
  results.push({ label: 'cli --dump（evolution profile）', ok: dumpOk, detail: `${dump.ms} ms` })
  console.log(`${dumpOk ? '✅' : '❌'} ${'cli --dump'.padEnd(26)} ${dump.ms} ms`)

  const task = await run([join('src', 'apps', 'cli.ts'), '--profile', join('profiles', 'evolution.json'), '读一下 README'])
  const taskOk = passes(task, ['complete', '这就是模型看到的全部'])
  results.push({ label: 'cli 任务（evolution profile）', ok: taskOk, detail: `${task.ms} ms` })
  console.log(`${taskOk ? '✅' : '❌'} ${'cli 任务'.padEnd(26)} ${task.ms} ms`)
  if (!taskOk) console.log(task.tail.split('\n').map((line) => `   ${line}`).join('\n'))

  // ── 对话框：多轮对话（输入从 stdin 灌进去，和真人敲键走同一条代码路径）──
  const repl = await run(
    [join('src', 'apps', 'repl.ts')],
    ['看看这个目录里有什么', '读一下 notes.txt', '今天天气怎么样', '/stats', '/exit'].join('\n') + '\n',
  )
  const replOk = passes(repl, ['助手 ›', '离线规则模式', '轮次='])
  results.push({ label: 'repl 对话框（4 轮）', ok: replOk, detail: `${repl.ms} ms` })
  console.log(`${replOk ? '✅' : '❌'} ${'repl 对话框'.padEnd(26)} ${repl.ms} ms`)
  if (!replOk) console.log(repl.tail.split('\n').map((line) => `   ${line}`).join('\n'))

  // ── Web GUI：起服务 → 探测三个端点 → 关掉 ──
  const web = await checkWebGui()
  results.push({ label: 'web GUI 冒烟', ok: web.ok, detail: web.detail })
  console.log(`${web.ok ? '✅' : '❌'} ${'web GUI'.padEnd(26)} ${web.detail}`)
  if (!web.ok) console.log(`   ${web.detail}`)

  // ── 模式系统：列出、装配、以及"模式真的改了装配" ──
  const modeList = await run([join('src', 'apps', 'cli.ts'), '--list-modes'])
  const modeListOk = passes(modeList, ['standard', 'ptc', 'minimal', 'creator', 'multi-agent'])
  results.push({ label: '模式列表', ok: modeListOk, detail: `${modeList.ms} ms` })
  console.log(`${modeListOk ? '✅' : '❌'} ${'模式列表'.padEnd(26)} ${modeList.ms} ms`)

  const minimalDump = await run([
    join('src', 'apps', 'cli.ts'), '--profile', join('profiles', 'chat.json'),
    '--mode', 'minimal', '--dump', '占位',
  ])
  // 最小模式必须**只剩** run_command，且 multi-agent 行被禁用 —— 这两条才是"模式生效"的证据
  const minimalOk =
    passes(minimalDump, ['"builtin":["run_command"]', '已禁用']) &&
    !minimalDump.output.includes('"builtin":["read_file"')
  results.push({ label: '模式改造装配（minimal）', ok: minimalOk, detail: `${minimalDump.ms} ms` })
  console.log(`${minimalOk ? '✅' : '❌'} ${'模式改造装配'.padEnd(26)} ${minimalDump.ms} ms`)
  if (!minimalOk) console.log(minimalDump.tail.split('\n').map((line) => `   ${line}`).join('\n'))

  const passed = results.filter((item) => item.ok).length
  console.log(`\n======== 汇总 ========`)
  console.log(`  ${passed}/${results.length} 项通过`)
  for (const item of results.filter((entry) => !entry.ok)) console.log(`  ✗ ${item.label}（${item.detail}）`)

  process.exitCode = passed === results.length ? 0 : 1
}

/**
 * Web GUI 冒烟测试：起服务、探端点、关服务。
 *
 * ★ 为什么必须自己起停，而不是"检查 HTML 文件存在"？★
 * 因为那种检查在 `web.ts` 真的崩了的时候照样通过 ——
 * 而"服务能起来、首页能返回、状态接口是合法 JSON"才是这个文件存在的意义。
 * @returns 结果
 */
async function checkWebGui(): Promise<{ readonly ok: boolean; readonly detail: string }> {
  const port = 8799
  const started = Date.now()
  const child = spawn(process.execPath, [join('src', 'apps', 'web.ts'), '--port', String(port)], {
    cwd: ROOT,
    env: { ...process.env, NODE_OPTIONS: '--disable-warning=ExperimentalWarning' },
  })

  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })

  try {
    // 轮询等它就绪（最多 10 秒）—— 比固定 sleep 更稳，机器慢也不会误报
    let ready = false
    for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
      await new Promise((r) => setTimeout(r, 250))
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/state`)
        ready = response.ok
      } catch {
        ready = false
      }
    }
    if (!ready) return { ok: false, detail: '服务 10 秒内没就绪' }

    const home = await fetch(`http://127.0.0.1:${port}/`)
    const html = await home.text()
    if (!home.ok || !html.includes('<title>dsh-mini')) {
      return { ok: false, detail: `首页异常：HTTP ${home.status}` }
    }

    const state = (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()) as { provider?: string }
    if (state.provider === undefined) return { ok: false, detail: '状态接口缺少 provider 字段' }

    return { ok: true, detail: `${Date.now() - started} ms（首页 ${html.length} 字节，provider=${state.provider}）` }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  } finally {
    child.kill()
  }
}

await main()

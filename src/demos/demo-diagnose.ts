/**
 * 第 15 步演示：失败归因 + 指标（Macro-F1 / Cohen's κ / 95% CI）。
 *
 * 运行：  node src/demos/demo-diagnose.ts
 */

import { Session } from '../kernel/session.ts'
import { classifyFailure, evaluate, featuresOf, FAILURE_COMPONENTS, interpretKappa } from '../evolution/diagnose.ts'
import type { FailureComponent, FailureFeatures } from '../evolution/diagnose.ts'

/** 打印结构化的东西。 */
function show(title: string, value: unknown): void {
  console.log(`\n--- ${title} ---`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

/** 造一个"跑了但失败"的会话，事件全部用真实的 append 写进去。 */
function buildSession(
  id: string,
  build: (session: Session) => void,
  toolFailures: string[] = [],
  codes: string[] = [],
  endReason: 'complete' | 'error' | 'max-steps' = 'complete',
): Session {
  const session = new Session(id)
  const turn = session.startTurn()
  session.recordUser('演示任务')

  for (const code of codes) {
    session.recordAttempt(1, code, `失败：${code}`)
  }

  const step = session.startStep()
  session.recordAssistant('', [{ id: 'call_1', name: toolFailures[0] ?? 'read_file', arguments: {}, rawArguments: '{}', parseError: '' }])

  for (const [index, name] of toolFailures.entries()) {
    session.recordToolCall(`call_${index + 1}`, name)
    session.recordToolResult(`call_${index + 1}`, name, '失败：路径不存在', true)
  }

  session.endStep(step)
  build(session)
  session.endTurn(turn, codes.length > 0 && endReason === 'complete' ? 'error' : endReason)
  return session
}

/** 造一条"守卫拒绝"的会话。 */
function guardSession(id: string): Session {
  const session = new Session(id)
  const turn = session.startTurn()
  session.recordUser('删除重要文件')
  const step = session.startStep()
  session.recordAssistant('', [{ id: 'call_1', name: 'delete_file', arguments: { path: 'important.txt' }, rawArguments: '{}', parseError: '' }])
  session.recordToolCall('call_1', 'delete_file')
  session.recordGuard('delete_file', 'deny', 'irreversibleGuard', '不可逆操作被拒绝')
  session.recordToolResult('call_1', 'delete_file', '操作被拒绝：不可逆操作', true)
  session.endStep(step)
  session.endTurn(turn, 'error')
  return session
}

async function main(): Promise<void> {
  // ==========================================================
  // 演示 1：四种典型失败的归因
  // ==========================================================
  console.log('======== 演示 1：规则归因（全部特征来自日志） ========')

  const cases: { readonly name: string; readonly session: Session; readonly gold: FailureComponent }[] = [
    {
      name: '工具参数写错',
      session: buildSession('d-tools', () => {}, ['read_file', 'read_file'], []),
      gold: 'tools',
    },
    {
      name: '守卫拒绝',
      session: guardSession('d-guard'),
      gold: 'guard',
    },
    {
      name: '步数用尽',
      session: buildSession('d-steps', (session) => {
        // 多走几步，让 steps 逼近上限
        for (let index = 0; index < 6; index += 1) {
          const step = session.startStep()
          session.recordAssistant('', [])
          session.endStep(step)
        }
      }, [], [], 'max-steps'),
      gold: 'agent-loop',
    },
    {
      name: 'AUTH 错误（不可重试）',
      session: buildSession('d-auth', () => {}, [], ['AUTH', 'AUTH']),
      gold: 'llm',
    },
  ]

  const gold: string[] = []
  const predicted: string[] = []

  for (const item of cases) {
    const features = featuresOf(item.session, 3)
    const diagnosis = classifyFailure(features)
    show(`案例：${item.name}`, {
      归因: diagnosis.component,
      人工标注: item.gold,
      是否一致: diagnosis.component === item.gold ? '✓' : '✗',
      理由: diagnosis.reason,
      证据: diagnosis.evidence,
      置信: diagnosis.confidence,
    })
    gold.push(item.gold)
    predicted.push(diagnosis.component)
  }

  // ==========================================================
  // 演示 2：扩展到 60 条标注，算 Macro-F1 与 κ
  // ==========================================================
  console.log('\n======== 演示 2：60 条标注上的指标 ========')

  // 用同样的四种场景扩样，并按已知规律注入少量"规则会答错"的边界情况，
  // 好让指标不是虚高的 1.0（真实的规则一定有边界）
  const samples: { readonly gold: FailureComponent; readonly session: Session }[] = []
  for (let index = 0; index < 14; index += 1) samples.push({ gold: 'tools', session: buildSession(`s-t-${index}`, () => {}, ['read_file'], []) })
  for (let index = 0; index < 10; index += 1) samples.push({ gold: 'guard', session: guardSession(`s-g-${index}`) })
  for (let index = 0; index < 12; index += 1) {
    samples.push({
      gold: 'agent-loop',
      session: buildSession(`s-s-${index}`, (session) => {
        for (let step = 0; step < 6; step += 1) {
          const inner = session.startStep()
          session.recordAssistant('', [])
          session.endStep(inner)
        }
      }, [], [], 'max-steps'),
    })
  }
  for (let index = 0; index < 8; index += 1) samples.push({ gold: 'llm', session: buildSession(`s-a-${index}`, () => {}, [], ['AUTH']) })

  // 边界情况：这一类规则归到 retry（可重试错误重试耗尽），而人工标为 llm
  for (let index = 0; index < 6; index += 1) {
    samples.push({ gold: 'llm', session: buildSession(`s-r-${index}`, () => {}, [], ['SERVER', 'SERVER']) })
  }
  // 边界情况：既有工具失败也有守卫拒绝，人工标 guard，规则也归 guard（一致）
  for (let index = 0; index < 5; index += 1) samples.push({ gold: 'guard', session: guardSession(`s-m-${index}`) })
  // 边界情况：什么都没留下 → unknown
  for (let index = 0; index < 5; index += 1) samples.push({ gold: 'unknown', session: buildSession(`s-u-${index}`, () => {}, [], []) })

  const sampleGold: string[] = []
  const samplePredicted: string[] = []
  for (const sample of samples) {
    sampleGold.push(sample.gold)
    samplePredicted.push(classifyFailure(featuresOf(sample.session, 8)).component)
  }

  const metrics = evaluate(sampleGold, samplePredicted)
  show('总体指标', {
    样本数: metrics.n,
    'Macro-F1': Number(metrics.macroF1.toFixed(4)),
    'Macro-F1 95% CI': metrics.macroF1CI.map((value) => Number(value.toFixed(4))),
    准确率: Number(metrics.accuracy.toFixed(4)),
    "Cohen's κ": Number(metrics.kappa.toFixed(4)),
    'κ 95% CI': metrics.kappaCI.map((value) => Number(value.toFixed(4))),
    判读: interpretKappa(metrics.kappa),
  })

  show('分类别指标', Object.fromEntries(
    Object.entries(metrics.perClass).map(([label, value]) => [label, {
      support: value.support,
      precision: Number(value.precision.toFixed(3)),
      recall: Number(value.recall.toFixed(3)),
      f1: Number(value.f1.toFixed(3)),
    }]),
  ))

  console.log('\n★ 为什么必须报 κ 而不只是准确率：')
  console.log(`  准确率 ${metrics.accuracy.toFixed(3)} 看着不错，但数据里 ${(sampleGold.filter((item) => item === 'unknown').length / sampleGold.length * 100).toFixed(0)}% 是 unknown ——`)
  console.log('  一个"永远猜 unknown"的傻分类器也能拿到一部分准确率。κ 扣掉了随机一致。')
  console.log(`  κ 的 95% CI 是 ${metrics.kappaCI.map((value) => value.toFixed(3)).join(' ~ ')}：区间宽说明样本还不够。`)

  // ==========================================================
  // 演示 3：可复现 —— 同一批数据两次评估结果完全一致
  // ==========================================================
  console.log('\n======== 演示 3：bootstrap 用固定种子，结果可复现 ========')
  const again = evaluate(sampleGold, samplePredicted)
  show('两次运行一致？', {
    第一次_κ: metrics.kappa,
    第二次_κ: again.kappa,
    'CI 相同': JSON.stringify(metrics.kappaCI) === JSON.stringify(again.kappaCI),
  })

  // ==========================================================
  // 演示 4：标签集合与长度校验
  // ==========================================================
  console.log('\n======== 演示 4：评分前先挡住"静默对齐" ========')
  show('可用的组件标签', FAILURE_COMPONENTS)
  try {
    evaluate(['tools'], ['tools', 'guard'])
  } catch (error) {
    show('长度不一致被拒绝', error instanceof Error ? error.message : String(error))
  }
}

await main()

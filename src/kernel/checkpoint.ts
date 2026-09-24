/**
 * 第 10 步 ｜ 检查点与回滚：让 B 类失败变成「可恢复」
 *
 * A/B/C 三分法里，B 类的判据是：
 *
 *     「失败发生时状态**已被改变**，但改变**可以被撤销**」
 *
 * 而模型**没有"撤销"这个动作** —— 它可以写信、可以重写，但它不记得
 * 自己刚才改了哪几个文件，于是"重来一遍"往往只是把现场搞得更乱。
 *
 * 这个文件提供模型缺的那个能力：**回到之前的某个状态**。
 *
 * ── 三个设计要点 ──────────────────────────────────────────────────────
 *
 * ① **快照保存内容，不是保存引用。**
 *    真正生产级系统会用 git / 事件溯源 / 文件系统快照。教学版直接存内容 ——
 *    简单、可读、能跑，代价是**大文件会吃内存**（这是本文件已知的缺陷，见文档 L9）。
 *
 * ② **回滚要"撤销新增"，不只是"还原修改"。**
 *    ★ 这是最容易漏的一点 ★ —— agent 犯错常常是**多创建了一个文件**，
 *    而不是改错了已有文件。只还原不删除的回滚，会让错误的痕迹留下来，
 *    而且下一次快照会把它当成"原本就有的"。
 *
 * ③ **哪些状态不该被回滚。** 本文件只碰 {@link WORKSPACE_IGNORES} 之外的文件。
 *    会话日志、检查点目录自身都不该回滚 —— 否则你会**失去"回滚过"这个事实**。
 *    这就是 error-taxonomy.md 里那个问题（"回滚时哪些状态该恢复、哪些不该"）
 *    的具体答案：**描述事实的载体不参与回滚，被描述的世界才参与。**
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** 不参与快照的目录名（在任意层级都跳过）。 */
export const WORKSPACE_IGNORES: readonly string[] = ['.git', '.checkpoints', 'node_modules', 'tmp']

/** 一个文件在快照时刻的样子。 */
export interface FileStamp {
  /** 相对工作目录的路径，用 `/` 分隔（跨平台一致）。 */
  readonly path: string
  /** 内容的 SHA-256 —— 用来快速判断"变没变"。 */
  readonly hash: string
  /** 内容本身。回滚时要靠它写回去。 */
  readonly content: string
}

/** 一个检查点：一组文件在某一时刻的样子。 */
export interface Checkpoint {
  /** 检查点 id，形如 `cp-3`。 */
  readonly id: string
  /** 做这个快照时是第几步。 */
  readonly step: number
  /** 快照时刻的文件集合。 */
  readonly files: readonly FileStamp[]
}

/** 一次回滚做了什么 —— 这份报告会回灌给模型。 */
export interface RollbackReport {
  /** 快照里有、后来被改坏了，已写回的文件。 */
  readonly restored: readonly string[]
  /** 快照里没有、后来被创建出来，已删除的文件。 */
  readonly removed: readonly string[]
  /** 从头到尾没变的文件数。 */
  readonly unchanged: number
}

/** 把路径统一成 `/` 分隔 —— 否则 Windows 上同一文件的两种写法会被当成两个。 */
function toPosix(path: string): string {
  return path.split(sep).join('/')
}

/** 内容摘要。 */
function hashOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * 递归列出工作目录里的所有文件（相对路径，`/` 分隔）。
 * @param root 工作目录的绝对路径
 * @returns 相对路径列表，已排序
 */
async function listWorkspaceFiles(root: string): Promise<string[]> {
  const found: string[] = []

  async function walk(absolute: string): Promise<void> {
    let entries
    try {
      entries = await readdir(absolute, { withFileTypes: true })
    } catch {
      // 目录不存在（还没创建）或没权限 —— 都当成"没有文件"
      return
    }

    for (const entry of entries) {
      if (WORKSPACE_IGNORES.includes(entry.name)) continue
      const childAbsolute = join(absolute, entry.name)
      if (entry.isDirectory()) {
        await walk(childAbsolute)
      } else if (entry.isFile()) {
        found.push(toPosix(relative(root, childAbsolute)))
      }
    }
  }

  await walk(root)
  return found.sort()
}

/**
 * 检查点仓库：给工作目录拍快照，并能在之后回滚到任意一张。
 *
 * 它**不属于工作目录的内容** —— 它观察工作目录。这个区别是设计要点 ③ 的基础。
 */
export class CheckpointStore {
  readonly #workspace: string
  readonly #checkpoints: Checkpoint[] = []
  #counter = 0

  /**
   * @param workspace 要观察的工作目录
   */
  constructor(workspace: string) {
    this.#workspace = resolve(workspace)
  }

  /** 已经拍了多少张快照。 */
  get size(): number {
    return this.#checkpoints.length
  }

  /** 按拍摄顺序列出所有快照。 */
  list(): readonly Checkpoint[] {
    return [...this.#checkpoints]
  }

  /**
   * 拍一张快照。
   * @param step 当前是第几步（记进快照，便于回滚时对齐轨迹）
   * @returns 新建的检查点
   */
  async snapshot(step: number): Promise<Checkpoint> {
    this.#counter += 1
    const files: FileStamp[] = []

    for (const path of await listWorkspaceFiles(this.#workspace)) {
      const content = await readFile(join(this.#workspace, path), 'utf8')
      files.push({ path, hash: hashOf(content), content })
    }

    const checkpoint: Checkpoint = { id: `cp-${this.#counter}`, step, files }
    this.#checkpoints.push(checkpoint)
    return checkpoint
  }

  /**
   * 回滚到指定快照。
   *
   * 做三件事，缺一不可：
   *   1. 快照里有、现在没了   → 写回去
   *   2. 快照里有、现在变了   → 写回去
   *   3. 快照里没有、现在有了 → **删掉**（设计要点 ②）
   * @param id 目标检查点的 id
   * @returns 这次回滚做了什么
   * @throws 找不到该 id 时
   */
  async rollback(id: string): Promise<RollbackReport> {
    const target = this.#checkpoints.find((checkpoint) => checkpoint.id === id)
    if (target === undefined) {
      const known = this.#checkpoints.map((checkpoint) => checkpoint.id).join(', ')
      throw new Error(`找不到检查点 "${id}"。现有：${known === '' ? '(无)' : known}`)
    }

    const before = new Map(target.files.map((file) => [file.path, file]))
    const now = new Set(await listWorkspaceFiles(this.#workspace))

    const restored: string[] = []
    const removed: string[] = []
    let unchanged = 0

    // 1 + 2：恢复
    for (const file of target.files) {
      const absolute = join(this.#workspace, file.path)
      if (!now.has(file.path)) {
        await mkdir(dirname(absolute), { recursive: true })
        await writeFile(absolute, file.content, 'utf8')
        restored.push(file.path)
        continue
      }
      const current = await readFile(absolute, 'utf8')
      if (hashOf(current) !== file.hash) {
        await writeFile(absolute, file.content, 'utf8')
        restored.push(file.path)
      } else {
        unchanged += 1
      }
    }

    // 3：撤销新增（设计要点 ②）
    for (const path of now) {
      if (before.has(path)) continue
      await rm(join(this.#workspace, path), { force: true })
      removed.push(path)
    }

    return { restored, removed, unchanged }
  }

  /**
   * 丢弃指定快照之后的所有快照。
   *
   * 为什么需要？回滚之后，那些"未来"的快照描述的是一个**已经不存在的世界**。
   * 留着它们，下次就可能滚到一个从未发生过的状态。
   * 这就是"回滚必须同时截断历史"—— 便宜且唯一正确的做法。
   * @param id 保留到哪个检查点（含它自己）
   */
  truncateAfter(id: string): void {
    const index = this.#checkpoints.findIndex((checkpoint) => checkpoint.id === id)
    if (index < 0) throw new Error(`找不到检查点 "${id}"`)
    this.#checkpoints.length = index + 1
  }

  /** 把回滚报告转成给模型看的文字。 */
  static describe(report: RollbackReport): string {
    const lines = [
      `已回滚工作区：恢复 ${report.restored.length} 个文件，删除 ${report.removed.length} 个文件，${report.unchanged} 个未变。`,
    ]
    if (report.restored.length > 0) lines.push(`- 恢复：${report.restored.join(', ')}`)
    if (report.removed.length > 0) lines.push(`- 删除：${report.removed.join(', ')}`)
    return lines.join('\n')
  }
}

/** 第 10 步里的路径常量：检查点目录名。 */
export const CHECKPOINT_DIR_NAME = '.checkpoints'

/** 计算检查点目录的绝对路径。 */
export function checkpointDirOf(workspace: string): string {
  return join(resolve(workspace), CHECKPOINT_DIR_NAME)
}

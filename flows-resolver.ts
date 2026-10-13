// 解析本仓 flows/ 流程定义目录（维护者与用户统一入口）。
//
// 唯一编辑源是 jeeflow-java 仓的 test/resources/flows/。本仓 flows/ 是其副本，
// 入库 commit（单语言用户下载即用，不依赖隔壁 Java 仓）。
//
// dir() 的语义：
//   1. 环境变量 JEEFLOW_FLOWS_DIR 显式覆盖（容器/特殊部署）
//   2. 否则从当前工作目录向上找第一个含 flows/（且有 .json）的目录 = 本仓根
//   3. 若本仓根的兄弟目录里有 Java 源（维护者机器）→ 精确镜像进本仓 flows/
//      （拷贝所有 .json + 删除本仓多出的孤儿 .json，防 id 按文件名排序错位）
//   4. 始终返回本仓 flows/ 路径 —— 所有读取点只读这里，Java 仓不再被直接读取
//
// 放仓根（package.json files 只打包 dist，不进 npm 包）：demo 与 __tests__ 共用。

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync, rmSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'

// java 源目录相对本仓根的位置（jeeflow-java 与本仓是 jeeflow-hub 下的兄弟目录）
const JAVA_FLOWS_REL = join('..', 'jeeflow-java', 'jeeflow-core', 'src', 'test', 'resources', 'flows')

let _cached: string | null = null

/** 返回本仓 flows/ 绝对路径；维护者机器上会先把 Java 源精确镜像进来。 */
export function dir(): string {
  const env = process.env.JEEFLOW_FLOWS_DIR
  if (env) return env
  const root = findFlowsRoot(process.cwd())
  if (!root) throw new Error(`flows-resolver: no flows/ directory found from ${process.cwd()}`)
  mirror(root)
  if (!_cached) _cached = join(root, 'flows')
  return _cached
}

function findFlowsRoot(start: string): string | null {
  let d = start
  for (;;) {
    if (hasFlows(d)) return d
    const parent = dirname(d)
    if (parent === d) return null // 到文件系统顶
    d = parent
  }
}

function hasFlows(d: string): boolean {
  const fdir = join(d, 'flows')
  try {
    return readdirSync(fdir).some((f) => f.endsWith('.json'))
  } catch {
    return false
  }
}

/** 若 Java 源存在则精确镜像到本仓 flows/（拷所有 + 删孤儿），不存在则原样返回。导出仅供 issues/187 的工装用例铺临时树。 */
export function mirror(root: string): void {
  const src = join(root, JAVA_FLOWS_REL)
  const dst = join(root, 'flows')
  if (!existsSync(src) || !statSync(src).isDirectory()) return // 用户单仓 / 容器：无 Java 源，跳过镜像
  const srcNames = new Set<string>()
  for (const f of readdirSync(src)) {
    if (!f.endsWith('.json')) continue
    srcNames.add(f)
    writeAtomic(join(dst, f), readFileSync(join(src, f)))
  }
  // 孤儿清理：本仓有、Java 源已无的 .json（防 id 错位）。临时件名不以 .json 结尾，不在此面。
  for (const f of readdirSync(dst)) {
    if (f.endsWith('.json') && !srcNames.has(f)) rmSync(join(dst, f))
  }
}

const RENAME_RETRY = 100
const RENAME_RETRY_MS = 10

function writeAtomic(target: string, data: Buffer): void {
  // 稳态零写：内容逐字节相同就不动盘 ⇒ 绝大多数测试轮里镜像整腿零写入，读者无从撞窗口。
  try {
    if (readFileSync(target).equals(data)) return
  } catch {
    /* 目标还不存在（或正被别的进程持有）：走写入腿 */
  }
  const tmp = `${target}.tmp.${process.pid}` // 名带 pid ⇒ 并发进程互不覆写同一条临时件
  for (let attempt = 0; ; attempt++) {
    writeFileSync(tmp, data)
    try {
      renameSync(tmp, target) // 同目录 rename 对读者是原子的：只会看到旧件或新件，看不到半截
      return
    } catch (e) {
      // Windows：libuv 开文件不带 FILE_SHARE_DELETE，读者正持句柄时 rename 报 EPERM，重试即可。
      if (attempt >= RENAME_RETRY) {
        rmSync(tmp, { force: true })
        throw new Error(`flows-resolver: 镜像 ${target} 失败（重试 ${RENAME_RETRY} 次）: ${String(e)}`)
      }
      sleepMs(RENAME_RETRY_MS)
    }
  }
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

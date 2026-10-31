/**
 * 「退回修改、重提直返」——分支归属与直返上下文（Node 栈）。
 *
 * 状态落点与 Java/Go/Python 参考实现一致：零 DDL，全部寄存在任务变量保留键里
 * （spec 04-engine-ops「退回修改、重提直返」）。
 */
import { KeyNextNodeOperator, KeySubmitType } from './engine.js'
import { SubmitType, TaskState, TypeCustom, TypeFork, TypeJoin, TypeStart, TypeTask } from './model.js'

export const PROP_REAPPLY_MODE = 'reapplyMode'
export const VAR_BRANCH_CTX = '_branchCtx'
export const VAR_REAPPLY_CTX = '_reapplyContext'
export const NORMAL = 'NORMAL'
export const RETURN_TO_SOURCE = 'RETURN_TO_SOURCE'

export interface BranchScope { fork: string; join: string; round: string; root: string }

const locks = new Map<string, Promise<void>>()

/** 同实例串行化（进程内 promise 链）。多进程部署需仓储侧提供跨进程锁。 */
export async function withInstanceLock<T>(engine: any, instanceId: string | undefined, fn: () => Promise<T>): Promise<T> {
  const key = `${String((engine as any).__rjId ??= Math.random())}:${instanceId || '0'}`
  const prev = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(res => { release = res })
  locks.set(key, prev.then(() => gate))
  await prev
  try {
    return await fn()
  } finally {
    release()
    if (locks.get(key) === gate) locks.delete(key)
  }
}

export function parseMode(node: any): string {
  const raw = String(node?.properties?.[PROP_REAPPLY_MODE] ?? '').trim()
  if (raw === '' || raw === NORMAL) return NORMAL
  if (raw === RETURN_TO_SOURCE) return RETURN_TO_SOURCE
  throw new Error(`节点[${node?.id}]的 reapplyMode 配置非法: ${raw}`)
}

export function stripReserved(args: Record<string, any> | undefined): Record<string, any> {
  const out = { ...(args ?? {}) }
  delete out[VAR_BRANCH_CTX]
  delete out[VAR_REAPPLY_CTX]
  return out
}

// ─── 模型静态分析 ────────────────────────────────────────────────────────────

function incoming(flow: any, nodeId: string): string[] {
  return flow.edges.filter((e: any) => e.targetNodeId === nodeId).map((e: any) => e.sourceNodeId)
}

function outgoing(flow: any, nodeId: string): string[] {
  return flow.edges.filter((e: any) => e.sourceNodeId === nodeId).map((e: any) => e.targetNodeId)
}

/**
 * 沿入边回溯到指定分叉之间的任务集合；可穿过嵌套的内层 fork，遇到 stopFork 即止。
 */
function backwardTaskIds(flow: any, nodeId: string, stopFork = ''): Set<string> {
  const out = new Set<string>()
  const stack = incoming(flow, nodeId)
  const visited = new Set<string>()
  const byId = new Map<string, any>(flow.nodes.map((n: any) => [n.id, n]))
  while (stack.length) {
    const cur = stack.pop()!
    if (!cur || visited.has(cur)) continue
    visited.add(cur)
    const n = byId.get(cur)
    if (!n) continue
    if (n.type === TypeFork && cur === stopFork) continue
    if (n.type === TypeTask || n.type === TypeCustom) out.add(cur)
    stack.push(...incoming(flow, cur))
  }
  return out
}

/**
 * 汇合点对应的分叉：取「最近后支配汇合点 === 本 join」的 fork，多候选取最外层。
 * 不能取"回溯遇到的第一个 fork"——嵌套并行时外层汇合点沿内层分支回溯会先撞到内层 fork。
 */
function forkForJoin(flow: any, joinId: string): string {
  let best = ''
  let bestDepth = -1
  for (const n of flow.nodes) {
    if (n.type !== TypeFork) continue
    if (nearestPostDominatingJoin(flow, n.id) !== joinId) continue
    const d = maxDistanceToJoin(flow, n.id, joinId)
    if (d > bestDepth) {
      bestDepth = d
      best = n.id
    }
  }
  return best
}

function nearestPostDominatingJoin(flow: any, forkId: string): string {
  let best = ''
  let bestMax = -1
  for (const n of flow.nodes) {
    if (n.type !== TypeJoin) continue
    if (!postDominates(flow, forkId, n.id)) continue
    const d = maxDistanceToJoin(flow, forkId, n.id)
    if (d >= 0 && (bestMax < 0 || d < bestMax)) {
      bestMax = d
      best = n.id
    }
  }
  return best
}

/** 屏蔽该汇合点后，fork 的任一分支仍能走到末端即不成立 */
function postDominates(flow: any, forkId: string, joinId: string): boolean {
  const stack = outgoing(flow, forkId)
  const visited = new Set<string>()
  while (stack.length) {
    const cur = stack.pop()!
    if (!cur || cur === joinId || visited.has(cur)) continue
    visited.add(cur)
    const outs = outgoing(flow, cur)
    if (!outs.length) return false
    stack.push(...outs)
  }
  return true
}

function maxDistanceToJoin(flow: any, forkId: string, joinId: string): number {
  let frontier = Array.from(new Set(outgoing(flow, forkId)))
  const visited = new Set(frontier)
  let d = 1
  let found = -1
  while (frontier.length) {
    const next: string[] = []
    for (const cur of frontier) {
      if (cur === joinId) found = d
      for (const t of outgoing(flow, cur)) {
        if (!visited.has(t)) {
          visited.add(t)
          next.push(t)
        }
      }
    }
    frontier = next
    d++
  }
  return found
}

export function staticScopes(flow: any, nodeId: string): BranchScope[] {
  const hits: Array<{ size: number; scope: BranchScope }> = []
  for (const n of flow.nodes) {
    if (n.type !== TypeJoin) continue
    const fork = forkForJoin(flow, n.id)
    if (!fork) continue
    const inside = backwardTaskIds(flow, n.id, fork)
    if (!inside.has(nodeId)) continue
    hits.push({ size: inside.size, scope: { fork, join: n.id, round: '0', root: '0' } })
  }
  hits.sort((a, b) => b.size - a.size)
  return hits.map(h => h.scope)
}

export function buildScopes(flow: any, nodeId: string, parentVars: Record<string, any> | undefined,
                            parentId: string, selfId: string): BranchScope[] {
  const statics = staticScopes(flow, nodeId)
  const parentScopes = scopesOf(parentVars)
  return statics.map(s => {
    const inherited = parentScopes.find(p => p.fork === s.fork && p.join === s.join)
    return inherited
      ? { fork: s.fork, join: s.join, round: inherited.round, root: inherited.root }
      : { fork: s.fork, join: s.join, round: parentId, root: selfId }
  })
}

// ─── 变量读写 ────────────────────────────────────────────────────────────────

export function scopesOf(vars: Record<string, any> | undefined): BranchScope[] {
  const raw = vars?.[VAR_BRANCH_CTX]
  if (!Array.isArray(raw)) return []
  return raw.filter((x: any) => x && typeof x === 'object').map((x: any) => ({
    fork: String(x.fork ?? ''), join: String(x.join ?? ''),
    round: String(x.round ?? '0'), root: String(x.root ?? '0'),
  }))
}

export function reapplyOf(vars: Record<string, any> | undefined): Record<string, any> | undefined {
  const raw = vars?.[VAR_REAPPLY_CTX]
  return raw && typeof raw === 'object' && Object.keys(raw).length ? raw : undefined
}

export function branchOf(rc: Record<string, any> | undefined): BranchScope[] {
  if (!rc) return []
  return scopesOf({ [VAR_BRANCH_CTX]: rc.branch })
}

export function findScope(scopes: BranchScope[], joinId: string): BranchScope | undefined {
  return scopes.find(s => s.join === joinId)
}

export function newContext(sourceTaskId: string, sourceNode: string, branch: BranchScope[]): Record<string, any> {
  return { mode: RETURN_TO_SOURCE, sourceTaskId: String(sourceTaskId), sourceNode, branch: branch ?? [] }
}

// ─── 引擎侧适配 ──────────────────────────────────────────────────────────────

/** 建单钩子：给本次新任务补分支归属（父任务在聚合内按 ID 查）。 */
export async function attachCreated(engine: any, flow: any, inst: any, created: any[],
                                    nodeId: string, parentId: string): Promise<void> {
  if (!created.length) return
  const parent = (inst.tasks ?? []).find((t: any) => t.id === parentId)
  for (const nt of created) {
    nt.variables = nt.variables ?? {}
    nt.variables[VAR_BRANCH_CTX] = buildScopes(flow, nodeId, parent?.variables, parentId, nt.id)
    await engine.repo.updateTask(nt)
  }
}

export async function mergeReady(engine: any, flow: any, inst: any, joinId: string, arrivingId: string): Promise<boolean> {
  const arriving = (inst.tasks ?? []).find((t: any) => t.id === arrivingId)
  const scope = arriving ? findScope(scopesOf(arriving.variables), joinId) : undefined
  if (!scope) return (await engine.repo.findDoingTasks(inst.id)).length === 0
  const roots = new Map<string, boolean>()
  for (const t of inst.tasks ?? []) {
    const s = findScope(scopesOf(t.variables), joinId)
    const inRound = !!s && s.fork === scope.fork && s.round === scope.round
    if (inRound && !roots.has(s!.root)) roots.set(s!.root, false)
    if (t.taskState !== TaskState.Doing) continue
    if (inRound) roots.set(s!.root, true)
    for (const b of branchOf(reapplyOf(t.variables))) {
      if (b.join === joinId && b.fork === scope.fork && b.round === scope.round) roots.set(b.root, true)
    }
  }
  if (!roots.size) return (await engine.repo.findDoingTasks(inst.id)).length === 0
  return ![...roots.values()].some(Boolean)
}

async function createTaskAt(engine: any, flow: any, node: any, inst: any, operator: string,
                            vars: Record<string, any>, parentId: string,
                            scopes: BranchScope[], rc: Record<string, any> | undefined): Promise<void> {
  const sink: any[] | undefined = engine.createdScope?.getStore?.()
  const before = sink ? sink.length : 0
  const pn = await engine.surrogateProcessName(flow, inst)
  await engine.createTask(node, inst, operator, vars, pn, parentId, engine.isFirstTaskNode(flow, node))
  const created = sink ? sink.slice(before) : []
  for (const nt of created) {
    nt.variables = nt.variables ?? {}
    nt.variables[VAR_BRANCH_CTX] = scopes ?? []
    if (rc) nt.variables[VAR_REAPPLY_CTX] = rc
    await engine.repo.updateTask(nt)
  }
}

export async function executeReapply(engine: any, task: any, operator: string, args: Record<string, any>): Promise<any> {
  const st = args[KeySubmitType]
  if (st != null && Number(st) !== Number(SubmitType.ReApply)) {
    throw new Error('带重提直返标记的申请待办只接受重新提交(submitType=5)')
  }
  const inst = await engine.repo.findInstanceById(task.processInstanceId)
  if (!inst) throw new Error('流程实例不存在')
  const def = await engine.repo.findDefineById(inst.defineId)
  const flow = JSON.parse(typeof def.content === 'string' ? def.content : new TextDecoder().decode(def.content))
  const rc = reapplyOf(task.variables)!
  const sourceId = String(rc.sourceTaskId ?? '')
  const source = (inst.tasks ?? []).find((t: any) => t.id === sourceId)
  if (!source || source.taskState !== TaskState.Done || source.processInstanceId !== inst.id) {
    throw new Error('重提直返来源任务无效或未完成')
  }
  const sourceNode = flow.nodes.find((n: any) => n.id === source.taskName)
  if (!sourceNode || sourceNode.type !== TypeTask || parseMode(sourceNode) !== RETURN_TO_SOURCE) {
    throw new Error('重提直返来源节点配置已变更，拒绝执行')
  }
  const applyNode = flow.nodes.find((n: any) => n.id === task.taskName)
  if (!applyNode || !engine.isFirstTaskNode(flow, applyNode)) {
    throw new Error('重提直返必须从申请待办发起')
  }
  const prepared = await engine.prepareExecuteTask(task.id, operator, args)
  const vars = prepared.vars
  delete vars[KeyNextNodeOperator]
  await createTaskAt(engine, flow, sourceNode, prepared.inst, operator, vars, task.id, branchOf(rc), undefined)
  return await engine.repo.findInstanceById(prepared.inst.id)
}

export { createTaskAt }

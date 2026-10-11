import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EngineImpl } from '../src/engine.js'
import { MemoryRepository } from '../src/memory.js'
import { MemoryExtRepository } from '../src/memory-ext.js'
import { JeeflowFacade } from '../src/facade.js'
import type { ExpressionEvaluator, UserProvider } from '../src/spi.js'
import { dir as flowsResolverDir } from '../flows-resolver.js'

/**
 * issues/162 的 node 腿判据（audit8 队列 R7 记账口径：**随下一次触及该栈的发版轮逐栈带**，
 * node 的搭车人点名含 R3；判据形状照 162 §6.1 的 go v1.8.43 那枚）。
 *
 * 口径＝**保留降级面＋落一条可诊断日志**（156/160 两例同法）：坏定义只许降级模型补全腿
 * （边集 / 节点补全 / nodeProgress；实例与任务行不受影响、对外仍 code=0），但不再
 * 一声不吭地吞掉（旧形状是一个空的 catch 块）——这条静默通道先后藏住过 156（php）与
 * 160（python）两个真分叉。
 *
 * 判据两向（各起新栈，互相遮不住）：
 * ① 坏定义 ⇒ code=0＋边集空＋nodeProgress 空对象＋活跃任务行仍是 task1＋**日志真拿到**
 *   （console.error 捕获；三件齐：instanceId=/defineId=<真号>/err=）；
 * ② 好定义 ⇒ 补全腿产出非空边集（夹具自证）＋**不得出现该 WARN**（证明它挂在失败支上，
 *   不是每次高亮都刷屏）。
 */

const flowDir = flowsResolverDir() + '/'

const userProv: UserProvider = {
  async getUser(userId) {
    return { userId, realName: '用户' + userId, deptId: 'D01', deptName: '测试部门', postId: 'P01', postName: '测试岗位' }
  },
}
const exprEval: ExpressionEvaluator = {
  async eval(expr, vars) {
    const amt = Number(vars.amount ?? 0)
    if (expr === 'amount > 1000') return amt > 1000
    if (expr === 'amount <= 1000') return amt <= 1000
    return false
  },
}

function mkSeqIdGen() {
  const base = Date.now() * 1000
  let n = 0
  return { nextId() { n += 1; return String(base + n) } }
}

function setup() {
  const repo = new MemoryRepository()
  const engine = new EngineImpl(repo, userProv, mkSeqIdGen(), exprEval)
  const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
  return { engine, repo, facade }
}

/** console.error 捕获（与 137 测试同款取证口）；用完必须 restore，别污染别的格 */
function captureError(): { calls: any[][]; restore(): void } {
  const calls: any[][] = []
  const orig = console.error
  console.error = (...a: any[]) => { calls.push(a) }
  return { calls, restore() { console.error = orig } }
}

function logged(calls: any[][]): string {
  return calls.map(a => a.map(x => (x instanceof Error ? `${x.name}: ${x.message}` : String(x))).join(' ')).join('\n')
}

/** 起一单 01-simple（startAndExecute 自动跑完 apply ⇒ 停在 task1）；broken=true 时把定义 content 换成坏 JSON。 */
async function setupBroken(broken: boolean) {
  const { facade, repo } = setup()
  const content = readFileSync(flowDir + '01-simple.json', 'utf-8')
  const r0 = await facade.flow('processDefine/deploy', { content })
  assert.equal(r0.code, 0, JSON.stringify(r0))
  const defineId = String(r0.data.processDefineId)
  const r1 = await facade.flow('processInstance/startAndExecute',
    { processDefineId: defineId, operator: 'zhangsan' })
  assert.equal(r1.code, 0, JSON.stringify(r1))
  const instanceId = String(r1.data.processInstanceId)
  if (broken) {
    const def = await repo.findDefineById(defineId)
    assert.ok(def, '前置：定义取得到')
    def!.content = '{"cells": [ 这是坏 JSON'
    await repo.saveDefine(def!)
  }
  return { facade, repo, instanceId, defineId }
}

describe('issues/162 · highLight 模型补全腿降级必须留日志（node 腿）', () => {

  it('① 坏定义 ⇒ 对外仍 code=0、边集/进度留空、任务行照旧，且日志真拿到（三件齐）', async () => {
    const { facade, instanceId, defineId } = await setupBroken(true)
    const cap = captureError()
    let r: any
    try {
      r = await facade.flow('processInstance/highLight', { id: instanceId })
    } finally { cap.restore() }

    assert.equal(r.code, 0, `162 口径＝降级面保留（坏定义不该让整条 highLight 变红）：${JSON.stringify(r)}`)
    const hl = r.data
    assert.deepEqual(hl.historyEdgeNames, [], '降级档边集应为空')
    assert.deepEqual(Object.keys(hl.nodeProgress ?? {}), [], '降级档 nodeProgress 应为空对象')
    assert.ok((hl.activeNodeNames ?? []).includes('task1'),
      `降级只许影响模型补全腿，活跃任务行仍须是 task1，实得 ${JSON.stringify(hl.activeNodeNames)}`)

    const out = logged(cap.calls)
    assert.ok(out.includes('模型补全腿解码失败'),
      `降级必须落一条可诊断日志（静默通道就是本案要收的那条），实得 ${JSON.stringify(out)}`)
    assert.ok(out.includes(`instanceId=${instanceId}`) && out.includes(`defineId=${defineId}`) && out.includes('err='),
      `日志要带可归因的三件（实例/定义号取对/原因，缺一件等于没落），实得 ${JSON.stringify(out)}（defineId=${defineId}）`)
  })

  it('② 好定义 ⇒ 补全腿产出非空边集，且不得出现该 WARN（挂在失败支上，不是每次高亮都刷屏）', async () => {
    const { facade, instanceId } = await setupBroken(false)
    const cap = captureError()
    let r: any
    try {
      r = await facade.flow('processInstance/highLight', { id: instanceId })
    } finally { cap.restore() }

    assert.equal(r.code, 0, JSON.stringify(r))
    assert.ok((r.data.historyEdgeNames ?? []).length > 0,
      `好定义下补全腿应产出边集（本用例若空＝夹具没走到模型腿，②档自证失效）：${JSON.stringify(r.data.historyEdgeNames)}`)
    assert.ok(!logged(cap.calls).includes('模型补全腿解码失败'),
      `正常路径不该出现降级日志：${JSON.stringify(logged(cap.calls))}`)
  })
})

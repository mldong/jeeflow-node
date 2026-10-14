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
 * issues/201（audit8 队列 R79·owner 拍 C＝只统一「求值器自身抛异常必须落可诊断日志」，
 * 遍历宽度不钉）的 node 腿判据。
 *
 * 修前形状＝`evalDecisionExpr` 的 `catch { return false }`：求值失败被折成「这条分支求值为假」
 * ⇒ 与合法判假在对外读数上完全同形、且零线索（本栈 162 腿已给解码失败那条落了 WARN，
 * 这条是同一族里的第二条静默腿）。本栈宽度维持折 false（该边不收、其余边继续遍历）。
 *
 * 三枚判据分工＝①失败⇒有日志且归因齐；③合法判假⇒**不许**有日志（两档必须分得开，
 * 否则 WARN 会变成每次高亮都刷屏）；②正常⇒零日志且边集真产出 e3（阳性对照，
 * 防夹具根本没走到决策腿就自证绿）。
 */

const flowDir = flowsResolverDir() + '/'

const userProv: UserProvider = {
  async getUser(userId) {
    return { userId, realName: '用户' + userId, deptId: 'D01', deptName: '测试部门', postId: 'P01', postName: '测试岗位' }
  },
}

/** 三档求值器（正常／合法判假／抛错）——建单与办公固定走正常档，切档只发生在 highLight 之前 */
function mkEval() {
  const st = { fail: false, allFalse: false }
  const ev: ExpressionEvaluator = {
    async eval(expr, vars) {
      if (st.fail) throw new Error(`i201 夹具注入的求值失败（expr=${expr}）`)
      if (st.allFalse) return false
      const amt = Number(vars.amount ?? 0)
      if (expr === 'amount > 1000') return amt > 1000
      if (expr === 'amount <= 1000') return amt <= 1000
      return false
    },
  }
  return { st, ev }
}

function mkSeqIdGen() {
  const base = Date.now() * 1000
  let n = 0
  return { nextId() { n += 1; return String(base + n) } }
}

/** 夹具＝03-decision-expr.json：start → apply → task1 → decision1 →(e3 amount>1000 → task2 / e4 → task3) → end */
async function setupStopped() {
  const { st, ev } = mkEval()
  const repo = new MemoryRepository()
  const engine = new EngineImpl(repo, userProv, mkSeqIdGen(), ev)
  const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())

  const r0 = await facade.flow('processDefine/deploy', { content: readFileSync(flowDir + '03-decision-expr.json', 'utf-8') })
  assert.equal(r0.code, 0, JSON.stringify(r0))
  const defineId = String(r0.data.processDefineId)
  const r1 = await facade.flow('processInstance/startAndExecute',
    { processDefineId: defineId, operator: 'zhangsan', amount: 5000 })
  assert.equal(r1.code, 0, JSON.stringify(r1))
  const instanceId = String(r1.data.processInstanceId)

  for (const t of await repo.findDoingTasks(instanceId)) {
    if (t.taskName !== 'task1') continue
    await repo.addTaskActor(t.id, ['leader'])
    const r2 = await facade.flow('processTask/execute', { processTaskId: t.id, operator: 'leader', submitType: 1 })
    assert.equal(r2.code, 0, JSON.stringify(r2))
  }
  // 夹具形状自证：必须停在 task2 活跃，否则递归到不了 decision1 的两条出边（②③档恒真）
  const doing = await repo.findDoingTasks(instanceId)
  assert.deepEqual(doing.map(t => t.taskName), ['task2'], `夹具应停在 task2 活跃：${JSON.stringify(doing)}`)
  return { facade, instanceId, defineId, st }
}

/** console.error 捕获（与 162 测试同款取证口）；用完必须 restore，别污染别的格 */
function captureError(): { calls: any[][]; restore(): void } {
  const calls: any[][] = []
  const orig = console.error
  console.error = (...a: any[]) => { calls.push(a) }
  return { calls, restore() { console.error = orig } }
}

function logged(calls: any[][]): string {
  return calls.map(a => a.map(x => (x instanceof Error ? `${x.name}: ${x.message}` : String(x))).join(' ')).join('\n')
}

async function highLight(facade: JeeflowFacade, instanceId: string) {
  const cap = captureError()
  let r: any
  try {
    r = await facade.flow('processInstance/highLight', { id: instanceId })
  } finally { cap.restore() }
  assert.equal(r.code, 0, `拍 C 口径＝降级面保留，求值失败只许留痕不许变红：${JSON.stringify(r)}`)
  return { hl: r.data, out: logged(cap.calls) }
}

describe('issues/201 · highLight 决策边求值失败必须留日志（node 腿）', () => {

  it('① 求值器抛错 ⇒ 落一条可归因 WARN（实例/定义号＋节点＋表达式＋原因），边集按 false 不收', async () => {
    const { facade, instanceId, defineId, st } = await setupStopped()
    st.fail = true
    const { hl, out } = await highLight(facade, instanceId)

    assert.ok(out.includes('决策边表达式求值失败'),
      `求值失败必须落一条可诊断日志（静默通道就是本案要收的那条），实得 ${JSON.stringify(out)}`)
    for (const piece of [`instanceId=${instanceId}`, `defineId=${defineId}`, 'nodeId=decision1', 'expr=', 'err=']) {
      assert.ok(out.includes(piece), `日志缺归因件 ${JSON.stringify(piece)}（缺一件等于没落），实得 ${JSON.stringify(out)}`)
    }
    // 拍 C 不钉宽度＝本栈维持修前形状（折 false）；边若收了说明行为被顺手改了
    assert.ok(!hl.historyEdgeNames.includes('e3') && !hl.historyEdgeNames.includes('e4'),
      `本栈宽度＝求值失败按 false 处理，e3/e4 都不该收，实得 ${JSON.stringify(hl.historyEdgeNames)}`)
    assert.ok(hl.activeNodeNames.includes('task2'),
      `失败只许影响模型补全腿，活跃任务行仍须是 task2，实得 ${JSON.stringify(hl.activeNodeNames)}`)
  })

  it('② 求值器正常 ⇒ 零求值失败日志，且边集真产出 e3（阳性对照：夹具确走的是决策腿）', async () => {
    const { facade, instanceId } = await setupStopped()
    const { hl, out } = await highLight(facade, instanceId)

    assert.ok(!out.includes('决策边表达式求值失败'), `正常路径不该出现求值失败日志：${JSON.stringify(out)}`)
    assert.ok(hl.historyEdgeNames.includes('e3'),
      `夹具未走到决策边求值（本用例自证失效），期望收 e3，实得 ${JSON.stringify(hl.historyEdgeNames)}`)
  })

  it('③ 求值器合法判假（返回 false、不抛）⇒ 同样不收 e3，但不许落求值失败日志', async () => {
    const { facade, instanceId, st } = await setupStopped()
    st.allFalse = true
    const { hl, out } = await highLight(facade, instanceId)

    assert.ok(!out.includes('决策边表达式求值失败'),
      `合法判假不是失败，不该落日志（本案只统一"失败必留痕"）：${JSON.stringify(out)}`)
    assert.ok(!hl.historyEdgeNames.includes('e3'),
      `判假档 e3 不该收（夹具自证），实得 ${JSON.stringify(hl.historyEdgeNames)}`)
  })
})

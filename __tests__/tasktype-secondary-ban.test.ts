/**
 * 节点级 taskType=1（协办）解析期禁配（issues/252，规范 02 §4.4）——Node 腿。
 *
 * 正向：折成 SECONDARY 的全部输入形（1／"1"／"协办"／"SECONDARY"，大小写不敏感——
 * 本栈无既有 taskType 容错表，判定照 isCountersign 同尺）解析期报错、逐字文案、零写入；
 * 回归：0／"Major"／缺省／未知值 "Aidant" 仍解析成功且建单回落主办 taskType=0
 * （issues/245 口径不变，不扩成 fail-fast）；custom 记录节点历史行形状不变（缺省 0）。
 *
 * 夹具内联 JSON，不碰共享 flows/ 目录（同 dynamic-countersign.test.ts 纪律）。
 */
import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { EngineImpl, KeySubmitType } from '../src/engine.js'
import { checkFlowConfig } from '../src/addsign.js'
import { MemoryRepository } from '../src/memory.js'
import { SubmitType, TaskState, type ProcessDefine } from '../src/model.js'
import type { ExpressionEvaluator, UserProvider } from '../src/spi.js'

const APPLY = SubmitType.Apply
const MSG = '节点[review]不允许配置协办任务类型（taskType=1）'

function setup() {
  const repo = new MemoryRepository()
  const userProv: UserProvider = {
    async getUser(userId: string) {
      return { userId, realName: '用户' + userId, deptId: 'D01', deptName: '测试部门', postId: 'P01', postName: '测试岗位' }
    },
  }
  const base = Date.now() * 1000
  let n = 0
  const idGen = { nextId() { n += 1; return String(base + n) } }
  const exprEval: ExpressionEvaluator = { async eval() { return false } }
  const engine = new EngineImpl(repo, userProv, idGen as any, exprEval)
  return { engine, repo }
}

// ─── 夹具 ─────────────────────────────────────────────────────────────────────

const nodeOf = (id: string, type: string, props: Record<string, any>, text: string) =>
  ({ id, type, x: 0, y: 0, properties: props, text: { value: text } })
const edgeOf = (id: string, from: string, to: string) =>
  ({ id, type: 'snaker:transition', sourceNodeId: from, targetNodeId: to, properties: {} })

let seq = 0
/** start → apply → review → final → end；reviewProps 控制 review 节点 taskType 等（空对象＝缺省键）。 */
function chain(reviewProps: Record<string, any>): string {
  return JSON.stringify({
    name: `tt252-${++seq}`, displayName: '协办禁配夹具', type: 'approval',
    nodes: [
      nodeOf('start', 'snaker:start', {}, '开始'),
      nodeOf('apply', 'snaker:task', { form: 'apply-form', assignee: 'applicant', taskType: 0, performType: 0 }, '发起申请'),
      nodeOf('review', 'snaker:task', { form: 'form-r', assignee: 'userA', performType: 0, ...reviewProps }, '审批'),
      nodeOf('final', 'snaker:task', { form: 'form-f', assignee: 'userF', taskType: 0, performType: 0 }, '终审'),
      nodeOf('end', 'snaker:end', {}, '结束'),
    ],
    edges: [edgeOf('e1', 'start', 'apply'), edgeOf('e2', 'apply', 'review'),
      edgeOf('e3', 'review', 'final'), edgeOf('e4', 'final', 'end')],
  })
}

/** start → apply → c1(custom，带 taskType:2 属性) → end：记录类节点不读 taskType，历史行形状不变。 */
function customChain(): string {
  return JSON.stringify({
    name: `tt252-custom-${++seq}`, displayName: 'custom 回归夹具', type: 'approval',
    nodes: [
      nodeOf('start', 'snaker:start', {}, '开始'),
      nodeOf('apply', 'snaker:task', { form: 'apply-form', assignee: 'applicant', taskType: 0, performType: 0 }, '发起申请'),
      nodeOf('c1', 'snaker:custom', { taskType: 2 }, '记录'),
      nodeOf('end', 'snaker:end', {}, '结束'),
    ],
    edges: [edgeOf('e1', 'start', 'apply'), edgeOf('e2', 'apply', 'c1'), edgeOf('e3', 'c1', 'end')],
  })
}

function registerFlowJson(repo: MemoryRepository, jsonStr: string): ProcessDefine {
  const raw = JSON.parse(jsonStr)
  const def: ProcessDefine = {
    id: '', name: raw.name, displayName: raw.displayName ?? '', type: raw.type ?? 'approval',
    state: 1, content: jsonStr, version: 1,
  } as ProcessDefine
  repo.addDefine(def)
  return def
}

/** 发起并办结申请节点，返回停在 review 的实例。 */
async function startToReview(engine: any, repo: MemoryRepository, jsonStr: string) {
  const def = registerFlowJson(repo, jsonStr)
  const started = await engine.startProcessInstanceById(def.id, 'applicant', {})
  for (const t of await repo.findDoingTasks(started.id)) {
    await engine.executeProcessTask(t.id, 'applicant', { [KeySubmitType]: APPLY })
  }
  return (await repo.findInstanceById(started.id))!
}

// ─── 正向 ─────────────────────────────────────────────────────────────────────

describe('issues/252 节点级协办（taskType=1）解析期禁配', () => {
  it('格 1：折成协办的全部输入形解析期报错且逐字文案', () => {
    for (const raw of [1, '1', '协办', 'SECONDARY', 'secondary']) {
      assert.throws(() => checkFlowConfig(JSON.parse(chain({ taskType: raw }))),
        (e: Error) => e.message === MSG, `taskType=${JSON.stringify(raw)} 应拦`)
    }
  })

  it('格 2：发起腿报错且零写入', async () => {
    const { engine, repo } = setup()
    const def = registerFlowJson(repo, chain({ taskType: 1 }))
    await assert.rejects(engine.startProcessInstanceById(def.id, 'applicant', {}),
      (e: Error) => e.message.includes(MSG))
    assert.equal(await repo.hasInstancesByDefineId(def.id), false, '解析报错必须零写入')
  })

  // ─── 回归 ───────────────────────────────────────────────────────────────────

  it('格 3：0／Major／缺省／未知值 Aidant 仍解析成功且回落主办', async () => {
    for (const raw of [0, '0', 'Major', 'MAJOR', '主办', 'Aidant', undefined]) {
      const props = raw === undefined ? {} : { taskType: raw }
      const flow = chain(props)
      checkFlowConfig(JSON.parse(flow))  // 解析层：不得报错
      const { engine, repo } = setup()
      const inst = await startToReview(engine, repo, flow)
      const review = (await repo.findDoingTasks(inst.id)).find(t => t.taskName === 'review')
      assert.ok(review, `taskType=${JSON.stringify(raw)} 应停在 review`)
      assert.equal(review!.taskType, 0, '未知值维持静默回落主办（issues/245 口径）')
    }
  })

  it('格 4：custom 记录节点历史行不变', async () => {
    const flow = customChain()
    checkFlowConfig(JSON.parse(flow))
    const { engine, repo } = setup()
    const def = registerFlowJson(repo, flow)
    const started = await engine.startProcessInstanceById(def.id, 'applicant', {})
    for (const t of await repo.findDoingTasks(started.id)) {
      await engine.executeProcessTask(t.id, 'applicant', { [KeySubmitType]: APPLY })
    }
    const rows = (await repo.findHistoryTasks(started.id)).filter(t => t.taskName === 'c1')
    assert.equal(rows.length, 1, 'custom 记录行必须照落')
    assert.equal(rows[0].taskState, TaskState.Done)
    assert.equal(rows[0].taskType, 0, '本栈历史行 taskType 形状不变（缺省 0）')
    assert.equal((await repo.findDoingTasks(started.id)).length, 0, '令牌应续流到 end')
  })
})
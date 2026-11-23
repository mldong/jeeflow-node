/**
 * 「表单指定用户所属部门经理／分管领导」两个内置处理器（Node 栈）。
 *
 * 契约＝执行卡 `docs/2026-11-22-form-user-assignment-handler-handoff.md` §3（八语言同形）；
 * 行为基准＝jeeflow-go `v1.8.67`（本轮样章）；场景来源＝mldong-fastapi-wf `fe9233d`（HR 代员工提交）。
 * 夹具＝内联流程 JSON（不占共享 flows 的号，见执行报告 P2）。
 */
import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { EngineImpl } from '../src/engine.js'
import { MemoryRepository } from '../src/memory.js'
import { HandlerRegistry } from '../src/registry.js'
import {
  DeptLeaderAssignmentHandler, FormFieldAssigneeHandler,
  FormUserDeptLeaderAssignmentHandler, FormUserDeptMainLeaderAssignmentHandler,
  HANDLER_FORM_USER_DEPT_LEADER, HANDLER_FORM_USER_DEPT_MAIN_LEADER,
  firstFormUserId, findFormUserFieldValue, registerBuiltinAssignments,
} from '../src/builtin.js'
import type { ProcessDefine, FlowNode, ProcessInstance } from '../src/model.js'
import type { OrgUserProvider, UserProvider } from '../src/spi.js'

const FQ_LEADER = 'com.mldong.jeeflow.interceptor.impl.FormUserDeptLeaderAssignmentHandler'
const FQ_MAIN = 'com.mldong.jeeflow.interceptor.impl.FormUserDeptMainLeaderAssignmentHandler'

/** emp→D01（有两位经理＋一位分管领导）、other→D02（无领导）、nodept→无部门、其余查无此人 */
const userProv: UserProvider = {
  async getUser(userId: string) {
    if (userId === 'emp') return { userId, realName: '员工', deptId: 'D01', deptName: '合成部门', postId: '', postName: '' }
    if (userId === 'other') return { userId, realName: '别的部门', deptId: 'D02', deptName: '空部门', postId: '', postName: '' }
    if (userId === 'nodept') return { userId, realName: '无部门', deptId: undefined, deptName: '', postId: '', postName: '' }
    if (userId === 'zero') return { userId, realName: '零号', deptId: 'D01', deptName: '合成部门', postId: '', postName: '' }
    return null
  },
}
const orgProv: OrgUserProvider = {
  async findDeptLeaders(deptId: string) { return deptId === 'D01' ? ['leader1', 'leader2'] : [] },
  async findDeptMainLeaders(deptId: string) { return deptId === 'D01' ? ['boss1'] : [] },
  async findByRole() { return [] },
}

function node(id: string): FlowNode {
  return { id, type: 'snaker:task', properties: {}, text: { value: id } } as FlowNode
}
function inst(operator: string, variables: Record<string, any>): ProcessInstance {
  return { id: '1', defineId: '1', operator, variables } as ProcessInstance
}

async function actors(nodeId: string, variables: Record<string, any>, main = false,
                      opts: { user?: boolean; org?: boolean } = {}) {
  const u = opts.user === false ? undefined : userProv
  const o = opts.org === false ? undefined : orgProv
  const built = main ? new FormUserDeptMainLeaderAssignmentHandler(u, o)
    : new FormUserDeptLeaderAssignmentHandler(u, o)
  return (built as any).assign(node(nodeId), inst('hr', variables), 'hr')
}

describe('正向：四档并集，顺序即优先级', () => {
  const CASES: [string, string, Record<string, any>][] = [
    ['f_ 主通道', 'manager', { f_manager: 'emp' }],
    ['裸名回落', 'manager', { manager: 'emp' }],
    ['# 右半（字段名本身带 f_）', 'manager#f_userId', { f_userId: 'emp' }],
    ['# 右半的 f_ 变体', 'manager#userId', { f_userId: 'emp' }],
    ['_NN 去后缀的 f_ 形', 'manager_01', { f_manager: 'emp' }],
    ['_NN 去后缀的裸名形', 'manager_01', { manager: 'emp' }],
  ]
  for (const [label, nodeId, vars] of CASES) {
    it(label, async () => assert.deepEqual(await actors(nodeId, vars), ['leader1', 'leader2']))
  }
  it('分管领导档取 mainLeader 出口', async () => {
    assert.deepEqual(await actors('manager#f_userId', { f_userId: 'emp' }, true), ['boss1'])
  })
})

describe('负向：一律空数组、不抛异常', () => {
  const CASES: [string, Record<string, any>][] = [
    ['表单没给字段', {}],
    ['值为空串', { f_userId: '' }],
    ['值为纯空白', { f_userId: '   ' }],
    ['列表全空', { f_userId: ['', '  '] }],
    ['指向查无此人', { f_userId: 'ghost' }],
    ['指向无部门用户', { f_userId: 'nodept' }],
    ['指向别的部门（该部门无领导）', { f_userId: 'other' }],
  ]
  for (const [label, vars] of CASES) {
    it(label, async () => {
      assert.deepEqual(await actors('manager#f_userId', vars), [])
      assert.deepEqual(await actors('manager#f_userId', vars, true), [])
    })
  }

  it('SPI 未注册／node·inst 为空都不报错', async () => {
    assert.deepEqual(await actors('manager', { f_manager: 'emp' }, false, { user: false }), [])
    assert.deepEqual(await actors('manager', { f_manager: 'emp' }, false, { org: false }), [])
    const h = new FormUserDeptLeaderAssignmentHandler(userProv, orgProv) as any
    assert.deepEqual(await h.assign(null, inst('hr', {}), 'hr'), [])
    assert.deepEqual(await h.assign(node('manager'), null, 'hr'), [])
  })
})

describe('取值细节', () => {
  it('f_ 前缀压裸名', () => {
    assert.equal(findFormUserFieldValue({ f_x: 'emp', x: 'other' }, 'x'), 'emp')
  })
  it('# 档先裸名再 f_ 变体', () => {
    assert.equal(findFormUserFieldValue({ userId: 'emp', f_userId: 'other' }, 'manager#userId'), 'emp')
  })
  it('_NN 档先 f_ 再裸名（与参照实现相反，jeeflow 变量存 f_）', () => {
    assert.equal(findFormUserFieldValue({ f_manager: 'emp', manager: 'other' }, 'manager_01'), 'emp')
  })
  it('只取第一个非空 id，"0" 不被真值判据吃掉', () => {
    assert.equal(firstFormUserId('a,b'), 'a')
    assert.equal(firstFormUserId(['', 'b', 'c']), 'b')
    assert.equal(firstFormUserId('  ,  ,d'), 'd')
    assert.equal(firstFormUserId(0), '0')
    assert.equal(firstFormUserId('0'), '0')
    assert.equal(firstFormUserId(['', ' ']), '')
    assert.equal(firstFormUserId(null), '')
  })
  it('id 为 "0" 时照常取人（不被语言真值判据拦掉）', async () => {
    const seen: string[] = []
    const spy: UserProvider = {
      async getUser(userId: string) {
        seen.push(userId)
        return userId === '0'
          ? { userId, realName: '零号', deptId: 'D01', deptName: '', postId: '', postName: '' }
          : null
      },
    }
    const h = new FormUserDeptLeaderAssignmentHandler(spy, orgProv) as any
    assert.deepEqual(await h.assign(node('manager'), inst('hr', { f_manager: '0' }), 'hr'), ['leader1', 'leader2'])
    assert.deepEqual(seen, ['0'], 'getUser 必须被以 "0" 调用一次（不是被真值判据提前拦掉）')
  })
})

describe('回归：现存 handler 没被并集查找渗进去', () => {
  it('DeptLeader 仍按操作人取人，表单错值不影响它', async () => {
    const h = new DeptLeaderAssignmentHandler(userProv, orgProv) as any
    assert.deepEqual(await h.assign(node('manager'), inst('emp', { manager: 'other' }), 'emp'), ['leader1', 'leader2'])
    assert.deepEqual(await h.assign(node('manager'), inst('nodept', { manager: 'emp' }), 'nodept'), [])
  })
  it('FormFieldAssignee 仍只做三档（第 3 档不认 f_ 变体）', async () => {
    const h = new FormFieldAssigneeHandler() as any
    assert.deepEqual(await h.assign(node('manager#userId'), inst('hr', { f_userId: 'emp' }), 'hr'), [])
  })
  it('老类第三档＝_NN 去后缀查裸名 base（issues/255 正／负）', async () => {
    const h = new FormFieldAssigneeHandler() as any
    const legacy = (id: string, variables: Record<string, any>) =>
      h.assign(node(id), inst('hr', variables), 'hr')
    assert.deepEqual(await legacy('task_01', { task: 'userA,userB' }), ['userA', 'userB'])
    // 惰性量词的最早可切点：a_b_01 的 base 是 a_b，不是 a
    assert.deepEqual(await legacy('a_b_01', { a: 'u_x', a_b: 'u_c' }), ['u_c'])
    // 优先级：f_<id> → 裸名 → base 裸名
    assert.deepEqual(await legacy('task_01', { f_task_01: 'u_1', task_01: 'u_2', task: 'u_3' }), ['u_1'])
    assert.deepEqual(await legacy('task_01', { task_01: 'u_2', task: 'u_3' }), ['u_2'])
    // 反向：尾巴非纯数字、base 为空、base 只有 f_ 形 ⇒ 三档全落空
    assert.deepEqual(await legacy('task_01x', { task: 'u_3' }), [])
    assert.deepEqual(await legacy('_01', { '': 'u_3' }), [])
    assert.deepEqual(await legacy('task_02', { f_task: 'u_3' }), [])
  })
})

describe('注册名／元数据', () => {
  it('注册名是顶级类 FQN 且可解析', () => {
    assert.equal(HANDLER_FORM_USER_DEPT_LEADER, FQ_LEADER)
    assert.equal(HANDLER_FORM_USER_DEPT_MAIN_LEADER, FQ_MAIN)
    const reg = new HandlerRegistry()
    registerBuiltinAssignments(reg, userProv, orgProv)
    assert.ok((reg as any).resolveAssignment(FQ_LEADER) instanceof FormUserDeptLeaderAssignmentHandler)
    assert.ok((reg as any).resolveAssignment(FQ_MAIN) instanceof FormUserDeptMainLeaderAssignmentHandler)
  })
})

// ─── HR 代员工提交：引擎级两段链路 ─────────────────────────────────────────────

function hrFlow(name: string): string {
  const task = (id: string, handler: string) => ({
    id, type: 'snaker:task', x: 480, y: 500, text: { value: id },
    properties: { taskType: 0, performType: 0, assignmentHandler: handler },
  })
  return JSON.stringify({
    name, displayName: 'HR代员工提交（表单指定用户）', type: 'test',
    nodes: [
      { id: 'start', type: 'snaker:start', properties: {}, text: { value: '开始' } },
      { id: 'apply', type: 'snaker:task', properties: { assignee: 'applicant', taskType: 0, performType: 0 }, text: { value: '发起申请' } },
      task('manager#f_userId', FQ_LEADER),
      task('mainLeader#f_userId', FQ_MAIN),
      { id: 'end', type: 'snaker:end', properties: {}, text: { value: '结束' } },
    ],
    edges: [
      { id: 'e0', sourceNodeId: 'start', targetNodeId: 'apply', properties: {} },
      { id: 'e1', sourceNodeId: 'apply', targetNodeId: 'manager#f_userId', properties: {} },
      { id: 'e2', sourceNodeId: 'manager#f_userId', targetNodeId: 'mainLeader#f_userId', properties: {} },
      { id: 'e3', sourceNodeId: 'mainLeader#f_userId', targetNodeId: 'end', properties: {} },
    ],
  })
}

async function hrHarness(name: string) {
  const mem = new MemoryRepository()
  const engine = new EngineImpl(mem, userProv)
  const registry = new HandlerRegistry()
  registerBuiltinAssignments(registry, userProv, orgProv)
  engine.setRegistry(registry)
  const def = { id: '', name, displayName: 'HR代员工提交', type: 'test', state: 1,
    content: hrFlow(name), version: 1, createTime: new Date(), createUser: 't',
    updateTime: new Date(), updateUser: 't' } as ProcessDefine
  mem.addDefine(def)
  return { mem, engine, def }
}

describe('HR 代员工提交（引擎级）', () => {
  it('两段待办分别落在表单指定用户的经理与分管领导名下', async () => {
    const { mem, engine, def } = await hrHarness('fu-hr-proxy')
    const inst1 = await engine.startProcessInstanceById(def.id, 'hr', { f_userId: 'emp' })
    const apply = (await mem.findDoingTasks(inst1.id))[0]
    assert.equal(apply.taskName, 'apply')
    await engine.executeProcessTask(apply.id, 'hr', {})

    const doing = await mem.findDoingTasks(inst1.id)
    assert.deepEqual(doing.map((t) => t.taskName), ['manager#f_userId'])
    assert.deepEqual([...doing[0].actorIds].sort(), ['leader1', 'leader2'])

    await engine.executeProcessTask(doing[0].id, 'leader1', {})
    const next = await mem.findDoingTasks(inst1.id)
    assert.deepEqual(next.map((t) => t.taskName), ['mainLeader#f_userId'])
    assert.deepEqual([...next[0].actorIds], ['boss1'])
  })

  it('字段缺失 ⇒ 参与者为空、实例仍进行中（不被空参与者打断）', async () => {
    const { mem, engine, def } = await hrHarness('fu-hr-proxy-empty')
    const inst1 = await engine.startProcessInstanceById(def.id, 'hr', {})
    const apply = (await mem.findDoingTasks(inst1.id))[0]
    await engine.executeProcessTask(apply.id, 'hr', {})
    const doing = await mem.findDoingTasks(inst1.id)
    assert.deepEqual(doing.map((t) => t.taskName), ['manager#f_userId'], '零参与者仍建 DO 行')
    assert.deepEqual([...doing[0].actorIds], [])
    const fresh = await mem.findInstanceById(inst1.id)
    assert.equal(String(fresh.state), '10')
  })
})

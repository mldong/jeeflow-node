import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EngineImpl, KeyAutoGenTitle } from '../src/engine.js'
import { HandlerRegistry, registerBuiltinAssignments } from '../src/index.js'
import { MemoryRepository } from '../src/memory.js'
import { MemoryExtRepository } from '../src/memory-ext.js'
import { JeeflowFacade } from '../src/facade.js'
import { InstanceState, type ProcessDefine, type ProcessInstance, type ProcessTask } from '../src/model.js'
import type { ExpressionEvaluator, UserProvider } from '../src/spi.js'
import { type FlowInterceptor, EventType, type EngineExtensions } from '../src/extensions.js'

const flowDir = '../jeeflow-java/jeeflow-core/src/test/resources/flows/'

function setup() {
  const repo = new MemoryRepository()
  const userProv: UserProvider = {
    async getUser(userId) { return { userId, realName: '用户' + userId, deptId: 'D01', deptName: '测试部门', postId: 'P01', postName: '测试岗位' } },
  }
  const idGen = { nextId() { return String(Date.now() * 1000 + Math.floor(Math.random() * 1000)) } }
  const exprEval: ExpressionEvaluator = {
    async eval(expr, vars) {
      const amt = Number(vars.amount ?? 0)
      if (expr === 'amount > 1000') return amt > 1000
      if (expr === 'amount <= 1000') return amt <= 1000
      return false
    },
  }
  return { engine: new EngineImpl(repo, userProv, idGen, exprEval), repo }
}

function loadFlow(repo: MemoryRepository, filename: string): ProcessDefine {
  const data = readFileSync(flowDir + filename, 'utf-8')
  const def: ProcessDefine = { id: 0, name: filename, displayName: filename, type: 'test', state: 1, content: data, version: 1, createTime: new Date(), updateTime: new Date(), createUser: '', updateUser: '' }
  repo.addDefine(def)
  return def
}


async function startAndExecute(engine: EngineImpl, repo: MemoryRepository, defineId: number, operator: string, args?: Record<string, any>) {
  const inst = await engine.startProcessInstanceById(defineId, operator, args)
  const doing = await repo.findDoingTasks(inst.id)
  for (const task of doing) {
    if (task.taskName === 'apply') {
      await repo.addTaskActor(task.id, [operator])
      await engine.executeProcessTask(task.id, operator)
    }
  }
  return inst
}

async function assertDone(inst: ProcessInstance | null, msg: string) {
  assert.equal(inst?.state, InstanceState.Done, msg)
}

describe('jeeflow compliance tests', () => {

  it('01 simple flow', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '01-simple.json')
    const inst = await startAndExecute(engine, repo, def.id, 'applicant')
    // issue 29：autoGenTitle 自动生成验证
    assert.ok(inst.variables[KeyAutoGenTitle], 'autoGenTitle should be set in instance variables')
    assert.ok(typeof inst.variables[KeyAutoGenTitle] === 'string' && inst.variables[KeyAutoGenTitle].length > 0, 'autoGenTitle should not be empty')
    const doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing.length, 1)
    assert.equal(doing[0].taskName, 'task1')
    await repo.addTaskActor(doing[0].id, ['applicant'])
    doing[0].actorIds.push('applicant')
    const result = await engine.executeProcessTask(doing[0].id, 'applicant')
    await assertDone(result, 'simple: expected done')
  })

  it('02 multi-task', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '02-multi-task.json')
    const inst = await startAndExecute(engine, repo, def.id, 'applicant')

    let doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing.length, 1, 'task1')
    assert.equal(doing[0].taskName, 'task1')
    await repo.addTaskActor(doing[0].id, ['userA'])
    doing[0].actorIds.push('userA')
    await engine.executeProcessTask(doing[0].id, 'userA')

    doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing.length, 1, 'task2')
    assert.equal(doing[0].taskName, 'task2')
    await repo.addTaskActor(doing[0].id, ['userB'])
    doing[0].actorIds.push('userB')
    await engine.executeProcessTask(doing[0].id, 'userB')

    doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing.length, 1, 'task3')
    assert.equal(doing[0].taskName, 'task3')
    await repo.addTaskActor(doing[0].id, ['userC'])
    doing[0].actorIds.push('userC')
    const result = await engine.executeProcessTask(doing[0].id, 'userC')
    await assertDone(result, 'multi: expected done')
  })

  it('03 decision', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '03-decision-expr.json')
    const inst = await startAndExecute(engine, repo, def.id, 'applicant', { amount: 3000 })
    let doing = await repo.findDoingTasks(inst.id)
    await repo.addTaskActor(doing[0].id, ['applicant'])
    doing[0].actorIds.push('applicant')
    await engine.executeProcessTask(doing[0].id, 'applicant')
    doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing[0].taskName, 'task2', 'amount>1000 → task2')
  })

  it('03.5 highLight 决策分支表达式过滤（issues/06）', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, undefined)
    const def = loadFlow(repo, '03-decision-expr.json')
    // amount=500 → 走「amount <= 1000」分支（task3），task2 分支未执行
    const inst = await startAndExecute(engine, repo, def.id, 'applicant', { amount: 500 })
    let doing = await repo.findDoingTasks(inst.id)
    for (const t of doing) {
      if (t.taskName === 'task1') {
        await repo.addTaskActor(t.id, ['leader'])
        t.actorIds.push('leader')
        await engine.executeProcessTask(t.id, 'leader')
      }
    }
    doing = await repo.findDoingTasks(inst.id)
    for (const t of doing) {
      if (t.taskName === 'task3') {
        await repo.addTaskActor(t.id, ['director'])
        t.actorIds.push('director')
        await engine.executeProcessTask(t.id, 'director')
      }
    }
    const r = await facade.flow('processInstance/highLight', { id: inst.id })
    assert.equal(r.code, 0, JSON.stringify(r))
    const hl = r.data
    assert.ok(hl.historyEdgeNames.includes('e4') && hl.historyEdgeNames.includes('e6'), JSON.stringify(hl))
    assert.ok(!hl.historyEdgeNames.includes('e3') && !hl.historyEdgeNames.includes('e5'), JSON.stringify(hl))
    assert.ok(!hl.historyNodeNames.includes('task2'), JSON.stringify(hl))
    assert.ok(hl.historyNodeNames.includes('task3'), JSON.stringify(hl))
  })

  it('05-1 三个 detail 返回 jsonObject', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, undefined)
    const def = loadFlow(repo, '01-simple.json')
    let r = await facade.flow('processDefine/detail', { id: def.id })
    assert.equal(r.code, 0, JSON.stringify(r))
    assert.ok(r.data.jsonObject, 'defineDetail 缺 jsonObject')

    const inst = await startAndExecute(engine, repo, def.id, 'applicant')
    r = await facade.flow('processInstance/detail', { id: inst.id })
    assert.equal(r.code, 0, JSON.stringify(r))
    assert.ok(r.data.jsonObject, 'instanceDetail 缺 jsonObject')

    const doing = await repo.findDoingTasks(inst.id)
    r = await facade.flow('processTask/detail', { id: doing[0].id, operator: 'applicant' })
    assert.equal(r.code, 0, JSON.stringify(r))
    assert.ok(r.data.jsonObject, 'taskDetail 缺 jsonObject')
  })

  it('04 fork-join', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '04-fork-join.json')
    const inst = await startAndExecute(engine, repo, def.id, 'applicant')
    let doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing.length, 2, 'fork: 2 tasks')
    const tA = doing.find(t => t.taskName === 'taskA')!
    const tB = doing.find(t => t.taskName === 'taskB')!
    await repo.addTaskActor(tA.id, ['userA'])
    tA.actorIds.push('userA')
    await engine.executeProcessTask(tA.id, 'userA')
    let inst2 = await repo.findInstanceById(inst.id)
    assert.equal(inst2?.state, InstanceState.Doing, 'still doing')
    await repo.addTaskActor(tB.id, ['userB'])
    tB.actorIds.push('userB')
    const result = await engine.executeProcessTask(tB.id, 'userB')
    await assertDone(result, 'fork-join: expected done')
  })

  it('05 countersign parallel', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '05-countersign-parallel.json')
    const inst = await startAndExecute(engine, repo, def.id, 'applicant')
    let doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing.length, 3, 'parallel cs: 3 tasks')
    for (const actor of ['userA', 'userB', 'userC']) {
      doing = await repo.findDoingTasks(inst.id)
      const t = doing[0]
      await repo.addTaskActor(t.id, [actor])
      t.actorIds.push(actor)
      await engine.executeProcessTask(t.id, actor)
    }
    const result = await repo.findInstanceById(inst.id)
    await assertDone(result, 'parallel cs: expected done')
  })

  it('06 countersign sequential', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '06-countersign-sequential.json')
    const inst = await startAndExecute(engine, repo, def.id, 'applicant')
    let doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing.length, 1, 'seq cs: 1 task')
    let t = doing[0]
    await repo.addTaskActor(t.id, ['userA'])
    t.actorIds.push('userA')
    await engine.executeProcessTask(t.id, 'userA')
    doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing.length, 1, 'seq cs step2: 1 task')
    t = doing[0]
    await repo.addTaskActor(t.id, ['userB'])
    t.actorIds.push('userB')
    const result = await engine.executeProcessTask(t.id, 'userB')
    await assertDone(result, 'seq cs: expected done')
  })

  it('07 countersign ratio', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '07-countersign-ratio.json')
    const inst = await startAndExecute(engine, repo, def.id, 'applicant')
    let doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing.length, 4, 'ratio cs: 4 tasks')
    for (const actor of ['userA', 'userB', 'userC', 'userD']) {
      doing = await repo.findDoingTasks(inst.id)
      const t = doing[0]
      await repo.addTaskActor(t.id, [actor])
      t.actorIds.push(actor)
      await engine.executeProcessTask(t.id, actor)
    }
    const result = await repo.findInstanceById(inst.id)
    await assertDone(result, 'ratio cs: expected done')
  })

  it('08 reject', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '02-multi-task.json')
    const inst = await startAndExecute(engine, repo, def.id, 'applicant')
    const doing = await repo.findDoingTasks(inst.id)
    await repo.addTaskActor(doing[0].id, ['applicant'])
    doing[0].actorIds.push('applicant')
    const result = await engine.executeAndJumpToEnd(doing[0].id, 'applicant')
    assert.equal(result.state, InstanceState.Reject, 'reject: expected 45')
  })

  it('09 permission', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '02-multi-task.json')
    const inst = await startAndExecute(engine, repo, def.id, 'applicant')
    const doing = await repo.findDoingTasks(inst.id)
    await repo.addTaskActor(doing[0].id, ['leader'])
    doing[0].actorIds = ['leader']
    await assert.rejects(() => engine.executeProcessTask(doing[0].id, 'intruder'), /not allowed/)
  })

  it('10 interceptor + events', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '01-simple.json')
    let preCalled = false, postCalled = false
    const events: string[] = []
    engine.setExtensions({
      interceptors: [{ order: 1,
        async preHandle() { preCalled = true; return true },
        async postHandle() { postCalled = true },
      }],
      listeners: [(e) => {
        if (e.type === EventType.ProcessStart) events.push('start')
        if (e.type === EventType.TaskComplete) events.push('taskDone')
        if (e.type === EventType.ProcessFinish) events.push('finish')
      }],
    })
    const inst = await startAndExecute(engine, repo, def.id, 'applicant')
    const doing = await repo.findDoingTasks(inst.id)
    await repo.addTaskActor(doing[0].id, ['leader'])
    doing[0].actorIds.push('leader')
    await engine.executeProcessTask(doing[0].id, 'leader')
    assert.ok(preCalled)
    assert.ok(postCalled)
    // start + apply自动完成 + task1 + finish
    assert.deepStrictEqual(events, ['start', 'taskDone', 'taskDone', 'finish'])
  })

  it('11 assignee 变量解析（v1.0.1，集成反馈③）', async () => {
    const { engine, repo } = setup()
    let def = loadFlow(repo, '11-assignee-vars.json')

    // ① deptLeader 变量命中 → 参与者 = 变量值
    let inst = await engine.startProcessInstanceById(def.id, 'applicant', { deptLeader: 'L001' })
    let doing = await repo.findDoingTasks(inst.id)
    await repo.addTaskActor(doing[0].id, ['applicant'])
    await engine.executeProcessTask(doing[0].id, 'applicant')
    doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing[0].taskName, 'task1')
    assert.deepStrictEqual(doing[0].actorIds, ['L001'], '变量命中应解析为变量值')

    // ② 静态字面量 userA,userB（变量未命中）
    await engine.executeProcessTask(doing[0].id, 'L001')
    doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing[0].taskName, 'task2')
    assert.deepStrictEqual(doing[0].actorIds, ['userA', 'userB'], '静态字面量参与者')

    // ③ 变量未传入 → token 字面量回退（对齐 boot3 args.get(token, token)）
    def = loadFlow(repo, '11-assignee-vars.json')
    inst = await engine.startProcessInstanceById(def.id, 'applicant')
    doing = await repo.findDoingTasks(inst.id)
    await repo.addTaskActor(doing[0].id, ['applicant'])
    await engine.executeProcessTask(doing[0].id, 'applicant')
    doing = await repo.findDoingTasks(inst.id)
    assert.deepStrictEqual(doing[0].actorIds, ['deptLeader'], '未命中应回退字面量')

    // ④ tf_nextNodeOperator 优先于 assignee
    def = loadFlow(repo, '11-assignee-vars.json')
    inst = await engine.startProcessInstanceById(def.id, 'applicant')
    doing = await repo.findDoingTasks(inst.id)
    await repo.addTaskActor(doing[0].id, ['applicant'])
    await engine.executeProcessTask(doing[0].id, 'applicant', { tf_nextNodeOperator: 'BOSS1,BOSS2' })
    doing = await repo.findDoingTasks(inst.id)
    assert.deepStrictEqual(doing[0].actorIds, ['BOSS1', 'BOSS2'], 'tf_nextNodeOperator 应优先')
  })

  it('13 门面路由（v1.1.0，spec §12 #15）：deploy 版本管理', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
    const content = readFileSync(flowDir + '01-simple.json', 'utf-8')

    let r = await facade.flow('processDefine/deploy', { content })
    assert.equal(r.code, 0, JSON.stringify(r))
    const defineId = r.data.processDefineId
    const d1 = await repo.findDefineById(defineId)
    assert.equal(d1?.version, 0, '首次部署 version=0')

    r = await facade.flow('processDefine/deploy', { content })
    assert.equal(r.code, 0, JSON.stringify(r))
    const latest = await repo.findDefineByName('simple')
    assert.equal(latest?.version, 1, '二次部署 version=1')

    r = await facade.flow('processDefine/upAndDown', { id: defineId, state: 0 })
    assert.equal(r.code, 0, JSON.stringify(r))
    assert.equal((await repo.findDefineById(defineId))?.state, 0)

    r = await facade.flow('processDefine/remove', { id: defineId })
    assert.equal(r.code, 0, JSON.stringify(r))
    assert.equal(await repo.findDefineById(defineId), null)
  })

  it('14 门面路由：发起即提交 / 执行 / 撤回级联', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
    const content = readFileSync(flowDir + '01-simple.json', 'utf-8')
    const r0 = await facade.flow('processDefine/deploy', { content })
    const defineId = r0.data.processDefineId

    const r1 = await facade.flow('processInstance/startAndExecute',
      { processDefineId: defineId, operator: 'zhangsan', amount: '1000' })
    assert.equal(r1.code, 0, JSON.stringify(r1))
    const instanceId = r1.data.processInstanceId

    let doing = await repo.findDoingTasks(instanceId)
    assert.equal(doing.length, 1)
    assert.equal(doing[0].taskName, 'task1')
    const r2 = await facade.flow('processTask/execute',
      { processTaskId: doing[0].id, operator: 'leader', submitType: 1 })
    assert.equal(r2.code, 0, JSON.stringify(r2))
    const inst = await repo.findInstanceById(instanceId)
    assert.equal(inst?.state, InstanceState.Done, '实例应完成')

    // withdraw 级联废弃 doing
    const r3 = await facade.flow('processInstance/startAndExecute',
      { processDefineId: defineId, operator: 'zhangsan' })
    const instanceId2 = r3.data.processInstanceId
    const r4 = await facade.flow('processInstance/withdraw', { id: instanceId2, operator: 'zhangsan' })
    assert.equal(r4.code, 0, JSON.stringify(r4))
    doing = await repo.findDoingTasks(instanceId2)
    assert.equal(doing.length, 0, '撤回应废弃 doing 任务')
  })

  it('15 门面路由：设计保存/详情/发布 + 委托增查删', async () => {
    const { engine, repo } = setup()
    const extRepo = new MemoryExtRepository()
    const facade = new JeeflowFacade(engine, repo, extRepo)
    const content = readFileSync(flowDir + '01-simple.json', 'utf-8')

    const r1 = await facade.flow('processDesign/save',
      { name: 'leave', displayName: '请假流程', content, operator: 'zhangsan' })
    assert.equal(r1.code, 0, JSON.stringify(r1))
    const designId = r1.data.id

    const r2 = await facade.flow('processDesign/detail', { id: designId })
    assert.equal(r2.code, 0, JSON.stringify(r2))
    assert.ok(r2.data.jsonObject)
    assert.equal(r2.data.his.length, 1)

    // issues/07：无 content 的设计 → jsonObject 补齐基本信息
    const r2b = await facade.flow('processDesign/save',
      { name: 'test_display', displayName: '回显测试', operator: 'zhangsan' })
    assert.equal(r2b.code, 0, JSON.stringify(r2b))
    const r2c = await facade.flow('processDesign/detail', { id: r2b.data.id })
    assert.equal(r2c.code, 0, JSON.stringify(r2c))
    assert.equal(r2c.data.jsonObject.name, 'test_display', JSON.stringify(r2c))
    assert.equal(r2c.data.jsonObject.displayName, '回显测试', JSON.stringify(r2c))
    assert.equal(r2c.data.jsonObject.processDesignId, r2b.data.id, JSON.stringify(r2c))

    const r3 = await facade.flow('processDesign/deploy', { id: designId, operator: 'zhangsan' })
    assert.equal(r3.code, 0, JSON.stringify(r3))
    assert.ok(r3.data.processDefineId > 0)
    assert.equal((await extRepo.findDesignById(designId))?.isDeployed, 1)

    const r4 = await facade.flow('processSurrogate/save',
      { operator: 'zhangsan', surrogate: 'lisi', processName: 'leave' })
    assert.equal(r4.code, 0, JSON.stringify(r4))
    const hit = await extRepo.getSurrogate('zhangsan', 'leave')
    assert.equal(hit?.surrogate, 'lisi')

    const r5 = await facade.flow('processSurrogate/page', { operator: 'zhangsan' })
    assert.equal(r5.code, 0, JSON.stringify(r5))
    assert.equal(r5.data.recordCount, 1)

    const r6 = await facade.flow('processSurrogate/remove', { id: r4.data.id })
    assert.equal(r6.code, 0, JSON.stringify(r6))
  })

  it('17 门面视图端点（v1.2.0，spec §12 #16-18）', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
    const content = readFileSync(flowDir + '01-simple.json', 'utf-8')
    const r0 = await facade.flow('processDefine/deploy', { content })
    const defineId = r0.data.processDefineId

    // getLastByName
    const r1 = await facade.flow('processDefine/getLastByName', { processDefineName: 'simple' })
    assert.equal(r1.code, 0, JSON.stringify(r1))
    assert.equal(r1.data.name, 'simple')

    // startAndExecute → 视图端点
    const r2 = await facade.flow('processInstance/startAndExecute', { processDefineId: defineId, operator: 'zhangsan' })
    const instanceId = r2.data.processInstanceId

    const r3 = await facade.flow('processInstance/approvalRecord', { id: instanceId })
    assert.equal(r3.code, 0, JSON.stringify(r3))
    assert.equal(r3.data.length, 2, 'apply + task1')

    const r4 = await facade.flow('processInstance/highLight', { id: instanceId })
    assert.equal(r4.code, 0, JSON.stringify(r4))
    assert.ok(r4.data.activeNodeNames.includes('task1'), JSON.stringify(r4.data))
    assert.ok(r4.data.historyNodeNames.includes('apply'), JSON.stringify(r4.data))

    const r5 = await facade.flow('processInstance/getAssigneeTextData', { id: instanceId })
    assert.equal(r5.code, 0, JSON.stringify(r5))
    assert.equal(r5.data.length, 1, 'task1 → leader')

    let doing = await repo.findDoingTasks(instanceId)
    const r6 = await facade.flow('processTask/detail', { id: doing[0].id, operator: 'leader' })
    assert.equal(r6.code, 0, JSON.stringify(r6))
    assert.equal(r6.data.executable, true)
    assert.ok(r6.data.taskModel)
    // issues/62：taskModel 补 form/ext（字段权限）
    assert.equal(r6.data.taskModel.form, 'leave-form', JSON.stringify(r6.data.taskModel))
    assert.equal(r6.data.taskModel.ext.PERMISSION_f_leaveType, 1, JSON.stringify(r6.data.taskModel))
    assert.equal(r6.data.taskModel.ext.PERMISSION_days, 2, JSON.stringify(r6.data.taskModel))

    const r7 = await facade.flow('processTask/latest', { processInstanceId: instanceId })
    assert.equal(r7.code, 0, JSON.stringify(r7))
    assert.equal(r7.data.taskName, 'task1')

    // 抄送：创建 + 已读 + 列表（ccList v1.3.0 补齐）
    const r8 = await facade.flow('processInstance/createCCInstance',
      { processInstanceId: instanceId, operator: 'zhangsan', actorIds: ['lisi'] })
    assert.equal(r8.code, 0, JSON.stringify(r8))
    const r9 = await facade.flow('processInstance/updateCCStatus',
      { processInstanceId: instanceId, operator: 'lisi' })
    assert.equal(r9.code, 0, JSON.stringify(r9))
    const r10 = await facade.flow('processInstance/ccList', { operator: 'lisi' })
    assert.equal(r10.code, 0, JSON.stringify(r10))
    assert.equal(r10.data.rows.length, 1, JSON.stringify(r10))

    // 加签/转交
    const r11 = await facade.flow('processTask/addCandidate',
      { processTaskId: doing[0].id, actorIds: ['zhaoliu'] })
    assert.equal(r11.code, 0, JSON.stringify(r11))
    const actors = await repo.findTaskActors(doing[0].id)
    assert.ok(actors.includes('zhaoliu'))

    // candidatePage：未配置钩子报错；配置后可用
    const r12 = await facade.flow('processTask/candidatePage', { processTaskId: doing[0].id })
    assert.equal(r12.code, 99999999, JSON.stringify(r12))
    facade.setUserSearch(async () => [[{ userId: 'u1', realName: '用户1' }], 1])
    const r13 = await facade.flow('processTask/candidatePage', { processTaskId: doing[0].id })
    assert.equal(r13.code, 0, JSON.stringify(r13))
    assert.equal(r13.data.recordCount, 1)
  })

  it('19 列表字段契约（issues/05-2+05-3）：ext/instanceExt/version + 时间格式', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
    const content = readFileSync(flowDir + '01-simple.json', 'utf-8')
    const r0 = await facade.flow('processDefine/deploy', { content })
    assert.equal(r0.code, 0, JSON.stringify(r0))
    const r1 = await facade.flow('processInstance/startAndExecute',
      { processDefineId: r0.data.processDefineId, operator: 'zhangsan', amount: 500 })
    assert.equal(r1.code, 0, JSON.stringify(r1))
    const instanceId = r1.data.processInstanceId

    const timeRe = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

    // todoList：ext（任务变量，空回退实例变量）+ instanceExt + version + 时间格式
    const r2 = await facade.flow('processTask/todoList', { operator: 'leader' })
    assert.equal(r2.code, 0, JSON.stringify(r2))
    assert.ok(r2.data.rows.length > 0, JSON.stringify(r2))
    const row = r2.data.rows[0]
    assert.ok(row.ext && typeof row.ext === 'object', JSON.stringify(row))
    assert.ok(row.instanceExt && typeof row.instanceExt === 'object', JSON.stringify(row))
    assert.equal(row.instanceExt.amount, 500, 'instanceExt 应含实例变量')
    assert.ok(row.version != null, JSON.stringify(row))
    assert.match(String(row.createTime), timeRe, '时间应为 yyyy-MM-dd HH:mm:ss（无 T）')
    assert.ok(!String(row.createTime).includes('T'))

    // 完成任务 → doneList：finishTime 同样格式化
    let doing = await repo.findDoingTasks(instanceId)
    await engine.executeProcessTask(doing[0].id, 'leader')
    const r3 = await facade.flow('processTask/doneList', { operator: 'leader' })
    assert.equal(r3.code, 0, JSON.stringify(r3))
    assert.ok(r3.data.rows.length > 0, JSON.stringify(r3))
    const drow = r3.data.rows[0]
    assert.ok(drow.ext && typeof drow.ext === 'object', JSON.stringify(drow))
    assert.ok(drow.instanceExt && typeof drow.instanceExt === 'object', JSON.stringify(drow))
    assert.ok(drow.version != null, JSON.stringify(drow))
    assert.match(String(drow.finishTime), timeRe, 'finishTime 应为 yyyy-MM-dd HH:mm:ss')
    assert.match(String(drow.createTime), timeRe, 'createTime 应为 yyyy-MM-dd HH:mm:ss')

    // instancePage：ext（实例变量对象）+ displayName/version（定义）
    const r4 = await facade.flow('processInstance/page', { operator: 'zhangsan' })
    assert.equal(r4.code, 0, JSON.stringify(r4))
    assert.ok(r4.data.rows.length > 0, JSON.stringify(r4))
    const irow = r4.data.rows[0]
    assert.ok(irow.ext && typeof irow.ext === 'object', JSON.stringify(irow))
    assert.ok(irow.displayName, JSON.stringify(irow))
    assert.ok(irow.version != null, JSON.stringify(irow))
    assert.match(String(irow.createTime), timeRe, '实例行时间应为 yyyy-MM-dd HH:mm:ss')

    // ccList：ext + displayName + version
    const r5 = await facade.flow('processInstance/createCCInstance',
      { processInstanceId: instanceId, operator: 'zhangsan', actorIds: ['lisi'] })
    assert.equal(r5.code, 0, JSON.stringify(r5))
    const r6 = await facade.flow('processInstance/ccList', { operator: 'lisi' })
    assert.equal(r6.code, 0, JSON.stringify(r6))
    assert.ok(r6.data.rows.length > 0, JSON.stringify(r6))
    const crow = r6.data.rows[0]
    assert.ok(crow.ext && typeof crow.ext === 'object', JSON.stringify(crow))
    assert.ok(crow.displayName && crow.version != null, JSON.stringify(crow))
    assert.match(String(crow.createTime), timeRe, '抄送行时间应为 yyyy-MM-dd HH:mm:ss')
  })

  it('20 m_ 前缀查询参数（issues/05-5）', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
    const c1 = readFileSync(flowDir + '01-simple.json', 'utf-8')   // name=simple
    const c2 = readFileSync(flowDir + '02-multi-task.json', 'utf-8') // name=multi-task
    await facade.flow('processDefine/deploy', { content: c1 })
    await facade.flow('processDefine/deploy', { content: c2 })

    // 无别名 → 默认主表别名 t（t.name / t.display_name）
    const r1 = await facade.flow('processDefine/page', { m_LIKE_name: 'simple' })
    assert.equal(r1.code, 0, JSON.stringify(r1))
    assert.equal(r1.data.rows.length, 1, JSON.stringify(r1))
    assert.equal(r1.data.rows[0].name, 'simple')

    const r2 = await facade.flow('processDefine/page', { m_LIKE_displayName: '简单' })
    assert.equal(r2.code, 0, JSON.stringify(r2))
    assert.equal(r2.data.rows.length, 1, JSON.stringify(r2))

    const r3 = await facade.flow('processDefine/page', { m_LIKE_displayName: '流程' })
    assert.equal(r3.code, 0, JSON.stringify(r3))
    assert.equal(r3.data.rows.length, 2, '应匹配全部: ' + JSON.stringify(r3))

    // 实例列表：m_pd_LIKE_displayName（别名 pd → pd.display_name）
    const def = await repo.findDefineByName('simple')
    await facade.flow('processInstance/startAndExecute', { processDefineId: def.id, operator: 'zhangsan' })
    const r4 = await facade.flow('processInstance/page',
      { operator: 'zhangsan', m_pd_LIKE_displayName: '简单' })
    assert.equal(r4.code, 0, JSON.stringify(r4))
    assert.equal(r4.data.rows.length, 1, JSON.stringify(r4))
    const r5 = await facade.flow('processInstance/page',
      { operator: 'zhangsan', m_pd_LIKE_displayName: 'zzz' })
    assert.equal(r5.data.rows.length, 0, JSON.stringify(r5))

    // 任务列表：m_t_LIKE_displayName（别名 t → t.display_name）
    const r6 = await facade.flow('processTask/todoList',
      { operator: 'leader', m_t_LIKE_displayName: '审批' })
    assert.equal(r6.code, 0, JSON.stringify(r6))
    assert.equal(r6.data.rows.length, 1, JSON.stringify(r6))
    const r7 = await facade.flow('processTask/todoList',
      { operator: 'leader', m_t_LIKE_displayName: 'zzz' })
    assert.equal(r7.data.rows.length, 0, JSON.stringify(r7))

    // 设计列表：无别名 m_LIKE_name（issues/05-5 process-design 页）
    await facade.flow('processDesign/save',
      { name: 'leave', displayName: '请假流程', content: c1, operator: 'zhangsan' })
    const r8 = await facade.flow('processDesign/page', { m_LIKE_name: 'leave' })
    assert.equal(r8.code, 0, JSON.stringify(r8))
    assert.equal(r8.data.rows.length, 1, JSON.stringify(r8))

    // issues/63：processDesign/page 时间格式应为 yyyy-MM-dd HH:mm:ss
    const timeRe = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
    const pageAll = await facade.flow('processDesign/page', { pageNum: 1, pageSize: 100 })
    for (const row of pageAll.data.rows) {
      assert.match(row.createTime, timeRe, `createTime should be yyyy-MM-dd HH:mm:ss, got ${row.createTime}`)
      assert.match(row.updateTime, timeRe, `updateTime should be yyyy-MM-dd HH:mm:ss, got ${row.updateTime}`)
    }
  })

  it('21 设计部署/重新部署/内容变更的 is_deployed 同步（issues/08）', async () => {
    const { engine, repo } = setup()
    const extRepo = new MemoryExtRepository()
    const facade = new JeeflowFacade(engine, repo, extRepo)
    const c1 = readFileSync(flowDir + '01-simple.json', 'utf-8')
    const c2 = readFileSync(flowDir + '02-multi-task.json', 'utf-8')

    // 保存（含内容快照）→ 未部署
    const r0 = await facade.flow('processDesign/save',
      { name: 'leave08', displayName: '请假流程08', content: c1, operator: 'zhangsan' })
    assert.equal(r0.code, 0, JSON.stringify(r0))
    const designId = r0.data.id
    assert.equal((await extRepo.findDesignById(designId))?.isDeployed, 0)

    // 部署 → is_deployed=1
    const r1 = await facade.flow('processDesign/deploy', { id: designId, operator: 'zhangsan' })
    assert.equal(r1.code, 0, JSON.stringify(r1))
    const defineId = r1.data.processDefineId
    assert.equal((await extRepo.findDesignById(designId))?.isDeployed, 1)
    const versionAfterDeploy = (await repo.findDefineById(String(defineId)))?.version

    // 重新部署 → 同一 defineId + is_deployed=1
    const r2 = await facade.flow('processDesign/redeploy', { id: designId, operator: 'zhangsan' })
    assert.equal(r2.code, 0, JSON.stringify(r2))
    assert.equal(r2.data.processDefineId, defineId, JSON.stringify(r2))
    assert.equal((await extRepo.findDesignById(designId))?.isDeployed, 1)
    // issues/59：redeploy 是替换语义，version 必须保持
    assert.equal((await repo.findDefineById(String(defineId)))?.version, versionAfterDeploy)

    // 设计稿内容变更（updateDefine，不同 content）→ 新快照 + is_deployed=0 + name 同步
    const r3 = await facade.flow('processDesign/updateDefine',
      { processDesignId: designId, content: c2, operator: 'zhangsan' })
    assert.equal(r3.code, 0, JSON.stringify(r3))
    const design = await extRepo.findDesignById(designId)
    assert.equal(design?.isDeployed, 0, JSON.stringify(design))
    assert.equal(design?.name, 'multi-task', JSON.stringify(design))
    assert.equal((await extRepo.listDesignHis(designId)).length, 2)

    // 基本信息修改（update）→ is_deployed 不变
    const r4 = await facade.flow('processDesign/update',
      { id: designId, displayName: '改名08', operator: 'zhangsan' })
    assert.equal(r4.code, 0, JSON.stringify(r4))
    const design2 = await extRepo.findDesignById(designId)
    assert.equal(design2?.displayName, '改名08')
    assert.equal(design2?.isDeployed, 0)

    // 部署 → 再置 1
    const r5 = await facade.flow('processDesign/deploy', { id: designId, operator: 'zhangsan' })
    assert.equal(r5.code, 0, JSON.stringify(r5))
    assert.equal((await extRepo.findDesignById(designId))?.isDeployed, 1)

    // issues/59 强回归：把定义 version 抬到 >0 后 redeploy 必须保持
    const defineId2 = String(r5.data.processDefineId)
    const defV1 = await repo.findDefineById(defineId2)
    if (defV1) {
      defV1.version = 5
      await repo.updateDefine(defV1)
    }
    const r6 = await facade.flow('processDesign/redeploy', { id: designId, operator: 'zhangsan' })
    assert.equal(r6.code, 0, JSON.stringify(r6))
    assert.equal((await repo.findDefineById(defineId2))?.version, 5)
  })

  it('22 表单数据契约 formData/taskFormData/审批记录 ext（issues/15）', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
    const content = readFileSync(flowDir + '01-simple.json', 'utf-8')
    const r0 = await facade.flow('processDefine/deploy', { content })
    assert.equal(r0.code, 0, JSON.stringify(r0))
    const r1 = await facade.flow('processInstance/startAndExecute',
      { processDefineId: r0.data.processDefineId, operator: 'zhangsan', f_reasonType: '休假', f_amount: 500 })
    assert.equal(r1.code, 0, JSON.stringify(r1))
    const instId = r1.data.processInstanceId

    // 实例详情：formData（f_ 前缀 + 去前缀副本）+ name/displayName/version
    const r2 = await facade.flow('processInstance/detail', { id: instId })
    assert.equal(r2.code, 0, JSON.stringify(r2))
    assert.equal(r2.data.formData?.f_reasonType, '休假', JSON.stringify(r2))
    assert.equal(r2.data.formData?.reasonType, '休假', JSON.stringify(r2))
    assert.equal(r2.data.name, 'simple', JSON.stringify(r2))
    assert.ok(r2.data.displayName && r2.data.version != null, JSON.stringify(r2))

    // 执行任务（tf_ 前缀变量）→ doneList 行 taskFormData + approvalRecord ext
    const r3 = await facade.flow('processTask/todoList', { operator: 'leader' })
    const taskId = r3.data.rows[0].id
    const r4 = await facade.flow('processTask/execute',
      { processTaskId: taskId, operator: 'leader', tf_approvalComment: '同意' })
    assert.equal(r4.code, 0, JSON.stringify(r4))
    const r5 = await facade.flow('processTask/doneList', { operator: 'leader' })
    assert.equal(r5.data.rows[0].taskFormData?.tf_approvalComment, '同意', JSON.stringify(r5))
    assert.equal(r5.data.rows[0].taskFormData?.approvalComment, '同意', JSON.stringify(r5))
    const r6 = await facade.flow('processInstance/approvalRecord', { id: instId })
    assert.equal(r6.code, 0, JSON.stringify(r6))
    assert.ok(r6.data.some((row: any) => row.ext != null), JSON.stringify(r6))
  })

  it('16 门面错误路径：未知 action / 缺扩展仓储', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo)
    const r1 = await facade.flow('foo/bar', {})
    assert.equal(r1.code, 99999999, JSON.stringify(r1))
    const r2 = await facade.flow('processDesign/page', {})
    assert.equal(r2.code, 99999999, JSON.stringify(r2))
  })

  it('12 系统代执行 flow.auto / flow.admin（v1.0.1，集成反馈④）', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '11-assignee-vars.json')
    let inst = await engine.startProcessInstanceById(def.id, 'applicant', { deptLeader: 'L001' })
    let doing = await repo.findDoingTasks(inst.id)

    // ① flow.auto 非参与者身份放行（startAndExecute 契约）
    inst = await engine.executeProcessTask(doing[0].id, 'flow.auto')
    doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing[0].taskName, 'task1', 'flow.auto 应放行执行')

    // ② 跳过 UserProvider 注入：u_userId 不会被替换成 flow.auto
    const reloaded = await repo.findInstanceById(inst.id)
    assert.equal(reloaded?.variables.u_userId, 'applicant', 'flow.auto 应跳过用户注入')

    // ③ flow.admin 放行
    inst = await engine.executeProcessTask(doing[0].id, 'flow.admin')
    doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing[0].taskName, 'task2', 'flow.admin 应放行执行')
  })

  it('23 内置参与者 handler 全链路（issues/16）', async () => {
    const repo = new MemoryRepository()
    const userProv: UserProvider = {
      async getUser(userId) { return { userId, realName: '用户' + userId, deptId: 'D01', deptName: '测试部门', postId: 'P01', postName: '测试岗位' } },
    }
    const orgProv = {
      async findDeptLeaders(deptId: string) { return deptId === 'D01' ? ['leader1', 'leader2'] : [] },
      async findDeptMainLeaders(deptId: string) { return deptId === 'D01' ? ['boss1'] : [] },
      async findByRole(roleCode: string) { return roleCode === 'task4' ? ['roleA', 'roleB'] : [] },
    }
    const registry = new HandlerRegistry()
    registerBuiltinAssignments(registry, userProv, orgProv)
    const idGen = { nextId() { return String(Date.now() * 1000 + Math.floor(Math.random() * 1000)) } }
    const exprEval: ExpressionEvaluator = {
      async eval(expr, vars) {
        const amt = Number(vars.amount ?? 0)
        if (expr === 'amount > 1000') return amt > 1000
        if (expr === 'amount <= 1000') return amt <= 1000
        return false
      },
    }
    const engine = new EngineImpl(repo, userProv, idGen, exprEval)
    engine.setRegistry(registry)
    const def = loadFlow(repo, '11-assignment-handler.json')

    // ① FormFieldAssigneeHandler：节点 task1 → args.task1 = userA,userB
    let inst = await engine.startProcessInstanceById(def.id, 'user1', { task1: 'userA,userB' })
    let doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing[0].taskName, 'task1')
    assert.deepEqual([...doing[0].actorIds].sort(), ['userA', 'userB'], `① formField actors: ${doing[0].actorIds}`)
    await repo.addTaskActor(doing[0].id, doing[0].actorIds)
    await engine.executeProcessTask(doing[0].id, 'userA')

    // ② OperatorAssignmentHandler：task2 → 发起人 user1
    doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing[0].taskName, 'task2')
    assert.deepEqual(doing[0].actorIds, ['user1'], `② operator actors: ${doing[0].actorIds}`)
    await repo.addTaskActor(doing[0].id, doing[0].actorIds)
    await engine.executeProcessTask(doing[0].id, 'user1')

    // ③ DeptLeaderAssignmentHandler：task3 → user1 部门 D01 领导
    doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing[0].taskName, 'task3')
    assert.deepEqual([...doing[0].actorIds].sort(), ['leader1', 'leader2'], `③ deptLeader actors: ${doing[0].actorIds}`)
    await repo.addTaskActor(doing[0].id, doing[0].actorIds)
    await engine.executeProcessTask(doing[0].id, 'leader1')

    // ④ TaskRoleAssigneeHandler：task4 → roleCode=task4 → roleA,roleB
    doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing[0].taskName, 'task4')
    assert.deepEqual([...doing[0].actorIds].sort(), ['roleA', 'roleB'], `④ taskRole actors: ${doing[0].actorIds}`)
    await repo.addTaskActor(doing[0].id, doing[0].actorIds)
    inst = await engine.executeProcessTask(doing[0].id, 'roleA')

    // ⑤ 流程结束
    assert.equal(inst?.state, InstanceState.Done, `⑤ state: ${inst?.state}`)
  })

  it('24 candidatePage 双源候选（issues/16 GlobalCandidateHandler 语义）', async () => {
    const repo = new MemoryRepository()
    const idGen = { nextId() { return String(Date.now() * 1000 + Math.floor(Math.random() * 1000)) } }
    const exprEval: ExpressionEvaluator = {
      async eval() { return false },
    }
    const engine = new EngineImpl(repo, undefined, idGen, exprEval)
    const facade = new JeeflowFacade(engine, repo, undefined)
    facade.setOrgProvider({
      async findDeptLeaders() { return [] },
      async findDeptMainLeaders() { return [] },
      async findByRole(roleCode: string) { return roleCode === 'finance' ? ['finA', 'finB'] : [] },
    })

    const r0 = await facade.flow('processDefine/deploy', { content: readFileSync(flowDir + '12-candidate-page.json', 'utf-8') })
    assert.equal(r0.code, 0, JSON.stringify(r0))
    const def = await repo.findDefineByName('candidate-flow')
    assert.ok(def, 'define should exist')

    // 直接启动（不自动完成 apply）→ apply 任务 → candidatePage 查 review 候选
    const inst = await engine.startProcessInstanceById(def!.id, 'user1')
    const doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing[0].taskName, 'apply')
    const r = await facade.flow('processTask/candidatePage', { processTaskId: doing[0].id })
    assert.equal(r.code, 0, JSON.stringify(r))
    const userIds = (r.data.rows as Array<{ userId: string }>).map(x => x.userId).sort()
    assert.deepEqual(userIds, ['finA', 'finB', 'userA', 'userB'],
      `候选应为 candidateUsers(userA/userB) + candidateGroups(finA/finB): ${userIds}`)
  })

  it('25 startAndExecute 预指派人 f_nextNodeOperator（对齐 boot3）', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, undefined)
    const r0 = await facade.flow('processDefine/deploy', { content: readFileSync(flowDir + '01-simple.json', 'utf-8') })
    assert.equal(r0.code, 0, JSON.stringify(r0))
    const def = await repo.findDefineByName('simple')
    assert.ok(def)

    // 预指派人：f_nextNodeOperator=userA → task1 参与者 = userA
    const r1 = await facade.flow('processInstance/startAndExecute', {
      processDefineId: def!.id, operator: 'user1', f_nextNodeOperator: 'userA',
    })
    assert.equal(r1.code, 0, JSON.stringify(r1))
    const doing1 = await repo.findDoingTasks(r1.data.processInstanceId)
    assert.equal(doing1[0].taskName, 'task1')
    assert.deepEqual(doing1[0].actorIds, ['userA'], `预指派后 task1 参与者应为 userA: ${doing1[0].actorIds}`)

    // 未指定 → task1 参与者 = leader
    const r2 = await facade.flow('processInstance/startAndExecute', {
      processDefineId: def!.id, operator: 'user1',
    })
    assert.equal(r2.code, 0, JSON.stringify(r2))
    const doing2 = await repo.findDoingTasks(r2.data.processInstanceId)
    assert.equal(doing2[0].taskName, 'task1')
    assert.deepEqual(doing2[0].actorIds, ['leader'], `未指定时 task1 参与者应为 leader: ${doing2[0].actorIds}`)
  })

  it('26 Java 雪花 id（>2^53）跨语言共享（issue 38 E9）：string id 全程直通', async () => {
    const { engine, repo } = setup()
    // Java 雪花 id：2084320543834124290 ≈ 2.08e18 > Number.MAX_SAFE_INTEGER（2^53）
    const SNOWFLAKE = '2084320543834124290'
    const def: ProcessDefine = {
      id: SNOWFLAKE, name: 'snow-flow', displayName: '雪花流程', type: 'approval',
      state: 1, content: readFileSync(flowDir + '01-simple.json', 'utf-8'),
      version: 1, createTime: new Date(), updateTime: new Date(), createUser: '', updateUser: '',
    }
    repo.addDefine(def)
    // 按 string id 发起（前端从列表拿到 id 即 string，不做 Number() 转换）
    const inst = await engine.startProcessInstanceById(SNOWFLAKE, 'user1')
    assert.equal(inst.defineId, SNOWFLAKE, `defineId 必须原样保留: ${inst.defineId}`)
    const doing = await repo.findDoingTasks(inst.id)
    assert.ok(doing.length > 0, '应创建任务')
    await repo.addTaskActor(doing[0].id, ['user1'])
    await engine.executeProcessTask(doing[0].id, 'user1')
    // 01-simple 双任务：继续完成 task1 → end
    const doing2 = await repo.findDoingTasks(inst.id)
    assert.ok(doing2.length > 0, 'task1 应创建')
    await repo.addTaskActor(doing2[0].id, ['user1'])
    await engine.executeProcessTask(doing2[0].id, 'user1')
    const finished = await repo.findInstanceById(inst.id)
    assert.equal(finished?.state, InstanceState.Done, '流程应结束')
    // facade 全链路：startAndExecute 传字符串雪花 id
    const facade = new JeeflowFacade(engine, repo, undefined)
    const r = await facade.flow('processInstance/startAndExecute', {
      processDefineId: SNOWFLAKE, operator: 'user1',
    })
    assert.equal(r.code, 0, JSON.stringify(r))
    // 返回 id 必须是 string（JS number 无法承载雪花值，前端回传必须用字符串）
    assert.equal(typeof r.data.processInstanceId, 'string', JSON.stringify(r))
  })

  it('27 highLight nodeProgress 成员进度回显（issue 41）', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
    // 顺序会签流程：apply(applicant) → task1(userA,userB SEQUENTIAL) → end
    const r0 = await facade.flow('processDefine/deploy', { content: readFileSync(flowDir + '06-countersign-sequential.json', 'utf-8') })
    assert.equal(r0.code, 0, JSON.stringify(r0))
    const r1 = await facade.flow('processInstance/startAndExecute', { processDefineId: r0.data.processDefineId, operator: 'user1' })
    assert.equal(r1.code, 0, JSON.stringify(r1))
    const hl = await facade.flow('processInstance/highLight', { id: r1.data.processInstanceId })
    assert.equal(hl.code, 0, JSON.stringify(hl))
    const np = hl.data.nodeProgress as Record<string, any>
    // 历史节点 apply：发起人 done
    assert.equal(np.apply.members[0].id, 'user1')
    assert.equal(np.apply.members[0].done, true)
    // 顺序会签进行中：type=SEQUENTIAL、第一位 active、第二位未标记
    assert.equal(np.task1.type, 'SEQUENTIAL')
    assert.equal(np.task1.members[0].id, 'userA')
    assert.equal(np.task1.members[0].active, true)
    // 姓名走 UserProvider SPI 解析（setup userProv realName = '用户' + id）
    assert.equal(np.task1.members[0].name, '用户userA', `name 应经 SPI 解析: ${np.task1.members[0].name}`)
    assert.equal(np.task1.members[1].id, 'userB')
    assert.equal(np.task1.members[1].done, undefined)
    assert.equal(np.task1.members[1].active, undefined)
    // 推进会签：完成 userA → userB active
    const doing1 = await repo.findDoingTasks(r1.data.processInstanceId)
    await repo.addTaskActor(doing1[0].id, ['userA'])
    await engine.executeProcessTask(doing1[0].id, 'userA')
    const hl2 = await facade.flow('processInstance/highLight', { id: r1.data.processInstanceId })
    const np2 = hl2.data.nodeProgress as Record<string, any>
    assert.equal(np2.task1.members[0].done, true, 'userA 应 done')
    assert.equal(np2.task1.members[1].active, true, 'userB 应 active')
    // 全部完成 → 全部 done
    const doing2 = await repo.findDoingTasks(r1.data.processInstanceId)
    await repo.addTaskActor(doing2[0].id, ['userB'])
    await engine.executeProcessTask(doing2[0].id, 'userB')
    const hl3 = await facade.flow('processInstance/highLight', { id: r1.data.processInstanceId })
    const np3 = hl3.data.nodeProgress as Record<string, any>
    assert.equal(np3.task1.members[0].done, true)
    assert.equal(np3.task1.members[1].done, true)
    assert.equal(np3.task1.members[1].active, undefined)
  })

  it('28 performType 字符串兼容（issue 42）：ALL 面板格式会签行为与数字 1 一致', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
    // 面板格式：performType 存 'ALL' 字符串（Java codeOf 契约）
    const contentAll = readFileSync(flowDir + '05-countersign-parallel.json', 'utf-8')
      .replace('\"performType\": 1', '\"performType\": \"ALL\"')
    const r0 = await facade.flow('processDefine/deploy', { content: contentAll })
    assert.equal(r0.code, 0, JSON.stringify(r0))
    const r1 = await facade.flow('processInstance/startAndExecute', { processDefineId: r0.data.processDefineId, operator: 'user1' })
    assert.equal(r1.code, 0, JSON.stringify(r1))
    // 并行会签：3 参与者 → 3 个任务（普通语义只有 1 个）
    const doing = await repo.findDoingTasks(r1.data.processInstanceId)
    const csTasks = doing.filter(t => t.taskName === 'task1')
    assert.equal(csTasks.length, 3, `ALL 格式应生成 3 个会签任务: ${csTasks.length}`)
    assert.deepEqual(csTasks.map(t => t.actorIds[0]).sort(), ['userA', 'userB', 'userC'])
    // 数字 1 格式对照：行为一致
    const r2 = await facade.flow('processDefine/deploy', { content: readFileSync(flowDir + '05-countersign-parallel.json', 'utf-8') })
    const r3 = await facade.flow('processInstance/startAndExecute', { processDefineId: r2.data.processDefineId, operator: 'user1' })
    const doing2 = await repo.findDoingTasks(r3.data.processInstanceId)
    assert.equal(doing2.filter(t => t.taskName === 'task1').length, 3, '数字 1 格式同样 3 个会签任务')
    // nodeProgress 对 ALL 格式同样识别为会签（type=PARALLEL）
    const hl = await facade.flow('processInstance/highLight', { id: r3.data.processInstanceId })
    assert.equal(hl.code, 0, JSON.stringify(hl))
    assert.equal(hl.data.nodeProgress.task1.type, 'PARALLEL')
  })

  it('29 E2E 反馈回归：撤回状态 30 / 会签 performType 落库 / 发起抄送（issues 53/52/56）', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
    // 56：发起时抄送 f_ccActors
    const r0 = await facade.flow('processDefine/deploy', { content: readFileSync(flowDir + '01-simple.json', 'utf-8') })
    const r1 = await facade.flow('processInstance/startAndExecute', {
      processDefineId: r0.data.processDefineId, operator: 'user1', f_ccActors: 'wangqiang,zhaomin',
    })
    assert.equal(r1.code, 0, JSON.stringify(r1))
    const cc = await repo.pageCcInstances(1, 10, 'wangqiang')
    assert.ok(cc.total >= 1, `抄送应创建: ${cc.total}`)
    // 52：会签任务 performType 落库
    const r2 = await facade.flow('processDefine/deploy', { content: readFileSync(flowDir + '05-countersign-parallel.json', 'utf-8') })
    const r3 = await facade.flow('processInstance/startAndExecute', { processDefineId: r2.data.processDefineId, operator: 'user1' })
    const doing = await repo.findDoingTasks(r3.data.processInstanceId)
    const cs = doing.filter(t => t.taskName === 'task1')
    assert.ok(cs.length === 3 && cs.every(t => t.performType === 1), `会签任务 performType 应=1: ${cs.map(t => t.performType)}`)
    // 53：撤回状态 30
    const r4 = await facade.flow('processDefine/deploy', { content: readFileSync(flowDir + '01-simple.json', 'utf-8') })
    const r5 = await facade.flow('processInstance/startAndExecute', { processDefineId: r4.data.processDefineId, operator: 'user1' })
    const wr = await facade.flow('processInstance/withdraw', { id: r5.data.processInstanceId, operator: 'user1' })
    assert.equal(wr.code, 0, JSON.stringify(wr))
    const after = await repo.findInstanceById(r5.data.processInstanceId)
    assert.equal(after?.state, InstanceState.Withdraw, `撤回状态应为 30: ${after?.state}`)
    assert.equal(await repo.findDoingTasks(r5.data.processInstanceId).then(x => x.length), 0, '撤回后无 doing')
  })

  it('30 分页信封五键（issues/64）', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
    const empty = await facade.flow('processDefine/page', { pageNum: 1, pageSize: 10 })
    assert.equal(empty.code, 0, JSON.stringify(empty))
    for (const k of ['pageNum', 'pageSize', 'rows', 'recordCount', 'totalPage']) {
      assert.ok(k in empty.data, `缺 ${k}: ${JSON.stringify(empty.data)}`)
    }
    assert.equal(empty.data.recordCount, 0)
    assert.equal(empty.data.totalPage, 0)
    await facade.flow('processDefine/deploy', { content: readFileSync(flowDir + '01-simple.json', 'utf-8') })
    const r = await facade.flow('processDefine/page', { pageNum: 1, pageSize: 1 })
    assert.equal(r.code, 0, JSON.stringify(r))
    assert.equal(r.data.pageNum, 1)
    assert.equal(r.data.pageSize, 1)
    assert.ok(r.data.recordCount >= 1)
    assert.equal(r.data.totalPage, r.data.recordCount)
  })

  it('31 MysqlAdapter 分页走 query 而非 execute（issues/66）', async () => {
    const { MysqlConnection } = await import('../src/jdbc/mysql.js')
    let executeCalls = 0
    let queryCalls = 0
    const fake = {
      async execute() {
        executeCalls++
        throw new Error('Incorrect arguments to mysqld_stmt_execute')
      },
      async query(_sql: string, _args: any[]) {
        queryCalls++
        return [[{ id: '1' }], []]
      },
    }
    const conn = new MysqlConnection(fake as any)
    const rows = await conn.fetchAll('SELECT id FROM wf_process_define t WHERE 1=1 ORDER BY t.id DESC LIMIT ? OFFSET ?', [5, 0])
    assert.equal(executeCalls, 0, '不得走 mysql2 execute（LIMIT 预处理会失败）')
    assert.equal(queryCalls, 1)
    assert.equal(rows[0].id, '1')
    await conn.execute('INSERT INTO t (id) VALUES (?)', ['2'])
    assert.equal(executeCalls, 0)
    assert.equal(queryCalls, 2)
  })
})

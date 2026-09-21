import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EngineImpl, KeyAutoGenTitle, KeyRealName, KeyUserID } from '../src/engine.js'
import { HandlerRegistry, registerBuiltinAssignments } from '../src/index.js'
import { MemoryRepository } from '../src/memory.js'
import { MemoryExtRepository } from '../src/memory-ext.js'
import { JeeflowFacade } from '../src/facade.js'
import { InstanceState, TaskState, SubmitType, type ProcessDefine, ProcessInstance, ProcessTask } from '../src/model.js'
import type { ExpressionEvaluator, UserProvider } from '../src/spi.js'
import { type FlowInterceptor, EventType, type EngineExtensions } from '../src/extensions.js'
import { dir as flowsResolverDir } from '../flows-resolver.js'
import { runParity } from './surrparity.js'

const flowDir = flowsResolverDir() + '/'

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

  it('02B issues/97 实例 u_realName 恒为发起人（execute 不覆盖实例 u_*，对齐 Java）', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '02-multi-task.json')
    // 发起人 alice 发起并自动完成 apply
    const inst = await startAndExecute(engine, repo, def.id, 'alice')
    assert.equal(inst.variables[KeyRealName], '用户alice', 'start: 实例 u_realName=发起人 alice')

    // 第一审批节点 bob 办理
    let doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing[0].taskName, 'task1')
    await repo.addTaskActor(doing[0].id, ['bob'])
    doing[0].actorIds.push('bob')
    const doneTaskId = doing[0].id
    const instAfter = await engine.executeProcessTask(doneTaskId, 'bob')

    // 核心：实例 u_realName 不被操作人 bob 覆盖，恒为发起人 alice
    assert.equal(instAfter.variables[KeyRealName], '用户alice', `issues/97: 实例 u_realName 漂移为 ${instAfter.variables[KeyRealName]}`)
    assert.equal(instAfter.variables[KeyUserID], 'alice', `issues/97: 实例 u_userId 漂移为 ${instAfter.variables[KeyUserID]}`)
    // autoGenTitle 前缀（发起人）与实例 u_realName 一致
    assert.ok(String(instAfter.variables[KeyAutoGenTitle]).startsWith('用户alice的'), `autoGenTitle 前缀应为发起人: ${instAfter.variables[KeyAutoGenTitle]}`)
    // 任务行 ext（facade 操作人来源）保留操作人 bob 的 u_*
    const doneTask = await repo.findTaskById(doneTaskId)
    assert.equal(doneTask?.variables[KeyRealName], '用户bob', `issues/97: 任务行 u_realName 应为操作人 bob, got ${doneTask?.variables[KeyRealName]}`)

    // 深层节点再办一次（userB 办 task2），实例 u_realName 仍为 alice
    doing = await repo.findDoingTasks(instAfter.id)
    assert.equal(doing[0].taskName, 'task2')
    await repo.addTaskActor(doing[0].id, ['userB'])
    doing[0].actorIds.push('userB')
    const instDeep = await engine.executeProcessTask(doing[0].id, 'userB')
    assert.equal(instDeep.variables[KeyRealName], '用户alice', `issues/97: 深层节点后实例 u_realName 应仍为 alice, got ${instDeep.variables[KeyRealName]}`)
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

  it('10b TASK_CREATE 事件（落库后 fire / 会签逐任务，对齐 Java CreateTaskHandler / Rust）', async () => {
    const creates: Array<{ taskId?: string; nodeId?: string; instanceId: string; operator: string }> = []
    const { engine, repo } = setup()
    engine.setExtensions({
      listeners: [(e) => { if (e.type === EventType.TaskCreate) creates.push(e) }],
    })
    // ① 普通任务：01-simple startAndExecute → apply 完成 → task1 创建（共 2 个）
    const def = loadFlow(repo, '01-simple.json')
    const inst = await startAndExecute(engine, repo, def.id, 'applicant')
    assert.strictEqual(creates.length, 2, `want 2 TASK_CREATE (apply+task1), got ${creates.length}`)
    for (const c of creates) {
      const t = await repo.findTaskById(c.taskId!)
      assert.ok(t, `TASK_CREATE taskId=${c.taskId} 落库后可反查（fire 时机过早）`)
      assert.ok(c.instanceId === inst.id && c.nodeId && c.operator, `事件字段齐全: ${JSON.stringify(c)}`)
      assert.ok(t.actorIds.length > 0, `任务 actor 非空: ${t.actorIds}`)
    }
    creates.length = 0
    // ② 并行会签：userA/userB/userC 三人逐任务 fire（apply + 3 会签 = 4）
    const defPar = loadFlow(repo, '05-countersign-parallel.json')
    await startAndExecute(engine, repo, defPar.id, 'applicant')
    assert.strictEqual(creates.length, 4, `want 4 TASK_CREATE (apply+3会签), got ${creates.length}`)
    const seen = new Set<string>()
    for (const c of creates.slice(1)) {
      const t = await repo.findTaskById(c.taskId!)
      assert.ok(t, `会签 TASK_CREATE taskId=${c.taskId} 落库后可反查`)
      assert.ok(c.nodeId, `会签事件 nodeId 非空`)
      seen.add(c.taskId!)
    }
    assert.strictEqual(seen.size, 3, `会签 TaskID 互不相同（逐任务 fire）: ${[...seen]}`)
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

    // withdraw 级联撤回 doing → 任务态 30（WITHDRAW）
    const r3 = await facade.flow('processInstance/startAndExecute',
      { processDefineId: defineId, operator: 'zhangsan' })
    const instanceId2 = r3.data.processInstanceId
    const beforeWithdraw = await repo.findDoingTasks(instanceId2)
    assert.ok(beforeWithdraw.length >= 1, '撤回前应有 doing 任务')
    const r4 = await facade.flow('processInstance/withdraw', { id: instanceId2, operator: 'zhangsan' })
    assert.equal(r4.code, 0, JSON.stringify(r4))
    doing = await repo.findDoingTasks(instanceId2)
    assert.equal(doing.length, 0, '撤回应清空 doing 任务')
    // issues/113：原 doing 任务须落 30，不能落 99——"doing 清空"这一断言两种码值都满足，抓不到缺陷
    for (const t of beforeWithdraw) {
      const stored = await repo.findTaskById(t.id)
      assert.equal(stored?.taskState, TaskState.Withdraw,
        `撤回任务态应=30(WITHDRAW)，实测 ${stored?.taskState}（99 是废弃码，两码不得混用）`)
    }
    assert.equal((await repo.findInstanceById(instanceId2))?.state, InstanceState.Withdraw, '实例态应=30')
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

  it('门面委托生效判断（issues/82-12）：时间窗 startTime/endTime + enabled 过滤（对齐 Java 基准）', async () => {
    const { engine, repo } = setup()
    const extRepo = new MemoryExtRepository()
    const facade = new JeeflowFacade(engine, repo, extRepo)
    const op = 'winop'

    const save = async (sur: string, pn: string, extra: Record<string, any> = {}) => {
      const r = await facade.flow('processSurrogate/save',
        { operator: op, surrogate: sur, processName: pn, enabled: 1, ...extra })
      assert.equal(r.code, 0, JSON.stringify(r))
    }

    // A 在窗（2026-08-01 ~ 08-31）
    await save('sA', 'winA', { startTime: '2026-08-01 00:00:00', endTime: '2026-08-31 23:59:59' })
    // B 未到（2026-09-01 起）
    await save('sB', 'winB', { startTime: '2026-09-01 00:00:00' })
    // C 已过（07-31 止）
    await save('sC', 'winC', { endTime: '2026-07-31 23:59:59' })
    // D 无窗但停用（enabled=0）
    await save('sD', 'winD', { enabled: 0 })
    // E 无窗且启用（enabled=1）
    await save('sE', 'winE')

    const at = new Date(2026, 7, 15, 12, 0, 0)
    const hitA = await extRepo.getSurrogate(op, 'winA', at)
    assert.equal(hitA?.surrogate, 'sA', '在窗委托应生效')
    assert.equal(await extRepo.getSurrogate(op, 'winB', at), null, '未到窗委托不应生效')
    assert.equal(await extRepo.getSurrogate(op, 'winC', at), null, '已过窗委托不应生效')
    assert.equal(await extRepo.getSurrogate(op, 'winD', at), null, 'enabled=0 不应生效')
    const hitE = await extRepo.getSurrogate(op, 'winE', at)
    assert.equal(hitE?.surrogate, 'sE', '无窗启用委托应生效（NULL=不限）')
    assert.equal(await extRepo.getSurrogate(op, 'winZ', at), null, '无匹配流程应返回 null')

    // 换时间验证窗口边界随时间变化：B 在 9 月生效、A 在 9 月失效
    const atSep = new Date(2026, 8, 15, 12, 0, 0)
    const hitB = await extRepo.getSurrogate(op, 'winB', atSep)
    assert.equal(hitB?.surrogate, 'sB', '9 月：B 进入窗口应生效')
    assert.equal(await extRepo.getSurrogate(op, 'winA', atSep), null, '9 月：A 已出窗口不应生效')
  })

  it('门面委托编辑链路（issues/77）：save(空格格式时间窗)→detail 回显→update 改字段→detail 再回显 + 负向', async () => {
    const { engine, repo } = setup()
    const extRepo = new MemoryExtRepository()
    const facade = new JeeflowFacade(engine, repo, extRepo)

    // 新增（带时间窗，前端 RangePicker 实际提交的 yyyy-MM-dd HH:mm:ss 空格格式）
    const r1 = await facade.flow('processSurrogate/save',
      { operator: 'zhangsan', surrogate: 'lisi', processName: 'leave',
        startTime: '2026-08-01 00:00:00', endTime: '2026-08-31 23:59:59', enabled: 1 })
    assert.equal(r1.code, 0, JSON.stringify(r1))
    const surrogateId = r1.data.id

    // detail 回显：行结构齐全 + 时间格式化
    const d1 = await facade.flow('processSurrogate/detail', { id: surrogateId })
    assert.equal(d1.code, 0, JSON.stringify(d1))
    assert.equal(d1.data.processName, 'leave')
    assert.equal(d1.data.operator, 'zhangsan')
    assert.equal(d1.data.surrogate, 'lisi')
    assert.equal(d1.data.startTime, '2026-08-01 00:00:00', JSON.stringify(d1.data))
    assert.equal(d1.data.endTime, '2026-08-31 23:59:59', JSON.stringify(d1.data))

    // update：改代理人/时间窗/启用状态（不带 operator，授权人应保留）
    const r2 = await facade.flow('processSurrogate/update',
      { id: surrogateId, surrogate: 'wangwu', processName: 'leave',
        startTime: '2026-09-01 00:00:00', endTime: '2026-09-30 23:59:59', enabled: 0 })
    assert.equal(r2.code, 0, JSON.stringify(r2))
    assert.equal(r2.data.id, surrogateId)

    // detail 再回显：变更生效 + 授权人未被清空
    const d2 = await facade.flow('processSurrogate/detail', { id: surrogateId })
    assert.equal(d2.code, 0, JSON.stringify(d2))
    assert.equal(d2.data.surrogate, 'wangwu', JSON.stringify(d2.data))
    assert.equal(d2.data.operator, 'zhangsan', JSON.stringify(d2.data))
    assert.equal(d2.data.enabled, 0, JSON.stringify(d2.data))
    assert.equal(d2.data.startTime, '2026-09-01 00:00:00', JSON.stringify(d2.data))
    assert.equal(d2.data.endTime, '2026-09-30 23:59:59', JSON.stringify(d2.data))

    // 仓储侧同步（update 真的写了）
    const s = await extRepo.findSurrogateById(surrogateId)
    assert.ok(s, 'repo should have surrogate')
    assert.equal(s.surrogate, 'wangwu')
    assert.equal(s.enabled, 0)

    // 负向：id 不存在
    const e1 = await facade.flow('processSurrogate/detail', { id: '99999' })
    assert.equal(e1.code, 99999999, JSON.stringify(e1))
    const e2 = await facade.flow('processSurrogate/update', { id: '99999', surrogate: 'wangwu' })
    assert.equal(e2.code, 99999999, JSON.stringify(e2))
    // 负向：update 缺 id
    const e3 = await facade.flow('processSurrogate/update', { surrogate: 'wangwu' })
    assert.equal(e3.code, 99999999, JSON.stringify(e3))
  })

  it('委托删除 {ids} 批量（issues/95）：行内/批量统一走 ids，单 id 保留兼容', async () => {
    const { engine, repo } = setup()
    const extRepo = new MemoryExtRepository()
    const facade = new JeeflowFacade(engine, repo, extRepo)

    const save = async (op: string, agent: string, name: string) => {
      const r = await facade.flow('processSurrogate/save', { operator: op, surrogate: agent, processName: name })
      assert.equal(r.code, 0, JSON.stringify(r))
      return String(r.data.id)
    }
    const gone = async (id: string, label: string) => {
      assert.equal(await extRepo.findSurrogateById(id), null, `${label} 应已删除`)
    }

    const a = await save('zhangsan', 'lisiA', 'leaveA')
    const b = await save('zhangsan', 'lisiB', 'leaveB')
    assert.equal((await facade.flow('processSurrogate/remove', { ids: [a, b] })).code, 0)
    await gone(a, '批量 a')
    await gone(b, '批量 b')

    // 行内删除：前端同样走 {ids}，长度 1
    const c = await save('lisiC', 'lisiD', 'leaveC')
    assert.equal((await facade.flow('processSurrogate/remove', { ids: [c] })).code, 0)
    await gone(c, '行内 c')

    // 单 {id} 兼容形态回归（移动端 workflow.uts 发这个）
    const d = await save('zhangsan', 'lisiE', 'leaveD')
    assert.equal((await facade.flow('processSurrogate/remove', { id: d })).code, 0)
    await gone(d, '单 id d')
  })

  it('{ids}/{id} 缺失或空数组一律报错，禁止静默成功（issues/95 §5②）', async () => {
    const { engine, repo } = setup()
    const extRepo = new MemoryExtRepository()
    const facade = new JeeflowFacade(engine, repo, extRepo)

    const cases: Array<[string, Record<string, any>]> = [
      ['processSurrogate/remove', { ids: [] }],
      ['processSurrogate/remove', { surrogate: 'lisi' }],
      ['processSurrogate/remove', { ids: ['123', null] }],
      ['processDefine/remove', { ids: [] }],
      ['processDesign/remove', { ids: [] }],
      ['processDefine/upAndDown', { ids: [], opType: 0 }],
    ]
    for (const [action, args] of cases) {
      const r = await facade.flow(action, args)
      assert.equal(r.code, 99999999, `${action} ${JSON.stringify(args)} → ${JSON.stringify(r)}`)
      assert.ok(String(r.msg).includes('id 缺失或非法'), `${action} msg=${r.msg}`)
    }
  })

  // ── issues/96 §4B：入口参数形态矩阵（四 action × 四态）──────────────────────────
  // 补测动机：既有门面用例历史上全发单数 {id}，引擎完全不认 {ids} 也照样全绿
  // （issues/95 六语言集体漏检的根因）。每个 action 逐一断言前端 IdsParam 真实载荷。

  it('入口形态矩阵 processSurrogate/remove（issues/96 §4B）：ids 批量 / 单 id / 空数组 / 含空值', async () => {
    const { engine, repo } = setup()
    const extRepo = new MemoryExtRepository()
    const facade = new JeeflowFacade(engine, repo, extRepo)

    // 造数：时间窗用前端 RangePicker 实际提交的 yyyy-MM-dd HH:mm:ss 空格格式
    const save = async (tag: string) => {
      const r = await facade.flow('processSurrogate/save', {
        operator: 'zhangsan', surrogate: 'agent' + tag, processName: 'leave' + tag,
        startTime: '2026-08-01 00:00:00', endTime: '2026-08-31 23:59:59', enabled: 1 })
      assert.equal(r.code, 0, JSON.stringify(r))
      return String(r.data.id)
    }
    // 事后回查：仓储取不到 + 门面 detail 也取不到
    const gone = async (id: string, label: string) => {
      assert.equal(await extRepo.findSurrogateById(id), null, `${label} 仓储侧应已删除`)
      const d = await facade.flow('processSurrogate/detail', { id })
      assert.equal(d.code, 99999999, `${label} 门面 detail 应取不到: ${JSON.stringify(d)}`)
    }
    // 负向：必须报错且 msg 含「id 缺失或非法」，禁止静默成功
    const rejected = async (args: Record<string, any>, label: string) => {
      const r = await facade.flow('processSurrogate/remove', args)
      assert.equal(r.code, 99999999, `${label} 应报错: ${JSON.stringify(r)}`)
      assert.ok(String(r.msg).includes('id 缺失或非法'), `${label} msg=${r.msg}`)
    }

    // 态 1：{ids:[a,b]} —— Web 端「我的委托」勾选批量删除的真实载荷
    const a = await save('A')
    const b = await save('B')
    const r1 = await facade.flow('processSurrogate/remove', { ids: [a, b] })
    assert.equal(r1.code, 0, JSON.stringify(r1))
    await gone(a, '批量 a')
    await gone(b, '批量 b')

    // 态 2：{id:c} —— 单数旧形态回归保护（移动端 workflow.uts 发这个）
    const c = await save('C')
    const r2 = await facade.flow('processSurrogate/remove', { id: c })
    assert.equal(r2.code, 0, JSON.stringify(r2))
    await gone(c, '单 id c')

    // 态 3：{ids:[]} 空数组
    await rejected({ ids: [] }, '空数组')
    // 态 4：{ids:['']} 与含 null 的数组
    await rejected({ ids: [''] }, '含空串')
    await rejected({ ids: ['123', null] }, '含 null')

    // 副作用检查：负向请求不得删数据（此时 a/b/c 已删，库里只剩 1 条）
    const d = await save('D')
    const p = await facade.flow('processSurrogate/page', { operator: 'zhangsan' })
    assert.equal(p.code, 0, JSON.stringify(p))
    assert.equal(p.data.recordCount, 1, `负向请求不应删数据: ${JSON.stringify(p.data)}`)
    assert.equal((await facade.flow('processSurrogate/remove', { ids: [d] })).code, 0)
  })

  it('入口形态矩阵 processDesign/remove（issues/96 §4B）：ids 批量 / 单 id / 空数组 / 含空值', async () => {
    const { engine, repo } = setup()
    const extRepo = new MemoryExtRepository()
    const facade = new JeeflowFacade(engine, repo, extRepo)
    const content = readFileSync(flowDir + '01-simple.json', 'utf-8')

    const saveDesign = async (tag: string) => {
      const r = await facade.flow('processDesign/save',
        { name: 'draft' + tag, displayName: '设计稿' + tag, content, operator: 'zhangsan' })
      assert.equal(r.code, 0, JSON.stringify(r))
      return String(r.data.id)
    }
    const gone = async (id: string, label: string) => {
      assert.equal(await extRepo.findDesignById(id), null, `${label} 仓储侧应已删除`)
      const d = await facade.flow('processDesign/detail', { id })
      assert.equal(d.code, 99999999, `${label} 门面 detail 应取不到: ${JSON.stringify(d)}`)
    }
    const rejected = async (args: Record<string, any>, label: string) => {
      const r = await facade.flow('processDesign/remove', args)
      assert.equal(r.code, 99999999, `${label} 应报错: ${JSON.stringify(r)}`)
      assert.ok(String(r.msg).includes('id 缺失或非法'), `${label} msg=${r.msg}`)
    }

    // 态 1：{ids:[a,b]} 批量
    const a = await saveDesign('A')
    const b = await saveDesign('B')
    const r1 = await facade.flow('processDesign/remove', { ids: [a, b] })
    assert.equal(r1.code, 0, JSON.stringify(r1))
    await gone(a, '批量 a')
    await gone(b, '批量 b')

    // 态 2：{id:c} 单数回归
    const c = await saveDesign('C')
    const r2 = await facade.flow('processDesign/remove', { id: c })
    assert.equal(r2.code, 0, JSON.stringify(r2))
    await gone(c, '单 id c')

    // 态 3 + 态 4
    await rejected({ ids: [] }, '空数组')
    await rejected({ ids: [''] }, '含空串')
    await rejected({ ids: ['123', null] }, '含 null')

    // 副作用检查：态 3/4 不应动到未删的设计稿
    const d = await saveDesign('D')
    assert.ok(await extRepo.findDesignById(d), '负向请求不应删除设计稿')
  })

  it('入口形态矩阵 processDefine/remove（issues/96 §4B）：ids 批量 / 单 id / 空数组 / 含空值', async () => {
    const { engine, repo } = setup()
    const extRepo = new MemoryExtRepository()
    const facade = new JeeflowFacade(engine, repo, extRepo)

    // 造数：设计稿 save → updateDefine（内容快照）→ deploy，再 processDefine/getLastByName 回查命中
    const deployDefine = async (file: string) => {
      const content = readFileSync(flowDir + file, 'utf-8')
      const flowName: string = JSON.parse(content).name
      const s = await facade.flow('processDesign/save',
        { name: 'draft-' + flowName, displayName: '草稿' + flowName, content, operator: 'zhangsan' })
      assert.equal(s.code, 0, JSON.stringify(s))
      const u = await facade.flow('processDesign/updateDefine',
        { processDesignId: s.data.id, content, operator: 'zhangsan' })
      assert.equal(u.code, 0, JSON.stringify(u))
      const dp = await facade.flow('processDesign/deploy', { id: s.data.id, operator: 'zhangsan' })
      assert.equal(dp.code, 0, JSON.stringify(dp))
      const defineId = String(dp.data.processDefineId)
      const g = await facade.flow('processDefine/getLastByName', { processDefineName: flowName })
      assert.equal(g.code, 0, JSON.stringify(g))
      assert.equal(String(g.data.id), defineId, `getLastByName 应命中刚部署的定义: ${JSON.stringify(g)}`)
      return { defineId, flowName }
    }
    const gone = async (def: { defineId: string, flowName: string }, label: string) => {
      assert.equal(await repo.findDefineById(def.defineId), null, `${label} 仓储侧应已删除`)
      const g = await facade.flow('processDefine/getLastByName', { processDefineName: def.flowName })
      assert.equal(g.code, 99999999, `${label} 按 name 应取不到: ${JSON.stringify(g)}`)
      const d = await facade.flow('processDefine/detail', { id: def.defineId })
      assert.equal(d.code, 99999999, `${label} 门面 detail 应取不到: ${JSON.stringify(d)}`)
    }
    const rejected = async (args: Record<string, any>, label: string) => {
      const r = await facade.flow('processDefine/remove', args)
      assert.equal(r.code, 99999999, `${label} 应报错: ${JSON.stringify(r)}`)
      assert.ok(String(r.msg).includes('id 缺失或非法'), `${label} msg=${r.msg}`)
    }

    // 态 1：{ids:[a,b]} 批量
    const a = await deployDefine('01-simple.json')
    const b = await deployDefine('02-multi-task.json')
    const r1 = await facade.flow('processDefine/remove', { ids: [a.defineId, b.defineId] })
    assert.equal(r1.code, 0, JSON.stringify(r1))
    await gone(a, '批量 a')
    await gone(b, '批量 b')

    // 态 2：{id:c} 单数回归
    const c = await deployDefine('03-decision-expr.json')
    const r2 = await facade.flow('processDefine/remove', { id: c.defineId })
    assert.equal(r2.code, 0, JSON.stringify(r2))
    await gone(c, '单 id c')

    // 态 3 + 态 4
    await rejected({ ids: [] }, '空数组')
    await rejected({ ids: [''] }, '含空串')
    await rejected({ ids: ['123', null] }, '含 null')

    // 副作用检查：负向请求不应删掉仍在库的定义
    const d = await deployDefine('04-fork-join.json')
    assert.ok(await repo.findDefineById(d.defineId), '负向请求不应删除定义')
  })

  it('入口形态矩阵 processDefine/upAndDown（issues/96 §4B）：四态皆带合法 opType/state，空 ids 报错非恒真', async () => {
    const { engine, repo } = setup()
    const extRepo = new MemoryExtRepository()
    const facade = new JeeflowFacade(engine, repo, extRepo)
    const content = readFileSync(flowDir + '01-simple.json', 'utf-8')

    // 造数：deploy 出的定义初始 state=1，停用后应为 0（upAndDown 是改状态而非删除，
    // 故本 action 的「事后回查」= 两条 state 均按预期翻转，而非取不到）
    const deployDefine = async (tag: string) => {
      const s = await facade.flow('processDesign/save',
        { name: 'updown' + tag, displayName: '启停' + tag, content, operator: 'zhangsan' })
      assert.equal(s.code, 0, JSON.stringify(s))
      const dp = await facade.flow('processDesign/deploy', { id: s.data.id, operator: 'zhangsan' })
      assert.equal(dp.code, 0, JSON.stringify(dp))
      const defineId = String(dp.data.processDefineId)
      assert.equal((await repo.findDefineById(defineId))?.state, 1, '新部署定义 state 应为 1')
      return defineId
    }
    const stateOf = async (id: string) => {
      const d = await facade.flow('processDefine/detail', { id })
      assert.equal(d.code, 0, JSON.stringify(d))
      return d.data.state
    }
    const rejected = async (args: Record<string, any>, label: string) => {
      const r = await facade.flow('processDefine/upAndDown', args)
      assert.equal(r.code, 99999999, `${label} 应报错: ${JSON.stringify(r)}`)
      assert.ok(String(r.msg).includes('id 缺失或非法'), `${label} msg=${r.msg}`)
    }

    // 态 1：{ids:[a,b], opType:0} 批量停用
    const a = await deployDefine('A')
    const b = await deployDefine('B')
    const r1 = await facade.flow('processDefine/upAndDown', { ids: [a, b], opType: 0 })
    assert.equal(r1.code, 0, JSON.stringify(r1))
    assert.equal(await stateOf(a), 0, '批量 a 应已停用')
    assert.equal(await stateOf(b), 0, '批量 b 应已停用')

    // 态 2：{id:c, state:0} 单数 + state 别名回归
    const c = await deployDefine('C')
    const r2 = await facade.flow('processDefine/upAndDown', { id: c, state: 0 })
    assert.equal(r2.code, 0, JSON.stringify(r2))
    assert.equal(await stateOf(c), 0, '单 id c 应已停用')
    // 反向：单 id 启用回 1
    assert.equal((await facade.flow('processDefine/upAndDown', { id: c, opType: 1 })).code, 0)
    assert.equal(await stateOf(c), 1, '单 id c 应已启用')

    // 关键坑自证：upAndDown 先校验 state/opType，不带 state 的空 ids 用例会把
    // 「空 ids 报错」变成恒真断言（撞的是 state 校验）。故显式钉住两种 msg 可区分。
    const noState = await facade.flow('processDefine/upAndDown', { ids: [] })
    assert.equal(noState.code, 99999999, JSON.stringify(noState))
    assert.ok(!String(noState.msg).includes('id 缺失或非法'),
      `缺 state 时应先撞 state 校验，实际 msg=${noState.msg}`)

    // 态 3：{ids:[], opType:0} —— 带合法 state，报的必须是 id 缺失
    await rejected({ ids: [], opType: 0 }, '空数组+opType')
    await rejected({ ids: [], state: 0 }, '空数组+state')
    // 态 4：含空串 / 含 null，同样带合法 opType
    await rejected({ ids: [''], opType: 0 }, '含空串+opType')
    await rejected({ ids: ['123', null], opType: 0 }, '含 null+opType')

    // 副作用检查：负向请求不应改动已有定义状态
    assert.equal(await stateOf(a), 0, '负向请求不应改 a 的状态')
    assert.equal(await stateOf(c), 1, '负向请求不应改 c 的状态')
  })

  it('委托分页 m_ 条件（issues/82-7 五语言基准）：m_IN_processName / m_EQ_enabled', async () => {
    const { engine, repo } = setup()
    const extRepo = new MemoryExtRepository()
    const facade = new JeeflowFacade(engine, repo, extRepo)

    // 3 条委托：leave(启用) / overtime(启用) / sick(停用)
    // 直接 save enabled:0（走 save 路径，覆盖 saveSurrogate 的 enabled clobber）
    const r1 = await facade.flow('processSurrogate/save',
      { operator: 'zhangsan', surrogate: 'lisi', processName: 'leave', enabled: 1 })
    assert.equal(r1.code, 0, JSON.stringify(r1))
    const r2 = await facade.flow('processSurrogate/save',
      { operator: 'zhangsan', surrogate: 'wangwu', processName: 'overtime', enabled: 1 })
    assert.equal(r2.code, 0, JSON.stringify(r2))
    const r3 = await facade.flow('processSurrogate/save',
      { operator: 'zhangsan', surrogate: 'zhaoliu', processName: 'sick', enabled: 0 })
    assert.equal(r3.code, 0, JSON.stringify(r3))

    // 无过滤：3 条
    const p0 = await facade.flow('processSurrogate/page', { operator: 'zhangsan' })
    assert.equal(p0.code, 0, JSON.stringify(p0))
    assert.equal(p0.data.recordCount, 3)

    // m_IN_processName：IN 列表命中 2 条
    const pIn = await facade.flow('processSurrogate/page',
      { operator: 'zhangsan', m_IN_processName: ['leave', 'overtime'] })
    assert.equal(pIn.code, 0, JSON.stringify(pIn))
    assert.equal(pIn.data.recordCount, 2)
    const names = pIn.data.rows.map((r: any) => r.processName)
    assert.ok(names.includes('leave') && names.includes('overtime'), JSON.stringify(names))

    // m_EQ_enabled：启用过滤命中 2 条（依赖 enabled=0 未被吞）
    const pEq = await facade.flow('processSurrogate/page',
      { operator: 'zhangsan', m_EQ_enabled: 1 })
    assert.equal(pEq.code, 0, JSON.stringify(pEq))
    assert.equal(pEq.data.recordCount, 2)

    // m_IN + m_EQ 组合：sick/overtime 中仅启用 → 1 条（overtime）
    const pCombo = await facade.flow('processSurrogate/page',
      { operator: 'zhangsan', m_IN_processName: ['sick', 'overtime'], m_EQ_enabled: 1 })
    assert.equal(pCombo.code, 0, JSON.stringify(pCombo))
    assert.equal(pCombo.data.recordCount, 1)
    assert.equal(pCombo.data.rows[0].processName, 'overtime', JSON.stringify(pCombo.data))

    // 负向：IN 全不命中 / EQ 无匹配 → 0 条
    const pNone = await facade.flow('processSurrogate/page',
      { operator: 'zhangsan', m_IN_processName: ['none1', 'none2'] })
    assert.equal(pNone.code, 0, JSON.stringify(pNone))
    assert.equal(pNone.data.recordCount, 0)
    const pEq2 = await facade.flow('processSurrogate/page',
      { operator: 'zhangsan', m_EQ_enabled: 2 })
    assert.equal(pEq2.code, 0, JSON.stringify(pEq2))
    assert.equal(pEq2.data.recordCount, 0)
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

    // issues/82-6：实例列表按编码搜 m_pd_LIKE_name（别名 pd → pd.name）
    const r5b = await facade.flow('processInstance/page',
      { operator: 'zhangsan', m_pd_LIKE_name: 'simple' })
    assert.equal(r5b.code, 0, JSON.stringify(r5b))
    assert.equal(r5b.data.rows.length, 1, JSON.stringify(r5b))
    const r5c = await facade.flow('processInstance/page',
      { operator: 'zhangsan', m_pd_LIKE_name: 'zzz' })
    assert.equal(r5c.data.rows.length, 0, JSON.stringify(r5c))

    // 任务列表：m_t_LIKE_displayName（别名 t → t.display_name）
    const r6 = await facade.flow('processTask/todoList',
      { operator: 'leader', m_t_LIKE_displayName: '审批' })
    assert.equal(r6.code, 0, JSON.stringify(r6))
    assert.equal(r6.data.rows.length, 1, JSON.stringify(r6))
    const r7 = await facade.flow('processTask/todoList',
      { operator: 'leader', m_t_LIKE_displayName: 'zzz' })
    assert.equal(r7.data.rows.length, 0, JSON.stringify(r7))

    // 设计列表：无别名 m_LIKE_name（issues/05-5 process-design 页）
    // 82-9：save 带 remark/icon，page 行应回显（设计页回显字段，对齐 Java/Go/Python）
    await facade.flow('processDesign/save',
      { name: 'leave', displayName: '请假流程', content: c1, operator: 'zhangsan',
        icon: 'icon-echo', remark: '回显验证备注' })
    const r8 = await facade.flow('processDesign/page', { m_LIKE_name: 'leave' })
    assert.equal(r8.code, 0, JSON.stringify(r8))
    assert.equal(r8.data.rows.length, 1, JSON.stringify(r8))
    const dRow = r8.data.rows[0]
    assert.equal(dRow.remark, '回显验证备注', `designPage remark 应回显保存值: ${dRow.remark}`)
    assert.equal(dRow.icon, 'icon-echo', `designPage icon 应回显保存值: ${dRow.icon}`)

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

  it('23b FormFieldAssigneeHandler f_ 前缀（issues/48）', async () => {
    const repo = new MemoryRepository()
    const userProv: UserProvider = {
      async getUser(userId) { return { userId, realName: '用户' + userId, deptId: 'D01', deptName: '测试部门', postId: 'P01', postName: '测试岗位' } },
    }
    const orgProv = {
      async findDeptLeaders() { return [] },
      async findDeptMainLeaders() { return [] },
      async findByRole() { return [] },
    }
    const registry = new HandlerRegistry()
    registerBuiltinAssignments(registry, userProv, orgProv)
    const idGen = { nextId() { return String(Date.now() * 1000 + Math.floor(Math.random() * 1000)) } }
    const exprEval: ExpressionEvaluator = { async eval() { return false } }
    const engine = new EngineImpl(repo, userProv, idGen, exprEval)
    engine.setRegistry(registry)
    const def = loadFlow(repo, '11-assignment-handler.json')

    // ① f_ 前缀变量（前端表单提交格式）
    let inst = await engine.startProcessInstanceById(def.id, 'user1', { f_task1: 'userA,userB' })
    let doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing[0].taskName, 'task1')
    assert.deepEqual([...doing[0].actorIds].sort(), ['userA', 'userB'], `① f_ prefix: ${doing[0].actorIds}`)
    await repo.addTaskActor(doing[0].id, doing[0].actorIds)
    await engine.executeProcessTask(doing[0].id, 'userA')

    // ② f_ 前缀优先于裸名
    inst = await engine.startProcessInstanceById(def.id, 'user1', { f_task1: 'userX', task1: 'userY' })
    doing = await repo.findDoingTasks(inst.id)
    assert.deepEqual([...doing[0].actorIds], ['userX'], `② f_ priority: ${doing[0].actorIds}`)
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
    const rows = r.data.rows as Array<{ id?: string; userId?: string; realName?: string }>
    const userIds = rows.map(x => x.userId).sort()
    assert.deepEqual(userIds, ['finA', 'finB', 'userA', 'userB'],
      `候选应为 candidateUsers(userA/userB) + candidateGroups(finA/finB): ${userIds}`)
    // issues/80：行键契约 {id, realName}（对齐前端 UserSelect valueField='id'）
    for (const x of rows) {
      assert.ok(x.id && x.id.length > 0, `candidate row 缺 id 键: ${JSON.stringify(x)}`)
      assert.ok(typeof x.realName === 'string', `candidate row 缺 realName 键: ${JSON.stringify(x)}`)
      if (x.userId !== undefined) {
        assert.equal(x.id, x.userId, `id 与 userId 应一一对齐（行键归一）: id=${x.id} userId=${x.userId}`)
      }
    }
    assert.ok(rows.some(x => x.id === 'userA'), `id 列表应含 userA: ${rows.map(x => x.id)}`)
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

  it('27b taskDetail performType/taskType 出口数字契约（issues/78）：普通 0 / 会签 1', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())

    // 普通流程：task1 performType=0 / taskType=0
    const r0 = await facade.flow('processDefine/deploy', { content: readFileSync(flowDir + '01-simple.json', 'utf-8') })
    assert.equal(r0.code, 0, JSON.stringify(r0))
    const r1 = await facade.flow('processInstance/startAndExecute', { processDefineId: r0.data.processDefineId, operator: 'zhangsan' })
    assert.equal(r1.code, 0, JSON.stringify(r1))
    const doing = await repo.findDoingTasks(r1.data.processInstanceId)
    assert.ok(doing.length > 0, '应有进行中任务')
    const d = await facade.flow('processTask/detail', { id: doing[0].id, operator: 'leader' })
    assert.equal(d.code, 0, JSON.stringify(d))
    assert.equal(d.data.performType, 0, `普通任务 performType 应=0: ${d.data.performType}`)
    assert.equal(d.data.taskType, 0, `普通任务 taskType 应=0: ${d.data.taskType}`)

    // 会签流程：task1 performType=1
    const r2 = await facade.flow('processDefine/deploy', { content: readFileSync(flowDir + '06-countersign-sequential.json', 'utf-8') })
    assert.equal(r2.code, 0, JSON.stringify(r2))
    const r3 = await facade.flow('processInstance/startAndExecute', { processDefineId: r2.data.processDefineId, operator: 'user1' })
    assert.equal(r3.code, 0, JSON.stringify(r3))
    const csDoing = await repo.findDoingTasks(r3.data.processInstanceId)
    assert.ok(csDoing.length > 0, '会签应有进行中任务')
    const cs = await facade.flow('processTask/detail', { id: csDoing[0].id, operator: 'userA' })
    assert.equal(cs.code, 0, JSON.stringify(cs))
    assert.equal(cs.data.performType, 1, `会签任务 performType 应=1（非 'COUNTERSIGN'）: ${cs.data.performType}`)
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
    // issues/113：会签实例整单撤回时，3 条 doing 会签任务同样落 30——99 留给一票否决的废弃路径
    const csIid = r3.data.processInstanceId
    const cw = await facade.flow('processInstance/withdraw', { id: csIid, operator: 'user1' })
    assert.equal(cw.code, 0, JSON.stringify(cw))
    for (const t of cs) {
      const stored = await repo.findTaskById(t.id)
      assert.equal(stored?.taskState, TaskState.Withdraw, `撤回会签任务态应=30，实测 ${stored?.taskState}`)
    }
    assert.equal((await repo.findDoingTasks(csIid)).length, 0, '会签实例撤回后应无 doing 任务')
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

  it('31 issues/114 撤回鉴权：operator 硬必填 + 三条归属判据 + update_user 回写', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
    const r0 = await facade.flow('processDefine/deploy', { content: readFileSync(flowDir + '01-simple.json', 'utf-8') })
    const defineId = r0.data.processDefineId
    const start = async (operator: string) => {
      const r = await facade.flow('processInstance/startAndExecute', { processDefineId: defineId, operator })
      assert.equal(r.code, 0, JSON.stringify(r))
      return r.data.processInstanceId as string
    }

    // ① operator 缺失/空串 → 明确报错，严禁回落 user1：实例与任务必须原样未动
    const iid1 = await start('zhangsan')
    const doing1 = await repo.findDoingTasks(iid1)
    const rw1 = await facade.flow('processInstance/withdraw', { id: iid1 })
    assert.equal(rw1.code, 99999999, JSON.stringify(rw1))
    assert.ok(String(rw1.msg).includes('operator 必填'), `msg 应为「operator 必填」: ${rw1.msg}`)
    const rw1b = await facade.flow('processInstance/withdraw', { id: iid1, operator: '  ' })
    assert.equal(rw1b.code, 99999999)
    assert.ok(String(rw1b.msg).includes('operator 必填'), `空串同样必填: ${rw1b.msg}`)
    assert.equal((await repo.findInstanceById(iid1))?.state, InstanceState.Doing, '被拒后实例仍进行中')
    for (const t of doing1) {
      assert.equal((await repo.findTaskById(t.id))?.taskState, TaskState.Doing, '被拒后任务仍 DOING（未回落 user1 静默撤回）')
    }

    // ② 判据 1 发起人：撤回成功 + 持久值断言（状态 30 / update_user=撤回人）
    const rw2 = await facade.flow('processInstance/withdraw', { id: iid1, operator: 'zhangsan' })
    assert.equal(rw2.code, 0, JSON.stringify(rw2))
    const inst2 = await repo.findInstanceById(iid1)
    assert.equal(inst2?.state, InstanceState.Withdraw, '实例态应=30')
    assert.equal(inst2?.updateUser, 'zhangsan', '实例 update_user 回写撤回人')
    assert.ok(doing1.length > 0)
    for (const t of doing1) {
      const stored = await repo.findTaskById(t.id)
      assert.equal(stored?.taskState, TaskState.Withdraw, `原 doing 任务落库应=30，实测 ${stored?.taskState}`)
      assert.equal(stored?.updateUser, 'zhangsan', '进行中任务 update_user 回写撤回人')
    }
    // 已完成(20)的 apply 行不被改写（契约：20/40 任务行不得被撤回触碰）
    const applyRow = (await repo.findHistoryTasks(iid1)).find(t => t.taskName === 'apply')
    assert.equal(applyRow?.taskState, TaskState.Done, '已完成任务行不被撤回改写')

    // ③ 判据 2 参与者：发起人 alice、当前任务参与者 leader（非发起人）撤回整单
    //    ⚠️ isAllowed 只判 actorIds+auto/admin 不查发起人——此判据走"参与者"支，与 ④ 共同证伪
    const iid3 = await start('alice')
    const doing3 = await repo.findDoingTasks(iid3)
    assert.deepEqual(doing3[0].actorIds, ['leader'], '01-simple task1 参与者=leader（非发起人 alice）')
    const rw3 = await facade.flow('processInstance/withdraw', { id: iid3, operator: 'leader' })
    assert.equal(rw3.code, 0, JSON.stringify(rw3))
    assert.equal((await repo.findInstanceById(iid3))?.updateUser, 'leader', 'update_user=真实撤回人 leader（非 user1/非发起人）')
    for (const t of doing3) {
      const stored = await repo.findTaskById(t.id)
      assert.equal(stored?.taskState, TaskState.Withdraw, `参与者撤回后任务应=30: ${stored?.taskState}`)
      assert.equal(stored?.updateUser, 'leader')
    }

    // ④ 无关第三人 → 99999999 + msg；拒绝后任务/实例状态与 update_user 均不变
    const iid4 = await start('alice')
    const doing4 = await repo.findDoingTasks(iid4)
    const rw4 = await facade.flow('processInstance/withdraw', { id: iid4, operator: 'nobody' })
    assert.equal(rw4.code, 99999999, JSON.stringify(rw4))
    assert.ok(String(rw4.msg).includes('无权限撤回该流程实例'), `msg 应为「无权限撤回该流程实例」: ${rw4.msg}`)
    assert.equal((await repo.findInstanceById(iid4))?.state, InstanceState.Doing, '拒绝后实例仍 10')
    assert.notEqual((await repo.findInstanceById(iid4))?.updateUser, 'nobody', '拒绝后 update_user 未被污染')
    assert.equal((await repo.findTaskById(doing4[0].id))?.taskState, TaskState.Doing, '拒绝后任务仍 10')

    // ⑤ flow.auto / flow.admin 放行（判据 3）
    const iid5 = await start('alice')
    assert.equal((await facade.flow('processInstance/withdraw', { id: iid5, operator: 'flow.admin' })).code, 0)
    const iid5b = await start('alice')
    assert.equal((await facade.flow('processInstance/withdraw', { id: iid5b, operator: 'flow.auto' })).code, 0)

    // ⑥ 已完成(20)任务行不得被撤回改写：02-multi-task 推进到 task2（task1 已完成）
    const rD = await facade.flow('processDefine/deploy', { content: readFileSync(flowDir + '02-multi-task.json', 'utf-8') })
    const rS = await facade.flow('processInstance/startAndExecute', { processDefineId: rD.data.processDefineId, operator: 'alice' })
    const iid6 = rS.data.processInstanceId as string
    let doing6 = await repo.findDoingTasks(iid6)
    const task1Id = doing6.find(t => t.taskName === 'task1')!.id
    await repo.addTaskActor(task1Id, ['leader'])
    assert.equal((await facade.flow('processTask/execute', { processTaskId: task1Id, operator: 'leader', submitType: 1 })).code, 0)
    doing6 = await repo.findDoingTasks(iid6)
    const task2Id = doing6.find(t => t.taskName === 'task2')!.id
    const rw6 = await facade.flow('processInstance/withdraw', { id: iid6, operator: 'alice' })
    assert.equal(rw6.code, 0, JSON.stringify(rw6))
    assert.equal((await repo.findTaskById(task1Id))?.taskState, TaskState.Done, '已完成(20)任务行不被撤回改写')
    assert.equal((await repo.findTaskById(task2Id))?.taskState, TaskState.Withdraw, '进行中任务落 30')
    // 作用于整单：同实例全部进行中任务都被撤（不只操作人自己那一条）
    assert.equal((await repo.findDoingTasks(iid6)).length, 0, '撤回作用于整单，无残留 doing')
  })

  it('32 issues/115 转办：摘原人+换新人+submitType=7 留痕（同一 taskId）', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
    const r0 = await facade.flow('processDefine/deploy', { content: readFileSync(flowDir + '01-simple.json', 'utf-8') })
    const r1 = await facade.flow('processInstance/startAndExecute',
      { processDefineId: r0.data.processDefineId, operator: 'zhangsan', amount: '100' })
    assert.equal(r1.code, 0, JSON.stringify(r1))
    const iid = r1.data.processInstanceId as string
    const taskId = (await repo.findDoingTasks(iid))[0].id
    // 多参与人任务：加签 coactor（surrogate 只追加语义不动）
    assert.equal((await facade.flow('processTask/surrogate', { processTaskId: taskId, actorIds: ['coactor'] })).code, 0)

    // ── 四类明确报错（精确失败码 + msg 关键字，且参与者集合不被破坏）──
    const neg = async (args: Record<string, any>, keyword: string) => {
      const r = await facade.flow('processTask/transfer', args)
      assert.equal(r.code, 99999999, JSON.stringify(r))
      assert.ok(String(r.msg).includes(keyword), `msg 应含「${keyword}」: ${r.msg}`)
      assert.deepEqual(await repo.findTaskActors(taskId), ['leader', 'coactor'], `报错后参与者不变: ${keyword}`)
    }
    await neg({ processTaskId: taskId, fromActor: 'leader', toActor: 'lisi' }, 'operator 必填')
    await neg({ processTaskId: taskId, fromActor: 'leader', toActor: 'lisi', operator: 'other' }, '无权限转办该任务')
    await neg({ processTaskId: taskId, fromActor: 'ghost', toActor: 'lisi', operator: 'ghost' }, '原办理人不是该任务参与人')
    await neg({ processTaskId: taskId, fromActor: 'leader', toActor: 'coactor', operator: 'leader' }, '目标人已是该任务参与人')

    // ── 正向：leader 转办给 lisi（原因）──
    const rw = await facade.flow('processTask/transfer',
      { processTaskId: taskId, fromActor: 'leader', toActor: 'lisi', reason: '出差', operator: 'leader' })
    assert.equal(rw.code, 0, JSON.stringify(rw))

    // ① 只摘 fromActor 一行：coactor 保留、lisi 追加、leader 出局（读回持久值）
    assert.deepEqual(await repo.findTaskActors(taskId), ['coactor', 'lisi'], '参与者读回值')
    // ② 待办从 A 挪到 B（同一 taskId）
    const todoB = await repo.pageTodoTasks(1, 50, 'lisi')
    assert.ok(todoB.rows.some(r => String(r.id) === String(taskId)), 'B 待办出现该任务')
    const todoA = await repo.pageTodoTasks(1, 50, 'leader')
    assert.ok(!todoA.rows.some(r => String(r.id) === String(taskId)), 'A 待办消失')
    // ③ 任务不新建：沿用同一 taskId、仍 DOING、变量落库
    const stored = await repo.findTaskById(taskId)
    assert.equal(stored?.taskState, TaskState.Doing, '转办后任务仍进行中')
    assert.equal(stored?.actorId, '', '转办后 DOING 任务 actor_id 恒无值（契约 06 ⚠️ 严禁覆写）')
    assert.equal(stored?.variables.submitType, SubmitType.Transfer, 'submitType=7 持久化')
    assert.equal(stored?.variables.tf_transferTo, 'lisi', 'tf_transferTo 任务变量')
    assert.equal(stored?.variables.tf_transferReason, '出差', 'tf_transferReason 任务变量')
    assert.equal(stored?.updateUser, 'leader', 'update_user=转办人')
    // ④ 审批记录可读"A 转办给 B（原因…）"
    const rec = await facade.flow('processInstance/approvalRecord', { id: iid })
    assert.equal(rec.code, 0, JSON.stringify(rec))
    const recRow = rec.data.find((x: any) => x.taskName === 'task1')
    assert.ok(String(recRow?.variable?.tf_approvalComment ?? recRow?.ext?.tf_approvalComment ?? '')
      .includes('leader 转办给 lisi'), `审批记录文案可读转办: ${JSON.stringify(recRow)}`)
    assert.equal(recRow?.variable?.submitType, SubmitType.Transfer, '审批记录 submitType=7')
    // ⑤ 转办后 B 能正常办理（prepareExecuteTask 合并任务变量时 submitType 被 execute 入参覆盖）
    const rEx = await facade.flow('processTask/execute', { processTaskId: taskId, operator: 'lisi', submitType: 1 })
    assert.equal(rEx.code, 0, JSON.stringify(rEx))
    assert.equal((await repo.findInstanceById(iid))?.state, InstanceState.Done, 'lisi 办结后流程正常结束')
    // ⑥ 非 DOING（已完成）不可转办
    const rT2 = await facade.flow('processTask/transfer',
      { processTaskId: taskId, fromActor: 'lisi', toActor: 'zhaoliu', operator: 'lisi' })
    assert.equal(rT2.code, 99999999)
    assert.ok(String(rT2.msg).includes('任务非进行中，不可转办'), `msg: ${rT2.msg}`)

    // ⑦ flow.admin 可代转办（归属判据例外）
    const rD = await facade.flow('processDefine/deploy', { content: readFileSync(flowDir + '05-countersign-parallel.json', 'utf-8') })
    const rS = await facade.flow('processInstance/startAndExecute', { processDefineId: rD.data.processDefineId, operator: 'zhangsan' })
    const iid7 = rS.data.processInstanceId as string
    const doing7 = await repo.findDoingTasks(iid7)
    const taskA = doing7.find(t => (t.actorIds ?? []).includes('userA'))!
    const taskB = doing7.find(t => (t.actorIds ?? []).includes('userB'))!
    assert.ok(taskA && taskB, '会签三任务 userA/userB/userC 就位')
    const rAdm = await facade.flow('processTask/transfer',
      { processTaskId: taskA.id, fromActor: 'userA', toActor: 'lisi', operator: 'flow.admin' })
    assert.equal(rAdm.code, 0, JSON.stringify(rAdm))
    // 契约 06 §transfer 留痕⚠️（新契约判据）：代转办同样**严禁覆写 actor_id 列**——进行中任务
    // 该列恒无值；"办理人记谁"由 update_user + tf_transferHistory[].operator 承载
    assert.equal((await facade.flow('processTask/detail', { id: taskA.id, operator: 'lisi' })).data.operator,
      '', '转办后 DOING 任务 operator 列恒无值（严禁覆写）')
    const admHop = (await repo.findTaskById(taskA.id))?.variables.tf_transferHistory
    assert.ok(Array.isArray(admHop) && admHop.length === 1 && admHop[0].operator === 'flow.admin',
      `真操作人由账本 operator 承载: ${JSON.stringify(admHop)}`)
    // ⑧ 会签只动自己那一行：userA 任务参与者换成 lisi，userB 任务行不受影响
    assert.deepEqual(await repo.findTaskActors(taskA.id), ['lisi'], 'userA 票只摘本人')
    assert.deepEqual(await repo.findTaskActors(taskB.id), ['userB'], 'userB 票不受影响')
  })

  it('33 issues/115 转办两跳账本 tf_transferHistory：只追加不覆盖，办结后仍在', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
    const r0 = await facade.flow('processDefine/deploy', { content: readFileSync(flowDir + '01-simple.json', 'utf-8') })
    const r1 = await facade.flow('processInstance/startAndExecute',
      { processDefineId: r0.data.processDefineId, operator: 'zhangsan' })
    assert.equal(r1.code, 0, JSON.stringify(r1))
    const iid = r1.data.processInstanceId as string
    const taskId = (await repo.findDoingTasks(iid))[0].id
    // 时间格式契约：spec 06 §2.4 一律 yyyy-MM-dd HH:mm:ss
    const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

    // ── clause 4 出口实勘：DOING 任务转办前 actorId 为空（引擎只在 finish 时写办理人）──
    const beforeDetail = await facade.flow('processTask/detail', { id: taskId, operator: 'lisi' })
    assert.equal(beforeDetail.data.operator, '', '未转办时 DOING 任务 detail.operator 为空')

    // ── 两跳：leader→lisi→zhaoliu（同一 taskId，账本按跳序累积）──
    assert.equal((await facade.flow('processTask/transfer', { processTaskId: taskId,
      fromActor: 'leader', toActor: 'lisi', reason: '出差', operator: 'leader' })).code, 0)
    assert.equal((await facade.flow('processTask/transfer', { processTaskId: taskId,
      fromActor: 'lisi', toActor: 'zhaoliu', reason: '转专家', operator: 'lisi' })).code, 0)

    // 每跳一条、六字段齐全；末跳便捷键与可读文案只留末跳（全量以账本为准）
    const mid = await repo.findTaskById(taskId)
    const hist = mid?.variables.tf_transferHistory
    assert.ok(Array.isArray(hist), `tf_transferHistory 应为追加式数组，实测 ${JSON.stringify(mid?.variables.tf_transferHistory)}`)
    assert.equal(hist?.length, 2, `两跳后账本应 2 条，实测 ${hist?.length}`)
    const [hop1, hop2] = hist ?? []
    assert.equal(Object.keys(hop1).sort().join(','), 'fromActor,operator,reason,submitType,time,toActor', '账本条目六字段')
    assert.deepEqual({ ...hop1, time: '' }, { submitType: SubmitType.Transfer, fromActor: 'leader', toActor: 'lisi', reason: '出差', time: '', operator: 'leader' }, '第 1 跳逐字段')
    assert.match(hop1.time, TIME_RE, '第 1 跳 time 格式')
    assert.deepEqual({ ...hop2, time: '' }, { submitType: SubmitType.Transfer, fromActor: 'lisi', toActor: 'zhaoliu', reason: '转专家', time: '', operator: 'lisi' }, '第 2 跳逐字段（append 不覆盖第 1 跳）')
    assert.match(hop2.time, TIME_RE, '第 2 跳 time 格式')
    assert.equal(mid?.variables.tf_transferTo, 'zhaoliu', '便捷键反映末跳')
    assert.equal(mid?.variables.tf_transferReason, '转专家', '末跳原因')

    // ── 契约 06 §transfer 留痕⚠️（新契约判据，替代旧"实测锁死"断言）：转办严禁覆写 actor_id 列，
    //    四个出口在任务仍 DOING 时读该列都必须是空——持单人以参与者表（taskActorIdList）为准 ──
    const afterDetail = await facade.flow('processTask/detail', { id: taskId, operator: 'zhaoliu' })
    const latest = await facade.flow('processTask/latest', { processInstanceId: iid })
    const instDetail = await facade.flow('processInstance/detail', { id: iid })
    const todo = await facade.flow('processTask/todoList', { operator: 'zhaoliu' })
    assert.equal(afterDetail.data.operator, '', '契约回归：processTask/detail.operator 恒无值')
    assert.equal(latest.data.operator, '', '契约回归：processTask/latest.operator 同上')
    assert.equal(instDetail.data.activeTaskList.find((t: any) => String(t.id) === String(taskId))?.operator, '', '契约回归：实例详情 activeTaskList.operator 同上')
    assert.equal(todo.data.rows.find((t: any) => String(t.id) === String(taskId))?.operator, '', '契约回归：待办卡片行 operator 同上')
    assert.equal(afterDetail.data.taskState, TaskState.Doing, '转办后任务仍 DOING')
    assert.deepEqual(afterDetail.data.taskActorIdList, ['zhaoliu'], '待办归属（参与者表）正确指向 C')

    // ── C 办结：submitType 槽位被覆盖属预期，账本必须仍在 ──
    const rEx = await facade.flow('processTask/execute', { processTaskId: taskId, operator: 'zhaoliu', submitType: SubmitType.Agree })
    assert.equal(rEx.code, 0, JSON.stringify(rEx))
    const after = await repo.findTaskById(taskId)
    assert.equal(after?.taskState, TaskState.Done)
    assert.equal(after?.variables.submitType, SubmitType.Agree, '末跳槽位被 C 的办理动作覆盖（契约明定为预期）')
    assert.equal(after?.variables.tf_transferHistory?.length, 2, '办结后账本仍在（合并序：实例←任务←本次提交）')
    assert.deepEqual({ ...after?.variables.tf_transferHistory?.[0], time: '' }, { ...hop1, time: '' }, '办结后第 1 跳内容不变')
    assert.deepEqual({ ...after?.variables.tf_transferHistory?.[1], time: '' }, { ...hop2, time: '' }, '办结后第 2 跳内容不变')
    // 审批记录读回（前端唯一读取路径）同样带全量账本
    const rec = await facade.flow('processInstance/approvalRecord', { id: iid })
    const row = rec.data.find((x: any) => x.taskName === 'task1')
    assert.equal(row?.variable?.tf_transferHistory?.length, 2, '审批记录透出两跳账本')
    assert.equal(row?.variable?.submitType, SubmitType.Agree, '审批记录槽位读作办结动作')
  })

  it('34 契约06 transfer⚠️：转办不覆写 actor_id——撤回后「我已办」不冒单（内存路契约回归）', async () => {
    // 缺陷机理（Node 实测复现，契约已固化 778340a）：转办把被摘走的人写进任务 operator 列，
    // 该单一旦撤回（离开 DOING 但列值留着），pageDoneTasks（state <> 10 AND operator = ?）
    // 会让他凭空出现在从没办过的「我已办」列表。断言全落持久值/读回值。
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
    const r0 = await facade.flow('processDefine/deploy', { content: readFileSync(flowDir + '01-simple.json', 'utf-8') })
    const r1 = await facade.flow('processInstance/startAndExecute',
      { processDefineId: r0.data.processDefineId, operator: 'zhangsan' })
    assert.equal(r1.code, 0, JSON.stringify(r1))
    const iid = r1.data.processInstanceId as string
    const taskId = (await repo.findDoingTasks(iid))[0].id
    assert.equal((await facade.flow('processTask/transfer', { processTaskId: taskId,
      fromActor: 'leader', toActor: 'lisi', reason: '出差', operator: 'leader' })).code, 0)
    let mid = await repo.findTaskById(taskId)
    assert.equal(mid?.actorId, '', '转办后持久任务行 actor_id 恒无值')
    assert.equal(mid?.updateUser, 'leader', '办理人经 update_user 承载')
    // 发起人撤回：任务离开 DOING(→30)，operator 列不被污染
    assert.equal((await facade.flow('processInstance/withdraw', { id: iid, operator: 'zhangsan' })).code, 0)
    mid = await repo.findTaskById(taskId)
    assert.equal(mid?.taskState, TaskState.Withdraw, '撤回后任务态=30（本用例判据生效的前提）')
    assert.equal(mid?.actorId, '', '撤回后 actor_id 列仍恒无值')
    for (const who of ['leader', 'lisi']) {
      const rd = await facade.flow('processTask/doneList', { operator: who, pageSize: 100 })
      assert.equal(rd.code, 0, JSON.stringify(rd))
      assert.ok(!rd.data.rows.some((r: any) => String(r.id) === String(taskId)),
        `转办→撤回后 ${who} 的「我已办」不得冒入该单（他从没办过）: ${JSON.stringify(rd.data.rows.map((r: any) => r.id))}`)
    }
  })

  // ═══ execute submitType 2/3/4/5/6/20 门面行为（issues/79，前端按钮全量暴露路径）═══

  async function startMultiTaskAt(facade: JeeflowFacade, repo: MemoryRepository, name: string): Promise<string> {
    // 02-multi-task：发起（apply 自动完成）→ 推进到名为 name 的任务节点
    const r0 = await facade.flow('processDefine/deploy', { content: readFileSync(flowDir + '02-multi-task.json', 'utf-8') })
    assert.equal(r0.code, 0, r0.msg)
    const r1 = await facade.flow('processInstance/startAndExecute',
      { processDefineId: r0.data.processDefineId, operator: 'zhangsan' })
    assert.equal(r1.code, 0, r1.msg)
    const instanceId: string = r1.data.processInstanceId
    const order = ['task1', 'task2', 'task3']
    const actor = ['leader', 'manager', 'boss']
    const target = order.indexOf(name)
    for (let i = 0; i < target; i++) {
      const doing = await repo.findDoingTasks(instanceId)
      const tid = doing.find(t => t.taskName === order[i])?.id
      assert.ok(tid, `应推进到 ${order[i]}`)
      await repo.addTaskActor(tid, [actor[i]])
      const r = await facade.flow('processTask/execute', { processTaskId: tid, operator: actor[i], submitType: 1 })
      assert.equal(r.code, 0, r.msg)
    }
    return instanceId
  }

  async function doingTaskId(repo: MemoryRepository, instanceId: string, name: string): Promise<string | undefined> {
    for (const t of await repo.findDoingTasks(instanceId)) if (t.taskName === name) return t.id
    return undefined
  }

  async function doingTaskIdByActor(repo: MemoryRepository, instanceId: string, name: string, actor: string): Promise<string | undefined> {
    // 会签场景：同节点多个 DOING 任务（每 actor 一个），按 actor 定位
    for (const t of await repo.findDoingTasks(instanceId)) {
      if (t.taskName !== name) continue
      if ((t.actorIds ?? []).includes(actor)) return t.id
    }
    return undefined
  }

  it('79 execute submitType 3/4/5/6 + 负向（对齐 Java 参考实现断言）', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())

    // ── submitType=3 ROLLBACK：task2 退回上一步 → task1 新待办（actor=退回操作人），实例保持 DOING(10)
    const rb = await startMultiTaskAt(facade, repo, 'task2')
    const t2 = await doingTaskId(repo, rb, 'task2')
    await repo.addTaskActor(t2!, ['manager'])
    const r3 = await facade.flow('processTask/execute', { processTaskId: t2, operator: 'manager', submitType: 3 })
    assert.equal(r3.code, 0, r3.msg)
    const rbTask1 = await doingTaskId(repo, rb, 'task1')
    assert.ok(rbTask1, 'ROLLBACK 应在 task1 产生新待办')
    assert.ok((await repo.findTaskActors(rbTask1!)).includes('manager'), '退回任务 actor 应为退回操作人 manager')
    assert.equal((await repo.findInstanceById(rb))!.state, InstanceState.Doing, 'ROLLBACK 后实例应保持 DOING(10)')

    // ── submitType=4 JUMP：task3 跳转 apply（首任务节点 = start 直接后继，assignee 强制发起人）
    const jp = await startMultiTaskAt(facade, repo, 'task3')
    const t3 = await doingTaskId(repo, jp, 'task3')
    await repo.addTaskActor(t3!, ['boss'])
    const jl = await facade.flow('processTask/jumpAbleTaskNameList', { processInstanceId: jp })
    assert.equal(jl.code, 0, jl.msg)
    const jumpValues = (jl.data as any[]).map(m => m.value)
    assert.ok(jumpValues.includes('task1') && jumpValues.includes('apply'), `jumpAble 应含 task1/apply: ${jumpValues}`)
    const r4 = await facade.flow('processTask/execute', { processTaskId: t3, operator: 'boss', submitType: 4, taskName: 'apply' })
    assert.equal(r4.code, 0, r4.msg)
    const jpApply = await doingTaskId(repo, jp, 'apply')
    assert.ok(jpApply, 'JUMP 应在 apply（首任务节点）产生新待办')
    assert.deepEqual(await repo.findTaskActors(jpApply!), ['zhangsan'], '跳首任务节点 assignee 强制为发起人')
    assert.equal((await repo.findInstanceById(jp))!.state, InstanceState.Doing, 'JUMP 后实例应保持 DOING(10)')

    // ── 负向：JUMP taskName 不存在 → 99999999 + 「无法找到节点模型」
    const jn = await startMultiTaskAt(facade, repo, 'task2')
    const t2n = await doingTaskId(repo, jn, 'task2')
    await repo.addTaskActor(t2n!, ['manager'])
    const jr = await facade.flow('processTask/execute', { processTaskId: t2n, operator: 'manager', submitType: 4, taskName: 'no-such-node' })
    assert.equal(jr.code, 99999999, jr.msg)
    assert.match(String(jr.msg), /无法找到节点模型/, jr.msg)

    // ── submitType=5 RE_APPLY：task1 重新提交（前端 detail 抽屉场景，含 f_ 表单 + tf_nextNodeOperator）
    const ra = await startMultiTaskAt(facade, repo, 'task1')
    const t1r = await doingTaskId(repo, ra, 'task1')
    await repo.addTaskActor(t1r!, ['leader'])
    const r5 = await facade.flow('processTask/execute',
      { processTaskId: t1r, operator: 'leader', submitType: 5, tf_nextNodeOperator: 'manager', f_leaveType: 'annual' })
    assert.equal(r5.code, 0, r5.msg)
    const doingAfter = await repo.findDoingTasks(ra)
    assert.equal(doingAfter.length, 1)
    assert.equal(doingAfter[0].taskName, 'task2', 'RE_APPLY 后应推进到 task2')
    assert.deepEqual(await repo.findTaskActors(doingAfter[0].id), ['manager'], 'tf_nextNodeOperator 应覆盖 task2 处理人')
    const instRa = await repo.findInstanceById(ra)
    assert.equal(instRa!.variables.f_leaveType, 'annual', 'f_ 表单字段应落实例变量')
    assert.equal(instRa!.state, InstanceState.Doing, 'RE_APPLY 后实例应保持 DOING(10)')

    // ── submitType=6 ROLLBACK_TO_OPERATOR：task3 退回发起人 → apply 重执行、actor=发起人 zhangsan
    const ro = await startMultiTaskAt(facade, repo, 'task3')
    const t3o = await doingTaskId(repo, ro, 'task3')
    await repo.addTaskActor(t3o!, ['boss'])
    const r6 = await facade.flow('processTask/execute', { processTaskId: t3o, operator: 'boss', submitType: 6 })
    assert.equal(r6.code, 0, r6.msg)
    const roApply = await doingTaskId(repo, ro, 'apply')
    assert.ok(roApply, 'ROLLBACK_TO_OPERATOR 应重执行首个任务节点 apply')
    assert.deepEqual(await repo.findTaskActors(roApply!), ['zhangsan'], '退回发起人 assignee 强制为发起人')
    assert.equal((await repo.findInstanceById(ro))!.state, InstanceState.Doing, '退回发起人后实例应保持 DOING(10)')

    // ── 负向：非处理人执行被拒（NOT_ALLOWED_EXECUTE）
    const na = await startMultiTaskAt(facade, repo, 'task1')
    const t1n = await doingTaskId(repo, na, 'task1')
    const nr = await facade.flow('processTask/execute', { processTaskId: t1n, operator: 'hacker', submitType: 1 })
    assert.equal(nr.code, 99999999, nr.msg)
    assert.match(String(nr.msg), /not allowed/, nr.msg)
  })

  it('79 execute submitType=2 REJECT → REJECT(45)（对齐 Java/Go/Python/PHP）', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
    const instId = await startMultiTaskAt(facade, repo, 'task1')
    const t1 = await doingTaskId(repo, instId, 'task1')
    await repo.addTaskActor(t1!, ['leader'])
    const r = await facade.flow('processTask/execute', { processTaskId: t1, operator: 'leader', submitType: 2 })
    assert.equal(r.code, 0, r.msg)
    assert.equal((await repo.findInstanceById(instId))!.state, InstanceState.Reject, 'REJECT 后实例应为 REJECT(45)')
    assert.equal((await repo.findDoingTasks(instId)).length, 0, 'REJECT 后应无 DOING 任务')
  })

  it('91 execute submitType=20 软拒绝（06 串行未配 ONE_VOTE_VETO，对齐内置引擎默认策略）', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
    // 06-countersign-sequential：apply 自动完成 → task1 串行会签（逐人创建，先 userA）
    const r0 = await facade.flow('processDefine/deploy', { content: readFileSync(flowDir + '06-countersign-sequential.json', 'utf-8') })
    assert.equal(r0.code, 0, r0.msg)
    const r1 = await facade.flow('processInstance/startAndExecute',
      { processDefineId: r0.data.processDefineId, operator: 'user1' })
    assert.equal(r1.code, 0, r1.msg)
    const instanceId: string = r1.data.processInstanceId
    const taskA = await doingTaskIdByActor(repo, instanceId, 'task1', 'userA')
    assert.ok(taskA, '会签节点应有 userA 的 DOING 任务')
    await repo.addTaskActor(taskA!, ['userA'])
    // submitType=20（未配 ONE_VOTE_VETO → 软拒绝）：flag 记录，流程不阻断，串行推进到下一成员
    const r = await facade.flow('processTask/execute', { processTaskId: taskA, operator: 'userA', submitType: 20 })
    assert.equal(r.code, 0, r.msg)
    const inst = await repo.findInstanceById(instanceId)
    assert.equal(inst!.state, InstanceState.Doing, `软拒绝后实例应保持 DOING(10)，继续等 userB: ${inst?.state}`)
    assert.equal(Number(inst!.variables.countersignDisagreeFlag), 1, 'countersignDisagreeFlag=1 应落实例变量')
    const doneA = await repo.findTaskById(taskA!)
    assert.equal(doneA!.taskState, TaskState.Done, '软拒绝任务应正常完成')
    assert.equal(Number(doneA!.variables.countersignDisagreeFlag), 1, 'countersignDisagreeFlag=1 应落任务变量')
    assert.equal(doneA!.actorId, 'userA', '否决人应记录为实际操作人 userA')
    // 软拒绝推进串行会签到下一成员：userB 任务应被创建且 DOING
    assert.ok(await doingTaskIdByActor(repo, instanceId, 'task1', 'userB'), '软拒绝后串行会签应推进到 userB（DOING）')
  })

  it('91 execute submitType=20 一票否决（13 并行 + ONE_VOTE_VETO，否决后废弃残留任务）', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
    const r0 = await facade.flow('processDefine/deploy', { content: readFileSync(flowDir + '13-countersign-one-vote-veto.json', 'utf-8') })
    assert.equal(r0.code, 0, r0.msg)
    const r1 = await facade.flow('processInstance/startAndExecute',
      { processDefineId: r0.data.processDefineId, operator: 'user1' })
    assert.equal(r1.code, 0, r1.msg)
    const instanceId: string = r1.data.processInstanceId
    // 并行会签全员预创建：userA/userB/userC 三个 DOING 任务
    const taskA = await doingTaskIdByActor(repo, instanceId, 'task1', 'userA')
    const taskB = await doingTaskIdByActor(repo, instanceId, 'task1', 'userB')
    const taskC = await doingTaskIdByActor(repo, instanceId, 'task1', 'userC')
    assert.ok(taskA && taskB && taskC, '并行会签应预创建 userA/userB/userC 三个 DOING 任务')
    await repo.addTaskActor(taskA!, ['userA'])
    // userA 会签不同意（已配 ONE_VOTE_VETO → 一票否决）
    const r = await facade.flow('processTask/execute', { processTaskId: taskA, operator: 'userA', submitType: 20 })
    assert.equal(r.code, 0, r.msg)
    const inst = await repo.findInstanceById(instanceId)
    assert.equal(inst!.state, InstanceState.Done, `一票否决后会签节点应立即推进 end（实例 DONE 20）: ${inst?.state}`)
    assert.equal(Number(inst!.variables.countersignDisagreeFlag), 1, 'countersignDisagreeFlag=1 应落实例变量')
    const doneA = await repo.findTaskById(taskA!)
    assert.equal(doneA!.taskState, TaskState.Done, '否决任务应已完成')
    assert.equal(doneA!.actorId, 'userA', '否决人应记录为实际操作人 userA')
    // 否决应废弃其余成员（ABANDONED 99）
    for (const tid of [taskB!, taskC!]) {
      const tk = await repo.findTaskById(tid)
      assert.equal(tk!.taskState, TaskState.Abandoned, `否决应废弃其余成员任务为 ABANDONED(99): id=${tid}`)
    }
    assert.equal((await repo.findDoingTasks(instanceId)).length, 0, '否决后应无 DOING 任务')
  })

  it('91 execute submitType=20 并行软拒绝（05 未配 ONE_VOTE_VETO，其余成员保持 DOING）', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
    const r0 = await facade.flow('processDefine/deploy', { content: readFileSync(flowDir + '05-countersign-parallel.json', 'utf-8') })
    assert.equal(r0.code, 0, r0.msg)
    const r1 = await facade.flow('processInstance/startAndExecute',
      { processDefineId: r0.data.processDefineId, operator: 'user1' })
    assert.equal(r1.code, 0, r1.msg)
    const instanceId: string = r1.data.processInstanceId
    const taskA = await doingTaskIdByActor(repo, instanceId, 'task1', 'userA')
    const taskB = await doingTaskIdByActor(repo, instanceId, 'task1', 'userB')
    const taskC = await doingTaskIdByActor(repo, instanceId, 'task1', 'userC')
    assert.ok(taskA && taskB && taskC, '并行会签应预创建 userA/userB/userC 三个 DOING 任务')
    await repo.addTaskActor(taskA!, ['userA'])
    // userA 会签不同意（未配 ONE_VOTE_VETO → 软拒绝）
    const r = await facade.flow('processTask/execute', { processTaskId: taskA, operator: 'userA', submitType: 20 })
    assert.equal(r.code, 0, r.msg)
    const inst = await repo.findInstanceById(instanceId)
    assert.equal(inst!.state, InstanceState.Doing, `并行软拒绝后实例应保持 DOING(10)，等 userB/userC: ${inst?.state}`)
    assert.equal(Number(inst!.variables.countersignDisagreeFlag), 1, 'countersignDisagreeFlag=1 应落实例变量')
    const doneA = await repo.findTaskById(taskA!)
    assert.equal(doneA!.taskState, TaskState.Done, '软拒绝任务应正常完成')
    for (const tid of [taskB!, taskC!]) {
      const tk = await repo.findTaskById(tid)
      assert.equal(tk!.taskState, TaskState.Doing, `软拒绝不应废弃其余成员，应保持 DOING: id=${tid}`)
    }
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

  it('82-5 taskDetail 任务级 ext.isFirstTaskNode（前端 detail.vue 双兜底，对齐 Java 1912456）', async () => {
    // 场景 1：startAndExecute 自动完成 apply → 剩 task1（DOING，非首节点）→ false
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
    const c1 = readFileSync(flowDir + '01-simple.json', 'utf-8')
    const r0 = await facade.flow('processDefine/deploy', { content: c1 })
    assert.equal(r0.code, 0, JSON.stringify(r0))
    const r1 = await facade.flow('processInstance/startAndExecute',
      { processDefineId: r0.data.processDefineId, operator: 'zhangsan' })
    assert.equal(r1.code, 0, JSON.stringify(r1))
    const instanceId = r1.data.processInstanceId
    const task1Id = await doingTaskId(repo, instanceId, 'task1')
    assert.ok(task1Id, '应有 task1 进行中任务')
    const r = await facade.flow('processTask/detail', { id: task1Id, operator: 'leader' })
    assert.equal(r.code, 0, JSON.stringify(r))
    assert.ok(r.data.ext && typeof r.data.ext === 'object', JSON.stringify(r.data))
    assert.equal(r.data.ext.isFirstTaskNode, false, 'task1 非首任务节点，ext.isFirstTaskNode 应为 false')

    // 场景 2：直接启动（不自动完成 apply）→ apply 为首任务节点且 DOING → true
    const { engine: engine2, repo: repo2 } = setup()
    const facade2 = new JeeflowFacade(engine2, repo2, new MemoryExtRepository())
    const def = loadFlow(repo2, '01-simple.json')
    const inst2 = await engine2.startProcessInstanceById(def.id, 'zhangsan', {})
    const applyId = await doingTaskId(repo2, inst2.id, 'apply')
    assert.ok(applyId, 'apply 应为进行中任务')
    const r2 = await facade2.flow('processTask/detail', { id: applyId, operator: 'zhangsan' })
    assert.equal(r2.code, 0, JSON.stringify(r2))
    assert.ok(r2.data.ext && typeof r2.data.ext === 'object', JSON.stringify(r2.data))
    assert.equal(r2.data.ext.isFirstTaskNode, true, 'apply 为首任务节点且 DOING，ext.isFirstTaskNode 应为 true')
  })

  it('82 按 id 查"记录不存在"负向（对齐 PHP 模板 / Java 1912456）', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
    const bigId = '999999999999999999'

    const rd = await facade.flow('processDefine/detail', { id: bigId })
    assert.equal(rd.code, 99999999, JSON.stringify(rd))
    assert.ok(rd.msg.includes('流程定义不存在'), rd.msg)

    const ri = await facade.flow('processInstance/detail', { id: bigId })
    assert.equal(ri.code, 99999999, JSON.stringify(ri))
    assert.ok(ri.msg.includes('流程实例不存在'), ri.msg)

    const rx = await facade.flow('processDesign/detail', { id: bigId })
    assert.equal(rx.code, 99999999, JSON.stringify(rx))
    assert.ok(rx.msg.includes('流程设计不存在'), rx.msg)

    const rt = await facade.flow('processTask/detail', { id: bigId, operator: 'leader' })
    assert.equal(rt.code, 99999999, JSON.stringify(rt))
    assert.ok(rt.msg.includes('任务不存在'), rt.msg)
  })

  it('82 抄送空 actors 报错负向（对齐 Java/Go/PHP 基准）：createCCInstance 空/缺失 actorIds → 99999999', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())

    // 空 actorIds list
    const r1 = await facade.flow('processInstance/createCCInstance',
      { processInstanceId: '123', operator: 'user1', actorIds: [] })
    assert.equal(r1.code, 99999999, JSON.stringify(r1))
    assert.ok(r1.msg.includes('actorIds 缺失'), r1.msg)

    // 负向边界：actorIds 键完全缺失同样报错
    const r2 = await facade.flow('processInstance/createCCInstance',
      { processInstanceId: '123', operator: 'user1' })
    assert.equal(r2.code, 99999999, JSON.stringify(r2))
    assert.ok(r2.msg.includes('actorIds 缺失'), r2.msg)
  })

  it('82 雪花 id 精度守卫（对齐 Go TestSnowflakeIDPrecision / issues/38 E9）：float64 超 2^53 显性报错，字符串精确解析', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())

    // ① 数字雪花 id（JSON.parse 降级为 float64，已丢精度）→ 显性报错（不静默截断）
    const r1 = await facade.flow('processInstance/startAndExecute',
      { processDefineId: 2084320543834124288, operator: 'user1' })
    assert.equal(r1.code, 99999999, JSON.stringify(r1))
    assert.ok(r1.msg.includes('超出 float64 精确范围'), r1.msg)

    // ② 字符串雪花 id → 精确解析（无该定义 → 报不存在，消息含原始完整 id）
    const SNOW = '2084320543834124290'
    const r2 = await facade.flow('processInstance/startAndExecute',
      { processDefineId: SNOW, operator: 'user1' })
    assert.equal(r2.code, 99999999, JSON.stringify(r2))
    assert.ok(r2.msg.includes(SNOW), `字符串应精确解析（消息应含原始雪花 id）: ${r2.msg}`)
  })

  it('83 嵌套对象 id 出口字符串化（82-4 / Python #76 对齐）：designDetail his 列表 + instanceDetail 任务行', async () => {
    const { engine, repo } = setup()
    const extRepo = new MemoryExtRepository()
    const facade = new JeeflowFacade(engine, repo, extRepo)

    // ── processDesign/detail 嵌套 his 列表（Python #76 同构；雪花大 id 奇数尾，float64 会改写值）──
    const SNOW = '17769128440810003' // 17 位 >2^53
    await extRepo.saveDesign({
      id: SNOW, name: 'his-flow', displayName: '历史流程', type: 'approval',
      isDeployed: 0, createTime: new Date(), createUser: 't', updateTime: new Date(), updateUser: 't',
    })
    await extRepo.saveDesignHis({ id: SNOW, processDesignId: SNOW, content: '{"v":2}', createTime: new Date(), createUser: 't' })
    await extRepo.saveDesignHis({ id: '17769128440810002', processDesignId: SNOW, content: '{"v":1}', createTime: new Date(), createUser: 't' })

    const r = await facade.flow('processDesign/detail', { id: SNOW })
    assert.equal(r.code, 0, JSON.stringify(r))
    const d = r.data
    assert.equal(d.id, SNOW, '主 id 必须精确字符串')
    assert.equal(typeof d.id, 'string', JSON.stringify(d.id))
    const his = d.his as Array<Record<string, any>>
    assert.equal(his.length, 2, JSON.stringify(d))
    for (const h of his) {
      assert.ok(h && typeof h === 'object', `his 项应为普通对象: ${JSON.stringify(h)}`)
      assert.equal(typeof h.id, 'string', `his[].id 必须字符串: ${JSON.stringify(h)}`)
      assert.equal(typeof h.processDesignId, 'string', `his[].processDesignId 必须字符串: ${JSON.stringify(h)}`)
    }
    // 逐条精确十进制（顺序非契约点）——若 id 中途经 float64/Number，奇数尾被舍入改写，字符串值即不同
    assert.deepEqual((his.map(h => h.id).sort()), ['17769128440810002', SNOW], JSON.stringify(his))
    assert.ok(his.every(h => h.processDesignId === SNOW), 'his[].processDesignId 应指向主设计')

    // ── processInstance/detail 嵌套任务行（activeTaskList/tasks）：雪花 defineId 发起 ──
    const { engine: engine2, repo: repo2 } = setup()
    const facade2 = new JeeflowFacade(engine2, repo2, new MemoryExtRepository())
    repo2.addDefine({
      id: SNOW, name: 'simple', displayName: '简单审批', type: 'approval', state: 1,
      content: readFileSync(flowDir + '01-simple.json', 'utf-8'),
      version: 1, createTime: new Date(), updateTime: new Date(), createUser: '', updateUser: '',
    })
    const inst = await engine2.startProcessInstanceById(SNOW, 'user1')
    const ri = await facade2.flow('processInstance/detail', { id: inst.id })
    assert.equal(ri.code, 0, JSON.stringify(ri))
    const di = ri.data
    assert.equal(typeof di.id, 'string', `实例 id 必须字符串: ${JSON.stringify(di.id)}`)
    assert.equal(di.processDefineId, SNOW, 'processDefineId 必须精确字符串（雪花）')
    const active = di.activeTaskList as Array<Record<string, any>>
    assert.ok(Array.isArray(di.tasks) && (di.tasks as any[]).length >= 1, 'tasks 行非空')
    assert.equal(active.length, 1, 'apply 应 DOING')
    for (const row of [...(di.tasks as Array<Record<string, any>>), ...active]) {
      assert.equal(typeof row.id, 'string', `任务行 id 必须字符串: ${JSON.stringify(row)}`)
      assert.equal(typeof row.processInstanceId, 'string', `任务行 processInstanceId 必须字符串: ${JSON.stringify(row)}`)
    }
    assert.equal(active[0].taskName, 'apply')
  })

  it('10c CcCreate 事件：逐抄送人 fire + ccActorId 直传（issues/102）', async () => {
    const ccs: Array<{ instanceId: string; ccActorId?: string }> = []
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
    engine.setExtensions({
      listeners: [(e) => { if (e.type === EventType.CcCreate) ccs.push(e) }],
    })
    const content = readFileSync(flowDir + '01-simple.json', 'utf-8')
    const r0 = await facade.flow('processDefine/deploy', { content })
    assert.equal(r0.code, 0, JSON.stringify(r0))
    const defineId = r0.data.processDefineId

    // ① 发起带 f_ccActors（字符串逗号分隔）→ 逐抄送人 fire，ccActorId 顺序保真
    const r1 = await facade.flow('processInstance/startAndExecute',
      { processDefineId: defineId, operator: 'zhangsan', f_ccActors: 'alice,bob' })
    assert.equal(r1.code, 0, JSON.stringify(r1))
    const instanceId = r1.data.processInstanceId
    assert.strictEqual(ccs.length, 2, `want 2 CcCreate (alice,bob), got ${ccs.length}: ${JSON.stringify(ccs)}`)
    assert.deepStrictEqual(ccs.map((e) => e.ccActorId), ['alice', 'bob'], 'ccActorId 逐抄送人直传且顺序保真')
    for (const e of ccs) assert.ok(e.instanceId === instanceId, `instanceId 精确: ${JSON.stringify(e)}`)

    // ② 手动补抄送 → 第 3 个事件
    const r2 = await facade.flow('processInstance/createCCInstance',
      { processInstanceId: instanceId, operator: 'zhangsan', actorIds: 'carol' })
    assert.equal(r2.code, 0, JSON.stringify(r2))
    assert.strictEqual(ccs.length, 3, `want 3rd CcCreate (carol), got ${ccs.length}`)
    assert.equal(ccs[2].ccActorId, 'carol')

    // ③ cc 实例确实落库（事件 fire 时机不早于落库）
    const ccA = await repo.pageCcInstances(1, 10, 'alice')
    assert.equal(ccA.total, 1, 'alice 的 cc 行存在')
  })

  it('10d CcCreate 无监听器零副作用（纯增量，issues/102）', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
    // 不 setExtensions：ext/listeners 全空 → fireEvent 零副作用，与上一版行为逐字节一致
    const content = readFileSync(flowDir + '01-simple.json', 'utf-8')
    const r0 = await facade.flow('processDefine/deploy', { content })
    const r1 = await facade.flow('processInstance/startAndExecute',
      { processDefineId: r0.data.processDefineId, operator: 'zhangsan', f_ccActors: 'alice,bob' })
    assert.equal(r1.code, 0, JSON.stringify(r1))
    const r2 = await facade.flow('processInstance/createCCInstance',
      { processInstanceId: r1.data.processInstanceId, operator: 'zhangsan', actorIds: 'carol' })
    assert.equal(r2.code, 0, JSON.stringify(r2))
    for (const actor of ['alice', 'bob', 'carol']) {
      const cc = await repo.pageCcInstances(1, 10, actor)
      assert.equal(cc.total, 1, `${actor} 的 cc 行存在（无监听器不影响落库）`)
    }
  })

  // ── 统计三 action（v1.8.25，issues/103） ──────────────────────────────────

  function seedStats(repo: MemoryRepository, now_?: Date) {
    const now = now_ ?? new Date()
    const def: ProcessDefine = {
      id: '100', name: 'stats-flow', displayName: '统计测试流程', type: 'oa',
      state: 1, content: '', version: 1,
      createTime: now, updateTime: now, createUser: '', updateUser: '',
    }
    repo.addDefine(def)

    const inst100 = new ProcessInstance({
      id: '100', defineId: '100', state: InstanceState.Done, operator: 'alice',
      parentNodeName: '', businessNo: '', variables: {},
      createTime: new Date(now.getTime() - 2 * 3600_000),
      updateTime: now, createUser: 'alice', updateUser: 'alice',
    })
    const inst101 = new ProcessInstance({
      id: '101', defineId: '100', state: InstanceState.Doing, operator: 'charlie',
      parentNodeName: '', businessNo: '', variables: {},
      createTime: new Date(now.getTime() - 1 * 3600_000),
      updateTime: now, createUser: 'charlie', updateUser: 'charlie',
    })
    const inst102 = new ProcessInstance({
      id: '102', defineId: '100', state: InstanceState.Reject, operator: 'alice',
      parentNodeName: '', businessNo: '', variables: {},
      createTime: new Date(now.getTime() - 24 * 3600_000),
      updateTime: now, createUser: 'alice', updateUser: 'alice',
    })
    const inst103 = new ProcessInstance({
      id: '103', defineId: '100', state: InstanceState.Done, operator: 'frank',
      parentNodeName: '', businessNo: '', variables: {},
      createTime: new Date(now.getTime() - 2 * 24 * 3600_000),
      updateTime: now, createUser: 'frank', updateUser: 'frank',
    })
    for (const inst of [inst100, inst101, inst102, inst103]) repo.saveInstance(inst)

    const task1000 = new ProcessTask({
      id: '1000', processInstanceId: '100', taskName: 'approve', displayName: '审批节点A',
      taskType: 0, performType: 0, taskState: TaskState.Done, actorId: 'bob',
      finishTime: new Date(inst100.createTime.getTime() + 3600_000),
      createTime: inst100.createTime, updateTime: now, createUser: 'bob', updateUser: 'bob',
    })
    const task1001 = new ProcessTask({
      id: '1001', processInstanceId: '101', taskName: 'approve', displayName: '审批节点B',
      taskType: 0, performType: 0, taskState: TaskState.Doing, actorId: '',
      expireTime: new Date(now.getTime() - 1 * 3600_000),
      createTime: inst101.createTime, updateTime: now, createUser: 'charlie', updateUser: 'charlie',
    })
    const task1003 = new ProcessTask({
      id: '1003', processInstanceId: '103', taskName: 'countersign', displayName: '会签节点',
      taskType: 0, performType: 1, taskState: TaskState.Done, actorId: 'gina',
      finishTime: new Date(inst103.createTime.getTime() + 10800_000),
      createTime: inst103.createTime, updateTime: now, createUser: 'gina', updateUser: 'gina',
    })
    for (const t of [task1000, task1001, task1003]) repo.saveTask(t)
    repo.addTaskActor('1001', ['dave', 'eve'])

    return { now, def, inst100, inst101, inst102, inst103, task1000, task1001, task1003 }
  }

  describe('stats overview', () => {
    it('空库 overview 全 0', async () => {
      const { repo } = setup()
      const facade = new JeeflowFacade(null as any, repo, new MemoryExtRepository())
      const r = await facade.flow('processInstance/stats/overview', {})
      assert.equal(r.code, 0, JSON.stringify(r))
      const d = r.data
      for (const k of ['total', 'inProgress', 'completed', 'rejected', 'withdrawn', 'suspended', 'todayNew', 'pendingTaskCount', 'overdueTaskCount']) {
        assert.equal(d[k], 0, `${k} should be 0`)
      }
      assert.equal(d.avgDurationSeconds, 0)
      assert.equal(d.rejectRate, 0)
      assert.equal(d.countersignRate, 0)
      assert.equal(d.onTimeRate, 0)
    })

    it('有数据 overview 13 字段', async () => {
      const { repo } = setup()
      const facade = new JeeflowFacade(null as any, repo, new MemoryExtRepository())
      const seeded = seedStats(repo)
      const r = await facade.flow('processInstance/stats/overview', {})
      assert.equal(r.code, 0, JSON.stringify(r))
      const d = r.data
      assert.equal(d.total, 4)
      assert.equal(d.inProgress, 1)
      assert.equal(d.completed, 2)
      assert.equal(d.rejected, 1)
      assert.equal(d.withdrawn, 0)
      assert.equal(d.suspended, 0)
      // 种子用 now-2h/now-1h 相对时间，跨午夜运行时部分实例落在昨日 → 按种子动态算
      const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
      const todayCnt = [seeded.inst100, seeded.inst101, seeded.inst102, seeded.inst103].filter(i => sameDay(i.createTime, seeded.now)).length
      assert.equal(d.todayNew, todayCnt, `created-today instances = ${todayCnt}`)
      // avgDurationSeconds: inst100→3600s, inst103→10800s → avg=7200
      assert.equal(d.avgDurationSeconds, 7200)
      // rejectRate: 1/max(1,2+1) = 0.3333
      assert.equal(d.rejectRate, 0.3333)
      assert.equal(d.pendingTaskCount, 1)
      assert.equal(d.overdueTaskCount, 1)
      // countersignRate: 1 countersign(task1003) / 2 completed tasks = 0.5
      assert.equal(d.countersignRate, 0.5)
      // onTimeRate: no task has expireTime set AND finished → 0
      assert.equal(d.onTimeRate, 0)
    })

    it('stateIn 入参生效（B 自证），todayNew 不受影响', async () => {
      const { repo } = setup()
      const facade = new JeeflowFacade(null as any, repo, new MemoryExtRepository())
      const seeded = seedStats(repo)
      const r = await facade.flow('processInstance/stats/overview', { stateIn: [10] })
      assert.equal(r.code, 0, JSON.stringify(r))
      const d = r.data
      assert.equal(d.total, 1, 'only inst101 (Doing) matches stateIn=[10]')
      assert.equal(d.inProgress, 1)
      assert.equal(d.completed, 0)
      const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
      const todayCnt = [seeded.inst100, seeded.inst101, seeded.inst102, seeded.inst103].filter(i => sameDay(i.createTime, seeded.now)).length
      assert.equal(d.todayNew, todayCnt, 'todayNew ignores stateIn (E)')
    })

    it('start/end 过滤 overview', async () => {
      const { repo } = setup()
      const facade = new JeeflowFacade(null as any, repo, new MemoryExtRepository())
      const now = new Date()
      seedStats(repo, now)
      // filter: only instances created 2.5h–0.5h ago → inst100(2h ago) and inst101(1h ago)
      const start = new Date(now.getTime() - 2.5 * 3600_000)
      const end = new Date(now.getTime() - 0.5 * 3600_000)
      const r = await facade.flow('processInstance/stats/overview', { start: fmtDt(start), end: fmtDt(end) })
      assert.equal(r.code, 0, JSON.stringify(r))
      const d = r.data
      assert.equal(d.total, 2, 'inst100 + inst101 in window')
      assert.equal(d.completed, 1, 'only inst100 is Done in window')
      assert.equal(d.inProgress, 1, 'inst101 is Doing in window')
    })
  })

  describe('stats trend', () => {
    it('空库 trend 全 0 桶', async () => {
      const { repo } = setup()
      const facade = new JeeflowFacade(null as any, repo, new MemoryExtRepository())
      const now = new Date()
      const start = new Date(now.getTime() - 2 * 86400_000)
      const r = await facade.flow('processInstance/stats/trend', {
        granularity: 'day',
        start: fmtDt(start),
        end: fmtDt(now),
      })
      assert.equal(r.code, 0, JSON.stringify(r))
      // A：data 本体为裸数组（无 {granularity, series} 包装）
      assert.ok(Array.isArray(r.data), `data should be a bare array, got ${typeof r.data}`)
      assert.ok(r.data.length >= 2)
      for (const s of r.data) {
        assert.equal(s.started, 0)
        assert.equal(s.finished, 0)
      }
    })

    it('day 粒度 trend 有数据', async () => {
      const { repo } = setup()
      const facade = new JeeflowFacade(null as any, repo, new MemoryExtRepository())
      const { now } = seedStats(repo)
      const start = new Date(now.getTime() - 3 * 86400_000)
      const r = await facade.flow('processInstance/stats/trend', {
        granularity: 'day',
        start: fmtDt(start),
        end: fmtDt(now),
      })
      assert.equal(r.code, 0, JSON.stringify(r))
      const series = r.data
      assert.ok(Array.isArray(series), 'data should be a bare array')
      assert.ok(series.length >= 3, `expected >=3 day buckets, got ${series.length}`)
      const totalStarted = series.reduce((s: number, b: any) => s + b.started, 0)
      assert.equal(totalStarted, 4, 'all 4 instances started')
      const totalFinished = series.reduce((s: number, b: any) => s + b.finished, 0)
      assert.equal(totalFinished, 2, '2 tasks finished (task1000 + task1003)')
    })

    it('四种粒度均不报错', async () => {
      const { repo } = setup()
      const facade = new JeeflowFacade(null as any, repo, new MemoryExtRepository())
      const { now } = seedStats(repo)
      const start = new Date(now.getTime() - 30 * 86400_000)
      for (const g of ['hour', 'day', 'week', 'month']) {
        const r = await facade.flow('processInstance/stats/trend', {
          granularity: g,
          start: fmtDt(start),
          end: fmtDt(now),
        })
        assert.equal(r.code, 0, `${g} should succeed: ${JSON.stringify(r)}`)
        assert.ok(Array.isArray(r.data) && r.data.length > 0, `${g} should have buckets`)
      }
    })

    it('非法 granularity → 错误码', async () => {
      const { repo } = setup()
      const facade = new JeeflowFacade(null as any, repo, new MemoryExtRepository())
      const r = await facade.flow('processInstance/stats/trend', { granularity: 'abc' })
      assert.notEqual(r.code, 0, 'should fail on invalid granularity')
      assert.ok(r.msg.includes('granularity'), `msg should mention granularity: ${r.msg}`)
    })

    it('缺 start / 缺 end → 错误码（C 自证，不静默回退不限时间）', async () => {
      const { repo } = setup()
      const facade = new JeeflowFacade(null as any, repo, new MemoryExtRepository())
      const r1 = await facade.flow('processInstance/stats/trend', { granularity: 'day', end: '2026-08-02 00:00:00' })
      assert.notEqual(r1.code, 0, 'missing start should fail')
      const r2 = await facade.flow('processInstance/stats/trend', { granularity: 'day', start: '2026-08-01 00:00:00' })
      assert.notEqual(r2.code, 0, 'missing end should fail')
    })
  })

  describe('stats group', () => {
    it('空库 group 各维度空数组', async () => {
      const { repo } = setup()
      const facade = new JeeflowFacade(null as any, repo, new MemoryExtRepository())
      for (const dim of ['state', 'define', 'category', 'approver', 'applicant', 'node', 'stuckNode', 'stuckApprover', 'durationBucket']) {
        const r = await facade.flow('processInstance/stats/group', { dimension: dim })
        assert.equal(r.code, 0, `${dim} on empty: ${JSON.stringify(r)}`)
        // A：data 本体为裸数组（无 {dimension, rows} 包装）
        assert.ok(Array.isArray(r.data), `${dim} data should be a bare array`)
        if (dim === 'durationBucket') {
          assert.equal(r.data.length, 4, 'durationBucket always has 4 rows')
          for (const row of r.data) assert.equal(row.count, 0)
        } else {
          assert.equal(r.data.length, 0, `${dim} should be empty`)
        }
      }
    })

    it('state 维度', async () => {
      const { repo } = setup()
      const facade = new JeeflowFacade(null as any, repo, new MemoryExtRepository())
      seedStats(repo)
      const r = await facade.flow('processInstance/stats/group', { dimension: 'state' })
      assert.equal(r.code, 0, JSON.stringify(r))
      const rows = r.data
      // 2 Done(20), 1 Doing(10), 1 Reject(45) → sorted by count desc
      assert.ok(rows.length >= 2)
      assert.equal(rows[0].key, '20')
      assert.equal(rows[0].count, 2)
      assert.equal(rows[0].avgDurationSeconds, null)
    })

    it('define 维度', async () => {
      const { repo } = setup()
      const facade = new JeeflowFacade(null as any, repo, new MemoryExtRepository())
      seedStats(repo)
      const r = await facade.flow('processInstance/stats/group', { dimension: 'define' })
      assert.equal(r.code, 0, JSON.stringify(r))
      const rows = r.data
      assert.equal(rows.length, 1)
      assert.equal(rows[0].key, 'stats-flow')
      assert.equal(rows[0].label, '统计测试流程')
      assert.equal(rows[0].count, 4)
      assert.ok(rows[0].avgDurationSeconds != null, 'define should have avgDurationSeconds')
    })

    it('category 维度', async () => {
      const { repo } = setup()
      const facade = new JeeflowFacade(null as any, repo, new MemoryExtRepository())
      seedStats(repo)
      const r = await facade.flow('processInstance/stats/group', { dimension: 'category' })
      assert.equal(r.code, 0, JSON.stringify(r))
      const rows = r.data
      assert.equal(rows.length, 1)
      assert.equal(rows[0].key, 'oa')
      assert.equal(rows[0].count, 4)
    })

    it('approver 维度', async () => {
      const { repo } = setup()
      const facade = new JeeflowFacade(null as any, repo, new MemoryExtRepository())
      seedStats(repo)
      const r = await facade.flow('processInstance/stats/group', { dimension: 'approver' })
      assert.equal(r.code, 0, JSON.stringify(r))
      const rows = r.data
      // task1000: bob (Done), task1003: gina (Done) → 2 approvers each with count 1
      assert.equal(rows.length, 2)
      for (const row of rows) {
        assert.ok(['bob', 'gina'].includes(row.key))
        assert.equal(row.count, 1)
      }
    })

    it('applicant 维度', async () => {
      const { repo } = setup()
      const facade = new JeeflowFacade(null as any, repo, new MemoryExtRepository())
      seedStats(repo)
      const r = await facade.flow('processInstance/stats/group', { dimension: 'applicant' })
      assert.equal(r.code, 0, JSON.stringify(r))
      const rows = r.data
      // alice: 2 (inst100, inst102), charlie: 1, frank: 1 → sorted desc
      assert.equal(rows[0].key, 'alice')
      assert.equal(rows[0].count, 2)
    })

    it('node 维度', async () => {
      const { repo } = setup()
      const facade = new JeeflowFacade(null as any, repo, new MemoryExtRepository())
      seedStats(repo)
      const r = await facade.flow('processInstance/stats/group', { dimension: 'node' })
      assert.equal(r.code, 0, JSON.stringify(r))
      const rows = r.data
      // task1000: 审批节点A Done, task1003: 会签节点 Done → each count 1
      assert.equal(rows.length, 2)
      for (const row of rows) {
        assert.ok(['审批节点A', '会签节点'].includes(row.key))
        assert.equal(row.count, 1)
        assert.ok(row.avgDurationSeconds != null, 'node should have avgDurationSeconds')
      }
      // 审批节点A: 3600s, 会签节点: 10800s
      const nodeA = rows.find((r: any) => r.key === '审批节点A')
      assert.equal(nodeA.avgDurationSeconds, 3600)
      const nodeCS = rows.find((r: any) => r.key === '会签节点')
      assert.equal(nodeCS.avgDurationSeconds, 10800)
    })

    it('stuckNode 维度', async () => {
      const { repo } = setup()
      const facade = new JeeflowFacade(null as any, repo, new MemoryExtRepository())
      seedStats(repo)
      const r = await facade.flow('processInstance/stats/group', { dimension: 'stuckNode' })
      assert.equal(r.code, 0, JSON.stringify(r))
      const rows = r.data
      assert.equal(rows.length, 1)
      assert.equal(rows[0].key, '审批节点B')
      assert.equal(rows[0].count, 1)
    })

    it('stuckApprover 维度（每 actor 一行）', async () => {
      const { repo } = setup()
      const facade = new JeeflowFacade(null as any, repo, new MemoryExtRepository())
      seedStats(repo)
      const r = await facade.flow('processInstance/stats/group', { dimension: 'stuckApprover' })
      assert.equal(r.code, 0, JSON.stringify(r))
      const rows = r.data
      // task1001 has actors [dave, eve], both Doing → 2 rows each count 1
      assert.equal(rows.length, 2)
      const keys = rows.map((r: any) => r.key).sort()
      assert.deepEqual(keys, ['dave', 'eve'])
      for (const row of rows) assert.equal(row.count, 1)
    })

    it('durationBucket 维度（固定 4 桶定序）', async () => {
      const { repo } = setup()
      const facade = new JeeflowFacade(null as any, repo, new MemoryExtRepository())
      seedStats(repo)
      const r = await facade.flow('processInstance/stats/group', { dimension: 'durationBucket' })
      assert.equal(r.code, 0, JSON.stringify(r))
      const rows = r.data
      assert.equal(rows.length, 4)
      assert.equal(rows[0].key, 'sameDay')
      assert.equal(rows[1].key, '1to3d')
      assert.equal(rows[2].key, '3to7d')
      assert.equal(rows[3].key, 'over7d')
      // inst100: 3600s (<86400 → sameDay), inst103: 10800s (<86400 → sameDay)
      assert.equal(rows[0].count, 2, 'both completed instances are sameDay')
      assert.equal(rows[1].count, 0)
      assert.equal(rows[2].count, 0)
      assert.equal(rows[3].count, 0)
    })

    it('非法 dimension → 错误码', async () => {
      const { repo } = setup()
      const facade = new JeeflowFacade(null as any, repo, new MemoryExtRepository())
      const r = await facade.flow('processInstance/stats/group', { dimension: 'bogus' })
      assert.notEqual(r.code, 0, 'should fail on invalid dimension')
      assert.ok(r.msg.includes('dimension'), `msg should mention dimension: ${r.msg}`)
    })

    it('limit 参数生效', async () => {
      const { repo } = setup()
      const facade = new JeeflowFacade(null as any, repo, new MemoryExtRepository())
      seedStats(repo)
      const r = await facade.flow('processInstance/stats/group', { dimension: 'applicant', limit: 2 })
      assert.equal(r.code, 0, JSON.stringify(r))
      assert.equal(r.data.length, 2, 'limit=2 should return only top 2')
    })
  })

  it('监听器异常兜底：单监听器抛错不影响后续监听器与主流程（issues/104 P2）', async () => {
    const { engine, repo } = setup()
    const seen: string[] = []
    engine.setExtensions({
      listeners: [
        () => { throw new Error('boom') },
        async () => { seen.push('second') },
      ],
    })
    const content = readFileSync(flowDir + '01-simple.json', 'utf-8')
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
    const r0 = await facade.flow('processDefine/deploy', { content })
    assert.equal(r0.code, 0, JSON.stringify(r0))
    const r1 = await facade.flow('processInstance/startAndExecute', {
      processDefineId: r0.data.processDefineId, operator: 'alice',
    })
    assert.equal(r1.code, 0, '监听器异常不应影响发起主流程')
    // 流程全程 fire 多次事件（ProcessStart/TaskCreate/...），每次后续监听器都应被调
    assert.ok(seen.length >= 1 && seen.every(x => x === 'second'), `后续监听器应仍被调用：${seen}`)
  })

  describe('stats regression', () => {
    it('既有 action 不受 stats 影响', async () => {
      const { engine, repo } = setup()
      const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
      const content = readFileSync(flowDir + '01-simple.json', 'utf-8')
      const r0 = await facade.flow('processDefine/deploy', { content })
      assert.equal(r0.code, 0, JSON.stringify(r0))
      const r1 = await facade.flow('processInstance/startAndExecute', {
        processDefineId: r0.data.processDefineId, operator: 'alice',
      })
      assert.equal(r1.code, 0, JSON.stringify(r1))
      const r2 = await facade.flow('processInstance/page', { pageNum: 1, pageSize: 10, operator: 'alice' })
      assert.equal(r2.code, 0, JSON.stringify(r2))
      assert.ok(r2.data.recordCount >= 1)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// issues/116 委托代理自动生效（引擎内置、默认开启）——内存仓路径
// spec 06 §4.5 运行期语义 6 条 / spec 05 SurrogateInterceptor / 08 合规用例 26·27
// ─────────────────────────────────────────────────────────────────────────────

describe('issues/116 委托代理自动生效（引擎内置·内存仓路径）', () => {
  // 标准装配链：门面构造时把扩展仓储注入引擎（集成方零配置即开启）
  function setupExt() {
    const { engine, repo } = setup()
    const ext = new MemoryExtRepository()
    const facade = new JeeflowFacade(engine, repo, ext)
    return { engine, repo, ext, facade }
  }

  async function deploySimple(facade: JeeflowFacade): Promise<string> {
    const content = readFileSync(flowDir + '01-simple.json', 'utf-8')
    const r = await facade.flow('processDefine/deploy', { content, operator: 'zhangsan' })
    assert.equal(r.code, 0, JSON.stringify(r))
    return String(r.data.processDefineId)
  }

  const dayMs = 86400000

  it('用例26 正向：窗口内配"张三→李四"→ 李四真的落进任务参与者，张三那行仍在', async () => {
    const { engine, repo, facade } = setupExt()
    const defineId = await deploySimple(facade)
    // 张三→李四（精确流程名 simple）；leader→王五（空流程名 = 全流程兜底）
    assert.equal((await facade.flow('processSurrogate/save', {
      operator: 'zhangsan', surrogate: 'lisi', processName: 'simple',
      startTime: fmtDt(new Date(Date.now() - dayMs)), endTime: fmtDt(new Date(Date.now() + dayMs)),
    })).code, 0)
    assert.equal((await facade.flow('processSurrogate/save', {
      operator: 'leader', surrogate: 'wangwu', processName: '',
    })).code, 0)
    assert.ok(engine.isSurrogateEnabled(), '门面装配后默认开启')

    const inst = await engine.startProcessInstanceById(defineId, 'zhangsan')
    const apply = (await repo.findDoingTasks(inst.id))[0]
    assert.equal(apply.taskName, 'apply')
    // ① 落库读回（不是内存对象快照）：任务参与者 = 授权人 + 代理人
    assert.deepEqual(await repo.findTaskActors(apply.id), ['zhangsan', 'lisi'],
      '李四应在 actor 表真有一行，且张三那行仍在（委托不摘原人）')
    // ② 代理人待办分页真能查到该单（读回值，非"doing 列表为空"式空断言）
    const todoLi = await repo.pageTodoTasks(1, 50, 'lisi')
    assert.ok(todoLi.rows.some(t => t.id === apply.id), '李四待办应出现该单')
    assert.ok((await repo.pageTodoTasks(1, 50, 'zhangsan')).rows.some(t => t.id === apply.id),
      '张三待办应保留（任一可办）')

    // ③ 代理人直接办结（鉴权走 actorIds 读回值 → 委托真的能办，不只是多一行数据）
    await engine.executeProcessTask(apply.id, 'lisi')
    const task1 = (await repo.findDoingTasks(inst.id))[0]
    assert.equal(task1.taskName, 'task1', '李四办结 apply 后流程应推进')
    // ④ 第二跳：空 processName 全流程兜底委托也在建单那一刻并入（判据 a）
    assert.deepEqual(await repo.findTaskActors(task1.id), ['leader', 'wangwu'],
      '空 processName 兜底委托应在建单时并入（判据 a）')
    // ⑤ 二级代理人办结 → 流程走完（端到端证明"并入的人可办且办得掉"）
    await engine.executeProcessTask(task1.id, 'wangwu')
    const done = await repo.findInstanceById(inst.id)
    assert.equal(done?.state, InstanceState.Done, '代理人办完两级后流程应结束')
  })

  it('用例26 负向：窗外 / enabled=0 / 自委托 → 代理人无行', async () => {
    const { engine, repo, ext, facade } = setupExt()
    const defineId = await deploySimple(facade)
    // 窗外（已结束）
    await facade.flow('processSurrogate/save', {
      operator: 'zhangsan', surrogate: 'agent-expired', processName: 'simple',
      startTime: fmtDt(new Date(Date.now() - 3 * dayMs)), endTime: fmtDt(new Date(Date.now() - 2 * dayMs)),
    })
    // 未开始
    await facade.flow('processSurrogate/save', {
      operator: 'leader', surrogate: 'agent-future', processName: 'simple',
      startTime: fmtDt(new Date(Date.now() + 2 * dayMs)), endTime: fmtDt(new Date(Date.now() + 3 * dayMs)),
    })
    // enabled=0（停用）
    await facade.flow('processSurrogate/save', {
      operator: 'lisi', surrogate: 'agent-off', processName: 'simple', enabled: 0,
    })
    // 自委托：自己委托给自己
    await facade.flow('processSurrogate/save', {
      operator: 'wangwu', surrogate: 'wangwu', processName: 'simple',
    })

    // 窗外 / 未到窗：建单读回仍是原参与者
    const inst = await engine.startProcessInstanceById(defineId, 'zhangsan')
    const apply = (await repo.findDoingTasks(inst.id))[0]
    assert.deepEqual(await repo.findTaskActors(apply.id), ['zhangsan'], '窗外委托不应并入（判据 b）')
    await engine.executeProcessTask(apply.id, 'zhangsan')
    const task1 = (await repo.findDoingTasks(inst.id))[0]
    assert.equal(task1.taskName, 'task1')
    assert.deepEqual(await repo.findTaskActors(task1.id), ['leader'], '未到窗委托不应并入（判据 b）')

    // enabled=0 + 自委托：把两人直接做成参与人，确证两条委托都没并进来新行
    const inst2 = await engine.startProcessInstanceById(defineId, 'lisi', {
      tf_nextNodeOperator: 'lisi,wangwu',
    })
    const apply2 = (await repo.findDoingTasks(inst2.id))[0]
    assert.deepEqual(await repo.findTaskActors(apply2.id), ['lisi', 'wangwu'],
      'enabled=0 与自委托均不得并入（判据 c/d）')
    // 仓储侧同口径复核（同一条数据在查询层也不该命中）
    assert.equal(await ext.getSurrogate('lisi', 'simple'), null, 'enabled=0 仓储侧也不生效')
    assert.equal(await ext.getSurrogate('wangwu', 'simple'), null, '自委托仓储侧也不生效')
  })

  it('用例26 静默跳过：未配置扩展仓储 → 建单不被打断', async () => {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, undefined)
    assert.equal(engine.isSurrogateEnabled(), false, '未注入查询源 → 委托能力未启用')
    const defineId = await deploySimple(facade)
    const r = await facade.flow('processInstance/startAndExecute', {
      processDefineId: defineId, operator: 'zhangsan',
    })
    assert.equal(r.code, 0, `缺扩展仓储不得打断建单: ${JSON.stringify(r)}`)
    const inst = await repo.findInstanceById(String(r.data.processInstanceId))
    const doing = await repo.findDoingTasks(inst!.id)
    assert.ok(doing.length > 0, '实例应正常推进到待办节点')
    assert.deepEqual(await repo.findTaskActors(doing[0].id), ['leader'], '参与者原样（无代理人）')
  })

  it('用例26 静默跳过：查询源抛错也只跳过该参与人，不打断建单', async () => {
    const { engine, repo } = setup()
    engine.setSurrogateRepository({
      getSurrogate: async (op: string) => {
        if (op === 'leader') throw new Error('模拟委托表不存在')
        return null
      },
    })
    const defineId = await deploySimple(new JeeflowFacade(engine, repo))
    const inst = await engine.startProcessInstanceById(defineId, 'zhangsan')
    const apply = (await repo.findDoingTasks(inst.id))[0]
    await engine.executeProcessTask(apply.id, 'zhangsan')
    const task1 = (await repo.findDoingTasks(inst.id))[0]
    assert.equal(task1.taskName, 'task1', '委托查询异常不应中断流程推进')
    assert.deepEqual(await repo.findTaskActors(task1.id), ['leader'])
  })

  it('用例26 显式关闭：三条关闭路均回到"仅台账"（委托行仍在，只是运行期不并入）', async () => {
    // 路 1：开关 setSurrogateEnabled(false)
    {
      const { engine, repo, ext, facade } = setupExt()
      const defineId = await deploySimple(facade)
      await facade.flow('processSurrogate/save', { operator: 'zhangsan', surrogate: 'lisi', processName: 'simple' })
      engine.setSurrogateEnabled(false)
      assert.equal(engine.isSurrogateEnabled(), false)
      const inst = await engine.startProcessInstanceById(defineId, 'zhangsan')
      const apply = (await repo.findDoingTasks(inst.id))[0]
      assert.deepEqual(await repo.findTaskActors(apply.id), ['zhangsan'], '关闭后不并入代理人')
      const [rows] = await ext.pageSurrogates(1, 10, { operator: 'zhangsan' })
      assert.equal(rows.length, 1, '关闭只关运行期，台账仍在（processSurrogate/* 不受影响）')
    }
    // 路 2：摘掉查询源 setSurrogateRepository(null)
    {
      const { engine, repo, facade } = setupExt()
      const defineId = await deploySimple(facade)
      await facade.flow('processSurrogate/save', { operator: 'zhangsan', surrogate: 'lisi', processName: 'simple' })
      engine.setSurrogateRepository(null)
      const inst = await engine.startProcessInstanceById(defineId, 'zhangsan')
      assert.deepEqual(await repo.findTaskActors((await repo.findDoingTasks(inst.id))[0].id), ['zhangsan'])
    }
    // 路 3：注册空实现（只覆盖 getSurrogate）
    {
      const { engine, repo, facade } = setupExt()
      const defineId = await deploySimple(facade)
      await facade.flow('processSurrogate/save', { operator: 'zhangsan', surrogate: 'lisi', processName: 'simple' })
      engine.setSurrogateRepository({ getSurrogate: async () => null })
      const inst = await engine.startProcessInstanceById(defineId, 'zhangsan')
      assert.deepEqual(await repo.findTaskActors((await repo.findDoingTasks(inst.id))[0].id), ['zhangsan'])
    }
    // 路 4：构造参数形态
    {
      const { repo, ext } = setupExt()
      const engine2 = new EngineImpl(repo, undefined, undefined, undefined, { surrogateRepository: ext, surrogateEnabled: false })
      const facade2 = new JeeflowFacade(engine2, repo, ext)
      const defineId = await deploySimple(facade2)
      await facade2.flow('processSurrogate/save', { operator: 'zhangsan', surrogate: 'lisi', processName: 'simple' })
      const inst = await engine2.startProcessInstanceById(defineId, 'zhangsan')
      assert.deepEqual(await repo.findTaskActors((await repo.findDoingTasks(inst.id))[0].id), ['zhangsan'],
        '构造参数 surrogateEnabled:false 应压过门面自动装配')
    }
  })

  it('多参与人任务：每人各自的代理人并入同一任务且去重（委托不新增会签成员）', async () => {
    const { engine, repo, facade } = setupExt()
    const defineId = await deploySimple(facade)
    await facade.flow('processSurrogate/save', { operator: 'zhangsan', surrogate: 'agent1', processName: 'simple' })
    await facade.flow('processSurrogate/save', { operator: 'leader', surrogate: 'agent1', processName: 'simple' })
    await facade.flow('processSurrogate/save', { operator: 'lisi', surrogate: 'agent2', processName: 'simple' })
    const inst = await engine.startProcessInstanceById(defineId, 'zhangsan', {
      tf_nextNodeOperator: 'zhangsan,leader,lisi',
    })
    const apply = (await repo.findDoingTasks(inst.id))[0]
    assert.deepEqual(await repo.findTaskActors(apply.id),
      ['zhangsan', 'leader', 'lisi', 'agent1', 'agent2'],
      '原参与人顺序不变，代理人按序追加且同名去重')
  })

  it('用例27 判据 a~d（内存仓）：空流程名兜底 / 时间窗 NULL 不限 / 自委托过滤 / enabled 只认 1', async () => {
    const ext = new MemoryExtRepository()
    const put = async (id: string, s: any) => {
      await ext.saveSurrogate({ id, createTime: new Date(), createUser: 't', updateTime: new Date(), updateUser: 't', ...s } as any)
    }
    // d：enabled 脏值一律不启用（'1' 与 1 同结论，与 SQL 侧 INT 列一致）
    await put('1', { operator: 'opD', surrogate: 'aTrue', enabled: 1, processName: 'p' })
    await put('2', { operator: 'opD', surrogate: 'aStr', enabled: '1', processName: 'p2' })
    await put('3', { operator: 'opD', surrogate: 'aAbc', enabled: 'abc', processName: 'p3' })
    await put('4', { operator: 'opD', surrogate: 'aBool', enabled: true as any, processName: 'p4' })
    await put('5', { operator: 'opD', surrogate: 'aNum', enabled: 2, processName: 'p5' })
    await put('6', { operator: 'opD', surrogate: 'aNull', enabled: null as any, processName: 'p6' })
    assert.equal((await ext.getSurrogate('opD', 'p'))?.surrogate, 'aTrue', 'enabled=1 生效')
    assert.equal((await ext.getSurrogate('opD', 'p2'))?.surrogate, 'aStr', "enabled='1' 与整数 1 同结论")
    for (const pn of ['p3', 'p4', 'p5', 'p6']) {
      assert.equal(await ext.getSurrogate('opD', pn), null, `脏值 enabled 不得当启用（${pn}）`)
    }
    // c：自委托过滤
    await put('10', { operator: 'opC', surrogate: 'opC', enabled: 1, processName: 'p' })
    assert.equal(await ext.getSurrogate('opC', 'p'), null, '自己委托给自己不生效')
    // b：时间窗任一侧 NULL = 该侧不限；字符串窗与 Date 窗同结论
    await put('20', { operator: 'opB', surrogate: 'bOpen', enabled: 1, processName: 'open', startTime: '2000-01-01 00:00:00' })
    await put('21', { operator: 'opB', surrogate: 'bPast', enabled: 1, processName: 'past', endTime: new Date(Date.now() - dayMs) })
    await put('22', { operator: 'opB', surrogate: 'bFuture', enabled: 1, processName: 'future', startTime: new Date(Date.now() + dayMs) })
    await put('23', { operator: 'opB', surrogate: 'bBoth', enabled: 1, processName: 'both',
      startTime: new Date(Date.now() - dayMs), endTime: new Date(Date.now() + dayMs) })
    assert.equal((await ext.getSurrogate('opB', 'open'))?.surrogate, 'bOpen', 'start 有值 end NULL = 结束侧不限')
    assert.equal(await ext.getSurrogate('opB', 'past'), null, '已过窗不生效')
    assert.equal(await ext.getSurrogate('opB', 'future'), null, '未到窗不生效')
    assert.equal((await ext.getSurrogate('opB', 'both'))?.surrogate, 'bBoth', '窗内生效')
    // a：精确命中优先于全流程兜底；无精确命中时用兜底
    await put('30', { operator: 'opA', surrogate: 'global', enabled: 1, processName: '' })
    await put('31', { operator: 'opA', surrogate: 'exact', enabled: 1, processName: 'special' })
    assert.equal((await ext.getSurrogate('opA', 'special'))?.surrogate, 'exact', '精确流程优先')
    assert.equal((await ext.getSurrogate('opA', 'other'))?.surrogate, 'global', '其它流程走全流程兜底')
    assert.equal((await ext.getSurrogate('opA', ''))?.surrogate, 'global', '引擎拿不到流程名时仍走兜底')
    // 多条兜底命中取最新（与 SQL 侧 ORDER BY id DESC LIMIT 1 同结论）
    await put('40', { operator: 'opZ', surrogate: 'globalOld', enabled: 1, processName: null })
    await put('41', { operator: 'opZ', surrogate: 'globalNew', enabled: 1, processName: '' })
    assert.equal((await ext.getSurrogate('opZ', 'anything'))?.surrogate, 'globalNew', '多条兜底取 id 最大')
    // NULL process_name 也算全流程兜底
    assert.equal((await ext.getSurrogate('opZ', 'anything'))?.surrogate, 'globalNew')
    assert.equal(await ext.getSurrogate('nobody', 'x'), null, '无授权人记录 → null')
  })

  // ── 逐条契约补测：1.1 取值口径 / 1.2 不级联 / 1 建单路径全覆盖 / 1.3 名册 / 1.4 id 最大 ──

  /** 直接写台账（跳过门面），便于构造乱序 id、脏 enabled 等边界行 */
  async function putSur(ext: MemoryExtRepository, s: Record<string, any>) {
    await ext.saveSurrogate({
      id: '', processName: '', enabled: 1, createTime: new Date(), createUser: 't',
      updateTime: new Date(), updateUser: 't', ...s,
    } as any)
  }

  it('契约 1.1 取值口径：define.name ≠ 模型 name 时取模型 name（诱饵行钉住）', async () => {
    const { engine, repo } = setup()
    const ext = new MemoryExtRepository()
    engine.setSurrogateRepository(ext)
    // loadFlow 直接落库：define.name = 文件名，而模型 JSON 的 name = 'simple'（两者刻意不同）
    const def = loadFlow(repo, '01-simple.json')
    assert.notEqual(String(def.name), 'simple', '诱饵前提：define.name 必须 ≠ 流程模型 name')
    await putSur(ext, { operator: 'applicant', surrogate: 'agentModel', processName: 'simple' })
    await putSur(ext, { operator: 'leader', surrogate: 'agentDefine', processName: String(def.name) })

    const inst = await engine.startProcessInstanceById(def.id, 'applicant')
    const apply = (await repo.findDoingTasks(inst.id))[0]
    assert.deepEqual(await repo.findTaskActors(apply.id), ['applicant', 'agentModel'],
      '必须按流程模型 name 命中（内置版 SurrogateInterceptor 用 processModel.getName() 的迁移基线）')
    await engine.executeProcessTask(apply.id, 'applicant')
    const task1 = (await repo.findDoingTasks(inst.id))[0]
    assert.deepEqual(await repo.findTaskActors(task1.id), ['leader'],
      '挂在 define.name 那一头的委托不得命中（本栈若改回取 define.name，此断言即红）')
  })

  it('契约 1.1 回落：模型未带 name 时才用 wf_process_define.name', async () => {
    const { engine, repo } = setup()
    const ext = new MemoryExtRepository()
    engine.setSurrogateRepository(ext)
    const def = loadFlow(repo, '01-simple.json')
    const bare = JSON.parse(String(def.content))
    delete bare.name
    def.content = JSON.stringify(bare)          // 模型不带 name（addDefine 存同一对象引用）
    def.name = 'define-only-name'
    await putSur(ext, { operator: 'applicant', surrogate: 'agentFallback', processName: 'define-only-name' })
    const inst = await engine.startProcessInstanceById(def.id, 'applicant')
    assert.deepEqual(await repo.findTaskActors((await repo.findDoingTasks(inst.id))[0].id),
      ['applicant', 'agentFallback'],
      '模型未带 name 时必须回落 define.name（否则内置版配的委托迁到 jeeflow 就永远命中不上）')
  })

  it('契约 1.2 不级联：A→B 且 B→C 时 C 不进参与者（环状 A→B→C→A 也不死循环）', async () => {
    const { engine, repo } = setup()
    const ext = new MemoryExtRepository()
    engine.setSurrogateRepository(ext)
    const def = loadFlow(repo, '01-simple.json')
    await putSur(ext, { operator: 'applicant', surrogate: 'agentB', processName: 'simple' })
    await putSur(ext, { operator: 'agentB', surrogate: 'agentC', processName: 'simple' })
    await putSur(ext, { operator: 'agentC', surrogate: 'applicant', processName: 'simple' })
    const inst = await engine.startProcessInstanceById(def.id, 'applicant')
    const apply = (await repo.findDoingTasks(inst.id))[0]
    assert.deepEqual(await repo.findTaskActors(apply.id), ['applicant', 'agentB'],
      '只对建单那一刻的原始参与者快照逐个查一次委托，代理人自身的委托不展开')
    assert.equal((await repo.pageTodoTasks(1, 50, 'agentC')).rows.length, 0, 'C 不得因环状委托收到该单')
  })

  it('串行会签第一步并入 + 条款 1.3 名册（每一步推进的并入由「条款 1 路径 3/3」独立钉）', async () => {
    const { engine, repo } = setup()
    const ext = new MemoryExtRepository()
    engine.setSurrogateRepository(ext)
    const def = loadFlow(repo, '06-countersign-sequential.json')   // 模型 name = countersign-sequential
    assert.notEqual(String(def.name), 'countersign-sequential', '诱饵前提：两仓名不同')
    await putSur(ext, { operator: 'userA', surrogate: 'agentA', processName: 'countersign-sequential' })
    // 注意：userB **不配**委托——推进路径的并入由专属用例（路径 3/3）独立钉死，
    // 本用例失能取证时只应暴露 createTask 的 SEQUENTIAL 分支挂点问题。
    const inst = await engine.startProcessInstanceById(def.id, 'applicant')
    const apply = (await repo.findDoingTasks(inst.id))[0]
    await engine.executeProcessTask(apply.id, 'applicant')

    let doing = await repo.findDoingTasks(inst.id)
    assert.equal(doing.length, 1, '串行会签一步一人')
    const step1 = doing[0]
    assert.deepEqual(await repo.findTaskActors(step1.id), ['userA', 'agentA'], '第一步并入 userA 的代理人')
    assert.deepEqual((await repo.findTaskById(step1.id))!.variables['operatorList_task1'], ['userA', 'userB'],
      '条款 1.3：代理人只进当一步任务，不得扩会签投票名册（否则改票数）')

    // 推进会出第二步任务（此处 userB 无委托 ⇒ 断言的是"无代理人时集合原样 + 名册仍不扩"，
    // 第二步并入代理人的正判据在「条款 1 路径 3/3 串行会签每一步推进」）
    await engine.executeProcessTask(step1.id, 'userA')
    doing = await repo.findDoingTasks(inst.id)
    const step2 = doing[0]
    assert.equal(step2.taskName, 'task1')
    assert.deepEqual(await repo.findTaskActors(step2.id), ['userB'], '第二步成员原样参与者（userB 未配委托）')
    assert.deepEqual((await repo.findTaskById(step2.id))!.variables['operatorList_task1'], ['userA', 'userB'],
      '条款 1.3：推进出的新单同样不改名册')
    await engine.executeProcessTask(step2.id, 'userB')
    assert.equal((await repo.findInstanceById(inst.id))!.state, InstanceState.Done, '两步走完流程应结束')
  })

  // ── 条款 1「覆盖范围」：流转中新增建任务路径各一条**独立**用例 ─────────────────
  // 三条路径各用**专属流程名 + 专属参与者 + 专属代理人**（互不共用——某路径失能时
  // 只有它自己的用例红，其余全绿）。断言一律落在 `findTaskActors` 读回的持久参与者行。
  // 挂点归属与"单路径失能"实测结论（本轮逐条注一遍跑全量，恢复后 git diff 核对逐字节回到改前）：
  //   · 串行会签推进 = engine.ts executeProcessTask 的 SEQUENTIAL 分支（:263 附近，**独占**挂点）
  //       → 只注它：全量恰好 1 红 = 「条款 1 路径 3/3」
  //   · ROLLBACK     = engine.ts createTaskWithActors（**独占**挂点，仅被 ROLLBACK 调用）
  //       → 只注它：全量恰好 1 红 = 「条款 1 路径 2/3」
  //   · JUMP         = executeNode → createTask，与「发起 / 办理推进 / 跳首节点」**共用同一挂点**，
  //       注掉整处挂点必连发起与条款 1.1 全家一起红，做不到"只红自己"——故用**路径内注入**取证：
  //       挂点内按本路径专属流程名 'surrjump116' 跳过委托应用（该流程内唯一对委托敏感的断言
  //       是 j2，起点自证保证 j1 无代理人 ⇒ 全量恰好 1 红 = 「条款 1 路径 1/3」。
  //       Go/Python 栈 JUMP 与发起共用 _create_task，取证方式与此同款）。

  it('条款 1 路径 1/3 跳转(JUMP)：委托只配跳转目标参与人，跳转新建任务并入代理人', async () => {
    const { engine, repo, ext, def } = surrHarness('surrjump116',
      surrFlowJson('surrjump116', [{ id: 'j1', assignee: 'jmp-zhang' }, { id: 'j2', assignee: 'jmp-wang' }]))
    await putSur(ext, { operator: 'jmp-wang', surrogate: 'jmp-agent', processName: 'surrjump116' })

    const inst = await engine.startProcessInstanceById(def.id, 'jmp-boss')
    assert.deepEqual(await doingActors(repo, inst.id, 'j1'), ['jmp-zhang'],
      '起点自证：发起产生的 j1 不该出现代理人（jmp-zhang 无委托）⇒ j2 里的代理人只可能由跳转路径写入')
    const j1 = (await repo.findDoingTasks(inst.id)).find(t => t.taskName === 'j1')!
    await engine.executeAndJumpTask(j1.id, 'jmp-zhang', {}, 'j2')
    assert.deepEqual(await doingActors(repo, inst.id, 'j2'), ['jmp-wang', 'jmp-agent'],
      '条款 1「跳转(JUMP)」：跳转新建的任务未并入代理人（期望 [jmp-wang jmp-agent]）')
  })

  it('条款 1 路径 2/3 回退(ROLLBACK)：回退新建上一节点任务并入回退操作人的代理人（诱饵配原参与人）', async () => {
    const { engine, repo, ext, def } = surrHarness('surrback116',
      surrFlowJson('surrback116', [{ id: 'b1', assignee: 'rbk-zhang' }, { id: 'b2', assignee: 'rbk-wang' }]))
    await putSur(ext, { operator: 'rbk-wang', surrogate: 'rbk-agent', processName: 'surrback116' })    // 回退操作人
    await putSur(ext, { operator: 'rbk-zhang', surrogate: 'rbk-decoy', processName: 'surrback116' })   // 诱饵：b1 原参与人

    const inst = await engine.startProcessInstanceById(def.id, 'rbk-boss')
    assert.deepEqual(await doingActors(repo, inst.id, 'b1'), ['rbk-zhang', 'rbk-decoy'],
      '起点自证：发起产生的 b1 只带 rbk-zhang 自己的代理人 ⇒ 回退新建 b1 里的代理人必须另有其人（rbk-agent）')
    const b1 = (await repo.findDoingTasks(inst.id)).find(t => t.taskName === 'b1')!
    await engine.executeProcessTask(b1.id, 'rbk-zhang')
    const b2 = (await repo.findDoingTasks(inst.id)).find(t => t.taskName === 'b2')!
    await engine.executeAndJumpTask(b2.id, 'rbk-wang', {})
    // 原 b1 已 Done，b1 上唯一进行中任务就是回退新建的那一条
    assert.deepEqual(await doingActors(repo, inst.id, 'b1'), ['rbk-wang', 'rbk-agent'],
      '条款 1「回退(ROLLBACK)」：回退新建的任务未并入代理人（期望 [rbk-wang rbk-agent]）')
  })

  it('条款 1 路径 3/3 串行会签每一步推进：推进出的下一步任务并入该成员代理人（1.3 名册顺带钉）', async () => {
    const { engine, repo, ext, def } = surrHarness('surrseq116',
      surrFlowJson('surrseq116', [{ id: 'cs', assignee: 'seq-zhang,seq-wang', countersign: 'SEQUENTIAL' }]))
    await putSur(ext, { operator: 'seq-wang', surrogate: 'seq-agent', processName: 'surrseq116' })

    const inst = await engine.startProcessInstanceById(def.id, 'seq-boss')
    assert.deepEqual(await doingActors(repo, inst.id, 'cs'), ['seq-zhang'],
      '起点自证：第一步任务不该出现代理人（seq-zhang 无委托，代理只配第二步成员）')
    const step1 = (await repo.findDoingTasks(inst.id)).find(t => t.taskName === 'cs')!
    await engine.executeProcessTask(step1.id, 'seq-zhang')
    const second = (await repo.findDoingTasks(inst.id)).filter(t => t.taskName === 'cs')
    assert.equal(second.length, 1, `串行会签推进后应恰好一条进行中任务: ${second.length}`)
    assert.equal(String((await repo.findTaskById(second[0].id))!.variables['loopCounter_cs']), '1',
      '自证：断言对象必须是串行会签第 2 步（loopCounter_cs=1），不是第一步残留')
    assert.deepEqual(await repo.findTaskActors(second[0].id), ['seq-wang', 'seq-agent'],
      '条款 1「串行会签的每一步推进」：推进出的下一步任务未并入代理人（期望 [seq-wang seq-agent]）')
    const vars2 = (await repo.findTaskById(second[0].id))!.variables
    assert.deepEqual(vars2['operatorList_cs'], ['seq-zhang', 'seq-wang'], '条款 1.3：代理人不得进投票名册')
    assert.equal(Number(vars2['nrOfInstances_cs']), 2, '条款 1.3：票数不得因代理人改变')
  })

  it('条款 1.4 多条命中取 id 最大：乱序写入 / 雪花 19 位都不被 Map 插入序带跑', async () => {
    const ext = new MemoryExtRepository()
    // ① 三条乱序：按插入顺序给 id 900 → 1000 → 950，期望命中 1000（**插入序中间位**）——
    //    "取遍历首条"答 900、"取插入末条"答 950、BigInt 比较退化成**字典序**也答 950
    //    （'950' > '1000'），三种错实现同红。SQL 侧主键序即数值序、等长 id 无此分叉，
    //    乱序夹具的判别力就在内存侧（surrparity.ts 头注同款事实）。
    await putSur(ext, { id: '900', operator: 'opOrd', surrogate: 'first' })
    await putSur(ext, { id: '1000', operator: 'opOrd', surrogate: 'max-mid' })
    await putSur(ext, { id: '950', operator: 'opOrd', surrogate: 'last' })
    assert.equal((await ext.getSurrogate('opOrd', 'x'))?.surrogate, 'max-mid',
      '全流程兜底组：id 数值最大 ≠ 插入首条 ≠ 插入末条 ≠ 字典序最大')
    // ② 先小后大：同样必须选 big（与 ① 合起来才排除"插入序"）
    await putSur(ext, { id: '100', operator: 'opAsc', surrogate: 'small' })
    await putSur(ext, { id: '900', operator: 'opAsc', surrogate: 'big' })
    assert.equal((await ext.getSurrogate('opAsc', 'x'))?.surrogate, 'big', '兜底组反向：仍取 id 最大')
    // ③ 精确组同样按 id 最大
    await putSur(ext, { id: '900', operator: 'opEx', surrogate: 'exBig', processName: 'p' })
    await putSur(ext, { id: '100', operator: 'opEx', surrogate: 'exSmall', processName: 'p' })
    assert.equal((await ext.getSurrogate('opEx', 'p'))?.surrogate, 'exBig', '精确组：取 id 最大')
    // ④ 雪花 19 位：Number 精度下两者相等，只有按数值（BigInt）比才能给对，对齐 BIGINT 列
    await putSur(ext, { id: '1827345678901234567', operator: 'opSf', surrogate: 'sfOld' })
    await putSur(ext, { id: '1827345678901234568', operator: 'opSf', surrogate: 'sfNew' })
    assert.equal((await ext.getSurrogate('opSf', 'anything'))?.surrogate, 'sfNew',
      '雪花 id 必须按数值比大小（Number 精度会塌成相等而错选首条）')
  })

  // ── 批次 D 收尾：条款 1.1 逐形态核实 + 缓存留痕 + 条款 1.4 共用夹具（内存侧）────

  it('契约 1.1 五种"未带 name"形态逐一回落 define.name（键缺失/null/空串/纯空白/tab 空格 + 回落值自身 trim）', async () => {
    const shapes: Array<[string, string | null | undefined]> = [
      ['键缺失', undefined], ['null', null], ['空串', ''], ['纯空白', '   '], ['制表符+空格', '\t '],
    ]
    let i = 0
    for (const [what, model] of shapes) {
      i++
      const dn = `fb-${i}-surr116`
      const { engine, repo, ext, def } = surrHarness(dn, surrFlowJson(model, [{ id: 'fbt', assignee: `fb${i}-zhang` }]))
      await putSur(ext, { operator: `fb${i}-zhang`, surrogate: `fb${i}-agent`, processName: dn })
      const inst = await engine.startProcessInstanceById(def.id, `fb${i}-boss`)
      assert.deepEqual(await doingActors(repo, inst.id, 'fbt'), [`fb${i}-zhang`, `fb${i}-agent`],
        `条款 1.1「模型 name ${what}」必须回落 wf_process_define.name=${dn} 并命中（先 trim 再判空）`)
    }
    // 回落值本身也 trim：define.name 带首尾空白、台账存的是干净名 ⇒ 不 trim 回落值就查不到
    const h = surrHarness('  spaced-def-surr116  ', surrFlowJson('   ', [{ id: 'fbt', assignee: 'fb-sp-zhang' }]))
    await putSur(h.ext, { operator: 'fb-sp-zhang', surrogate: 'fb-sp-agent', processName: 'spaced-def-surr116' })
    const inst = await h.engine.startProcessInstanceById(h.def.id, 'fb-sp-boss')
    assert.deepEqual(await doingActors(h.repo, inst.id, 'fbt'), ['fb-sp-zhang', 'fb-sp-agent'],
      '条款 1.1 回落值（define.name）也须 trim 后再查（台账存干净名，" 名 "查不到）')
  })

  it('契约 1.1 undefined 形态（typeof 守卫直调单点）：JSON 序列化后与"键缺失"等价，端到端上一条已覆盖', async () => {
    const { engine, def } = surrHarness('fb-undef-116', surrFlowJson(undefined, [{ id: 'fbt', assignee: 'fb-u-zhang' }]))
    const probe = await (engine as any).surrogateProcessName({ name: undefined }, { defineId: def.id })
    assert.equal(probe, 'fb-undef-116',
      'flow.name=undefined 必须走回落（typeof 守卫）；该形态经 JSON 序列化即成"键缺失"，端到端由上一条覆盖')
  })

  it('契约 1.1 传给委托查询的值必须 trim：假仓储捕获入参断言（不只断最终参与者）', async () => {
    const cap = new CaptureExt()
    const { engine, repo, def } = surrHarness('paddeddef-116',
      surrFlowJson('  padded-surr116  ', [{ id: 't1', assignee: 'pd-zhang' }]), cap)
    await putSur(cap, { operator: 'pd-zhang', surrogate: 'pd-agent', processName: 'padded-surr116' })
    const inst = await engine.startProcessInstanceById(def.id, 'pd-boss')
    assert.deepEqual(await doingActors(repo, inst.id, 't1'), ['pd-zhang', 'pd-agent'],
      '台账按干净名配置 ⇒ 只有引擎传出 trim 值才命中（" 名 " 与 "名" 必须命中同一条委托）')
    assert.ok(cap.queries.length > 0, '未捕获到任何 getSurrogate 调用，用例空转')
    const bad = cap.queries.filter(([, pn]) => pn !== 'padded-surr116')
    assert.deepEqual(bad, [],
      `传给委托查询的流程名必须是 trim 后的值，实测未 trim 入参：${JSON.stringify(bad)}`)
  })

  it('契约 1.1 回落读定义行抛错：按"拿不到流程名"只命中全流程兜底，不打断建单、不吞正常路径', async () => {
    const repo = new FlakyDefineRepo()
    const engine = new EngineImpl(repo, undefined, seqIdGen('tf'))
    const cap = new CaptureExt()
    engine.setSurrogateRepository(cap)
    const def = seedSurrDefine(repo, 'tf-surr116', surrFlowJson(undefined, [{ id: 't1', assignee: 'tf-zhang' }]))
    repo.badId = String(def.id)   // 首读（start 取 content）放行，其后回落读抛错
    await putSur(cap, { operator: 'tf-zhang', surrogate: 'tf-global', processName: '' })

    const inst = await engine.startProcessInstanceById(def.id, 'tf-boss')   // 不得抛
    assert.deepEqual(await doingActors(repo, inst.id, 't1'), ['tf-zhang', 'tf-global'],
      '回落抛错必须退回"拿不到流程名"：只命中全流程兜底（判据 4——委托是增强能力，绝不打断建单）')
    assert.deepEqual(cap.queries, [['tf-zhang', '']],
      `异常回落传给查询的流程名应为空串，实测 ${JSON.stringify(cap.queries)}`)

    // 不吞正常路径：另一条带模型 name 的流程在同一引擎上照常精确命中
    const def2 = seedSurrDefine(repo, 'tf2-surr116', surrFlowJson('tg-surr116', [{ id: 't2', assignee: 'tg-zhang' }]))
    await putSur(cap, { operator: 'tg-zhang', surrogate: 'tg-agent', processName: 'tg-surr116' })
    const inst2 = await engine.startProcessInstanceById(def2.id, 'tg-boss')
    assert.deepEqual(await doingActors(repo, inst2.id, 't2'), ['tg-zhang', 'tg-agent'],
      '一次回落异常不得把后续正常解析一起吞掉')
  })

  it('契约 1.1 defineName 缓存：一次 execution 解析后复用（不逐任务读）；命中值恒等于首读值 + "不失效"欠账留痕', async () => {
    // ① 不逐任务解析：fork 出两个任务节点、模型 name 纯空白 → 读定义行应恰 2 次
    //    （①发起取 content ②首次回落解析并缓存）；若逐任务回落解析会是 3 次。
    const repo = new CountDefineRepo()
    const engine = new EngineImpl(repo, undefined, seqIdGen('ck'))
    const ext = new MemoryExtRepository()
    engine.setSurrogateRepository(ext)
    const forkFlow = {
      name: '   ', displayName: '委托测试', type: 'approval',
      nodes: [
        { id: 'start', type: 'snaker:start', properties: {}, text: { value: '开始' } },
        { id: 'fork', type: 'snaker:fork', properties: {}, text: { value: '并行' } },
        { id: 'ckA', type: 'snaker:task', properties: { assignee: 'ck-zhang', taskType: 0, performType: 0 }, text: { value: 'ckA' } },
        { id: 'ckB', type: 'snaker:task', properties: { assignee: 'ck-wang', taskType: 0, performType: 0 }, text: { value: 'ckB' } },
        { id: 'end', type: 'snaker:end', properties: {}, text: { value: '结束' } },
      ],
      edges: [
        { id: 'e0', sourceNodeId: 'start', targetNodeId: 'fork', properties: {} },
        { id: 'e1', sourceNodeId: 'fork', targetNodeId: 'ckA', properties: {} },
        { id: 'e2', sourceNodeId: 'fork', targetNodeId: 'ckB', properties: {} },
        { id: 'e3', sourceNodeId: 'ckA', targetNodeId: 'end', properties: {} },
        { id: 'e4', sourceNodeId: 'ckB', targetNodeId: 'end', properties: {} },
      ],
    }
    const def = seedSurrDefine(repo, 'cache-def-surr116', JSON.stringify(forkFlow))
    await putSur(ext, { operator: 'ck-zhang', surrogate: 'ck-agent-a', processName: 'cache-def-surr116' })
    await putSur(ext, { operator: 'ck-wang', surrogate: 'ck-agent-b', processName: 'cache-def-surr116' })
    const inst = await engine.startProcessInstanceById(def.id, 'ck-boss')
    assert.deepEqual(await doingActors(repo, inst.id, 'ckA'), ['ck-zhang', 'ck-agent-a'], '分支 A 回落命中')
    assert.deepEqual(await doingActors(repo, inst.id, 'ckB'), ['ck-wang', 'ck-agent-b'], '分支 B 回落命中')
    assert.equal(repo.defineReads, 2,
      `回落解析必须缓存复用、不得逐任务读：findDefineById 次数 = ${repo.defineReads}, want 2（逐任务会是 3）`)

    // ② 命中缓存的值 == 首次读到的值（**已知欠账留痕**：本栈 defineNameCache 与 Go 同款
    //    跨 execution 不失效；Java 逐次 execution 现解、Python 每次 start 重播无此账。
    //    行为待 owner 拍板，本用例只钉"缓存值与首读一致"的现状，不做失效改造。）
    const h = surrHarness('cache-v1-116', surrFlowJson(undefined, [{ id: 't1', assignee: 'cc2-zhang' }]))
    await putSur(h.ext, { operator: 'cc2-zhang', surrogate: 'agent-v1', processName: 'cache-v1-116' })
    const i1 = await h.engine.startProcessInstanceById(h.def.id, 'cc2-boss')
    assert.deepEqual(await doingActors(h.repo, i1.id, 't1'), ['cc2-zhang', 'agent-v1'], '首跑回落读 V1 并命中')
    h.def.name = 'cache-v2-116'   // 改定义行名（模拟改名/重部署）；V2 委托 id 更大，重读必命中 V2
    await putSur(h.ext, { operator: 'cc2-zhang', surrogate: 'agent-v2', processName: 'cache-v2-116' })
    const i2 = await h.engine.startProcessInstanceById(h.def.id, 'cc2-boss')
    assert.deepEqual(await doingActors(h.repo, i2.id, 't1'), ['cc2-zhang', 'agent-v1'],
      '第二跑必须拿到与首跑一致的缓存值（agent-v1）——钉住"缓存命中==首读值"，同时留痕缓存不失效欠账')
  })

  it('条款 1.4 判别力夹具·内存仓侧：与真机 SQL 仓同一份数据+期望（__tests__/surrparity.ts 单一事实源）', async () => {
    const ext = new MemoryExtRepository()
    const failures: string[] = []
    await runParity(ext, 900000, (desc, ok, detail) => { if (!ok) failures.push(detail ? `${desc}（${detail}）` : desc) })
    assert.deepEqual(failures, [], '内存仓与共用期望表不一致：\n' + failures.join('\n'))
  })

  it('条款 5 判据 d 写侧：脏 enabled 归 0 落库且不打断保存（读回持久值）', async () => {
    const { engine, repo, ext, facade } = setupExt()
    const defineId = await deploySimple(facade)
    const r = await facade.flow('processSurrogate/save', {
      operator: 'zhangsan', surrogate: 'lisi', processName: 'simple', enabled: 'abc',
    })
    assert.equal(r.code, 0, `脏 enabled 不得报错打断保存: ${JSON.stringify(r)}`)
    assert.equal(Number((await facade.flow('processSurrogate/detail', { id: r.data.id })).data.enabled), 0,
      '脏值必须按停用落库（持久值读回）')
    assert.equal(await ext.getSurrogate('zhangsan', 'simple'), null, '脏值行仓储侧也不命中')
    const inst = await engine.startProcessInstanceById(defineId, 'zhangsan')
    assert.deepEqual(await repo.findTaskActors((await repo.findDoingTasks(inst.id))[0].id), ['zhangsan'],
      '脏值委托不得并入（不得默认当启用）')
    // 未传 = 契约默认 1；布尔 true/false 不算脏值
    const r2 = await facade.flow('processSurrogate/save', { operator: 'lisi', surrogate: 'agent2', processName: 'simple' })
    assert.equal(Number((await facade.flow('processSurrogate/detail', { id: r2.data.id })).data.enabled), 1,
      '未传 enabled 应落契约默认 1')
    const r3 = await facade.flow('processSurrogate/save', {
      operator: 'wangwu', surrogate: 'agent3', processName: 'simple', enabled: false,
    })
    assert.equal(Number((await facade.flow('processSurrogate/detail', { id: r3.data.id })).data.enabled), 0,
      'enabled:false 应落 0')
    const r4 = await facade.flow('processSurrogate/update', { id: r.data.id, operator: 'zhangsan', surrogate: 'lisi', processName: 'simple', enabled: '1' })
    assert.equal(r4.code, 0, JSON.stringify(r4))
    assert.equal(Number((await facade.flow('processSurrogate/detail', { id: r.data.id })).data.enabled), 1,
      "'1' 可解析为整数 1，应与整数 1 同结论")
  })
})

function fmtDt(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// ─── issues/116 批次 D 测试基建（形状对齐 Go mkFlow / Python _flow_json）─────────
// 自建线性流程 start → tasks… → end（节点 id 即 taskName）。name **原样**写入 JSON：
// 不传 = 不带键、null = "name": null、字符串（含空白）原样落盘——条款 1.1 各形态可精确构造。
function surrFlowJson(
  name: string | null | undefined,
  specs: Array<{ id: string; assignee: string; countersign?: string }>,
): string {
  const nodes: any[] = [{ id: 'start', type: 'snaker:start', properties: {}, text: { value: '开始' } }]
  const edges: any[] = []
  let prev = 'start'
  for (const s of specs) {
    const props: Record<string, any> = s.countersign
      ? { assignee: s.assignee, taskType: 0, performType: '1', countersignType: s.countersign }
      : { assignee: s.assignee, taskType: 0, performType: 0 }
    nodes.push({ id: s.id, type: 'snaker:task', properties: props, text: { value: s.id } })
    edges.push({ id: `e_${prev}_${s.id}`, sourceNodeId: prev, targetNodeId: s.id, properties: {} })
    prev = s.id
  }
  nodes.push({ id: 'end', type: 'snaker:end', properties: {}, text: { value: '结束' } })
  edges.push({ id: `e_${prev}_end`, sourceNodeId: prev, targetNodeId: 'end', properties: {} })
  const raw: Record<string, any> = { displayName: '委托测试', type: 'approval', nodes, edges }
  if (name !== undefined) raw.name = name
  return JSON.stringify(raw)
}

// 直接落定义行（**绕过门面 deploy 的 def.name = model.name 不变量**）——条款 1.1 的
// 诱饵/回落形态只有"define.name ≠ 模型 name"时才造得出来，与集成方自带导入链路同形。
function seedSurrDefine(repo: MemoryRepository, defineName: string, content: string): ProcessDefine {
  const def = {
    id: '', name: defineName, displayName: '委托测试', type: 'test', state: 1, content, version: 1,
    createTime: new Date(), createUser: 't', updateTime: new Date(), updateUser: 't',
  } as ProcessDefine
  repo.addDefine(def)
  return def
}

// 确定性发号：setup()/默认发号是 `Date.now()*1000+random`，同毫秒多单可撞号——
// 实例 id 相撞会让 findDoingTasks 翻倍、任务 id 相撞会让 saveTask 覆盖丢单
// （既有用例「07 countersign ratio」同型偶发红即此病根，非本批引入，建议挂账统一换种）。
function seqIdGen(prefix: string) {
  let n = 0
  return { nextId: () => `${prefix}-${++n}` }
}

// 引擎直用 + 注入扩展仓储（= 门面装配同形态，委托默认开启）；顺序发号保证 harness 内 id 唯一
function surrHarness(defineName: string, content: string, ext?: MemoryExtRepository) {
  const repo = new MemoryRepository()
  const engine = new EngineImpl(repo, undefined, seqIdGen('h'))
  const e = ext ?? new MemoryExtRepository()
  engine.setSurrogateRepository(e)
  const def = seedSurrDefine(repo, defineName, content)
  return { engine, repo, ext: e, def }
}

// 读回某节点进行中任务的**持久参与者行**（不看内存对象快照、不看待办空不空）
async function doingActors(repo: MemoryRepository, instId: string, node: string): Promise<string[]> {
  const doing = (await repo.findDoingTasks(instId)).filter(t => t.taskName === node)
  assert.equal(doing.length, 1, `节点 ${node} 进行中任务数 = ${doing.length}, want 1`)
  return repo.findTaskActors(doing[0].id)
}

/** 捕获 getSurrogate 真实入参的内存扩展仓储（条款 1.1「传出去必须 trim」的入参级断言用） */
class CaptureExt extends MemoryExtRepository {
  queries: Array<[string, string]> = []
  async getSurrogate(operator: string, processName: string, at = new Date()) {
    this.queries.push([operator, String(processName ?? '')])
    return super.getSurrogate(operator, processName, at)
  }
}

/** badId 定义行首读放行（start 取 content 必须成功），此后每次读抛错——模拟回落读定义行失败 */
class FlakyDefineRepo extends MemoryRepository {
  badId = ''
  private reads = new Map<string, number>()
  async findDefineById(id: string) {
    const k = String(id)
    const n = (this.reads.get(k) ?? 0) + 1
    this.reads.set(k, n)
    if (k === this.badId && n > 1) throw new Error('模拟定义行读取失败（含 content BLOB）')
    return super.findDefineById(id)
  }
}

/** 统计 findDefineById 次数（条款 1.1 尾注"逐次 execution 解析一次后复用"取证用） */
class CountDefineRepo extends MemoryRepository {
  defineReads = 0
  async findDefineById(id: string) {
    this.defineReads++
    return super.findDefineById(id)
  }
}

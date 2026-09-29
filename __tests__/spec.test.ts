import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EngineImpl, KeyAutoGenTitle, KeyCustomReturnVal, KeyRealName, KeyUserID } from '../src/engine.js'
import { HandlerRegistry, registerBuiltinAssignments } from '../src/index.js'
import { MemoryRepository } from '../src/memory.js'
import { MemoryExtRepository } from '../src/memory-ext.js'
// issues/129：SQL 仓那半在 T0 用**零连接探针**验（只取 buildWhere/位置参短路，不连任何数据库）
import { JdbcRepository } from '../src/jdbc/shared.js'
import { JdbcProcessExtRepository } from '../src/jdbc/ext.js'
import { JeeflowFacade } from '../src/facade.js'
import { InstanceState, TaskState, SubmitType, type ProcessDefine, ProcessInstance, ProcessTask } from '../src/model.js'
import type { ExpressionEvaluator, UserProvider } from '../src/spi.js'
// issues/141 G10：写侧兜底路径（java `default` 方法的 TS 对应物）＋ 单点判据要能直连测到
import { defaultCreateCcInstanceIfAbsent } from '../src/spi.js'
import { type FlowInterceptor, EventType, type EngineExtensions, type ProcessEvent,
  // issues/132 §11.6 改名兼容义务：旧成员名保留一代为别名（enum 外部的同值常量）
  ProcessStart, ProcessFinish, ProcessReject, TaskCreate, TaskComplete, CcCreate } from '../src/extensions.js'
// 别名必须从**包门面**（第三方可 import 的面）拿得到，不只是子路径
import * as pkg from '../src/index.js'
import { dir as flowsResolverDir } from '../flows-resolver.js'
import { runParity } from './surrparity.js'
// issues/130 案 A：判据（只认数值 1）与**边界还原**（驱动串化）分属两层，测试要分别钉住
import { surrogateEnabled, surrogateHydrateEnabled } from '../src/surrogate-rule.js'

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

  it('issues/121 P1 建单不变量：taskParentId 与行级 isFirstTaskNode 必写、门面读时行上值优先', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '02-multi-task.json')
    // 夹具是 apply→task1→task2→task3 四级链；两步流里"上一节点"与"首任务节点"同格＝断言恒真
    const inst = await engine.startProcessInstanceById(def.id, 'applicant')
    const facade = new JeeflowFacade(engine, repo, undefined)
    const extOf = async (name: string) => {
      const r = await facade.flow('processInstance/detail', { id: inst.id })
      assert.equal(r.code, 0, JSON.stringify(r))
      const row = r.data.tasks.find((x: any) => x.taskName === name)
      return row && row.ext && row.ext.isFirstTaskNode
    }

    const apply = (await repo.findDoingTasks(inst.id))[0]
    assert.equal(apply.taskName, 'apply')
    assert.equal(apply.parentTaskId, '0', '发起那条 execution 无当前任务 ⇒ parent 落 0（不是 null/undefined）')
    assert.equal(apply.variables.isFirstTaskNode, true, '首任务节点行应落 isFirstTaskNode=true')
    await repo.addTaskActor(apply.id, ['applicant'])
    await engine.executeProcessTask(apply.id, 'applicant')

    let prev = apply
    for (const [name, who] of [['task1', 'userA'], ['task2', 'userB'], ['task3', 'userC']] as const) {
      const t = (await repo.findDoingTasks(inst.id))[0]
      assert.equal(t.taskName, name)
      assert.equal(t.parentTaskId, prev.id, `${name}.parent 应为刚办结的 ${prev.taskName}.id`)
      assert.equal(t.variables.isFirstTaskNode, false, '非首节点必须 false')
      await repo.addTaskActor(t.id, [who])
      await engine.executeProcessTask(t.id, who)
      prev = t
    }

    // 本案真正要的那格：血缘版回退读的是已办结的历史行，标记必须随行存活
    const his = await repo.findTaskById(apply.id)
    assert.notEqual(his.taskState, 10, 'apply 应已办结')
    assert.equal(his.variables.isFirstTaskNode, true, '历史行标记必须还在（现算版在历史行上恒 false）')
    assert.equal(his.parentTaskId, '0', '历史行的血缘指针不应被后续路径覆写')

    // 门面出口：行上值优先 ⇒ 历史行也报 true；缺键（存量行）⇒ 回退现算 ⇒ false
    assert.equal(await extOf('apply'), true, '已办结的 apply 行出口应给行上值 true')
    his.variables = { ...his.variables }
    delete his.variables.isFirstTaskNode
    await repo.updateTask(his)
    assert.equal(await extOf('apply'), false, '缺键的存量历史行回退现算（仅进行中口径）⇒ false，且不得报错')
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
        // issues/132 码表重排：旧名 ProcessStart/ProcessFinish 换成 §11.3 规范名
        // ProcessInstanceStart(1)/ProcessInstanceEnd(2)——**断言语义与期望序列一字未改**
        if (e.type === EventType.ProcessInstanceStart) events.push('start')
        if (e.type === EventType.TaskComplete) events.push('taskDone')
        if (e.type === EventType.ProcessInstanceEnd) events.push('finish')
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

  it('10b PROCESS_TASK_START 事件（落库后 fire / 会签逐任务，对齐 Java CreateTaskHandler / Rust）', async () => {
    const creates: Array<{ taskId?: string; nodeId?: string; instanceId: string; operator: string }> = []
    const { engine, repo } = setup()
    engine.setExtensions({
      listeners: [(e) => { if (e.type === EventType.ProcessTaskStart) creates.push(e) }],
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
    assert.ok(String(recRow?.ext?.tf_approvalComment ?? '')
      .includes('leader 转办给 lisi'), `审批记录文案可读转办: ${JSON.stringify(recRow)}`)
    assert.equal(recRow?.ext?.submitType, SubmitType.Transfer, '审批记录 submitType=7') // issues/124：行出口读 ext
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
    assert.equal(row?.ext?.tf_transferHistory?.length, 2, '审批记录透出两跳账本') // issues/124：行出口读 ext
    assert.equal(row?.ext?.submitType, SubmitType.Agree, '审批记录槽位读作办结动作')
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
    const rb1Actors = await repo.findTaskActors(rbTask1!)  // issues/121 P2 血缘版：复活行参与者＝该行办结人
    assert.ok(rb1Actors.includes('leader') && !rb1Actors.includes('manager'),
      `血缘版：复活行 actor 应为 task1 原办结人 leader，不该是执行回退的 manager：${rb1Actors}`)
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

  /**
   * issues/130 案 A · T0 enabled 脏值矩阵（内存仓路径，判据打在「委托是否命中」的**行为**上，
   * 不只看内部谓词返回值）。每格独立 processName 作用域、窗不限、代理人非空且≠授权人
   * ⇒ 命中与否只由 enabled 决定。严判据只认整数 1：正向整数 1 命中，0/2 及一切字符串/布尔/
   * null/undefined 落空。
   *
   * ⚠️ 台账原值必须**绕过两层写侧归一**才测得到判据本身：① 门面 `processSurrogate/*` 的入参归一
   * （`parseSurrogateEnabled`，issues/130 明令保留不动）、② 内存仓 `saveSurrogate` 的台账边界
   * （案 A 补的那一段：本表 enabled 建模 INT 列，`'1'` 直写就该落成数值 1，用例 27 的 p2 档靠它）。
   * 姿势同 PHP `SurrogateAutoApplyTest::testEnabledAcceptsOnlyIntegerOneAndNoEquivalentForms`：
   * 先 save 一条 enabled=1 的行，再用**不做归一的** `updateSurrogate` 把原值盖回台账——这恰好就是
   * issue §2 说的唯一显形路径（业务方自定义 SPI 仓储回行时传非整数 enabled）。
   * 每档先自检"台账里真的是这个值、这个类型"，否则负向断言只是空转。
   *
   * ⚠️ 关于「浮点 1.0」：JS 只有一个 Number 类型，字面量 `1.0 === 1` 且 `Number.isInteger(1.0) === true`，
   * 与整数 1 **在运行期无法区分**。issues/130 里"停用浮点 1.0"是 Python/PHP 的类型级概念
   * （Java/Go 用 `Integer`/`int` 静态列，1.0 根本存不进来，本栈无对应脏值可喂）。故本矩阵把
   * `1.0` 归入正向整数 1 一档（命中），与五栈严阵营的实际可观测行为一致，并在此钉死这个事实。
   */
  it('issues/130 案 A T0：enabled 脏值矩阵逐档不命中、整数 1 命中（内存仓·只认整数 1）', async () => {
    const ext = new MemoryExtRepository()
    let seq = 100
    const probe = async (label: string, enabled: any): Promise<boolean> => {
      const pn = `e130-${label}`
      const id = String(seq++)
      await putSur(ext, { id, operator: 'opE', surrogate: `agent-${label}`, processName: pn })
      const row = await ext.findSurrogateById(id)
      assert.ok(row, `${label}：委托行未落库（负向会空转）`)
      // 盖回台账原值：updateSurrogate 不归一（saveSurrogate 的写侧边界会把 '1' 落成数值 1）
      await ext.updateSurrogate({ ...row, enabled } as any)
      const ledger = await ext.findSurrogateById(id)
      assert.ok(ledger && 'enabled' in ledger, `${label}：前置自检失败——台账行没有 enabled 键`)
      assert.ok(Object.is(enabled, ledger!.enabled),
        `${label}：前置自检——台账里须真的是 ${String(enabled)}(${typeof enabled})，`
        + `实际是 ${String(ledger!.enabled)}(${typeof ledger!.enabled})，否则本档等于没测`)
      const hit = await ext.getSurrogate('opE', pn)
      return hit !== null && hit.surrogate === `agent-${label}`
    }
    // 正向：整数 1 → 命中
    assert.equal(await probe('int-1', 1), true, '整数 1 必须命中（正向对照，防判据写反成恒不命中）')
    // ⚠️ JS 里 1.0 === 1 ⇒ 与整数 1 同值，归入正向（见上注释）
    assert.equal(await probe('num-1.0', 1.0), true, 'JS 数值 1.0 与整数 1 无法区分 ⇒ 命中')
    // 逐档脏值 → 全部不命中（只认整数 1）
    const dirty: Array<[string, any]> = [
      ['int-0', 0],           // 停用合法值
      ['int-2', 2],           // 其它整数（阳性对照，issues/130 §4）
      ['str-1', '1'],         // 案 A 关键收窄：字符串 '1' 不再等价 1（判据层面；台账写侧边界另见 T1）
      ['str-1.0', '1.0'],     // 半宽病灶：'1.0' 曾经 Number.isInteger(Number(s)) 蒙混过关
      ['bool-true', true],
      ['str-x', 'x'],         // 阳性对照：不可解析串（issues/130 §4）
      ['undefined', undefined],
      ['null', null],
      ['empty-str', ''],
    ]
    for (const [label, v] of dirty) {
      assert.equal(await probe(label, v), false, `脏值 enabled(${label}) 不得命中（只认整数 1，issues/130 案 A）`)
    }
  })

  /**
   * issues/130 案 A · T1 **内存仓写侧台账边界**：`enabled` 列建模的是 INT（tests/schema/*.sql），
   * 直写台账的规范整数串必须落成数值（＝用例 27 里 `'1'` 与整数 1 同结论的那一段；摘掉它 :2971 翻红）。
   * 同一段不许顺手放宽：非规范串（`'1.0'` / `' 1'` / `'01'` / `'+1'` / `''` / `'abc'`）与非字符串
   * （`true` / `2` / `null`）原样留在台账里，交判据判停用——那才是"只认数值 1"而不是"换个地方强转"。
   */
  it('issues/130 案 A T1：内存仓写侧边界只把规范整数串落成数值，非规范值原样留着判停用', async () => {
    const ext = new MemoryExtRepository()
    await putSur(ext, { id: 'w-str1', operator: 'opW1', surrogate: 'agStr', processName: 'f', enabled: '1' })
    const led = await ext.findSurrogateById('w-str1')
    assert.equal(typeof led?.enabled, 'number',
      "INT 列语义：台账直写 '1' 须在写侧边界落成数值（不还原＝严判据把这类台账整体判废，用例 27 即红）")
    assert.equal(led?.enabled, 1, "台账里应是数值 1，而不是 '1' 也不是别的")
    assert.equal((await ext.getSurrogate('opW1', 'f'))?.surrogate, 'agStr',
      "'1' 经写侧边界后与整数 1 同结论（用例 27 d 档）")
    const keep: Array<[string, any]> = [
      ['1.0', '1.0'], ['空格1', ' 1'], ['尾空格1', '1 '], ['前导零', '01'], ['加号', '+1'],
      ['空串', ''], ['不可解析', 'abc'], ['布尔', true], ['其它整数', 2], ['null', null],
    ]
    for (const [label, v] of keep) {
      const id = `w-${label}`
      await putSur(ext, { id, operator: `opK-${label}`, surrogate: `agK-${label}`, processName: 'f', enabled: v })
      const row = await ext.findSurrogateById(id)
      assert.ok(Object.is(v, row?.enabled), `非规范值 ${label} 不得被写侧边界改写（改写＝把接受集合放宽回去）`)
      assert.equal(await ext.getSurrogate(`opK-${label}`, 'f'), null,
        `写侧边界后 ${label} 仍须判停用（只认数值 1，issues/130 案 A）`)
    }
  })

  /**
   * issues/130 案 A · T2 边界纯函数语法：`surrogateHydrateEnabled` 只认规范整数串 `-?(0|[1-9]\d*)`。
   * 钉住"这不是把判据的宽松转换换个地方做"——`'1.0'` / `'01'` / `' 1'` / `'1 '` / `'+1'` / `'1abc'`
   * 一律原样返回且交判据必停；非字符串入参原样透传（案 A 三条口径之②：驱动串化由边界还原，
   * 不为此放宽判据）。
   */
  it('issues/130 案 A T2：surrogateHydrateEnabled 只认规范整数串，非规范串原样返回且仍判停用', () => {
    for (const [text, num] of [['1', 1], ['0', 0], ['2', 2], ['-1', -1], ['123', 123]] as Array<[string, number]>) {
      assert.equal(surrogateHydrateEnabled(text), num, `规范整数串 '${text}' 应还原为数值`)
      assert.equal(typeof surrogateHydrateEnabled(text), 'number', `还原后须是数值型：'${text}'`)
    }
    assert.equal(surrogateEnabled(surrogateHydrateEnabled('1')), true, "'1' 经边界还原后判据才认")
    assert.equal(surrogateEnabled(surrogateHydrateEnabled('0')), false, "还原成数值 0 照样判停用")
    assert.equal(surrogateEnabled(surrogateHydrateEnabled('2')), false, "还原成数值 2 照样判停用")
    for (const text of ['1.0', '01', ' 1', '1 ', '+1', '1abc', 'abc1', 'x', '', '  ', 'abc', '1_0']) {
      assert.equal(surrogateHydrateEnabled(text), text, `非规范整数串 '${text}' 不得被还原（还原＝放宽接受集合）`)
      assert.equal(surrogateEnabled(surrogateHydrateEnabled(text)), false, `非规范串经边界后仍须判停用: [${text}]`)
    }
    for (const v of [1, 0, 2, -1, true, false, null, undefined, {}, [], Number.NaN]) {
      assert.ok(Object.is(v, surrogateHydrateEnabled(v)), `非字符串入参原样透传: ${String(v)}`)
    }
    assert.equal(surrogateEnabled(surrogateHydrateEnabled(1)), true, '数值 1 透传后照旧命中')
    assert.equal(surrogateEnabled(surrogateHydrateEnabled(true)), false, '布尔 true 不被还原成 1')
  })

  /**
   * issues/130 案 A · T3 **SQL 仓读侧驱动边界**：`enabled` 是 INT 列，但驱动不保证回读成数值
   * （mysql2 关 typeCast、pg 的 int8/numeric 一律给字符串）。判据只认数值 1 之后不在这里还原，
   * 这类宿主的委托会**整体判废且零告警** ⇒ 本格用假驱动复现"给串"的形态（真机 MySQL 那一路在
   * `__tests__/jdbc.test.ts`，本机无库跑不到）。摘掉 `queryNewestSurrogate` 里的还原 ⇒ 本格翻红。
   * 同用例钉住边界**不是**换个地方做宽松转换：文本列值 `'abc'` / 半宽 `'1.0'` 仍判停用，
   * 台账回显（findSurrogateById）仍给列原值，且与内存仓同答案（条款 6 / 用例 27）。
   */
  it('issues/130 案 A T3：SQL 仓读侧还原驱动串化的 INT 列，非规范串仍停用且与内存仓同答案', async () => {
    const now = new Date()
    const dbRow = (id: string, operator: string, surrogate: string, enabled: any, processName: string) => ({
      id, process_name: processName, operator, surrogate, start_time: null, end_time: null,
      enabled, create_time: now, create_user: 't', update_time: now, update_user: 't',
    })
    const rows = [
      dbRow('13001', 'n130-opStr', 'sStrOne', '1', 'flowStr'),     // 驱动把 INT 列串化成 '1'
      dbRow('13002', 'n130-opTxt', 'sTxtOff', 'abc', 'flowTxt'),   // 真表里就是文本脏值
      dbRow('13003', 'n130-opSemi', 'sSemiOff', '1.0', 'flowSemi'), // 半宽串
    ]
    // 零连接假驱动：只复刻 SQL 形状（args = [operator] 为兜底作用域、[operator, processName] 为精确作用域，
    // ORDER BY id DESC LIMIT 1 取首行），不碰任何数据库/端口
    const conn: any = {
      async execute() {},
      async fetchOne(sql: string, args: any[]) {
        if (sql.includes('WHERE id = ?')) return rows.find(r => String(r.id) === String(args[0])) ?? null
        return (await this.fetchAll(sql, args))[0] ?? null
      },
      async fetchAll(_sql: string, args: any[]) {
        const [operator, processName] = args
        const inScope = rows.filter(r => r.operator === operator && (processName === undefined
          ? (r.process_name === null || r.process_name === '')
          : r.process_name === processName))
        return inScope.length ? [inScope[inScope.length - 1]] : []
      },
      async begin() {}, async commit() {}, async rollback() {},
    }
    const sqlExt = new JdbcProcessExtRepository({
      placeholder: '?', async acquire() { return conn }, async release() {},
    } as any)

    const hit = await sqlExt.getSurrogate('n130-opStr', 'flowStr')
    assert.ok(hit, "驱动把 INT 列回读成字符串 '1' 时 SQL 路仍须命中（漏还原＝这类宿主的委托整体判废）")
    assert.equal(hit!.surrogate, 'sStrOne')
    assert.equal(typeof (hit as any).enabled, 'number', '交判据之前，行里的 enabled 须已在仓储读侧边界还原成数值')
    assert.equal((hit as any).enabled, 1)
    assert.equal(await sqlExt.getSurrogate('n130-opTxt', 'flowTxt'), null,
      "边界只还原规范整数串：真表列值是文本 'abc' 仍判停用（不是把宽松转换换个地方做）")
    assert.equal(await sqlExt.getSurrogate('n130-opSemi', 'flowSemi'), null,
      "'1.0' 不是规范整数串，读侧边界不许还原")
    assert.equal((await sqlExt.findSurrogateById('13001') as any)?.enabled, '1',
      '还原只做在裁决读上；台账回显（findSurrogateById）仍是列原值，不替调用方改写数据')

    // 双仓同答案（条款 6 / 用例 27）：同一份 INT 列数据，内存仓与 SQL 仓命中同一个代理人
    const mem = new MemoryExtRepository()
    await mem.saveSurrogate({
      id: '13001', operator: 'n130-opStr', surrogate: 'sStrOne', processName: 'flowStr',
      enabled: '1' as any, createTime: now, createUser: 't', updateTime: now, updateUser: 't',
    } as any)
    assert.equal((await mem.getSurrogate('n130-opStr', 'flowStr'))?.surrogate, 'sStrOne',
      '双仓同答案：内存仓同档（写侧边界落数值 1）同样命中')
  })

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

  it('条款 1 路径 2/3 回退(ROLLBACK)：复活血缘前驱行并并入该行参与人的代理人（诱饵配执行回退的人）', async () => {
    // issues/121 P2 血缘版：复活 b1 那条历史行，参与者＝该行办结人 rbk-zhang（不是执行回退的
    // rbk-wang）。台账延后到 b1 建单之后再配 ⇒ 起点自证仍然成立。
    const { engine, repo, ext, def } = surrHarness('surrback116',
      surrFlowJson('surrback116', [{ id: 'b1', assignee: 'rbk-zhang' }, { id: 'b2', assignee: 'rbk-wang' }]))

    const inst = await engine.startProcessInstanceById(def.id, 'rbk-boss')
    assert.deepEqual(await doingActors(repo, inst.id, 'b1'), ['rbk-zhang'],
      '起点自证：台账还没配，发起产生的 b1 不该有任何代理人')
    const b1 = (await repo.findDoingTasks(inst.id)).find(t => t.taskName === 'b1')!
    await engine.executeProcessTask(b1.id, 'rbk-zhang')
    await putSur(ext, { operator: 'rbk-zhang', surrogate: 'rbk-agent', processName: 'surrback116' })   // 该行办结人
    await putSur(ext, { operator: 'rbk-boss', surrogate: 'rbk-agent', processName: 'surrback116' })    // 该行是首节点时 ⇒ 参与者取 u_userId/发起人
    await putSur(ext, { operator: 'rbk-wang', surrogate: 'rbk-decoy', processName: 'surrback116' })    // 诱饵：执行回退的人
    const b2 = (await repo.findDoingTasks(inst.id)).find(t => t.taskName === 'b2')!
    await engine.executeAndJumpTask(b2.id, 'rbk-wang', {})
    // 原 b1 已 Done，b1 上唯一进行中任务就是复活出来的那一条
    const revived = await doingActors(repo, inst.id, 'b1')
    assert.equal(revived.length, 2, `复活行应＝1 个 principal + 1 个代理人，实得 ${JSON.stringify(revived)}`)
    assert.ok(revived.includes('rbk-agent'),
      `条款 1「回退(ROLLBACK)」：复活行必须并入其 principal 的代理人，实得 ${JSON.stringify(revived)}`)
    assert.ok(!revived.includes('rbk-wang') && !revived.includes('rbk-decoy'),
      `复活行的参与者不能是执行回退的人或其代理人（血缘版），实得 ${JSON.stringify(revived)}`)
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

  /**
   * issues/123 任务 A/B（内存仓 + 建单落库断言）：`条款 1.4 多条命中取 id 最大` 那条用例的
   * 延长线 —— 同一授权人+同一流程先有一条「窗内 enabled=1」，之后再新建一条**更新**的
   * 窗外 / enabled=0 / enabled=2 脏值 / 自委托记录 ⇒ 参与者读回**只有原人**
   * （先按 id 取最新一条、再由四判据裁决这一条，不生效就不命中，**不回落**到更旧那条）。
   * 每轮配正向对照（最新一条生效 ⇒ 必须并入），防判据写反成"恒不并入"后空转通过。
   */
  it('issues/123 最新一条不生效 ⇒ 建单不并入代理人、不回落到更旧生效行（内存仓）', async () => {
    const t0 = Date.now()
    const dt = (days: number) => fmtDt(new Date(t0 + days * dayMs))
    const rounds: Array<[string, Record<string, any>, string, string[]]> = [
      ['A1 最新一条窗外（未到窗）', { startTime: dt(3), endTime: dt(5) }, 'aLate', ['zhang']],
      ['A2 最新一条窗外（已过期）', { startTime: dt(-5), endTime: dt(-3) }, 'aGone', ['zhang']],
      ['A3 最新一条 enabled=0', { enabled: 0 }, 'aOff', ['zhang']],
      ['A4 最新一条 enabled=2 脏值', { enabled: 2 }, 'aDirty', ['zhang']],
      ['A5 最新一条自委托', {}, 'zhang', ['zhang']],
      ['B 正向对照：最新一条窗内 enabled=1', {}, 'aOn', ['zhang', 'aOn']],
    ]
    for (const [label, override, agent, expect] of rounds) {
      const { engine, repo, ext, def } =
        surrHarness('surr123-a', surrFlowJson('surr123-a', [{ id: 't1', assignee: 'zhang' }]))
      // 更旧的一条：窗内 + enabled=1 —— 旧形状（先滤生效再取最新）会把它当成命中行永远并入
      await putSur(ext, { id: '123001', operator: 'zhang', surrogate: 'aOlder',
        processName: 'surr123-a', startTime: dt(-1), endTime: dt(1) })
      // 更新的一条：按某判据不生效（正向对照组则是生效的）
      await putSur(ext, { id: '123002', operator: 'zhang', surrogate: agent,
        processName: 'surr123-a', startTime: dt(-1), endTime: dt(1), enabled: 1, ...override })
      // 种子自证：两条都真落库（否则"不并入"只是数据没进去）
      assert.ok(await ext.findSurrogateById('123001'), `${label}：更旧那条未落库`)
      assert.equal((await ext.findSurrogateById('123002'))?.surrogate, agent, `${label}：最新那条未落库`)
      const inst = await engine.startProcessInstanceById(def.id, 'boss')
      assert.deepEqual(await doingActors(repo, inst.id, 't1'), expect,
        `${label}：期望参与者 ${JSON.stringify(expect)}`)
    }
  })

  /**
   * issues/123 判据 4（内存仓）：精确作用域最新一条停用 ⇒ 同层内不复活更旧那条，
   * 但仍须由那条生效的全流程兜底委托接管（条款 1.4 后半句，对齐 Java 既有测试）。
   * 末尾删净精确作用域两条后再发起一次，证明兜底路径本身是活的。
   */
  it('issues/123 精确作用域最新一条不生效 ⇒ 由生效的全流程委托兜底（内存仓）', async () => {
    const t0 = Date.now()
    const dt = (days: number) => fmtDt(new Date(t0 + days * dayMs))
    const { engine, repo, ext, def } =
      surrHarness('surr123-g', surrFlowJson('surr123-g', [{ id: 't1', assignee: 'zhang' }]))
    await putSur(ext, { id: '123010', operator: 'zhang', surrogate: 'aAll', processName: '',
      startTime: dt(-1), endTime: dt(1) })                              // 生效的全流程兜底行
    await putSur(ext, { id: '123011', operator: 'zhang', surrogate: 'aOk', processName: 'surr123-g',
      startTime: dt(-1), endTime: dt(1) })                              // 本流程窗内生效（更旧）
    await putSur(ext, { id: '123012', operator: 'zhang', surrogate: 'aOff', processName: 'surr123-g',
      startTime: dt(-1), endTime: dt(1), enabled: 0 })                   // 本流程最新一条：停用
    const inst = await engine.startProcessInstanceById(def.id, 'boss')
    assert.deepEqual(await doingActors(repo, inst.id, 't1'), ['zhang', 'aAll'],
      '精确作用域最新一条停用 ⇒ 同层不复活 aOk/aOff，但由全流程兜底行 aAll 接管（条款 1.4）')

    // 正向对照：删净精确作用域两条后，兜底路径必须照常接管
    await ext.removeSurrogate('123012')
    await ext.removeSurrogate('123011')
    const inst2 = await engine.startProcessInstanceById(def.id, 'boss')
    assert.deepEqual(await doingActors(repo, inst2.id, 't1'), ['zhang', 'aAll'],
      '精确作用域清空后，空 processName 的兜底委托应并入代理人')
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

// ═══ issues/121 P2 退回上一步（血缘版）两格负向 ═══════════════════════════════
describe('issues/121 P2 血缘回退负向：20010007 无血缘 / 20010008 守卫', () => {
  it('首任务节点上退回 ⇒ 无血缘（parent 为 0 与 P1 之前老行的 undefined 两种形状）报 20010007', async () => {
    const { engine, repo, def } = surrHarness('lin07', surrFlowJson('lin07',
      [{ id: 'b1', assignee: 'ln-zhang' }, { id: 'b2', assignee: 'ln-wang' }]))
    const inst = await engine.startProcessInstanceById(def.id, 'ln-boss')
    const b1 = (await repo.findDoingTasks(inst.id)).find(t => t.taskName === 'b1')!
    assert.equal(b1.parentTaskId ?? '0', '0', '前置条件：发起那条 parent 应为 0')
    await assert.rejects(() => engine.executeAndJumpTask(b1.id, 'ln-zhang', {}), (err: any) =>
      String(err?.message).includes('上一步任务ID为空，无法驳回至上一步处理') && !String(err?.message).includes('2001000'))

    // 老行形状：P1 之前落的数据该列是 NULL（仓储读回 undefined），同样必须报错——
    // 不能因为"取不到 parent"就静默走"什么都不建单"那条路。
    // 另起一条实例：上一段那次退回已把这条 b1 办结（内存仓储无事务），复用它会先撞到"任务不在进行中"。
    const inst2 = await engine.startProcessInstanceById(def.id, 'ln-boss')
    const legacy = (await repo.findDoingTasks(inst2.id)).find(t => t.taskName === 'b1')!
    legacy.parentTaskId = undefined
    await repo.updateTask(legacy)
    const beforeRollback = (await repo.findDoingTasks(inst2.id)).length
    await assert.rejects(() => engine.executeAndJumpTask(legacy.id, 'ln-zhang', {}), (err: any) =>
      String(err?.message).includes('上一步任务ID为空，无法驳回至上一步处理') && !String(err?.message).includes('2001000'))
    assert.ok((await repo.findDoingTasks(inst2.id)).length <= beforeRollback,
      '报错即不建单：不该凭空多出进行中任务（内存仓储无事务，只断"不多"）')

    // 第三种形状：parent 是个非 0 但**指不到真实行**的值（老数据被清理过 / 跨库迁过来）
    // ⇒ 走"取不到历史行"那条分支，同样必须报 20010007，不得静默不建单
    const inst3 = await engine.startProcessInstanceById(def.id, 'ln-boss')
    const dangling = (await repo.findDoingTasks(inst3.id)).find(t => t.taskName === 'b1')!
    dangling.parentTaskId = '9223372036854775807'
    await repo.updateTask(dangling)
    const before3 = (await repo.findDoingTasks(inst3.id)).length
    await assert.rejects(() => engine.executeAndJumpTask(dangling.id, 'ln-zhang', {}), (err: any) =>
      String(err?.message).includes('上一步任务ID为空，无法驳回至上一步处理') && !String(err?.message).includes('2001000'))
    assert.ok((await repo.findDoingTasks(inst3.id)).length <= before3,
      '"取不到历史行"也不得静默不建单')
  })

  it('血缘前驱跨不过 fork（boot2 语义：遇 fork/join/start 跳过该入边不再深入）⇒ 报 20010008', async () => {
    const nd = (id: string, type: string, properties: any = {}) => ({ id, type, properties, text: { value: id } })
    const ed = (a: string, b: string) => ({ id: `e_${a}_${b}`, sourceNodeId: a, targetNodeId: b, properties: {} })
    const content = JSON.stringify({
      name: 'lin08', displayName: 'lin08', type: 'approval',
      nodes: [nd('start', 'snaker:start'),
        nd('apply', 'snaker:task', { assignee: 'fk-zhang', taskType: 0, performType: 0 }),
        nd('fork1', 'snaker:fork'),
        nd('taskA', 'snaker:task', { assignee: 'fk-a', taskType: 0, performType: 0 }),
        nd('taskB', 'snaker:task', { assignee: 'fk-b', taskType: 0, performType: 0 }),
        nd('join1', 'snaker:join'), nd('end', 'snaker:end')],
      edges: [ed('start', 'apply'), ed('apply', 'fork1'), ed('fork1', 'taskA'), ed('fork1', 'taskB'),
        ed('taskA', 'join1'), ed('taskB', 'join1'), ed('join1', 'end')],
    })
    const { engine, repo, def } = surrHarness('lin08', content)
    const inst = await engine.startProcessInstanceById(def.id, 'fk-boss')
    const apply = (await repo.findDoingTasks(inst.id)).find(t => t.taskName === 'apply')!
    await engine.executeProcessTask(apply.id, 'fk-zhang')
    const branch = (await repo.findDoingTasks(inst.id)).find(t => t.taskName === 'taskA')!
    assert.ok(branch.parentTaskId && branch.parentTaskId !== '0',
      '前置条件：分支行的 parent 应已由 P1 写入（否则这条红是因为"无血缘"而不是守卫）')
    await assert.rejects(() => engine.executeAndJumpTask(branch.id, 'fk-a', {}), (err: any) =>
      String(err?.message).includes('无法驳回至上一步处理，请确认上一步骤并非fork、join、suprocess以及会签任务') && !String(err?.message).includes('2001000'))
  })
})
describe('issues/122 审批记录行的可空时间列必须出键', () => {
  it('进行中的那条：finishTime 出空串且经剥-null 序列化后键仍在', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '02-multi-task.json')
    const facade = new JeeflowFacade(engine, repo, undefined)
    const inst = await startAndExecute(engine, repo, def.id, 'applicant')
    const doing = (await repo.findDoingTasks(inst.id))[0]
    const r = await facade.flow('processInstance/approvalRecord', { id: inst.id })
    assert.equal(r.code, 0, JSON.stringify(r))
    const row: any = r.data.find((x: any) => x.taskName === doing.taskName)
    assert.ok(row, `记录行里应能找到进行中的那条: ${JSON.stringify(r.data)}`)
    assert.ok('finishTime' in row, '可空时间列必须出键（不是整键省略）')
    // issues/133 拍板 B：这里曾断 ''（理由写的是"与 boot2 同形"，实为错——boot2 的
    // ProcessTaskVO 继承 entity 的 Date 字段，Jackson 出 null），真实动机是绕 issues/122
    // 的宿主剥-null；根因已由 mldong-nestjs @KeepNullResponse 类级豁免收口 ⇒ 引擎收回 null。
    assert.strictEqual(row.finishTime, null, "空值出 null（spec 06-facade.md:93）")
    // 只留引擎侧那一半：序列化后键必须还在且值是 null。
    // 宿主剥不剥 null 不是引擎能证的（那是壳层 @KeepNullResponse 的义务，见 122 收口）。
    assert.ok(/"finishTime":\s*null/.test(JSON.stringify(row)),
      `出口 JSON 应保留 finishTime 键且值为 null: ${JSON.stringify(row)}`)
  })

  /**
   * issues/133（拍板 B）的完整面：fmtTime 覆盖的是**所有行投影**（任务行/委托行/设计行/实例行），
   * 逐个补 `?? null` 迟早漏一处 ⇒ 归一放在 fmtTime 本身。本用例不写死键路径，
   * 直接扫三条真实 action 的响应树：任何 *Time 键必须**出键**，值只能是
   * `yyyy-MM-dd HH:mm:ss` 串或 `null`，绝不允许 ''（'' 是 122 时代的宿主兜底残留）。
   *
   * 原本这里还有一道"剥-null 反闸"（把响应过一遍 v===null?undefined:v 再比键集合）——
   * 那验的是**宿主**的序列化行为，引擎负不了这个责；宿主那半的正解是
   * mldong-nestjs `@KeepNullResponse()`（挂 WfController 类级，拦 /wf/** 全部出口）。
   * ⇒ 换成引擎侧可证的那半：raw JSON 里键在、空值是 null。
   */
  it('全链时间列一律出键、空值出 null（任务行 / 委托行 / 定义行三投影）', async () => {
    const { engine, repo } = setup()
    const ext = new MemoryExtRepository()
    const facade = new JeeflowFacade(engine, repo, ext)
    const def = loadFlow(repo, '02-multi-task.json')
    const inst = await startAndExecute(engine, repo, def.id, 'applicant')
    // 委托行：不填起止时间 ⇒ 走的是"空值"那一支
    await ext.saveSurrogate({
      id: '1220001', operator: 'surr-op', surrogate: 'agent-a', processName: '', enabled: 1,
    } as any)

    const probes: Array<[string, any]> = [
      ['processInstance/detail', await facade.flow('processInstance/detail', { id: inst.id })],
      ['processSurrogate/page', await facade.flow('processSurrogate/page', { operator: 'surr-op' })],
      ['processDefine/page', await facade.flow('processDefine/page', {})],
    ]
    const isTimeKey = (k: string) =>
      /(?:Time|Time\w*)$/.test(k) && k !== 'expireTimeOut' && !/Timeout/i.test(k)
    /** 单格判据：null 合法、'' 非法、非串非法（键缺失由 scan 的另一半管）。 */
    const badTimeCell = (p: string, v: any): string | null => {
      if (v === null) return null
      if (typeof v === 'string' && v !== '') return null
      return `${p}=${JSON.stringify(v)}`
    }
    // 判据自身的三格内联自证：少了它，"改了判据方向"与"判据坏了"读起来一模一样
    assert.ok(badTimeCell('x.finishTime', ''), "自证①：'' 必须判坏（133 收的就是它）")
    assert.equal(badTimeCell('x.finishTime', null), null, "自证②：null 必须判好（spec 06:93）")
    assert.equal(badTimeCell('x.finishTime', '2026-01-01 00:00:00'), null, "自证③：正常串必须判好")
    const scan = (node: any, path: string, keys: string[], bad: string[]) => {
      if (node == null || typeof node !== 'object') return
      for (const [k, v] of Object.entries(node)) {
        const p = `${path}.${k}`
        if (isTimeKey(k)) {
          keys.push(p)
          const hit = badTimeCell(p, v)
          if (hit) bad.push(hit)
        }
        scan(v, p, keys, bad)
      }
    }
    for (const [action, r] of probes) {
      assert.equal(r.code, 0, `${action} 应成功：${JSON.stringify(r)}`)
      const keys: string[] = [], bad: string[] = []
      scan(r, action, keys, bad)
      assert.ok(keys.length > 0, `${action} 响应里一个时间列都没扫到 ⇒ 本用例空转（夹具失效）`)
      assert.deepEqual(bad, [],
        `${action}：时间列只能出 null 或 yyyy-MM-dd HH:mm:ss 串，出 '' 即违 spec 06-facade.md:93（issues/133）`)
      // 引擎侧那一半：序列化后键不能整键消失（宿主剥-null 是壳层义务，见 @KeepNullResponse）
      const raw = JSON.stringify(r)
      for (const p of keys) {
        const k = p.split('.').pop() as string
        assert.ok(raw.includes(`"${k}":`),
          `${action}：时间列 ${k} 在出口 JSON 里整键不见了`)
      }
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// issues/129 案 A · operator「空串 ≡ 缺键」+ 仓储归属兜底（两层收口）
//
// 症状（2026-09-28 实测 node 栈，同一份库三档并排）：`{"operator":""}` 的 processInstance/page
// 出 25 行（返回的全是别人的实例），而 `{"operator":"user1"}` 4 行、`{"operator":"__nobody__"}` 0 行
// ⇒ "空串条件"被**整条丢掉**，等价于"不过滤 = 读全库"。
// 裁定语义（jeeflow-doc `spec/06-facade.md` §2.5）：
//   ① 门面归一化：空串/全空白 ≡ 缺键 ⇒ 一并回落 demo 缺省 `user1`；
//   ② 仓储兜底：动态 WHERE 里「归属谓词列 + 空值」⇒ **空页**，绝不允许变成"这条条件不加"；
//   ③ 只收归属列（`t.operator` / `pi.operator` / `pta.actor_id` / `cc.actor_id`）的 EQ——
//      `m_LIKE_*` 等**可选过滤**的"空值当作没填"通用放行不动（整体改掉会把可选过滤一起改坏）。
// 参考实现：java `JeeflowFacade.operatorArg` + `JdbcProcessRepository.buildWhere`(OWNERSHIP_COLUMNS)。
// 本栈形状差异：门面把"我是谁"作为**位置参**下发（java 下发的是 EQ 条件），且内存仓/SQL 仓两套实现
// ⇒ 第二层落点比 java 多：memory.ts（位置参×4 + matchConditions）、jdbc/shared.ts（buildWhere +
// 位置参×3）、jdbc/ext.ts（buildExtWhere + surrogate filters）、memory-ext.ts（surrogate filters）。
// T0 只用内存仓跑真数据；SQL 仓那半用**零连接探针**钉（不连任何数据库）。
// ─────────────────────────────────────────────────────────────────────────────
describe('issues/129 operator 空档两层收口（门面归一化 + 仓储归属兜底）', () => {
  const ME = 'user1'            // 门面缺省档：空串/全空白必须归到这一档
  const OTHER = 'n129-other'    // 另一个用户：证明"空档 ≠ 别人的档 / ≠ 全库"
  const NOBODY = 'n129-nobody'  // 对照档：谁都没有 ⇒ 必须 0 行（证明过滤真的生效，不是恒定放行）

  // 夹具行数刻意做成 ME ≠ OTHER ≠ 全库，且 ME 档非空——否则"0 == 0"是自等假绿
  const N = { meInst: 3, otherInst: 5, meTodo: 2, otherTodo: 3, meCc: 2, otherCc: 3 }

  /**
   * 本组专用装配：idGen 换成**严格递增**的发号器。
   * 不复用 setup() 的 `Date.now()*1000 + random(1000)`——本夹具一口气造 8 个实例 + 16 个任务，
   * 同一毫秒内撞号会把 MemoryRepository 的 Map 行**静默覆盖**（实测偶发 doneList 少 1 行），
   * 那种红与本 issue 无关，会污染变异对照的读数。
   */
  function setup129() {
    const repo = new MemoryRepository()
    const userProv: UserProvider = {
      async getUser(userId) {
        return { userId, realName: '用户' + userId, deptId: 'D01', deptName: '测试部门', postId: 'P01', postName: '测试岗位' }
      },
    }
    let issued = 1_700_000_000_000_000 // 2^53 内（9.0e15），且与 Date.now()*1000 同量级不冲突
    const idGen = { nextId() { return String(++issued) } }
    const exprEval: ExpressionEvaluator = { async eval() { return false } }
    return { engine: new EngineImpl(repo, userProv, idGen, exprEval), repo }
  }

  async function fixture129() {
    const { engine, repo } = setup129()
    const extRepo = new MemoryExtRepository()
    const facade = new JeeflowFacade(engine, repo, extRepo)
    const content = readFileSync(flowDir + '01-simple.json', 'utf-8')
    const dep = await facade.flow('processDefine/deploy', { content })
    assert.equal(dep.code, 0, JSON.stringify(dep))
    const defineId = dep.data.processDefineId

    // 实例：startAndExecute 会自动办结 apply（t.operator=发起人）⇒ 顺带造出「我已办」行
    const mine: string[] = []
    const theirs: string[] = []
    for (let i = 0; i < N.meInst; i++) {
      const r = await facade.flow('processInstance/startAndExecute', { processDefineId: defineId, operator: ME })
      assert.equal(r.code, 0, JSON.stringify(r))
      mine.push(String(r.data.processInstanceId))
    }
    for (let i = 0; i < N.otherInst; i++) {
      const r = await facade.flow('processInstance/startAndExecute', { processDefineId: defineId, operator: OTHER })
      assert.equal(r.code, 0, JSON.stringify(r))
      theirs.push(String(r.data.processInstanceId))
    }
    // 待办：把各自加进 doing 的 task1 参与者名册
    const mineTodoTasks: string[] = []
    const theirsTodoTasks: string[] = []
    for (const id of mine.slice(0, N.meTodo)) {
      const doing = await repo.findDoingTasks(id)
      await repo.addTaskActor(doing[0].id, [ME])
      mineTodoTasks.push(String(doing[0].id))
    }
    for (const id of theirs.slice(0, N.otherTodo)) {
      const doing = await repo.findDoingTasks(id)
      await repo.addTaskActor(doing[0].id, [OTHER])
      theirsTodoTasks.push(String(doing[0].id))
    }
    // 抄送：各占不同实例 ⇒ cc 全库行数 = meCc + otherCc
    for (const id of mine.slice(0, N.meCc)) await repo.createCcInstance(id, ME, ME)
    for (const id of theirs.slice(0, N.otherCc)) await repo.createCcInstance(id, OTHER, OTHER)

    const all = repo.allTasks()
    return {
      engine, repo, extRepo, facade, mine, theirs, mineTodoTasks, theirsTodoTasks,
      libInstances: repo.allInstances().length,
      libDoing: all.filter(t => t.taskState === TaskState.Doing).length,
      libDone: all.filter(t => t.taskState !== TaskState.Doing).length,
      libCc: N.meCc + N.otherCc,
    }
  }
  type Fix129 = Awaited<ReturnType<typeof fixture129>>

  /** 四个「我的」出口：归属列 / 门面 action / 三档读数器（正向、负向共用一张表） */
  function outlets(f: Fix129) {
    return [
      {
        action: 'processInstance/page', col: 't.operator',
        me: N.meInst, other: N.otherInst, library: f.libInstances,
        rows: async (args: Record<string, any>) => (await f.facade.flow('processInstance/page', { pageSize: 100, ...args })).data.rows,
        // 实例行归属列 = operator（发起人）
        isMine: (r: any) => String(r.operator) === ME,
      },
      {
        action: 'processTask/todoList', col: 'pta.actor_id',
        me: N.meTodo, other: N.otherTodo, library: f.libDoing,
        rows: async (args: Record<string, any>) => (await f.facade.flow('processTask/todoList', { pageSize: 100, ...args })).data.rows,
        isMine: (r: any) => f.mineTodoTasks.includes(String(r.id)),
      },
      {
        action: 'processTask/doneList', col: 't.operator',
        me: N.meInst, other: N.otherInst, library: f.libDone,
        rows: async (args: Record<string, any>) => (await f.facade.flow('processTask/doneList', { pageSize: 100, ...args })).data.rows,
        isMine: (r: any) => String(r.operator) === ME,
      },
      {
        action: 'processInstance/ccList', col: 'cc.actor_id',
        me: N.meCc, other: N.otherCc, library: f.libCc,
        rows: async (args: Record<string, any>) => (await f.facade.flow('processInstance/ccList', { pageSize: 100, ...args })).data.rows,
        isMine: (r: any) => f.mine.slice(0, N.meCc).includes(String(r.id)),
      },
    ]
  }

  it('正向 · 四个出口：{"operator":""} ≡ 全空白 ≡ 缺键 ≡ 显式 user1，且该档非空、无归属用户档为 0', async () => {
    const f = await fixture129()
    for (const o of outlets(f)) {
      const explicit = (await o.rows({ operator: ME })).length
      const missing = (await o.rows({})).length
      const blank = (await o.rows({ operator: '' })).length
      const spaces = (await o.rows({ operator: ' \t ' })).length
      const nobody = (await o.rows({ operator: NOBODY })).length
      assert.ok(explicit > 0, `${o.action}：夹具没让 ${ME} 有行 ⇒ 三档同为 0 是自等假绿（夹具失效）`)
      assert.equal(explicit, o.me, `${o.action}：显式 ${ME} 档应 ${o.me} 行`)
      assert.equal(missing, explicit, `${o.action}：缺键档应等于显式 ${ME} 档（spec 06 §2.5 缺省回落）`)
      assert.equal(blank, explicit,
        `${o.action}：{"operator":""} 应与缺键同档（回落 ${ME}），实读 ${blank} vs ${explicit} ⇒ 空串又漏进仓储了`)
      assert.equal(spaces, explicit, `${o.action}：全空白串应与缺键同档（trim 后判空）`)
      assert.equal(nobody, 0, `${o.action}：谁都没有的归属者必须空页（对照组）`)
    }
  })

  it('负向 · 空串档不得折叠成"不过滤"：既不等于别人的档、也不等于全库，行内不混别人的归属', async () => {
    const f = await fixture129()
    for (const o of outlets(f)) {
      const rows = await o.rows({ operator: '' })
      const blank = rows.length
      // A 口径下"空串 ⇒ 空页"（php/moon 当时那档）同样是错档：空串必须与缺键同档 = user1 的行
      assert.ok(blank > 0,
        `${o.action}：空串档出 0 行 ⇒ 把空串当真实归属值过滤了（该档应回落 ${ME} 的 ${o.me} 行）`)
      assert.ok(blank < o.library,
        `${o.action}：空串档读出 ${blank} 行，全库才 ${o.library} 行 ⇒ 只要 ≥ 全库就是"空即不过滤"旁路复活（issues/129）`)
      assert.notEqual(blank, o.library, `${o.action}：空串档不得等于全库行数 ${o.library}`)
      assert.notEqual(blank, o.other, `${o.action}：空串档不得等于另一用户（${OTHER}）的档 ${o.other}`)
      const foreign = rows.filter(r => !o.isMine(r)).map(r => `${r.id}/${r.operator}`)
      assert.deepEqual(foreign, [],
        `${o.action}：空串档混进非 ${ME} 归属的行（${o.col} 过滤没生效）：${JSON.stringify(foreign)}`)
    }
  })

  it('仓储层 · 绕过门面直连内存仓：归属位置参传空串/全空白/null/undefined ⇒ 空页（旧写法 `if (operator && …)` 读全库）', async () => {
    const f = await fixture129()
    const blanks: any[] = ['', '   ', '\t\n', null, undefined]
    for (const v of blanks) {
      const tag = `${JSON.stringify(v)}`
      const inst = await f.repo.pageInstances(1, 100, v)
      const todo = await f.repo.pageTodoTasks(1, 100, v)
      const done = await f.repo.pageDoneTasks(1, 100, v)
      const cc = await f.repo.pageCcInstances(1, 100, v)
      assert.equal(inst.rows.length, 0, `pageInstances 归属值 ${tag} ⇒ 空页，实读 ${inst.rows.length}`)
      assert.equal(inst.total, 0, `pageInstances total 也要归 0（${tag}）`)
      assert.equal(todo.rows.length, 0, `pageTodoTasks 归属值 ${tag} ⇒ 空页`)
      assert.equal(done.rows.length, 0, `pageDoneTasks 归属值 ${tag} ⇒ 空页（issues/129 §2 点名的内存仓落点）`)
      assert.equal(cc.rows.length, 0, `pageCcInstances 归属值 ${tag} ⇒ 空页`)
    }
    // 对照：非空归属值照常（证明"空页"没把四个分页一起做废）
    assert.equal((await f.repo.pageInstances(1, 100, ME)).rows.length, N.meInst)
    assert.equal((await f.repo.pageTodoTasks(1, 100, ME)).rows.length, N.meTodo)
    assert.equal((await f.repo.pageDoneTasks(1, 100, ME)).rows.length, N.meInst)
    assert.equal((await f.repo.pageCcInstances(1, 100, ME)).rows.length, N.meCc)
  })

  it('仓储层 · 动态条件：归属列 EQ + 空值 ⇒ 空页；非归属列空值仍被忽略（可选过滤照旧的哨兵）', async () => {
    const f = await fixture129()
    const OWNERSHIP = ['t.operator', 'pi.operator', 'pta.actor_id', 'cc.actor_id']
    const pagers: Array<[string, (op: string, c: any[]) => Promise<{ rows: any[]; total: number }>]> = [
      ['pageInstances', (op, c) => f.repo.pageInstances(1, 100, op, c)],
      ['pageTodoTasks', (op, c) => f.repo.pageTodoTasks(1, 100, op, c)],
      ['pageDoneTasks', (op, c) => f.repo.pageDoneTasks(1, 100, op, c)],
      ['pageCcInstances', (op, c) => f.repo.pageCcInstances(1, 100, op, c)],
    ]
    // 四个归属列 × 三种空值 × 四个分页：位置参给的是合法归属者，只有条件那一路能把行全吃掉
    for (const [name, pager] of pagers) {
      for (const col of OWNERSHIP) {
        for (const val of ['', '   ', null]) {
          const r = await pager(ME, [{ column: col, operator: 'EQ', value: val }])
          assert.equal(r.rows.length, 0, `${name}：归属列 ${col} + 空值(${JSON.stringify(val)}) 必须空页，不能"这条条件不加"`)
          assert.equal(r.total, 0, `${name}：归属列 ${col} 空值档 total 也要归 0`)
        }
      }
    }
    // 哨兵①：非归属列（可选过滤）空串/空值仍"当作没填"⇒ 行数与不带条件一致
    const base = (await f.repo.pageInstances(1, 100, ME)).rows.length
    for (const c of [
      { column: 't.business_no', operator: 'LIKE', value: '' },
      { column: 't.business_no', operator: 'EQ', value: null },
      { column: 'pd.name', operator: 'LIKE', value: '' },
    ]) {
      const r = await f.repo.pageInstances(1, 100, ME, [c])
      assert.equal(r.rows.length, base, `哨兵：可选过滤 ${c.column}(${c.operator}) 传空值应被忽略，不该折叠成空页`)
    }
    // 哨兵②：只收 EQ——归属列 NE + 空值不收紧（对齐 java 那句只判 "EQ"）
    const ne = await f.repo.pageInstances(1, 100, ME, [{ column: 't.operator', operator: 'NE', value: '' }])
    assert.equal(ne.rows.length, base, '哨兵：归属列 NE + 空值不该被收进空页（本次只收 EQ）')
    // 哨兵③：门面那一路的 m_ 可选过滤同样不动
    const viaFacade = await f.facade.flow('processInstance/page', { operator: ME, pageSize: 100, m_LIKE_businessNo: '' })
    assert.equal(viaFacade.code, 0, JSON.stringify(viaFacade))
    assert.equal(viaFacade.data.rows.length, base, '哨兵：m_LIKE_* 传空串按"没填"处理（通用放行未被我改动）')
  })

  it('仓储层 · SQL 仓（零连接探针，T0 不连库）：buildWhere 出 `AND 1=0`、位置参空值不取连接', async () => {
    const noConn: any = {
      placeholder: '?',
      acquire() { throw new Error('探针不该取连接（T0 无数据库）') },
      release() { throw new Error('探针不该释放连接') },
    }
    // buildWhere 是 protected ⇒ 用子类暴露；不改产品代码可见性
    class WhereProbe extends JdbcRepository {
      where(conditions: any[], whitelist: string[]) { return this.buildWhere(conditions, new Set(whitelist)) }
    }
    const p = new WhereProbe(noConn)
    const WL = ['t.operator', 'pi.operator', 'pta.actor_id', 'cc.actor_id', 't.business_no', 'pd.name', 't.task_name']
    const cond = (column: string, value: any, operator = 'EQ') => ({ column, operator, value })
    for (const col of ['t.operator', 'pi.operator', 'pta.actor_id', 'cc.actor_id']) {
      for (const val of ['', '   ', null]) {
        const w = p.where([cond(col, val)], WL)
        assert.equal(w.sql, ' AND 1=0', `SQL 仓：归属列 ${col} + 空值(${JSON.stringify(val)}) ⇒ 空页谓词`)
        assert.deepEqual(w.params, [], '空页谓词不绑参数')
      }
    }
    // 归属列非空 ⇒ 正常谓词（证明 1=0 不是无条件加）
    assert.equal(p.where([cond('t.operator', ME)], WL).sql, ' AND t.operator = ?')
    assert.deepEqual(p.where([cond('t.operator', ME)], WL).params, [ME])
    // 哨兵：非归属列空值仍整条忽略（可选过滤不动）+ 归属列 NE 不收
    assert.equal(p.where([cond('t.business_no', '', 'LIKE')], WL).sql, '', '哨兵：可选过滤空串仍被忽略')
    assert.equal(p.where([cond('t.business_no', null)], WL).sql, '', '哨兵：可选过滤 null 仍被忽略')
    assert.equal(p.where([cond('t.operator', '', 'NE')], WL).sql, '', '哨兵：归属列 NE + 空值不收紧（只收 EQ）')
    // 位置参那一路：空值直接空页，且**不取连接**（短路在 SQL 之前）
    for (const v of ['', '   ', null, undefined]) {
      assert.deepEqual(await p.pageInstances(1, 10, v as any), { rows: [], total: 0 }, `SQL 仓 pageInstances 归属值 ${JSON.stringify(v)} ⇒ 空页`)
      assert.deepEqual(await p.pageTodoTasks(1, 10, v as any), { rows: [], total: 0 }, 'SQL 仓 pageTodoTasks 空归属 ⇒ 空页')
      assert.deepEqual(await p.pageDoneTasks(1, 10, v as any), { rows: [], total: 0 }, 'SQL 仓 pageDoneTasks 空归属 ⇒ 空页')
      assert.deepEqual(await p.pageCcInstances(1, 10, v as any), { rows: [], total: 0 }, 'SQL 仓 pageCcInstances 空归属 ⇒ 空页')
    }
    // 反闸：非空归属值会去取连接并抛错 ⇒ 证明上面四组真是短路，不是探针本身失效
    await assert.rejects(() => p.pageInstances(1, 10, ME), /探针不该取连接/,
      '反闸：非空归属值应照常下查询（否则上面那 16 格空页断言是空转）')

    // 扩展仓储（委托分页）同判据：buildExtWhere + filters 两路
    const extProbe: any = new JdbcProcessExtRepository(noConn)
    const extWhere = (conditions: any[], whitelist: string[]) =>
      extProbe.buildExtWhere(conditions, new Set(whitelist)) as { sql: string; params: any[] }
    assert.equal(extWhere([cond('t.operator', '')], ['t.operator', 't.process_name']).sql, ' AND 1=0',
      'SQL 扩展仓：委托归属列 t.operator + 空值 ⇒ 空页谓词')
    assert.equal(extWhere([cond('t.operator', ME)], ['t.operator']).sql, ' AND t.operator = ?')
    assert.equal(extWhere([cond('t.process_name', '', 'LIKE')], ['t.operator', 't.process_name']).sql, '',
      '哨兵：设计/委托的 process_name 可选过滤空串仍被忽略')
    for (const v of ['', '   ', null]) {
      assert.deepEqual(await extProbe.pageSurrogates(1, 10, { operator: v }), [[], 0],
        `SQL 扩展仓 pageSurrogates：filters.operator=${JSON.stringify(v)} ⇒ 空页（与内存仓同判据）`)
    }
    await assert.rejects(() => extProbe.pageSurrogates(1, 10, { operator: ME }), /探针不该取连接/,
      '反闸：非空 filters.operator 应照常下查询')
  })

  it('委托分页 · {"operator":""} 与缺键同档；直连仓储空归属 ⇒ 空页（内存仓与 SQL 仓一个答案）', async () => {
    const f = await fixture129()
    await f.extRepo.saveSurrogate({
      id: '1290001', operator: ME, surrogate: 'agent-a', processName: '', enabled: 1,
    } as any)
    await f.extRepo.saveSurrogate({
      id: '1290002', operator: OTHER, surrogate: 'agent-b', processName: '', enabled: 1,
    } as any)
    const count = async (args: Record<string, any>) =>
      (await f.facade.flow('processSurrogate/page', { pageSize: 100, ...args })).data.rows.length
    // 本 action 在 java 门面里不下发归属条件 ⇒ 同档 = 空串与缺键都"不过滤"（不是回落 user1）
    assert.equal(await count({}), 2, '夹具：两条委托（两人各一条）')
    assert.equal(await count({ operator: '' }), await count({}), 'processSurrogate/page：{"operator":""} 应与缺键同档')
    assert.equal(await count({ operator: ' \t ' }), await count({}), 'processSurrogate/page：全空白同缺键')
    assert.equal(await count({ operator: ME }), 1, '显式归属者档照常过滤（没顺手放宽）')
    // 仓储档：直连空 operator ⇒ 空页（不是"条件丢掉"读全库）
    assert.equal((await f.extRepo.pageSurrogates(1, 10, { operator: '' }))[0].length, 0, '内存仓 filters.operator="" ⇒ 空页')
    assert.equal((await f.extRepo.pageSurrogates(1, 10, { operator: '   ' }))[0].length, 0, '内存仓 filters.operator 全空白 ⇒ 空页')
    assert.equal((await f.extRepo.pageSurrogates(1, 10, { operator: null }) as any)[0].length, 0, '内存仓 filters.operator null ⇒ 空页')
    // m_ 条件那一路由 matchConditions 的归属兜底覆盖（SURROGATE_FIELDS 带 t.operator）
    assert.equal((await f.extRepo.pageSurrogates(1, 10, undefined, [{ column: 't.operator', operator: 'EQ', value: '' }]))[0].length, 0,
      '内存仓 conditions：t.operator EQ "" ⇒ 空页')
    // 哨兵：非归属 filter 键的空值仍当作没填
    assert.equal((await f.extRepo.pageSurrogates(1, 10, { surrogate: '' }))[0].length, 2,
      '哨兵：surrogate（非归属）传空串仍被忽略 ⇒ 两条都在')
  })

  it('issues/114 硬必填未被本次改动污染：withdraw/transfer 的空串与缺键仍报「operator 必填」，绝不回落 user1', async () => {
    const f = await fixture129()
    for (const args of [{ id: f.mine[0] }, { id: f.mine[0], operator: '' }, { id: f.mine[0], operator: '  ' }]) {
      const r = await f.facade.flow('processInstance/withdraw', args)
      assert.equal(r.code, 99999999, `${JSON.stringify(args)} ⇒ ${JSON.stringify(r)}`)
      assert.ok(String(r.msg).includes('operator 必填'),
        `withdraw 空串/缺键必须硬报错（issues/114），不该被 operatorArg 兜成 ${ME}：${JSON.stringify(r)}`)
    }
    const tr = await f.facade.flow('processTask/transfer',
      { processTaskId: f.mineTodoTasks[0], fromActor: ME, toActor: OTHER, operator: '' })
    assert.equal(tr.code, 99999999, JSON.stringify(tr))
    assert.ok(String(tr.msg).includes('operator 必填'), `transfer 同样保持硬必填：${JSON.stringify(tr)}`)
  })
})

// ═══ issues/126 案 A · 任务行 expire_time 由**建单路径**按节点表达式真算 ═══════════
// 契约：jeeflow-hub/docs/goal-126-到期时间七引擎-启动词.md §1 / §1.5 / §1.8 / §1.9
// 基准＝boot2 内置版 ProcessTaskServiceImpl 的三处写（:213 普通建单 / :386 回退新建 / :524 会签建单），
// 参照实现＝jeeflow-java @ cb541d4（applyExpireTime / applyNodeExpireTime 一把尺子，五处写点）。
// 本栈原形状：engine.ts 各建单分支从不给 task.expireTime 赋值（只有回退那支例外都没有），
// 于是"配了到期表达式的节点"这一列恒空 ⇒ 逾期统计在常规流上恒 0。
// 节点没配（undefined / null / 空串）⇒ 该列保持空，不造默认值（owner 2026-09-28 口径）。
describe('issues/126 案 A 任务行到期时间：建单五处写点按节点表达式真算（T0 四格 + §1.8 两格）', () => {

  /** start → 单任务节点 task1（properties 原样落 JSON，expire 键不给＝节点没配）→ end */
  function expireFlow(props: Record<string, any>, name = 'expire126'): string {
    return JSON.stringify({
      name, displayName: '到期时间测试', type: 'approval',
      nodes: [
        { id: 'start', type: 'snaker:start', properties: {}, text: { value: '开始' } },
        { id: 'task1', type: 'snaker:task',
          properties: { assignee: 'userA', taskType: 0, performType: 0, ...props }, text: { value: '审批' } },
        { id: 'end', type: 'snaker:end', properties: {}, text: { value: '结束' } },
      ],
      edges: [
        { id: 'e1', sourceNodeId: 'start', targetNodeId: 'task1', properties: {} },
        { id: 'e2', sourceNodeId: 'task1', targetNodeId: 'end', properties: {} },
      ],
    })
  }

  /** start → 三任务线性流（specs 各自带 assignee/expire/countersign），回退与并行格用 */
  function expireFlowMulti(specs: Array<{ id: string; assignee: string; props?: Record<string, any> }>, name: string): string {
    const nodes: any[] = [{ id: 'start', type: 'snaker:start', properties: {}, text: { value: '开始' } }]
    const edges: any[] = []
    let prev = 'start'
    for (const s of specs) {
      nodes.push({ id: s.id, type: 'snaker:task',
        properties: { assignee: s.assignee, taskType: 0, performType: 0, ...(s.props ?? {}) }, text: { value: s.id } })
      edges.push({ id: `e_${prev}_${s.id}`, sourceNodeId: prev, targetNodeId: s.id, properties: {} })
      prev = s.id
    }
    nodes.push({ id: 'end', type: 'snaker:end', properties: {}, text: { value: '结束' } })
    edges.push({ id: `e_${prev}_end`, sourceNodeId: prev, targetNodeId: 'end', properties: {} })
    return JSON.stringify({ name, displayName: '到期时间测试', type: 'approval', nodes, edges })
  }

  function seedExpireDefine(repo: MemoryRepository, content: string, name: string): ProcessDefine {
    const def = {
      id: '', name, displayName: '到期时间测试', type: 'test', state: 1, content, version: 1,
      createTime: new Date(), createUser: 't', updateTime: new Date(), updateUser: 't',
    } as ProcessDefine
    repo.addDefine(def)
    return def
  }

  /** 发起一条单节点流程，读回 task1 的进行中行**持久值**（行不在 ⇒ null，便于把"没读到行"与"值为空"分开断） */
  async function rowAfterStart(props: Record<string, any>, args: Record<string, any> = {}) {
    const repo = new MemoryRepository()
    const engine = new EngineImpl(repo, undefined, seqIdGen('e126'))
    const def = seedExpireDefine(repo, expireFlow(props), 'expire126')
    const inst = await engine.startProcessInstanceById(def.id, 'userA', args)
    const doing = (await repo.findDoingTasks(inst.id)).filter(t => t.taskName === 'task1')
    assert.equal(doing.length, 1, `夹具自证：task1 进行中行应恰好 1 条，实得 ${doing.length}`)
    return await repo.findTaskById(doing[0].id)
  }

  /** 同行 create→expire 差值≈2h。带宽 [2h−5s, 2h+60s]：只判"非空"就会被 now() 占位蒙过
   *  （那正是 issues/126 病灶的形状），不许放宽成"非空" */
  function assertExpireAbout2h(expire: unknown, create: unknown, who: string): void {
    assert.ok(expire != null, `${who} 必须带到期时间（实得 ${String(expire)}）`)
    assert.ok(create != null, `${who} 的 createTime 应有值（内部对照）`)
    const delta = (new Date(expire as Date | string).getTime() - new Date(create as Date | string).getTime()) / 1000
    assert.ok(delta >= 2 * 3600 - 5 && delta <= 2 * 3600 + 60,
      `${who} 同行 create→expire 差值应≈2h，实得 ${delta}s（占位写法算出≈0 ⇒ 新建即逾期）`)
  }

  /** 取该实例里参与者含某用户的那条 DOING 行本身（读不到返回 null） */
  async function memberRow(repo: MemoryRepository, instId: string, actor: string) {
    const doing = await repo.findDoingTasks(instId)
    const hit = doing.find(t => (t.actorIds ?? []).includes(actor))
    return hit ? await repo.findTaskById(hit.id) : null
  }

  // ── T0 四格（照 Java ExpireTimeOnCreateTest 的形状，走本栈真实建单路径）────────
  it('T0① 相对档 "2h"：同一行 create→expire 差值≈2h（不是 now、不是 0）', async () => {
    const row = await rowAfterStart({ expireTime: '2h' })
    assert.ok(row, 'T0① task1 行没读到（夹具或建单路径本身出问题）')
    assertExpireAbout2h(row!.expireTime, row!.createTime, 'T0① 普通建单（2h）')
  })

  it('T0② 表达式是变量名：取实例变量那份值当到期时间（"yyyy-MM-dd HH:mm:ss" 串 + 毫秒整数两形态）', async () => {
    const str = await rowAfterStart({ expireTime: 'dueAt' }, { dueAt: '2026-12-31 10:00:00' })
    assert.ok(str, 'T0② 行没读到')
    assert.equal(new Date(str!.expireTime as Date).getTime(), new Date(2026, 11, 31, 10, 0, 0).getTime(),
      '变量档应取该变量的值（本地时区解析），而不是把变量名当表达式解析')

    const ms = 1767147600000   // 2026-12-31 10:00:00（本地）——毫秒时间戳档
    const num = await rowAfterStart({ expireTime: 'dueMs' }, { dueMs: ms })
    assert.ok(num, 'T0② 毫秒档行没读到')
    assert.equal(new Date(num!.expireTime as Date).getTime(), ms, '毫秒时间戳变量 ⇒ 该时刻')
  })

  it('T0③ 节点没配（键缺失 / null / 空串 / 纯空白）：该列保持空，绝不写 now()', async () => {
    for (const props of [{}, { expireTime: null }, { expireTime: '' }, { expireTime: '   ' }]) {
      const row = await rowAfterStart(props)
      assert.ok(row, `T0③ 行本身要读到（否则"值为空"这条恒真）：${JSON.stringify(props)}`)
      assert.ok(row!.createTime, `T0③ 对照：createTime 应有值 ${JSON.stringify(props)}`)
      assert.equal(row!.expireTime ?? null, null,
        `未配到期表达式的行不得被赋任何时间（实得 ${String(row!.expireTime)}）：${JSON.stringify(props)}`)
    }
  })

  it('T0④ 解析不出 ⇒ 留空而不是 now()（含 §1.9 第 3 条"相对档前缀非整数"落穿档）', async () => {
    for (const expr of ['not-a-time', 'xh', '12x3h', '2O26-12-31 10:00:00', '2026-13-31 10:00:00']) {
      const row = await rowAfterStart({ expireTime: expr })
      assert.ok(row, 'T0④ 行没读到')
      assert.ok(row!.createTime, 'T0④ 对照：createTime 应有值')
      assert.equal(row!.expireTime ?? null, null,
        `"${expr}" 解析不出必须留空；退回 now() 等于静默造一个"建单即逾期"的值（本案病灶）`)
    }
    // 变量档内解析失败 ⇒ null（Java/C# 同形：字符串值解析不出即终止，不落穿到相对/绝对档）
    const badVar = await rowAfterStart({ expireTime: 'dueAt' }, { dueAt: 'not-a-time' })
    assert.ok(badVar, 'T0④ 变量档负向行没读到')
    assert.equal(badVar!.expireTime ?? null, null, '变量值是字符串但解析不出 ⇒ null')
    // 落穿自证：变量存在但类型不认识（布尔）⇒ 继续走相对/绝对档，最终 null，而不是提前 return
    const boolVar = await rowAfterStart({ expireTime: 'dueAt' }, { dueAt: true })
    assert.ok(boolVar, 'T0④ 落穿档行没读到')
    assert.equal(boolVar!.expireTime ?? null, null, '变量值类型不认识 ⇒ 落穿 ⇒ 最终 null')
  })

  // ── §1.8 第五处写点：串行会签**推进出的下一位成员**（绕过建单 helper 直建行）────
  it('§1.8 串行会签首成员 ∧ 推进出的第二成员都带到期（夹具 06-countersign-sequential-expire.json）', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '06-countersign-sequential-expire.json')   // 只有 task1 配 expireTime:"2h"
    const inst = await startAndExecute(engine, repo, def.id, 'applicant')

    const first = await memberRow(repo, inst.id, 'userA')
    assert.ok(first, '串行会签首成员行没读到')
    assert.equal(first!.taskName, 'task1', '自证：断言对象是 task1 的会签行')
    assertExpireAbout2h(first!.expireTime, first!.createTime, '§1.8 首成员（createTask SEQUENTIAL 分支）')

    await engine.executeProcessTask(first!.id, 'userA')
    const second = await memberRow(repo, inst.id, 'userB')
    assert.ok(second, '推进后的第二成员行没读到')
    assert.equal(second!.taskName, 'task1', '自证：第二行仍是同一会签节点（串行推进，不是下游新节点）')
    assert.equal(String(second!.variables['loopCounter_task1']), '1',
      '自证：断言对象必须是串行会签第 2 步（loopCounter=1），不是第一步残留')
    assertExpireAbout2h(second!.expireTime, second!.createTime, '§1.8 推进新建的第二成员（第五处写点）')
  })

  it('§1.8 同夹具去掉 expireTime（原 06-countersign-sequential.json）⇒ 首成员与第二成员两行都留空', async () => {
    const { engine, repo } = setup()
    const def = loadFlow(repo, '06-countersign-sequential.json')          // 与上格唯一差异：task1 不带 expireTime
    const inst = await startAndExecute(engine, repo, def.id, 'applicant')

    const first = await memberRow(repo, inst.id, 'userA')
    assert.ok(first, '首成员行本身要读到（否则这条负向恒真）')
    assert.ok(first!.createTime, '对照：首成员 createTime 应有值')
    assert.equal(first!.expireTime ?? null, null, '未配到期表达式的会签节点，首成员行不该有到期时间')

    await engine.executeProcessTask(first!.id, 'userA')
    const second = await memberRow(repo, inst.id, 'userB')
    assert.ok(second, '推进后的第二成员行本身要读到（否则这条负向恒真）')
    assert.ok(second!.createTime, '对照：第二成员 createTime 应有值')
    assert.equal(second!.expireTime ?? null, null, '推进出的第二成员同样不该有到期时间')
  })

  // ── 其余两处写点（并行全员 / 回退新建）各一格：本轮改动含它们，无格即无牙 ─────────
  it('并行会签全员：每位成员的行都带到期（写点：createTask PARALLEL 分支）', async () => {
    const repo = new MemoryRepository()
    const engine = new EngineImpl(repo, undefined, seqIdGen('p126'))
    const def = seedExpireDefine(repo, expireFlow(
      { assignee: 'pA,pB,pC', performType: '1', countersignType: 'PARALLEL', expireTime: '2h' }), 'expire126p')
    const inst = await engine.startProcessInstanceById(def.id, 'pA')
    const rows = (await repo.findDoingTasks(inst.id)).filter(t => t.taskName === 'task1')
    assert.equal(rows.length, 3, `并行会签应恰好 3 条进行中行，实得 ${rows.length}`)
    for (const r of rows) {
      const persisted = await repo.findTaskById(r.id)
      assert.ok(persisted, `并行成员 ${JSON.stringify(r.actorIds)} 的行没读到`)
      assertExpireAbout2h(persisted!.expireTime, persisted!.createTime,
        `并行全员（参与者 ${JSON.stringify(r.actorIds)}）`)
    }
  })

  it('回退新建：表达式取**被回退掉的那个节点**、变量源取随行那份（写点：rollbackToParent）', async () => {
    const repo = new MemoryRepository()
    const engine = new EngineImpl(repo, undefined, seqIdGen('r126'))
    // b1 不配到期；b2 配 dueAt（变量名档）⇒ 从 b2 回退复活的 b1 行必须按 **b2 的表达式** 算
    const def = seedExpireDefine(repo, expireFlowMulti(
      [{ id: 'b1', assignee: 'rbkA' }, { id: 'b2', assignee: 'rbkB', props: { expireTime: 'dueAt' } }], 'expire126r'),
      'expire126r')
    const inst = await engine.startProcessInstanceById(def.id, 'rbkA', { dueAt: '2026-12-31 10:00:00' })
    const b1 = (await repo.findDoingTasks(inst.id)).find(t => t.taskName === 'b1')!
    const b1Row = await repo.findTaskById(b1.id)
    assert.ok(b1Row, 'b1 原始行没读到')
    assert.equal(b1Row!.expireTime ?? null, null, 'b1 节点未配到期 ⇒ 原始行留空（本格内部对照）')
    await engine.executeProcessTask(b1.id, 'rbkA')

    const b2 = (await repo.findDoingTasks(inst.id)).find(t => t.taskName === 'b2')!
    const b2Row = await repo.findTaskById(b2.id)
    assert.ok(b2Row, 'b2 行没读到')
    assert.equal(new Date(b2Row!.expireTime as Date).getTime(), new Date(2026, 11, 31, 10, 0, 0).getTime(),
      'b2 行按变量档取 dueAt 的值（发起时并入实例变量）')

    await engine.executeAndJumpTask(b2.id, 'rbkB', {})   // 空 target = ROLLBACK 血缘版
    const revived = (await repo.findDoingTasks(inst.id)).filter(t => t.taskName === 'b1')
    assert.equal(revived.length, 1, `复活出的 b1 行应恰好 1 条，实得 ${revived.length}`)
    const row = await repo.findTaskById(revived[0].id)
    assert.ok(row, '回退新建的行本身要读到（否则下面"值为空"恒真）')
    assert.equal(new Date(row!.expireTime as Date).getTime(), new Date(2026, 11, 31, 10, 0, 0).getTime(),
      '回退新建按当前节点（b2）表达式 + 随行变量重算——与 boot2 :386 / Java rejectTask 逐字一致')
  })
})

// ═══ issues/134 案 A · 撤回的实例状态守卫（内部码 20010009）═══════════════════════
// 契约：jeeflow-doc `docs/spec/06-facade.md` §processInstance/withdraw ＋
//       jeeflow-hub `issues/134-….md` §5.1（owner 2026-09-28 拍板 A，八栈同形）。
// 判据：撤回作用于**实例**时，实例 state ≠ 10(进行中) 一律拒；被拒时 state 不被改写、不落库。
// 出口＝issues/121 口径：门面吞内部码 ⇒ code=99999999 ＋ msg **逐字**等值
//       「流程实例非进行中，无法撤回」，不拼码、不加前缀。
// ⚠️ state=40 那一档本栈引擎没有常规流转路径，且集成侧 gate 造不出 40 行（issues/134 §5.2 注：
//    L2-15 已证壳侧造不出）⇒ 40 由本栈引擎单测钉；L2-28 只钉 20 ＋ 正向 10。
// 任务行层面的既有保护（20/40 任务行不得被撤回改写）保持原样，实例级守卫排在它之前。
describe('issues/134 案 A 撤回实例状态守卫 20010009：非 10 一律拒且不改写、不落库', () => {
  const NOT_DOING = '流程实例非进行中，无法撤回'   // 逐字八栈一致，L2-28 按等值断言

  /** 01-simple 夹具：deploy 一次，start() 起一条由 zhangsan 发起、停在 task1(leader) 的进行中实例 */
  async function harness134() {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
    const r0 = await facade.flow('processDefine/deploy', { content: readFileSync(flowDir + '01-simple.json', 'utf-8') })
    assert.equal(r0.code, 0, JSON.stringify(r0))
    const start = async () => {
      const r = await facade.flow('processInstance/startAndExecute',
        { processDefineId: r0.data.processDefineId, operator: 'zhangsan' })
      assert.equal(r.code, 0, JSON.stringify(r))
      return r.data.processInstanceId as string
    }
    return { repo, facade, start }
  }

  it('聚合根 withdraw：state≠10 逐档抛逐字文案，且 state/updateTime 一行不动（20/30/40/45/50/99）', () => {
    for (const state of [InstanceState.Done, InstanceState.Withdraw, InstanceState.Interrupt,
      InstanceState.Reject, InstanceState.Pending, InstanceState.Abandon]) {
      const inst = ProcessInstance.create(`i134-agg-${state}`, 'd134', 'zhangsan', {}, new Date())
      inst.state = state   // 夹具：非进行中态直钉（本栈引擎无 40/45/50/99 的撤回前置流转）
      const beforeUpdate = new Date(inst.updateTime).getTime()
      let thrown: any = null
      try { inst.withdraw(new Date()) } catch (e) { thrown = e }
      assert.ok(thrown, `state=${state} 的实例撤回必须被拒（未抛＝守卫没牙）`)
      assert.equal(String(thrown.message), NOT_DOING,
        `state=${state} 的拒绝文案要逐字等值（宽松"包含 撤回"判据不许放宽）`)
      assert.ok(!String(thrown.message).includes('20010009'),
        `内部码不得进 msg（issues/121 口径）：${thrown.message}`)
      assert.equal(inst.state, state, `被抛后实例 state 不得被改写（state=${state} 实测 ${inst.state}）`)
      assert.equal(new Date(inst.updateTime).getTime(), beforeUpdate, `被抛后 updateTime 也不该动（state=${state}）`)
    }
    // 正向对照：同一条聚合根路径，state=10 必须仍落 30（防守卫条件写反把正常路径也拦了）
    const doing = ProcessInstance.create('i134-agg-10', 'd134', 'zhangsan', {}, new Date())
    assert.equal(doing.state, InstanceState.Doing, '夹具自证：create 出来就是进行中(10)')
    doing.withdraw(new Date())
    assert.equal(doing.state, InstanceState.Withdraw, '正向：进行中实例撤回应落 30（WITHDRAW，不是 99）')
  })

  it('门面负向 state=20（已办结）：code=99999999 + msg 逐字等值，再读实例仍 20、任务行仍 20', async () => {
    const { repo, facade, start } = await harness134()
    const iid = await start()
    const task1 = (await repo.findDoingTasks(iid)).find(t => t.taskName === 'task1')
    assert.ok(task1, '夹具自证：发起后应有 task1 进行中行（否则下面办结那步打空）')
    assert.equal((await facade.flow('processTask/execute',
      { processTaskId: task1!.id, operator: 'leader', submitType: 1 })).code, 0, '前置：leader 办结 task1')

    const done = await repo.findInstanceById(iid)
    assert.equal(done?.state, InstanceState.Done, '夹具自证：办结后实例应=20（否则本档负向判据没有对象）')
    const beforeUpdate = new Date(done!.updateTime).getTime()
    const beforeUpdateUser = done!.updateUser

    const r = await facade.flow('processInstance/withdraw', { id: iid, operator: 'zhangsan' })
    assert.equal(r.code, 99999999, `已办结(20)实例撤回必须被拒: ${JSON.stringify(r)}`)
    assert.equal(r.msg, NOT_DOING, `出口 msg 逐字等值，不拼码不加前缀: ${r.msg}`)
    assert.ok(!String(r.msg).includes('20010009'), `内部码不进 msg（issues/121 口径）: ${r.msg}`)

    // 病灶判据：改前这条会被静默改写成 30，用户看不到任何报错
    const after = await repo.findInstanceById(iid)
    assert.equal(after?.state, InstanceState.Done, '被拒后实例 state 仍是 20，不得静默改写')
    assert.equal(new Date(after!.updateTime).getTime(), beforeUpdate, '被拒后 updateTime 未被改写（未落库）')
    assert.equal(after!.updateUser, beforeUpdateUser, '被拒后 update_user 没被污染成撤回人')
    // 任务行层面既有保护原样
    assert.equal((await repo.findTaskById(task1!.id))?.taskState, TaskState.Done, '已完成(20)任务行不被撤回改写')
  })

  it('门面负向 state=40（已终止）：同样逐字拒绝，实例仍 40 且进行中任务行一条都不动', async () => {
    const { repo, facade, start } = await harness134()
    const iid = await start()
    const doing = await repo.findDoingTasks(iid)
    assert.ok(doing.length >= 1, '夹具自证：本档要有进行中任务行，才验得出"守卫排在任务改写之前"')
    // 造 40：本栈引擎无常规"终止"流转，集成侧 gate 也造不出 40 行 ⇒ 引擎栈内直钉（issues/134 §5.2）
    const inst40 = await repo.findInstanceById(iid)
    inst40!.state = InstanceState.Interrupt
    await repo.updateInstance(inst40!)
    assert.equal((await repo.findInstanceById(iid))?.state, InstanceState.Interrupt,
      '夹具自证：40 档已就位且落库（否则本档只是又跑了 10 的正向路径）')

    const r = await facade.flow('processInstance/withdraw', { id: iid, operator: 'zhangsan' })
    assert.equal(r.code, 99999999, `已终止(40)实例撤回必须被拒: ${JSON.stringify(r)}`)
    assert.equal(r.msg, NOT_DOING, `出口 msg 逐字等值: ${r.msg}`)
    assert.ok(!String(r.msg).includes('20010009'), `内部码不进 msg: ${r.msg}`)

    assert.equal((await repo.findInstanceById(iid))?.state, InstanceState.Interrupt,
      '被拒后实例 state 仍是 40（不得被静默改写成 30）')
    for (const t of doing) {
      assert.equal((await repo.findTaskById(t.id))?.taskState, TaskState.Doing,
        `被拒后进行中任务行仍 10（守卫排在任务改写与 updateTask 落库之前），实测行 ${t.id}`)
    }
  })

  it('正向对照 state=10：撤回仍 code=0 并落 30；再次撤回（state=30）被同一文案拒绝', async () => {
    const { repo, facade, start } = await harness134()
    const iid = await start()
    const doing = await repo.findDoingTasks(iid)
    assert.ok(doing.length >= 1, '夹具自证：进行中实例有 doing 行')

    const ok = await facade.flow('processInstance/withdraw', { id: iid, operator: 'zhangsan' })
    assert.equal(ok.code, 0, `进行中(10)实例的正常撤回不得被新守卫拦掉: ${JSON.stringify(ok)}`)
    assert.equal((await repo.findInstanceById(iid))?.state, InstanceState.Withdraw, '正向：实例落 30')
    for (const t of doing) {
      assert.equal((await repo.findTaskById(t.id))?.taskState, TaskState.Withdraw,
        `正向：进行中任务行落 30，实测 ${t.id}`)
    }
    assert.equal((await repo.findDoingTasks(iid)).length, 0, '正向：撤回作用于整单，无残留 doing')

    // 已撤回(30) 本身也属"非进行中" ⇒ 二次撤回同样被拒，状态不被反复改写
    const again = await facade.flow('processInstance/withdraw', { id: iid, operator: 'zhangsan' })
    assert.equal(again.code, 99999999, `撤回态(30)实例二次撤回应被拒: ${JSON.stringify(again)}`)
    assert.equal(again.msg, NOT_DOING, `二次撤回出口 msg 逐字等值: ${again.msg}`)
    assert.equal((await repo.findInstanceById(iid))?.state, InstanceState.Withdraw, '被拒后实例仍 30')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// issues/127 ＋ issues/132「事件代码腿」
// 判据源＝jeeflow-doc/docs/spec/11-events.md（§11.3 码表 / §11.6 迁移 / §11.7 抄送联动）
//        ＋ spec/08-compliance.md 场景 28~36（每支都断"收到 ＋ 顺序 ＋ 时机"，只断出现过不算过）
// ─────────────────────────────────────────────────────────────────────────────

describe('issues/127/132 事件腿：A 套码表 · 办理抄送 · 5/6 互斥 · 6/7/8/9 补支', () => {
  /** §11.3 权威规范名 ↔ 本栈码值（测试按规范名断言，码值只在"码表钉死"档里出现） */
  const SPEC_NAME: Record<number, string> = {
    1: 'PROCESS_INSTANCE_START', 2: 'PROCESS_INSTANCE_END', 3: 'PROCESS_TASK_START',
    4: 'CC_CREATE', 5: 'TASK_COMPLETE', 6: 'TASK_REJECT', 7: 'TASK_TRANSFER',
    8: 'TASK_WITHDRAW', 9: 'INSTANCE_TERMINATED',
  }
  /** recorder 监听器：按 fire 顺序逐条留档（浅拷贝，防对象复用串档） */
  function attachRecorder(engine: EngineImpl): ProcessEvent[] {
    const fired: ProcessEvent[] = []
    engine.setExtensions({ listeners: [(e) => { fired.push({ ...e }) }] })
    return fired
  }
  const nameOf = (e: ProcessEvent) => SPEC_NAME[e.type]
  /** 折叠重复后的规范名序列（同一支多次 fire 只留首次出现，顺序保真） */
  function firstSeen(fired: ProcessEvent[]): string[] {
    const out: string[] = []
    for (const e of fired) if (!out.includes(nameOf(e))) out.push(nameOf(e))
    return out
  }
  function facadeOf(engine: EngineImpl, repo: MemoryRepository) {
    return new JeeflowFacade(engine, repo, new MemoryExtRepository())
  }
  async function deploy(facade: JeeflowFacade, file: string): Promise<string> {
    const r = await facade.flow('processDefine/deploy', { content: readFileSync(flowDir + file, 'utf-8') })
    assert.equal(r.code, 0, JSON.stringify(r))
    return String(r.data.processDefineId)
  }
  async function start(facade: JeeflowFacade, defineId: string, operator: string, extra: Record<string, any> = {}) {
    const r = await facade.flow('processInstance/startAndExecute',
      { processDefineId: defineId, operator, ...extra })
    assert.equal(r.code, 0, JSON.stringify(r))
    return String(r.data.processInstanceId)
  }

  /** §11.6 兼容别名表：旧成员名 → 规范成员名 ＋ 旧码值（别名是 enum 外部的同值常量） */
  const LEGACY_ALIAS: Array<[string, EventType, string, number]> = [
    ['ProcessStart',  ProcessStart,  'ProcessInstanceStart', 0],
    ['ProcessFinish', ProcessFinish, 'ProcessInstanceEnd',   1],
    ['ProcessReject', ProcessReject, 'ProcessInstanceEnd',   2],
    ['TaskCreate',    TaskCreate,    'ProcessTaskStart',     3],
    ['TaskComplete',  TaskComplete,  'TaskComplete',         4],
    ['CcCreate',      CcCreate,      'CcCreate',             5],
  ]
  /** 码值 → 本栈 enum 成员名（反向映射判据源；与 SPEC_NAME 的 SCREAMING 权威名一一对应） */
  const MEMBER_BY_CODE: Record<number, string> = {
    1: 'ProcessInstanceStart', 2: 'ProcessInstanceEnd', 3: 'ProcessTaskStart', 4: 'CcCreate',
    5: 'TaskComplete', 6: 'TaskReject', 7: 'TaskTransfer', 8: 'TaskWithdraw', 9: 'InstanceTerminated',
  }

  it('码表钉死：EventType 整表＝规范 11 §11.3 的 A 套 1..9，旧 0..5 套成员名一律不作 enum 成员（只作 §11.6 外部别名）', () => {
    assert.deepEqual([
      EventType.ProcessInstanceStart, EventType.ProcessInstanceEnd, EventType.ProcessTaskStart,
      EventType.CcCreate, EventType.TaskComplete, EventType.TaskReject, EventType.TaskTransfer,
      EventType.TaskWithdraw, EventType.InstanceTerminated,
    ], [1, 2, 3, 4, 5, 6, 7, 8, 9], 'A 套码值（CcCreate 5→4、TaskComplete 4→5、实例终态统一 2、退回走 6）')
    // 旧形状退场判据**改判**（§11.6「改名兼容义务」）：旧成员名必须还在，但以 **enum 外部的同值常量别名**
    // 形态存在一代（见下方「兼容别名」格），不能塞回 enum 成员列表——数字枚举同值成员会覆盖反向映射，
    // 那才是"拿数字码当判据"的温床。故此处只钉：enum 成员名恰 9 支、旧名不在成员名里。
    const members = Object.keys(EventType).filter(k => isNaN(Number(k)))
    assert.equal(members.length, 9, `成员数＝9，实测 ${members.join(',')}`)
    assert.equal(new Set(members.map(m => (EventType as any)[m])).size, 9, '码值唯一，无复用')
    for (const [legacy, alias, spec] of LEGACY_ALIAS) {
      if (legacy === spec) continue   // TaskComplete/CcCreate 名未改（只挪码值），本身就是成员名
      assert.ok(!members.includes(legacy), `旧成员名 ${legacy} 不得回流成 enum 成员（同值成员会覆盖反向映射）`)
      assert.ok(Number.isInteger(alias as number), `旧名 ${legacy} 的 §11.6 别名必须存在且是整型码`)
    }
  })

  it('§11.6 兼容别名：六个旧成员名逐个 === 对应规范名成员（同符号同值），并从包门面 index 出口拿得到', () => {
    // ① 六支逐个：别名与规范名成员是"同一个成员"（TS 数字枚举里即同一个值），switch 命中同一 case
    assert.equal(ProcessStart,  EventType.ProcessInstanceStart, '旧 ProcessStart(0) → ProcessInstanceStart(1)')
    assert.equal(ProcessFinish, EventType.ProcessInstanceEnd,   '旧 ProcessFinish(1) → ProcessInstanceEnd(2)')
    assert.equal(ProcessReject, EventType.ProcessInstanceEnd,   '旧 ProcessReject(2) → ProcessInstanceEnd(2)')
    assert.equal(TaskCreate,    EventType.ProcessTaskStart,     '旧 TaskCreate(3) → ProcessTaskStart(3)')
    assert.equal(TaskComplete,  EventType.TaskComplete,         '旧 TaskComplete(4) → 同名成员，码值 4→5')
    assert.equal(CcCreate,      EventType.CcCreate,             '旧 CcCreate(5) → 同名成员，码值 5→4')
    // 逐支的"旧码 → 新码"台账（防改名时把两支接错）：新码即规范成员值，且必须能在反向映射里取回规范名
    for (const [legacy, alias, spec, oldCode] of LEGACY_ALIAS) {
      assert.equal(alias, (EventType as any)[spec], `${legacy} 必须＝${spec}`)
      assert.equal(MEMBER_BY_CODE[alias], spec,
        `${legacy}：旧码 ${oldCode} → 新码 ${alias}，反向名＝${spec}`)
    }
    // ② 别名走**同一条出口**：src/index.ts 是第三方可 import 的面（包门面），旧引用升 pin 后要能编过
    for (const [legacy, alias] of LEGACY_ALIAS) {
      assert.equal((pkg as Record<string, unknown>)[legacy], alias,
        `包门面必须导出旧名别名 ${legacy}（下游 import 面只有 index）`)
    }
    assert.equal(((pkg as Record<string, any>).EventType as Record<string, unknown>).ProcessStart, undefined,
      '别名不得挂在 enum 对象上（数字枚举同值成员会覆盖反向映射）——只作模块级常量导出')
  })

  it('§11.6 反向映射未被别名污染：EventType[1..9] 九支逐个仍取到规范成员名（sink 靠它写 <code>|<规范名>）', () => {
    assert.equal(EventType[EventType.ProcessInstanceStart], 'ProcessInstanceStart',
      '1 的反向名不能被旧别名 ProcessStart 顶掉')
    for (const [code, member] of Object.entries(MEMBER_BY_CODE)) {
      assert.equal(EventType[Number(code)], member, `反向映射 ${code} → ${member}`)
    }
    // 六支别名逐支反查：拿到的是规范名，不是旧名（把别名写进 enum 成员就会在这一格红）
    for (const [legacy, alias, spec] of LEGACY_ALIAS) {
      assert.equal(EventType[alias], spec, `别名 ${legacy} 同值位的反向名＝规范成员名 ${spec}`)
    }
    // 反向键集合也恰是 1..9 九个，多一个少一个都算污染
    assert.deepEqual(Object.keys(EventType).filter(k => !isNaN(Number(k))).map(Number).sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('§11.6 合并语义：旧 ProcessFinish / ProcessReject 两支别名同指码 2，一次办结的流水只落一支码 2', async () => {
    assert.equal(ProcessFinish, 2, '旧 ProcessFinish(1) → 码 2')
    assert.equal(ProcessReject, 2, '旧 ProcessReject(2) → 码 2')
    assert.equal(ProcessFinish, ProcessReject, '两支别名＝同一支（"办结/拒绝"合并为实例终态，靠载荷 state 分）')
    assert.equal(EventType[ProcessFinish], 'ProcessInstanceEnd', '码 2 的反向名仍是规范名')
    assert.notEqual(EventType.TaskReject, ProcessFinish, '"任务被退回"另立 6，不再混在实例终态里')
    // 流水判据复用第一轮 5/6 互斥那条 recorder 口径（不重写实现）：一次正常办结，两支旧别名分别命中
    const { engine, repo } = setup()
    const fired = attachRecorder(engine)
    const facade = facadeOf(engine, repo)
    const instanceId = await start(facade, await deploy(facade, '01-simple.json'), 'zhangsan')
    const task = (await repo.findDoingTasks(instanceId))[0]
    fired.length = 0
    const r = await facade.flow('processTask/execute',
      { processTaskId: task.id, operator: 'leader', submitType: SubmitType.Agree })
    assert.equal(r.code, 0, JSON.stringify(r))
    const byFinish = fired.filter(e => e.type === ProcessFinish)
    const byReject = fired.filter(e => e.type === ProcessReject)
    assert.equal(byFinish.length, 1, `一次办结只落一支码 2: ${fired.map(e => e.type)}`)
    assert.deepEqual(byReject, byFinish, '旧两支别名分别分派命中的是同一条记录（合并，不产生两支码 2）')
    assert.equal(fired.filter(e => e.type === 2).length, 1, '流水里码 2 恰一条')
    // sink 串按反向映射取名：旧名绝不能出现在 <code>|<规范名>|<sourceId> 里
    const sink = fired.map(e => `${e.type}|${EventType[e.type]}|${e.taskId ?? e.instanceId}`)
    assert.ok(!sink.some(s => /Process(Finish|Reject)|TaskCreate/.test(s)),
      `sink 规范名只出自反向映射: ${sink.join(',')}`)
    assert.ok(sink.includes(`2|ProcessInstanceEnd|${instanceId}`), `实例终态那支: ${sink.join(',')}`)
  })

  it('场景 28~32 主链 recorder：一条流从发起到办结按顺序收 [1,3,5,3,5,2]，规范名序列 [START, TASK_START, COMPLETE, END]', async () => {
    const { engine, repo } = setup()
    const fired = attachRecorder(engine)
    const facade = facadeOf(engine, repo)
    const defineId = await deploy(facade, '01-simple.json')
    const instanceId = await start(facade, defineId, 'zhangsan')
    const doing = await repo.findDoingTasks(instanceId)
    assert.equal(doing[0].taskName, 'task1', '夹具自证：发起腿自动办掉 apply，剩 task1')
    const r = await facade.flow('processTask/execute',
      { processTaskId: doing[0].id, operator: 'leader', submitType: SubmitType.Agree })
    assert.equal(r.code, 0, JSON.stringify(r))

    // ① 码值序列逐格保序（apply 与 task1 各一对 3/5，末格是实例终态 2）
    assert.deepEqual(fired.map(e => e.type), [1, 3, 5, 3, 5, 2],
      `fire 序列逐格: ${fired.map(e => `${e.type}(${nameOf(e)})`).join(',')}`)
    // ② 规范名序列＝§11.8 L2-30 那一串（缺支或错序都红）
    assert.deepEqual(firstSeen(fired),
      ['PROCESS_INSTANCE_START', 'PROCESS_TASK_START', 'TASK_COMPLETE', 'PROCESS_INSTANCE_END'])
    // ③ 时机：每支都在落库之后——1 之后实例可反查；3 之后任务可反查且参与者已就位；
    //    2 的 state 与落库值一致
    assert.ok(await repo.findInstanceById(fired[0].instanceId), '1 fire 时实例行已落库')
    for (const e of fired.filter(x => x.type === 3)) {
      assert.ok(await repo.findTaskById(e.taskId!), `3 的 sourceId=${e.taskId} 落库后可反查`)
      assert.ok(Array.isArray(e.actors) && e.actors.length > 0, `3 必带非空 actors 键: ${JSON.stringify(e)}`)
      assert.deepEqual(e.actors, await repo.findTaskActors(e.taskId!), '3 的 actors＝落库的参与者列表')
    }
    const end = fired[fired.length - 1]
    assert.equal(end.type, 2)
    assert.equal(end.state, InstanceState.Done, '2 的 state＝落库后的整数')
    assert.equal((await repo.findInstanceById(end.instanceId))!.state, InstanceState.Done)
    // ④ 5 的载荷必备键（§11.3），且不用"省略整键"表达可空字段（issues/122 同族）
    for (const e of fired.filter(x => x.type === 5)) {
      assert.ok('submitType' in e && typeof e.submitType === 'number', `5 必带 submitType: ${JSON.stringify(e)}`)
      assert.ok(e.instanceId && e.taskId && e.operator, `5 的 instanceId/taskId/operator 齐: ${JSON.stringify(e)}`)
    }
  })

  it('载荷 submitType 三档：显式值原样透传 / 变量里从未出现过 ⇒ 归一成整数 1(AGREE) / 绝不"省略整键"（issues/122 同族坑）', async () => {
    // ① 纯引擎路径：startProcessInstanceById 不自动办 apply ⇒ 实例/任务变量里根本没有 submitType
    const { engine, repo } = setup()
    const fired = attachRecorder(engine)
    const def = loadFlow(repo, '01-simple.json')
    const inst = await engine.startProcessInstanceById(def.id, 'zhangsan')
    fired.length = 0
    const apply = (await repo.findDoingTasks(inst.id))[0]
    await engine.executeProcessTask(apply.id, 'zhangsan')   // 无 args：引擎按默认（同意）办理
    const bare = fired.filter(e => e.type === 5).pop()!
    assert.ok(bare, '无 submitType 的办理仍是"任务被办掉"')
    assert.equal(bare.submitType, SubmitType.Agree, '缺 submitType 时归一成 1（与引擎"非拒绝即办结"同尺）')
    assert.ok(JSON.stringify(bare).includes('"submitType"'), '序列化后 submitType 键仍在')

    // ② 门面显式提交：载荷原样透传那支码（不重新解释）
    const e2 = setup()
    const fired2 = attachRecorder(e2.engine)
    const facade2 = facadeOf(e2.engine, e2.repo)
    const iid2 = await start(facade2, await deploy(facade2, '01-simple.json'), 'zhangsan')
    fired2.length = 0
    const r2 = await facade2.flow('processTask/execute', {
      processTaskId: (await e2.repo.findDoingTasks(iid2))[0].id,
      operator: 'leader', submitType: SubmitType.ReApply,
    })
    assert.equal(r2.code, 0, JSON.stringify(r2))
    assert.equal(fired2.filter(e => e.type === 5).pop()!.submitType, SubmitType.ReApply)

    // ③ 继承档：apply 提交过的 submitType=0 已合进实例变量，后续直连办理不传 ⇒ 读到的就是那份
    //    （fire 载荷与 executeNode TypeEnd 的拒绝判据取同一个 vars，两处不得各算一套）
    const e3 = setup()
    const fired3 = attachRecorder(e3.engine)
    const facade3 = facadeOf(e3.engine, e3.repo)
    const iid3 = await start(facade3, await deploy(facade3, '01-simple.json'), 'zhangsan')
    fired3.length = 0
    await e3.engine.executeProcessTask((await e3.repo.findDoingTasks(iid3))[0].id, 'leader')
    const inherited = fired3.filter(e => e.type === 5).pop()!
    assert.equal(inherited.submitType, SubmitType.Apply, '合并变量里的 submitType 原样带出，不是又造一个默认值')
    assert.ok(typeof inherited.submitType === 'number' && Number.isFinite(inherited.submitType))
  })

  it('issues/127 办理腿：execute 带 tf_ccActors ⇒ cc 行落库后逐人 fire CC_CREATE(4)，fire 时 cc 行已可反查', async () => {
    const { engine, repo } = setup()
    const seen: ProcessEvent[] = []
    const rowVisible: boolean[] = []
    engine.setExtensions({
      listeners: [async (e) => {
        if (e.type !== EventType.CcCreate) return
        seen.push(e)
        // 时机判据：监听器被调的当下就该能读到 cc 行（先 fire 后落库 ⇒ 红）
        rowVisible.push((await repo.pageCcInstances(1, 10, e.ccActorId!)).total >= 1)
      }],
    })
    const facade = facadeOf(engine, repo)
    const defineId = await deploy(facade, '01-simple.json')
    const instanceId = await start(facade, defineId, 'zhangsan')
    assert.deepEqual(seen, [], '不传 tf_ccActors 时零抄送事件（纯增量，不凭空多发）')
    const task = (await repo.findDoingTasks(instanceId))[0]
    const r = await facade.flow('processTask/execute', {
      processTaskId: task.id, operator: 'leader', submitType: SubmitType.Agree,
      tf_ccActors: 'alice, bob ,alice,',   // 逗号串：空项丢弃、同人去重（一次事实一次 fire）
    })
    assert.equal(r.code, 0, JSON.stringify(r))
    assert.deepEqual(seen.map(e => e.ccActorId), ['alice', 'bob'], '逐抄送人 fire 且顺序保真')
    assert.deepEqual([...new Set(seen.map(e => e.type))], [EventType.CcCreate], 'CC_CREATE 落 4 号位（旧 5 作废）')
    for (const e of seen) assert.equal(e.instanceId, instanceId, 'CC_CREATE 的 sourceId＝instanceId')
    assert.ok(rowVisible.every(v => v), `每条 CC_CREATE 触发时 cc 行已落库：${rowVisible}`)
    for (const actor of ['alice', 'bob']) {
      assert.equal((await repo.pageCcInstances(1, 10, actor)).total, 1, `${actor} 的 cc 行存在`)
    }
  })

  it('三腿同码：发起 f_ccActors／办理 tf_ccActors／手动 createCCInstance 共用一个漏斗，全部 CC_CREATE(4) 且逐人一次', async () => {
    const { engine, repo } = setup()
    const fired = attachRecorder(engine)
    const facade = facadeOf(engine, repo)
    const defineId = await deploy(facade, '01-simple.json')
    const instanceId = await start(facade, defineId, 'zhangsan', { f_ccActors: ['alice', 'bob'] })
    const task = (await repo.findDoingTasks(instanceId))[0]
    await facade.flow('processTask/execute',
      { processTaskId: task.id, operator: 'leader', submitType: SubmitType.Agree, tf_ccActors: 'carol' })
    const manual = await facade.flow('processInstance/createCCInstance',
      { processInstanceId: instanceId, operator: 'zhangsan', actorIds: 'dave,eve' })
    assert.equal(manual.code, 0, JSON.stringify(manual))
    const ccs = fired.filter(e => e.type === EventType.CcCreate)
    assert.deepEqual(ccs.map(e => e.ccActorId), ['alice', 'bob', 'carol', 'dave', 'eve'],
      `三条路径逐人各一次: ${ccs.map(e => e.ccActorId)}`)
    assert.deepEqual(firstSeen(ccs), ['CC_CREATE'], '三腿同码，路径不进事件名（§11.2 原则 1）')
    for (const actor of ['alice', 'bob', 'carol', 'dave', 'eve']) {
      assert.equal((await repo.pageCcInstances(1, 10, actor)).total, 1, `${actor} 有且只有一行 cc`)
    }
  })

  it('场景 30/31 互斥：submitType=2 拒绝 ⇒ 只 fire TASK_REJECT(6) 不再 fire 5，实例终态另发 2(state=45)', async () => {
    const { engine, repo } = setup()
    const fired = attachRecorder(engine)
    const facade = facadeOf(engine, repo)
    const defineId = await deploy(facade, '01-simple.json')
    const instanceId = await start(facade, defineId, 'zhangsan')
    fired.length = 0
    const task = (await repo.findDoingTasks(instanceId))[0]
    const r = await facade.flow('processTask/execute',
      { processTaskId: task.id, operator: 'leader', submitType: SubmitType.Reject })
    assert.equal(r.code, 0, JSON.stringify(r))
    assert.deepEqual(fired.map(e => e.type), [6, 2], '同一次拒绝：6 一支 ＋ 实例终态 2 一支，5 不得出现')
    assert.equal(fired[0].submitType, SubmitType.Reject, '6 的载荷带 submitType')
    assert.equal(fired[0].taskId, task.id, '6 的 sourceId＝taskId')
    assert.equal(fired[1].state, InstanceState.Reject, '2 的 state＝落库后的 45')
  })

  it('场景 31 族：submitType=3 退回上一步 / 6 退发起人 / 20 会签软拒绝 ⇒ 各发 6 不发 5', async () => {
    for (const submitType of [SubmitType.Rollback, SubmitType.RollbackToOperator]) {
      const { engine, repo } = setup()
      const fired = attachRecorder(engine)
      const facade = facadeOf(engine, repo)
      const defineId = await deploy(facade, '01-simple.json')
      const instanceId = await start(facade, defineId, 'zhangsan')
      fired.length = 0
      const task = (await repo.findDoingTasks(instanceId))[0]
      const r = await facade.flow('processTask/execute',
        { processTaskId: task.id, operator: 'leader', submitType })
      assert.equal(r.code, 0, `submitType=${submitType}: ${JSON.stringify(r)}`)
      assert.equal(fired.filter(e => e.type === 5).length, 0, `submitType=${submitType} 不得 fire TASK_COMPLETE`)
      const rejects = fired.filter(e => e.type === 6)
      assert.equal(rejects.length, 1, `submitType=${submitType} 应恰 fire 一支 TASK_REJECT`)
      assert.equal(rejects[0].submitType, submitType, '载荷 submitType 原值透传')
      // 回退复活出来的新待照样 fire 3（场景 29"回退复活行"）
      assert.ok(fired.some(e => e.type === 3), `submitType=${submitType} 复活行也要 fire 3`)
      assert.deepEqual(firstSeen(fired).slice(0, 2), ['TASK_REJECT', 'PROCESS_TASK_START'])
    }
    // 软拒绝：并行会签节点未完成即停留，本次动作仍是"被退回"
    const { engine, repo } = setup()
    const fired = attachRecorder(engine)
    const facade = facadeOf(engine, repo)
    const defineId = await deploy(facade, '05-countersign-parallel.json')
    const instanceId = await start(facade, defineId, 'zhangsan')
    fired.length = 0
    const members = await repo.findDoingTasks(instanceId)
    assert.equal(members.length, 3, '夹具自证：并行会签 3 条 doing 行')
    const r = await facade.flow('processTask/execute',
      { processTaskId: members[0].id, operator: members[0].actorIds[0], submitType: SubmitType.CountersignDisagree })
    assert.equal(r.code, 0, JSON.stringify(r))
    assert.deepEqual(fired.map(e => e.type), [6], '会签软拒绝＝退回族，只发 6（既没办掉也没生成新待办）')
    assert.equal(fired[0].submitType, SubmitType.CountersignDisagree)
  })

  it('场景 34 转办：参与者替换落库之后 fire TASK_TRANSFER(7)，载荷带 instanceId/taskId/fromActor/toActor/operator', async () => {
    const { engine, repo } = setup()
    const seen: ProcessEvent[] = []
    const actorsAtFire: string[][] = []
    engine.setExtensions({
      listeners: [async (e) => {
        if (e.type !== EventType.TaskTransfer) return
        seen.push(e)
        actorsAtFire.push(await repo.findTaskActors(e.taskId!))
      }],
    })
    const facade = facadeOf(engine, repo)
    const defineId = await deploy(facade, '01-simple.json')
    const instanceId = await start(facade, defineId, 'zhangsan')
    const task = (await repo.findDoingTasks(instanceId))[0]
    const r = await facade.flow('processTask/transfer',
      { processTaskId: task.id, operator: 'leader', fromActor: 'leader', toActor: 'carol', reason: '出差' })
    assert.equal(r.code, 0, JSON.stringify(r))
    assert.equal(seen.length, 1, '一次转办 fire 一次')
    const evt = seen[0]
    assert.equal(evt.instanceId, instanceId)
    assert.equal(evt.taskId, task.id, '7 的 sourceId＝taskId（沿用同一任务，不新建）')
    assert.equal(evt.fromActor, 'leader')
    assert.equal(evt.toActor, 'carol')
    assert.equal(evt.operator, 'leader')
    assert.deepEqual(actorsAtFire[0], ['carol'], 'fire 时参与者已替换落库（原人已摘、新人已在）')
    assert.ok(!firstSeen(seen).includes('TASK_COMPLETE'), '转办不冒充"任务被办掉"')
  })

  it('场景 32/34 撤回：TASK_WITHDRAW(8) 每轮只 fire 一次（并行会签 3 条 doing 行也只一次）＋ 不补发 2', async () => {
    const { engine, repo } = setup()
    const fired = attachRecorder(engine)
    const facade = facadeOf(engine, repo)
    const defineId = await deploy(facade, '05-countersign-parallel.json')
    const instanceId = await start(facade, defineId, 'zhangsan')
    fired.length = 0
    assert.equal((await repo.findDoingTasks(instanceId)).length, 3, '夹具自证：3 条 doing 行')
    const r = await facade.flow('processInstance/withdraw', { id: instanceId, operator: 'zhangsan' })
    assert.equal(r.code, 0, JSON.stringify(r))
    // 本轮契约修正（非自证绿）：依据＝规范 11 §11.3 码 2「实例 state 落库为 20/45 这类『走到终点』
    // 的状态之后……**30(撤回)/40(终止) 不由本支表达**——各有专属码 8/9；一场撤回同时发 8＋2
    // 会让下游收到『流程已办结』的错通知」＋ 码 8「撤回只发 8，不补发 2」＋ 规范 08 场景 32
    // 「**撤回(30)/终止(40) 不发 2**，各发 8/9；同轮既发 8 又发 2 ⇒ 红」。
    // 故 withdraw 的期望序列从 [8,2] 改为 [8]——这是规范本身改判，不是为了让断言通过。
    assert.deepEqual(fired.map(e => e.type), [8], '撤回一轮＝只 fire 8 一支，不补发 2（场景 32/34），不逐任务 fire')
    assert.equal(fired[0].instanceId, instanceId)
    assert.equal(fired[0].operator, 'zhangsan')
    assert.equal(fired.filter(e => e.type === 2).length, 0, '撤回不得 fire PROCESS_INSTANCE_END(2)')
    assert.equal(fired.filter(e => e.type === 8).length, 1, '每轮撤回只 fire 一次 8')
  })

  it('场景 34 终止：notifyInstanceEnd 漏斗对 state=40 额外 fire INSTANCE_TERMINATED(9)（reason 出空串不省键）；20/30/45 档不发 9', async () => {
    const { engine, repo } = setup()
    const fired = attachRecorder(engine)
    const facade = facadeOf(engine, repo)
    const defineId = await deploy(facade, '01-simple.json')
    const instanceId = await start(facade, defineId, 'zhangsan')
    const inst = (await repo.findInstanceById(instanceId))!
    fired.length = 0
    inst.state = InstanceState.Interrupt
    await repo.updateInstance(inst)
    await engine.notifyInstanceEnd(inst, 'zhangsan')
    assert.deepEqual(fired.map(e => e.type), [2, 9], '终止：2(state=40) ＋ 9 各一支')
    assert.equal(fired[0].state, InstanceState.Interrupt)
    assert.equal(fired[1].instanceId, instanceId)
    assert.equal(fired[1].reason, '', 'reason 出空串而非省略整键（§11.3 必备键）')
    // 负向：其余终态档一律不发 9（多发即红）
    for (const state of [InstanceState.Done, InstanceState.Withdraw, InstanceState.Reject]) {
      fired.length = 0
      inst.state = state
      await repo.updateInstance(inst)
      await engine.notifyInstanceEnd(inst, 'zhangsan')
      assert.deepEqual(fired.map(e => e.type), [2], `state=${state} 只发 2，不发 9`)
      assert.equal(fired[0].state, state)
    }
  })

  it('场景 35 不发清单：定义生命周期（deploy/启停/删除）与抄送状态更新一律零 fire', async () => {
    const { engine, repo } = setup()
    const fired = attachRecorder(engine)
    const facade = facadeOf(engine, repo)
    const defineId = await deploy(facade, '01-simple.json')
    const instanceId = await start(facade, defineId, 'zhangsan')
    fired.length = 0
    const ops: Array<[string, Record<string, any>]> = [
      ['processDefine/deploy', { content: readFileSync(flowDir + '01-simple.json', 'utf-8') }],
      ['processDefine/upAndDown', { id: defineId, state: 0 }],
      ['processInstance/updateCCStatus', { processInstanceId: instanceId, operator: 'zhangsan' }],
      ['processDefine/remove', { id: defineId }],
    ]
    for (const [action, args] of ops) {
      const r = await facade.flow(action, args)
      assert.equal(r.code, 0, `${action}: ${JSON.stringify(r)}`)
    }
    assert.deepEqual(fired, [], '定义生命周期／变量与状态写入不构成独立事实（§11.4 第 2/3 条）')
  })

  it('场景 36 订阅形状：同一事件挂两个监听器都被调到；零注册时 fire 安全返回', async () => {
    const { engine, repo } = setup()
    const hitsA: number[] = []
    const hitsB: number[] = []
    engine.setExtensions({ listeners: [
      (e) => { hitsA.push(e.type) },
      (e) => { hitsB.push(e.type) },
    ] })
    const facade = facadeOf(engine, repo)
    await start(facade, await deploy(facade, '01-simple.json'), 'zhangsan')
    assert.ok(hitsA.length >= 3, `监听器 1 收到主链各支: ${hitsA}`)
    assert.deepEqual(hitsB, hitsA, '一次 fire 送给全部监听器，不得"后注册覆盖前注册"')
    // 零注册（从未 setExtensions）主流程照常跑完，fire 内部安全返回
    const bare = setup()
    const bareFacade = facadeOf(bare.engine, bare.repo)
    const bareInst = await start(bareFacade, await deploy(bareFacade, '01-simple.json'), 'zhangsan')
    assert.ok(bareInst, '无监听器时发起＋办理不炸')
    // 空数组监听器同样安全
    bare.engine.setExtensions({ listeners: [] })
    assert.ok(await start(bareFacade, await deploy(bareFacade, '02-multi-task.json'), 'zhangsan'),
      '空监听器数组时 fire 安全返回')
  })
})

// ═══ issues/139 · designRedeploy 解析失败的出口形状 ══════════════════════════════
// 判据源：jeeflow-hub `issues/139-….md`（owner 拍"修"）＋ `issues/121` 那轮定的口径——
//   出口只出逐字固定文案（code=99999999 ＋ 一句中文），内部码与内部异常细节都不进 msg。
// 逐字文案以 Java 参考实现为准：Java 的 processDesign/redeploy（JeeflowFacade.designRedeploy）
//   把内容交给 `ModelParser.parse(bytes)`，解析腿失败时抛
//   `RuntimeException("读取流程定义 JSON 失败", e)`（jeeflow-core ModelParser.java:47 ——
//   原始异常只作 cause，不拼进 message），门面顶层 catch 出 msg＝该句逐字原文；
//   C# 镜像同句（ModelParser.cs:45/54）。本栈改前拼的是 `String(e)` ⇒ msg 带 SyntaxError 文本。
// 反闸写法照 issues/121（单断 Contains 对"带前缀/带尾巴"是恒绿的，必须逐字等值＋逐项禁泄漏）。
describe('issues/139 designRedeploy JSON 解析失败：出口 msg 逐字等值且不含原始异常细节', () => {
  const PARSE_FAIL = '读取流程定义 JSON 失败'   // 逐字＝Java 参考实现原文，八栈可比对

  /** 夹具：设计稿有内容快照，但快照不是合法 JSON —— 正落在 designRedeploy 的解析腿上 */
  async function harness139(content: string) {
    const { engine, repo } = setup()
    const extRepo = new MemoryExtRepository()
    const facade = new JeeflowFacade(engine, repo, extRepo)
    const r0 = await facade.flow('processDesign/save',
      { name: 'bad139', displayName: '坏内容139', content, operator: 'zhangsan' })
    assert.equal(r0.code, 0, `前置：save 不校验内容合法性，坏 JSON 也该入库并回 id: ${JSON.stringify(r0)}`)
    assert.ok(r0.data.id, '前置：save 应回设计 id（否则下面 redeploy 打的是空 id）')
    assert.equal((await extRepo.listDesignHis(r0.data.id)).length, 1,
      '前置：内容快照已入库（redeploy 走的是"有快照但解析失败"那条腿，不是"没有内容"）')
    return { repo, extRepo, facade, designId: r0.data.id as string }
  }

  it('门面负向（截断 JSON）：code=99999999 + msg 逐字等值，异常类名/解析器文本/堆栈一律不在出口', async () => {
    const { facade, designId } = await harness139('{"name":"bad139","nodes":[')
    const r = await facade.flow('processDesign/redeploy', { id: designId, operator: 'zhangsan' })

    assert.equal(r.code, 99999999, `坏 JSON 重新部署必须被拒: ${JSON.stringify(r)}`)
    assert.equal(r.msg, PARSE_FAIL,
      `出口 msg 要逐字等值（改前拼 String(e) ⇒「流程定义 JSON 解析失败: SyntaxError: Unexpected end of JSON input」，本格即红）: ${r.msg}`)
    // 反闸：msg 里不得出现异常类名 / 解析器细节 / 堆栈痕迹 / 文件路径 / SQL / 内容片段
    for (const leak of ['Error', 'Syntax', 'Unexpected', 'position', 'JSON.parse', 'at ',
      '"nodes"', '{', '[', '/', '\\', '.json', 'SELECT', 'INSERT', 'undefined']) {
      assert.ok(!String(r.msg).includes(leak), `msg 不得含内部异常细节 ${JSON.stringify(leak)}: ${r.msg}`)
    }
  })

  it('门面负向（非法内容带片段）：同样逐字等值，msg 不得把设计稿片段透出来', async () => {
    // V8 对该串报 `Unexpected token 'S', ..."{"nodes":[SENTINEL_泄"... is not valid JSON`
    // ⇒ 拼 String(e) 的改法会把设计稿内容片段一起送出出口（信息泄漏面），本格钉住它。
    const { repo, extRepo, facade, designId } = await harness139('{"nodes":[SENTINEL_泄漏面_139]}')
    const r = await facade.flow('processDesign/redeploy', { id: designId, operator: 'zhangsan' })

    assert.equal(r.code, 99999999, `非法内容片段也必须被拒: ${JSON.stringify(r)}`)
    assert.equal(r.msg, PARSE_FAIL, `出口 msg 逐字等值: ${r.msg}`)
    assert.ok(!String(r.msg).includes('SENTINEL'), `msg 不得带内容片段哨兵串: ${r.msg}`)
    assert.ok(!String(r.msg).includes('"nodes"'), `msg 不得带设计稿 JSON 片段: ${r.msg}`)
    // 病灶不残留：解析失败排在任何写库之前 ⇒ 既没建新定义，也没把设计置成已部署
    assert.ok(!(await repo.findDefineByName('bad139')), '解析失败不得留下流程定义行')
    const design = await extRepo.findDesignById(designId)
    assert.equal(design?.isDeployed, 0, `被拒后设计仍是未部署(0): ${JSON.stringify(design)}`)
  })

  it('正向对照（合法设计稿内容）：redeploy 仍 code=0 出 processDefineId 且置已部署，防"改成无条件抛"', async () => {
    const good = readFileSync(flowDir + '01-simple.json', 'utf-8')
    const { repo, extRepo, facade, designId } = await harness139(good)
    const r = await facade.flow('processDesign/redeploy', { id: designId, operator: 'zhangsan' })
    assert.equal(r.code, 0, `正向：合法内容重新部署不得被新文案分支拦掉: ${JSON.stringify(r)}`)
    assert.equal(r.msg, '成功')
    assert.ok(r.data.processDefineId, '正向：出口仍出 processDefineId')
    assert.equal((await extRepo.findDesignById(designId))?.isDeployed, 1, '正向：设计置已部署(1)')
    assert.ok(await repo.findDefineById(String(r.data.processDefineId)), '正向：定义行确实落库')
  })

  it('同一条腿的另两处（processDefine/deploy 与 processDefine/redeploy）也用同一逐字文案，本栈不再三腿两样', async () => {
    const { engine, repo } = setup()
    const extRepo = new MemoryExtRepository()
    const facade = new JeeflowFacade(engine, repo, extRepo)

    // 腿 1：processDefine/deploy 直接吃 args.content（→ saveDeployedDefine 的解析分支）
    const r1 = await facade.flow('processDefine/deploy',
      { content: '{"name":"bad139legs","nodes":[', operator: 'zhangsan' })
    assert.equal(r1.code, 99999999, `deploy 腿坏 JSON 必须被拒: ${JSON.stringify(r1)}`)
    assert.equal(r1.msg, PARSE_FAIL, `deploy 腿 msg 逐字等值: ${r1.msg}`)

    // 先放一份合法定义，再走 processDefine/redeploy 的解析腿
    const good = readFileSync(flowDir + '01-simple.json', 'utf-8')
    const ok0 = await facade.flow('processDefine/deploy', { content: good, operator: 'zhangsan' })
    assert.equal(ok0.code, 0, `前置：合法内容部署成功才谈重新部署: ${JSON.stringify(ok0)}`)
    const r2 = await facade.flow('processDefine/redeploy',
      { processDefineId: ok0.data.processDefineId, content: '{"nodes":[SENTINEL_泄漏面_139]}', operator: 'zhangsan' })
    assert.equal(r2.code, 99999999, `redeploy 腿坏 JSON 必须被拒: ${JSON.stringify(r2)}`)
    assert.equal(r2.msg, PARSE_FAIL, `redeploy 腿 msg 逐字等值: ${r2.msg}`)
    assert.ok(!r2.msg.includes('SENTINEL'), `redeploy 腿不得把内容片段透出去: ${r2.msg}`)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// issues/141 G1「抄送分页归属条件必填」
// 判据源＝jeeflow-doc/docs/spec/06-facade.md §2.5「抄送分页同一条尺子（owner 2026-09-29 拍）」
// 行为基准＝jeeflow-java 3d1fc98 的 CcPageOwnershipTest（内存仓一路）
//          ＋ JdbcCcOwnershipIdempotentTest 的 G1 四格（SQL 仓一路）——两仓每一格读数必须相等
//          （issues/117 场景 27 那把尺子从 todo/done 扩到 ccList）。
// 本栈形状差异：java 的归属证据只有 `cc.actor_id` 条件一条腿；本栈门面把归属作为**位置参**下发
// （与 pageInstances/pageTodoTasks/pageDoneTasks 同形），conditions 是第二条腿 ⇒ 判据合成
// `hasEffectiveCcOwnership`，两仓共用同一份实现，不给分叉留余地。
// ─────────────────────────────────────────────────────────────────────────────

describe('issues/141 G1 抄送分页归属条件必填：cc.actor_id 无有效条件 ⇒ 空页（内存仓＋SQL 仓同判据）', () => {
  const ME = 'user1'
  const OTHER = 'user2'

  /** 两条 cc 行各占一个实例（ME / OTHER 各一条）：不引引擎，直连仓储把格钉在分页判据上。 */
  async function fixtureG1() {
    const { engine, repo } = setup()
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
    const r0 = await facade.flow('processDefine/deploy', { content: readFileSync(flowDir + '01-simple.json', 'utf-8') })
    assert.equal(r0.code, 0, JSON.stringify(r0))
    const mine = await facade.flow('processInstance/startAndExecute',
      { processDefineId: r0.data.processDefineId, operator: 'zhangsan', businessNo: 'CC141-MINE' })
    assert.equal(mine.code, 0, JSON.stringify(mine))
    const theirs = await facade.flow('processInstance/startAndExecute',
      { processDefineId: r0.data.processDefineId, operator: 'zhaoliu', businessNo: 'CC141-THEIRS' })
    assert.equal(theirs.code, 0, JSON.stringify(theirs))
    await repo.createCcInstance(String(mine.data.processInstanceId), 'zhangsan', ME)
    await repo.createCcInstance(String(theirs.data.processInstanceId), 'zhangsan', OTHER)
    return { repo, facade, mine: String(mine.data.processInstanceId), theirs: String(theirs.data.processInstanceId) }
  }

  /**
   * 判据表（java 的三档逐字照抄：缺条件⇒空页、空值三形＋空集合⇒空页、非归属列空值仍忽略）。
   * `rows` 字段＝内存仓该档的期望读数；`sqlShortCircuits`＝SQL 仓该档必须在**取连接之前**短路。
   */
  const TABLE: Array<{ tag: string; actor: any; conds?: any[]; rows: number; sqlShortCircuits: boolean }> = [
    // ① 条件整条没给（java `pageCcInstances(new PageQuery())` 那一档）
    { tag: '位置参缺省（undefined）', actor: undefined, rows: 0, sqlShortCircuits: true },
    { tag: '位置参 null', actor: null, rows: 0, sqlShortCircuits: true },
    // ② 空值三形（issues/129 已钉，此处与新增档同表复跑，防止改动面把旧档漏回去）
    { tag: '位置参空串', actor: '', rows: 0, sqlShortCircuits: true },
    { tag: '位置参全空白', actor: '   ', rows: 0, sqlShortCircuits: true },
    { tag: '位置参制表/换行空白', actor: '\t\n', rows: 0, sqlShortCircuits: true },
    // ②+ G1 新收的一档：空集合＝「谁都没有」，与空串同档（改前内存仓 [].trim() 直接抛、SQL 仓带数组下库）
    { tag: '位置参空集合 []（＝谁都没有）', actor: [], rows: 0, sqlShortCircuits: true },
    // ③ 条件腿（conditions）打在归属列上的空值：一律空页，不得折叠成"这条不加"
    { tag: '条件 cc.actor_id EQ 空串', actor: ME, conds: [{ column: 'cc.actor_id', operator: 'EQ', value: '' }], rows: 0, sqlShortCircuits: true },
    { tag: '条件 cc.actor_id EQ 全空白', actor: ME, conds: [{ column: 'cc.actor_id', operator: 'EQ', value: '   ' }], rows: 0, sqlShortCircuits: true },
    { tag: '条件 cc.actor_id EQ null', actor: ME, conds: [{ column: 'cc.actor_id', operator: 'EQ', value: null }], rows: 0, sqlShortCircuits: true },
    { tag: '条件 cc.actor_id EQ 空集合', actor: ME, conds: [{ column: 'cc.actor_id', operator: 'EQ', value: [] }], rows: 0, sqlShortCircuits: true },
    { tag: '条件 cc.actor_id IN 空集合（java「空 IN ⇒ 空页」）', actor: ME, conds: [{ column: 'cc.actor_id', operator: 'IN', value: [] }], rows: 0, sqlShortCircuits: true },
    { tag: '条件 cc.actor_id LIKE 空串', actor: ME, conds: [{ column: 'cc.actor_id', operator: 'LIKE', value: '' }], rows: 0, sqlShortCircuits: true },
    { tag: '条件 cc.actor_id NE 空集合', actor: ME, conds: [{ column: 'cc.actor_id', operator: 'NE', value: [] }], rows: 0, sqlShortCircuits: true },
    // ④ 正向对照（证明"空页"不是无条件返空）
    { tag: '正向 · 有效位置参归属', actor: ME, rows: 1, sqlShortCircuits: false },
    // ⑤ 哨兵：只收归属列——非归属列（可选过滤）空值仍按"没填"忽略
    { tag: '哨兵 · 非归属列 t.business_no LIKE 空串仍被忽略', actor: ME, conds: [{ column: 't.business_no', operator: 'LIKE', value: '' }], rows: 1, sqlShortCircuits: false },
    { tag: '哨兵 · 非归属列 pd.name EQ null 仍被忽略', actor: ME, conds: [{ column: 'pd.name', operator: 'EQ', value: null }], rows: 1, sqlShortCircuits: false },
  ]

  /** SQL 仓的 T0 探针：空页档必须在**取连接之前**短路；非空页档必须真去取连接（这才证明短路是真的）。 */
  function probeRepo() {
    const noConn: any = {
      placeholder: '?',
      acquire() { throw new Error('PROBE_ACQUIRE') },
      release() { throw new Error('PROBE_RELEASE') },
    }
    return new JdbcRepository(noConn)
  }

  it('内存仓 · 判据表逐档：空值三形＋空集合＋条件腿空值 ⇒ 空页；正向与可选过滤哨兵不被改坏', async () => {
    const f = await fixtureG1()
    for (const t of TABLE) {
      const page = await f.repo.pageCcInstances(1, 50, t.actor as any, t.conds)
      assert.equal(page.rows.length, t.rows,
        `${t.tag}：内存仓读数应为 ${t.rows} 行，实读 ${page.rows.length} ⇒ 空归属又退化成"这条不加"了`)
      assert.equal(page.total, t.rows, `${t.tag}：total 与 rows 同口径（空页时 total 也要归 0）`)
    }
    // 别人的归属档同样只出别人的（判据没把过滤做成"永远空"）
    assert.equal((await f.repo.pageCcInstances(1, 50, OTHER)).total, 1, 'OTHER 档照旧出他自己的 1 行')
    assert.equal((await f.repo.pageCcInstances(1, 50, 'nosuchuser')).total, 0, '谁都不是 ⇒ 空页（对照组）')
  })

  it('SQL 仓 · 同一张判据表逐档同答案（空归属短路在取连接之前，非空归属照常下查询）', async () => {
    const p = probeRepo()
    for (const t of TABLE) {
      if (t.sqlShortCircuits) {
        const page = await p.pageCcInstances(1, 50, t.actor as any, t.conds)
        assert.deepEqual(page, { rows: [], total: 0 },
          `${t.tag}：SQL 仓必须与内存仓同答案（空页），实读 ${JSON.stringify(page)}`)
      } else {
        // 反闸：非空归属档要真去取连接 ⇒ 上面那批"空页"断言不是探针本身失灵
        await assert.rejects(() => p.pageCcInstances(1, 50, t.actor as any, t.conds), /PROBE_ACQUIRE/,
          `${t.tag}：SQL 仓该档不该被空页短路吃掉（正向/哨兵档必须下查询）`)
      }
    }
  })

  it('两仓同答案 · 空页与"没短路"的档位划分逐档一致（判据只有一份实现）', async () => {
    const f = await fixtureG1()
    const p = probeRepo()
    for (const t of TABLE) {
      const mem = await f.repo.pageCcInstances(1, 50, t.actor as any, t.conds)
      let sqlEmpty: boolean
      try {
        const page = await p.pageCcInstances(1, 50, t.actor as any, t.conds)
        sqlEmpty = page.rows.length === 0 && page.total === 0
      } catch (e) {
        sqlEmpty = false // 取了连接＝没短路
      }
      const memEmpty = mem.rows.length === 0 && mem.total === 0
      assert.equal(sqlEmpty, memEmpty,
        `${t.tag}：同一份数据两仓必须同结论（内存 ${memEmpty ? '空页' : '出行'} / SQL ${sqlEmpty ? '空页' : '下查询'}）`)
    }
  })

  it('门面一路不受影响：ccList 空 operator 仍按 issues/129 回落缺省 user1，m_LIKE_* 空串仍当"没填"', async () => {
    const f = await fixtureG1()
    const blank = await f.facade.flow('processInstance/ccList', { operator: '', pageSize: 50 })
    assert.equal(blank.code, 0, JSON.stringify(blank))
    assert.equal(blank.data.rows.length, 1, `空 operator 回落 user1 ⇒ 1 行（不是空页、也不是全库）: ${JSON.stringify(blank.data)}`)
    const viaM = await f.facade.flow('processInstance/ccList', { operator: ME, pageSize: 50, m_LIKE_businessNo: '' })
    assert.equal(viaM.code, 0, JSON.stringify(viaM))
    assert.equal(viaM.data.rows.length, 1, 'm_LIKE_businessNo 传空串仍按"没填"忽略（可选放行未被 G1 改坏）')
    // 绕过门面的归属列条件（m_<别名>_<操作符>_<字段> ⇒ `m_cc_EQ_actorId`；空串被 parseMQuery 丢掉，
    // 全空白则真会下发）⇒ 仓储这层必须自己顶住
    const dirty = await f.facade.flow('processInstance/ccList', { operator: ME, pageSize: 50, m_cc_EQ_actorId: '   ' })
    assert.equal(dirty.code, 0, JSON.stringify(dirty))
    assert.equal(dirty.data.rows.length, 0, '归属列上空白条件 ⇒ 空页，不得退化成"这条不加"出全部实例')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// issues/141 G2「抄送写侧判重＝幂等空操作」
// 判据源＝jeeflow-doc/docs/spec/06-facade.md §4 ＋ spec 11 §11.2 原则 1「码值表达发生了什么事实」
//        ＋ §11.7「三条入口共用一支」。行为基准＝jeeflow-java 3d1fc98 的 CcWriteIdempotentTest
//        （内存仓一路 ＋ 引擎/门面两条腿）＋ JdbcCcOwnershipIdempotentTest 的 G2 六格（SQL 仓一路）。
// 四档逐字：同一 (instanceId, actorId) 已有 cc 行时 ①不新增行 ②不重置未读状态 ③不更新原行时间
// ④不 fire CC_CREATE（码 4）；逐人 fire 的入参换成"实际新建的子集"，子集为空整支不 fire。
// 查询侧不加 DISTINCT、历史重复行不清理（owner 拍为接受既成事实）⇒ 这里只钉写侧。
// ─────────────────────────────────────────────────────────────────────────────

describe('issues/141 G2 抄送写侧判重＝幂等空操作：①不新增行 ②不重置未读 ③不刷原行时间 ④不发码 4（子集才 fire）', () => {
  /** 让"原行时间被刷新"与"没被刷新"在断言上分得开（Date 毫秒精度，java 侧同款 tick）。 */
  const tick = async () => { await new Promise<void>(r => setTimeout(r, 12)) }

  /** 内存仓一路的夹具：引擎＋门面＋只收 CC_CREATE 的事件 sink。 */
  function harnessG2() {
    const { engine, repo } = setup()
    const fired: ProcessEvent[] = []
    engine.setExtensions({ listeners: [(e) => { if (e.type === EventType.CcCreate) fired.push({ ...e }) }] })
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
    return { engine, repo, facade, fired }
  }
  async function defineOf(facade: JeeflowFacade): Promise<string> {
    const r = await facade.flow('processDefine/deploy', { content: readFileSync(flowDir + '01-simple.json', 'utf-8') })
    assert.equal(r.code, 0, JSON.stringify(r))
    return String(r.data.processDefineId)
  }
  async function startG2(facade: JeeflowFacade, defineId: string, operator = 'zhangsan', extra: Record<string, any> = {}) {
    const r = await facade.flow('processInstance/startAndExecute', { processDefineId: defineId, operator, ...extra })
    assert.equal(r.code, 0, JSON.stringify(r))
    return String(r.data.processInstanceId)
  }
  async function manualCc(facade: JeeflowFacade, instanceId: string, ...actorIds: string[]) {
    const r = await facade.flow('processInstance/createCCInstance',
      { processInstanceId: instanceId, operator: 'zhangsan', actorIds })
    assert.equal(r.code, 0, `手动抄送应成功: ${JSON.stringify(r)}`)
  }
  const actorIdsOf = (events: ProcessEvent[]) => events.map(e => e.ccActorId)
  /** 行快照＝纯值拷贝（拿引用比时间会被"就地改字段"这种假修糊过去）。 */
  const rowsOf = (repo: MemoryRepository, instanceId: string) =>
    repo.ccRowsForTest(instanceId).map(r => ({ actorId: r.actorId, state: r.state, ct: r.createTime.getTime(), ut: r.updateTime.getTime() }))

  // ═══ 正向对照：全新的一次抄送照旧建行＋逐人 fire ═══

  it('正向对照 · 首轮全新抄送照旧逐人建行、逐人 fire 码 4，新行是未读（state=0）', async () => {
    const { repo, facade, fired } = harnessG2()
    const instanceId = await startG2(facade, await defineOf(facade))
    fired.length = 0
    await manualCc(facade, instanceId, '6101', '6102')

    assert.deepEqual(await repo.findCcActorIds(instanceId), ['6101', '6102'], '全新抄送应逐人落行')
    assert.equal(fired.length, 2, `全新抄送应逐人 fire（码 4），实收 ${fired.length}`)
    assert.deepEqual(actorIdsOf(fired), ['6101', '6102'], 'ccActorId 顺序与入参一致')
    assert.deepEqual([...new Set(fired.map(e => e.type))], [4], 'fire 的是码 4（CC_CREATE）而不是别的码')
    for (const e of fired) assert.equal(e.instanceId, instanceId, '码 4 的 sourceId 应为 instanceId')
    assert.deepEqual(rowsOf(repo, instanceId).map(r => r.state), [0, 0], '新行应是未读（state=0）')
  })

  // ═══ 四档：重复抄送是幂等空操作 ═══

  it('①不新增行 ＋ ④不发码 4 · 手动腿连发两次同一个人（没发生创建就不得发事件）', async () => {
    const { repo, facade, fired } = harnessG2()
    const instanceId = await startG2(facade, await defineOf(facade))
    await manualCc(facade, instanceId, '6201')
    assert.deepEqual(await repo.findCcActorIds(instanceId), ['6201'], '首次抄送落 1 行')
    assert.equal(fired.length, 1, '首次抄送 fire 1 次')

    fired.length = 0
    await tick()
    await manualCc(facade, instanceId, '6201')

    assert.deepEqual(await repo.findCcActorIds(instanceId), ['6201'], '①重复抄送不得新增行')
    assert.equal(rowsOf(repo, instanceId).length, 1, '①重复抄送后行数仍是 1')
    assert.equal(fired.length, 0, '④没发生"创建"就不得发码 4（spec 11.2 原则 1「码=事实」）')
  })

  it('②不重置未读 · 先置已读（state=1），重复抄送不得把已读抹回未读', async () => {
    const { repo, facade } = harnessG2()
    const instanceId = await startG2(facade, await defineOf(facade))
    await manualCc(facade, instanceId, '6301')
    const read = await facade.flow('processInstance/updateCCStatus', { processInstanceId: instanceId, operator: '6301' })
    assert.equal(read.code, 0, `已读应成功: ${JSON.stringify(read)}`)
    assert.equal(rowsOf(repo, instanceId)[0].state, 1, '置读后 state 应为 1（这条腿本身要能测出来）')

    await tick()
    await manualCc(facade, instanceId, '6301')

    assert.equal(rowsOf(repo, instanceId)[0].state, 1, '②重复抄送不得把已读抹回未读（不产生"再提醒一次"语义）')
    assert.equal(rowsOf(repo, instanceId).length, 1, '①顺带：仍是那一行')
  })

  it('③不更新原行时间 · 重复抄送后 createTime/updateTime 逐字不变', async () => {
    const { repo, facade } = harnessG2()
    const instanceId = await startG2(facade, await defineOf(facade))
    await manualCc(facade, instanceId, '6401')
    const before = rowsOf(repo, instanceId)[0]
    assert.ok(before.ct > 0 && before.ut > 0, `前置：原行两个时间都该有值: ${JSON.stringify(before)}`)

    await tick()
    await manualCc(facade, instanceId, '6401')

    const after = rowsOf(repo, instanceId)[0]
    assert.equal(after.ct, before.ct, '③重复抄送不得刷新原行 createTime')
    assert.equal(after.ut, before.ut, '③重复抄送不得刷新原行 updateTime')
  })

  it('④子集档 · 第二次给「已知人＋新人」⇒ 只为新人建行、事件里只出现新人', async () => {
    const { repo, facade, fired } = harnessG2()
    const instanceId = await startG2(facade, await defineOf(facade))
    await manualCc(facade, instanceId, '6501', '6502')
    assert.equal(fired.length, 2, '首轮 fire 2 次')

    fired.length = 0
    await tick()
    await manualCc(facade, instanceId, '6501', '6503')

    assert.deepEqual(actorIdsOf(fired), ['6503'], '逐人 fire 的入参应是**实际新建的子集**，不是原始请求')
    assert.equal(fired.length, 1, '子集只有 1 人 ⇒ 只 fire 1 次')
    assert.deepEqual(await repo.findCcActorIds(instanceId), ['6501', '6502', '6503'], '实际新建的 cc 行也只有那一行')
  })

  it('同一次调用内的重复折叠 · 仓储直连返回去重子集，门面两形态各只落一行一次', async () => {
    const { repo, facade, fired } = harnessG2()
    const instanceId = await startG2(facade, await defineOf(facade))

    // 直连仓储：入参里就带重复
    const created = await repo.createCcInstanceIfAbsent!(instanceId, 'zhangsan', '6601', '6601', '6602')
    assert.deepEqual(created, ['6601', '6602'], '返回的子集必须折掉同一次调用内的重复')
    assert.deepEqual(await repo.findCcActorIds(instanceId), ['6601', '6602'], '同人同实例只落一行')

    fired.length = 0
    // 逗号串形态（toStringList2 按逗号切 ＋ parseCcActors 再折一层）
    const r1 = await facade.flow('processInstance/createCCInstance',
      { processInstanceId: instanceId, operator: 'zhangsan', actorIds: '6603,6603' })
    assert.equal(r1.code, 0, JSON.stringify(r1))
    assert.equal(fired.length, 1, `同一次调用内的重复只 fire 一次，实收 ${JSON.stringify(actorIdsOf(fired))}`)
    assert.deepEqual(actorIdsOf(fired), ['6603'])
    // 数组形态（逐元素）里带重复，判重同一条
    fired.length = 0
    const r2 = await facade.flow('processInstance/createCCInstance',
      { processInstanceId: instanceId, operator: 'zhangsan', actorIds: ['6603', '6604', '6604'] })
    assert.equal(r2.code, 0, JSON.stringify(r2))
    assert.deepEqual(actorIdsOf(fired), ['6604'], '数组形态里的重复同样折叠')
    assert.deepEqual(await repo.findCcActorIds(instanceId), ['6601', '6602', '6603', '6604'])
  })

  it('f_ 与 tf_ 两腿共用同一条判重 · 发起腿已抄的人在办理腿不建行不 fire，新人照旧', async () => {
    const { repo, facade, fired } = harnessG2()
    const defineId = await defineOf(facade)
    const instanceId = await startG2(facade, defineId, 'zhangsan', { f_ccActors: '7001' })
    assert.deepEqual(actorIdsOf(fired), ['7001'], '发起腿 fire 1 次')
    assert.deepEqual(await repo.findCcActorIds(instanceId), ['7001'], '发起腿落 1 行')

    fired.length = 0
    await tick()
    const task = (await repo.findDoingTasks(instanceId))[0]
    const r = await facade.flow('processTask/execute', {
      processTaskId: task.id, operator: 'leader', submitType: SubmitType.Agree, tf_ccActors: '7001,7002',
    })
    assert.equal(r.code, 0, JSON.stringify(r))

    assert.deepEqual(await repo.findCcActorIds(instanceId), ['7001', '7002'], '办理腿只为新人 7002 建行（7001 已有行）')
    assert.deepEqual(actorIdsOf(fired), ['7002'], '办理腿只 fire 实际新建的子集（两腿共用判据，spec §11.7）')
  })

  it('逗号串与数组两形态等价 · 混用也走同一条判重腿', async () => {
    const { repo, facade, fired } = harnessG2()
    const defineId = await defineOf(facade)
    const instanceId = await startG2(facade, defineId, 'zhangsan', { f_ccActors: ['7101', '7102'] })
    assert.deepEqual(await repo.findCcActorIds(instanceId), ['7101', '7102'], '集合形态照旧逐人建行')
    assert.equal(fired.length, 2, '集合形态照旧逐人 fire')

    fired.length = 0
    await tick()
    const task = (await repo.findDoingTasks(instanceId))[0]
    await facade.flow('processTask/execute', {
      processTaskId: task.id, operator: 'leader', submitType: SubmitType.Agree, tf_ccActors: '7101, 7103 ,',
    })

    assert.deepEqual(await repo.findCcActorIds(instanceId), ['7101', '7102', '7103'], '逗号串形态与集合形态判重同一条')
    assert.deepEqual(actorIdsOf(fired), ['7103'], '两形态混用也只为新人 fire（空项照旧丢弃）')
  })

  it('反向哨兵 · 判重作用域按实例不按全局：不同实例上的同一个人各自建行各 fire', async () => {
    const { repo, facade, fired } = harnessG2()
    // 两个实例 id 直接给定（不走 startAndExecute）：setup() 的 idGen 是"毫秒 × 1000 ＋ 随机三位"，
    // 同一毫秒连起两单有 ~1‰ 撞号，会把这格的 notEqual 前置打成偶发红。判重作用域只看 cc 行的
    // (实例, 人) 二元组，实例是否真存在与本案无关（门面腿只校 id 形状）。
    const first = '1410000000000001'
    const second = '1410000000000002'
    fired.length = 0

    await manualCc(facade, first, '6701')
    await tick()
    await manualCc(facade, second, '6701')

    assert.deepEqual(await repo.findCcActorIds(first), ['6701'], '实例一应有自己的 cc 行')
    assert.deepEqual(await repo.findCcActorIds(second), ['6701'], '实例二不受实例一影响，同一个人照样建行')
    assert.equal(fired.length, 2, '两个实例各 fire 一次（判重不得做成全局判重）')
    assert.deepEqual(fired.map(e => e.instanceId), [first, second], '事件按各自的实例 id 发出')
  })

  // ═══ 第三方仓储的兼容形状（java 的 interface default 在 TS 里的对应物） ═══

  it('未实现判重 SPI 的第三方仓储 ⇒ 旧行为逐字不变（全量建行 ＋ 全量 fire）', async () => {
    const calls: string[][] = []
    const legacyRepo: any = {
      async createCcInstance(_id: string, _creator: string, ...actors: string[]) { calls.push(actors) },
    }
    const fired: ProcessEvent[] = []
    const engine = new EngineImpl(legacyRepo)
    engine.setExtensions({ listeners: [(e) => { fired.push({ ...e }) }] })

    const created = await engine.handleCcActors('88001', 'zhangsan', 'a,b')
    assert.deepEqual(calls, [['a', 'b']], '未实现 findCcActorIds ⇒ 既有行视作空集 ⇒ 全量插入（与旧 createCcInstance 逐字一致）')
    assert.deepEqual(created, ['a', 'b'], '返回全量（没有判重依据时不静默改变既有集成方行为）')
    assert.deepEqual(actorIdsOf(fired), ['a', 'b'], 'fire 照旧逐人一次')
  })

  it('第三方只实现 findCcActorIds ⇒ 判重照样生效（读侧驱动，与内置两仓同一条 default 腿）', async () => {
    const calls: string[][] = []
    const existing = ['a']
    const partialRepo: any = {
      async createCcInstance(_id: string, _creator: string, ...actors: string[]) { calls.push(actors); existing.push(...actors) },
      async findCcActorIds() { return [...existing] },
    }
    const engine = new EngineImpl(partialRepo)

    const created = await engine.handleCcActors('88002', 'zhangsan', 'a,b')
    assert.deepEqual(calls, [['b']], '已有行里的 a 不再插第二行')
    assert.deepEqual(created, ['b'], '返回实际新建的子集')
  })

  // ═══ SQL 仓一路（T0 假适配器：只装 cc 写侧三条语句，不连任何数据库） ═══

  /**
   * 假适配器：内存里养一张 `wf_process_cc_instance`，逐条记录执行过的语句。
   * 断言直接查这张表的真实行（只看返回值不作数），并借语句流水钉住
   * "跳过式判重既不 UPDATE 原行、也不重插"（②③档在 SQL 仓的证据形态）。
   */
  function ccTableRepo() {
    const rows: Array<Record<string, any>> = []
    const stmts: Array<{ sql: string; args: any[] }> = []
    const byInstance = (instanceId: any) =>
      rows.filter(r => String(r.process_instance_id) === String(instanceId))
        .slice().sort((a, b) => Number(a.id) - Number(b.id))
    const conn: any = {
      async execute(sql: string, args: any[]) {
        stmts.push({ sql, args })
        if (/^INSERT INTO wf_process_cc_instance/.test(sql)) {
          rows.push({
            id: args[0], process_instance_id: args[1], actor_id: args[2], state: 0,
            create_time: args[3], create_user: args[4], update_time: args[5], update_user: args[6],
          })
          return
        }
        if (/^UPDATE wf_process_cc_instance SET state=1/.test(sql)) {
          for (const r of byInstance(args[1])) if (String(r.actor_id) === String(args[2])) { r.state = 1; r.update_time = args[0] }
          return
        }
        throw new Error(`假适配器收到未预期语句: ${sql}`)
      },
      async fetchAll(sql: string, args: any[]) {
        stmts.push({ sql, args })
        if (/^SELECT actor_id FROM wf_process_cc_instance/.test(sql)) {
          return byInstance(args[0]).map(r => ({ actor_id: r.actor_id }))
        }
        if (/FROM wf_process_instance t/.test(sql)) return [] // 分页取数：形状断言用，行内容不在本案范围
        throw new Error(`假适配器收到未预期语句: ${sql}`)
      },
      async fetchOne(sql: string, args: any[]) {
        stmts.push({ sql, args })
        if (/SELECT COUNT\(\*\)/.test(sql)) return { cnt: rows.filter(r => String(r.actor_id) === String(args[0])).length }
        throw new Error(`假适配器收到未预期语句: ${sql}`)
      },
      async begin() {}, async commit() {}, async rollback() {},
    }
    const adapter: any = { placeholder: '?', async acquire() { return conn }, async release() {} }
    return { repo: new JdbcRepository(adapter), rows, stmts, byInstance }
  }
  const insertStmts = (stmts: Array<{ sql: string }>) => stmts.filter(s => /^INSERT INTO wf_process_cc_instance/.test(s.sql))
  const updateStmts = (stmts: Array<{ sql: string }>) => stmts.filter(s => /^UPDATE wf_process_cc_instance/.test(s.sql))

  it('SQL 仓 · findCcActorIds 读的是真实行集（判重的依据不能是内存猜测）', async () => {
    const { repo } = ccTableRepo()
    assert.deepEqual(await repo.findCcActorIds!('900001'), [], '空实例没有 cc 行')
    await repo.createCcInstance('900001', 'zhangsan', '8601', '8602')
    assert.deepEqual(await repo.findCcActorIds!('900001'), ['8601', '8602'], '两行两个人')
    await repo.createCcInstance('900001', 'zhangsan', '8601', '8603')
    assert.deepEqual(await repo.findCcActorIds!('900001'), ['8601', '8602', '8603'], '重复的 8601 不新增')
  })

  it('SQL 仓 · ①不新增行 ＋ ④子集：createCcInstanceIfAbsent 只插新人并只回新人', async () => {
    const { repo, rows, stmts } = ccTableRepo()
    const first = await repo.createCcInstanceIfAbsent!('900002', 'zhangsan', '8201', '8202')
    assert.deepEqual(first, ['8201', '8202'], '首轮全新 ⇒ 子集＝全量')
    assert.equal(insertStmts(stmts).length, 2, '首轮两条 INSERT')

    const before = stmts.length
    const again = await repo.createCcInstanceIfAbsent!('900002', 'zhangsan', '8201', '8503')
    assert.deepEqual(again, ['8503'], '返回的必须是实际新建的子集（引擎拿它去 fire）')
    assert.equal(insertStmts(stmts.slice(before)).length, 1, '重复的 8201 不得再插一行')
    assert.equal(rows.length, 3, `库里总共 3 行，实读 ${rows.length}`)
    assert.deepEqual(await repo.findCcActorIds!('900002'), ['8201', '8202', '8503'])
  })

  it('SQL 仓 · ②不重置未读 ＋ ③不刷原行时间：跳过式判重既不 UPDATE 也不重插', async () => {
    const { repo, rows, stmts, byInstance } = ccTableRepo()
    await repo.createCcInstance('900003', 'zhangsan', '8401')
    await repo.updateCcStatus('900003', '8401')
    assert.equal(byInstance('900003')[0].state, 1, '置读后 state=1')
    const ct = byInstance('900003')[0].create_time as Date
    const ut = byInstance('900003')[0].update_time as Date
    assert.ok(ct instanceof Date && ut instanceof Date, `前置：原行两个时间都该有值: ${JSON.stringify(byInstance('900003'))}`)

    const before = { inserts: insertStmts(stmts).length, updates: updateStmts(stmts).length }
    await repo.createCcInstance('900003', 'zhangsan', '8401')
    await repo.createCcInstanceIfAbsent!('900003', 'zhangsan', '8401')

    assert.equal(insertStmts(stmts).length, before.inserts, '①重复抄送一条 INSERT 都不该多发')
    assert.equal(updateStmts(stmts).length, before.updates, '②③跳过式判重不走 UPDATE ⇒ 未读状态与原行时间无从被动')
    assert.equal(rows.length, 1, '①库里仍是那一行')
    assert.equal(byInstance('900003')[0].state, 1, '②重复抄送不得把已读抹回未读')
    assert.equal(byInstance('900003')[0].create_time, ct, '③create_time 逐字不变')
    assert.equal(byInstance('900003')[0].update_time, ut, '③update_time 逐字不变')
  })

  it('SQL 仓 · 改动面不外溢：查询侧仍 LEFT JOIN 不带 DISTINCT，写侧不发 DELETE（历史重复行不清理）', async () => {
    const { repo, stmts, rows } = ccTableRepo()
    await repo.createCcInstance('900004', 'zhangsan', '8701')
    await repo.pageCcInstances(1, 10, '8701')

    const page = stmts.filter(s => /FROM wf_process_instance t/.test(s.sql))
    assert.ok(page.length >= 1, '分页应下查询（COUNT ＋ 取数两条）')
    for (const s of page) {
      assert.ok(/LEFT JOIN wf_process_cc_instance cc/.test(s.sql), `查询侧 join 形状不动: ${s.sql}`)
      assert.ok(!/DISTINCT/i.test(s.sql), `判重在写侧，查询侧不得引入 DISTINCT（owner 2026-09-29 拍）: ${s.sql}`)
    }
    assert.equal(stmts.filter(s => /DELETE FROM wf_process_cc_instance/.test(s.sql)).length, 0,
      '历史重复行不清理 ⇒ 写侧不得出现 DELETE')
    assert.equal(rows.length, 1)
    // 手动构造历史重复行（绕过写侧判重直接落两行）⇒ 查询侧原样出行、不去重
    rows.push({ id: 2, process_instance_id: '900004', actor_id: '8701', state: 0, create_time: new Date(), create_user: 'x', update_time: new Date(), update_user: 'x' })
    assert.deepEqual(await repo.findCcActorIds!('900004'), ['8701', '8701'], 'findCcActorIds 也不加 DISTINCT：重复行原样返回')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// issues/141 G10「空抄送人不建 cc 行」（owner 2026-09-29 拍：「空不创建行」）
// 判据源＝jeeflow-doc/docs/spec/06-facade.md §2.10。行为基准＝jeeflow-java 5fbd5ac
// （CcBlankActorDroppedTest 13 格 ＋ JdbcCcOwnershipIdempotentTest 的 G10 六格）。
// 四条实现要求逐条钉住：
//   ① 三条入口（发起 f_ccActors／办理 tf_ccActors／门面手动 createCCInstance）解析抄送人集合时
//      空串、纯空白、数组里的空元素一律丢弃；丢完为空 ⇒ 不建任何 cc 行、也不 fire CC_CREATE(4)；
//      逗号串与数组两种形态同判据（只修一条腿正是本条要抓的形状）。
//   ② 两层都挡——漏斗层（engine.handleCcActors／parseCcActors）＋ 写侧层（两仓 createCcInstance
//      ＋ spi.defaultCreateCcInstanceIfAbsent）。只修漏斗，绕过门面/引擎直连仓储的调用方照样灌空值。
//   ③ 落库与比较一律取 trim 后的值：" 123 " 与 "123" 是同一个人（不 trim 就把 G2 的写侧判重打穿）。
//   ④ 反向哨兵："0" 这类"看起来像空"的正常 id 不得被当空值丢掉；手动腿丢完为空与本仓既有的
//      "空 actorIds"档同判（沿用 'actorIds 缺失' 文案，不新造错误码/文案）。
// node 侧的旧形状与 java 不同：漏斗 parseCcActors 本就丢空（没有 `"".split(",")` 得一空元素的洞），
// 洞在**手动腿的 toStringList2**（`v.map(String)` 把 null 变成字面量 "null" 的假归属人）与
// **两仓写侧＋spi default**（只挡 null，空串/纯空白/未 trim 一律放行）——G10 收的就是这两处。
// ─────────────────────────────────────────────────────────────────────────────

describe('issues/141 G10 空抄送人不建 cc 行：空串/纯空白/数组空元素一律丢弃 ⇒ 不建行、不 fire 码 4（三入口＋两仓同判据）', () => {
  /** 内存仓一路夹具：引擎＋门面＋只收 CC_CREATE 的事件 sink（与 G2 块同款，互不串味）。 */
  function harnessG10() {
    const { engine, repo } = setup()
    const fired: ProcessEvent[] = []
    engine.setExtensions({ listeners: [(e) => { if (e.type === EventType.CcCreate) fired.push({ ...e }) }] })
    const facade = new JeeflowFacade(engine, repo, new MemoryExtRepository())
    return { engine, repo, facade, fired }
  }
  const firedIds = (events: ProcessEvent[]) => events.map(e => e.ccActorId)

  async function defineOf10(facade: JeeflowFacade): Promise<string> {
    const r = await facade.flow('processDefine/deploy', { content: readFileSync(flowDir + '01-simple.json', 'utf-8') })
    assert.equal(r.code, 0, JSON.stringify(r))
    return String(r.data.processDefineId)
  }
  async function start10(facade: JeeflowFacade, defineId: string, extra: Record<string, any> = {}): Promise<string> {
    const r = await facade.flow('processInstance/startAndExecute', { processDefineId: defineId, operator: 'zhangsan', ...extra })
    assert.equal(r.code, 0, JSON.stringify(r))
    return String(r.data.processInstanceId)
  }
  /** 手动腿原始返回（全空白档要看它是不是与"空集合"同档，不能假定成功）。 */
  const manualRaw = (facade: JeeflowFacade, instanceId: string, actorIds: any) =>
    facade.flow('processInstance/createCCInstance', { processInstanceId: instanceId, operator: 'zhangsan', actorIds })
  async function manualOk(facade: JeeflowFacade, instanceId: string, actorIds: any) {
    const r = await manualRaw(facade, instanceId, actorIds)
    assert.equal(r.code, 0, `手动抄送应成功: ${JSON.stringify(r)}`)
  }
  /** 办理腿：给实例上唯一待办办理并带 tf_ccActors。 */
  async function executeCc10(facade: JeeflowFacade, repo: MemoryRepository, instanceId: string, ccActors: any) {
    const task = (await repo.findDoingTasks(instanceId))[0]
    const r = await facade.flow('processTask/execute', {
      processTaskId: task.id, operator: 'leader', submitType: SubmitType.Agree, tf_ccActors: ccActors,
    })
    assert.equal(r.code, 0, `办理应成功: ${JSON.stringify(r)}`)
  }

  /**
   * SQL 仓一路的 T0 假适配器（与 G2 块那个同款、只装 cc 写侧用得上的两条语句）：
   * 内存里养一张 `wf_process_cc_instance`，逐条记录语句 ⇒ 不连任何数据库、不开端口，
   * "空值不得下库"看的是 INSERT 流水而不是返回值。
   */
  function ccTableG10() {
    const rows: Array<Record<string, any>> = []
    const stmts: Array<{ sql: string; args: any[] }> = []
    const conn: any = {
      async execute(sql: string, args: any[]) {
        stmts.push({ sql, args })
        if (/^INSERT INTO wf_process_cc_instance/.test(sql)) {
          rows.push({ id: args[0], process_instance_id: args[1], actor_id: args[2], state: 0, create_time: args[3], create_user: args[4], update_time: args[5], update_user: args[6] })
          return
        }
        throw new Error(`假适配器收到未预期语句: ${sql}`)
      },
      async fetchAll(sql: string, args: any[]) {
        stmts.push({ sql, args })
        if (/^SELECT actor_id FROM wf_process_cc_instance/.test(sql)) {
          return rows.filter(r => String(r.process_instance_id) === String(args[0])).map(r => ({ actor_id: r.actor_id }))
        }
        throw new Error(`假适配器收到未预期语句: ${sql}`)
      },
      async fetchOne() { return null },
      async begin() {}, async commit() {}, async rollback() {},
    }
    const adapter: any = { placeholder: '?', async acquire() { return conn }, async release() {} }
    const repo = new JdbcRepository(adapter)
    const inserts = () => stmts.filter(s => /^INSERT INTO wf_process_cc_instance/.test(s.sql))
    return { repo, rows, stmts, inserts }
  }

  // ═══ 正向对照（G10 不得把好行为改坏）═══

  it('正向对照 · 非空抄送人照旧逐人建行、逐人 fire 码 4', async () => {
    const { repo, facade, fired } = harnessG10()
    const instanceId = await start10(facade, await defineOf10(facade))
    fired.length = 0

    await manualOk(facade, instanceId, ['9101', '9102'])

    assert.deepEqual(await repo.findCcActorIds(instanceId), ['9101', '9102'], '正向对照：非空抄送人照旧逐人落行')
    assert.deepEqual(firedIds(fired), ['9101', '9102'], '正向对照：照旧逐人 fire 码 4')
  })

  // ═══ 手动腿 ═══

  it('G10 手动腿 · 丢完为空 ⇒ 不建行、不 fire，且与既有"空 actorIds"档同判（actorIds 缺失，不新造文案）', async () => {
    const { repo, facade, fired } = harnessG10()
    const defineId = await defineOf10(facade)
    // 参照档：本仓既有的"空集合"判据（空数组）——所有空白档必须与它同一个答案
    const refIid = await start10(facade, defineId)
    const ref = await manualRaw(facade, refIid, [])
    assert.equal(ref.code, 99999999, `参照档应报错: ${JSON.stringify(ref)}`)
    assert.ok(ref.msg.includes('actorIds 缺失'), ref.msg)

    for (const [label, actorIds] of [
      ["'' 空串", ''], ["'   ' 纯空白", '   '], ["['']", ['']], ["['  ']", ['  ']],
      ["['', '   ']", ['', '   ']], ["[null]", [null]], ["[undefined]", [undefined]],
      ["[null, undefined]", [null, undefined]],
    ] as Array<[string, any]>) {
      fired.length = 0
      const instanceId = await start10(facade, defineId)
      const r = await manualRaw(facade, instanceId, actorIds)
      assert.equal(r.code, ref.code, `${label} 应与空集合同档（code）: ${JSON.stringify(r)}`)
      assert.equal(r.msg, ref.msg, `${label} 应与空集合同档（msg 逐字，不新造文案）`)
      assert.deepEqual(await repo.findCcActorIds(instanceId), [], `G10：${label} 不得建任何 cc 行`)
      assert.equal(fired.length, 0, `G10：${label} 不得 fire 码 4，实收 ${JSON.stringify(firedIds(fired))}`)
    }
  })

  it('G10 手动腿 · 混给只丢空的：有效的人照旧建行＋fire，不得落出空 actor_id 行', async () => {
    const { repo, facade, fired } = harnessG10()
    const instanceId = await start10(facade, await defineOf10(facade))
    fired.length = 0

    await manualOk(facade, instanceId, ['9301', '', '  ', '9302'])

    assert.deepEqual(await repo.findCcActorIds(instanceId), ['9301', '9302'], '数组里的空元素丢弃、有效元素保留')
    assert.equal(repo.ccRowsForTest(instanceId).length, 2, `不得落出 actor_id='' 的行，实有 ${repo.ccRowsForTest(instanceId).length} 行`)
    assert.deepEqual(firedIds(fired), ['9301', '9302'], 'fire 的入参只含有效的人')
  })

  it('G10 手动腿 · 数组里的 null/undefined 是空值，不是字面量 "null"/"undefined" 假归属人（node 侧 toStringList2 旧形状）', async () => {
    const { repo, facade, fired } = harnessG10()
    const instanceId = await start10(facade, await defineOf10(facade))
    fired.length = 0

    await manualOk(facade, instanceId, ['9401', null, undefined])

    assert.deepEqual(await repo.findCcActorIds(instanceId), ['9401'],
      `null/undefined 必须丢弃，不得被 String() 串化成 "null"/"undefined" 落进 actor_id`)
    assert.deepEqual(firedIds(fired), ['9401'], '事件里也不得出现串化后的假归属人')
  })

  // ═══ 发起腿 f_ccActors（逗号串与数组两形态同判据）═══

  it('G10 发起腿 · f_ccActors 给空串 ⇒ 不建行、不 fire（java 旧形状 "".split(",") 得一空元素的对手戏）', async () => {
    const { repo, facade, fired } = harnessG10()
    const defineId = await defineOf10(facade)
    fired.length = 0

    const instanceId = await start10(facade, defineId, { f_ccActors: '' })
    assert.deepEqual(await repo.findCcActorIds(instanceId), [], 'G10：空串不得建 cc 行')
    assert.equal(fired.length, 0, 'G10：空串不得 fire 码 4')

    const instanceId2 = await start10(facade, defineId, { f_ccActors: '   ' })
    assert.deepEqual(await repo.findCcActorIds(instanceId2), [], 'G10：纯空白同样不建行')
    assert.equal(fired.length, 0, 'G10：纯空白同样不 fire')
  })

  it('G10 发起腿 · 逗号串里的空元素与尾随逗号丢弃，有效的人照旧建行＋fire', async () => {
    const { repo, facade, fired } = harnessG10()
    const defineId = await defineOf10(facade)
    fired.length = 0

    const iid = await start10(facade, defineId, { f_ccActors: '9501,,9502' })
    assert.deepEqual(await repo.findCcActorIds(iid), ['9501', '9502'], '逗号串空元素丢弃')
    assert.deepEqual(firedIds(fired), ['9501', '9502'], '逐有效人 fire')

    fired.length = 0
    const iid2 = await start10(facade, defineId, { f_ccActors: '9503,' })
    assert.deepEqual(await repo.findCcActorIds(iid2), ['9503'], '尾随逗号不得建空行')
    assert.deepEqual(firedIds(fired), ['9503'], '尾随逗号只 fire 有效的人')
  })

  it('G10 发起腿 · 数组形态含空元素与逗号串同判据（只修一条腿＝本条要抓的形状）', async () => {
    const { repo, facade, fired } = harnessG10()
    fired.length = 0

    const iid = await start10(facade, await defineOf10(facade), { f_ccActors: ['9601', '', '  '] })
    assert.deepEqual(await repo.findCcActorIds(iid), ['9601'], '数组形态与逗号串同判据')
    assert.deepEqual(firedIds(fired), ['9601'], '数组形态只 fire 有效的人')
  })

  // ═══ 办理腿 tf_ccActors ═══

  it('G10 办理腿 · tf_ccActors 纯空白/空串 ⇒ 不建行、不 fire', async () => {
    const { repo, facade, fired } = harnessG10()
    const defineId = await defineOf10(facade)

    for (const [label, ccActors] of [["'   ' 纯空白", '   '], ["'' 空串", ''], ["['']", ['']], ["['  ','']", ['  ', '']]] as Array<[string, any]>) {
      const instanceId = await start10(facade, defineId)
      fired.length = 0
      await executeCc10(facade, repo, instanceId, ccActors)
      assert.deepEqual(await repo.findCcActorIds(instanceId), [], `G10：办理腿 ${label} 不得建 cc 行`)
      assert.equal(fired.length, 0, `G10：办理腿 ${label} 不得 fire 码 4`)
    }
  })

  it('G10 办理腿 · 尾随逗号与混给只丢空的（逗号串/数组两形态同判）', async () => {
    const { repo, facade, fired } = harnessG10()
    const defineId = await defineOf10(facade)

    const iid = await start10(facade, defineId)
    fired.length = 0
    await executeCc10(facade, repo, iid, '9701,')
    assert.deepEqual(await repo.findCcActorIds(iid), ['9701'], '办理腿尾随逗号不得建空行')
    assert.deepEqual(firedIds(fired), ['9701'], '办理腿只 fire 有效的人')

    const iid2 = await start10(facade, defineId)
    fired.length = 0
    await executeCc10(facade, repo, iid2, ['9702', '', '  ', '9703'])
    assert.deepEqual(await repo.findCcActorIds(iid2), ['9702', '9703'], '办理腿数组形态同样只丢空的')
    assert.deepEqual(firedIds(fired), ['9702', '9703'])
  })

  // ═══ trim：落库与比较一律取 trim 后的值（与 G2 判重咬合）═══

  it('G10 落库值取 trim 后的串 · " 9801 " 与 "9801" 是同一个人', async () => {
    const { repo, facade, fired } = harnessG10()
    const instanceId = await start10(facade, await defineOf10(facade))
    fired.length = 0

    await manualOk(facade, instanceId, [' 9801 ', '9802'])

    assert.deepEqual(await repo.findCcActorIds(instanceId), ['9801', '9802'], '入库值应是 trim 后的串')
    assert.deepEqual(firedIds(fired), ['9801', '9802'], 'fire 的 ccActorId 也取 trim 后的值')
  })

  it('G10 trim 后同值命中 G2 判重 · 先抄 9901 再抄 " 9901 " ⇒ 仍 1 行、0 新 fire', async () => {
    const { repo, facade, fired } = harnessG10()
    const instanceId = await start10(facade, await defineOf10(facade))
    await manualOk(facade, instanceId, ['9901'])
    fired.length = 0

    await manualOk(facade, instanceId, [' 9901 '])

    assert.deepEqual(await repo.findCcActorIds(instanceId), ['9901'], '带空格的同一人不得再建第二行（不 trim 就把 G2 判重打穿）')
    assert.equal(repo.ccRowsForTest(instanceId).length, 1, '库里仍是那一行')
    assert.equal(fired.length, 0, `判重命中 ⇒ 不 fire 码 4，实收 ${JSON.stringify(firedIds(fired))}`)
  })

  // ═══ 写侧兜底：绕过引擎/门面直连仓储也建不出空行 ═══

  it('G10 内存仓写侧兜底 · 直连 createCcInstance：空串/纯空白/null 丢弃 ＋ 落库值 trim', async () => {
    const { repo } = harnessG10()
    await repo.createCcInstance('G10-M1', 'zhangsan', '', '   ', null as any, undefined as any, ' 8501 ', '8501')

    assert.deepEqual(await repo.findCcActorIds('G10-M1'), ['8501'], '仓储写侧空串/纯空白/null 都不建行，值取 trim 后的串')
    assert.equal(repo.ccRowsForTest('G10-M1').length, 1, `只落那一行（" 8501 " 与 "8501" 是同一个人），实有 ${repo.ccRowsForTest('G10-M1').length} 行`)

    const { repo: fresh } = harnessG10()
    await fresh.createCcInstance('G10-M2', 'zhangsan', '')
    assert.deepEqual(fresh.ccRowsForTest('G10-M2'), [], 'createCcInstance(id, creator, \'\') ⇒ 零行（本条普查的正主）')
  })

  it('G10 内存仓 IfAbsent · 返回的子集不含空值；全空入参 ⇒ 一行不建', async () => {
    const { repo } = harnessG10()

    const created = await repo.createCcInstanceIfAbsent!('G10-M3', 'zhangsan', '', '8601', '  ')
    assert.deepEqual(created, ['8601'], '实际新建子集只含有效的人（子集是拿去 fire 的那一份）')
    assert.deepEqual(await repo.findCcActorIds('G10-M3'), ['8601'], '子集与落库行一致')

    const created2 = await repo.createCcInstanceIfAbsent!('G10-M4', 'zhangsan', '', '   ', null as any)
    assert.deepEqual(created2, [], '全空入参 ⇒ 子集为空')
    assert.deepEqual(repo.ccRowsForTest('G10-M4'), [], '全空入参 ⇒ 不建任何 cc 行')
  })

  it('G10 判据单点 · spi.defaultCreateCcInstanceIfAbsent（第三方仓储兜底路径）同样丢空，全空时连 createCcInstance 都不调用', async () => {
    const calls: string[][] = []
    const thirdParty: any = {
      async createCcInstance(_id: string, _creator: string, ...actors: string[]) { calls.push(actors) },
    }

    const created = await defaultCreateCcInstanceIfAbsent(thirdParty, 'G10-S1', 'zhangsan', ['', '  ', '8701', ' 8702 '])
    assert.deepEqual(created, ['8701', '8702'], '子集不含空值且取 trim 后的串')
    assert.deepEqual(calls, [['8701', '8702']], '递给 createCcInstance 的入参也必须是归一后的集合')

    calls.length = 0
    const empty = await defaultCreateCcInstanceIfAbsent(thirdParty, 'G10-S2', 'zhangsan', ['', '   ', null as any])
    assert.deepEqual(empty, [], '全空 ⇒ 子集为空')
    assert.equal(calls.length, 0, '全空 ⇒ 最底层写入口一次都不被调用（不建行为主）')
  })

  // ═══ 反向哨兵 ═══

  it('G10 反向哨兵 · "0" 这类"看起来像空"的正常 id 不得被当空值丢掉（三入口同判）', async () => {
    const { repo, facade, fired } = harnessG10()
    const defineId = await defineOf10(facade)

    fired.length = 0
    const manual = await start10(facade, defineId)
    await manualOk(facade, manual, ['0', 'user-1'])
    assert.deepEqual(await repo.findCcActorIds(manual), ['0', 'user-1'], "G10 只丢空串/纯空白：'0' 这类正常 id 不得被吃掉")
    assert.equal(fired.length, 2, '反向哨兵：照旧逐人 fire')

    fired.length = 0
    const startLeg = await start10(facade, defineId, { f_ccActors: '0' })
    assert.deepEqual(await repo.findCcActorIds(startLeg), ['0'], "发起腿 '0' 照旧建行")
    assert.deepEqual(firedIds(fired), ['0'], "发起腿 '0' 照旧 fire")

    fired.length = 0
    const execLeg = await start10(facade, defineId)
    await executeCc10(facade, repo, execLeg, ['0'])
    assert.deepEqual(await repo.findCcActorIds(execLeg), ['0'], "办理腿 ['0'] 照旧建行")
    assert.deepEqual(firedIds(fired), ['0'], "办理腿 ['0'] 照旧 fire")
  })

  // ═══ SQL 仓一路 ═══

  it('G10 SQL 仓写侧兜底 · 直连 createCcInstance：空值一条 INSERT 都不发，落库值取 trim 后的串', async () => {
    const { repo, rows, inserts } = ccTableG10()

    await repo.createCcInstance('900101', 'zhangsan', '', '   ', null as any, undefined as any, ' 8501 ', '8501')

    assert.equal(inserts().length, 1, `空串/纯空白/null 不得下库，实发 ${inserts().length} 条 INSERT`)
    assert.deepEqual(rows.map(r => r.actor_id), ['8501'], '绑进 actor_id 的值是 trim 后的串，且 " 8501 " 与 "8501" 只落一行')
    assert.deepEqual(await repo.findCcActorIds('900101'), ['8501'])
  })

  it('G10 SQL 仓 IfAbsent · 子集不含空值；全空入参 ⇒ 零 INSERT', async () => {
    const { repo, rows, inserts } = ccTableG10()

    const created = await repo.createCcInstanceIfAbsent!('900102', 'zhangsan', '', '8601', '  ')
    assert.deepEqual(created, ['8601'], '返回的子集只含实际新建的有效人')
    assert.equal(inserts().length, 1, `只插一条，实发 ${inserts().length} 条`)

    const before = inserts().length
    const empty = await repo.createCcInstanceIfAbsent!('900102', 'zhangsan', '', '   ', null as any)
    assert.deepEqual(empty, [], '全空 ⇒ 子集为空')
    assert.equal(inserts().length, before, '全空 ⇒ 一条 INSERT 都不许多发')
    assert.deepEqual(rows.map(r => r.actor_id), ['8601'], '库里没有空行')
  })

  it('G10 SQL 仓 trim 后同值命中判重 · 已抄 8701 再抄 " 8701 " ⇒ 不多发一条 INSERT', async () => {
    const { repo, rows, inserts } = ccTableG10()

    await repo.createCcInstance('900103', 'zhangsan', '8701')
    const before = inserts().length
    await repo.createCcInstance('900103', 'zhangsan', ' 8701 ')

    assert.equal(inserts().length, before, `带空格的同一人必须命中判重（不 trim 就落两行），实多发 ${inserts().length - before} 条`)
    assert.deepEqual(rows.map(r => r.actor_id), ['8701'], '库里只有那一行')
  })

  it('G10 两仓同答案 · 同一组入参在内存仓与 SQL 仓得到同一个 actor 集合（issues/117 场景 27 那把尺子）', async () => {
    const vectors: Array<{ label: string; actors: any[] }> = [
      { label: '空串/纯空白/null/未 trim 同人混给', actors: ['', '   ', null, undefined, ' 8501 ', '8501'] },
      { label: '有效人夹空元素', actors: ['8502', '', '8503'] },
      { label: '只有带空格的一个人', actors: [' 8504 '] },
      { label: '反向哨兵 "0" 与带横线 id', actors: ['0', 'user-1'] },
      { label: '全空', actors: ['', '  '] },
      { label: '同一次调用内的重复', actors: ['8505', ' 8505 ', '8505'] },
    ]
    for (const [idx, { label, actors }] of vectors.entries()) {
      const mem = new MemoryRepository()
      const sql = ccTableG10().repo
      const memIds = `G10-X-${idx}`
      const sqlIds = `9002${idx}0`
      await mem.createCcInstance(memIds, 'zhangsan', ...(actors as string[]))
      await sql.createCcInstance(sqlIds, 'zhangsan', ...(actors as string[]))
      const a = await mem.findCcActorIds(memIds)
      const b = await sql.findCcActorIds(sqlIds)
      assert.deepEqual(a, b, `「${label}」两仓必须同答案：内存仓出 ${JSON.stringify(a)}，SQL 仓出 ${JSON.stringify(b)}`)
    }
    // 逐档的真值（同答案还不够，还得答案是"只丢空的"那一个）
    const mem = new MemoryRepository()
    await mem.createCcInstance('G10-X-9', 'zhangsan', '', '   ', null as any, undefined as any, ' 8501 ', '8501')
    assert.deepEqual(await mem.findCcActorIds('G10-X-9'), ['8501'], '混给档的期望真值')
  })
})

// ═══ issues/142 A 批 · 记录类节点（snaker:custom）执行形状 ＋ 任务类零参与者建单 ══════════
//
// 验收标准逐字来自 `jeeflow-doc/docs/spec/02-flow-definition.md`：
//   §6.1（owner 2026-09-29 拍「自定义类型这种记录类的，不会有参与人，是正常行为」）——
//        记录类正确形状＝执行 clazz、落 taskState=20 历史行、令牌继续流转；
//        禁止形状＝①当任务类建 DOING 行 ②兜底把行挂给当前操作人 ③直接跳过节点不建行（丢留痕）；
//   §6.2（owner 2026-09-30 逐条拍三条硬要求）——①历史行必须**真落库**（只在聚合内存里 append 不算做到，
//        java/c# 现读正是这个洞，本栈不照抄）；②clazz 解析不了 ⇒ 记日志＋照常落历史行＋续流，严禁抛错
//        打断建单，且"未注册"与"clazz 空串"要分档可诊断（c# 把两者合成同一个异常，不照抄），处理器
//        **自身**抛错不在豁免内；③记录类腿不解析参与者，反过来**任务类零参与者必须建 DOING 行**。
//
// 本栈改前三处病灶（逐处还原实测见本轮报告）：
//   ① engine.executeNode 把 TypeCustom 与 TypeTask 同路走 createTask ⇒ 落 DOING 待办行（§6.1 禁止形状①）；
//   ② engine.createTask 开头 `if (!actors.length) return` ⇒ 任务类零参与者一行不建（§6.1 死锁黑洞）；
//   ③ src 内 clazz 零命中 ⇒ 记录类节点既不执行处理器、也不落历史行、更没有 INSERT 腿。
describe('issues/142 记录类节点 custom 落 DONE 历史行并真落库 ＋ 任务类零参与者必须建 DOING 单（spec 02 §6.1/§6.2）', () => {

  /** 与共享夹具 flows/08-custom-node.json 逐字同串的 clazz（本栈按名注册，不是反射类路径） */
  const CLAZZ = 'com.mldong.jeeflow.test.TestCustomHandler'

  /** start → apply(任务类，assignee=applicant) → custom1(记录类，properties 可给) → end */
  function customFlowContent(customProps: Record<string, any>, taskProps: Record<string, any> = {}): string {
    return JSON.stringify({
      name: 'custom142', displayName: '记录类节点测试', type: 'approval',
      nodes: [
        { id: 'start', type: 'snaker:start', properties: {}, text: { value: '开始' } },
        { id: 'apply', type: 'snaker:task',
          properties: { assignee: 'applicant', taskType: 0, performType: 0, ...taskProps }, text: { value: '发起申请' } },
        { id: 'custom1', type: 'snaker:custom', properties: { ...customProps }, text: { value: '通知外部系统' } },
        { id: 'end', type: 'snaker:end', properties: {}, text: { value: '结束' } },
      ],
      edges: [
        { id: 'e0', sourceNodeId: 'start', targetNodeId: 'apply', properties: {} },
        { id: 'e1', sourceNodeId: 'apply', targetNodeId: 'custom1', properties: {} },
        { id: 'e2', sourceNodeId: 'custom1', targetNodeId: 'end', properties: {} },
      ],
    })
  }

  /** start → task1(任务类，properties 可给) → end；不给 assignee ⇒ 参与者天然解析为空 */
  function singleTaskFlowContent(taskProps: Record<string, any> = {}): string {
    return JSON.stringify({
      name: 'zero142', displayName: '零参与者建单测试', type: 'approval',
      nodes: [
        { id: 'start', type: 'snaker:start', properties: {}, text: { value: '开始' } },
        { id: 'task1', type: 'snaker:task', properties: { taskType: 0, performType: 0, ...taskProps }, text: { value: '审批' } },
        { id: 'end', type: 'snaker:end', properties: {}, text: { value: '结束' } },
      ],
      edges: [
        { id: 'e0', sourceNodeId: 'start', targetNodeId: 'task1', properties: {} },
        { id: 'e1', sourceNodeId: 'task1', targetNodeId: 'end', properties: {} },
      ],
    })
  }

  /** SQL 仓那半的 T0 假适配器：内存养 wf_process_task ＋ wf_process_task_actor 两张表、逐条记语句。
   *  不连任何数据库、不开端口——"历史行真落库"钉的是 INSERT 流水，不是返回值（§6.2 第 1 条）。 */
  function taskTableRepo() {
    const taskRows: Array<Record<string, any>> = []
    const actorRows: Array<Record<string, any>> = []
    const stmts: Array<{ sql: string; args: any[] }> = []
    const conn: any = {
      async execute(sql: string, args: any[]) {
        stmts.push({ sql, args })
        if (/^INSERT INTO wf_process_task \(/.test(sql)) {
          // 列序见 src/jdbc/shared.ts saveTask：0 id ·1 piid ·2 task_name ·3 display_name ·4 task_type
          // ·5 perform_type ·6 task_state ·7 operator ·8 finish_time ·9 expire_time ·10 form_key ·11 task_parent_id ·12 variable
          taskRows.push({ id: args[0], process_instance_id: args[1], task_name: args[2], task_type: args[4],
            perform_type: args[5], task_state: args[6], operator: args[7], finish_time: args[8],
            form_key: args[10], task_parent_id: args[11], variable: args[12] })
          return
        }
        if (/^DELETE FROM wf_process_task_actor/.test(sql)) {
          for (let i = actorRows.length - 1; i >= 0; i--) if (String(actorRows[i].process_task_id) === String(args[0])) actorRows.splice(i, 1)
          return
        }
        if (/^INSERT INTO wf_process_task_actor/.test(sql)) {
          actorRows.push({ id: args[0], process_task_id: args[1], actor_id: args[2] })
          return
        }
        throw new Error(`假适配器收到未预期语句: ${sql}`)
      },
      async fetchAll() { return [] },
      async fetchOne() { return null },
      async begin() {}, async commit() {}, async rollback() {},
    }
    const adapter: any = { placeholder: '?', async acquire() { return conn }, async release() {} }
    return { repo: new JdbcRepository(adapter), taskRows, actorRows, stmts }
  }

  /** 写侧同时打到两仓的仓储：读写走内存仓，saveTask 额外原样喂给 SQL 仓的假适配器。
   *  这样"两仓同答案"钉的是**同一次执行**产出的同一行，而不是两个仓各喂一份手搓数据。 */
  function bothRepos(mem: MemoryRepository, sql: JdbcRepository): any {
    return new Proxy(mem, {
      get(_t, prop: any) {
        const v: any = (mem as any)[prop]
        if (typeof v !== 'function') return v
        return async (...args: any[]) => {
          const out = await v.apply(mem, args)
          if (prop === 'saveTask') await sql.saveTask(args[0])
          return out
        }
      },
    })
  }

  function seedDefine(repo: MemoryRepository, name: string, content: string): ProcessDefine {
    const def = {
      id: '', name, displayName: '142 测试', type: 'test', state: 1, content, version: 1,
      createTime: new Date(), createUser: 't', updateTime: new Date(), updateUser: 't',
    } as ProcessDefine
    repo.addDefine(def)
    return def
  }

  /** 引擎 harness：内存仓 ＋ 按名注册的 custom 处理器 ＋ 事件流水；sqlPair 给时写侧同打 SQL 仓。 */
  function customHarness(content: string, customs: Record<string, any> = {}, sqlPair = false) {
    const mem = new MemoryRepository()
    const sql = taskTableRepo()
    const engine = new EngineImpl(sqlPair ? bothRepos(mem, sql.repo) : mem, undefined, seqIdGen('c142'))
    const registry = new HandlerRegistry()
    for (const [name, h] of Object.entries(customs)) registry.registerCustom(name, h)
    engine.setRegistry(registry)
    const fired: ProcessEvent[] = []
    engine.setExtensions({ listeners: [e => { fired.push({ ...e }) }] })
    const def = seedDefine(mem, String(JSON.parse(content).name), content)
    return { mem, sql, engine, registry, fired, def }
  }

  /** 走完整条记录类腿：发起（建 apply 待办）→ 把待办公办掉（触发 custom1 → end）。 */
  async function runThroughCustom(h: ReturnType<typeof customHarness>, operator = 'alice') {
    const started = await h.engine.startProcessInstanceById(h.def.id, operator)
    const todosBefore = await h.mem.findDoingTasks(started.id)
    for (const t of todosBefore) await h.engine.executeProcessTask(t.id, operator)
    return { started, todosBefore }
  }

  /** console.warn 捕获——两档日志要能**分别**断言（§6.2 第 2 条"未注册"与"空串"分档） */
  async function captureWarnings(fn: () => Promise<unknown>): Promise<string[]> {
    const lines: string[] = []
    const orig = console.warn
    console.warn = (...args: any[]) => { lines.push(args.map(String).join(' ')) }
    try { await fn() } finally { console.warn = orig }
    return lines
  }

  /** 从内存仓读回该实例上某节点那条 DONE 行（读不到 ⇒ null，把"没这行"与"行不对"分开断） */
  async function doneRow(mem: MemoryRepository, instId: string, taskName: string) {
    const hit = (await mem.findDoneTasks(instId)).find(t => t.taskName === taskName)
    return hit ? await mem.findTaskById(hit.id) : null
  }

  // ── A 组：记录类（custom）腿的形状 ────────────────────────────────────────────

  it('①共享夹具 08-custom-node.json · custom 落一条 taskState=20 历史行，同一次执行两仓都读得到（§6.2 第 1 条的 INSERT 腿）', async () => {
    const h = customHarness(readFileSync(flowDir + '08-custom-node.json', 'utf-8'),
      { [CLAZZ]: { handle: () => 'NOTIFIED-42' } }, true)
    const { started, todosBefore } = await runThroughCustom(h)
    const iid = started.id

    const done = await doneRow(h.mem, iid, 'custom1')
    assert.ok(done, '内存仓必须查得到那条历史行（只 append 进聚合数组＝java/c# 现读的洞，§6.2 明写不算做到）')
    assert.equal(done!.taskState, TaskState.Done, '历史行 taskState 必须是 20(DONE)，不是 10(DOING 待办)')
    assert.equal(done!.displayName, '通知外部系统', '历史行带节点显示名（留痕要可读）')
    assert.deepEqual(done!.actorIds, ['alice'], '历史行参与者＝当前操作人（java createHistoryTask 的 singletonList(operator) 同形，是留痕主体不是待办）')
    assert.ok(done!.finishTime instanceof Date, 'DONE 行带 finishTime（java/python 同形）')
    assert.equal(done!.formKey, '', '记录类行无 formKey')
    assert.equal(done!.performType, 0, '记录类行无会签字段')
    const applyRow = (await h.mem.findHistoryTasks(iid)).find(t => t.taskName === 'apply')!
    assert.equal(String(done!.parentTaskId), String(applyRow.id), '建单不变量：taskParentId＝刚办结的那条行（issues/121 P1）')
    assert.equal(done!.variables.isFirstTaskNode, false, '行级 isFirstTaskNode 照建单不变量写（custom1 不是 start 直接后继）')

    // SQL 仓那半：同一次执行的 INSERT 流水里真有这一行 ＋ 对应的一行参与者
    const sqlRow = h.sql.taskRows.find(r => r.task_name === 'custom1')
    assert.ok(sqlRow, 'SQL 仓必须收到那条 wf_process_task 的 INSERT（"落库"看语句流水，不看返回值）')
    assert.equal(Number(sqlRow!.task_state), 20, 'SQL 行 task_state=20')
    assert.deepEqual(h.sql.actorRows.filter(a => String(a.process_task_id) === String(sqlRow!.id)).map(a => a.actor_id), ['alice'],
      'SQL 行在 wf_process_task_actor 也有对应一行')
    assert.ok(String(sqlRow!.variable).includes('isFirstTaskNode'), 'SQL 行的 variable 落了 isFirstTaskNode 标记')

    // 待办数不增加（§6.1 硬结论 2：记录类不进"按待办数"的对账分母）
    assert.ok(todosBefore.length === 1, `夹具自证：办理前应只有 apply 一条待办，实得 ${todosBefore.length}`)
    assert.equal((await h.mem.findDoingTasks(iid)).length, 0, 'custom 不产生待办 ⇒ 公办后待办清零')
  })

  it('②不为 custom 那一条行 fire 码 3（TASK_START 表达"新待办产生"）；正向对照＝apply 那条 DOING 行照旧有码 3', async () => {
    const h = customHarness(customFlowContent({ clazz: CLAZZ, val: 'customResult' }), { [CLAZZ]: { handle: () => 'ok' } })
    const { started } = await runThroughCustom(h)

    const taskStarts = h.fired.filter(e => e.type === EventType.ProcessTaskStart)
    assert.ok(taskStarts.length >= 1, '正向对照：任务类建单照旧 fire 码 3（不能把整条腿的 fire 一起关掉）')
    assert.equal(taskStarts.filter(e => e.nodeId === 'custom1').length, 0,
      '记录类那一行不得出现在码 3 里（§11.3 码 3＝新待办产生，本腿建出来即已完成态）')
    assert.deepEqual(taskStarts.filter(e => e.nodeId === 'apply').map(e => e.actors), [['alice']],
      '任务类行的码 3 载荷仍带参与者')
    assert.ok(h.fired.some(e => e.type === EventType.ProcessInstanceEnd), '令牌继续流转：实例走到终点并 fire 码 2')
    assert.equal((await h.mem.findInstanceById(started.id))!.state, InstanceState.Done, '实例办结')
  })

  it('③记录类腿不解析参与者：定义里给 custom 配 assignee 也不建 DOING 行、不往行上挂人（§6.2 第 3 条前半）', async () => {
    const h = customHarness(customFlowContent({ clazz: CLAZZ, assignee: 'bob', assignmentHandler: 'whatever' }),
      { [CLAZZ]: { handle: () => 'ok' } })
    const { started } = await runThroughCustom(h)

    assert.equal((await h.mem.findDoingTasks(started.id)).length, 0, 'custom 不建 DOING 行（§6.1 禁止形状①）')
    const done = await doneRow(h.mem, started.id, 'custom1')
    assert.ok(done, '历史行照样要落（§6.1 禁止形状③：跳过节点丢留痕）')
    assert.deepEqual(done!.actorIds, ['alice'], '参与者是当前操作人，不是节点上配的 assignee（本腿不走 resolveActors）')
    assert.ok(!done!.actorIds.includes('bob'), '严禁把 assignee 解析成人挂到记录类行上')
  })

  // ── A 组：clazz 三档（未注册 / 空档 / 处理器自身抛错）──────────────────────────

  it('④clazz 未注册 ⇒ 不抛错＋照常落历史行＋令牌续流；日志档 1「未注册」带 clazz 原串（§6.2 第 2 条）', async () => {
    const h = customHarness(customFlowContent({ clazz: 'com.example.NotRegistered', methodName: 'execute' }))
    let started!: ProcessInstance
    const lines = await captureWarnings(async () => { started = (await runThroughCustom(h)).started })

    assert.equal((await h.mem.findInstanceById(started.id))!.state, InstanceState.Done,
      '未注册 clazz 不得打断建单——实例要走到终点（改前 java 那侧是抛 RuntimeException 的形状）')
    const done = await doneRow(h.mem, started.id, 'custom1')
    assert.ok(done, '未注册 clazz 也要落那条 DONE 历史行（记日志 ≠ 跳过节点）')
    assert.deepEqual(done!.actorIds, ['alice'], '历史行参与者仍是当前操作人')
    assert.equal(lines.filter(l => l.includes('未注册处理器')).length, 1, `档 1 日志应恰好一条，实得 ${JSON.stringify(lines)}`)
    assert.ok(lines[0].includes('clazz=com.example.NotRegistered'), `档 1 日志要带 clazz 原串才诊断得动：${lines[0]}`)
    assert.ok(lines[0].includes('methodName=execute'), `档 1 日志带 methodName（配了类名却查无实现，方法名是第二条线索）：${lines[0]}`)
    assert.ok(!lines.some(l => l.includes('未配置 clazz')), '档 1 不得串到档 2 的文案上')

    // 档 1 的第二小口：引擎压根没挂 HandlerRegistry ⇒ 同样不许炸，文案要指出 setRegistry
    const bareMem = new MemoryRepository()
    const bare = new EngineImpl(bareMem, undefined, seqIdGen('bare142'))
    const bareDef = seedDefine(bareMem, 'custom142', customFlowContent({ clazz: 'com.example.NotRegistered' }))
    let bareStarted!: ProcessInstance
    const bareLines = await captureWarnings(async () => {
      bareStarted = await bare.startProcessInstanceById(bareDef.id, 'alice')
      for (const t of await bareMem.findDoingTasks(bareStarted.id)) await bare.executeProcessTask(t.id, 'alice')
    })
    assert.equal((await bareMem.findInstanceById(bareStarted.id))!.state, InstanceState.Done,
      '没挂注册表也不得打断建单——记录类腿仍要落行并续流')
    assert.equal(bareLines.filter(l => l.includes('未注册处理器')).length, 1, `档 1 日志仍出一条，实得 ${JSON.stringify(bareLines)}`)
    assert.ok(bareLines[0].includes('setRegistry'), `未挂注册表时文案要指出 setRegistry 这一步：${bareLines[0]}`)
  })

  it('⑤clazz 空串／纯空白／整条缺失 ⇒ 不抛错＋照常落历史行＋续流；日志档 2 与档 1 分别可诊断', async () => {
    const vectors: Array<[string, Record<string, any>]> = [
      ['空串', { clazz: '', val: 'customResult' }],
      ['纯空白', { clazz: '   ' }],
      ['整条缺失', { methodName: 'execute' }],
    ]
    for (const [label, props] of vectors) {
      const h = customHarness(customFlowContent(props))
      let started!: ProcessInstance
      const lines = await captureWarnings(async () => { started = (await runThroughCustom(h)).started })

      assert.equal((await h.mem.findInstanceById(started.id))!.state, InstanceState.Done, `「${label}」档不得打断建单`)
      const done = await doneRow(h.mem, started.id, 'custom1')
      assert.ok(done, `「${label}」档仍要落历史行`)
      assert.equal(lines.filter(l => l.includes('未配置 clazz')).length, 1, `「${label}」档应出档 2 日志一条，实得 ${JSON.stringify(lines)}`)
      assert.ok(!lines.some(l => l.includes('未注册处理器')), `「${label}」档不得串到档 1 文案上（c# 把两者合成同一个异常，覆盖面比 java 宽，不照抄）`)
    }
  })

  it('⑥处理器自身抛错 ⇒ 照旧外抛（不在"误配不该炸流程"的豁免内），不被静默吞掉也不假装办结', async () => {
    const h = customHarness(customFlowContent({ clazz: CLAZZ }), {
      [CLAZZ]: { handle: () => { throw new Error('业务处理器炸了') } },
    })
    const started = await h.engine.startProcessInstanceById(h.def.id, 'alice')
    const todo = (await h.mem.findDoingTasks(started.id))[0]
    await assert.rejects(() => h.engine.executeProcessTask(todo.id, 'alice'), /业务处理器炸了/,
      '处理器自身执行失败是业务错误，必须外抛（§6.2 第 2 条末段）')
    assert.equal(await doneRow(h.mem, started.id, 'custom1'), null, '外抛时不落历史行——"吞掉错误还建行"才是本条要禁的形状')
    assert.equal((await h.mem.findInstanceById(started.id))!.state, InstanceState.Doing, '炸了不会假装办结')
  })

  it('⑦clazz 返回值：给了 properties.val 落自定义键，没给落缺省键 custom_return_val（对齐 java CustomParser/CustomModel）', async () => {
    const withVal = customHarness(customFlowContent({ clazz: CLAZZ, val: 'customResult' }), { [CLAZZ]: { handle: () => 'NOTIFIED-1' } })
    const a = await runThroughCustom(withVal)
    const va = (await withVal.mem.findInstanceById(a.started.id))!.variables
    assert.equal(va.customResult, 'NOTIFIED-1', 'properties.val 命中时写进该键')
    assert.ok(!('custom_return_val' in va), 'val 命中时不再另写缺省键')

    const noVal = customHarness(customFlowContent({ clazz: CLAZZ }), { [CLAZZ]: { handle: async () => ({ id: 7 }) } })
    const b = await runThroughCustom(noVal)
    const vb = (await noVal.mem.findInstanceById(b.started.id))!.variables
    assert.deepEqual(vb.custom_return_val, { id: 7 }, 'val 缺失 ⇒ 缺省键 custom_return_val（java FlowConst.CUSTOM_RETURN_VAL 同串）')
    assert.equal(KeyCustomReturnVal, 'custom_return_val', '本栈常量与 java 逐字同串')

    const voidRet = customHarness(customFlowContent({ clazz: CLAZZ }), { [CLAZZ]: { handle: () => undefined } })
    const c = await runThroughCustom(voidRet)
    const vc = (await voidRet.mem.findInstanceById(c.started.id))!.variables
    assert.ok(!('custom_return_val' in vc),
      '处理器无返回值 ⇒ 不写键（java 那侧 put 的是 JVM null；本栈 undefined 过 JSON 序列化会整键消失，见 extensions.ts issues/122 注释，故显式不写而不是写出空值）')
  })

  // ── B 组：任务类零参与者必须建单 ──────────────────────────────────────────────

  it('⑧任务类零参与者必须建一行 DOING：行存在、state=10、参与者空数组、发起人不在参与者里（§6.1 表第一行／§6.2 第 3 条）', async () => {
    const h = customHarness(singleTaskFlowContent())
    const inst = await h.engine.startProcessInstanceById(h.def.id, 'carol')
    const doing = await h.mem.findDoingTasks(inst.id)

    assert.equal(doing.length, 1, `零参与者也要建单，实得 ${doing.length} 行（改前 0 行＝§6.1 点名的死锁黑洞）`)
    assert.equal(doing[0].taskState, TaskState.Doing, '建的是 DOING(10) 行')
    assert.deepEqual(doing[0].actorIds, [], '参与者为空数组——"建行且不挂人"与"不建单"是两件事')
    assert.ok(!doing[0].actorIds.includes('carol'), '严禁兜底把行挂给当前操作人/发起人（§6.1 硬结论 1，python 任务类腿那一支也不照抄）')
    assert.equal((await h.mem.findInstanceById(inst.id))!.state, InstanceState.Doing, '实例进行中且确有可推进行')
    const starts = h.fired.filter(e => e.type === EventType.ProcessTaskStart)
    assert.equal(starts.length, 1, '这一行是待办行 ⇒ 照旧 fire 码 3 一次')
    assert.deepEqual(starts[0].actors, [], '码 3 载荷的参与者是空数组（不省键、不假装有值）')
  })

  it('⑨零参与者 ＋ 会签配置 ⇒ 仍只建一行（不 0 行、不 N 行），且不写 nrOfInstances=0 的会签簿记（重入口就此封死）', async () => {
    for (const ct of ['PARALLEL', 'SEQUENTIAL']) {
      const h = customHarness(singleTaskFlowContent({ performType: 'ALL', countersignType: ct }))
      const inst = await h.engine.startProcessInstanceById(h.def.id, 'dave')
      const doing = await h.mem.findDoingTasks(inst.id)

      assert.equal(doing.length, 1, `${ct} 零参与者应恰好建一行，实得 ${doing.length}`)
      assert.deepEqual(doing[0].actorIds, [], `${ct} 那行的参与者是空数组`)
      const keys = Object.keys(doing[0].variables)
      assert.ok(!keys.some(k => k.startsWith('nrOfInstances_')), `${ct} 零参与者行不得带 nrOfInstances=0 的会签簿记（0 计数正是反复重入的入口）`)
      assert.ok(!keys.some(k => k.startsWith('operatorList_')), `${ct} 零参与者行不得写空的 operatorList 簿记`)
      assert.equal(doing[0].variables.isFirstTaskNode, true, `${ct}：start 直接后继 ⇒ 行级首节点标记照建单不变量`)
    }
  })

  it('⑩零参与者行由 flow.auto 办得动并推进到终点；整条链不产生第二行（自动推进不重入）', async () => {
    const h = customHarness(singleTaskFlowContent())
    const inst = await h.engine.startProcessInstanceById(h.def.id, 'erin')
    const row = (await h.mem.findDoingTasks(inst.id))[0]
    await h.engine.executeProcessTask(row.id, 'flow.auto')

    assert.equal((await h.mem.findInstanceById(inst.id))!.state, InstanceState.Done, 'flow.auto 放行（isAllowed 判据不动）⇒ 实例走到终点')
    assert.equal((await h.mem.findDoingTasks(inst.id)).length, 0, '办结后不留待办')
    const all = await h.mem.findHistoryTasks(inst.id)
    assert.equal(all.length, 1, `整条链只有一行任务，实得 ${all.length} 行（反复重入会多建）`)
  })

  it('⑪正向对照 · 任务类有参与者时形状不变：单人一行一人、多人一行承载全部（尾部"按有效列表写回"没改坏既有形状）', async () => {
    const one = customHarness(singleTaskFlowContent({ assignee: 'frank' }))
    const i1 = await one.engine.startProcessInstanceById(one.def.id, 'frank')
    const d1 = await one.mem.findDoingTasks(i1.id)
    assert.equal(d1.length, 1, '单参与者仍是一行')
    assert.deepEqual(d1[0].actorIds, ['frank'], '单参与者行的参与者就是那一个人')

    const many = customHarness(singleTaskFlowContent({ assignee: 'frank,grace' }))
    const i2 = await many.engine.startProcessInstanceById(many.def.id, 'frank')
    const d2 = await many.mem.findDoingTasks(i2.id)
    assert.equal(d2.length, 1, '普通任务一行承载全部参与者（对齐 boot3 createTask＋addTaskActor，任一可办）')
    assert.deepEqual(d2[0].actorIds, ['frank', 'grace'], '多参与者按有效列表落库')
  })

  // ── C 组：clazz 注册表挂在既有 HandlerRegistry 上（不另立并行注册中心）───────────

  it('⑫clazz 注册表挂在既有 HandlerRegistry 上：registerCustom/resolveCustom/listHandlers/listHandlerNames 四件套', async () => {
    const r = new HandlerRegistry()
    assert.equal(r.resolveCustom(''), undefined, '空名 ⇒ undefined（引擎侧走"未配置 clazz"那一档，不抛错）')
    assert.equal(r.resolveCustom(CLAZZ), undefined, '未注册 ⇒ undefined（不是异常，这是 §6.2 第 2 条的前提）')

    const handler = { handle: () => 1 }
    r.registerCustom(CLAZZ, handler, { displayName: '外部系统通知', order: 3 })
    assert.equal(r.resolveCustom(CLAZZ), handler, '按 clazz 原样串解析到同一个实例')
    assert.equal(r.resolveCustom('com.example.Missing'), undefined, '别的名字仍未命中')
    assert.deepEqual(r.listHandlers('CustomHandler').map(m => m.name), [CLAZZ], 'CustomHandler 类型清单出得来（SPI 字典同一把尺子）')
    assert.equal(r.listHandlers('CustomHandler')[0].displayName, '外部系统通知', '元数据同族复用（displayName/order 走既有 HandlerMeta）')
    assert.deepEqual(r.listHandlerNames(), [CLAZZ], '名称清单含 custom —— 与 assignment/decision 同一家，没有第二个注册中心')
    assert.equal(r.listHandlers('AssignmentHandler').length, 7, '内置 7 个 assignment 元数据不受影响（既有清单没被动）')
    assert.deepEqual(r.listHandlers('DecisionHandler'), [], 'decision 清单未被 custom 串台')
  })

  it('⑬clazz 按 trim 后的原样串命中注册表（与 java `Class.forName(clazz.trim())` 同形）；未命中则不写返回值键', async () => {
    // 定义里 clazz 两端多写空白 ⇒ 仍命中同一个注册名，处理器照跑、返回值照写
    const padded = customHarness(customFlowContent({ clazz: `  ${CLAZZ}  ` }), { [CLAZZ]: { handle: () => 'HIT' } })
    const r = await runThroughCustom(padded)
    assert.equal(await (await doneRow(padded.mem, r.started.id, 'custom1'))?.taskState, TaskState.Done,
      '带空白的 clazz 也要落 DONE 历史行')
    const vars = (await padded.mem.findInstanceById(r.started.id))!.variables
    assert.equal(vars.custom_return_val, 'HIT', 'trim 后命中注册名 ⇒ 处理器返回值写进缺省键（不因为多了两个空格就退化成"未注册"档）')

    // 另一个未注册名 ⇒ 档 1：不炸、落行、处理器没跑所以也没有返回值键
    const missed = customHarness(customFlowContent({ clazz: 'com.example.NOT_FOUND' }), { [CLAZZ]: { handle: () => 'HIT' } })
    const r2 = await runThroughCustom(missed)
    const v2 = (await missed.mem.findInstanceById(r2.started.id))!.variables
    assert.ok(!('custom_return_val' in v2), '未注册 ⇒ 处理器没跑、不写返回值键（照常落行续流，见④）')
    assert.ok(await doneRow(missed.mem, r2.started.id, 'custom1'), '未注册档仍要落历史行')
  })

  it('⑭custom 作为 start 直接后继（发起腿当场执行）：行级 isFirstTaskNode=true、发起后即办结', async () => {
    const content = JSON.stringify({
      name: 'customfirst142', displayName: '记录类首节点测试', type: 'approval',
      nodes: [
        { id: 'start', type: 'snaker:start', properties: {}, text: { value: '开始' } },
        { id: 'custom1', type: 'snaker:custom', properties: { clazz: CLAZZ }, text: { value: '写台账' } },
        { id: 'end', type: 'snaker:end', properties: {}, text: { value: '结束' } },
      ],
      edges: [
        { id: 'e0', sourceNodeId: 'start', targetNodeId: 'custom1', properties: {} },
        { id: 'e1', sourceNodeId: 'custom1', targetNodeId: 'end', properties: {} },
      ],
    })
    const h = customHarness(content, { [CLAZZ]: { handle: () => 'LEDGER-1' } })
    const inst = await h.engine.startProcessInstanceById(h.def.id, 'gina')

    assert.equal((await h.mem.findInstanceById(inst.id))!.state, InstanceState.Done,
      '发起腿就要把记录类节点跑完并走到终点（§6.2 第 2 条"记日志但停在原地"算违反本条的那一档不许出现）')
    assert.equal((await h.mem.findDoingTasks(inst.id)).length, 0, '全程不产生待办')
    const done = await doneRow(h.mem, inst.id, 'custom1')
    assert.ok(done, '发起腿同样要落那条历史行')
    assert.equal(done!.variables.isFirstTaskNode, true, 'start 直接后继 ⇒ 行级首节点标记为 true（建单不变量与 java 同规格）')
    assert.equal(String(done!.parentTaskId), '0', '发起 execution 无当前任务 ⇒ parentTaskId 落字符 0（issues/121 P1）')
    assert.equal((await h.mem.findInstanceById(inst.id))!.variables.custom_return_val, 'LEDGER-1', '返回值随续流写进实例变量')
  })
})



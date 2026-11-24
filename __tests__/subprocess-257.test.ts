/**
 * issues/257 子流程主链定向 T0（Node）。
 * 夹具全部内联，只用 MemoryRepository；不碰共享 flows、不起服务、不连 DB。
 */
import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import {
  canRejected,
  EngineImpl,
  ErrNotFoundProcessDefine,
  KeyAdminID,
  KeyAutoExecute,
  KeyNextNodeOperator,
  KeyProcessStartNextNodeOperator,
  KeySubmitType,
  loadFlowModel,
} from '../src/engine.js'
import { JeeflowFacade } from '../src/facade.js'
import { MemoryRepository } from '../src/memory.js'
import {
  KnownNodeTypes,
  SubProcessNodeTypes,
  TaskState,
  TaskType,
  TypeStart,
  TypeSubProcess,
  TypeSubProcessLower,
  TypeSubProcessWf,
  InstanceState,
  SubmitType,
  type ProcessDefine,
  type ProcessInstance,
  type ProcessTask,
  type SubProcessNode,
} from '../src/model.js'
import { EventType, type ProcessEvent } from '../src/extensions.js'
import { VAR_BRANCH_CTX, VAR_REAPPLY_CTX } from '../src/reapply.js'

class CountingRepository extends MemoryRepository {
  readonly saveCalls = new Map<string, number>()

  override async saveTask(task: ProcessTask): Promise<void> {
    this.saveCalls.set(task.id, (this.saveCalls.get(task.id) ?? 0) + 1)
    await super.saveTask(task)
  }
}

function setup() {
  const repo = new CountingRepository()
  let seq = 0n
  const idGen = { nextId: () => (2570000000000000n + seq++).toString() }
  const engine = new EngineImpl(
    repo,
    { async getUser(userId: string) { return { userId, realName: `用户-${userId}` } } },
    idGen,
    { async eval() { return false } },
  )
  const fired: ProcessEvent[] = []
  const endSnapshots: Array<{ event: ProcessEvent; persistedState?: number }> = []
  engine.setExtensions({
    listeners: [async (event) => {
      if (event.type === EventType.ProcessInstanceEnd) {
        const persisted = await repo.findInstanceById(event.instanceId)
        endSnapshots.push({ event: { ...event }, persistedState: persisted?.state })
      }
      fired.push({ ...event })
    }],
  })
  return { repo, engine, fired, endSnapshots, facade: new JeeflowFacade(engine, repo) }
}

const node = (id: string, type: string, properties: Record<string, any> = {}) =>
  ({ id, type, x: 0, y: 0, properties, text: { value: id } })
const edge = (id: string, sourceNodeId: string, targetNodeId: string) =>
  ({ id, sourceNodeId, targetNodeId, properties: {} })
const task = (id: string, assignee: string, extra: Record<string, any> = {}) =>
  node(id, 'snaker:task', { assignee, taskType: 0, performType: 0, ...extra })
const sub = (id: string, properties: Record<string, any> = {}, type = TypeSubProcess) =>
  node(id, type, properties)

function linear(name: string, nodes: any[]): string {
  return JSON.stringify({
    name, displayName: name, type: 'approval', nodes,
    edges: nodes.slice(1).map((n, i) => edge(`e-${name}-${i}`, nodes[i].id, n.id)),
  })
}

function childFlow(name: string, reviewId: string): string {
  return linear(name, [node('start', TypeStart), task('apply', 'applicant'), task(reviewId, 'leader'), node('end', 'snaker:end')])
}

function register(repo: MemoryRepository, id: string, name: string, version: number,
                  content: string, state = 1): ProcessDefine {
  const def: ProcessDefine = {
    id, name, displayName: name, type: 'approval', state, content, version,
    createTime: new Date(0), createUser: 'tester', updateTime: new Date(0), updateUser: 'tester',
  }
  repo.addDefine(def)
  return def
}

async function startAndAuto(repo: MemoryRepository, engine: EngineImpl, defineId: string,
                            args: Record<string, any> = {}): Promise<ProcessInstance> {
  const started = await engine.startProcessInstanceById(defineId, 'applicant', args)
  await engine.applyInitialTasks(started.id, 'applicant', args)
  return (await repo.findInstanceById(started.id))!
}

function onlyChild(repo: MemoryRepository, parentId: string): ProcessInstance {
  const children = repo.allInstances().filter(i => i.parentId === parentId)
  assert.equal(children.length, 1, `parent=${parentId} 应恰有一个子实例`)
  return children[0]
}

async function onlyDoing(repo: MemoryRepository, instanceId: string, name?: string): Promise<ProcessTask> {
  const rows = (await repo.findDoingTasks(instanceId)).filter(t => name == null || t.taskName === name)
  assert.equal(rows.length, 1, `instance=${instanceId} node=${name ?? '*'} 应恰有一条 DOING`)
  return rows[0]
}

function countEvent(events: ProcessEvent[], type: EventType, instanceId: string, taskId?: string): number {
  return events.filter(e => e.type === type && e.instanceId === instanceId &&
    (taskId == null || e.taskId === taskId)).length
}

describe('issues/257 子流程主链（Node 定向 T0）', () => {
  it('01 类型表与模型：三别名同值，processName→name→id，form 原样保留但不查找', () => {
    for (const type of SubProcessNodeTypes) assert.equal(KnownNodeTypes.has(type), true, type)
    const model = loadFlowModel(linear('parse257', [
      node('start', TypeStart),
      sub('byProcess', { processName: 'target', name: 'wrong', version: 2, form: '__wrong__' }, TypeSubProcess),
      sub('byName', { name: 'target', version: null }, TypeSubProcessLower),
      sub('byId', { subProcessName: 'ignored' }, TypeSubProcessWf),
      node('end', 'snaker:end'),
    ]))
    const byProcess = model.nodes.find(n => n.id === 'byProcess') as SubProcessNode
    const byName = model.nodes.find(n => n.id === 'byName') as SubProcessNode
    const byId = model.nodes.find(n => n.id === 'byId') as SubProcessNode
    assert.equal(byProcess.processName, 'target')
    assert.equal(byProcess.version, 2)
    assert.equal(byProcess.form, '__wrong__')
    assert.equal(byName.processName, 'target')
    assert.equal(byName.version, null)
    assert.equal(byId.processName, 'byId', 'subProcessName 不是新契约键')
  })

  it('02 定义选版：version desc/id desc、显式精确、无 state 过滤、form 不参与查找', async () => {
    const { repo, engine } = setup()
    register(repo, '2570100', 'target257', 3, childFlow('target-v3', 'reviewV3'), 0)
    register(repo, '2570102', 'target257', 2, childFlow('target-v2a', 'reviewV2A'), 0)
    register(repo, '2570103', 'target257', 2, childFlow('target-v2b', 'reviewV2B'), 1)
    register(repo, '2570199', 'target257', 1, childFlow('target-v1', 'reviewV1'), 1)

    const cases = [
      { id: '2570201', version: undefined, expected: '2570100', type: TypeSubProcess },
      { id: '2570202', version: 2, expected: '2570103', type: TypeSubProcessLower },
      { id: '2570203', version: 1, expected: '2570199', type: TypeSubProcessWf },
    ]
    for (const c of cases) {
      const props: Record<string, any> = { processName: 'target257', form: '__wrong__' }
      if (c.version !== undefined) props.version = c.version
      const parent = register(repo, c.id, `parent-${c.id}`, 1, linear(`parent-${c.id}`, [
        node('start', TypeStart), task('apply', 'applicant'), sub('sub257', props, c.type), node('end', 'snaker:end'),
      ]))
      const parentInst = await startAndAuto(repo, engine, parent.id)
      assert.equal(onlyChild(repo, parentInst.id).defineId, c.expected)
    }
    assert.equal((await repo.findDefineByNameAndVersion!('target257', null))!.id, '2570100')
  })

  it('03 缺失定义：20010002＋固定文案，直接出边预检在当前任务完成前且内存零写入', async () => {
    const { repo, engine, fired } = setup()
    const parent = register(repo, '2570301', 'parent-missing257', 1, linear('parent-missing257', [
      node('start', TypeStart), task('apply', 'applicant'),
      sub('subMissing', { processName: 'missing257', version: 1 }), node('end', 'snaker:end'),
    ]))
    const started = await engine.startProcessInstanceById(parent.id, 'applicant', {})
    const apply = await onlyDoing(repo, started.id, 'apply')
    const beforeTasks = (await repo.findHistoryTasks(started.id)).map(t => ({ id: t.id, state: t.taskState }))
    const beforeInstances = repo.allInstances().length
    const beforeEvents = fired.length
    const beforeSaves = repo.saveCalls.get(apply.id) ?? 0

    await assert.rejects(
      engine.executeProcessTask(apply.id, 'applicant', { [KeySubmitType]: SubmitType.Apply }),
      (err: any) => {
        assert.equal(err.code, ErrNotFoundProcessDefine)
        assert.equal(err.message, '子流程missing257定义不存在')
        return true
      },
    )
    assert.equal((await repo.findTaskById(apply.id))!.taskState, TaskState.Doing)
    assert.deepEqual((await repo.findHistoryTasks(started.id)).map(t => ({ id: t.id, state: t.taskState })), beforeTasks)
    assert.equal(repo.allInstances().length, beforeInstances)
    assert.equal(fired.length, beforeEvents)
    assert.equal(repo.saveCalls.get(apply.id) ?? 0, beforeSaves)
  })

  it('04 父子闭环：子申请自动办理、父 model/vars 回父、父子事件各一次且任务不重复', async () => {
    const { repo, engine, fired, endSnapshots, facade } = setup()
    const childDef = register(repo, '2570401', 'child257', 1, childFlow('child257', 'childReview'))
    const parentDef = register(repo, '2570402', 'parent257', 1, linear('parent257', [
      node('start', TypeStart), task('apply', 'applicant'),
      sub('sub257', { processName: 'child257', version: 1, form: '__wrong__' }),
      task('parentAfter', 'f_parentActor', { form: 'parent-form' }), node('end', 'snaker:end'),
    ]))

    const res = await facade.flow('processDefine/startAndExecute', {
      processDefineId: parentDef.id, operator: 'applicant', f_parentActor: 'parentManager',
    })
    assert.equal(res.code, 0, JSON.stringify(res))
    const parent = (await repo.findInstanceById(String(res.data.processInstanceId)))!
    const child = onlyChild(repo, parent.id)
    assert.equal(child.defineId, childDef.id)
    assert.equal(child.parentId, parent.id)
    assert.equal(child.parentNodeName, 'sub257')
    assert.equal(child.operator, 'applicant', 'flow.auto 启动子流程应回退父 operator')
    assert.equal(child.state, InstanceState.Doing)

    const childApply = (await repo.findDoneTasks(child.id, ['apply']))[0]
    const parentApply = (await repo.findDoneTasks(parent.id, ['apply']))[0]
    assert.equal(childApply.actorId, KeyAutoExecute)
    assert.equal(Number(childApply.variables[KeySubmitType]), SubmitType.Apply)
    assert.equal((await repo.findTaskActors(childApply.id)).includes('applicant'), true)
    const childReview = await onlyDoing(repo, child.id, 'childReview')
    assert.equal(await repo.findDoingTasks(parent.id, ['parentAfter']).then(rows => rows.length), 0)

    await engine.executeProcessTask(childReview.id, 'leader', {
      [KeySubmitType]: SubmitType.Agree, f_parentActor: 'childManager',
    })
    const parentAfter = await onlyDoing(repo, parent.id, 'parentAfter')
    assert.deepEqual(parentAfter.actorIds, ['childManager'], '回父执行沿用子流程最新 args')
    assert.equal(parentAfter.formKey, 'parent-form', '回父必须使用父 model')
    assert.equal((await repo.findInstanceById(parent.id))!.variables.f_parentActor, 'parentManager')
    assert.equal((await repo.findInstanceById(child.id))!.variables.f_parentActor, 'childManager')

    await engine.executeProcessTask(parentAfter.id, 'childManager', { [KeySubmitType]: SubmitType.Agree })
    assert.equal((await repo.findInstanceById(child.id))!.state, InstanceState.Done)
    assert.equal((await repo.findInstanceById(parent.id))!.state, InstanceState.Done)
    for (const instanceId of [parent.id, child.id]) {
      assert.equal(countEvent(fired, EventType.ProcessInstanceStart, instanceId), 1)
      assert.equal(countEvent(fired, EventType.ProcessInstanceEnd, instanceId), 1)
    }
    for (const [instanceId, taskId] of [
      [parent.id, parentApply.id], [child.id, childApply.id], [child.id, childReview.id], [parent.id, parentAfter.id],
    ] as Array<[string, string]>) {
      assert.equal(countEvent(fired, EventType.ProcessTaskStart, instanceId, taskId), 1)
      assert.equal(repo.saveCalls.get(taskId), 1, `task=${taskId} 不得重复 saveTask`)
    }
    for (const snapshot of endSnapshots) {
      assert.equal(snapshot.persistedState, snapshot.event.state, '终态事件必须在落库后播')
    }
  })

  it('05 operator 回退与隔离：auto/admin→父 operator，真实人保留；子任务不并入父返回', async () => {
    const { repo, engine, fired } = setup()
    register(repo, '2570501', 'child-ops257', 1, childFlow('child-ops257', 'childReview'))
    const parentDef = register(repo, '2570502', 'parent-ops257', 1, linear('parent-ops257', [
      node('start', TypeStart), task('apply', 'applicant'), task('trigger', 'manager'),
      sub('sub257', { processName: 'child-ops257', version: 1 }), node('end', 'snaker:end'),
    ]))
    const parentArgs = {
      f_keep: 'yes', [KeySubmitType]: 99,
      [KeyProcessStartNextNodeOperator]: 'bad-start-next',
      tf_parentControl: 'bad-task-control', [VAR_BRANCH_CTX]: { bad: true }, [VAR_REAPPLY_CTX]: { bad: true },
    }
    for (const [operator, expected] of [
      [KeyAutoExecute, 'applicant'], [KeyAdminID, 'applicant'], ['manager', 'manager'],
    ] as Array<[string, string]>) {
      const started = await engine.startProcessInstanceById(parentDef.id, 'applicant', parentArgs)
      const initialCreated = await engine.applyInitialTasks(started.id, 'applicant', {})
      assert.equal(initialCreated.length, 1, '父申请推进只应返回父 trigger')
      assert.equal(initialCreated[0].processInstanceId, started.id)
      const trigger = await onlyDoing(repo, started.id, 'trigger')
      const created = await engine.executeProcessTask(trigger.id, operator, {
        [KeySubmitType]: SubmitType.Agree, [KeyNextNodeOperator]: 'bad-trigger-next',
        tf_comment: 'bad', f_nextNodeOperator: 'bad2',
      })
      assert.deepEqual(created, [], '子任务已自行持久化，不得并入父 execution 产出')
      const child = onlyChild(repo, started.id)
      assert.equal(child.operator, expected)
      assert.equal(child.variables.f_keep, 'yes')
      assert.equal(Number(child.variables[KeySubmitType]), SubmitType.Apply, '父 submitType 已剥除，子自办重写 0')
      for (const key of [
        KeyProcessStartNextNodeOperator, KeyNextNodeOperator, 'tf_parentControl', 'tf_comment', 'f_nextNodeOperator',
        VAR_BRANCH_CTX, VAR_REAPPLY_CTX,
      ]) assert.equal(Object.prototype.hasOwnProperty.call(child.variables, key), false, key)
      const apply = (await repo.findDoneTasks(child.id, ['apply']))[0]
      const review = await onlyDoing(repo, child.id, 'childReview')
      assert.equal(repo.saveCalls.get(apply.id), 1)
      assert.equal(repo.saveCalls.get(review.id), 1)
      assert.equal(countEvent(fired, EventType.ProcessTaskStart, child.id, apply.id), 1)
      assert.equal(countEvent(fired, EventType.ProcessTaskStart, child.id, review.id), 1)
    }
  })

  it('06 无 apply 也自办：初始 DOING 快照加 applicant，submitType=0/flow.auto，保留真审批待办', async () => {
    const { repo, engine } = setup()
    register(repo, '2570601', 'child-no-apply257', 1, linear('child-no-apply257', [
      node('start', TypeStart), task('first257', 'leader'), task('second257', 'manager'), node('end', 'snaker:end'),
    ]))
    const parentDef = register(repo, '2570602', 'parent-no-apply257', 1, linear('parent-no-apply257', [
      node('start', TypeStart), task('apply', 'applicant'),
      sub('sub257', { processName: 'child-no-apply257', version: 1 }), node('end', 'snaker:end'),
    ]))
    const parent = await startAndAuto(repo, engine, parentDef.id)
    const child = onlyChild(repo, parent.id)
    const first = (await repo.findDoneTasks(child.id, ['first257']))[0]
    assert.equal(first.actorId, KeyAutoExecute)
    assert.equal(Number(first.variables[KeySubmitType]), SubmitType.Apply)
    assert.deepEqual(new Set(await repo.findTaskActors(first.id)), new Set(['leader', 'applicant']))
    await onlyDoing(repo, child.id, 'second257')
  })

  it('07 子结束主办守卫：仍有主办 DOING 时拒绝结束且不回父，办完后可正常闭环', async () => {
    const { repo, engine, fired } = setup()
    register(repo, '2570701', 'child-fork257', 1, JSON.stringify({
      name: 'child-fork257', displayName: 'child-fork257', type: 'approval',
      nodes: [node('start', TypeStart), task('apply', 'applicant'), node('fork', 'snaker:fork'),
        task('reviewA', 'userA'), task('reviewB', 'userB'), node('end', 'snaker:end')],
      edges: [edge('e1', 'start', 'apply'), edge('e2', 'apply', 'fork'), edge('e3', 'fork', 'reviewA'),
        edge('e4', 'fork', 'reviewB'), edge('e5', 'reviewA', 'end'), edge('e6', 'reviewB', 'end')],
    }))
    const parentDef = register(repo, '2570702', 'parent-fork257', 1, linear('parent-fork257', [
      node('start', TypeStart), task('apply', 'applicant'),
      sub('sub257', { processName: 'child-fork257', version: 1 }), task('parentAfter', 'manager'), node('end', 'snaker:end'),
    ]))
    const parent = await startAndAuto(repo, engine, parentDef.id)
    const child = onlyChild(repo, parent.id)
    const reviewA = await onlyDoing(repo, child.id, 'reviewA')
    const reviewB = await onlyDoing(repo, child.id, 'reviewB')
    await assert.rejects(
      engine.executeProcessTask(reviewA.id, 'userA', { [KeySubmitType]: SubmitType.Agree }),
      /存在未完成的主办任务,请确认\./,
    )
    assert.equal((await repo.findInstanceById(child.id))!.state, InstanceState.Doing)
    assert.equal((await repo.findTaskById(reviewA.id))!.taskState, TaskState.Done)
    assert.equal((await repo.findTaskById(reviewB.id))!.taskState, TaskState.Doing)
    assert.equal(countEvent(fired, EventType.ProcessInstanceEnd, child.id), 0)
    assert.equal((await repo.findDoingTasks(parent.id, ['parentAfter'])).length, 0)

    await engine.executeProcessTask(reviewB.id, 'userB', { [KeySubmitType]: SubmitType.Agree })
    assert.equal((await repo.findInstanceById(child.id))!.state, InstanceState.Done)
    await onlyDoing(repo, parent.id, 'parentAfter')
    assert.equal(countEvent(fired, EventType.ProcessInstanceEnd, child.id), 1)
  })

  it('08 子结束协办清结：剩余协办由 flow.auto 办结，终态落库后播且回父一次', async () => {
    const { repo, engine, fired, endSnapshots } = setup()
    register(repo, '2570801', 'child-aidant257', 1, childFlow('child-aidant257', 'childReview'))
    const parentDef = register(repo, '2570802', 'parent-aidant257', 1, linear('parent-aidant257', [
      node('start', TypeStart), task('apply', 'applicant'),
      sub('sub257', { processName: 'child-aidant257', version: 1 }), task('parentAfter', 'manager'), node('end', 'snaker:end'),
    ]))
    const parent = await startAndAuto(repo, engine, parentDef.id)
    const child = onlyChild(repo, parent.id)
    const aggregate = (await repo.findInstanceById(child.id))!
    const doneApply = (await repo.findDoneTasks(child.id, ['apply']))[0]
    const aidant = aggregate.createTask('2570999', 'apply', '遗留协办', 'helper', 'leader', '',
      new Date(), doneApply.id, true)
    aidant.taskType = TaskType.Secondary
    await repo.saveTask(aidant)

    const review = await onlyDoing(repo, child.id, 'childReview')
    await engine.executeProcessTask(review.id, 'leader', { [KeySubmitType]: SubmitType.Agree })
    const persistedAidant = (await repo.findTaskById(aidant.id))!
    assert.equal(persistedAidant.taskState, TaskState.Done)
    assert.equal(persistedAidant.actorId, KeyAutoExecute)
    assert.equal(countEvent(fired, EventType.TaskComplete, child.id, aidant.id), 1)
    assert.equal((await repo.findInstanceById(child.id))!.state, InstanceState.Done)
    await onlyDoing(repo, parent.id, 'parentAfter')
    assert.equal(countEvent(fired, EventType.ProcessTaskStart, parent.id,
      (await repo.findDoingTasks(parent.id, ['parentAfter']))[0].id), 1)
    const childEnd = endSnapshots.find(s => s.event.instanceId === child.id)
    assert.ok(childEnd)
    assert.equal(childEnd.persistedState, InstanceState.Done)
  })

  it('09 子拒绝也回父：child=45、父推进一次，父子终态事件不重复', async () => {
    const { repo, engine, fired } = setup()
    register(repo, '2570901', 'child-reject257', 1, childFlow('child-reject257', 'childReview'))
    const parentDef = register(repo, '2570902', 'parent-reject257', 1, linear('parent-reject257', [
      node('start', TypeStart), task('apply', 'applicant'),
      sub('sub257', { processName: 'child-reject257', version: 1 }), task('parentAfter', 'manager'), node('end', 'snaker:end'),
    ]))
    const parent = await startAndAuto(repo, engine, parentDef.id)
    const child = onlyChild(repo, parent.id)
    const review = await onlyDoing(repo, child.id, 'childReview')
    await engine.executeAndJumpToEnd(review.id, 'leader', { [KeySubmitType]: SubmitType.Reject })
    assert.equal((await repo.findInstanceById(child.id))!.state, InstanceState.Reject)
    const parentAfter = await onlyDoing(repo, parent.id, 'parentAfter')
    assert.equal(countEvent(fired, EventType.ProcessInstanceEnd, child.id), 1)
    assert.equal(countEvent(fired, EventType.ProcessTaskStart, parent.id, parentAfter.id), 1)
    assert.equal(countEvent(fired, EventType.ProcessInstanceEnd, parent.id), 0)

    await engine.executeProcessTask(parentAfter.id, 'manager', { [KeySubmitType]: SubmitType.Agree })
    assert.equal((await repo.findInstanceById(parent.id))!.state, InstanceState.Done)
    assert.equal(countEvent(fired, EventType.ProcessInstanceEnd, parent.id), 1)
    assert.equal(countEvent(fired, EventType.ProcessInstanceEnd, child.id), 1)
  })

  it('10 canRejected：跳过 SubProcessModel，且会签父节点不可退', () => {
    const subBoundary = loadFlowModel(linear('guard257', [
      node('start', TypeStart), task('apply', 'applicant'),
      sub('subGuard', { processName: 'child257' }), task('after', 'manager'), node('end', 'snaker:end'),
    ]))
    assert.equal(canRejected(subBoundary, 'after', 'apply'), false)

    const countersign = loadFlowModel(linear('cs257', [
      node('start', TypeStart), task('apply', 'applicant'),
      task('cs', 'leader', { performType: 1 }), task('after', 'manager'), node('end', 'snaker:end'),
    ]))
    assert.equal(canRejected(countersign, 'after', 'cs'), false)
    assert.equal(canRejected(countersign, 'after', 'apply'), true)
  })

  it('11 子申请即办结：回父新任务进入父返回，父子抄送各一次且终态落库后播', async () => {
    const { repo, engine, fired, endSnapshots } = setup()
    register(repo, '2571101', 'child-instant257', 1, linear('child-instant257', [
      node('start', TypeStart), task('apply', 'applicant'), node('end', 'snaker:end'),
    ]))
    const parentDef = register(repo, '2571102', 'parent-instant257', 1, linear('parent-instant257', [
      node('start', TypeStart), task('apply', 'applicant'),
      sub('sub257', { processName: 'child-instant257', version: 1 }), task('parentAfter', 'manager'), node('end', 'snaker:end'),
    ]))
    const started = await engine.startProcessInstanceById(parentDef.id, 'applicant', { f_ccActors: 'cc1' })
    const apply = await onlyDoing(repo, started.id, 'apply')
    const created = await engine.executeProcessTask(apply.id, 'applicant', { [KeySubmitType]: SubmitType.Apply })
    const child = onlyChild(repo, started.id)
    const parentAfter = await onlyDoing(repo, started.id, 'parentAfter')
    assert.deepEqual(created.map(t => t.id), [parentAfter.id])
    assert.equal((await repo.findInstanceById(child.id))!.state, InstanceState.Done)
    assert.equal((await repo.findInstanceById(started.id))!.state, InstanceState.Doing)
    for (const instanceId of [started.id, child.id]) {
      assert.equal(countEvent(fired, EventType.ProcessInstanceStart, instanceId), 1)
      assert.equal(countEvent(fired, EventType.CcCreate, instanceId), 1)
    }
    assert.equal(countEvent(fired, EventType.ProcessInstanceEnd, child.id), 1)
    assert.equal(countEvent(fired, EventType.ProcessInstanceEnd, started.id), 0)
    assert.equal(repo.saveCalls.get(parentAfter.id), 1)
    for (const snapshot of endSnapshots) assert.equal(snapshot.persistedState, snapshot.event.state)
  })
})

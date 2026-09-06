// T003：业务数据种子 driver——引擎真实启动（startAndExecute + execute），不直插 repo。
// 矩阵 = 八语言共用 canonical（day-shift 已在 Rust demo 实测全绿，照 rust seed_business.rs 移植）：
// 16 进行中(state=10) + 9 已完成(advance 推到 state=20) + 8 委托。
// 8 用户 × 5 菜单（待办/已办/发起/抄送/委托）全覆盖。
import type { JeeflowFacade as Facade } from '../src/facade.js'

type Row = {
  defineId: string  // Node 引擎 id 约定为 string
  operator: string
  extra?: Record<string, unknown>
  cc?: string[]
}

// 进行中 16 条：发起后停 state=10（I3/I15 冻结在决策/驳回前，I14 发起后再办两节点停 boss）
const IN_PROGRESS: Row[] = [
  { defineId: '1', operator: 'user1', cc: ['userA', 'userB'] },
  { defineId: '2', operator: 'user1' },
  { defineId: '3', operator: 'userA', extra: { amount: 500 } },
  { defineId: '4', operator: 'manager', cc: ['userC', 'leader'] },
  { defineId: '5', operator: 'userB' },
  { defineId: '6', operator: 'director', cc: ['manager', 'boss'] },
  { defineId: '7', operator: 'userC', cc: ['user1'] },
  { defineId: '1', operator: 'boss' },
  { defineId: '12', operator: 'user1', extra: { deptLeader: 'manager' } },
  { defineId: '12', operator: 'userC', extra: { deptLeader: 'director' } },
  { defineId: '12', operator: 'userB', extra: { deptLeader: 'user1' } },
  { defineId: '15', operator: 'userA', cc: ['boss'] },
  { defineId: '14', operator: 'leader', cc: ['director', 'userC'] },
  { defineId: '2', operator: 'userA' }, // I14 发起后再办 leader/manager → 停 boss
  { defineId: '10', operator: 'userB' },
  { defineId: '8', operator: 'user1' },
]

// 已完成 9 条：advance 推到 state=20（分支无关）
const FINISHED: Row[] = [
  { defineId: '1', operator: 'userA', cc: ['user1', 'director'] },
  { defineId: '8', operator: 'userB', cc: ['boss', 'manager'] },
  { defineId: '2', operator: 'manager', cc: ['boss'] },
  { defineId: '10', operator: 'director' },
  { defineId: '12', operator: 'userC', extra: { deptLeader: 'leader' } },
  { defineId: '1', operator: 'director' },
  { defineId: '5', operator: 'manager' },
  { defineId: '12', operator: 'userA', extra: { deptLeader: 'director' } },
  { defineId: '12', operator: 'userB', extra: { deptLeader: 'user1' } },
]

// 委托 8 条：processSurrogate/page 无 operator 过滤 → 8 用户委托菜单全非空
const SURROGATES: Array<[string, string]> = [
  ['user1', 'userA'], ['userA', 'userB'], ['userB', 'userC'], ['userC', 'leader'],
  ['leader', 'manager'], ['manager', 'director'], ['director', 'boss'], ['boss', 'user1'],
]

type Resp = Record<string, any>

function isOk(r: Resp | undefined): boolean {
  return !!r && Number(r.code) === 0
}

async function startInstance(f: Facade, row: Row): Promise<unknown> {
  const resp: Resp = await f.flow('processDefine/startAndExecute', {
    processDefineId: row.defineId, operator: row.operator, ...(row.extra ?? {}),
  })
  if (!isOk(resp)) {
    console.error(`[seed] startAndExecute define=${row.defineId} op=${row.operator} 失败:`, resp)
    return undefined
  }
  return (resp.data ?? {}).processInstanceId
}

async function addCC(f: Facade, iid: unknown, op: string, cc: string[]): Promise<void> {
  const resp: Resp = await f.flow('processInstance/createCCInstance', {
    processInstanceId: iid, operator: op, actorIds: cc,
  })
  if (!isOk(resp)) console.error(`[seed] createCCInstance iid=${iid} 失败:`, resp)
}

// advance 原语：循环读 detail，对每个 doing 任务以其自身 actor execute(submitType=1)。
// doing 任务 operator 为 null，actor 取 taskActorIdList[0]。
async function advance(f: Facade, iid: unknown): Promise<number> {
  for (let i = 0; i < 30; i++) {
    const resp: Resp = await f.flow('processInstance/detail', { id: iid })
    const data = (resp.data ?? {}) as Record<string, any>
    const state = Number(data.state ?? 0)
    if (state !== 10) return state
    const doing = (data.tasks ?? []).filter((t: Record<string, any>) => Number(t.taskState) === 10)
    if (doing.length === 0) return state
    let progress = false
    for (const t of doing) {
      const actor = (t.operator as string) || ((t.taskActorIdList ?? [])[0] as string | undefined)
      if (!actor) continue
      const r: Resp = await f.flow('processTask/execute', {
        processTaskId: t.id, operator: actor, submitType: 1,
      })
      if (isOk(r)) progress = true
      else console.error(`[seed] advance execute iid=${iid} actor=${actor} 失败:`, r)
    }
    if (!progress) return state
  }
  const resp: Resp = await f.flow('processInstance/detail', { id: iid })
  return Number((resp.data ?? {}).state ?? 0)
}

// 仅 I14 用：在该实例里找 op 的 doing 任务行
async function todoRow(f: Facade, op: string, iid: unknown): Promise<Record<string, any> | undefined> {
  const resp: Resp = await f.flow('processTask/todoList', { operator: op, pageNum: 1, pageSize: 200 })
  const rows = (resp.data ?? {}).rows ?? []
  return rows.find((r: Record<string, any>) =>
    String(r.processInstanceId) === String(iid) && Number(r.taskState) === 10)
}

// 种业务数据；失败逐条打日志不抛异常（demo 启动不被单条卡死）。
export async function seedBusiness(f: Facade): Promise<void> {
  let okIn = 0, okFin = 0, okSurr = 0
  for (const row of IN_PROGRESS) {
    const iid = await startInstance(f, row)
    if (iid === undefined) continue
    // I14：发起后再办 leader、manager 两节点 → 停在 boss
    if (row.defineId === '2' && row.operator === 'userA') {
      for (const actor of ['leader', 'manager']) {
        const t = await todoRow(f, actor, iid)
        if (t) await f.flow('processTask/execute', { processTaskId: t.id, operator: actor, submitType: 1 })
        else console.error(`[seed] I14 todoRow actor=${actor} iid=${iid} 未找到`)
      }
    }
    if (row.cc?.length) await addCC(f, iid, row.operator, row.cc)
    okIn++
  }
  for (const row of FINISHED) {
    const iid = await startInstance(f, row)
    if (iid === undefined) continue
    const state = await advance(f, iid)
    if (state !== 20) console.error(`[seed] FIN define=${row.defineId} op=${row.operator} iid=${iid} 终态=${state}（期望 20）`)
    if (row.cc?.length) await addCC(f, iid, row.operator, row.cc)
    okFin++
  }
  for (const [op, surrogate] of SURROGATES) {
    const resp: Resp = await f.flow('processSurrogate/save', {
      operator: op, surrogate, processName: '',
      startTime: '2026-01-01 00:00:00', endTime: '2027-12-31 23:59:59',
    })
    if (isOk(resp)) okSurr++
    else console.error(`[seed] surrogate ${op}->${surrogate} 失败:`, resp)
  }
  console.log(`[seedBusiness] done: in-progress ${okIn}/16, finished ${okFin}/9, surrogates ${okSurr}/8`)
}

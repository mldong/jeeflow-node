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

// 申请信息表单：f_ 前缀 = 实例变量，前端「申请信息」区按 apply 节点 formKey 取 f_* 回显。
// 键 = defineId（13 = 11-assignment-handler 无 apply 节点，故表里没有 '13'）。
// ⚠️ 八语言 demo 必须同表同值同序——跨栈字节级一致是生态硬规则，勿改措辞、勿重排。
// ⚠️ 日期写死字面量，绝不按当前时钟算：八栈跑的机器时区/系统时间各异，
//    算出来的日期会漂移，横评时数据就不再可比。
// ⚠️ 字段名严禁叫 amount / finalAmount：它们是 03-decision-expr、10-mixed-mode
//    条件表达式里的判定变量（IN_PROGRESS/FINISHED 的 extra.amount 走的就是这条线），
//    撞上会改变流程走向。
const FORM_BY_DEFINE: Record<string, Record<string, unknown>> = {
  '1': { f_reason: '家中有事需请假', f_days: 3, f_leaveType: 'annual', f_startDate: '2026-09-01', f_endDate: '2026-09-03' },
  '2': { f_reason: '项目上线后调休', f_days: 2, f_leaveType: 'annual', f_startDate: '2026-09-07', f_endDate: '2026-09-08' },
  '3': { f_reason: '出差报销申请', f_days: 1, f_leaveType: 'personal', f_startDate: '2026-09-10', f_endDate: '2026-09-10' },
  '4': { f_reason: '培训进修请假', f_days: 5, f_leaveType: 'sick', f_startDate: '2026-09-14', f_endDate: '2026-09-18' },
  '5': { f_reason: '年假出行', f_days: 4, f_leaveType: 'annual', f_startDate: '2026-09-21', f_endDate: '2026-09-24' },
  '6': { f_reason: '婚假申请', f_days: 10, f_leaveType: 'personal', f_startDate: '2026-09-28', f_endDate: '2026-10-07' },
  '7': { f_reason: '病假休养', f_days: 6, f_leaveType: 'sick', f_startDate: '2026-10-12', f_endDate: '2026-10-17' },
  '8': { f_reason: '产检假', f_days: 3, f_leaveType: 'sick', f_startDate: '2026-10-19', f_endDate: '2026-10-21' },
  '9': { f_reason: '陪产假', f_days: 5, f_leaveType: 'personal', f_startDate: '2026-10-26', f_endDate: '2026-10-30' },
  '10': { f_reason: '事假处理家务', f_days: 2, f_leaveType: 'personal', f_startDate: '2026-11-02', f_endDate: '2026-11-03' },
  '11': { f_bizType: 'purchase', f_budget: 12000, f_urgency: 'normal', f_desc: '采购一批开发板与传感器' },
  '12': { f_reason: '部门例行调休', f_days: 1, f_leaveType: 'annual', f_startDate: '2026-11-09', f_endDate: '2026-11-09' },
  '14': { f_reason: '外派学习请假', f_days: 7, f_leaveType: 'annual', f_startDate: '2026-11-16', f_endDate: '2026-11-22' },
  '15': { f_reason: '丧假', f_days: 3, f_leaveType: 'personal', f_startDate: '2026-11-23', f_endDate: '2026-11-25' },
}

// 办理表单：tf_ 前缀 = 任务变量，前端「办理表单」区读 taskFormData 回显。
// 键 = 审批节点的 formKey（properties.form）；表里没有的 formKey 只落通用意见，不臆造字段。
// 同样八栈同表同值——勿改勿重排。
const TF_BY_FORM: Record<string, Record<string, unknown>> = {
  'leave-form': { tf_approvedDays: 3, tf_needExtra: 'no', tf_remark: '按项目排期核准，注意工作交接' },
  'review-form': { tf_riskLevel: 'low', tf_needLegalDoc: 'no', tf_reviewOpinion: '条款与预算均无风险' },
  'boss-form': { tf_finalDecision: 'agree', tf_finalAmount: 8000, tf_bossNote: '同意，走年度预算' },
  'check-form': { tf_invoiceOk: 'yes', tf_amountChecked: 8000, tf_checkNote: '票据齐全，计入差旅科目' },
  'countersign-form': { tf_signVote: 'support', tf_signAmount: 5000, tf_signOpinion: '本条线无异议' },
  'seq-form': { tf_seqStage: 'first', tf_seqVote: 'pass', tf_seqOpinion: '初审通过，转下一人' },
  'approve-form': { tf_approveResult: 'ok', tf_approveAmount: 8000, tf_approveNote: '审批通过' },
  'ratio-form': { tf_ratioVote: 'agree', tf_ratioOpinion: '达到比例即可通过' },
  'veto-form': { tf_vetoResult: 'pass', tf_vetoReason: '无异议' },
  'form-a': { tf_branchA: 'a1', tf_branchANote: 'A 分支选方案 A1' },
  'form-b': { tf_branchB: 'b1', tf_branchBNote: 'B 分支选方案 B1' },
  'field-form': { tf_ownerName: '张三', tf_field: 'tech', tf_fieldNote: '技术域评估通过' },
  'operator-form': { tf_selfCheck: 'done', tf_operatorNote: '发起人自查无误' },
  'dept-form': { tf_deptAgree: 'yes', tf_deptQuota: 8000, tf_deptNote: '同意占用本部门额度' },
  'role-form': { tf_roleResult: 'pass', tf_roleNote: '角色审批通过' },
}

type Resp = Record<string, any>

function isOk(r: Resp | undefined): boolean {
  return !!r && Number(r.code) === 0
}

// 办理表单落库：先给通用意见，再按该节点的 formKey 覆盖专属字段。
// 抽成 helper 是因为两处 execute 调用点（advance 循环 / I14 特例）必须同口径，
// 否则八栈横评里同一节点会填出不一样的数据。
function withTaskForm(ex: Record<string, unknown>, formKey: unknown): void {
  ex.tf_approvalComment = '同意，情况已核实'
  Object.assign(ex, TF_BY_FORM[String(formKey ?? '')] ?? {})
}

async function startInstance(f: Facade, row: Row): Promise<unknown> {
  const resp: Resp = await f.flow('processDefine/startAndExecute', {
    processDefineId: row.defineId, operator: row.operator,
    // 先铺申请信息，再铺 row.extra：已有的流程变量（amount / deptLeader）优先，不被表单值盖掉
    ...(FORM_BY_DEFINE[String(row.defineId)] ?? {}), ...(row.extra ?? {}),
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
      const ex: Record<string, unknown> = { processTaskId: t.id, operator: actor, submitType: 1 }
      withTaskForm(ex, t.formKey)
      const r: Resp = await f.flow('processTask/execute', ex)
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
        if (t) {
          // todoList 行同样带 formKey（facade taskRowToMap），照 advance 同口径填办理表单
          const ex: Record<string, unknown> = { processTaskId: t.id, operator: actor, submitType: 1 }
          withTaskForm(ex, t.formKey)
          await f.flow('processTask/execute', ex)
        }
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

import { TaskState } from './model.js'
import type { CcInstanceRow, DefineRow, InstanceRow, TaskRow, ProcessDefine } from './model.js'
import { cloneInstance, cloneTask, type ProcessInstance, type ProcessTask } from './model.js'
import type { ProcessRepository, QueryCondition } from './spi.js'

// ═══ 条件匹配基建（issues/05-5，对齐 JDBC 白名单语义） ═══

// 行字段映射（列名 → 行属性，白名单列均可匹配）
const TASK_FIELDS: Record<string, string> = {
  't.id': 'id', 't.task_name': 'taskName', 't.display_name': 'displayName',
  't.task_type': 'taskType', 't.perform_type': 'performType', 't.task_state': 'taskState',
  't.operator': 'operator', 't.form_key': 'formKey', 't.create_time': 'createTime',
  't.finish_time': 'finishTime', 't.expire_time': 'expireTime',
  't.process_instance_id': 'processInstanceId', 't.task_parent_id': 'taskParentId',
  'pd.name': 'processDefineName', 'pd.display_name': 'processDefineDisplayName',
  'pd.version': 'defineVersion',
}

const INSTANCE_FIELDS: Record<string, string> = {
  't.id': 'id', 't.parent_id': 'parentId', 't.process_define_id': 'defineId',
  't.state': 'state', 't.parent_node_name': 'parentNodeName', 't.business_no': 'businessNo',
  't.operator': 'operator', 't.expire_time': 'expireTime', 't.create_time': 'createTime',
  'pd.name': 'defineName', 'pd.display_name': 'defineDisplayName', 'pd.version': 'defineVersion',
}

const DEFINE_FIELDS: Record<string, string> = {
  't.id': 'id', 't.name': 'name', 't.display_name': 'displayName', 't.type': 'type',
  't.state': 'state', 't.version': 'version', 't.create_time': 'createTime',
  't.update_time': 'updateTime',
}

/** 行字段提取（列名 → 值） */
function pickFields(row: any, map: Record<string, string>): Record<string, any> {
  const fields: Record<string, any> = {}
  for (const [col, key] of Object.entries(map)) {
    fields[col] = row[key]
  }
  return fields
}

/** 条件全匹配（操作符对齐 JDBC buildWhere；列不在字段中则跳过） */
export function matchConditions(conditions: QueryCondition[] | undefined, fields: Record<string, any>): boolean {
  for (const c of conditions ?? []) {
    const v = fields[c.column]
    const expect = c.value
    if (v == null || expect == null) continue
    switch (c.operator.toUpperCase()) {
      case 'EQ': if (!eqValue(v, expect)) return false; break
      case 'NE': if (eqValue(v, expect)) return false; break
      case 'LIKE': if (!String(v).includes(String(expect))) return false; break
      case 'LLIKE': if (!String(v).endsWith(String(expect))) return false; break
      case 'RLIKE': if (!String(v).startsWith(String(expect))) return false; break
      case 'GT': if (Number(v) <= Number(expect)) return false; break
      case 'GE': if (Number(v) < Number(expect)) return false; break
      case 'LT': if (Number(v) >= Number(expect)) return false; break
      case 'LE': if (Number(v) > Number(expect)) return false; break
      case 'IN': if (!Array.isArray(expect) || !expect.includes(v)) return false; break
      case 'NIN': if (Array.isArray(expect) && expect.includes(v)) return false; break
    }
  }
  return true
}

/** EQ：值或集合包含判断（pta.actor_id/cc.actor_id 为数组） */
export function eqValue(v: any, expect: any): boolean {
  if (Array.isArray(v)) return v.includes(expect)
  return String(v) === String(expect)
}

export class MemoryRepository implements ProcessRepository {
  private defines  = new Map<string, ProcessDefine>()
  private instances = new Map<string, ProcessInstance>()
  private tasks    = new Map<string, ProcessTask>()
  private actors   = new Map<string, string[]>()
  private ccInstances = new Map<string, string[]>()
  private seq = 1

  addDefine(def: ProcessDefine) {
    if (!def.id) def.id = String(this.seq++)
    this.defines.set(def.id, def)
  }

  async findDefineById(id: string) { return this.defines.get(id) ?? null }

  // findDefineByName 按流程编码查最新一条定义（id 倒序取首条，v1.1.0）
  async findDefineByName(name: string) {
    let latest: ProcessDefine | null = null
    for (const d of this.defines.values()) {
      // BigInt 比较：id 为 string（issue 38 E9），大整数数字比较不可靠
      if (d.name === name && (!latest || BigInt(d.id) > BigInt(latest.id))) latest = d
    }
    return latest
  }

  // ── 定义写操作（v1.0.1，对齐 SPI）──

  async saveDefine(def: ProcessDefine) {
    if (!def.id) def.id = String(this.seq++)
    this.defines.set(def.id, def)
  }
  async updateDefine(def: ProcessDefine) {
    this.defines.set(def.id, def)
  }
  async updateDefineState(defineId: string, state: number) {
    const d = this.defines.get(defineId)
    if (d) d.state = state
  }
  async removeDefine(defineId: string) {
    this.defines.delete(defineId)
  }

  async saveInstance(inst: ProcessInstance) {
    if (!inst.id) inst.id = String(this.seq++)
    const cp = cloneInstance(inst)
    cp.tasks = []
    this.instances.set(inst.id, cp)
  }
  async updateInstance(inst: ProcessInstance) {
    const cp = cloneInstance(inst)
    cp.tasks = []
    this.instances.set(inst.id, cp)
    // v1.0.1：级联保存聚合根内任务状态变更
    for (const t of (inst.tasks ?? [])) {
      if (!t.id) continue
      const tc = cloneTask(t)
      tc.actorIds = []
      this.tasks.set(t.id, tc)
      if (t.actorIds?.length) this.actors.set(t.id, [...t.actorIds])
    }
  }
  async findInstanceById(id: string) {
    const inst = this.instances.get(id)
    if (!inst) return null
    const cp = cloneInstance(inst)
    cp.tasks = []
    for (const t of this.tasks.values()) {
      if (t.processInstanceId === id) {
        const tc = cloneTask(t)
        tc.actorIds = this.actors.get(t.id) ?? t.actorIds
        cp.tasks.push(tc)
      }
    }
    return cp
  }

  async findTaskById(id: string) {
    const t = this.tasks.get(id)
    if (!t) return null
    const cp = cloneTask(t)
    cp.actorIds = this.actors.get(id) ?? t.actorIds
    return cp
  }
  async saveTask(task: ProcessTask) {
    if (!task.id) task.id = String(this.seq++)
    const cp = cloneTask(task)
    cp.actorIds = []
    this.tasks.set(task.id, cp)
    if (task.actorIds?.length) this.actors.set(task.id, [...task.actorIds])
  }
  async updateTask(task: ProcessTask) {
    const cp = cloneTask(task)
    cp.actorIds = []
    this.tasks.set(task.id, cp)
    if (task.actorIds?.length) this.actors.set(task.id, [...task.actorIds])
  }
  async findDoingTasks(instanceId: string, taskNames?: string[]) {
    const result: ProcessTask[] = []
    for (const t of this.tasks.values()) {
      if (t.processInstanceId === instanceId && t.taskState === 10) {
        if (taskNames?.length && !taskNames.includes(t.taskName)) continue
        const cp = cloneTask(t)
        cp.actorIds = this.actors.get(t.id) ?? t.actorIds
        result.push(cp)
      }
    }
    return result
  }
  async findDoneTasks(instanceId: string, _taskNames?: string[]) {
    const result: ProcessTask[] = []
    for (const t of this.tasks.values()) {
      if (t.processInstanceId === instanceId && t.taskState === 20) {
        const cp = cloneTask(t)
        cp.actorIds = this.actors.get(t.id) ?? t.actorIds
        result.push(cp)
      }
    }
    return result
  }
  async findHistoryTasks(instanceId: string) {
    const result: ProcessTask[] = []
    for (const t of this.tasks.values()) {
      if (t.processInstanceId === instanceId) {
        const cp = cloneTask(t)
        cp.actorIds = this.actors.get(t.id) ?? t.actorIds
        result.push(cp)
      }
    }
    return result
  }
  async findTaskActors(taskId: string) { return this.actors.get(taskId) ?? [] }
  async addTaskActor(taskId: string, actors: string[]) {
    const existing = this.actors.get(taskId) ?? []
    const seen = new Set(existing)
    for (const a of actors) { if (!seen.has(a)) { existing.push(a); seen.add(a) } }
    this.actors.set(taskId, existing)
  }
  async removeTaskActor(taskId: string, actors: string[]) {
    const remove = new Set(actors)
    this.actors.set(taskId, (this.actors.get(taskId) ?? []).filter(a => !remove.has(a)))
  }
  async createCcInstance(instanceId: string, _creator: string, ...actorIds: string[]) {
    const existing = this.ccInstances.get(instanceId) ?? []
    const seen = new Set(existing)
    for (const a of actorIds) { if (!seen.has(a)) { existing.push(a); seen.add(a) } }
    this.ccInstances.set(instanceId, existing)
  }
  async updateCcStatus(_instanceId: string, _actorId: string) {}

  // ── 核心表分页（v1.5.0）──

  async pageDefines(pageNum = 1, pageSize = 10, conditions?: QueryCondition[]) {
    const rows: DefineRow[] = [...this.defines.values()].map(d => ({
      id: d.id, name: d.name, displayName: d.displayName, type: d.type,
      state: d.state, version: d.version,
      createTime: d.createTime, createUser: d.createUser,
      updateTime: d.updateTime, updateUser: d.updateUser,
    })).filter(r => matchConditions(conditions, pickFields(r, DEFINE_FIELDS)))
    const total = rows.length
    const start = (pageNum - 1) * pageSize
    return { rows: rows.slice(start, start + pageSize), total }
  }

  async pageInstances(pageNum = 1, pageSize = 10, operator: string, conditions?: QueryCondition[]) {
    const rows: InstanceRow[] = []
    for (const inst of this.instances.values()) {
      if (operator && inst.operator !== operator) continue
      const def = this.defines.get(inst.defineId)
      const r: InstanceRow = {
        id: inst.id, parentId: inst.parentId, defineId: inst.defineId, state: inst.state,
        parentNodeName: inst.parentNodeName, businessNo: inst.businessNo, operator: inst.operator,
        expireTime: inst.expireTime, variables: { ...inst.variables },
        createTime: inst.createTime, createUser: inst.createUser,
        updateTime: inst.updateTime, updateUser: inst.updateUser,
        defineName: def?.name ?? '', defineDisplayName: def?.displayName ?? '',
        defineVersion: def?.version ?? 0,
      }
      if (matchConditions(conditions, pickFields(r, INSTANCE_FIELDS))) rows.push(r)
    }
    const total = rows.length
    const start = (pageNum - 1) * pageSize
    return { rows: rows.slice(start, start + pageSize), total }
  }

  async pageTodoTasks(pageNum = 1, pageSize = 10, actorId: string, conditions?: QueryCondition[]) {
    const rows: TaskRow[] = []
    for (const t of this.tasks.values()) {
      if (t.taskState !== TaskState.Doing) continue
      if (actorId && !(this.actors.get(t.id) ?? []).includes(actorId)) continue
      const r = this.taskRow(t)
      const fields = pickFields(r, TASK_FIELDS)
      fields['pta.actor_id'] = this.actors.get(t.id) ?? []
      if (matchConditions(conditions, fields)) rows.push(r)
    }
    const total = rows.length
    const start = (pageNum - 1) * pageSize
    return { rows: rows.slice(start, start + pageSize), total }
  }

  async pageDoneTasks(pageNum = 1, pageSize = 10, operator: string, conditions?: QueryCondition[]) {
    const rows: TaskRow[] = []
    for (const t of this.tasks.values()) {
      if (t.taskState === TaskState.Doing) continue
      if (operator && t.actorId !== operator) continue
      const r = this.taskRow(t)
      if (matchConditions(conditions, pickFields(r, TASK_FIELDS))) rows.push(r)
    }
    const total = rows.length
    const start = (pageNum - 1) * pageSize
    return { rows: rows.slice(start, start + pageSize), total }
  }

  private taskRow(t: ProcessTask): TaskRow {
    const inst = this.instances.get(t.processInstanceId)
    const def = inst ? this.defines.get(inst.defineId) : undefined
    return {
      id: t.id, processInstanceId: t.processInstanceId, taskName: t.taskName,
      displayName: t.displayName, taskType: t.taskType, performType: t.performType,
      taskState: t.taskState, operator: t.actorId ?? '', finishTime: t.finishTime,
      expireTime: t.expireTime, formKey: t.formKey ?? '', taskParentId: t.parentTaskId,
      variables: { ...t.variables }, createTime: t.createTime, createUser: t.createUser,
      updateTime: t.updateTime, updateUser: t.updateUser,
      processDefineName: def?.name ?? '', processDefineDisplayName: def?.displayName ?? '',
      defineVersion: def?.version ?? 0,
      instanceVariable: inst ? JSON.stringify(inst.variables ?? {}) : '',
      instanceCreateTime: inst?.createTime ?? t.createTime,
    }
  }

  // pageCcInstances 我的抄送分页（v1.3.0）：按抄送人 actorId 过滤，join 实例 + 定义
  async pageCcInstances(pageNum = 1, pageSize = 10, actorId: string, conditions?: QueryCondition[]) {
    const rows: CcInstanceRow[] = []
    for (const [instId, actors] of this.ccInstances) {
      if (actorId && !actors.includes(actorId)) continue
      const inst = this.instances.get(instId)
      if (!inst) continue
      const def = this.defines.get(inst.defineId)
      const r: CcInstanceRow = {
        id: inst.id, parentId: inst.parentId, defineId: inst.defineId, state: inst.state,
        parentNodeName: inst.parentNodeName, businessNo: inst.businessNo, operator: inst.operator,
        expireTime: inst.expireTime, variables: { ...inst.variables },
        createTime: inst.createTime, createUser: inst.createUser,
        updateTime: inst.updateTime, updateUser: inst.updateUser,
        defineName: def?.name ?? '', defineDisplayName: def?.displayName ?? '',
        defineVersion: def?.version ?? 0,
      }
      const fields = pickFields(r, INSTANCE_FIELDS)
      fields['cc.actor_id'] = actors
      if (matchConditions(conditions, fields)) rows.push(r)
    }
    const total = rows.length
    const start = (pageNum - 1) * pageSize
    return { rows: rows.slice(start, start + pageSize), total }
  }

  allDefines() { return [...this.defines.values()] }
  allInstances() { return [...this.instances.values()] }
  allTasks() {
    return [...this.tasks.values()].map(t => {
      const cp = cloneTask(t)
      cp.actorIds = this.actors.get(t.id) ?? t.actorIds
      return cp
    })
  }

  // ── 统计（v1.8.25，issues/103） ──────────────────────────────────────────

  private toDt(v: Date | string | null | undefined): Date | undefined {
    if (v == null) return undefined
    if (v instanceof Date) return isNaN(v.getTime()) ? undefined : v
    const d = new Date(String(v).replace(' ', 'T'))
    return isNaN(d.getTime()) ? undefined : d
  }

  async queryInstancesForStats(stateIn: number[], start?: Date | null, end?: Date | null) {
    const sd = this.toDt(start); const ed = this.toDt(end)
    const rows: { defineId: string; state: number; operator: string; createTime: Date | string | null }[] = []
    for (const inst of this.instances.values()) {
      const sv = Number(inst.state)
      if (!stateIn.includes(sv)) continue
      const ct = this.toDt(inst.createTime)
      if (sd && ct && ct < sd) continue
      if (ed && ct && ct > ed) continue
      rows.push({ defineId: String(inst.defineId), state: sv, operator: inst.operator ?? '', createTime: inst.createTime ?? null })
    }
    return rows
  }

  async queryTasksForStats(taskState?: number, start?: Date | null, end?: Date | null) {
    const sd = this.toDt(start); const ed = this.toDt(end)
    const rows: { operator: string; displayName: string; performType: number; createTime: Date | string | null; finishTime: Date | string | null; expireTime: Date | string | null }[] = []
    for (const t of this.tasks.values()) {
      if (taskState != null && Number(t.taskState) !== taskState) continue
      const ft = this.toDt(t.finishTime)
      if (sd && ft && ft < sd) continue
      if (ed && ft && ft > ed) continue
      rows.push({
        operator: t.actorId ?? '', displayName: t.displayName ?? '',
        performType: t.performType ?? 0,
        createTime: t.createTime ?? null, finishTime: t.finishTime ?? null, expireTime: t.expireTime ?? null,
      })
    }
    return rows
  }

  async statsPendingAndOverdueCount(): Promise<[number, number]> {
    const now = new Date()
    let pending = 0, overdue = 0
    for (const t of this.tasks.values()) {
      if (Number(t.taskState) !== TaskState.Doing) continue
      pending++
      const exp = this.toDt(t.expireTime)
      if (exp && exp < now) overdue++
    }
    return [pending, overdue]
  }

  async statsCompletedTaskAggregate(): Promise<[number, number, number, number]> {
    let total = 0, countersign = 0, onTime = 0, onTimeDenom = 0
    for (const t of this.tasks.values()) {
      if (Number(t.taskState) !== TaskState.Done) continue
      total++
      if (t.performType === 1) countersign++
      const ft = this.toDt(t.finishTime)
      const exp = this.toDt(t.expireTime)
      if (exp != null) {
        onTimeDenom++
        if (ft && ft <= exp) onTime++
      }
    }
    return [total, countersign, onTime, onTimeDenom]
  }

  async statsAvgCompletedDurationSeconds(start?: Date | null, end?: Date | null): Promise<number> {
    const sd = this.toDt(start); const ed = this.toDt(end)
    let totalSec = 0, count = 0
    for (const inst of this.instances.values()) {
      if (Number(inst.state) !== 20) continue
      const ct = this.toDt(inst.createTime)
      if (sd && ct && ct < sd) continue
      if (ed && ct && ct > ed) continue
      let maxFt: Date | undefined
      for (const t of this.tasks.values()) {
        if (t.processInstanceId !== inst.id) continue
        const ft = this.toDt(t.finishTime)
        if (ft && (!maxFt || ft > maxFt)) maxFt = ft
      }
      if (maxFt && ct) {
        totalSec += Math.floor((maxFt.getTime() - ct.getTime()) / 1000)
        count++
      }
    }
    return count > 0 ? Math.floor(totalSec / count) : 0
  }

  async statsDefineGroup(start?: Date | null, end?: Date | null, limit = 10) {
    const sd = this.toDt(start); const ed = this.toDt(end)
    const grouped = new Map<string, { key: string; label: string | null; count: number; totalDur: number; durCount: number }>()
    for (const inst of this.instances.values()) {
      const ct = this.toDt(inst.createTime)
      if (sd && ct && ct < sd) continue
      if (ed && ct && ct > ed) continue
      const did = String(inst.defineId)
      if (!grouped.has(did)) {
        const defn = this.defines.get(did)
        grouped.set(did, { key: defn?.name ?? '', label: defn?.displayName ?? null, count: 0, totalDur: 0, durCount: 0 })
      }
      const g = grouped.get(did)!
      g.count++
      if (Number(inst.state) === 20) {
        let maxFt: Date | undefined
        for (const t of this.tasks.values()) {
          if (t.processInstanceId !== inst.id) continue
          const ft = this.toDt(t.finishTime)
          if (ft && (!maxFt || ft > maxFt)) maxFt = ft
        }
        if (maxFt && ct) {
          g.totalDur += Math.floor((maxFt.getTime() - ct.getTime()) / 1000)
          g.durCount++
        }
      }
    }
    const entries = [...grouped.values()].sort((a, b) => b.count - a.count).slice(0, limit)
    return entries.map(e => ({ key: e.key, label: e.label, count: e.count, avgDurationSeconds: e.durCount > 0 ? Math.floor(e.totalDur / e.durCount) : null }))
  }

  async statsStuckNodeGroup(limit = 10) {
    const grouped = new Map<string, number>()
    for (const t of this.tasks.values()) {
      if (Number(t.taskState) !== TaskState.Doing) continue
      const dn = t.displayName
      if (!dn) continue
      grouped.set(dn, (grouped.get(dn) ?? 0) + 1)
    }
    const entries = [...grouped.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
    return entries.map(([k, c]) => ({ key: k, count: c }))
  }

  async statsStuckApproverGroup(limit = 10) {
    const grouped = new Map<string, number>()
    for (const t of this.tasks.values()) {
      if (Number(t.taskState) !== TaskState.Doing) continue
      const actors = this.actors.get(t.id) ?? []
      for (const aid of actors) {
        if (!aid) continue
        grouped.set(aid, (grouped.get(aid) ?? 0) + 1)
      }
    }
    const entries = [...grouped.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
    return entries.map(([k, c]) => ({ key: k, count: c }))
  }

  async statsCompletedInstanceDurations(start?: Date | null, end?: Date | null): Promise<number[]> {
    const sd = this.toDt(start); const ed = this.toDt(end)
    const durations: number[] = []
    for (const inst of this.instances.values()) {
      if (Number(inst.state) !== 20) continue
      const ct = this.toDt(inst.createTime)
      if (sd && ct && ct < sd) continue
      if (ed && ct && ct > ed) continue
      let maxFt: Date | undefined
      for (const t of this.tasks.values()) {
        if (t.processInstanceId !== inst.id) continue
        const ft = this.toDt(t.finishTime)
        if (ft && (!maxFt || ft > maxFt)) maxFt = ft
      }
      if (maxFt && ct) {
        durations.push(Math.floor((maxFt.getTime() - ct.getTime()) / 1000))
      }
    }
    return durations
  }
}

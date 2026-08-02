import type { CcInstanceRow, ProcessDefine } from './model.js'
import { cloneInstance, cloneTask, type ProcessInstance, type ProcessTask } from './model.js'
import type { ProcessRepository } from './spi.js'

export class MemoryRepository implements ProcessRepository {
  private defines  = new Map<number, ProcessDefine>()
  private instances = new Map<number, ProcessInstance>()
  private tasks    = new Map<number, ProcessTask>()
  private actors   = new Map<number, string[]>()
  private ccInstances = new Map<number, string[]>()
  private seq = 1

  addDefine(def: ProcessDefine) {
    if (!def.id) def.id = this.seq++
    this.defines.set(def.id, def)
  }

  async findDefineById(id: number) { return this.defines.get(id) ?? null }

  // findDefineByName 按流程编码查最新一条定义（id 倒序取首条，v1.1.0）
  async findDefineByName(name: string) {
    let latest: ProcessDefine | null = null
    for (const d of this.defines.values()) {
      if (d.name === name && (!latest || d.id > latest.id)) latest = d
    }
    return latest
  }

  // ── 定义写操作（v1.0.1，对齐 SPI）──

  async saveDefine(def: ProcessDefine) {
    if (!def.id) def.id = this.seq++
    this.defines.set(def.id, def)
  }
  async updateDefine(def: ProcessDefine) {
    this.defines.set(def.id, def)
  }
  async updateDefineState(defineId: number, state: number) {
    const d = this.defines.get(defineId)
    if (d) d.state = state
  }
  async removeDefine(defineId: number) {
    this.defines.delete(defineId)
  }

  async saveInstance(inst: ProcessInstance) {
    if (!inst.id) inst.id = this.seq++
    const cp = cloneInstance(inst)
    cp.tasks = []
    this.instances.set(inst.id, cp)
  }
  async updateInstance(inst: ProcessInstance) {
    const cp = cloneInstance(inst)
    cp.tasks = []
    this.instances.set(inst.id, cp)
    // v1.0.1：级联保存聚合根内任务状态变更
    for (const t of inst.tasks) {
      if (!t.id) continue
      const tc = cloneTask(t)
      tc.actorIds = []
      this.tasks.set(t.id, tc)
      if (t.actorIds.length) this.actors.set(t.id, [...t.actorIds])
    }
  }
  async findInstanceById(id: number) {
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

  async findTaskById(id: number) {
    const t = this.tasks.get(id)
    if (!t) return null
    const cp = cloneTask(t)
    cp.actorIds = this.actors.get(id) ?? t.actorIds
    return cp
  }
  async saveTask(task: ProcessTask) {
    if (!task.id) task.id = this.seq++
    const cp = cloneTask(task)
    cp.actorIds = []
    this.tasks.set(task.id, cp)
    if (task.actorIds.length) this.actors.set(task.id, [...task.actorIds])
  }
  async updateTask(task: ProcessTask) {
    const cp = cloneTask(task)
    cp.actorIds = []
    this.tasks.set(task.id, cp)
    if (task.actorIds.length) this.actors.set(task.id, [...task.actorIds])
  }
  async findDoingTasks(instanceId: number, taskNames?: string[]) {
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
  async findDoneTasks(instanceId: number, _taskNames?: string[]) {
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
  async findHistoryTasks(instanceId: number) {
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
  async findTaskActors(taskId: number) { return this.actors.get(taskId) ?? [] }
  async addTaskActor(taskId: number, actors: string[]) {
    const existing = this.actors.get(taskId) ?? []
    const seen = new Set(existing)
    for (const a of actors) { if (!seen.has(a)) { existing.push(a); seen.add(a) } }
    this.actors.set(taskId, existing)
  }
  async removeTaskActor(taskId: number, actors: string[]) {
    const remove = new Set(actors)
    this.actors.set(taskId, (this.actors.get(taskId) ?? []).filter(a => !remove.has(a)))
  }
  async createCcInstance(instanceId: number, _creator: string, ...actorIds: string[]) {
    const existing = this.ccInstances.get(instanceId) ?? []
    const seen = new Set(existing)
    for (const a of actorIds) { if (!seen.has(a)) { existing.push(a); seen.add(a) } }
    this.ccInstances.set(instanceId, existing)
  }
  async updateCcStatus(_instanceId: number, _actorId: string) {}

  // pageCcInstances 我的抄送分页（v1.3.0）：按抄送人 actorId 过滤，join 实例 + 定义
  async pageCcInstances(pageNum = 1, pageSize = 10, actorId: string) {
    const rows: CcInstanceRow[] = []
    for (const [instId, actors] of this.ccInstances) {
      if (actorId && !actors.includes(actorId)) continue
      const inst = this.instances.get(instId)
      if (!inst) continue
      const def = this.defines.get(inst.defineId)
      rows.push({
        id: inst.id, parentId: inst.parentId, defineId: inst.defineId, state: inst.state,
        parentNodeName: inst.parentNodeName, businessNo: inst.businessNo, operator: inst.operator,
        expireTime: inst.expireTime, variables: { ...inst.variables },
        createTime: inst.createTime, createUser: inst.createUser,
        updateTime: inst.updateTime, updateUser: inst.updateUser,
        defineName: def?.name ?? '', defineDisplayName: def?.displayName ?? '',
        defineVersion: def?.version ?? 0,
      })
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
}

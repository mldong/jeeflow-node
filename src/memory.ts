import type { ProcessDefine } from './model.js'
import { cloneInstance, cloneTask, type ProcessInstance, type ProcessTask } from './model.js'
import type { ProcessRepository } from './spi.js'

export class MemoryRepository implements ProcessRepository {
  private defines  = new Map<number, ProcessDefine>()
  private instances = new Map<number, ProcessInstance>()
  private tasks    = new Map<number, ProcessTask>()
  private actors   = new Map<number, string[]>()
  private seq = 1

  addDefine(def: ProcessDefine) {
    if (!def.id) def.id = this.seq++
    this.defines.set(def.id, def)
  }

  async findDefineById(id: number) { return this.defines.get(id) ?? null }
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
  async createCcInstance(..._args: any[]) {}
  async updateCcStatus(..._args: any[]) {}

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

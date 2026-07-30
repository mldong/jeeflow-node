import type { ProcessDefine, ProcessInstance, ProcessTask } from './model.js'
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
    this.instances.set(inst.id, { ...inst, tasks: [] })
  }
  async updateInstance(inst: ProcessInstance) {
    this.instances.set(inst.id, { ...inst, tasks: [] })
  }
  async findInstanceById(id: number) {
    const inst = this.instances.get(id)
    if (!inst) return null
    const tasks: ProcessTask[] = []
    for (const t of this.tasks.values()) {
      if (t.processInstanceId === id) {
        tasks.push({ ...t, actorIds: this.actors.get(t.id) ?? t.actorIds })
      }
    }
    return { ...inst, tasks }
  }

  async findTaskById(id: number) {
    const t = this.tasks.get(id)
    if (!t) return null
    return { ...t, actorIds: this.actors.get(id) ?? t.actorIds }
  }
  async saveTask(task: ProcessTask) {
    if (!task.id) task.id = this.seq++
    this.tasks.set(task.id, { ...task, actorIds: [] })
    if (task.actorIds.length) this.actors.set(task.id, [...task.actorIds])
  }
  async updateTask(task: ProcessTask) {
    this.tasks.set(task.id, { ...task, actorIds: [] })
    if (task.actorIds.length) this.actors.set(task.id, [...task.actorIds])
  }
  async findDoingTasks(instanceId: number, taskNames?: string[]) {
    const result: ProcessTask[] = []
    for (const t of this.tasks.values()) {
      if (t.processInstanceId === instanceId && t.taskState === 10) {
        if (taskNames?.length && !taskNames.includes(t.taskName)) continue
        result.push({ ...t, actorIds: this.actors.get(t.id) ?? t.actorIds })
      }
    }
    return result
  }
  async findDoneTasks(instanceId: number, _taskNames?: string[]) {
    const result: ProcessTask[] = []
    for (const t of this.tasks.values()) {
      if (t.processInstanceId === instanceId && t.taskState === 20)
        result.push({ ...t, actorIds: this.actors.get(t.id) ?? t.actorIds })
    }
    return result
  }
  async findHistoryTasks(instanceId: number) {
    const result: ProcessTask[] = []
    for (const t of this.tasks.values()) {
      if (t.processInstanceId === instanceId)
        result.push({ ...t, actorIds: this.actors.get(t.id) ?? t.actorIds })
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
    return [...this.tasks.values()].map(t => ({ ...t, actorIds: this.actors.get(t.id) ?? t.actorIds }))
  }
}

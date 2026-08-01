// JDBC（MySQL / mysql2）仓储参考实现——对齐 spec §7.4 事务约定。
//
// 事务机制（spec §7.4）：Node 使用 AsyncLocalStorage 绑定当前异步上下文的事务连接。
// withTx 开启事务并把连接写入 ALS，回调内所有仓储方法走同一连接；
// 无事务上下文时从连接池获取独立连接。

import { AsyncLocalStorage } from 'node:async_hooks'
import type { Pool, PoolConnection } from 'mysql2/promise'
import { ProcessInstance, ProcessTask, type ProcessDefine } from './model.js'
import { InstanceState, TaskState } from './model.js'
import type { IDGenerator, ProcessRepository } from './spi.js'

// 当前异步上下文绑定的事务连接
const txStore = new AsyncLocalStorage<PoolConnection>()

/** 默认 ID 生成器：时间戳毫秒 + 同毫秒递增序号（对齐 Java nextId 默认实现） */
export class TsIDGenerator implements IDGenerator {
  private last = 0
  private seq = 0

  nextId(): number {
    const now = Date.now()
    if (now === this.last) {
      this.seq++
    } else {
      this.last = now
      this.seq = 0
    }
    return now * 1000 + this.seq
  }
}

export class JdbcRepository implements ProcessRepository {
  constructor(
    private readonly pool: Pool,
    private readonly idGen: IDGenerator = new TsIDGenerator(),
  ) {}

  // ── 事务（spec §7.4：AsyncLocalStorage 绑定连接）─────────────────────────

  async withTx<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await this.pool.getConnection()
    try {
      await conn.beginTransaction()
      try {
        const result = await txStore.run(conn, fn)
        await conn.commit()
        return result
      } catch (err) {
        await conn.rollback()
        throw err
      }
    } finally {
      conn.release()
    }
  }

  /** 返回当前连接：有事务绑定用事务连接，否则用池连接 */
  private c(): PoolConnection | Pool {
    return txStore.getStore() ?? this.pool
  }

  // ── ProcessDefine ─────────────────────────────────────────────────────────

  async findDefineById(id: number): Promise<ProcessDefine | null> {
    const [rows] = await this.c().execute(
      'SELECT id, name, display_name, type, state, content, version, ' +
      'create_time, create_user, update_time, update_user FROM wf_process_define WHERE id = ?',
      [id],
    )
    const row = (rows as any[])[0]
    if (!row) return null
    return {
      id: row.id, name: row.name, displayName: row.display_name, type: row.type,
      state: row.state,
      content: row.content ? Buffer.from(row.content).toString('utf8') : '',
      version: row.version, createTime: row.create_time, createUser: row.create_user,
      updateTime: row.update_time, updateUser: row.update_user,
    }
  }

  // ── ProcessInstance ───────────────────────────────────────────────────────

  private static INSTANCE_COLS =
    'id, parent_id, process_define_id, state, parent_node_name, business_no, ' +
    'operator, expire_time, variable, create_time, create_user, update_time, update_user'

  async findInstanceById(id: number): Promise<ProcessInstance | null> {
    const [rows] = await this.c().execute(
      `SELECT ${JdbcRepository.INSTANCE_COLS} FROM wf_process_instance WHERE id = ?`, [id])
    const row = (rows as any[])[0]
    if (!row) return null
    const inst = new ProcessInstance({
      id: row.id, parentId: row.parent_id, defineId: row.process_define_id,
      state: row.state, parentNodeName: row.parent_node_name, businessNo: row.business_no,
      operator: row.operator, expireTime: row.expire_time,
      createTime: row.create_time, createUser: row.create_user,
      updateTime: row.update_time, updateUser: row.update_user,
      tasks: [],
    })
    inst.variables = row.variable ? JSON.parse(row.variable) : {}
    return inst
  }

  async saveInstance(inst: ProcessInstance): Promise<void> {
    await this.c().execute(
      'INSERT INTO wf_process_instance (id, parent_id, process_define_id, state, ' +
      'parent_node_name, business_no, operator, expire_time, variable, ' +
      'create_time, create_user, update_time, update_user) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [inst.id, inst.parentId ?? null, inst.defineId, inst.state, inst.parentNodeName ?? '',
        inst.businessNo ?? '', inst.operator, inst.expireTime ?? null,
        JSON.stringify(inst.variables ?? {}), inst.createTime, inst.createUser,
        inst.updateTime, inst.updateUser],
    )
  }

  async updateInstance(inst: ProcessInstance): Promise<void> {
    await this.c().execute(
      'UPDATE wf_process_instance SET state=?, parent_node_name=?, business_no=?, ' +
      'operator=?, expire_time=?, variable=?, update_time=?, update_user=? WHERE id=?',
      [inst.state, inst.parentNodeName ?? '', inst.businessNo ?? '', inst.operator,
        inst.expireTime ?? null, JSON.stringify(inst.variables ?? {}),
        inst.updateTime, inst.updateUser, inst.id],
    )
  }

  // ── ProcessTask ───────────────────────────────────────────────────────────

  private static TASK_COLS =
    'id, process_instance_id, task_name, display_name, task_type, perform_type, ' +
    'task_state, operator, finish_time, expire_time, form_key, task_parent_id, ' +
    'variable, create_time, create_user, update_time, update_user'

  async findTaskById(taskId: number): Promise<ProcessTask | null> {
    const [rows] = await this.c().execute(
      `SELECT ${JdbcRepository.TASK_COLS} FROM wf_process_task WHERE id = ?`, [taskId])
    const row = (rows as any[])[0]
    if (!row) return null
    const task = this.mapTask(row)
    task.actorIds = await this.findTaskActors(taskId)
    return task
  }

  async saveTask(task: ProcessTask): Promise<void> {
    await this.c().execute(
      'INSERT INTO wf_process_task (id, process_instance_id, task_name, display_name, ' +
      'task_type, perform_type, task_state, operator, finish_time, expire_time, form_key, ' +
      'task_parent_id, variable, create_time, create_user, update_time, update_user) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [task.id, task.processInstanceId, task.taskName, task.displayName, task.taskType ?? 0,
        task.performType ?? 0, task.taskState, task.actorId ?? '', task.finishTime ?? null,
        task.expireTime ?? null, task.formKey ?? '', task.parentTaskId ?? null,
        JSON.stringify(task.variables ?? {}), task.createTime, task.createUser,
        task.updateTime, task.updateUser],
    )
    await this.replaceTaskActors(task.id, task.actorIds ?? [])
  }

  async updateTask(task: ProcessTask): Promise<void> {
    await this.c().execute(
      'UPDATE wf_process_task SET task_state=?, operator=?, finish_time=?, expire_time=?, ' +
      'variable=?, update_time=?, update_user=? WHERE id=?',
      [task.taskState, task.actorId ?? '', task.finishTime ?? null, task.expireTime ?? null,
        JSON.stringify(task.variables ?? {}), task.updateTime, task.updateUser, task.id],
    )
  }

  private async findTasksByState(
    instanceId: number, state: TaskState | null, taskNames?: string[],
  ): Promise<ProcessTask[]> {
    let sql = `SELECT ${JdbcRepository.TASK_COLS} FROM wf_process_task WHERE process_instance_id = ?`
    const args: any[] = [instanceId]
    if (state !== null) {
      sql += ' AND task_state = ?'
      args.push(state)
    }
    if (taskNames && taskNames.length > 0) {
      sql += ' AND task_name IN (?' + ',?'.repeat(taskNames.length - 1) + ')'
      args.push(...taskNames)
    }
    sql += ' ORDER BY id ASC'
    const [rows] = await this.c().execute(sql, args)
    const list = rows as any[]
    const tasks = list.map(r => this.mapTask(r))
    if (tasks.length > 0) {
      const ids = tasks.map(t => t.id)
      const [actorRows] = await this.c().execute(
        `SELECT process_task_id, actor_id FROM wf_process_task_actor WHERE process_task_id IN (?${',?'.repeat(ids.length - 1)}) ORDER BY id ASC`,
        ids)
      for (const t of tasks) t.actorIds = []
      for (const r of actorRows as any[]) {
        const t = tasks.find(x => x.id === r.process_task_id)
        if (t) t.actorIds.push(r.actor_id)
      }
    }
    return tasks
  }

  async findDoingTasks(instanceId: number, taskNames?: string[]): Promise<ProcessTask[]> {
    return this.findTasksByState(instanceId, TaskState.Doing, taskNames)
  }

  async findDoneTasks(instanceId: number, taskNames?: string[]): Promise<ProcessTask[]> {
    return this.findTasksByState(instanceId, TaskState.Done, taskNames)
  }

  async findHistoryTasks(instanceId: number): Promise<ProcessTask[]> {
    return this.findTasksByState(instanceId, null)
  }

  private mapTask(row: any): ProcessTask {
    const task = new ProcessTask({
      id: row.id, processInstanceId: row.process_instance_id, taskName: row.task_name,
      displayName: row.display_name, taskType: row.task_type, performType: row.perform_type,
      taskState: row.task_state, actorId: row.operator, finishTime: row.finish_time,
      expireTime: row.expire_time, formKey: row.form_key, parentTaskId: row.task_parent_id,
      createTime: row.create_time, createUser: row.create_user,
      updateTime: row.update_time, updateUser: row.update_user,
    })
    task.variables = row.variable ? JSON.parse(row.variable) : {}
    task.actorIds = []
    return task
  }

  // ── TaskActor ─────────────────────────────────────────────────────────────

  private async replaceTaskActors(taskId: number, actors: string[]): Promise<void> {
    const conn = this.c()
    await conn.execute('DELETE FROM wf_process_task_actor WHERE process_task_id = ?', [taskId])
    await this.insertTaskActors(taskId, actors)
  }

  private async insertTaskActors(taskId: number, actors: string[]): Promise<void> {
    const now = new Date()
    for (const a of actors) {
      await this.c().execute(
        'INSERT INTO wf_process_task_actor (id, process_task_id, actor_id, create_time, create_user) VALUES (?,?,?,?,?)',
        [this.idGen.nextId(), taskId, a, now, 'jeeflow'],
      )
    }
  }

  async findTaskActors(taskId: number): Promise<string[]> {
    const [rows] = await this.c().execute(
      'SELECT actor_id FROM wf_process_task_actor WHERE process_task_id = ? ORDER BY id ASC', [taskId])
    return (rows as any[]).map(r => r.actor_id)
  }

  async addTaskActor(taskId: number, actors: string[]): Promise<void> {
    await this.insertTaskActors(taskId, actors)
  }

  async removeTaskActor(taskId: number, actors: string[]): Promise<void> {
    if (actors.length === 0) return
    await this.c().execute(
      `DELETE FROM wf_process_task_actor WHERE process_task_id = ? AND actor_id IN (?${',?'.repeat(actors.length - 1)})`,
      [taskId, ...actors],
    )
  }

  // ── CcInstance（抄送）─────────────────────────────────────────────────────

  async createCcInstance(instanceId: number, creator: string, ...actorIds: string[]): Promise<void> {
    const now = new Date()
    for (const actorId of actorIds) {
      await this.c().execute(
        'INSERT INTO wf_process_cc_instance (id, process_instance_id, actor_id, state, ' +
        'create_time, create_user, update_time, update_user) VALUES (?,?,?,0,?,?,?,?)',
        [this.idGen.nextId(), instanceId, actorId, now, creator, now, creator],
      )
    }
  }

  async updateCcStatus(instanceId: number, actorId: string): Promise<void> {
    await this.c().execute(
      'UPDATE wf_process_cc_instance SET state=1, update_time=? WHERE process_instance_id=? AND actor_id=?',
      [new Date(), instanceId, actorId],
    )
  }
}

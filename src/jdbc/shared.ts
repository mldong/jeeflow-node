// 共享 JDBC 仓储核心——SQL 逻辑与数据库无关。
//
// 设计（多数据库维护策略）：
// - 本文件是**唯一维护点**：15 个仓储方法的 SQL 逻辑、行映射、ID 生成
// - SQL 占位符统一使用 `?`，由各数据库适配器（SqlAdapter）转换为自家风格
//   （MySQL `?` 原生 / PostgreSQL `$n`）
// - 事务（spec §7.4）：withTx 用 AsyncLocalStorage 绑定当前异步上下文的事务连接
//
// 新增数据库 = 写一个适配器（约 80 行）：实现 SqlAdapter + 连接包装
// （execute/fetchOne/fetchAll/begin/commit/rollback）。参考 mysql.ts / postgres.ts。

import { AsyncLocalStorage } from 'node:async_hooks'
import { ProcessInstance, ProcessTask, type ProcessDefine, type CcInstanceRow, type DefineRow, type InstanceRow, type TaskRow } from '../model.js'
import { InstanceState, TaskState } from '../model.js'
import type { IDGenerator, ProcessRepository, QueryCondition } from '../spi.js'

// ═══ 列白名单（issues/05-5，与 mldong-boot2 别名一致） ═══

const TASK_WHITELIST = new Set([
  't.id', 't.task_name', 't.display_name', 't.task_type', 't.perform_type', 't.task_state',
  't.operator', 't.form_key', 't.create_time', 't.finish_time', 't.expire_time',
  't.process_instance_id', 't.task_parent_id', 't.variable',
  'pi.id', 'pi.business_no', 'pi.operator', 'pi.create_time', 'pi.state',
  'pd.name', 'pd.display_name', 'pd.type',
  'pta.actor_id', 'pta.process_task_id',
])

const INSTANCE_WHITELIST = new Set([
  't.id', 't.parent_id', 't.process_define_id', 't.state', 't.business_no',
  't.operator', 't.create_time', 't.expire_time', 't.variable',
  'pd.name', 'pd.display_name', 'pd.type', 'pd.version',
])

const CC_WHITELIST = new Set([
  't.id', 't.process_define_id', 't.state', 't.business_no', 't.operator',
  't.create_time', 't.variable',
  'pd.name', 'pd.display_name', 'pd.type', 'pd.version',
  'cc.actor_id', 'cc.state',
])

const DEFINE_WHITELIST = new Set([
  't.id', 't.name', 't.display_name', 't.type', 't.state', 't.version',
  't.create_time', 't.update_time',
])

// 当前异步上下文绑定的事务连接
const txStore = new AsyncLocalStorage<SqlConnection>()

/** 默认 ID 生成器：时间戳毫秒 + 同毫秒递增序号（对齐 Java nextId 默认实现）——
 *  issue 38 E9：返回 string（数字值在 2^53 内精确，转字符串统一承载） */
export class TsIDGenerator implements IDGenerator {
  private last = 0
  private seq = 0

  nextId(): string {
    const now = Date.now()
    if (now === this.last) {
      this.seq++
    } else {
      this.last = now
      this.seq = 0
    }
    return String(now * 1000 + this.seq)
  }
}

/** 行 id 归一化（issue 38 E9）：mysql2 可能返回 number（默认）或 string（bigNumberStrings），
 *  统一转 string，保证引擎内部 id 全字符串、跨驱动一致 */
export function rowId(v: any): string {
  return v == null ? '' : String(v)
}

/** 适配器返回的连接包装——最小接口 */
export interface SqlConnection {
  execute(sql: string, args: any[]): Promise<void>
  fetchOne(sql: string, args: any[]): Promise<any | null>
  fetchAll(sql: string, args: any[]): Promise<any[]>
  begin(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
}

/** 数据库适配器——连接生命周期 + 占位符风格 */
export interface SqlAdapter {
  placeholder: '?' | '$n'
  acquire(): Promise<SqlConnection>
  release(conn: SqlConnection): Promise<void>
}

/** 把核心 SQL 的统一 `?` 占位符转换为适配器风格 */
export function convertPlaceholder(sql: string, style: string): string {
  if (style === '$n') {
    let i = 0
    return sql.replace(/\?/g, () => `$${++i}`)
  }
  return sql // '?' 原生
}

/** 生成 n 个 `?` 占位符（用于 IN 列表） */
export function repeatPh(n: number): string {
  return Array.from({ length: n }, () => '?').join(',')
}

export class JdbcRepository implements ProcessRepository {
  constructor(
    private readonly adapter: SqlAdapter,
    private readonly idGen: IDGenerator = new TsIDGenerator(),
  ) {}

  private sql(s: string): string {
    return convertPlaceholder(s, this.adapter.placeholder)
  }

  // ── 事务（spec §7.4：AsyncLocalStorage 绑定连接）─────────────────────────

  async withTx<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await this.adapter.acquire()
    try {
      await conn.begin()
      try {
        const result = await txStore.run(conn, fn)
        await conn.commit()
        return result
      } catch (err) {
        await conn.rollback()
        throw err
      }
    } finally {
      await this.adapter.release(conn)
    }
  }

  /** 返回当前连接：有事务绑定用事务连接，否则从适配器获取 */
  private async c(): Promise<SqlConnection> {
    return txStore.getStore() ?? (await this.adapter.acquire())
  }

  /** 归还非事务连接（事务连接由 withTx 统一释放） */
  private async done(conn: SqlConnection): Promise<void> {
    if (!txStore.getStore()) await this.adapter.release(conn)
  }

  // ── ProcessDefine ─────────────────────────────────────────────────────────

  async findDefineById(id: string): Promise<ProcessDefine | null> {
    const conn = await this.c()
    try {
      const row = await conn.fetchOne(this.sql(
        'SELECT id, name, display_name, type, state, content, version, ' +
        'create_time, create_user, update_time, update_user FROM wf_process_define WHERE id = ?'),
        [id])
      if (!row) return null
      return {
        id: row.id, name: row.name, displayName: row.display_name, type: row.type,
        state: row.state,
        content: row.content ? Buffer.from(row.content).toString('utf8') : '',
        version: row.version, createTime: row.create_time, createUser: rowId(row.create_user),
        updateTime: row.update_time, updateUser: rowId(row.update_user),
      }
    } finally {
      await this.done(conn)
    }
  }

  // 定义写操作（v1.0.1，集成反馈①）。SQL 与 jeeflow-java JdbcProcessRepository 对齐；
  // State/Version 零值按 Java null 语义默认 1。

  async saveDefine(define: ProcessDefine): Promise<void> {
    if (!define.id) define.id = this.idGen.nextId()
    const now = new Date()
    const createTime = define.createTime ?? now
    const createUser = define.createUser || define.updateUser
    const conn = await this.c()
    try {
      await conn.execute(this.sql(
        'INSERT INTO wf_process_define (id, name, display_name, type, state, content, version, ' +
        'create_time, create_user, update_time, update_user) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
        [define.id, define.name, define.displayName, define.type, define.state || 1,
          define.content, define.version || 1, createTime, createUser,
          define.updateTime ?? now, define.updateUser])
    } finally {
      await this.done(conn)
    }
  }

  async updateDefine(define: ProcessDefine): Promise<void> {
    const conn = await this.c()
    try {
      await conn.execute(this.sql(
        'UPDATE wf_process_define SET name=?, display_name=?, type=?, state=?, content=?, ' +
        'version=?, update_time=?, update_user=? WHERE id=?'),
        [define.name, define.displayName, define.type, define.state || 1,
          define.content, define.version || 1, new Date(), define.updateUser, define.id])
    } finally {
      await this.done(conn)
    }
  }

  async updateDefineState(defineId: string, state: number): Promise<void> {
    const conn = await this.c()
    try {
      await conn.execute(this.sql(
        'UPDATE wf_process_define SET state=?, update_time=? WHERE id=?'),
        [state, new Date(), defineId])
    } finally {
      await this.done(conn)
    }
  }

  async removeDefine(defineId: string): Promise<void> {
    const conn = await this.c()
    try {
      await conn.execute(this.sql('DELETE FROM wf_process_define WHERE id=?'), [defineId])
    } finally {
      await this.done(conn)
    }
  }

  // findDefineByName 按流程编码查最新一条定义（v1.1.0，deploy 版本管理用）
  async findDefineByName(name: string): Promise<ProcessDefine | null> {
    const conn = await this.c()
    try {
      const row = await conn.fetchOne(this.sql(
        'SELECT id, name, display_name, type, state, content, version, ' +
        'create_time, create_user, update_time, update_user FROM wf_process_define WHERE name = ? ORDER BY version DESC LIMIT 1'),
        [name])
      if (!row) return null
      return {
        id: rowId(row.id), name: row.name, displayName: row.display_name, type: row.type,
        state: row.state,
        content: row.content ? Buffer.from(row.content).toString('utf8') : '',
        version: row.version, createTime: row.create_time, createUser: rowId(row.create_user),
        updateTime: row.update_time, updateUser: rowId(row.update_user),
      }
    } finally {
      await this.done(conn)
    }
  }

  // ── ProcessInstance ───────────────────────────────────────────────────────

  private static INSTANCE_COLS =
    'id, parent_id, process_define_id, state, parent_node_name, business_no, ' +
    'operator, expire_time, variable, create_time, create_user, update_time, update_user'

  async findInstanceById(id: string): Promise<ProcessInstance | null> {
    const conn = await this.c()
    try {
      const row = await conn.fetchOne(this.sql(
        `SELECT ${JdbcRepository.INSTANCE_COLS} FROM wf_process_instance WHERE id = ?`), [id])
      if (!row) return null
      const inst = new ProcessInstance({
        id: rowId(row.id), parentId: row.parent_id != null ? rowId(row.parent_id) : undefined,
        defineId: rowId(row.process_define_id),
        state: row.state, parentNodeName: row.parent_node_name, businessNo: row.business_no,
        operator: row.operator, expireTime: row.expire_time,
        createTime: row.create_time, createUser: rowId(row.create_user),
        updateTime: row.update_time, updateUser: rowId(row.update_user),
        tasks: [],
      })
      inst.variables = row.variable ? JSON.parse(row.variable) : {}
      return inst
    } finally {
      await this.done(conn)
    }
  }

  async saveInstance(inst: ProcessInstance): Promise<void> {
    const conn = await this.c()
    try {
      await conn.execute(this.sql(
        'INSERT INTO wf_process_instance (id, parent_id, process_define_id, state, ' +
        'parent_node_name, business_no, operator, expire_time, variable, ' +
        'create_time, create_user, update_time, update_user) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'),
        [inst.id, inst.parentId ?? null, inst.defineId, inst.state, inst.parentNodeName ?? '',
          inst.businessNo ?? '', inst.operator, inst.expireTime ?? null,
          JSON.stringify(inst.variables ?? {}), inst.createTime, inst.createUser,
          inst.updateTime, inst.updateUser])
    } finally {
      await this.done(conn)
    }
  }

  async updateInstance(inst: ProcessInstance): Promise<void> {
    const conn = await this.c()
    try {
      await conn.execute(this.sql(
        'UPDATE wf_process_instance SET state=?, parent_node_name=?, business_no=?, ' +
        'operator=?, expire_time=?, variable=?, update_time=?, update_user=? WHERE id=?'),
        [inst.state, inst.parentNodeName ?? '', inst.businessNo ?? '', inst.operator,
          inst.expireTime ?? null, JSON.stringify(inst.variables ?? {}),
          inst.updateTime, inst.updateUser, inst.id])
      // v1.0.1：级联持久化聚合根内任务状态变更（同连接，spec §7.4）
      for (const task of inst.tasks) {
        if (task.id) await this.updateTaskWithConn(conn, task)
      }
    } finally {
      await this.done(conn)
    }
  }

  // ── ProcessTask ───────────────────────────────────────────────────────────

  private static TASK_COLS =
    'id, process_instance_id, task_name, display_name, task_type, perform_type, ' +
    'task_state, operator, finish_time, expire_time, form_key, task_parent_id, ' +
    'variable, create_time, create_user, update_time, update_user'

  async findTaskById(taskId: string): Promise<ProcessTask | null> {
    const conn = await this.c()
    try {
      const row = await conn.fetchOne(this.sql(
        `SELECT ${JdbcRepository.TASK_COLS} FROM wf_process_task WHERE id = ?`), [taskId])
      if (!row) return null
      const task = this.mapTask(row)
      task.actorIds = await this.findTaskActors(taskId)
      return task
    } finally {
      await this.done(conn)
    }
  }

  async saveTask(task: ProcessTask): Promise<void> {
    const conn = await this.c()
    try {
      await conn.execute(this.sql(
        'INSERT INTO wf_process_task (id, process_instance_id, task_name, display_name, ' +
        'task_type, perform_type, task_state, operator, finish_time, expire_time, form_key, ' +
        'task_parent_id, variable, create_time, create_user, update_time, update_user) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'),
        [task.id, task.processInstanceId, task.taskName, task.displayName, task.taskType ?? 0,
          task.performType ?? 0, task.taskState, task.actorId ?? '', task.finishTime ?? null,
          task.expireTime ?? null, task.formKey ?? '', task.parentTaskId ?? null,
          JSON.stringify(task.variables ?? {}), task.createTime, task.createUser,
          task.updateTime, task.updateUser])
      await this.replaceTaskActors(conn, task.id, task.actorIds ?? [])
    } finally {
      await this.done(conn)
    }
  }

  async updateTask(task: ProcessTask): Promise<void> {
    const conn = await this.c()
    try {
      await this.updateTaskWithConn(conn, task)
    } finally {
      await this.done(conn)
    }
  }

  /** 用指定连接更新任务（实例级联时与实例更新同连接） */
  private async updateTaskWithConn(conn: SqlConnection, task: ProcessTask): Promise<void> {
    await conn.execute(this.sql(
      'UPDATE wf_process_task SET task_state=?, operator=?, finish_time=?, expire_time=?, ' +
      'variable=?, update_time=?, update_user=? WHERE id=?'),
      [task.taskState, task.actorId ?? '', task.finishTime ?? null, task.expireTime ?? null,
        JSON.stringify(task.variables ?? {}), task.updateTime, task.updateUser, task.id])
  }

  private async findTasksByState(
    instanceId: string, state: TaskState | null, taskNames?: string[],
  ): Promise<ProcessTask[]> {
    let sql = `SELECT ${JdbcRepository.TASK_COLS} FROM wf_process_task WHERE process_instance_id = ?`
    const args: any[] = [instanceId]
    if (state !== null) {
      sql += ' AND task_state = ?'
      args.push(state)
    }
    if (taskNames && taskNames.length > 0) {
      sql += ` AND task_name IN (${repeatPh(taskNames.length)})`
      args.push(...taskNames)
    }
    sql += ' ORDER BY id ASC'
    const conn = await this.c()
    try {
      const rows = await conn.fetchAll(this.sql(sql), args)
      const tasks = rows.map(r => this.mapTask(r))
      if (tasks.length > 0) {
        const ids = tasks.map(t => t.id)
        const actorRows = await conn.fetchAll(this.sql(
          `SELECT process_task_id, actor_id FROM wf_process_task_actor WHERE process_task_id IN (${repeatPh(ids.length)}) ORDER BY id ASC`),
          ids)
        for (const t of tasks) t.actorIds = []
        for (const r of actorRows) {
          const t = tasks.find(x => x.id === rowId(r.process_task_id))
          if (t) t.actorIds.push(r.actor_id)
        }
      }
      return tasks
    } finally {
      await this.done(conn)
    }
  }

  async findDoingTasks(instanceId: string, taskNames?: string[]): Promise<ProcessTask[]> {
    return this.findTasksByState(instanceId, TaskState.Doing, taskNames)
  }

  async findDoneTasks(instanceId: string, taskNames?: string[]): Promise<ProcessTask[]> {
    return this.findTasksByState(instanceId, TaskState.Done, taskNames)
  }

  async findHistoryTasks(instanceId: string): Promise<ProcessTask[]> {
    return this.findTasksByState(instanceId, null)
  }

  private mapTask(row: any): ProcessTask {
    const task = new ProcessTask({
      id: rowId(row.id), processInstanceId: rowId(row.process_instance_id), taskName: row.task_name,
      displayName: row.display_name, taskType: row.task_type, performType: row.perform_type,
      taskState: row.task_state, actorId: row.operator, finishTime: row.finish_time,
      expireTime: row.expire_time, formKey: row.form_key,
      parentTaskId: row.task_parent_id != null ? rowId(row.task_parent_id) : undefined,
      createTime: row.create_time, createUser: rowId(row.create_user),
      updateTime: row.update_time, updateUser: rowId(row.update_user),
    })
    task.variables = row.variable ? JSON.parse(row.variable) : {}
    task.actorIds = []
    return task
  }

  // ── TaskActor ─────────────────────────────────────────────────────────────

  private async replaceTaskActors(conn: SqlConnection, taskId: string, actors: string[]): Promise<void> {
    await conn.execute(this.sql('DELETE FROM wf_process_task_actor WHERE process_task_id = ?'), [taskId])
    await this.insertTaskActors(conn, taskId, actors)
  }

  private async insertTaskActors(conn: SqlConnection, taskId: string, actors: string[]): Promise<void> {
    const now = new Date()
    for (const a of actors) {
      await conn.execute(this.sql(
        'INSERT INTO wf_process_task_actor (id, process_task_id, actor_id, create_time, create_user) VALUES (?,?,?,?,?)'),
        [this.idGen.nextId(), taskId, a, now, 'jeeflow'])
    }
  }

  async findTaskActors(taskId: string): Promise<string[]> {
    const conn = await this.c()
    try {
      const rows = await conn.fetchAll(this.sql(
        'SELECT actor_id FROM wf_process_task_actor WHERE process_task_id = ? ORDER BY id ASC'), [taskId])
      return rows.map(r => r.actor_id)
    } finally {
      await this.done(conn)
    }
  }

  async addTaskActor(taskId: string, actors: string[]): Promise<void> {
    if (actors.length === 0) return
    // 追加语义（对齐 boot2/boot3，issues/03）：查已有参与者，去重后仅插入新增，不清空原参与者
    const existing = await this.findTaskActors(taskId)
    const seen = new Set(existing)
    const toAdd = actors.filter(a => !seen.has(a))
    if (toAdd.length === 0) return
    const conn = await this.c()
    try {
      await this.insertTaskActors(conn, taskId, toAdd)
    } finally {
      await this.done(conn)
    }
  }

  async removeTaskActor(taskId: string, actors: string[]): Promise<void> {
    if (actors.length === 0) return
    const conn = await this.c()
    try {
      await conn.execute(this.sql(
        `DELETE FROM wf_process_task_actor WHERE process_task_id = ? AND actor_id IN (${repeatPh(actors.length)})`),
        [taskId, ...actors])
    } finally {
      await this.done(conn)
    }
  }

  // ── CcInstance（抄送）─────────────────────────────────────────────────────

  async createCcInstance(instanceId: string, creator: string, ...actorIds: string[]): Promise<void> {
    const conn = await this.c()
    try {
      const now = new Date()
      for (const actorId of actorIds) {
        await conn.execute(this.sql(
          'INSERT INTO wf_process_cc_instance (id, process_instance_id, actor_id, state, ' +
          'create_time, create_user, update_time, update_user) VALUES (?,?,?,0,?,?,?,?)'),
          [this.idGen.nextId(), instanceId, actorId, now, creator, now, creator])
      }
    } finally {
      await this.done(conn)
    }
  }

  async updateCcStatus(instanceId: string, actorId: string): Promise<void> {
    const conn = await this.c()
    try {
      await conn.execute(this.sql(
        'UPDATE wf_process_cc_instance SET state=1, update_time=? WHERE process_instance_id=? AND actor_id=?'),
        [new Date(), instanceId, actorId])
    } finally {
      await this.done(conn)
    }
  }

  // ── 核心表分页（v1.5.0，对齐 Java pageDefines/pageInstances/pageTodoTasks/pageDoneTasks）──

  async pageDefines(pageNum: number, pageSize: number, conditions?: QueryCondition[]): Promise<{ rows: DefineRow[]; total: number }> {
    const cond = this.buildWhere(conditions ?? [], DEFINE_WHITELIST)
    const where = ' FROM wf_process_define t WHERE 1=1' + cond.sql
    const conn = await this.c()
    try {
      const countRow = await conn.fetchOne(this.sql('SELECT COUNT(*) ' + where), cond.params)
      const total = Number(Object.values(countRow as Record<string, unknown>)[0] ?? 0)
      const rows = await conn.fetchAll(this.sql(
        'SELECT id, name, display_name, type, state, version, create_time, create_user, update_time, update_user' +
        where + ' ORDER BY t.id DESC LIMIT ? OFFSET ?'),
        [...cond.params, pageSize, (pageNum - 1) * pageSize])
      return {
        rows: rows.map(r => ({
          id: rowId(r.id), name: r.name, displayName: r.display_name, type: r.type,
          state: Number(r.state), version: Number(r.version),
          createTime: r.create_time, createUser: rowId(r.create_user),
          updateTime: r.update_time, updateUser: rowId(r.update_user),
        })),
        total,
      }
    } finally {
      await this.done(conn)
    }
  }

  async pageInstances(pageNum: number, pageSize: number, operator: string, conditions?: QueryCondition[]): Promise<{ rows: InstanceRow[]; total: number }> {
    const cond = this.buildWhere(conditions ?? [], INSTANCE_WHITELIST)
    const where = ' FROM wf_process_instance t' +
      ' LEFT JOIN wf_process_define pd ON t.process_define_id = pd.id' +
      ' WHERE t.operator = ?' + cond.sql
    const conn = await this.c()
    try {
      const countRow = await conn.fetchOne(this.sql('SELECT COUNT(*) ' + where), [operator, ...cond.params])
      const total = Number(Object.values(countRow as Record<string, unknown>)[0] ?? 0)
      const cols = 't.id, t.parent_id, t.process_define_id, t.state, t.parent_node_name, t.business_no,' +
        ' t.operator, t.expire_time, t.variable, t.create_time, t.create_user, t.update_time, t.update_user,' +
        ' pd.name, pd.display_name, pd.version'
      const rows = await conn.fetchAll(this.sql(
        `SELECT ${cols}${where} ORDER BY t.id DESC LIMIT ? OFFSET ?`),
        [operator, ...cond.params, pageSize, (pageNum - 1) * pageSize])
      return { rows: rows.map(r => this.mapInstanceRow(r)), total }
    } finally {
      await this.done(conn)
    }
  }

  async pageTodoTasks(pageNum: number, pageSize: number, actorId: string, conditions?: QueryCondition[]): Promise<{ rows: TaskRow[]; total: number }> {
    return this.pageTasks(pageNum, pageSize, false, actorId, conditions)
  }

  async pageDoneTasks(pageNum: number, pageSize: number, operator: string, conditions?: QueryCondition[]): Promise<{ rows: TaskRow[]; total: number }> {
    return this.pageTasks(pageNum, pageSize, true, operator, conditions)
  }

  private async pageTasks(pageNum: number, pageSize: number, done: boolean, filter: string, conditions?: QueryCondition[]): Promise<{ rows: TaskRow[]; total: number }> {
    const cond = this.buildWhere(conditions ?? [], TASK_WHITELIST)
    const where = ' FROM wf_process_task t' +
      ' LEFT JOIN wf_process_instance pi ON t.process_instance_id = pi.id' +
      ' LEFT JOIN wf_process_define pd ON pi.process_define_id = pd.id' +
      ' LEFT JOIN wf_process_task_actor pta ON t.id = pta.process_task_id' +
      (done ? ' WHERE t.task_state <> 10 AND t.operator = ?' : ' WHERE t.task_state = 10 AND pta.actor_id = ?') + cond.sql
    const conn = await this.c()
    try {
      const countRow = await conn.fetchOne(this.sql('SELECT COUNT(DISTINCT t.id) ' + where), [filter, ...cond.params])
      const total = Number(Object.values(countRow as Record<string, unknown>)[0] ?? 0)
      const cols = 'DISTINCT t.id, t.process_instance_id, t.task_name, t.display_name, t.task_type, t.perform_type,' +
        ' t.task_state, t.operator, t.finish_time, t.expire_time, t.form_key, t.task_parent_id, t.variable,' +
        ' t.create_time, t.create_user, t.update_time, t.update_user,' +
        ' pd.name, pd.display_name, pd.version AS process_define_version,' +
        ' pi.variable AS instance_variable, pi.create_time AS instance_create_time'
      const rows = await conn.fetchAll(this.sql(
        `SELECT ${cols}${where} ORDER BY t.id DESC LIMIT ? OFFSET ?`),
        [filter, ...cond.params, pageSize, (pageNum - 1) * pageSize])
      return { rows: rows.map(r => this.mapTaskRow(r)), total }
    } finally {
      await this.done(conn)
    }
  }

  private mapInstanceRow(r: Record<string, any>): InstanceRow {
    let variables: Record<string, any> = {}
    if (r.variable) {
      try { variables = JSON.parse(r.variable) } catch { /* 忽略坏 JSON */ }
    }
    return {
      id: rowId(r.id), parentId: r.parent_id != null ? rowId(r.parent_id) : undefined,
      defineId: rowId(r.process_define_id), state: r.state as InstanceState,
      parentNodeName: r.parent_node_name ?? '', businessNo: r.business_no ?? '', operator: r.operator ?? '',
      expireTime: r.expire_time ?? undefined, variables,
      createTime: r.create_time, createUser: rowId(r.create_user),
      updateTime: r.update_time, updateUser: rowId(r.update_user),
      defineName: r.name ?? '', defineDisplayName: r.display_name ?? '',
      defineVersion: Number(r.version ?? 0),
    }
  }

  // ═══ m_ 条件 WHERE 构建（issues/05-5，白名单 + 参数化，对齐 Java buildWhere） ═══

  protected buildWhere(conditions: QueryCondition[], whitelist: Set<string>): { sql: string; params: any[] } {
    let sql = ''
    const params: any[] = []
    for (const c of conditions) {
      if (!whitelist.has(c.column)) continue // 不在白名单，丢弃
      const val = c.value
      if (val == null || val === '') continue
      switch (c.operator.toUpperCase()) {
        case 'EQ': sql += ` AND ${c.column} = ?`; params.push(val); break
        case 'NE': sql += ` AND ${c.column} <> ?`; params.push(val); break
        case 'LIKE': sql += ` AND ${c.column} LIKE ?`; params.push(`%${val}%`); break
        case 'LLIKE': sql += ` AND ${c.column} LIKE ?`; params.push(`%${val}`); break
        case 'RLIKE': sql += ` AND ${c.column} LIKE ?`; params.push(`${val}%`); break
        case 'GT': sql += ` AND ${c.column} > ?`; params.push(val); break
        case 'GE': sql += ` AND ${c.column} >= ?`; params.push(val); break
        case 'LT': sql += ` AND ${c.column} < ?`; params.push(val); break
        case 'LE': sql += ` AND ${c.column} <= ?`; params.push(val); break
        case 'IN':
        case 'NIN': {
          if (Array.isArray(val) && val.length > 0) {
            const marks = val.map(() => '?').join(',')
            sql += ` AND ${c.column} ${c.operator.toUpperCase() === 'IN' ? 'IN' : 'NOT IN'} (${marks})`
            params.push(...val)
          }
          break
        }
      }
    }
    return { sql, params }
  }

  private mapTaskRow(r: Record<string, any>): TaskRow {
    let variables: Record<string, any> = {}
    if (r.variable) {
      try { variables = JSON.parse(r.variable) } catch { /* 忽略坏 JSON */ }
    }
    return {
      id: rowId(r.id), processInstanceId: rowId(r.process_instance_id), taskName: r.task_name,
      displayName: r.display_name, taskType: Number(r.task_type), performType: Number(r.perform_type),
      taskState: r.task_state as TaskState, operator: r.operator ?? '', finishTime: r.finish_time ?? undefined,
      expireTime: r.expire_time ?? undefined, formKey: r.form_key ?? '',
      taskParentId: r.task_parent_id != null ? rowId(r.task_parent_id) : undefined,
      variables, createTime: r.create_time, createUser: rowId(r.create_user),
      updateTime: r.update_time, updateUser: rowId(r.update_user),
      processDefineName: r.name ?? '', processDefineDisplayName: r.display_name ?? '',
      defineVersion: Number(r.process_define_version ?? 0),
      instanceVariable: r.instance_variable ?? '', instanceCreateTime: r.instance_create_time,
    }
  }

  // pageCcInstances 我的抄送分页（v1.3.0）：cc 表 join 实例 + 定义，按抄送人过滤（对齐 Java pageCcInstances）
  async pageCcInstances(pageNum: number, pageSize: number, actorId: string, conditions?: QueryCondition[]): Promise<{ rows: CcInstanceRow[]; total: number }> {
    const cond = this.buildWhere(conditions ?? [], CC_WHITELIST)
    const where = ' FROM wf_process_instance t' +
      ' LEFT JOIN wf_process_define pd ON t.process_define_id = pd.id' +
      ' LEFT JOIN wf_process_cc_instance cc ON t.id = cc.process_instance_id' +
      ' WHERE cc.actor_id = ?' + cond.sql
    const cols = 't.id, t.parent_id, t.process_define_id, t.state, t.parent_node_name, t.business_no,' +
      ' t.operator, t.expire_time, t.variable, t.create_time, t.create_user, t.update_time, t.update_user,' +
      ' pd.name, pd.display_name, pd.version'
    const conn = await this.c()
    try {
      const countRow = await conn.fetchOne(this.sql('SELECT COUNT(*) ' + where), [actorId, ...cond.params])
      const total = Number(Object.values(countRow as Record<string, unknown>)[0] ?? 0)
      const rows = await conn.fetchAll(this.sql(
        `SELECT ${cols}${where} ORDER BY t.id ASC LIMIT ? OFFSET ?`),
        [actorId, ...cond.params, pageSize, (pageNum - 1) * pageSize])
      return {
        rows: rows.map(r => this.mapCcRow(r)),
        total,
      }
    } finally {
      await this.done(conn)
    }
  }

  private mapCcRow(r: Record<string, any>): CcInstanceRow {
    let variables: Record<string, any> = {}
    if (r.variable) {
      try { variables = JSON.parse(r.variable) } catch { /* 忽略坏 JSON */ }
    }
    return {
      id: rowId(r.id), parentId: r.parent_id != null ? rowId(r.parent_id) : undefined,
      defineId: rowId(r.process_define_id), state: r.state as InstanceState,
      parentNodeName: r.parent_node_name ?? '', businessNo: r.business_no ?? '', operator: r.operator ?? '',
      expireTime: r.expire_time ?? undefined, variables,
      createTime: r.create_time, createUser: rowId(r.create_user),
      updateTime: r.update_time, updateUser: rowId(r.update_user),
      defineName: r.name ?? '', defineDisplayName: r.display_name ?? '',
      defineVersion: Number(r.version ?? 0),
    }
  }
}

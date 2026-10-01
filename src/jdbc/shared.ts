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
import type { IDGenerator, ProcessRepository, QueryCondition, InstanceStatsRow, TaskStatsRow } from '../spi.js'
import { isBlankOwnership, isBlankValue, hasEffectiveCcOwnership, defaultCreateCcInstanceIfAbsent, normalizeActorValue, normalizeActors, actorDeleteForms } from '../spi.js'

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
        // issues/110：聚合水合——二次查 wf_process_task 装任务副本（含 actorIds），
        // 对齐 Java findTasksByInstanceId / PHP PdoProcessRepository / C# issues/89；
        // 否则门面 detail 的 tasks/activeTaskList 恒空。
        // 复用 findHistoryTasks（ORDER BY id ASC + 批查 actor，事务内经 c() 复用连接）
        tasks: await this.findHistoryTasks(rowId(row.id)),
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

  /**
   * `wf_process_task_actor` 的**唯一 INSERT 腿**（`saveTask`/`updateInstance` 级联的
   * `replaceTaskActors` 与 `addTaskActor` 两条路都从这里下库）。
   *
   * <p>issues/142 B 批（spec 06 §2.11「归属值写侧归一」）：绑定进 `actor_id` 的值先过
   * `spi.normalizeActors` **那一枚**单点——逐元素 trim、空串/纯空白/`null`/`undefined` 丢弃、
   * 同一次调用内的重复折叠。判据落在这一层而不是只落门面腿：绕过
   * `processTask/addCandidate`／`surrogate`／`transfer` 直连仓储的调用方（集成层、第三方仓储消费者）
   * 同样不得把空归属值灌进归属列——那正是 issues/129 那族"空归属值读全库"的上游进水口。
   * ⚠️ 与内存仓 `MemoryRepository.writeActors` 同一判据、同一份实现，两仓必须同答案。
   */
  private async insertTaskActors(conn: SqlConnection, taskId: string, actors: readonly unknown[]): Promise<void> {
    const now = new Date()
    for (const a of normalizeActors(actors)) {
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
    // issues/142 B 批（spec 06 §2.11）：写侧兜底——改前这里**判重不判空不 trim**，
    // `""`/`"  "`/`"null"`（门面数组腿串化出来的假归属人）全放行。
    // 归一交给 `insertTaskActors` 那一枚单点（与内存仓 writeActors 同一份实现），本方法只多一道
    // "与库里既有行判重"：判重两侧取的都是 trim 后的值，`" 123 "` 与 `"123"` 是同一个人。
    const normalized = normalizeActors(actors)
    if (normalized.length === 0) return
    // 追加语义（对齐 boot2/boot3，issues/03）：查已有参与者，去重后仅插入新增，不清空原参与者
    const existing = await this.findTaskActors(taskId)
    const seen = new Set(existing)
    const toAdd = normalized.filter(a => !seen.has(a))
    if (toAdd.length === 0) return
    const conn = await this.c()
    try {
      await this.insertTaskActors(conn, taskId, toAdd)
    } finally {
      await this.done(conn)
    }
  }

  async removeTaskActor(taskId: string, actors: string[]): Promise<void> {
    // issues/137 §3-6（spec 06 §processTask/removeTaskActor 语义 6 · owner 2026-10-02 拍「两形并集」）：
    // 删除值先过 spi.actorDeleteForms **那一枚**单点 —— ① 空值（null/undefined/''/纯空白）一律不喂 DELETE
    // （否则历史 actor_id='' 脏行被批量误删）；② 非空值同时以「原值」与「trim 值」两形进 IN：只取 trim 形
    // ⇒ 门面按语义 6 交出的脏行原值 " 9101 " 被削成 9101，真库 NO PAD 排序规则下那一行删不掉而门面报成功
    // （假成功）；只取原值 ⇒ 绕过门面直连仓储传 " 8601 " 删不掉写侧归一后的规范行（issues/142 §9.2）。
    // ③ 展开后为空 ⇒ 早退，一条 DELETE 都不发（不得退化成"清空该任务全部参与者"）。
    // 占位符数量按 forms 长度算（repeatPh 复用）；⚠️ 与内存仓 MemoryRepository.removeTaskActor 同一枚判据
    // （spi.actorDeleteForms），两仓同答案（issues/117 场景 27）；判据只在 spi 那一处，本方法不抄第二份。
    const forms = actorDeleteForms(actors)
    if (forms.length === 0) return
    const conn = await this.c()
    try {
      await conn.execute(this.sql(
        `DELETE FROM wf_process_task_actor WHERE process_task_id = ? AND actor_id IN (${repeatPh(forms.length)})`),
        [taskId, ...forms])
    } finally {
      await this.done(conn)
    }
  }

  // ── CcInstance（抄送）─────────────────────────────────────────────────────

  async createCcInstance(instanceId: string, creator: string, ...actorIds: string[]): Promise<void> {
    // issues/141 G2 写侧判重＝幂等空操作（spec 06 §4），与内存仓同一条判据：同一 (实例, 被抄送人)
    // 已有 cc 行 ⇒ 直接跳过——①不新增行、②不重置未读（state 保持原值）、③不更新原行时间
    // （不碰 UPDATE，create_time/update_time 逐字不变）。判重放在**写侧**而不是查询侧：
    // 查询不引入 DISTINCT（owner 2026-09-29 拍），历史重复行也不清理。
    //
    // issues/141 G10「空不创建行」（spec 06 §2.10）：入参先过 `spi.normalizeActorValue`
    // （旧名 normalizeCcActorValue 是它的别名，同一枚函数）——
    // 空串/纯空白/null 一律丢弃，绑进 actor_id 的值取 trim 后的串（`" 123 "` 与 `"123"` 是同一个人，
    // 与上面的写侧判重同一条尺子）。绕过引擎/门面直连仓储的第三方调用方也建不出 actor_id='' 的行，
    // 那正是 issues/129 那族"空 operator 读全库"的病根。⚠️ 与内存仓共用一份判据，两仓必须同答案。
    const existing = await this.findCcActorIds(instanceId)
    const conn = await this.c()
    try {
      const now = new Date()
      for (const rawActorId of actorIds) {
        const actorId = normalizeActorValue(rawActorId)
        if (actorId === '' || existing.includes(actorId)) continue
        await conn.execute(this.sql(
          'INSERT INTO wf_process_cc_instance (id, process_instance_id, actor_id, state, ' +
          'create_time, create_user, update_time, update_user) VALUES (?,?,?,0,?,?,?,?)'),
          [this.idGen.nextId(), instanceId, actorId, now, creator, now, creator])
        // 同一次调用内的重复也算"已存在"，只落一行
        existing.push(actorId)
      }
    } finally {
      await this.done(conn)
    }
  }

  /**
   * issues/141 G2：某实例已有的 cc 行 actor id（写侧判重的读侧，对齐 java `findCcActorIds`）。
   * 排序按 id ASC 与本仓 `findTaskActors` 同形，让"既有集合"在两仓/跨驱动都稳定可断言。
   * ⚠️ 查询侧不带 DISTINCT：判重在写侧，历史重复行原样返回（owner 拍为接受既成事实）。
   */
  async findCcActorIds(instanceId: string): Promise<string[]> {
    const conn = await this.c()
    try {
      const rows = await conn.fetchAll(this.sql(
        'SELECT actor_id FROM wf_process_cc_instance WHERE process_instance_id = ? ORDER BY id ASC'), [instanceId])
      return rows.map(r => String(r.actor_id))
    } finally {
      await this.done(conn)
    }
  }

  async createCcInstanceIfAbsent(instanceId: string, creator: string, ...actorIds: string[]): Promise<string[]> {
    // spi 里那份 java default 的对应物（本仓的 findCcActorIds/createCcInstance 已自带判重，
    // 本方法只负责把"实际新建的子集"回传给调用方去 fire）
    return defaultCreateCcInstanceIfAbsent(this, instanceId, creator, actorIds)
  }

  async updateCcStatus(instanceId: string, actorId: string): Promise<void> {
    // issues/142 B 批（spec 06 §2.11 表第四行）：归属值入参**归一后再比**——比较值取 trim 后的串
    // （`" 123 "` 打不中行里的 `"123"` 就是"点了已读没反应"），归一后为空 ⇒ **一条 UPDATE 都不发**
    // （空 operator 会把 state=1 打到历史 `actor_id=''` 的脏行上）。与内存仓同一枚判据。
    const actor = normalizeActorValue(actorId)
    if (actor === '') return
    const conn = await this.c()
    try {
      await conn.execute(this.sql(
        'UPDATE wf_process_cc_instance SET state=1, update_time=? WHERE process_instance_id=? AND actor_id=?'),
        [new Date(), instanceId, actor])
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
    // issues/129 案 A 第二层：位置参归属过滤（t.operator）为空 ⇒ 空页。
    // 不短路的话 `WHERE t.operator = ''` 会去匹配 operator 列恰为空串的行，与内存仓（空 ⇒ 空页）、
    // 与 java（归属列空值 ⇒ `AND 1=0`）都不同答案；两仓同一份数据必须给同一个结论。
    if (isBlankValue(operator)) return { rows: [], total: 0 }
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
    // issues/129 案 A 第二层：位置参归属过滤（done=t.operator / todo=pta.actor_id）为空 ⇒ 空页，
    // 与内存仓同判据（两仓同一份数据一个答案），也让 `= ''` 不去匹配归属列恰为空串的行。
    if (isBlankValue(filter)) return { rows: [], total: 0 }
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
      // issues/45 E17：pd.display_name 与 t.display_name 列名冲突（DISTINCT 时后者覆盖）——
      // 流程名加别名 pd_display_name，mapTaskRow 分别映射
      const cols = 'DISTINCT t.id, t.process_instance_id, t.task_name, t.display_name, t.task_type, t.perform_type,' +
        ' t.task_state, t.operator, t.finish_time, t.expire_time, t.form_key, t.task_parent_id, t.variable,' +
        ' t.create_time, t.create_user, t.update_time, t.update_user,' +
        ' pd.name, pd.display_name AS pd_display_name, pd.version AS process_define_version,' +
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
      // issues/129 案 A 第二层（在**原有那句通用放行之前**，逐字对照 java JdbcProcessRepository.buildWhere）：
      // 归属谓词列 + 空值 ⇒ **空页**（`AND 1=0`），绝不能变成"这条条件不加"。
      // 门面已把空串归一化成缺省（facade `operatorArg`），这一道防的是绕过门面直接调仓储的调用方
      // 与将来的门面改动——只留门面那半不算修完（rust 1.0.17 同为两层）。
      // ⚠️ 只收归属列：下面那句"空值当作没填"是 QueryCondition 对 m_LIKE_* 等**可选过滤**的通用放行，
      // 照字面改成"空值即空页"会把可选过滤一起改坏。
      if (isBlankOwnership(c.column, c.operator, val)) {
        sql += ' AND 1=0'
        continue
      }
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
      processDefineName: r.name ?? '', processDefineDisplayName: r.pd_display_name ?? '',
      defineVersion: Number(r.process_define_version ?? 0),
      instanceVariable: r.instance_variable ?? '', instanceCreateTime: r.instance_create_time,
    }
  }

  // pageCcInstances 我的抄送分页（v1.3.0）：cc 表 join 实例 + 定义，按抄送人过滤（对齐 Java pageCcInstances）
  async pageCcInstances(pageNum: number, pageSize: number, actorId: string, conditions?: QueryCondition[]): Promise<{ rows: CcInstanceRow[]; total: number }> {
    // issues/141 G1 归属条件必填（spec 06 §2.5）：cc.actor_id 上没有有效归属证据 ⇒ 空页。
    // 这一格补的是 issues/129 那把尺子的**延长档**：129 收了"归属列给了空值"（下面 buildWhere 的
    // OWNERSHIP_COLUMNS ⇒ `AND 1=0`，位置参空值那一路也一并由 hasEffectiveCcOwnership 覆盖），
    // G1 收的是"空集合也算没填"（`[]`/空 IN ⇒ 空页，而不是让数组下库或整条条件静默消失）。
    // 旧形状在这一侧是 `FROM wf_process_instance t LEFT JOIN wf_process_cc_instance cc` 不带条件
    // 返回**全部实例**（php PDO 那面反面教材），而它自家内存仓只放"有 cc 行的实例"——同一栈两仓
    // 两个答案正是 issues/117 场景 27 立过法的形状，所以判据两仓共用 hasEffectiveCcOwnership 一份实现。
    if (!hasEffectiveCcOwnership(actorId, conditions)) return { rows: [], total: 0 }
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

  // ── Stats（issues/103：统计接口契约） ─────────────────────────────────────

  async queryInstancesForStats(stateIn?: number[] | null, start?: Date | null, end?: Date | null): Promise<InstanceStatsRow[]> {
    // stateIn 空 = 无 state 过滤（对齐内置线：仅 overview 六计数用 stateIn）
    let sql = 'SELECT process_define_id, state, operator, create_time FROM wf_process_instance WHERE 1=1'
    const args: any[] = []
    if (stateIn && stateIn.length) { sql += ` AND state IN (${repeatPh(stateIn.length)})`; args.push(...stateIn) }
    if (start) { sql += ' AND create_time >= ?'; args.push(start) }
    if (end) { sql += ' AND create_time < DATE_ADD(?, INTERVAL 1 SECOND)'; args.push(end) }
    sql += ' ORDER BY create_time'
    const conn = await this.c()
    try {
      const rows = await conn.fetchAll(this.sql(sql), args)
      return rows.map((r: any) => ({
        defineId: rowId(r.process_define_id), state: r.state,
        operator: r.operator ?? '', createTime: r.create_time,
      }))
    } finally {
      await this.done(conn)
    }
  }

  async queryTasksForStats(taskState?: number, start?: Date | null, end?: Date | null): Promise<TaskStatsRow[]> {
    let sql = 'SELECT operator, display_name, perform_type, create_time, finish_time, expire_time FROM wf_process_task WHERE 1=1'
    const args: any[] = []
    if (taskState != null) { sql += ' AND task_state = ?'; args.push(taskState) }
    if (start) { sql += ' AND finish_time >= ?'; args.push(start) }
    if (end) { sql += ' AND finish_time < DATE_ADD(?, INTERVAL 1 SECOND)'; args.push(end) }
    const conn = await this.c()
    try {
      const rows = await conn.fetchAll(this.sql(sql), args)
      return rows.map((r: any) => ({
        operator: r.operator ?? '', displayName: r.display_name ?? '',
        performType: r.perform_type ?? 0, createTime: r.create_time,
        finishTime: r.finish_time, expireTime: r.expire_time,
      }))
    } finally {
      await this.done(conn)
    }
  }

  async statsPendingAndOverdueCount(): Promise<[number, number]> {
    const conn = await this.c()
    try {
      const r1 = await conn.fetchOne(this.sql(
        'SELECT COUNT(*) FROM wf_process_task WHERE task_state = 10'), [])
      const pending = r1 ? Number(Object.values(r1)[0] ?? 0) : 0
      const now = new Date()
      const r2 = await conn.fetchOne(this.sql(
        'SELECT COUNT(*) FROM wf_process_task WHERE task_state = 10 AND expire_time IS NOT NULL AND expire_time < ?'),
        [now])
      const overdue = r2 ? Number(Object.values(r2)[0] ?? 0) : 0
      return [pending, overdue]
    } finally {
      await this.done(conn)
    }
  }

  async statsCompletedTaskAggregate(): Promise<[number, number, number, number]> {
    const conn = await this.c()
    try {
      const r = await conn.fetchOne(this.sql(
        'SELECT COUNT(*) AS total, ' +
        'SUM(CASE WHEN perform_type = 1 THEN 1 ELSE 0 END) AS countersign, ' +
        'SUM(CASE WHEN expire_time IS NOT NULL AND finish_time IS NOT NULL AND finish_time <= expire_time THEN 1 ELSE 0 END) AS on_time, ' +
        'SUM(CASE WHEN expire_time IS NOT NULL THEN 1 ELSE 0 END) AS on_time_denom ' +
        'FROM wf_process_task WHERE task_state = 20'), [])
      if (!r) return [0, 0, 0, 0]
      return [
        Number(r.total ?? 0),
        Number(r.countersign ?? 0),
        Number(r.on_time ?? 0),
        Number(r.on_time_denom ?? 0),
      ]
    } finally {
      await this.done(conn)
    }
  }

  async statsAvgCompletedDurationSeconds(start?: Date | null, end?: Date | null): Promise<number> {
    let sql = `SELECT COALESCE(ROUND(AVG(
        TIMESTAMPDIFF(SECOND, i.create_time, (
          SELECT MAX(t.finish_time) FROM wf_process_task t WHERE t.process_instance_id = i.id AND t.finish_time IS NOT NULL
        ))
      )), 0) AS avg_sec FROM wf_process_instance i WHERE i.state = 20`
    const args: any[] = []
    if (start) { sql += ' AND i.create_time >= ?'; args.push(start) }
    if (end) { sql += ' AND i.create_time < DATE_ADD(?, INTERVAL 1 SECOND)'; args.push(end) }
    const conn = await this.c()
    try {
      const r = await conn.fetchOne(this.sql(sql), args)
      if (!r) return 0
      return Number(Object.values(r)[0] ?? 0)
    } finally {
      await this.done(conn)
    }
  }

  async statsDefineGroup(start?: Date | null, end?: Date | null, limit = 10): Promise<Record<string, any>[]> {
    // 对齐内置线 mapper：count 全实例（无 state 过滤）、inner join define、
    // avg 仅对 state=20 且有 finish 的实例聚合（MAX(task.finish_time) - create_time）
    let sql = 'SELECT pd.name, pd.display_name, COUNT(*) AS cnt, ' +
      'ROUND(AVG(CASE WHEN i.state = 20 AND sub.maxft IS NOT NULL ' +
      'THEN TIMESTAMPDIFF(SECOND, i.create_time, sub.maxft) END)) AS avg_dur ' +
      'FROM wf_process_instance i ' +
      'JOIN wf_process_define pd ON i.process_define_id = pd.id ' +
      'LEFT JOIN (SELECT process_instance_id, MAX(finish_time) AS maxft ' +
      'FROM wf_process_task GROUP BY process_instance_id) sub ' +
      'ON sub.process_instance_id = i.id ' +
      'WHERE 1=1'
    const args: any[] = []
    if (start) { sql += ' AND i.create_time >= ?'; args.push(start) }
    if (end) { sql += ' AND i.create_time < DATE_ADD(?, INTERVAL 1 SECOND)'; args.push(end) }
    sql += ' GROUP BY pd.id, pd.name, pd.display_name ORDER BY cnt DESC LIMIT ?'
    args.push(limit)
    const conn = await this.c()
    try {
      const rows = await conn.fetchAll(this.sql(sql), args)
      return rows.map((r: any) => ({
        key: r.name ?? null, label: r.display_name ?? null,
        count: Number(r.cnt ?? 0),
        avgDurationSeconds: r.avg_dur != null ? Math.round(Number(r.avg_dur)) : null,
      }))
    } finally {
      await this.done(conn)
    }
  }

  async statsStuckNodeGroup(limit = 10): Promise<Record<string, any>[]> {
    const conn = await this.c()
    try {
      const rows = await conn.fetchAll(this.sql(
        'SELECT display_name, COUNT(*) AS cnt FROM wf_process_task ' +
        'WHERE task_state = 10 GROUP BY display_name ORDER BY cnt DESC LIMIT ?'),
        [limit])
      return rows.map((r: any) => ({
        key: r.display_name ?? '', label: null, count: Number(r.cnt ?? 0), avgDurationSeconds: null,
      }))
    } finally {
      await this.done(conn)
    }
  }

  async statsStuckApproverGroup(limit = 10): Promise<Record<string, any>[]> {
    const conn = await this.c()
    try {
      const rows = await conn.fetchAll(this.sql(
        'SELECT ta.actor_id, COUNT(DISTINCT t.id) AS cnt FROM wf_process_task_actor ta ' +
        'INNER JOIN wf_process_task t ON ta.process_task_id = t.id ' +
        'WHERE t.task_state = 10 GROUP BY ta.actor_id ORDER BY cnt DESC LIMIT ?'),
        [limit])
      return rows.map((r: any) => ({
        key: rowId(r.actor_id), label: null, count: Number(r.cnt ?? 0), avgDurationSeconds: null,
      }))
    } finally {
      await this.done(conn)
    }
  }

  async statsCompletedInstanceDurations(start?: Date | null, end?: Date | null): Promise<number[]> {
    let sql = `SELECT TIMESTAMPDIFF(SECOND, i.create_time, (
        SELECT MAX(t.finish_time) FROM wf_process_task t WHERE t.process_instance_id = i.id AND t.finish_time IS NOT NULL
      )) AS dur FROM wf_process_instance i WHERE i.state = 20`
    const args: any[] = []
    if (start) { sql += ' AND i.create_time >= ?'; args.push(start) }
    if (end) { sql += ' AND i.create_time < DATE_ADD(?, INTERVAL 1 SECOND)'; args.push(end) }
    const conn = await this.c()
    try {
      const rows = await conn.fetchAll(this.sql(sql), args)
      return rows.map((r: any) => Number(r.dur)).filter((v: number) => v != null && !isNaN(v))
    } finally {
      await this.done(conn)
    }
  }
}

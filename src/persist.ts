import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { KeySubmitType, KeyDeptID } from './engine.js'
import { TypeEnd, TypeTask, TypeCustom, InstanceState, SubmitType, type ProcessInstance, type ProcessDefine, type FlowNode } from './model.js'
import type { FlowInterceptor } from './extensions.js'
import type { HandlerRegistry } from './registry.js'

// ═══ 动态表写入组件（引擎无关）— issues/18 ═══════════════════════════════════

/**
 * 动态表写入组件接口——引擎无关，四语言契约一致（Java/Go/Python/Node）
 *
 * 用法：给「表名 + 字段 Map」安全写入任意业务表（列过滤 / 参数化 INSERT /
 * 幂等 / 系统字段）。不依赖工作流引擎。
 */
export interface DynamicTableWriter {
  /** 按目标表过滤列（表结构探测），返回表内实际存在的列 */
  filterColumns(tableName: string, columns: string[]): string[] | Promise<string[]>
  /** 参数化 INSERT（按列过滤结果落库），返回生成主键 */
  insert(tableName: string, data: Record<string, unknown>): unknown | Promise<unknown>
  /** 参数化 UPDATE（按列过滤结果组装 SET；条件列排除，防注入），返回受影响行数
   * （SYNC 同步演进，issues/24） */
  update(tableName: string, data: Record<string, unknown>, whereColumn: string, whereValue: unknown): number | Promise<number>
  /** 幂等检查：指定业务键（如 process_instance_id）是否已存在 */
  exists(tableName: string, bizKey: string, bizKeyValue: unknown): boolean | Promise<boolean>
  /** 按配置列名填充系统字段（未配置的列跳过） */
  fillSystemFields(data: Record<string, unknown>, isInsert: boolean): void
}

// ─── 默认实现：node:sqlite（内置零依赖） ──────────────────────────────────────

const TABLE_NAME_RE = /^[A-Za-z0-9_]+$/

/** 表列元数据（issues/21：主键/自增用于主键生成决策） */
interface ColumnMeta {
  name: string          // 表列原名（UPPER）
  primaryKey: boolean
  autoIncrement: boolean
}

/** 列名归一（issues/20）：转小写 + 去下划线（companyName / company_name / COMPANY_NAME 等价） */
function normalizeColumn(name: string): string {
  return name.toLowerCase().replace(/_/g, '')
}

function nowText(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 表名安全校验：非空、合法字符、拒绝 sys_ 前缀 */
function checkTableName(tableName: string): void {
  if (!tableName) throw new Error('persist: table name is empty')
  if (tableName.startsWith('sys_')) throw new Error(`persist: table ${tableName} with sys_ prefix is not allowed`)
  if (!TABLE_NAME_RE.test(tableName)) throw new Error(`persist: table ${tableName} contains illegal characters`)
}

/**
 * 动态表写入器默认实现（node:sqlite DatabaseSync）。
 *
 * 注意：node:sqlite 是实验特性（Node 22.5+，无需外部依赖）。
 * MySQL/PG 集成方可自行实现 DynamicTableWriter 接口（契约见上）。
 */
export class SqliteDynamicTableWriter implements DynamicTableWriter {
  private cache = new Map<string, ColumnMeta[]>()

  /** 系统字段列名（null/undefined 禁用） */
  createTimeColumn?: string | null = 'create_time'
  createUserColumn?: string | null = 'create_user'
  updateTimeColumn?: string | null = 'update_time'
  updateUserColumn?: string | null = 'update_user'
  isDeletedColumn?: string | null = 'is_deleted'
  /** 用户列默认值（issues/19）：优先取 data 中已注入的 apply_user_id=流程 operator，
   *  否则用此配置值，缺省 "system"——多数框架业务表 create_user/update_user 为 BIGINT 存 userId */
  defaultUserValue: unknown = 'system'
  /** 列匹配（issues/20）：默认宽松——驼峰↔下划线归一匹配（表单字段 companyName ↔ 表列 company_name）；
   *  需要精确控制列名的集成方显式开启严格模式（忽略大小写精确匹配） */
  strictColumnMatch = false
  /** 主键生成器（issues/21）：非自增主键表（雪花/应用生成）插入时生成主键值，入参表名 */
  primaryKeyGenerator?: (tableName: string) => unknown

  constructor(private db: DatabaseSync) {}

  private tableColumns(tableName: string): ColumnMeta[] {
    const cached = this.cache.get(tableName)
    if (cached) return cached
    // PRAGMA 不支持占位符——表名已过安全校验；INTEGER PRIMARY KEY 为 rowid 别名（自增）
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string; type: string; pk: number }>
    if (rows.length === 0) throw new Error(`persist: table ${tableName} not found`)
    const cols = rows.map(r => ({
      name: r.name.toUpperCase(),
      primaryKey: r.pk === 1,
      autoIncrement: r.pk === 1 && r.type.trim().toUpperCase() === 'INTEGER',
    }))
    this.cache.set(tableName, cols)
    return cols
  }

  filterColumns(tableName: string, columns: string[]): string[] {
    checkTableName(tableName)
    const cols = this.tableColumns(tableName)
    return columns.filter(c => this.findColumn(cols, c) !== '')
  }

  insert(tableName: string, data: Record<string, unknown>): unknown {
    checkTableName(tableName)
    const cols = this.tableColumns(tableName)
    const names: string[] = []
    const values: SQLInputValue[] = []
    // 保持插入顺序稳定（对象键无序，按表列顺序取）；写入用表列原名（issues/20）
    for (const m of cols) {
      const key = this.findDataKey(data, m.name)
      if (key !== '') {
        names.push(m.name)
        values.push(data[key] as SQLInputValue)
        continue
      }
      // 主键生成（issues/21）：非自增主键表且 data 无主键值 → 调生成器；未配置 → 清晰报错
      if (m.primaryKey && !m.autoIncrement) {
        if (!this.primaryKeyGenerator) {
          throw new Error(`persist: table ${tableName} primary key ${m.name} is not auto-increment and no primary key generator configured (set primaryKeyGenerator, e.g. snowflake)`)
        }
        names.push(m.name)
        values.push(this.primaryKeyGenerator(tableName) as SQLInputValue)
      }
    }
    if (names.length === 0) throw new Error(`persist: no matching columns for ${tableName}`)
    const placeholders = names.map(() => '?').join(',')
    const stmt = this.db.prepare(`INSERT INTO ${tableName} (${names.join(',')}) VALUES (${placeholders})`)
    const res = stmt.run(...values)
    return res.lastInsertRowid
  }

  /** 列匹配（issues/20）：严格=忽略大小写精确；宽松（默认）=驼峰↔下划线归一匹配 */
  private findColumn(cols: ColumnMeta[], key: string): string {
    for (const m of cols) {
      if (this.strictColumnMatch) {
        if (m.name.toUpperCase() === key.toUpperCase()) return m.name
      } else if (normalizeColumn(m.name) === normalizeColumn(key)) {
        return m.name
      }
    }
    return ''
  }

  /** 在 data 中找匹配指定表列的 key（宽松模式驼峰 key 匹配下划线列） */
  private findDataKey(data: Record<string, unknown>, col: string): string {
    for (const k of Object.keys(data)) {
      if (this.strictColumnMatch) {
        if (col.toUpperCase() === k.toUpperCase()) return k
      } else if (normalizeColumn(col) === normalizeColumn(k)) {
        return k
      }
    }
    return ''
  }

  exists(tableName: string, bizKey: string, bizKeyValue: unknown): boolean {
    checkTableName(tableName)
    this.tableColumns(tableName) // 表不存在提前报错
    const row = this.db.prepare(`SELECT COUNT(1) AS c FROM ${tableName} WHERE ${bizKey} = ?`).get(bizKeyValue as SQLInputValue) as { c: number }
    return Number(row?.c ?? 0) > 0
  }

  /** 参数化 UPDATE（SYNC 同步演进，issues/24）：列过滤（宽松匹配）+ 条件列排除 +
   *  参数化 SET，返回受影响行数。对齐 Java JdbcDynamicTableWriter.update。 */
  update(tableName: string, data: Record<string, unknown>, whereColumn: string, whereValue: unknown): number {
    checkTableName(tableName)
    if (!whereColumn) throw new Error(`persist: update ${tableName} requires where column`)
    const cols = this.tableColumns(tableName)
    const sets: string[] = []
    const values: SQLInputValue[] = []
    for (const m of cols) {
      if (normalizeColumn(m.name) === normalizeColumn(whereColumn)) continue // 条件列不参与 SET
      const key = this.findDataKey(data, m.name)
      if (key) {
        sets.push(`${m.name} = ?`)
        values.push(data[key] as SQLInputValue)
      }
    }
    if (sets.length === 0) return 0 // 无更新列（如结束节点仅状态探测未命中）
    values.push(whereValue as SQLInputValue)
    const res = this.db.prepare(`UPDATE ${tableName} SET ${sets.join(',')} WHERE ${whereColumn} = ?`).run(...values)
    return Number(res.changes ?? 0)
  }

  fillSystemFields(data: Record<string, unknown>, isInsert: boolean): void {
    const now = nowText()
    if (isInsert) {
      if (this.createTimeColumn) data[this.createTimeColumn] ??= now
      if (this.createUserColumn) data[this.createUserColumn] ??= this.resolveDefaultUser(data)
      if (this.updateTimeColumn) data[this.updateTimeColumn] ??= now
      if (this.updateUserColumn) data[this.updateUserColumn] ??= this.resolveDefaultUser(data)
      if (this.isDeletedColumn) data[this.isDeletedColumn] ??= 0
    } else {
      if (this.updateTimeColumn) data[this.updateTimeColumn] = now
      if (this.updateUserColumn) data[this.updateUserColumn] ??= this.resolveDefaultUser(data)
    }
  }

  /** 默认用户值（issues/19）：优先取 data 中已注入的 apply_user_id
   * （拦截器场景 = 流程 operator，BIGINT 用户列表开箱即用），否则回落配置默认值 */
  private resolveDefaultUser(data: Record<string, unknown>): unknown {
    return data['apply_user_id'] ?? this.defaultUserValue
  }
}

// ═══ 工作流入库适配拦截器 ════════════════════════════════════════════════════

/** 流程定义加载器（用于解析 relTableName / persistMode / 流程 name），通常透传仓库 findDefineById */
export type DefineLoader = (defineId: string) => Promise<ProcessDefine | null>

/** 持久化模式（流程定义顶层 persistMode，缺省 ARCHIVE） */
export const PersistModeArchive = 'ARCHIVE' // 结束归档（现状）：流程结束同意后落库
export const PersistModeSync = 'SYNC'       // 同步演进：发起 INSERT → 任务节点 UPDATE → 结束定稿

/** 字段权限值（任务节点 properties.field 的 PERMISSION_{字段名}，vben5-wf 机制） */
export const PermReadOnly = 1 // 只读：不更新
export const PermEdit = 2     // 可编辑：更新
export const PermHidden = 3   // 隐藏：不更新

/**
 * 工作流业务数据入库适配拦截器——按流程定义顶层 persistMode 分派：
 *
 * - ARCHIVE（缺省）：流程结束同意后，f_ 表单数据写入业务表（一次落库）
 * - SYNC（1.8.0，issues/24 同步演进）：提交申请即入库（start 节点 INSERT 全量），
 *   任务节点推进 UPDATE（f_ 按节点字段权限过滤 + tf_ 冗余 + 状态字段=DOING），
 *   结束节点定稿 UPDATE（最终状态 FINISHED/REJECT）——不管成功失败都入库
 *
 * 对标 Java PersistPostInterceptor（1.8.0）。
 */
export class PersistPostInterceptor implements FlowInterceptor {
  order = 0
  fieldPrefix = 'f_'
  taskFieldPrefix = 'tf_'

  constructor(
    private writer: DynamicTableWriter | null,
    private loader: DefineLoader | null,
  ) {}

  async preHandle(_node: FlowNode, _inst: ProcessInstance): Promise<boolean> {
    return true
  }

  async postHandle(node: FlowNode, inst: ProcessInstance): Promise<void> {
    if (!this.writer || !this.loader) return // 未注入：静默跳过
    if (!node || !inst) return
    const { tableName, persistMode } = await this.resolveDefine(inst)
    if (!tableName) return // 未配置：静默跳过
    if (persistMode.toUpperCase() === PersistModeSync) {
      await this.handleSync(node, inst, tableName)
      return
    }
    await this.handleArchive(node, inst, tableName)
  }

  // ─── ARCHIVE（现状：结束同意归档） ──────────────────────────────────────────

  private async handleArchive(node: FlowNode, inst: ProcessInstance, tableName: string): Promise<void> {
    const writer = this.writer
    if (!writer) return
    // 时机：仅结束节点 + 流程正常完成（Done）+ 同意
    if (node.type !== TypeEnd) return
    if (inst.state !== InstanceState.Done) return
    const submitType = Number(inst.variables[KeySubmitType])
    if (submitType !== SubmitType.Agree) return
    if (!this.markChain(node, inst)) return
    // 幂等：以 process_instance_id 为键，先查后插。
    // 表不存在等探测失败是配置错误，必须显性暴露（与 Java/Python 抛异常一致）
    if (await writer.exists(tableName, 'process_instance_id', inst.id)) return

    const data = this.extractFields(inst, null, false, true) // 只 f_ 全量
    this.fillContext(data, inst)
    writer.fillSystemFields(data, true)
    await writer.insert(tableName, data)
  }

  // ─── SYNC（1.8.0 同步演进：发起入库 → 节点推进 → 结束定稿） ──────────────────

  private async handleSync(node: FlowNode, inst: ProcessInstance, tableName: string): Promise<void> {
    const writer = this.writer
    if (!writer) return
    if (!this.markChain(node, inst)) return // 同链同节点不重复（节点级，issues/19 演进）
    const exists = await writer.exists(tableName, 'process_instance_id', inst.id)

    // 任务节点（TypeTask/TypeCustom）才更新业务字段：f_ 按节点字段权限过滤；
    // 结束/网关等非任务节点只定稿状态，避免全量覆盖任务节点的只读/隐藏限制
    const isTask = node.type === TypeTask || node.type === TypeCustom
    const fieldPerm = isTask ? this.resolveFieldPermission(node) : null
    const data = this.extractFields(inst, fieldPerm, !exists || isTask, !exists || isTask)

    // 状态字段：优先 {节点ID}_{状态码} 列，无则 {节点ID} 列。
    // 任务节点写 DOING(10)——任务推进状态；结束节点写实例最终状态（FINISHED/REJECT）
    let stateCode = Number(inst.state)
    if (isTask) stateCode = InstanceState.Doing
    this.putStateField(writer, tableName, data, node.id, stateCode)

    this.fillContext(data, inst)
    if (!exists) {
      writer.fillSystemFields(data, true)
      await writer.insert(tableName, data)
      return
    }
    writer.fillSystemFields(data, false) // 只填 update 组
    await writer.update(tableName, data, 'process_instance_id', inst.id)
  }

  // ─── 公共 ───────────────────────────────────────────────────────────────────

  private async resolveDefine(inst: ProcessInstance): Promise<{ tableName: string; persistMode: string }> {
    const define = await this.loader!(inst.defineId)
    if (!define) return { tableName: '', persistMode: '' }
    const content = typeof define.content === 'string' ? define.content : new TextDecoder().decode(define.content)
    let meta: { relTableName?: string; name?: string; persistMode?: string }
    try {
      meta = JSON.parse(content)
    } catch {
      return { tableName: '', persistMode: '' }
    }
    const tableName = (meta.relTableName ?? '').trim()
    return {
      tableName: tableName || (meta.name ?? '').trim(), // 缺省回落流程 name
      persistMode: (meta.persistMode ?? '').trim(),
    }
  }

  /** 同链重复触发防护（issues/19，1.8.0 节点级）：同一执行链中**每个节点**触发一次
   * （任务推进更新 + 结束定稿是不同节点，都要生效），同节点不重复；exists 兜底跨请求。 */
  private markChain(node: FlowNode, inst: ProcessInstance): boolean {
    const chainKey = `__persist_executed_${inst.id}_${node.id}`
    if (inst.variables[chainKey] === true) return false
    inst.variables[chainKey] = true
    return true
  }

  /** 提取字段：f_ 去前缀（SYNC 下按字段权限过滤——只读/隐藏不更新；
   *  includeFormFields=false 时不带出，用于非任务节点定稿避免覆盖只读限制）；
   *  tf_ 去前缀冗余（有列则写，列过滤由 writer 做） */
  private extractFields(inst: ProcessInstance, fieldPerm: Record<string, unknown> | null,
                        includeTaskFields: boolean, includeFormFields: boolean): Record<string, unknown> {
    const prefix = this.fieldPrefix || 'f_'
    const taskPrefix = this.taskFieldPrefix || 'tf_'
    const data: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(inst.variables)) {
      if (includeFormFields && k.startsWith(prefix) && k.length > prefix.length) {
        const name = k.slice(prefix.length)
        if (!this.isEditable(fieldPerm, name)) continue
        data[name] = v
      } else if (includeTaskFields && k.startsWith(taskPrefix) && k.length > taskPrefix.length) {
        data[k.slice(taskPrefix.length)] = v
      }
    }
    return data
  }

  /** 任务节点字段权限（node.properties.field 的 PERMISSION_x；缺省 null=全部可编辑） */
  private resolveFieldPermission(node: FlowNode): Record<string, unknown> | null {
    const field = node.properties?.field
    if (field && typeof field === 'object' && Object.keys(field as object).length > 0) {
      return field as Record<string, unknown>
    }
    return null
  }

  /** 字段可编辑判定：无声明或 EDIT(2) 可更新；READ_ONLY(1)/HIDDEN(3) 不更新 */
  /** 字段可编辑判定：无声明或 EDIT(2) 可更新；READ_ONLY(1)/HIDDEN(3) 不更新。
   *  键格式兼容两种（issues/25）：
   *  - PERMISSION_f_{表单字段全名}——前端 vben5-wf 设计器约定（优先）
   *  - PERMISSION_{去前缀名}——后端 1.8.0 首版格式（兼容） */
  private isEditable(fieldPerm: Record<string, unknown> | null, fieldName: string): boolean {
    if (!fieldPerm) return true
    const prefix = this.fieldPrefix || 'f_'
    let perm = fieldPerm[`PERMISSION_${prefix}${fieldName}`]
    if (perm == null) perm = fieldPerm[`PERMISSION_${fieldName}`]
    if (perm == null) return true
    return Number(perm) === PermEdit
  }

  /** 状态字段写入：优先 {节点ID}_{状态码} 列，无则 {节点ID} 列（列探测过滤） */
  private putStateField(writer: DynamicTableWriter, tableName: string, data: Record<string, unknown>,
                        nodeId: string, stateCode: number): void {
    if (!nodeId) return
    const kept = writer.filterColumns(tableName, [`${nodeId}_${stateCode}`, nodeId])
    if (Array.isArray(kept) && kept.length > 0) data[kept[0]] = stateCode
  }

  /** 流程上下文字段（蛇形列名约定，与 writer 系统字段一致） */
  private fillContext(data: Record<string, unknown>, inst: ProcessInstance): void {
    data['process_instance_id'] ??= inst.id
    data['apply_user_id'] ??= inst.operator
    data['apply_dept_id'] ??= inst.variables[KeyDeptID] ?? null
  }
}

// ─── 注册助手（issues/60）──────────────────────────────────────────────────────

/** 将 PersistPostInterceptor 元数据注册进处理器注册中心（SPI 字典源），
 *  集成方在实例组装处调用一次即可，保证"字典项 ⟺ 实例"同步（避免各端写死注册遗漏/名不一致）。 */
export function registerPersistMeta(registry: HandlerRegistry) {
  registry.registerMeta('FlowInterceptor', {
    name: 'com.mldong.jeeflow.persist.interceptor.PersistPostInterceptor',
    displayName: '业务数据自动入库',
    order: 0,
    group: 'post',
  })
}

import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { KeySubmitType, KeyDeptID } from './engine.js'
import { TypeEnd, InstanceState, SubmitType, type ProcessInstance, type ProcessDefine, type FlowNode } from './model.js'
import type { FlowInterceptor } from './extensions.js'

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

/** 流程定义加载器（用于解析 relTableName / 流程 name），通常透传仓库 findDefineById */
export type DefineLoader = (defineId: number) => Promise<ProcessDefine | null>

/**
 * 工作流业务数据入库适配拦截器——流程结束同意后，f_ 表单数据写入业务表。
 *
 * 语义（spec 契约，四语言一致）：
 * - 时机：结束节点执行后 + 实例 Done + submitType=AGREE（不同意/退回不入库）
 * - 字段：实例 Variables 中 f_ 前缀字段，去前缀
 * - 表名：流程定义 content 顶层 relTableName，缺省回落流程 name
 * - 系统字段：writer 通用字段 + 流程上下文（process_instance_id / apply_user_id /
 *   apply_dept_id，蛇形列名约定）
 * - 幂等：bizKey = process_instance_id（先查后插，跨请求有效）
 * - 静默跳过：非结束节点 / 非同意 / 未配置表名 / writer 未注入
 * - 表不存在 = 配置错误 → 显性抛错（快速失败）
 */
export class PersistPostInterceptor implements FlowInterceptor {
  order = 0
  fieldPrefix = 'f_'

  constructor(
    private writer: DynamicTableWriter | null,
    private loader: DefineLoader | null,
  ) {}

  async preHandle(_node: FlowNode, _inst: ProcessInstance): Promise<boolean> {
    return true
  }

  async postHandle(node: FlowNode, inst: ProcessInstance): Promise<void> {
    if (!this.writer || !this.loader) return // 未注入：静默跳过
    // 时机：仅结束节点 + 流程正常完成（Done）+ 同意
    if (!node || node.type !== TypeEnd) return
    if (!inst || inst.state !== InstanceState.Done) return
    const submitType = Number(inst.variables[KeySubmitType])
    if (submitType !== SubmitType.Agree) return

    // 同链重复触发防护（issues/19）：最后任务节点与结束节点都会触发后置拦截器，
    // 同一执行链（共享 inst.variables）只插一次。标记写入时实例已完成持久化
    // （引擎 executeNode 先 updateInstance 后触发拦截器，repo 存副本）不会落库；
    // exists 保留作为跨请求/重启的幂等兜底（先查后插语义不变）。
    const chainKey = `__persist_executed_${inst.id}`
    if (inst.variables[chainKey] === true) return
    inst.variables[chainKey] = true

    // 表名：流程定义顶层 relTableName，缺省回落流程 name
    const tableName = await this.resolveTableName(inst)
    if (!tableName) return // 未配置：静默跳过

    // 幂等：以 process_instance_id 为键，先查后插
    if (await this.writer.exists(tableName, 'process_instance_id', inst.id)) return

    // 提取 f_ 前缀字段（去前缀）
    const prefix = this.fieldPrefix || 'f_'
    const data: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(inst.variables)) {
      if (k.startsWith(prefix) && k.length > prefix.length) data[k.slice(prefix.length)] = v
    }

    // 流程上下文字段（蛇形列名约定，与 writer 系统字段一致）
    data['process_instance_id'] ??= inst.id
    data['apply_user_id'] ??= inst.operator
    data['apply_dept_id'] ??= inst.variables[KeyDeptID] ?? null

    // 通用系统字段（writer 按配置列填充）
    this.writer.fillSystemFields(data, true)

    await this.writer.insert(tableName, data)
  }

  private async resolveTableName(inst: ProcessInstance): Promise<string> {
    const define = await this.loader!(inst.defineId)
    if (!define) return ''
    const content = typeof define.content === 'string' ? define.content : new TextDecoder().decode(define.content)
    let meta: { relTableName?: string; name?: string }
    try {
      meta = JSON.parse(content)
    } catch {
      return ''
    }
    const tableName = (meta.relTableName ?? '').trim()
    return tableName || (meta.name ?? '').trim() // 缺省回落流程 name
  }
}

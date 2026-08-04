import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { DynamicTableWriter } from './persist.js'

// ═══ 元数据驱动的动态写入/读取规范（issues/23）— 与 Java/Go/Python 契约一致 ═══

/** 字段存储类型（对齐 mldong dev_schema_field 1-5 语义） */
export enum StorageType {
  Normal = 1,   // 直写列
  Expand = 2,   // 对象展开为多列（expandFields 定义子字段列映射）
  Json = 3,     // 对象/数组序列化为 JSON 串写列
  One2One = 4,  // 子表单条（外键=主表主键，同事务）
  One2Many = 5, // 子表多条（外键=主表主键，同事务）
}

/** 解析 storageType：支持名称（"EXPAND"）与数字（2，mldong 语义） */
export function parseStorageType(v: unknown): StorageType {
  if (typeof v === 'number') return v as StorageType
  if (typeof v === 'string') return StorageType[v as keyof typeof StorageType] ?? StorageType.Normal
  return StorageType.Normal
}

/** 字段元数据——表单字段 → 存储语义映射 */
export interface FieldMeta {
  name: string                          // 表单字段名（f_ 去前缀）
  columnName?: string                   // 主表列名（缺省 = name 转下划线）
  storageType?: StorageType             // 默认 NORMAL
  expandFields?: Record<string, string> // EXPAND：子字段名 → 表列名
  targetTable?: string                  // ONE2ONE/ONE2MANY：子表表名
  foreignKey?: string                   // 子表外键列（缺省 = 主表主键列名）
}

/** 表元数据——一张业务表的字段存储规范 */
export interface TableMeta {
  tableName: string
  primaryKey?: string // 默认 id
  fields: FieldMeta[]
}

export function columnOf(f: FieldMeta): string {
  return f.columnName || toUnderline(f.name)
}

export function pkOf(m: TableMeta): string {
  return m.primaryKey || 'id'
}

export function findField(m: TableMeta, name: string): FieldMeta | undefined {
  return m.fields.find(f => f.name.toLowerCase() === name.toLowerCase())
}

export function findFieldByColumn(m: TableMeta, columnName: string): FieldMeta | undefined {
  return m.fields.find(f => columnOf(f).toLowerCase() === columnName.toLowerCase())
}

/** 驼峰转下划线（companyName → company_name） */
export function toUnderline(name: string): string {
  return name.replace(/([A-Z])/g, (c, _: string, i: number) => (i > 0 ? '_' : '') + c.toLowerCase())
}

/** 元数据提供者 SPI——集成方只实现这一件事；未定义返回 null（回落表结构探测） */
export interface IDynamicMetaProvider {
  loadTableMeta(tableName: string): TableMeta | null
}

/** 内置 JSON 配置加载器——从目录加载（文件名 = 表名，如 biz_leave.json） */
export class JsonMetaProvider implements IDynamicMetaProvider {
  private cache = new Map<string, TableMeta>()

  constructor(private dir: string) {}

  loadTableMeta(tableName: string): TableMeta | null {
    if (this.cache.has(tableName)) return this.cache.get(tableName)!
    const data = readFileSyncSafe(`${this.dir}/${tableName}.json`)
    if (data === null) return null
    const raw = JSON.parse(data) as any
    const meta: TableMeta = {
      tableName: raw.tableName ?? tableName,
      primaryKey: raw.primaryKey ?? 'id',
      fields: (raw.fields ?? []).map((f: any) => ({
        name: f.name,
        columnName: f.columnName,
        storageType: parseStorageType(f.storageType ?? 1),
        expandFields: f.expandFields,
        targetTable: f.targetTable,
        foreignKey: f.foreignKey,
      })),
    }
    this.cache.set(tableName, meta)
    return meta
  }
}

import { readFileSync } from 'node:fs'

function readFileSyncSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

// ═══ MetaTableWriter（写，纯写职责） ═══════════════════════════════════════════

/** 元数据驱动的动态写入器——按 TableMeta.storageType 语义执行插入；
 *  无元数据时完全委托基础 writer（回落现状，零破坏）。读侧由 MetaTableReader 提供。 */
export class MetaTableWriter implements DynamicTableWriter {
  constructor(private base: DynamicTableWriter, private provider: IDynamicMetaProvider) {}

  filterColumns(tableName: string, columns: string[]): string[] | Promise<string[]> {
    return this.base.filterColumns(tableName, columns)
  }

  insert(tableName: string, data: Record<string, unknown>): unknown {
    const meta = this.provider.loadTableMeta(tableName)
    if (!meta) return this.base.insert(tableName, data) // 无元数据：回落现状

    const subData = new Map<string, unknown>()
    const row: Record<string, unknown> = {}
    for (const f of meta.fields) {
      const v = data[f.name]
      if (v === undefined || v === null) continue
      const st = f.storageType ?? StorageType.Normal
      if (st === StorageType.Json) {
        row[columnOf(f)] = JSON.stringify(v)
      } else if (st === StorageType.Expand) {
        this.expandInto(f, v, row)
      } else if (st === StorageType.One2One || st === StorageType.One2Many) {
        subData.set(f.name, v)
      } else {
        row[columnOf(f)] = v
      }
    }
    // 未消费字段（流程上下文 process_instance_id 等）直通基础 writer
    for (const [k, v] of Object.entries(data)) {
      if (!findField(meta, k)) row[k] ??= v
    }
    this.base.fillSystemFields(row, true)
    let pk = this.base.insert(tableName, row) // 主表插入（自增/生成器返回主键）
    if (pk === undefined || pk === null) pk = findRowValue(row, pkOf(meta))
    // 子表递归插入（外键=主表主键；继承主表 apply_user_id，issues/24）
    for (const [name, v] of subData) {
      this.insertSubTable(meta, findField(meta, name)!, v, pk, data)
    }
    return pk
  }

  /** 按元数据 storageType 组装 SET 列（SYNC 同步演进，issues/24）——
   *  NORMAL/JSON/EXPAND 参与更新；ONE2ONE/ONE2MANY 子表不参与中途更新
   *  （任务推进只更新主表行状态，子表数据变动走重新提交）；未消费字段直通。 */
  update(tableName: string, data: Record<string, unknown>, whereColumn: string, whereValue: unknown): number | Promise<number> {
    const meta = this.provider.loadTableMeta(tableName)
    if (!meta) return this.base.update(tableName, data, whereColumn, whereValue) // 无元数据：回落基础 writer
    const row: Record<string, unknown> = {}
    for (const f of meta.fields) {
      const v = data[f.name]
      if (v === undefined || v === null) continue
      const st = f.storageType ?? StorageType.Normal
      if (st === StorageType.Json) {
        row[columnOf(f)] = JSON.stringify(v)
      } else if (st === StorageType.Expand) {
        this.expandInto(f, v, row)
      } else if (st === StorageType.One2One || st === StorageType.One2Many) {
        continue // 子表不参与中途更新
      } else {
        row[columnOf(f)] = v
      }
    }
    // 未消费字段（流程上下文/状态字段等）直通基础 writer
    for (const [k, v] of Object.entries(data)) {
      if (!findField(meta, k)) row[k] ??= v
    }
    return this.base.update(tableName, row, whereColumn, whereValue)
  }

  exists(tableName: string, bizKey: string, bizKeyValue: unknown): boolean | Promise<boolean> {
    return this.base.exists(tableName, bizKey, bizKeyValue)
  }

  fillSystemFields(data: Record<string, unknown>, isInsert: boolean): void {
    this.base.fillSystemFields(data, isInsert)
  }

  private expandInto(f: FieldMeta, v: unknown, row: Record<string, unknown>): void {
    if (typeof v !== 'object' || v === null) return
    const obj = v as Record<string, unknown>
    for (const [sub, col] of Object.entries(f.expandFields ?? {})) {
      if (obj[sub] !== undefined && obj[sub] !== null) row[col] = obj[sub]
    }
  }

  private insertSubTable(parentMeta: TableMeta, f: FieldMeta, v: unknown, parentPk: unknown,
                         parentData: Record<string, unknown>): void {
    if (parentPk === undefined || parentPk === null) {
      throw new Error(`persist: parent primary key missing, cannot insert sub table ${f.name}`)
    }
    const fk = f.foreignKey || pkOf(parentMeta)
    const st = f.storageType ?? StorageType.Normal
    if (st === StorageType.One2One && typeof v === 'object' && v !== null) {
      this.insertSubRow(f, v as Record<string, unknown>, fk, parentPk, parentData)
    } else if (st === StorageType.One2Many && Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'object' && item !== null) {
          this.insertSubRow(f, item as Record<string, unknown>, fk, parentPk, parentData)
        }
      }
    }
  }

  /** 子表单行插入（issues/24）：继承主表 apply_user_id（拦截器场景=流程 operator），
   *  子表单显式同名字段优先（??=）——fillSystemFields 的用户列默认值可解析到 operator，
   *  避免 BIGINT create_user/update_user 列回落 "system" 严格模式报错 */
  private insertSubRow(f: FieldMeta, subData: Record<string, unknown>, fk: string,
                       parentPk: unknown, parentData: Record<string, unknown>): void {
    const row = { ...subData, [fk]: parentPk }
    if (parentData['apply_user_id'] !== undefined) {
      row['apply_user_id'] ??= parentData['apply_user_id']
    }
    this.insert(f.targetTable!, row) // 递归走子表自身元数据
  }
}

// ═══ JdbcTableReader（读侧底层） ═══════════════════════════════════════════════

/** 业务表查询器——按列等值查询原始行（与写入器职责分离） */
export class JdbcTableReader {
  constructor(private db: DatabaseSync) {}

  queryFirst(tableName: string, whereColumn: string, value: unknown): Record<string, unknown> | null {
    const rows = this.queryList(tableName, whereColumn, value, 1)
    return rows.length > 0 ? rows[0] : null
  }

  queryList(tableName: string, whereColumn: string, value: unknown, limit: number): Record<string, unknown>[] {
    const sql = `SELECT * FROM ${tableName} WHERE ${whereColumn} = ?${limit > 0 ? ` LIMIT ${limit}` : ''}`
    return this.db.prepare(sql).all(value as SQLInputValue) as Record<string, unknown>[]
  }
}

// ═══ MetaTableReader（读，流程回显最小闭环） ═══════════════════════════════════

/** 元数据驱动的动态读取器——按流程实例回显业务数据。
 *  边界（不做）：通用条件分页 / 动态条件语法 / 数据权限 / 排序。 */
export class MetaTableReader {
  constructor(private reader: JdbcTableReader, private provider: IDynamicMetaProvider) {}

  readByProcessInstance(tableName: string, processInstanceId: unknown): Record<string, unknown> | null {
    const row = this.reader.queryFirst(tableName, 'process_instance_id', processInstanceId)
    if (!row) return null
    const meta = this.provider.loadTableMeta(tableName)
    if (!meta) return row // 无元数据：原样返回（列名→值）
    return this.assemble(meta, row)
  }

  assemble(meta: TableMeta, row: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const f of meta.fields) {
      const v = findRowValue(row, columnOf(f))
      const st = f.storageType ?? StorageType.Normal
      if (st === StorageType.Json) {
        if (v !== undefined && v !== null) {
          try { result[f.name] = JSON.parse(String(v)) } catch { result[f.name] = v }
        }
      } else if (st === StorageType.Expand) {
        const obj = this.expandFrom(row, f)
        if (Object.keys(obj).length > 0) result[f.name] = obj
      } else if (st === StorageType.One2One || st === StorageType.One2Many) {
        const sub = this.readSubTable(meta, f, row)
        if (sub !== undefined && sub !== null) result[f.name] = sub
      } else if (v !== undefined && v !== null) {
        result[f.name] = v
      }
    }
    // 未在元数据中的列带出（key 统一小写）；
    // EXPAND 展开列（挂在某字段 expandFields 映射里，对象形式已带出）不重复平铺（issues/24）
    for (const [k, v] of Object.entries(row)) {
      if (!findFieldByColumn(meta, k) && !isExpandColumn(meta, k)) result[k.toLowerCase()] ??= v
    }
    return result
  }

  private expandFrom(row: Record<string, unknown>, f: FieldMeta): Record<string, unknown> {
    const obj: Record<string, unknown> = {}
    for (const [sub, col] of Object.entries(f.expandFields ?? {})) {
      const v = findRowValue(row, col)
      if (v !== undefined && v !== null) obj[sub] = v
    }
    return obj
  }

  private readSubTable(parentMeta: TableMeta, f: FieldMeta, row: Record<string, unknown>): unknown {
    const parentPk = findRowValue(row, pkOf(parentMeta))
    if (parentPk === undefined || parentPk === null) return null
    const fk = f.foreignKey || pkOf(parentMeta)
    const subMeta = this.provider.loadTableMeta(f.targetTable!)
    const st = f.storageType ?? StorageType.Normal
    if (st === StorageType.One2One) {
      const sub = this.reader.queryFirst(f.targetTable!, fk, parentPk)
      if (!sub) return null
      return subMeta ? this.assemble(subMeta, sub) : sub
    }
    // ONE2MANY
    const subs = this.reader.queryList(f.targetTable!, fk, parentPk, 0)
    return subs.map(sub => (subMeta ? this.assemble(subMeta, sub) : sub))
  }
}

/** 按列名取值（宽松：忽略大小写） */
export function findRowValue(row: Record<string, unknown>, columnName: string): unknown {
  for (const [k, v] of Object.entries(row)) {
    if (k.toLowerCase() === columnName.toLowerCase()) return v
  }
  return undefined
}


/** 列是否为某字段的 EXPAND 展开列（issues/24：已消费，不重复平铺带出） */
function isExpandColumn(meta: TableMeta, column: string): boolean {
  for (const f of meta.fields) {
    for (const col of Object.values(f.expandFields ?? {})) {
      if (col.toLowerCase() === (column ?? '').toLowerCase()) return true
    }
  }
  return false
}

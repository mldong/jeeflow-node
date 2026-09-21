// 扩展仓储内存实现（v1.1.0，测试/演示用）

import {
  ProcessDesign, ProcessDesignHis, ProcessSurrogate,
  type ProcessInstance,
} from './model.js'
import type { ProcessExtRepository, QueryCondition } from './spi.js'
import { matchConditions } from './memory.js'

// ═══ 条件匹配基建（issues/05-5） ═══

const DESIGN_FIELDS: Record<string, string> = {
  't.id': 'id', 't.name': 'name', 't.display_name': 'displayName', 't.type': 'type',
  't.is_deployed': 'isDeployed', 't.remark': 'remark',
  't.create_time': 'createTime', 't.update_time': 'updateTime',
}

const SURROGATE_FIELDS: Record<string, string> = {
  't.id': 'id', 't.process_name': 'processName', 't.operator': 'operator',
  't.surrogate': 'surrogate', 't.enabled': 'enabled',
  't.start_time': 'startTime', 't.end_time': 'endTime',
  't.create_time': 'createTime', 't.update_time': 'updateTime',
}

function pickFields(row: any, map: Record<string, string>): Record<string, any> {
  const fields: Record<string, any> = {}
  for (const [col, key] of Object.entries(map)) {
    fields[col] = row[key]
  }
  return fields
}

// ── 委托查询判据基建（issues/116 判据 b/d，与 SQL 仓同口径）─────────────────

/** 时间归一为毫秒：Date/毫秒数/可解析字符串均可；空值或脏值 → null（该侧不限，对齐 SQL 侧 NULL） */
function surrogateTimeMs(v: any): number | null {
  if (v == null || v === '') return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime()
  if (typeof v === 'number') return Number.isNaN(v) ? null : v
  if (typeof v === 'string') {
    // 兼容 'yyyy-MM-dd HH:mm:ss'（Safari/Node 对空格分隔不统一，转 T 再解）
    const n = Date.parse(v.trim().replace(' ', 'T'))
    return Number.isNaN(n) ? null : n
  }
  return null
}

/** enabled 只认整数 1（'1' 视作 1，与 SQL 侧 INT 列同结论）；脏值（'abc'/true/0/2/空）一律不启用 */
function surrogateEnabled(v: any): boolean {
  if (typeof v === 'number') return v === 1
  if (typeof v === 'string') {
    const s = v.trim()
    return s !== '' && Number.isInteger(Number(s)) && Number(s) === 1
  }
  return false
}

/**
 * 判据 1.4：比较两条委托的主键大小（a 是否比 b 旧）。id 是雪花数字串（19 位，已超
 * Number 安全整数），纯数字串一律按 BigInt 比**数值**（与 SQL 侧 `ORDER BY id DESC` 同序），
 * 非数字 id 退化为字符串序。
 *
 * ⚠️ 不能拿 Map 的插入序当 id 序：saveSurrogate/updateSurrogate 都接受调用方显式 id，
 * 乱序写入（补录、导入、双仓对拍）时"取遍历到的末条"就会与 SQL 仓给出不同答案。
 * Go 内存仓原实现正是"map 随机序取到啥算啥"被抓出来重写的（issues/116 §5）。
 */
function surrogateIdLess(a: any, b: any): boolean {
  const sa = String(a ?? ''), sb = String(b ?? '')
  if (/^\d+$/.test(sa) && /^\d+$/.test(sb)) return BigInt(sa) < BigInt(sb)
  return sa < sb
}

export class MemoryExtRepository implements ProcessExtRepository {
  private designs = new Map<string, ProcessDesign>()
  private designHis = new Map<string, ProcessDesignHis[]>()
  private surrogates = new Map<string, ProcessSurrogate>()
  private seq = 1

  // ── 流程设计 ──

  async findDesignById(id: string) { return this.designs.get(id) ?? null }

  async saveDesign(d: ProcessDesign) {
    if (!d.id) d.id = String(this.seq++)
    const now = new Date()
    if (!d.createTime) d.createTime = now
    if (!d.updateTime) d.updateTime = now
    this.designs.set(d.id, { ...d })
  }

  async updateDesign(d: ProcessDesign) {
    d.updateTime = new Date()
    this.designs.set(d.id, { ...d })
  }

  async removeDesign(id: string) {
    this.designs.delete(id)
    this.designHis.delete(id)
  }

  async pageDesigns(_pageNum = 1, _pageSize = 10, _filters?: Record<string, any>, conditions?: QueryCondition[]): Promise<[ProcessDesign[], number]> {
    const rows = [...this.designs.values()].filter(d =>
      matchConditions(conditions, pickFields(d, DESIGN_FIELDS)))
    return [rows, rows.length]
  }

  // ── 设计历史 ──

  async saveDesignHis(his: ProcessDesignHis) {
    if (!his.id) his.id = String(this.seq++)
    if (!his.createTime) his.createTime = new Date()
    const list = this.designHis.get(his.processDesignId) ?? []
    list.unshift({ ...his })
    this.designHis.set(his.processDesignId, list)
  }

  async listDesignHis(designId: string) {
    return this.designHis.get(designId) ?? []
  }

  // ── 委托代理 ──

  async findSurrogateById(id: string) { return this.surrogates.get(id) ?? null }

  async saveSurrogate(s: ProcessSurrogate) {
    if (!s.id) s.id = String(this.seq++)
    const now = new Date()
    if (!s.createTime) s.createTime = now
    if (!s.updateTime) s.updateTime = now
    // 显式 enabled=0 是合法值（停用委托）；缺省由门面处理（对齐 Java/Go/Python，issues/82-7）
    this.surrogates.set(s.id, { ...s })
  }

  async updateSurrogate(s: ProcessSurrogate) {
    s.updateTime = new Date()
    this.surrogates.set(s.id, { ...s })
  }

  async removeSurrogate(id: string) {
    this.surrogates.delete(id)
  }

  async pageSurrogates(_pageNum = 1, _pageSize = 10, filters?: Record<string, any>, conditions?: QueryCondition[]): Promise<[ProcessSurrogate[], number]> {
    const rows = [...this.surrogates.values()].filter(s => {
      for (const [col, val] of Object.entries(filters ?? {})) {
        if (val == null || val === '') continue
        const k = col === 'process_name' ? 'processName' : col
        if (String((s as any)[k]) !== String(val)) return false
      }
      return matchConditions(conditions, pickFields(s, SURROGATE_FIELDS))
    })
    return [rows, rows.length]
  }

  /**
   * 生效委托查询（issues/116 判据 a~d，与 JdbcProcessExtRepository.getSurrogate 同口径，
   * 同一份数据两仓必须给出同一结论）：
   *  a. processName 先精确命中，未命中再兜底空 process_name（全流程委托）
   *  b. 时间窗 start_time <= at <= end_time，任一侧为空 = 该侧不限
   *  c. 自委托过滤：surrogate <> operator
   *  d. enabled 只认整数 1，脏值不当启用
   * 多条命中取**主键 id 最大**（判据 1.4，对齐 SQL 侧 `ORDER BY id DESC LIMIT 1`；
   * 显式比 id，不依赖 Map 插入序，见 surrogateIdLess）
   */
  async getSurrogate(operator: string, processName: string, at: Date = new Date()): Promise<ProcessSurrogate | null> {
    const name = processName ?? ''
    const now = surrogateTimeMs(at)
    let exact: ProcessSurrogate | null = null
    let global: ProcessSurrogate | null = null
    for (const s of this.surrogates.values()) {
      if (s.operator !== operator) continue
      if (s.surrogate === operator) continue          // c 自委托过滤
      if (!surrogateEnabled(s.enabled)) continue      // d enabled 只认 1
      if (now != null) {                              // b 时间窗（空 = 不限）
        const start = surrogateTimeMs(s.startTime)
        const end = surrogateTimeMs(s.endTime)
        if (start != null && start > now) continue
        if (end != null && end < now) continue
      }
      const bucket = (name && s.processName === name) ? 'exact' : (!s.processName ? 'global' : '')
      if (!bucket) continue                           // a 异流程名的行既非精确也非兜底
      const cur = bucket === 'exact' ? exact : global
      if (cur == null || surrogateIdLess(cur.id, s.id)) {
        if (bucket === 'exact') exact = s; else global = s
      }
    }
    const hit = exact ?? global                       // a 精确优先，其次全流程兜底
    return hit ? { ...hit } : null
  }
}

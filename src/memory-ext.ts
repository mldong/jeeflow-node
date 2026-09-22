// 扩展仓储内存实现（v1.1.0，测试/演示用）

import {
  ProcessDesign, ProcessDesignHis, ProcessSurrogate,
  type ProcessInstance,
} from './model.js'
import type { ProcessExtRepository, QueryCondition } from './spi.js'
import { matchConditions } from './memory.js'
import { surrogateIsEffective, surrogateTimeMs, newestOf } from './surrogate-rule.js'

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

// ── 委托查询判据基建：单一事实源在 ./surrogate-rule.ts（与 SQL 仓共用，issues/116/123）──

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
   * 生效委托查询（issues/116 判据 a~d + issues/123 的取行/裁决顺序，
   * 与 JdbcProcessExtRepository.getSurrogate 同口径，同一份数据两仓必须给出同一结论）：
   *  a. 作用域：先在该流程名作用域内取记录，该作用域**一条都没有**才兜底 process_name 空（全流程委托）；
   *     精确作用域里只要有记录就由它裁决，**不跨作用域回落**；
   *  b. 时间窗 start_time <= at <= end_time，任一侧为空 = 该侧不限；`at` 解析不出时刻则整段跳过窗比较
   *     （保留 `at: Date = new Date()` 显式传 null 的老语义）；
   *  c. 自委托过滤 surrogate <> operator；d. enabled 只认整数 1。
   *
   * ⚠️ 顺序是「**先**按主键 id 取最新一条 → **再**由四判据裁决这一条」（条款 1.4 + issues/123）：
   * 反过来（先滤生效、剩下的才取最新）等于"历史上留过一条窗内委托就永久生效"，
   * 用户随后新建的窗外/停用/脏值/自委托记录全都判不动它。最新一条不生效 ⇒ 返回 null，
   * **不回落**到更旧那条。id 显式按数值比（surrogateIdLess），不依赖 Map 插入序。
   */
  async getSurrogate(operator: string, processName: string, at: Date = new Date()): Promise<ProcessSurrogate | null> {
    const name = processName ?? ''
    const ms = surrogateTimeMs(at)
    let hit = this.newestSurrogateInScope(operator, name)
    if (surrogateIsEffective(hit, operator, ms) || !name) {
      return surrogateIsEffective(hit, operator, ms) && hit ? { ...hit } : null
    }
    // 精确作用域判否（含池空）⇒ 仍要看全流程作用域的最新一条（条款 1.4 后半句）
    hit = this.newestSurrogateInScope(operator, '')
    return surrogateIsEffective(hit, operator, ms) && hit ? { ...hit } : null
  }

  /** 该授权人在指定流程作用域内 id 最大（最新）的一条委托；processName 为 '' = 全流程委托作用域。
   *  **不带**任何生效判据过滤（裁决在 getSurrogate 里对这一条单独做）。 */
  private newestSurrogateInScope(operator: string, processName: string): ProcessSurrogate | null {
    const inScope = [...this.surrogates.values()].filter(s =>
      s.operator === operator && (processName === '' ? !s.processName : s.processName === processName))
    return newestOf(inScope)
  }
}

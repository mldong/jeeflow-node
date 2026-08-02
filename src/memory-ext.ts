// 扩展仓储内存实现（v1.1.0，测试/演示用）

import {
  ProcessDesign, ProcessDesignHis, ProcessSurrogate,
  type ProcessInstance,
} from './model.js'
import type { ProcessExtRepository } from './spi.js'

export class MemoryExtRepository implements ProcessExtRepository {
  private designs = new Map<number, ProcessDesign>()
  private designHis = new Map<number, ProcessDesignHis[]>()
  private surrogates = new Map<number, ProcessSurrogate>()
  private seq = 1

  // ── 流程设计 ──

  async findDesignById(id: number) { return this.designs.get(id) ?? null }

  async saveDesign(d: ProcessDesign) {
    if (!d.id) d.id = this.seq++
    const now = new Date()
    if (!d.createTime) d.createTime = now
    if (!d.updateTime) d.updateTime = now
    this.designs.set(d.id, { ...d })
  }

  async updateDesign(d: ProcessDesign) {
    d.updateTime = new Date()
    this.designs.set(d.id, { ...d })
  }

  async removeDesign(id: number) {
    this.designs.delete(id)
    this.designHis.delete(id)
  }

  async pageDesigns(_pageNum = 1, _pageSize = 10, _filters?: Record<string, any>): Promise<[ProcessDesign[], number]> {
    return [[...this.designs.values()], this.designs.size]
  }

  // ── 设计历史 ──

  async saveDesignHis(his: ProcessDesignHis) {
    if (!his.id) his.id = this.seq++
    if (!his.createTime) his.createTime = new Date()
    const list = this.designHis.get(his.processDesignId) ?? []
    list.unshift({ ...his })
    this.designHis.set(his.processDesignId, list)
  }

  async listDesignHis(designId: number) {
    return this.designHis.get(designId) ?? []
  }

  // ── 委托代理 ──

  async findSurrogateById(id: number) { return this.surrogates.get(id) ?? null }

  async saveSurrogate(s: ProcessSurrogate) {
    if (!s.id) s.id = this.seq++
    const now = new Date()
    if (!s.createTime) s.createTime = now
    if (!s.updateTime) s.updateTime = now
    if (!s.enabled) s.enabled = 1
    this.surrogates.set(s.id, { ...s })
  }

  async updateSurrogate(s: ProcessSurrogate) {
    s.updateTime = new Date()
    this.surrogates.set(s.id, { ...s })
  }

  async removeSurrogate(id: number) {
    this.surrogates.delete(id)
  }

  async pageSurrogates(_pageNum = 1, _pageSize = 10, _filters?: Record<string, any>): Promise<[ProcessSurrogate[], number]> {
    return [[...this.surrogates.values()], this.surrogates.size]
  }

  async getSurrogate(operator: string, processName: string, at: Date = new Date()): Promise<ProcessSurrogate | null> {
    let fallback: ProcessSurrogate | null = null
    for (const s of this.surrogates.values()) {
      if (s.operator !== operator || s.enabled !== 1) continue
      if (s.startTime && s.startTime > at) continue
      if (s.endTime && s.endTime < at) continue
      if (s.processName === processName && processName) return { ...s }
      if ((!s.processName || s.processName === processName) && !fallback) fallback = s
    }
    return fallback ? { ...fallback } : null
  }
}

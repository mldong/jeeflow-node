import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SqliteDynamicTableWriter } from '../src/persist.js'
import {
  JsonMetaProvider, MetaTableReader, MetaTableWriter, JdbcTableReader,
  StorageType, type TableMeta, type FieldMeta, type IDynamicMetaProvider,
} from '../src/meta.js'

describe('persist 元数据驱动读写（issues/23）', () => {

  it('① JSON 配置加载：storageType 名称/数字双解析 + columnName 缺省转下划线', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meta-'))
    writeFileSync(join(dir, 'biz_leave.json'), JSON.stringify({
      tableName: 'biz_leave', primaryKey: 'id',
      fields: [
        { name: 'companyName', columnName: 'company_name', storageType: 'NORMAL' },
        { name: 'address', storageType: 2, expandFields: { province: 'province', city: 'city' } },
        { name: 'extra', storageType: 'JSON' },
        { name: 'items', storageType: 5, targetTable: 'biz_leave_item', foreignKey: 'leave_id' },
      ],
    }))
    const p = new JsonMetaProvider(dir)
    const meta = p.loadTableMeta('biz_leave')!
    assert.equal(meta.fields[0].storageType, StorageType.Normal)
    assert.equal(meta.fields[1].storageType, StorageType.Expand)
    assert.equal(meta.fields[3].storageType, StorageType.One2Many)
    assert.equal(meta.fields[3].targetTable, 'biz_leave_item')
    assert.equal(p.loadTableMeta('no_such'), null)
  })

  it('② 全链路：NORMAL/JSON/EXPAND + ONE2ONE/ONE2MANY 子表写入与回显组装', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE biz_leave (id INTEGER PRIMARY KEY AUTOINCREMENT, company_name TEXT, amount REAL,
        extra TEXT, province TEXT, city TEXT, detail_addr TEXT, process_instance_id INTEGER)`)
    db.exec(`CREATE TABLE biz_leave_address (id INTEGER PRIMARY KEY AUTOINCREMENT, leave_id INTEGER,
        province TEXT, city TEXT, detail_addr TEXT)`)
    db.exec(`CREATE TABLE biz_leave_item (id INTEGER PRIMARY KEY AUTOINCREMENT, leave_id INTEGER,
        name TEXT, qty INTEGER)`)

    const provider: IDynamicMetaProvider = {
      loadTableMeta(tableName) {
        const maps: Record<string, TableMeta> = {
          biz_leave: {
            tableName: 'biz_leave', primaryKey: 'id',
            fields: [
              { name: 'companyName' },
              { name: 'amount' },
              { name: 'extra', storageType: StorageType.Json },
              { name: 'address', storageType: StorageType.Expand, expandFields: { province: 'province', city: 'city', detail: 'detail_addr' } },
              { name: 'addressRel', storageType: StorageType.One2One, targetTable: 'biz_leave_address', foreignKey: 'leave_id' },
              { name: 'items', storageType: StorageType.One2Many, targetTable: 'biz_leave_item', foreignKey: 'leave_id' },
            ],
          },
          biz_leave_address: { tableName: 'biz_leave_address', fields: [{ name: 'province' }, { name: 'city' }, { name: 'detail', columnName: 'detail_addr' }] },
          biz_leave_item: { tableName: 'biz_leave_item', fields: [{ name: 'name' }, { name: 'qty' }] },
        }
        return maps[tableName] ?? null
      },
    }
    const base = new SqliteDynamicTableWriter(db)
    const writer = new MetaTableWriter(base, provider)
    const reader = new MetaTableReader(new JdbcTableReader(db), provider)

    writer.insert('biz_leave', {
      companyName: '复杂公司', amount: 800,
      extra: { tag: 'vip', level: 3 },
      address: { province: '广东省', city: '深圳市', detail: '科技园路1号' },
      addressRel: { province: '广东省', city: '广州市', detail: '天河区' },
      items: [{ name: '电脑', qty: 2 }, { name: '键盘', qty: 3 }],
      process_instance_id: 888,
    })

    // 落库断言
    const row = db.prepare('SELECT province, city FROM biz_leave').get() as any
    assert.equal(row.province, '广东省')
    assert.equal(row.city, '深圳市')
    const itemCount = (db.prepare('SELECT COUNT(1) AS c FROM biz_leave_item').get() as any).c
    assert.equal(itemCount, 2)

    // 回显组装
    const result = reader.readByProcessInstance('biz_leave', 888)!
    assert.equal(result.companyName, '复杂公司')
    assert.deepEqual(result.extra, { tag: 'vip', level: 3 })
    assert.equal((result.address as any).city, '深圳市')
    assert.equal((result.addressRel as any).city, '广州市')
    assert.equal((result.items as any[]).length, 2)
    assert.equal((result.items as any[])[0].name, '电脑')
    assert.equal(result.process_instance_id, 888)
    db.close()
  })

  it('③ 无元数据回落：委托基础 writer + 原始行回显', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE biz_leave (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, process_instance_id INTEGER)')
    const provider: IDynamicMetaProvider = { loadTableMeta() { return null } }
    const base = new SqliteDynamicTableWriter(db)
    const writer = new MetaTableWriter(base, provider)
    const reader = new MetaTableReader(new JdbcTableReader(db), provider)
    writer.insert('biz_leave', { title: '回落', process_instance_id: 1 })
    const result = reader.readByProcessInstance('biz_leave', 1)!
    assert.equal(result.title, '回落')
    db.close()
  })
})

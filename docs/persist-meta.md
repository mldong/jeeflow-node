# 元数据驱动入库（persist-meta）

> issues/23 · 1.7.0 起随主包提供（src/meta.ts）

**字段元数据（storageType）驱动的动态写入/读取**——复杂表单（对象/JSON/子表）落库与
流程回显成为通用能力。规范见文档站《10 · 元数据驱动的动态写入/读取》；本页是 Node.js 语言视角。

## 元数据 JSON（persist-meta/biz_leave.json）

```json
{
  "tableName": "biz_leave",
  "primaryKey": "id",
  "fields": [
    { "name": "companyName", "columnName": "company_name" },
    { "name": "address", "storageType": "EXPAND",
      "expandFields": { "province": "province", "city": "city", "detail": "detail_addr" } },
    { "name": "extra", "storageType": "JSON" },
    { "name": "items", "storageType": "ONE2MANY",
      "targetTable": "biz_leave_item", "foreignKey": "leave_id" }
  ]
}
```

storageType 支持名称（"EXPAND"）或数字（2，mldong dev_schema_field 1-5 语义）。

## 装配（写侧 + 读侧）

```ts
import { MetaTableWriter, MetaTableReader, JdbcTableReader, JsonMetaProvider } from '@mldong/jeeflow'

const provider = new JsonMetaProvider('persist-meta') // 文件系统目录
const writer = new MetaTableWriter(new SqliteDynamicTableWriter(db), provider)
const reader = new MetaTableReader(new JdbcTableReader(db), provider)
```

无元数据的表自动回落 1.6.x 行为（零破坏）；`IDynamicMetaProvider` 也可自行实现。

## 回显

```ts
const form = reader.readByProcessInstance('biz_leave', processInstanceId)
// form.address = { province, city, detail }   EXPAND 反展开
// form.extra   = { tag, level }               JSON 反序列化
// form.items   = [{ name, qty }, ...]         ONE2MANY 子表组装
```

边界（不做）：通用分页/条件/权限/排序。

## 测试

```bash
node --import tsx --test __tests__/meta.test.ts   # 3 用例（全量 56 passed）
```

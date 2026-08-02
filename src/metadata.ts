// 引擎元数据能力（v1.4.0，issues/04）——内置状态枚举字典
//
// key 对齐 boot3 字典（wf_process_define_state 等），value/label 与 Java enums 完全一致，
// 杜绝集成方重复定义导致的值漂移。

/** 单个字典项 */
export interface DictItem {
  value: string
  label: string
}

// 内置字典表（值顺序与 Java enums 声明顺序一致）
const DICTS: Record<string, DictItem[]> = {
  wf_process_define_state: [
    { value: '0', label: '禁用' }, { value: '1', label: '启用' },
  ],
  wf_process_instance_state: [
    { value: '10', label: '进行中' }, { value: '20', label: '已完成' }, { value: '30', label: '已撤回' },
    { value: '40', label: '强行终止' }, { value: '45', label: '已拒绝' }, { value: '50', label: '挂起' },
    { value: '99', label: '已废弃' },
  ],
  wf_process_submit_type: [
    { value: '0', label: '发起申请' }, { value: '1', label: '同意申请' }, { value: '2', label: '拒绝申请' },
    { value: '3', label: '退回上一步' }, { value: '4', label: '跳转' }, { value: '5', label: '重新提交' },
    { value: '6', label: '退回发起人' }, { value: '20', label: '拒绝申请' },
  ],
  wf_process_task_state: [
    { value: '10', label: '进行中' }, { value: '20', label: '已完成' }, { value: '30', label: '已撤回' },
    { value: '40', label: '强行终止' }, { value: '50', label: '挂起' }, { value: '99', label: '已废弃' },
  ],
  wf_process_task_type: [
    { value: '0', label: '主办' }, { value: '1', label: '协办' }, { value: '2', label: '记录' },
  ],
  wf_process_task_perform_type: [
    { value: '0', label: '普通参与' }, { value: '1', label: '会签参与' },
  ],
  wf_countersign_type: [
    { value: '0', label: '并行会签' }, { value: '1', label: '串行会签' },
  ],
}

/** 内置枚举字典 key 清单（对齐 boot3 字典 key，存量前端零改动） */
export function enumDictKeys(): string[] {
  return Object.keys(DICTS)
}

/** 按 key 取字典（[{value, label}]），未知 key 返回空列表 */
export function enumDict(key: string): DictItem[] {
  return [...(DICTS[key] ?? [])]
}

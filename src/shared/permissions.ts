export const permissionLabels = {
    "workspace.read": "查看草稿与正式设计",
    "workspace.write": "编辑自己的草稿",
    "design.publish": "发布至团队正式设计",
    "design.sync": "确认已同步至实现",
    "inspiration.read": "查看共享灵感池",
    "inspiration.write": "编辑共享灵感池",
    "schedule.read": "查看任务排期",
    "schedule.update": "更新自己负责的任务",
    "schedule.manage": "管理任务与排期"
};
export const capabilities = Object.keys(permissionLabels);
export const permissionDependencies: Record<string, string[]> = {
    "workspace.write": ["workspace.read"],
    "design.publish": ["workspace.read", "workspace.write"],
    "design.sync": ["workspace.read"],
    "inspiration.write": ["inspiration.read"],
    "schedule.update": ["schedule.read"],
    "schedule.manage": ["schedule.read", "schedule.update"]
};

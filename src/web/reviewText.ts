import { t } from './i18n';
import { propertyLabels } from '../shared/review';
const types: Record<string,string> = { object:'页面 / 记录', collection:'结构化集合', view:'集合视图', folder:'文件夹', text:'文本', number:'数值', boolean:'是 / 否', date:'日期', select:'单选', multi:'多选', reference:'引用', table:'表格', list:'列表', cards:'卡片' };
const operators: Record<string,string> = { contains:'包含', equals:'等于', startsWith:'开头为', empty:'为空', notEmpty:'不为空', gt:'大于', gte:'大于等于', lt:'小于', lte:'小于等于', between:'介于', in:'属于', today:'今天', last7days:'最近七天' };
const values = (value: unknown): string => value == null ? t("（空）") : typeof value === 'boolean' ? value ? t("是") : t("否") : typeof value === 'string' || typeof value === 'number' ? String(value) : Array.isArray(value) ? value.map(values).join('、') : Object.entries(value as Record<string,unknown>).map(([key, entry]) => key + '：' + values(entry)).join('；');
export function reviewText(value: unknown, property: string): string {
    if (value == null) return t("（空）");
    if (property === '对象' && typeof value === 'object' && !Array.isArray(value)) {
        const entity = value as Record<string,any>;
        return Object.entries(entity).filter(([key]) => key !== 'id').map(([key, entry]) => {
            if (key === 'body') return t("正文：\n") + String(entry || t("（空）"));
            if (key === 'fields' && entity.kind === 'object') return t("字段值：") + values(entry);
            return t(propertyLabels[key] || key) + '：' + reviewText(entry, key);
        }).join('\n');
    }
    if ((property === 'kind' || property === 'layout') && typeof value === 'string') return t(types[value] || value);
    if (property === 'fields' && Array.isArray(value)) return value.map(field => field.label + '（' + t(types[field.type] || field.type) + '，' + (field.required ? t("必填") : t("选填")) + '）' + (field.options?.length ? '：' + field.options.join('、') : '')).join('\n') || t("无字段");
    if (property === 'filters' && Array.isArray(value)) return value.map(filter => filter.key + ' ' + t(operators[filter.operator] || filter.operator) + (filter.value === undefined ? '' : ' ' + values(filter.value))).join('\n') || t("不筛选");
    if (property === 'filterLogic') return value === 'and' ? t("同时满足所有条件") : values(value);
    if (property === 'sort' && typeof value === 'object') { const sort = value as any; return sort.key + ' · ' + (sort.descending ? t("降序") : t("升序")); }
    if (property === 'pagination' && typeof value === 'object') { const size = (value as any).pageSize; return size ? t("每页 ") + size + t(" 条") : t("显示全部"); }
    return values(value);
}

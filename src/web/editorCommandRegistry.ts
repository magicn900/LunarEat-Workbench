export const editorCommands = [
    { id: 'link', title: '插入链接', words: 'link 链接', group: '插入' },
    { id: 'view', title: '嵌入集合视图', words: 'view table 视图 表格 集合', group: '插入' },
    { id: 'doc', title: '嵌入文档', words: 'embed document 文档 页面', group: '插入' },
    { id: 'paragraph', title: '正文', words: 'text paragraph 正文', group: '格式' },
    { id: 'heading1', title: '一级标题', words: 'h1 heading 标题', group: '格式' },
    { id: 'heading2', title: '二级标题', words: 'h2 heading 标题', group: '格式' },
    { id: 'heading3', title: '三级标题', words: 'h3 heading 标题', group: '格式' },
    { id: 'bullet_list', title: '无序列表', words: 'bullet list 无序列表', group: '格式' },
    { id: 'ordered_list', title: '有序列表', words: 'number list 有序列表', group: '格式' },
    { id: 'blockquote', title: '引用', words: 'quote 引用', group: '格式' },
    { id: 'code_block', title: '代码块', words: 'code 代码块', group: '格式' },
    { id: 'hr', title: '分隔线', words: 'divider horizontal 分隔线', group: '格式' }
] as const;


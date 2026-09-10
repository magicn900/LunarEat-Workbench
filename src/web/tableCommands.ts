import { Fragment } from '@milkdown/prose/model';
import { TextSelection, type Command, type EditorState } from '@milkdown/prose/state';
import { addColumnAfter, addColumnBefore, deleteColumn, deleteRow, deleteTable, goToNextCell, moveTableColumn, moveTableRow, selectedRect, isInTable } from '@milkdown/prose/tables';

export function tableContext(state: EditorState) {
    if (!isInTable(state)) return null;
    const rect = selectedRect(state);
    return { ...rect, row: rect.top, column: rect.left, rows: rect.map.height, columns: rect.map.width };
}

export const insertMarkdownTable: Command = (state, dispatch) => {
    const { schema } = state;
    const cells = (header: boolean) => Array.from({ length: 3 }, () => schema.nodes[header ? 'table_header' : 'table_cell'].create(null, schema.nodes.paragraph.create()));
    const table = schema.nodes.table.create(null, [schema.nodes.table_header_row.create(null, cells(true)), schema.nodes.table_row.create(null, cells(false)), schema.nodes.table_row.create(null, cells(false))]);
    const transaction = state.tr.replaceSelectionWith(table);
    let position = -1;
    transaction.doc.descendants((node, offset) => { if (node === table) position = offset; });
    if (position >= 0) transaction.setSelection(TextSelection.near(transaction.doc.resolve(position + 4)));
    dispatch?.(transaction);
    return true;
};

export function tableCommand(id: string): Command {
    return (state, dispatch, view) => {
        const context = tableContext(state);
        if (!context) return false;
        const { table, tableStart, row, column, rows, columns } = context;
        if (id === 'table-delete') return deleteTable(state, dispatch);
        if (id === 'column-before') return addColumnBefore(state, dispatch);
        if (id === 'column-after') return addColumnAfter(state, dispatch);
        if (id === 'column-delete') return columns - (context.right - column) > 0 && deleteColumn(state, dispatch);
        if (id === 'row-delete') return row > 0 && rows - (context.bottom - row) >= 2 && deleteRow(state, dispatch);
        if (id === 'row-up' || id === 'row-down') {
            const target = row + (id === 'row-up' ? -1 : 1);
            return row > 0 && target > 0 && target < rows && moveTableRow({ from: row, to: target })(state, dispatch, view);
        }
        if (id === 'column-left' || id === 'column-right') {
            const target = column + (id === 'column-left' ? -1 : 1);
            return target >= 0 && target < columns && moveTableColumn({ from: column, to: target })(state, dispatch, view);
        }
        if (id.startsWith('align-')) {
            const alignment = id.slice(6);
            if (!['left', 'center', 'right'].includes(alignment)) return false;
            const transaction = state.tr;
            for (let selectedColumn = context.left; selectedColumn < context.right; selectedColumn++) {
                for (let selectedRow = 0; selectedRow < rows; selectedRow++) {
                    const position = tableStart + context.map.positionAt(selectedRow, selectedColumn, table);
                    const cell = state.doc.nodeAt(position)!;
                    transaction.setNodeMarkup(position, undefined, { ...cell.attrs, alignment });
                }
            }
            dispatch?.(transaction);
            return true;
        }
        if (id === 'row-before' || id === 'row-after' || id === 'row-append') {
            const index = id === 'row-append' ? rows : id === 'row-before' ? row : context.bottom;
            if (index === 0) return false;
            let position = tableStart;
            for (let cursor = 0; cursor < index; cursor++) position += table.child(cursor).nodeSize;
            const cells = Array.from({ length: columns }, (_, cursor) => state.schema.nodes.table_cell.create({ alignment: table.firstChild!.child(cursor).attrs.alignment }, state.schema.nodes.paragraph.create()));
            const transaction = state.tr.insert(position, state.schema.nodes.table_row.create(null, Fragment.from(cells)));
            transaction.setSelection(TextSelection.near(transaction.doc.resolve(position + 2)));
            dispatch?.(transaction);
            return true;
        }
        if (id === 'column-append') {
            const position = tableStart + context.map.positionAt(row, columns - 1, table);
            const selected = state.apply(state.tr.setSelection(TextSelection.near(state.doc.resolve(position + 1))));
            return addColumnAfter(selected, dispatch);
        }
        if (id === 'cell-next' || id === 'cell-previous') {
            const direction = id === 'cell-next' ? 1 : -1;
            if (direction === 1 && row === rows - 1 && column === columns - 1) return tableCommand('row-append')(state, dispatch, view);
            return goToNextCell(direction)(state, dispatch);
        }
        return false;
    };
}

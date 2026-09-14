import { expect, it } from 'vitest';
import { emptyTask, type ScheduledTask } from '../src/shared/schedule';
import { scheduleRows, rescheduledDates } from '../src/web/scheduleLayout';
const task = (id: string, parentId: string | null = null): ScheduledTask => ({ ...emptyTask, id, title: id, parentId, version: 1, created: '', updated: '', startDate: '2026-09-14', endDate: '2026-09-18' });
it('includes cross-owner ancestor context without counting it as assigned work', () => {
    const tasks = [task('parent'), task('child', 'parent'), task('leaf', 'child'), task('other')];
    expect(scheduleRows(tasks, new Set(['leaf']), new Set()).map(row => [row.task.id, row.depth, row.context, row.parentRowId])).toEqual([
        ['parent', 0, true, null], ['child', 1, true, 'parent'], ['leaf', 2, false, 'child']
    ]);
});
it('collapses a whole subtree and respects the selected scope', () => {
    const tasks = [task('parent'), task('child', 'parent'), task('leaf', 'child')];
    expect(scheduleRows(tasks, new Set(['leaf']), new Set(['child'])).map(row => row.task.id)).toEqual(['parent', 'child']);
    expect(scheduleRows(tasks, new Set(['leaf']), new Set(), 'child').map(row => [row.task.id, row.depth])).toEqual([['child', 0], ['leaf', 1]]);
});
it('orders descendants beneath parents even when children were created first', () => {
    expect(scheduleRows([task('child', 'parent'), task('parent')], new Set(['parent', 'child']), new Set()).map(row => row.task.id)).toEqual(['parent', 'child']);
});
it('moves full date intervals and resizes either edge on a one-day grid', () => {
    expect(rescheduledDates(task('move'), 'move', 2)).toEqual({ startDate: '2026-09-16', endDate: '2026-09-20' });
    expect(rescheduledDates(task('start'), 'start', -2)).toEqual({ startDate: '2026-09-12', endDate: '2026-09-18' });
    expect(rescheduledDates(task('end'), 'end', 2)).toEqual({ startDate: '2026-09-14', endDate: '2026-09-20' });
});
it('prevents reversed ranges and clamps dates to schema bounds', () => {
    expect(rescheduledDates(task('start'), 'start', 99)).toEqual({ startDate: '2026-09-18', endDate: '2026-09-18' });
    expect(rescheduledDates(task('end'), 'end', -99)).toEqual({ startDate: '2026-09-14', endDate: '2026-09-14' });
    expect(rescheduledDates({ ...task('min'), startDate: '1900-01-01', endDate: '1900-01-03' }, 'move', -10)).toEqual({ startDate: '1900-01-01', endDate: '1900-01-03' });
    expect(rescheduledDates({ ...task('max'), startDate: '9998-12-29', endDate: '9998-12-31' }, 'move', 10)).toEqual({ startDate: '9998-12-29', endDate: '9998-12-31' });
    expect(() => rescheduledDates({ ...task('none'), startDate: null, endDate: null }, 'move', 1)).toThrow();
});
it('date arithmetic is independent of daylight saving changes', () => {
    expect(rescheduledDates({ ...task('dst'), startDate: '2026-03-07', endDate: '2026-03-09' }, 'move', 1)).toEqual({ startDate: '2026-03-08', endDate: '2026-03-10' });
});

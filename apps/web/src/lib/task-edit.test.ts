import { describe, expect, it } from 'vitest';
import { taskEditPatch } from './task-edit';

const NY = 'America/New_York';
// Stored with seconds, so re-encoding the form's minute value would move it.
const task = {
  title: 'Call the bank',
  dueAt: '2026-11-13T15:00:42.123Z',
  remindAt: '2026-11-13T14:30:07.000Z',
};
const untouched = { title: 'Call the bank', due: '2026-11-13T10:00', remind: '2026-11-13T09:30' };

describe('taskEditPatch', () => {
  it('sends nothing when nothing changed, ignoring whitespace around the title', () => {
    expect(taskEditPatch(task, untouched, NY)).toEqual({});
    expect(taskEditPatch(task, { ...untouched, title: '  Call the bank ' }, NY)).toEqual({});
  });

  it('sends only the title when only the title changed', () => {
    expect(taskEditPatch(task, { ...untouched, title: ' Call the bank today ' }, NY)).toEqual({
      title: 'Call the bank today',
    });
  });

  it('sends only the time that moved, as an instant in the zone', () => {
    expect(taskEditPatch(task, { ...untouched, due: '2026-11-14T11:15' }, NY)).toEqual({
      dueAt: '2026-11-14T16:15:00.000Z',
    });
    expect(taskEditPatch(task, { ...untouched, remind: '2026-11-13T08:00' }, NY)).toEqual({
      remindAt: '2026-11-13T13:00:00.000Z',
    });
  });

  it('sends null when a time is cleared, and nothing for an absent time left empty', () => {
    expect(taskEditPatch(task, { ...untouched, due: '' }, NY)).toEqual({ dueAt: null });
    const undated = { title: 'x', dueAt: null, remindAt: null };
    expect(taskEditPatch(undated, { title: 'x', due: '', remind: '' }, NY)).toEqual({});
    expect(taskEditPatch(undated, { title: 'x', due: '2026-11-13T10:00', remind: '' }, NY)).toEqual(
      { dueAt: '2026-11-13T15:00:00.000Z' },
    );
  });
});

import assert = require('node:assert/strict');

import {
  filterPaletteEntries,
  nextPaletteIndex,
  type PaletteCommandEntry,
} from '../renderer/command-palette';

const entries: PaletteCommandEntry[] = [
  {
    invocation: { id: 'workspace.open', args: { workspaceId: 'review' } },
    title: 'Open Workspace: Review',
    category: 'Workspace',
    searchTerms: ['switch', 'project', 'code review'],
    shortcut: 'Alt+2',
  },
  {
    invocation: { id: 'pane.focus', args: { paneId: 'tasks' } },
    title: 'Focus Pane: Configured Tasks',
    category: 'Pane',
    searchTerms: ['terminal', 'tasks'],
    shortcut: null,
  },
  {
    invocation: { id: 'workspace.dismissAttention', args: { workspaceId: 'review' } },
    title: 'Dismiss Attention: Review',
    category: 'Workspace',
    searchTerms: ['notification', 'exit'],
    shortcut: null,
  },
];

assert.deepEqual(filterPaletteEntries(entries, ''), entries);
assert.deepEqual(filterPaletteEntries(entries, 'REVIEW').map((entry) => entry.title), [
  'Open Workspace: Review',
  'Dismiss Attention: Review',
]);
assert.deepEqual(filterPaletteEntries(entries, 'pane tasks').map((entry) => entry.title), [
  'Focus Pane: Configured Tasks',
]);
assert.deepEqual(filterPaletteEntries(entries, 'workspace exit').map((entry) => entry.title), [
  'Dismiss Attention: Review',
]);
assert.deepEqual(filterPaletteEntries(entries, 'missing'), []);

assert.equal(nextPaletteIndex(-1, 3, 1), 0);
assert.equal(nextPaletteIndex(-1, 3, -1), 2);
assert.equal(nextPaletteIndex(0, 3, -1), 2);
assert.equal(nextPaletteIndex(2, 3, 1), 0);
assert.equal(nextPaletteIndex(0, 0, 1), -1);

console.log('command-palette tests passed');

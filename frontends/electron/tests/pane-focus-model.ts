import assert = require('node:assert/strict');

import { PaneFocusModel } from '../renderer/pane-focus-model';

const focus = new PaneFocusModel([
  { workspaceId: 'development', paneIds: ['shell', 'tasks', 'agent'] },
  { workspaceId: 'review', paneIds: ['review-shell', 'review-tasks'] },
]);

assert.equal(focus.activateWorkspace('development'), 'shell');
assert.equal(focus.activePaneId, 'shell');
assert.equal(focus.nextPane(), 'tasks');
assert.equal(focus.nextPane(), 'agent');
assert.equal(focus.nextPane(), 'shell', 'next pane did not wrap');
assert.equal(focus.previousPane(), 'agent', 'previous pane did not wrap');

assert.equal(focus.focusPane('tasks'), 'tasks');
assert.equal(focus.activateWorkspace('review'), 'review-shell');
assert.equal(focus.focusPane('review-tasks'), 'review-tasks');
assert.equal(focus.activateWorkspace('development'), 'tasks', 'workspace did not restore its remembered pane');
assert.equal(focus.activateWorkspace('review'), 'review-tasks', 'second workspace did not restore its remembered pane');

focus.setPaneOrder('review', ['review-shell', 'review-agent']);
assert.equal(focus.activePaneId, 'review-shell', 'removed active pane did not fall back to the first ordered pane');
assert.equal(focus.activateWorkspace('development'), 'tasks');
focus.setPaneOrder('development', ['shell', 'agent']);
assert.equal(
  focus.activateWorkspace('development'),
  'shell',
  'removed remembered pane did not fall back to the first ordered pane',
);

focus.setPaneOrder('development', []);
assert.equal(focus.activePaneId, null);
assert.equal(focus.nextPane(), null);
assert.throws(() => focus.focusPane('missing'), /unknown pane/);
assert.throws(() => focus.activateWorkspace('missing'), /unknown workspace/);
assert.throws(
  () => focus.setPaneOrder('review', ['duplicate', 'duplicate']),
  /duplicate pane id/,
);

console.log('pane-focus-model tests passed');

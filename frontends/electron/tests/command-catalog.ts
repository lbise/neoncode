import assert = require('node:assert/strict');

import {
  COMMAND_IDS,
  getCommandMetadata,
  listCommandMetadata,
  validateCommandInvocation,
  type CommandInvocation,
} from '../shared/command-catalog';

const validInvocations: CommandInvocation[] = [
  { id: 'palette.open' },
  { id: 'palette.close' },
  { id: 'settings.open' },
  { id: 'settings.close' },
  {
    id: 'workspace.create',
    args: {
      workspaceId: 'created', name: 'Created', path: '/tmp/created',
      defaultLaunchProfile: 'default-shell', sessionId: 'created-shell', title: 'Shell',
    },
  },
  { id: 'workspace.rename', args: { workspaceId: 'review', name: 'Code Review' } },
  { id: 'workspace.delete', args: { workspaceId: 'review', disposition: 'detach' } },
  { id: 'workspace.createDialog' },
  { id: 'workspace.renameDialog' },
  { id: 'workspace.deleteDialog' },
  { id: 'workspace.open', args: { workspaceId: 'review' } },
  { id: 'workspace.next' },
  { id: 'workspace.previous' },
  { id: 'workspace.dismissAttention', args: { workspaceId: 'review' } },
  {
    id: 'tab.create',
    args: {
      workspaceId: 'review', tabId: 'tab-review', title: 'Review',
      sessionId: 'review-shell', launchProfile: 'default-shell',
    },
  },
  { id: 'tab.open', args: { workspaceId: 'review', tabId: 'tab-review' } },
  { id: 'tab.rename', args: { workspaceId: 'review', tabId: 'tab-review', title: 'Renamed' } },
  { id: 'tab.move', args: { workspaceId: 'review', tabId: 'tab-review', toIndex: 0 } },
  { id: 'tab.close', args: { workspaceId: 'review', tabId: 'tab-review' } },
  { id: 'tab.createDefault' },
  { id: 'tab.next' },
  { id: 'tab.previous' },
  { id: 'tab.renameDialog' },
  { id: 'tab.closeDialog' },
  { id: 'pane.focus', args: { paneId: 'tasks' } },
  { id: 'pane.split', args: {
    workspaceId: 'review', paneId: 'tasks', sessionId: 'review-agent', splitId: 'split-agent',
    title: 'Agent', launchProfile: 'default-shell', direction: 'horizontal', position: 'after',
  } },
  { id: 'split.resize', args: { workspaceId: 'review', splitId: 'split-agent', delta: -0.05 } },
  { id: 'pane.close', args: { workspaceId: 'review', paneId: 'tasks' } },
  { id: 'pane.kill', args: { workspaceId: 'review', paneId: 'tasks' } },
  { id: 'pane.restart', args: { workspaceId: 'review', paneId: 'tasks' } },
  { id: 'pane.splitHorizontal' },
  { id: 'pane.splitVertical' },
  { id: 'pane.resizeLeft' },
  { id: 'pane.resizeRight' },
  { id: 'pane.resizeUp' },
  { id: 'pane.resizeDown' },
  { id: 'pane.closeDialog' },
  { id: 'pane.next' },
  { id: 'pane.previous' },
];

assert.deepEqual(validInvocations.map(validateCommandInvocation), validInvocations);
assert.deepEqual(listCommandMetadata().map((metadata) => metadata.id), [...COMMAND_IDS]);
for (const metadata of listCommandMetadata()) {
  assert(metadata.title.length > 0, `${metadata.id} omitted a title`);
  assert(metadata.searchTerms.length > 0, `${metadata.id} omitted search terms`);
  assert.equal(metadata.owningLayer, 'renderer');
  assert.equal(typeof metadata.externalInvocation, 'boolean');
}
const internalCommands = new Set([
  'palette.open', 'palette.close', 'settings.open', 'settings.close',
  'workspace.createDialog', 'workspace.renameDialog', 'workspace.deleteDialog',
  'tab.createDefault', 'tab.next', 'tab.previous', 'tab.renameDialog', 'tab.closeDialog',
  'pane.splitHorizontal', 'pane.splitVertical',
  'pane.resizeLeft', 'pane.resizeRight', 'pane.resizeUp', 'pane.resizeDown', 'pane.closeDialog',
]);
for (const metadata of listCommandMetadata()) {
  assert.equal(
    metadata.externalInvocation,
    !internalCommands.has(metadata.id),
    `${metadata.id} has incorrect future CLI eligibility`,
  );
}

const metadataCopy = getCommandMetadata('workspace.open');
metadataCopy.title = 'Mutated';
metadataCopy.searchTerms.push('mutated');
assert.equal(getCommandMetadata('workspace.open').title, 'Open Workspace');
assert(!getCommandMetadata('workspace.open').searchTerms.includes('mutated'));

for (const invalid of [
  null,
  {},
  { id: 'unknown' },
  { id: 'palette.open', args: {} },
  { id: 'workspace.next', extra: true },
  { id: 'workspace.open' },
  { id: 'workspace.create' },
  { id: 'workspace.create', args: {
    workspaceId: 'new', name: 'New', path: 'bad\npath', defaultLaunchProfile: 'default-shell',
    sessionId: 'new-shell', title: 'Shell',
  } },
  { id: 'workspace.rename', args: { workspaceId: 'review', name: '' } },
  { id: 'workspace.delete', args: { workspaceId: 'review', disposition: 'later' } },
  { id: 'workspace.createDialog', args: {} },
  { id: 'workspace.open', args: {} },
  { id: 'workspace.open', args: { workspaceId: '' } },
  { id: 'workspace.open', args: { workspaceId: 'not valid' } },
  { id: 'workspace.open', args: { workspaceId: 'review', extra: true } },
  { id: 'workspace.dismissAttention', args: { workspaceId: 7 } },
  { id: 'tab.createDefault', args: {} },
  { id: 'tab.create', args: {
    workspaceId: 'review', tabId: 'tab', title: '', sessionId: 'session', launchProfile: 'shell',
  } },
  { id: 'tab.open', args: { workspaceId: 'review' } },
  { id: 'tab.rename', args: { workspaceId: 'review', tabId: 'tab', title: 'bad\ntitle' } },
  { id: 'tab.move', args: { workspaceId: 'review', tabId: 'tab', toIndex: 8 } },
  { id: 'tab.close', args: { workspaceId: 'review', tabId: 'tab', disposition: 'later' } },
  { id: 'pane.focus', args: { paneId: 'bad\nvalue' } },
  { id: 'pane.focus', args: { paneId: 'x'.repeat(129) } },
  { id: 'pane.splitHorizontal', args: {} },
  { id: 'pane.split', args: {
    workspaceId: 'review', paneId: 'tasks', sessionId: 'new', splitId: 'split', title: 'New',
    launchProfile: 'shell', direction: 'diagonal', position: 'after',
  } },
  { id: 'pane.split', args: {
    workspaceId: 'review', paneId: 'tasks', sessionId: 'new', splitId: 'split', title: 'New',
    launchProfile: 'shell', direction: 'horizontal', position: 'middle',
  } },
  { id: 'pane.split', args: {
    workspaceId: 'review', paneId: 'tasks', sessionId: 'duplicate', splitId: 'duplicate',
    title: 'New', launchProfile: 'shell', direction: 'horizontal', position: 'after',
  } },
  { id: 'split.resize', args: { workspaceId: 'review', splitId: 'split', delta: 0.81 } },
  { id: 'split.resize', args: { workspaceId: 'review', splitId: 'split', delta: Number.NaN } },
  { id: 'pane.close', args: { workspaceId: 'review', paneId: 'tasks', disposition: 'later' } },
  { id: 'pane.kill', args: { workspaceId: 'review' } },
]) {
  assert.throws(() => validateCommandInvocation(invalid), /command|arguments|Unknown/u);
}

console.log('command-catalog tests passed');

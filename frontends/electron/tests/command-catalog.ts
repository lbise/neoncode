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
      defaultLaunchProfile: 'default-shell', sessionId: 'created-shell',
      paneId: 'created-pane', title: 'Shell',
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
  { id: 'pane.focus', args: { paneId: 'tasks' } },
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
for (const metadata of listCommandMetadata()) {
  assert.equal(
    metadata.externalInvocation,
    !metadata.id.startsWith('palette.')
      && !metadata.id.startsWith('settings.')
      && !metadata.id.endsWith('Dialog'),
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
    sessionId: 'new-shell', paneId: 'new-pane', title: 'Shell',
  } },
  { id: 'workspace.rename', args: { workspaceId: 'review', name: '' } },
  { id: 'workspace.delete', args: { workspaceId: 'review', disposition: 'later' } },
  { id: 'workspace.createDialog', args: {} },
  { id: 'workspace.open', args: {} },
  { id: 'workspace.open', args: { workspaceId: '' } },
  { id: 'workspace.open', args: { workspaceId: 'not valid' } },
  { id: 'workspace.open', args: { workspaceId: 'review', extra: true } },
  { id: 'workspace.dismissAttention', args: { workspaceId: 7 } },
  { id: 'pane.focus', args: { paneId: 'bad\nvalue' } },
  { id: 'pane.focus', args: { paneId: 'x'.repeat(129) } },
]) {
  assert.throws(() => validateCommandInvocation(invalid), /command|arguments|Unknown/u);
}

console.log('command-catalog tests passed');

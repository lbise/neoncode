import assert = require('node:assert/strict');

import { CommandRegistry } from '../renderer/command-registry';

async function run(): Promise<void> {
  const calls: string[] = [];
  let paneNextEnabled = false;
  const registry = new CommandRegistry({
    'palette.open': () => { calls.push('palette.open'); },
    'palette.close': () => { calls.push('palette.close'); },
    'settings.open': () => { calls.push('settings.open'); },
    'settings.close': () => { calls.push('settings.close'); },
    'workspace.create': ({ workspaceId }) => { calls.push(`workspace.create:${workspaceId}`); },
    'workspace.rename': ({ workspaceId }) => { calls.push(`workspace.rename:${workspaceId}`); },
    'workspace.delete': ({ workspaceId, disposition }) => {
      calls.push(`workspace.delete:${workspaceId}:${disposition}`);
    },
    'workspace.createDialog': () => { calls.push('workspace.createDialog'); },
    'workspace.renameDialog': () => { calls.push('workspace.renameDialog'); },
    'workspace.deleteDialog': () => { calls.push('workspace.deleteDialog'); },
    'workspace.open': ({ workspaceId }) => { calls.push(`workspace.open:${workspaceId}`); },
    'workspace.next': () => { calls.push('workspace.next'); },
    'workspace.previous': () => { calls.push('workspace.previous'); },
    'workspace.dismissAttention': ({ workspaceId }) => {
      calls.push(`workspace.dismissAttention:${workspaceId}`);
    },
    'tab.create': ({ tabId }) => { calls.push(`tab.create:${tabId}`); },
    'tab.open': ({ tabId }) => { calls.push(`tab.open:${tabId}`); },
    'tab.rename': ({ title }) => { calls.push(`tab.rename:${title}`); },
    'tab.move': ({ toIndex }) => { calls.push(`tab.move:${toIndex}`); },
    'tab.close': ({ disposition }) => { calls.push(`tab.close:${disposition}`); },
    'tab.createDefault': () => { calls.push('tab.createDefault'); },
    'tab.next': () => { calls.push('tab.next'); },
    'tab.previous': () => { calls.push('tab.previous'); },
    'tab.renameDialog': () => { calls.push('tab.renameDialog'); },
    'tab.closeDialog': () => { calls.push('tab.closeDialog'); },
    'pane.focus': ({ paneId }) => { calls.push(`pane.focus:${paneId}`); },
    'pane.next': async () => { calls.push('pane.next'); },
    'pane.previous': () => { calls.push('pane.previous'); },
  }, {
    'pane.next': () => paneNextEnabled ? null : 'No other pane is available',
    'workspace.open': ({ workspaceId }) => (
      workspaceId === 'missing' ? 'Workspace is unavailable' : null
    ),
  });

  assert.deepEqual(
    registry.list().map((command) => command.id),
    [
      'palette.open',
      'palette.close',
      'settings.open',
      'settings.close',
      'workspace.create',
      'workspace.rename',
      'workspace.delete',
      'workspace.createDialog',
      'workspace.renameDialog',
      'workspace.deleteDialog',
      'workspace.open',
      'workspace.next',
      'workspace.previous',
      'workspace.dismissAttention',
      'tab.create',
      'tab.open',
      'tab.rename',
      'tab.move',
      'tab.close',
      'tab.createDefault',
      'tab.next',
      'tab.previous',
      'tab.renameDialog',
      'tab.closeDialog',
      'pane.focus',
      'pane.next',
      'pane.previous',
    ],
  );
  assert(registry.list().every((command) => command.title.length > 0));
  assert(registry.list().every((command) => ['Application', 'Workspace', 'Tab', 'Pane'].includes(command.category)));

  const firstList = registry.list();
  const workspaceOpen = firstList.find((command) => command.id === 'workspace.open');
  assert(workspaceOpen);
  workspaceOpen.title = 'mutated test copy';
  workspaceOpen.searchTerms.push('mutated');
  assert.equal(registry.list().find((command) => command.id === 'workspace.open')?.title, 'Open Workspace');
  assert(!registry.list().find((command) => command.id === 'workspace.open')?.searchTerms.includes('mutated'));

  assert.deepEqual(
    registry.describe({ id: 'pane.next' }),
    {
      ...registry.list().find((command) => command.id === 'pane.next'),
      enabled: false,
      disabledReason: 'No other pane is available',
    },
  );
  assert.deepEqual(
    await registry.execute('pane.next'),
    { status: 'disabled', reason: 'No other pane is available' },
  );
  assert(!calls.includes('pane.next'), 'disabled command invoked its handler');
  assert.deepEqual(
    await registry.execute('workspace.open', { workspaceId: 'missing' }),
    { status: 'disabled', reason: 'Workspace is unavailable' },
  );

  await registry.execute('palette.open');
  await registry.execute('palette.close');
  await registry.execute('settings.open');
  await registry.execute('settings.close');
  await registry.execute('workspace.create', {
    workspaceId: 'created',
    name: 'Created',
    path: '/tmp/created',
    defaultLaunchProfile: 'default-shell',
    sessionId: 'created-shell',
    title: 'Shell',
  });
  await registry.execute('workspace.rename', { workspaceId: 'created', name: 'Renamed' });
  await registry.execute('workspace.delete', { workspaceId: 'created', disposition: 'detach' });
  await registry.execute('workspace.createDialog');
  await registry.execute('workspace.renameDialog');
  await registry.execute('workspace.deleteDialog');
  await registry.execute('workspace.open', { workspaceId: 'review' });
  await registry.execute('workspace.next');
  await registry.execute('workspace.previous');
  await registry.execute('workspace.dismissAttention', { workspaceId: 'review' });
  await registry.execute('tab.create', {
    workspaceId: 'review', tabId: 'tab-review', title: 'Review',
    sessionId: 'review-shell', launchProfile: 'default-shell',
  });
  await registry.execute('tab.open', { workspaceId: 'review', tabId: 'tab-review' });
  await registry.execute('tab.rename', { workspaceId: 'review', tabId: 'tab-review', title: 'Renamed' });
  await registry.execute('tab.move', { workspaceId: 'review', tabId: 'tab-review', toIndex: 0 });
  await registry.execute('tab.close', {
    workspaceId: 'review', tabId: 'tab-review', disposition: 'detach',
  });
  await registry.execute('tab.createDefault');
  await registry.execute('tab.next');
  await registry.execute('tab.previous');
  await registry.execute('tab.renameDialog');
  await registry.execute('tab.closeDialog');
  await registry.execute('pane.focus', { paneId: 'tasks' });
  paneNextEnabled = true;
  await registry.execute('pane.next');
  await registry.executeInvocation({ id: 'pane.previous' });
  assert.deepEqual(calls, [
    'palette.open',
    'palette.close',
    'settings.open',
    'settings.close',
    'workspace.create:created',
    'workspace.rename:created',
    'workspace.delete:created:detach',
    'workspace.createDialog',
    'workspace.renameDialog',
    'workspace.deleteDialog',
    'workspace.open:review',
    'workspace.next',
    'workspace.previous',
    'workspace.dismissAttention:review',
    'tab.create:tab-review',
    'tab.open:tab-review',
    'tab.rename:Renamed',
    'tab.move:0',
    'tab.close:detach',
    'tab.createDefault',
    'tab.next',
    'tab.previous',
    'tab.renameDialog',
    'tab.closeDialog',
    'pane.focus:tasks',
    'pane.next',
    'pane.previous',
  ]);

  await assert.rejects(
    registry.executeInvocation({ id: 'pane.next', args: {} }),
    /Invalid pane.next command invocation/u,
  );

  const failing = new CommandRegistry({
    'palette.open': () => { throw new Error('unexpected handler failure'); },
    'palette.close': () => {},
    'settings.open': () => {},
    'settings.close': () => {},
    'workspace.create': () => {},
    'workspace.rename': () => {},
    'workspace.delete': () => {},
    'workspace.createDialog': () => {},
    'workspace.renameDialog': () => {},
    'workspace.deleteDialog': () => {},
    'workspace.open': () => {},
    'workspace.next': () => {},
    'workspace.previous': () => {},
    'workspace.dismissAttention': () => {},
    'tab.create': () => {},
    'tab.open': () => {},
    'tab.rename': () => {},
    'tab.move': () => {},
    'tab.close': () => {},
    'tab.createDefault': () => {},
    'tab.next': () => {},
    'tab.previous': () => {},
    'tab.renameDialog': () => {},
    'tab.closeDialog': () => {},
    'pane.focus': () => {},
    'pane.next': () => {},
    'pane.previous': () => {},
  });
  await assert.rejects(failing.execute('palette.open'), /unexpected handler failure/u);
}

void run().then(() => {
  console.log('command-registry tests passed');
}).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

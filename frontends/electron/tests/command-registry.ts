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
    'workspace.open': ({ workspaceId }) => { calls.push(`workspace.open:${workspaceId}`); },
    'workspace.next': () => { calls.push('workspace.next'); },
    'workspace.previous': () => { calls.push('workspace.previous'); },
    'workspace.dismissAttention': ({ workspaceId }) => {
      calls.push(`workspace.dismissAttention:${workspaceId}`);
    },
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
      'workspace.open',
      'workspace.next',
      'workspace.previous',
      'workspace.dismissAttention',
      'pane.focus',
      'pane.next',
      'pane.previous',
    ],
  );
  assert(registry.list().every((command) => command.title.length > 0));
  assert(registry.list().every((command) => ['Application', 'Workspace', 'Pane'].includes(command.category)));

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
  await registry.execute('workspace.open', { workspaceId: 'review' });
  await registry.execute('workspace.next');
  await registry.execute('workspace.previous');
  await registry.execute('workspace.dismissAttention', { workspaceId: 'review' });
  await registry.execute('pane.focus', { paneId: 'tasks' });
  paneNextEnabled = true;
  await registry.execute('pane.next');
  await registry.executeInvocation({ id: 'pane.previous' });
  assert.deepEqual(calls, [
    'palette.open',
    'palette.close',
    'settings.open',
    'settings.close',
    'workspace.open:review',
    'workspace.next',
    'workspace.previous',
    'workspace.dismissAttention:review',
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
    'workspace.open': () => {},
    'workspace.next': () => {},
    'workspace.previous': () => {},
    'workspace.dismissAttention': () => {},
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

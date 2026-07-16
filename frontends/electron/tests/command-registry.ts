import assert = require('node:assert/strict');

import { CommandRegistry } from '../renderer/command-registry';

async function run(): Promise<void> {
  const calls: string[] = [];
  const registry = new CommandRegistry({
    'workspace.open': ({ workspaceId }) => { calls.push(`workspace.open:${workspaceId}`); },
    'workspace.next': () => { calls.push('workspace.next'); },
    'workspace.previous': () => { calls.push('workspace.previous'); },
    'pane.focus': ({ paneId }) => { calls.push(`pane.focus:${paneId}`); },
    'pane.next': async () => { calls.push('pane.next'); },
    'pane.previous': () => { calls.push('pane.previous'); },
  });

  assert.deepEqual(
    registry.list().map((command) => command.id),
    [
      'workspace.open',
      'workspace.next',
      'workspace.previous',
      'pane.focus',
      'pane.next',
      'pane.previous',
    ],
  );
  assert(registry.list().every((command) => command.title.length > 0));
  assert(registry.list().every((command) => command.category === 'Workspace' || command.category === 'Pane'));

  const firstList = registry.list();
  const first = firstList[0];
  assert(first);
  first.title = 'mutated test copy';
  assert.equal(registry.list()[0]?.title, 'Open Workspace', 'registry metadata leaked a mutable reference');

  await registry.execute('workspace.open', { workspaceId: 'review' });
  await registry.execute('workspace.next');
  await registry.execute('workspace.previous');
  await registry.execute('pane.focus', { paneId: 'tasks' });
  await registry.execute('pane.next');
  await registry.executeInvocation({ id: 'pane.previous' });
  assert.deepEqual(calls, [
    'workspace.open:review',
    'workspace.next',
    'workspace.previous',
    'pane.focus:tasks',
    'pane.next',
    'pane.previous',
  ]);
}

void run().then(() => {
  console.log('command-registry tests passed');
}).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

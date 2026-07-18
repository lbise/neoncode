import assert = require('node:assert/strict');

import {
  KeybindingRouter,
  createDefaultKeybindings,
  type KeybindingInput,
} from '../renderer/keybinding-router';

function key(overrides: Partial<KeybindingInput> = {}): KeybindingInput {
  return {
    code: 'KeyA',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altGraphKey: false,
    defaultPrevented: false,
    repeat: false,
    ...overrides,
  };
}

const bindings = createDefaultKeybindings([
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
]);
const router = new KeybindingRouter(bindings);

assert.deepEqual(
  bindings.map((binding) => binding.code),
  [
    'KeyP', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7',
    'Digit8', 'Digit9', 'Digit0', 'Digit1', 'Digit2', 'Digit3', 'Digit4',
    'Digit5', 'Digit6', 'Digit7', 'Digit8', 'KeyT', 'PageDown', 'PageUp',
    'Equal', 'Minus', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'F6', 'F6',
  ],
  'default bindings contained an unexpected shortcut',
);

assert.deepEqual(
  router.resolve(key({ code: 'KeyP', ctrlKey: true, shiftKey: true })),
  { claimed: true, execute: true, command: { id: 'palette.open' } },
);
assert.equal(router.shortcutFor({ id: 'palette.open' }), 'Ctrl+Shift+P');
assert.equal(router.shortcutFor({ id: 'workspace.openIndex', args: { index: 1 } }), 'Alt+2');
assert.equal(router.shortcutFor({ id: 'workspace.open', args: { workspaceId: 'two' } }), null);
assert.equal(router.shortcutFor({ id: 'pane.focusIndex', args: { index: 1 } }), 'Alt+Shift+2');
assert.equal(router.shortcutFor({ id: 'pane.focus', args: { paneId: 'tasks' } }), null);
assert.deepEqual(
  router.resolve(key({ code: 'Digit2', altKey: true })),
  {
    claimed: true,
    execute: true,
    command: { id: 'workspace.openIndex', args: { index: 1 } },
  },
);
assert.deepEqual(
  router.resolve(key({ code: 'KeyT', ctrlKey: true, shiftKey: true })),
  { claimed: true, execute: true, command: { id: 'tab.createDefault' } },
);
assert.deepEqual(
  router.resolve(key({ code: 'PageDown', ctrlKey: true })),
  { claimed: true, execute: true, command: { id: 'tab.next' } },
);
assert.deepEqual(
  router.resolve(key({ code: 'PageUp', ctrlKey: true })),
  { claimed: true, execute: true, command: { id: 'tab.previous' } },
);
assert.deepEqual(
  router.resolve(key({ code: 'Equal', altKey: true, shiftKey: true })),
  { claimed: true, execute: true, command: { id: 'pane.splitHorizontal' } },
);
assert.deepEqual(
  router.resolve(key({ code: 'ArrowLeft', altKey: true, shiftKey: true })),
  { claimed: true, execute: true, command: { id: 'pane.resizeLeft' } },
);
assert.deepEqual(
  router.resolve(key({ code: 'F6' })),
  { claimed: true, execute: true, command: { id: 'pane.next' } },
);
assert.deepEqual(
  router.resolve(key({ code: 'F6', shiftKey: true })),
  { claimed: true, execute: true, command: { id: 'pane.previous' } },
);
assert.deepEqual(
  router.resolve(key({ code: 'F6', repeat: true })),
  { claimed: true, execute: false },
  'a repeated claimed shortcut was not consumed without execution',
);
assert.deepEqual(
  router.resolve(key({ code: 'Digit2', altKey: true, shiftKey: true })),
  { claimed: true, execute: true, command: { id: 'pane.focusIndex', args: { index: 1 } } },
);
assert.deepEqual(
  router.resolve(key({ code: 'Digit0', altKey: true })),
  { claimed: true, execute: true, command: { id: 'workspace.openIndex', args: { index: 9 } } },
);

for (const input of [
  key({ code: 'Digit2', altKey: true, defaultPrevented: true }),
  key({ code: 'Digit2', altKey: true, ctrlKey: true }),
  key({ code: 'Digit2', altKey: true, altGraphKey: true }),
  key({ code: 'Digit2', metaKey: true, altKey: true }),
  key({ code: 'KeyP', ctrlKey: true, shiftKey: true, altKey: true }),
  key({ code: 'KeyP', ctrlKey: true }),
]) {
  assert.deepEqual(router.resolve(input), { claimed: false });
}

for (const code of ['KeyC', 'KeyD', 'KeyZ', 'KeyA', 'KeyE', 'KeyK', 'KeyU', 'KeyW', 'KeyR', 'KeyL']) {
  assert.deepEqual(
    router.resolve(key({ code, ctrlKey: true })),
    { claimed: false },
    `${code} terminal/readline control key was claimed`,
  );
}
for (const code of ['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'F5', 'F12']) {
  assert.deepEqual(router.resolve(key({ code })), { claimed: false }, `${code} terminal key was claimed`);
}

assert.throws(() => new KeybindingRouter([bindings[0]!, bindings[0]!]), /duplicate keybinding/);
console.log('keybinding-router tests passed');

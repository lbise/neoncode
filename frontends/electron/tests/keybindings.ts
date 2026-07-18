import assert = require('node:assert/strict');

import {
  availableKeybindingOverrides,
  bindingForCommand,
  createConcreteCommandInvocations,
  createDefaultKeybindings,
  formatKeyCombination,
  mergeKeybindings,
  validateKeybindingSettings,
  type KeyCombination,
  type KeybindingOverride,
} from '../shared/keybindings';

function combination(
  code: string,
  modifiers: Partial<Omit<KeyCombination, 'code'>> = {},
): KeyCombination {
  return {
    code,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
  };
}

const defaults = createDefaultKeybindings(['default', 'review']);
const allowed = createConcreteCommandInvocations(['default', 'review'], ['shell', 'tasks']);

assert.equal(formatKeyCombination(combination('KeyP', { ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+P');
assert.equal(formatKeyCombination(combination('Digit2', { altKey: true })), 'Alt+2');
assert.equal(formatKeyCombination(combination('NumpadAdd', { metaKey: true })), 'Meta+Numpad Add');
assert.equal(formatKeyCombination(bindingForCommand(defaults, { id: 'workspace.openIndex', args: { index: 1 } })!), 'Alt+2');
assert.equal(formatKeyCombination(bindingForCommand(defaults, { id: 'pane.focusIndex', args: { index: 1 } })!), 'Alt+Shift+2');
assert.equal(formatKeyCombination(bindingForCommand(defaults, { id: 'tab.createDefault' })!), 'Ctrl+Shift+T');
assert.equal(formatKeyCombination(bindingForCommand(defaults, { id: 'tab.next' })!), 'Ctrl+PageDown');
assert.equal(formatKeyCombination(bindingForCommand(defaults, { id: 'tab.previous' })!), 'Ctrl+PageUp');
assert.equal(bindingForCommand(defaults, { id: 'tab.closeDialog' }), null);
assert.equal(formatKeyCombination(bindingForCommand(defaults, { id: 'pane.splitHorizontal' })!), 'Alt+Shift+=');
assert.equal(formatKeyCombination(bindingForCommand(defaults, { id: 'pane.splitVertical' })!), 'Alt+Shift+-');
assert.equal(formatKeyCombination(bindingForCommand(defaults, { id: 'pane.resizeLeft' })!), 'Alt+Shift+Left');
assert.equal(formatKeyCombination(bindingForCommand(defaults, { id: 'pane.resizeRight' })!), 'Alt+Shift+Right');
assert.equal(formatKeyCombination(bindingForCommand(defaults, { id: 'pane.resizeUp' })!), 'Alt+Shift+Up');
assert.equal(formatKeyCombination(bindingForCommand(defaults, { id: 'pane.resizeDown' })!), 'Alt+Shift+Down');
assert.equal(bindingForCommand(defaults, { id: 'pane.closeDialog' }), null);
assert(allowed.some((command) => command.id === 'tab.renameDialog'));
assert(allowed.some((command) => command.id === 'workspace.openIndex'));
assert(allowed.some((command) => command.id === 'pane.focusIndex'));
assert(allowed.some((command) => command.id === 'pane.closeDialog'));

const overrides: KeybindingOverride[] = [
  {
    command: { id: 'workspace.open', args: { workspaceId: 'review' } },
    binding: combination('KeyJ', { ctrlKey: true, shiftKey: true }),
  },
  { command: { id: 'pane.next' }, binding: null },
  {
    command: { id: 'pane.focus', args: { paneId: 'tasks' } },
    binding: combination('F8'),
  },
];
const validated = validateKeybindingSettings({ overrides }, defaults, allowed);
const effective = mergeKeybindings(defaults, validated.overrides);
assert.equal(
  formatKeyCombination(bindingForCommand(effective, {
    id: 'workspace.open', args: { workspaceId: 'review' },
  })!),
  'Ctrl+Shift+J',
);
assert.equal(bindingForCommand(effective, { id: 'pane.next' }), null);
assert.equal(formatKeyCombination(bindingForCommand(effective, {
  id: 'workspace.openIndex', args: { index: 0 },
})!), 'Alt+1');
assert.equal(bindingForCommand(effective, { id: 'workspace.open', args: { workspaceId: 'default' } }), null);
assert.equal(formatKeyCombination(bindingForCommand(effective, {
  id: 'pane.focus', args: { paneId: 'tasks' },
})!), 'F8');

for (const binding of [
  combination('KeyQ'),
  combination('KeyQ', { shiftKey: true }),
  combination('KeyQ', { ctrlKey: true, altKey: true }),
  combination('KeyC', { ctrlKey: true }),
  combination('KeyD', { ctrlKey: true }),
  combination('KeyZ', { ctrlKey: true }),
  combination('Space', { ctrlKey: true }),
  combination('KeyL', { ctrlKey: true }),
  combination('KeyR', { ctrlKey: true }),
  combination('KeyA', { ctrlKey: true }),
  combination('KeyE', { ctrlKey: true }),
  combination('KeyK', { ctrlKey: true }),
  combination('KeyU', { ctrlKey: true }),
  combination('KeyW', { ctrlKey: true }),
  combination('KeyC', { ctrlKey: true, shiftKey: true }),
  combination('KeyV', { ctrlKey: true, shiftKey: true }),
  combination('Insert', { shiftKey: true }),
]) {
  assert.throws(
    () => validateKeybindingSettings({
      overrides: [{ command: { id: 'settings.open' }, binding }],
    }, defaults, allowed),
    /printable|AltGraph|terminal input/u,
    `unsafe shortcut was accepted: ${formatKeyCombination(binding)}`,
  );
}

assert.throws(() => validateKeybindingSettings({
  overrides: [{
    command: { id: 'settings.open' },
    binding: { ...combination('F8'), altGraphKey: true },
  }],
}, defaults, allowed), /keys must be exactly/u);
assert.throws(() => validateKeybindingSettings({
  overrides: [{ command: { id: 'settings.open' }, binding: combination('ShiftLeft') }],
}, defaults, allowed), /non-modifier/u);
assert.throws(() => validateKeybindingSettings({
  overrides: [{ command: { id: 'settings.open' }, binding: combination('NotAKey') }],
}, defaults, allowed), /KeyboardEvent\.code/u);
assert.throws(() => validateKeybindingSettings({
  overrides: [{ command: { id: 'unknown' }, binding: combination('F8') }],
}, defaults, allowed), /Unknown command/u);
const staleOverride: KeybindingOverride = {
  command: { id: 'pane.focus', args: { paneId: 'missing' } },
  binding: combination('F8'),
};
assert.throws(() => validateKeybindingSettings({
  overrides: [staleOverride],
}, defaults, allowed), /not a concrete command/u);
const tolerated = validateKeybindingSettings(
  { overrides: [staleOverride] },
  defaults,
  allowed,
  { tolerateUnavailable: true },
);
assert.deepEqual(tolerated.overrides, [staleOverride]);
assert.deepEqual(availableKeybindingOverrides(tolerated.overrides, allowed), []);
assert.throws(() => validateKeybindingSettings({ overrides: [], unexpected: true }, defaults, allowed), /keys must be exactly/u);
assert.throws(() => validateKeybindingSettings({
  overrides: Array.from({ length: 65 }, (_value, index) => ({
    command: { id: 'pane.focus', args: { paneId: `pane-${index}` } },
    binding: null,
  })),
}, defaults), /at most 64/u);
assert.throws(() => validateKeybindingSettings({
  overrides: [
    { command: { id: 'settings.open' }, binding: combination('F8') },
    { command: { id: 'settings.open' }, binding: null },
  ],
}, defaults, allowed), /same command invocation/u);
assert.throws(() => validateKeybindingSettings({
  overrides: [{ command: { id: 'settings.open' }, binding: combination('F6') }],
}, defaults, allowed), /conflicts/u);
assert.throws(() => validateKeybindingSettings({
  overrides: [
    { command: { id: 'pane.next' }, binding: null },
    { command: { id: 'settings.open' }, binding: combination('F6', { shiftKey: true }) },
  ],
}, defaults, allowed), /conflicts/u, 'the remaining Shift+F6 default conflict was not detected');

const reassigned = validateKeybindingSettings({
  overrides: [
    { command: { id: 'pane.next' }, binding: null },
    { command: { id: 'settings.open' }, binding: combination('F6') },
  ],
}, defaults, allowed);
assert.equal(formatKeyCombination(bindingForCommand(
  mergeKeybindings(defaults, reassigned.overrides),
  { id: 'settings.open' },
)!), 'F6');

console.log('keybinding contract tests passed');

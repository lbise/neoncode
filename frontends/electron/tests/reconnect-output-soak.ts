import assert = require('node:assert/strict');
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import { SessionModel } from '../renderer/session-model';

type TerminalMock = Pick<Terminal, 'rows' | 'cols' | 'options'>;

const model = new SessionModel({ windowRef: {} });
const terminal: TerminalMock = {
  rows: 24,
  cols: 80,
  options: {
    fontFamily: 'monospace',
    fontSize: 14,
    cursorBlink: false,
    theme: { background: '#000000', magenta: '#aa00aa', brightMagenta: '#ff00ff' },
  },
};
const state = model.createPaneState({
  index: 0,
  paneId: 'soak',
  sessionKey: 'soak',
  sessionId: 'soak',
  activationMode: 'attach',
  terminal: terminal as Terminal,
  fitAddon: null as unknown as FitAddon,
});
const pane = model.publicState.panes[0];
assert(pane);
const instanceId = 'ab'.repeat(16);
model.setSessionInstance(state, instanceId);
model.beginHubBoot(state, '01'.repeat(32));

let sequence = 0;
for (let reconnect = 0; reconnect < 100; reconnect += 1) {
  if (reconnect > 0 && reconnect % 10 === 0) {
    model.beginHubBoot(state, reconnect.toString(16).padStart(64, '0'));
  }
  model.applyReplayCheckpoint(state, {
    instanceId,
    firstAvailableSeq: 1,
    replayThroughSeq: sequence,
    replayTruncated: false,
    resetRequired: false,
  });
  if (sequence > 0) {
    assert.equal(model.recordOutput(state, 'duplicate', sequence), false);
  }
  for (let output = 0; output < 100; output += 1) {
    sequence += 1;
    assert.equal(model.recordOutput(state, `output-${sequence}\n`, sequence), true);
  }
  assert.equal(state.lastOutputSeq, sequence);
  assert.equal(state.sessionInstanceId, instanceId);
  assert.equal(pane.outputGap, '');
  assert.equal(pane.replayResetEvents, 0);
  assert.equal(pane.replayTruncated, false);
  assert(pane.recentOutput.length <= 32768);
}

assert.equal(sequence, 10000);
assert.equal(pane.outputEvents, 10000);
assert.equal(pane.firstOutputSeq, 1);
assert.equal(pane.lastOutputSeq, 10000);
console.log('reconnect/output deterministic soak passed');

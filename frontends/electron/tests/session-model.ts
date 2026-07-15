import assert = require('node:assert/strict');
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import { SessionModel } from '../renderer/session-model';
import type { PaneState, PublicPaneState } from '../shared/types';

type TerminalMock = Pick<Terminal, 'rows' | 'cols' | 'options'>;

interface TestState {
  model: SessionModel;
  state: PaneState;
  pane: PublicPaneState;
}

function createState(): TestState {
  const model = new SessionModel({ windowRef: {} });
  const publicState = model.publicState;
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
    paneId: 'shell',
    sessionKey: 'shell',
    sessionId: 'shell',
    activationMode: 'attach',
    terminal: terminal as Terminal,
    fitAddon: null as unknown as FitAddon,
  });
  const pane = publicState.panes[0];
  assert(pane);
  return { model, state, pane };
}

{
  const { model, state, pane } = createState();
  model.setSessionInstance(state, 'aa'.repeat(16));
  assert.equal(model.recordOutput(state, 'one', 1), true);
  assert.equal(model.recordOutput(state, 'two', 2), true);
  model.applyReplayCheckpoint(state, {
    instanceId: 'aa'.repeat(16),
    firstAvailableSeq: 1,
    replayThroughSeq: 2,
    replayTruncated: false,
    resetRequired: false,
  });
  assert.equal(state.lastOutputSeq, 2);
  assert.equal(pane.replayResetEvents, 0);
  assert.equal(pane.replayWarning, '');
}

{
  const { model, state, pane } = createState();
  model.setSessionInstance(state, 'aa'.repeat(16));
  model.recordOutput(state, 'old', 1);
  model.applyReplayCheckpoint(state, {
    instanceId: 'bb'.repeat(16),
    firstAvailableSeq: 100,
    replayThroughSeq: 120,
    replayTruncated: false,
    resetRequired: true,
  });
  assert.equal(state.lastOutputSeq, 99);
  assert.equal(model.recordOutput(state, 'bounded replay', 100), true);
  assert.equal(pane.outputGap, '');
  assert.equal(pane.firstOutputSeq, 100);
  assert.equal(pane.replayResetEvents, 1);
  assert.match(pane.replayWarning, /sequence 100/);
}

{
  const { model, state, pane } = createState();
  model.recordOutput(state, 'old', 10);
  model.applyReplayCheckpoint(state, {
    instanceId: 'aa'.repeat(16),
    firstAvailableSeq: 50,
    replayThroughSeq: 60,
    replayTruncated: true,
    resetRequired: false,
  });
  assert.equal(state.lastOutputSeq, 49);
  assert.equal(model.recordOutput(state, 'retained', 50), true);
  assert.equal(pane.outputGap, '');
  assert.equal(pane.replayTruncated, true);
  assert.match(pane.replayWarning, /sequence 50/);
}

{
  const { model, state } = createState();
  model.beginHubBoot(state, '11'.repeat(32));
  model.setSessionInstance(state, 'aa'.repeat(16));
  model.recordOutput(state, 'old', 7);
  model.beginHubBoot(state, '22'.repeat(32));
  assert.equal(state.sessionInstanceId, 'aa'.repeat(16));
  assert.equal(state.lastOutputSeq, 7);
}

{
  const { model, state } = createState();
  model.beginHubBoot(state, '11'.repeat(32));
  model.recordOutput(state, 'legacy', 7);
  model.beginHubBoot(state, '22'.repeat(32));
  assert.equal(state.lastOutputSeq, 0);
}

console.log('session-model replay checkpoint tests passed');

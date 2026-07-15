const assert = require('node:assert/strict');

global.self = global;
global.requestAnimationFrame = () => 1;

const { SessionModel } = require('../renderer/session-model');
const { ReconnectPolicy } = require('../renderer/reconnect-policy');
const { TerminalPane } = require('../renderer/terminal-pane');

class FakeClock {
  constructor() {
    this.nextId = 1;
    this.timers = new Map();
  }

  setTimer(callback) {
    const id = this.nextId++;
    this.timers.set(id, callback);
    return id;
  }

  clearTimer(id) {
    this.timers.delete(id);
  }

  fireNext() {
    const [id, callback] = this.timers.entries().next().value || [];
    assert(id, 'expected a reconnect timer');
    this.timers.delete(id);
    callback();
  }
}

class FakeHubClient {
  constructor(options) {
    this.options = options;
    this.messages = [];
    this.open = false;
    this.closed = false;
  }

  connect() {}
  isOpen() { return this.open && !this.closed; }
  attach(cursor) { this.messages.push({ type: 'attach', cursor }); return true; }
  start(request) { this.messages.push({ type: 'start', request }); return true; }
  resize() { return true; }
  close() { this.closed = true; }

  welcome(bootId) {
    this.open = true;
    this.options.onOpen({ boot_id: bootId, capabilities: ['session_replay_checkpoint'] });
  }

  message(message) {
    this.options.onMessage(message);
  }

  disconnect() {
    this.open = false;
    this.options.onClose({});
  }
}

function fakeTerminal() {
  return {
    rows: 24,
    cols: 80,
    resetCount: 0,
    writes: [],
    options: {
      fontFamily: 'monospace',
      fontSize: 14,
      cursorBlink: false,
      theme: { background: '#000000', magenta: '#aa00aa', brightMagenta: '#ff00ff' },
    },
    write(value) { this.writes.push(value); },
    writeln(value) { this.writes.push(value); },
    reset() { this.resetCount += 1; this.writes = []; },
  };
}

const clock = new FakeClock();
const reconnectPolicy = new ReconnectPolicy({
  setTimer: (callback) => clock.setTimer(callback),
  clearTimer: (timer) => clock.clearTimer(timer),
});
const clients = [];
const sessionModel = new SessionModel({ windowRef: {} });
const terminal = fakeTerminal();
const pane = new TerminalPane({
  index: 0,
  paneId: 'shell',
  sessionKey: 'shell',
  sessionId: 'fake-restart-shell',
  activationMode: 'start',
  endpoint: 'ws://127.0.0.1:44777/ws',
  capabilityToken: '00'.repeat(32),
  launchProfile: { command: 'sh', args: [], cwd: null },
  terminalAppearance: {},
  container: {},
  statusElement: null,
  sessionModel,
  setStatus: () => {},
  reconnectPolicy,
  hubClientFactory: (options) => {
    const client = new FakeHubClient(options);
    clients.push(client);
    return client;
  },
});
pane.state = sessionModel.createPaneState({
  index: 0,
  paneId: 'shell',
  sessionKey: 'shell',
  sessionId: 'fake-restart-shell',
  activationMode: 'start',
  terminal,
  fitAddon: { fit() {} },
});
pane.setLifecycle('connecting');
pane.connect();

const bootA = '11'.repeat(32);
const bootB = '22'.repeat(32);
const instanceA = 'aa'.repeat(16);
const instanceB = 'bb'.repeat(16);
const clientA = clients[0];
clientA.welcome(bootA);
assert.equal(clientA.messages[0].type, 'start');
clientA.message({ type: 'started', session_id: pane.sessionId, instance_id: instanceA });
clientA.message({
  type: 'output',
  session_id: pane.sessionId,
  seq: 1,
  data_b64: Buffer.from('before restart\n').toString('base64'),
});
assert.equal(pane.state.lastOutputSeq, 1);
assert.equal(pane.state.sessionInstanceId, instanceA);

clientA.disconnect();
assert.equal(clock.timers.size, 1);
clock.fireNext();
assert.equal(clients.length, 2);
const clientB = clients[1];

clientA.message({
  type: 'output',
  session_id: pane.sessionId,
  seq: 2,
  data_b64: Buffer.from('stale generation\n').toString('base64'),
});
assert.equal(pane.state.lastOutputSeq, 1, 'late generation-A output was accepted');

clientB.welcome(bootB);
assert.deepEqual(clientB.messages[0], {
  type: 'attach',
  cursor: { instanceId: instanceA, afterOutputSeq: 1 },
});
clientB.message({
  type: 'error',
  session_id: pane.sessionId,
  message: `unknown session: ${pane.sessionId}`,
});
assert.equal(clientB.messages.filter((message) => message.type === 'start').length, 1);
clientB.message({ type: 'started', session_id: pane.sessionId, instance_id: instanceB });
assert.equal(terminal.resetCount, 1);
assert.equal(pane.state.sessionInstanceId, instanceB);
assert.equal(pane.state.lastOutputSeq, 0);
assert.equal(sessionModel.publicState.panes[0].replayResetEvents, 1);

clientA.message({ type: 'started', session_id: pane.sessionId, instance_id: 'cc'.repeat(16) });
assert.equal(pane.state.sessionInstanceId, instanceB, 'late generation-A start was accepted');
clientB.message({
  type: 'output',
  session_id: pane.sessionId,
  seq: 1,
  data_b64: Buffer.from('after restart\n').toString('base64'),
});
assert.equal(pane.state.lastOutputSeq, 1);
assert.equal(sessionModel.publicState.panes[0].outputGap, '');

clientB.message({
  type: 'attached',
  session_id: pane.sessionId,
  instance_id: instanceB,
  first_available_seq: 1,
});
assert.equal(clientB.closed, true, 'malformed checkpoint did not close the fake transport');
assert.match(pane.state.error, /Invalid attach replay checkpoint/);
assert.equal(clock.timers.size, 0);
console.log('terminal-pane fake hub restart tests passed');

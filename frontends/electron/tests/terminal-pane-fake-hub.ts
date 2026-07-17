import assert = require('node:assert/strict');

import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import type { HubClientOptions, UnknownMessage } from '../renderer/hub-client';
import type { HubClientTransport } from '../renderer/terminal-pane';

Reflect.set(globalThis, 'self', globalThis);
Reflect.set(globalThis, 'requestAnimationFrame', (_callback: FrameRequestCallback): number => 1);

const { defaultTerminalAppearance }: typeof import('../config-store') = require('../config-store');
const { ReconnectPolicy }: typeof import('../renderer/reconnect-policy') = require('../renderer/reconnect-policy');
const { SessionModel }: typeof import('../renderer/session-model') = require('../renderer/session-model');
const { TerminalPane }: typeof import('../renderer/terminal-pane') = require('../renderer/terminal-pane');

type TimerCallback = () => void;

class FakeClock {
  nextId = 1;
  readonly timers = new Map<NodeJS.Timeout, TimerCallback>();

  setTimer(callback: TimerCallback): NodeJS.Timeout {
    const id = this.nextId++ as unknown as NodeJS.Timeout;
    this.timers.set(id, callback);
    return id;
  }

  clearTimer(id: NodeJS.Timeout): void {
    this.timers.delete(id);
  }

  fireNext(): void {
    const entry = this.timers.entries().next().value;
    assert(entry, 'expected a reconnect timer');
    const [id, callback] = entry;
    this.timers.delete(id);
    callback();
  }
}

interface SentAttachMessage {
  type: 'attach';
  cursor: { instanceId: string; afterOutputSeq: number } | undefined;
}

interface SentStartMessage {
  type: 'start';
  request: Parameters<HubClientTransport['start']>[0];
}

type SentMessage = SentAttachMessage | SentStartMessage;

class FakeHubClient implements HubClientTransport {
  readonly messages: SentMessage[] = [];
  open = false;
  closed = false;

  constructor(readonly options: HubClientOptions) {}

  connect(): void {}
  isOpen(): boolean { return this.open && !this.closed; }
  attach(cursor?: SentAttachMessage['cursor']): boolean {
    this.messages.push({ type: 'attach', cursor });
    return true;
  }
  start(request: SentStartMessage['request']): boolean {
    this.messages.push({ type: 'start', request });
    return true;
  }
  input(_bytes: Uint8Array): boolean { return true; }
  resize(_size: { rows: number; cols: number }): boolean { return true; }
  detach(): boolean { return true; }
  kill(): boolean { return true; }
  close(): void { this.closed = true; }

  welcome(bootId: string): void {
    this.open = true;
    assert(this.options.onOpen, 'fake hub requires an open callback');
    this.options.onOpen({
      type: 'welcome',
      protocol_version: 1,
      boot_id: bootId,
      capabilities: ['session_replay_checkpoint'],
    });
  }

  message(message: UnknownMessage): void {
    assert(this.options.onMessage, 'fake hub requires a message callback');
    this.options.onMessage(message);
  }

  disconnect(): void {
    this.open = false;
    assert(this.options.onClose, 'fake hub requires a close callback');
    this.options.onClose({} as CloseEvent);
  }
}

interface FakeTerminal {
  rows: number;
  cols: number;
  resetCount: number;
  writes: Array<string | Uint8Array>;
  options: {
    fontFamily: string;
    fontSize: number;
    cursorBlink: boolean;
    theme: { background: string; magenta: string; brightMagenta: string };
  };
  write(value: string | Uint8Array): void;
  writeln(value: string): void;
  reset(): void;
}

function fakeTerminal(): FakeTerminal {
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
    write(value): void { this.writes.push(value); },
    writeln(value): void { this.writes.push(value); },
    reset(): void { this.resetCount += 1; this.writes = []; },
  };
}

const clock = new FakeClock();
const reconnectPolicy = new ReconnectPolicy({
  setTimer: (callback) => clock.setTimer(callback),
  clearTimer: (timer) => clock.clearTimer(timer),
});
const clients: FakeHubClient[] = [];
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
  terminalAppearance: defaultTerminalAppearance(),
  container: {} as HTMLElement,
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
  terminal: terminal as unknown as Terminal,
  fitAddon: { fit(): void {} } as FitAddon,
});
pane.setLifecycle('connecting');
pane.connect();
assert.deepEqual(terminal.writes, [], 'internal connection text leaked into terminal scrollback');

const bootA = '11'.repeat(32);
const bootB = '22'.repeat(32);
const instanceA = 'aa'.repeat(16);
const instanceB = 'bb'.repeat(16);
const clientA = clients[0];
assert(clientA, 'missing generation-A fake hub client');
clientA.welcome(bootA);
assert.equal(clientA.messages[0]?.type, 'start');
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
assert(clientB, 'missing generation-B fake hub client');

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
assert.equal(sessionModel.publicState.panes[0]?.replayResetEvents, 1);
assert(
  !terminal.writes.some((write) => typeof write === 'string' && (write as string).includes('Replacement session started')),
  'internal replacement-session notice leaked into terminal scrollback',
);

clientA.message({ type: 'started', session_id: pane.sessionId, instance_id: 'cc'.repeat(16) });
assert.equal(pane.state.sessionInstanceId, instanceB, 'late generation-A start was accepted');
clientB.message({
  type: 'output',
  session_id: pane.sessionId,
  seq: 1,
  data_b64: Buffer.from('after restart\n').toString('base64'),
});
assert.equal(pane.state.lastOutputSeq, 1);
assert.equal(sessionModel.publicState.panes[0]?.outputGap, '');

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

const assert = require('node:assert/strict');
const { createHmac, webcrypto } = require('node:crypto');

Object.defineProperty(global, 'crypto', { configurable: true, value: webcrypto });

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor(endpoint, protocols) {
    this.endpoint = endpoint;
    this.protocols = protocols;
    this.readyState = MockWebSocket.OPEN;
    this.listeners = new Map();
    this.sent = [];
    MockWebSocket.instances.push(this);
  }

  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }

  async emit(type, event = {}) {
    for (const callback of this.listeners.get(type) || []) {
      await callback(event);
    }
  }

  send(payload) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    return this.emit('close', {});
  }
}

Object.defineProperty(global, 'WebSocket', { configurable: true, value: MockWebSocket });

class FakeClock {
  constructor() {
    this.now = 0;
    this.nextId = 1;
    this.timers = new Map();
  }

  setTimeout(callback, delayMs) {
    const id = this.nextId++;
    this.timers.set(id, { callback, due: this.now + delayMs });
    return id;
  }

  clearTimeout(id) {
    this.timers.delete(id);
  }

  advance(delayMs) {
    this.now += delayMs;
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.due <= this.now)
      .sort((left, right) => left[1].due - right[1].due);
    for (const [id, timer] of due) {
      if (!this.timers.delete(id)) continue;
      timer.callback();
    }
  }
}

const {
  HubClient,
  normalizeSessionSummaries,
  parseReplayCheckpoint,
} = require('../renderer/hub-client');

const TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const SERVER_NONCE = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

function hmac(payload) {
  return createHmac('sha256', Buffer.from(TOKEN, 'hex')).update(payload).digest('hex');
}

function validatesReplayCheckpoints() {
  assert.deepEqual(parseReplayCheckpoint({
    instance_id: 'ab'.repeat(16),
    first_available_seq: 10,
    replay_through_seq: 42,
    replay_truncated: true,
    reset_required: false,
  }), {
    instanceId: 'ab'.repeat(16),
    firstAvailableSeq: 10,
    replayThroughSeq: 42,
    replayTruncated: true,
    resetRequired: false,
  });
  assert.equal(parseReplayCheckpoint({ type: 'attached' }), null);
  assert.throws(
    () => parseReplayCheckpoint({
      instance_id: 'ab'.repeat(16),
      first_available_seq: 1,
    }),
    /Invalid attach replay checkpoint/,
  );
  const malformed = [
    {
      instance_id: 'not-an-instance', first_available_seq: 1, replay_through_seq: 0,
      replay_truncated: false, reset_required: false,
    },
    {
      instance_id: 'ab'.repeat(16), first_available_seq: 4, replay_through_seq: 2,
      replay_truncated: false, reset_required: false,
    },
    {
      instance_id: 'ab'.repeat(16), first_available_seq: 1, replay_through_seq: 2,
      replay_truncated: true, reset_required: true,
    },
    {
      instance_id: 'ab'.repeat(16), first_available_seq: Number.MAX_SAFE_INTEGER + 1,
      replay_through_seq: 0, replay_truncated: false, reset_required: false,
    },
  ];
  for (const checkpoint of malformed) {
    assert.throws(
      () => parseReplayCheckpoint(checkpoint),
      /Invalid attach replay checkpoint/,
    );
  }
}

async function handshakeTimeoutsAreDeterministic() {
  {
    const clock = new FakeClock();
    let invalid = 0;
    const client = new HubClient({
      endpoint: 'ws://127.0.0.1:44777/ws',
      capabilityToken: TOKEN,
      sessionId: 'timeout-authentication',
      onInvalidMessage: (error) => {
        invalid += 1;
        assert.match(error.message, /authentication timed out/);
      },
      setTimer: (callback, delayMs) => clock.setTimeout(callback, delayMs),
      clearTimer: (timer) => clock.clearTimeout(timer),
      authenticationTimeoutMs: 10,
    });
    client.connect();
    const socket = MockWebSocket.instances.at(-1);
    clock.advance(9);
    assert.equal(socket.readyState, MockWebSocket.OPEN);
    clock.advance(1);
    assert.equal(socket.readyState, MockWebSocket.CLOSED);
    assert.equal(invalid, 1);
    assert.equal(clock.timers.size, 0);
  }

  {
    const clock = new FakeClock();
    let opened = 0;
    let invalid = 0;
    const client = new HubClient({
      endpoint: 'ws://127.0.0.1:44777/ws',
      capabilityToken: TOKEN,
      sessionId: 'timeout-welcome',
      onOpen: () => { opened += 1; },
      onInvalidMessage: (error) => {
        invalid += 1;
        assert.match(error.message, /welcome timed out/);
      },
      setTimer: (callback, delayMs) => clock.setTimeout(callback, delayMs),
      clearTimer: (timer) => clock.clearTimeout(timer),
      authenticationTimeoutMs: 20,
      welcomeTimeoutMs: 10,
    });
    client.connect();
    const socket = MockWebSocket.instances.at(-1);
    await socket.emit('message', {
      data: JSON.stringify({ type: 'auth_challenge', nonce: SERVER_NONCE }),
    });
    const authenticate = JSON.parse(socket.sent[0]);
    await socket.emit('message', {
      data: JSON.stringify({
        type: 'authenticated',
        hmac: hmac(`server:${authenticate.client_nonce}`),
      }),
    });
    clock.advance(10);
    assert.equal(socket.readyState, MockWebSocket.CLOSED);
    assert.equal(opened, 0);
    assert.equal(invalid, 1);
    await socket.emit('message', {
      data: JSON.stringify({
        type: 'welcome', protocol_version: 1, boot_id: '12'.repeat(32), capabilities: [],
      }),
    });
    assert.equal(opened, 0);
    assert.equal(invalid, 1);
  }

  {
    const clock = new FakeClock();
    let opened = 0;
    const client = new HubClient({
      endpoint: 'ws://127.0.0.1:44777/ws',
      capabilityToken: TOKEN,
      sessionId: 'welcome-cancels-timeout',
      onOpen: () => { opened += 1; },
      setTimer: (callback, delayMs) => clock.setTimeout(callback, delayMs),
      clearTimer: (timer) => clock.clearTimeout(timer),
      authenticationTimeoutMs: 20,
      welcomeTimeoutMs: 10,
    });
    client.connect();
    const socket = MockWebSocket.instances.at(-1);
    await socket.emit('message', {
      data: JSON.stringify({ type: 'auth_challenge', nonce: SERVER_NONCE }),
    });
    const authenticate = JSON.parse(socket.sent[0]);
    await socket.emit('message', {
      data: JSON.stringify({
        type: 'authenticated',
        hmac: hmac(`server:${authenticate.client_nonce}`),
      }),
    });
    await socket.emit('message', {
      data: JSON.stringify({
        type: 'welcome', protocol_version: 1, boot_id: '34'.repeat(32), capabilities: [],
      }),
    });
    assert.equal(opened, 1);
    assert.equal(clock.timers.size, 0);
    clock.advance(100);
    assert.equal(socket.readyState, MockWebSocket.OPEN);
  }
}

function validatesSessionSummaries() {
  const complete = normalizeSessionSummaries([{
    session_id: 'shell',
    command: 'bash',
    cwd: '/tmp',
    persistent: true,
    attachment_count: 2,
  }]);
  assert.deepEqual(complete, [{
    sessionId: 'shell',
    command: 'bash',
    cwd: '/tmp',
    persistent: true,
    attachmentCount: 2,
    metadataComplete: true,
    state: 'running',
    latestExit: null,
    lifecycleComplete: false,
    instanceId: null,
    instanceComplete: false,
  }]);

  assert.deepEqual(normalizeSessionSummaries([{ session_id: 'legacy' }]), [{
    sessionId: 'legacy',
    command: null,
    cwd: null,
    persistent: null,
    attachmentCount: null,
    metadataComplete: false,
    state: 'running',
    latestExit: null,
    lifecycleComplete: false,
    instanceId: null,
    instanceComplete: false,
  }]);
  assert.throws(
    () => normalizeSessionSummaries([{ session_id: 'duplicate' }, { session_id: 'duplicate' }]),
    /duplicate session_id/,
  );
  assert.throws(
    () => normalizeSessionSummaries([{ session_id: 'partial', command: 'bash' }]),
    /metadata is incomplete/,
  );
  const exited = normalizeSessionSummaries([{
    session_id: 'exited',
    command: 'bash',
    cwd: null,
    persistent: true,
    attachment_count: 0,
    state: 'exited',
    latest_exit: {
      attention_id: 'ab'.repeat(16), status: 7, reason: 'process_exit',
    },
  }]);
  assert.deepEqual(exited[0].latestExit, {
    attentionId: 'ab'.repeat(16), status: 7, reason: 'process_exit',
  });
  assert.equal(exited[0].state, 'exited');
  assert.equal(exited[0].lifecycleComplete, true);
  assert.throws(
    () => normalizeSessionSummaries([{
      session_id: 'partial-lifecycle',
      command: 'bash',
      cwd: null,
      persistent: true,
      attachment_count: 0,
      state: 'exited',
    }]),
    /lifecycle metadata is incomplete/,
  );
  assert.throws(
    () => normalizeSessionSummaries([{
      session_id: 'bad-count',
      command: 'bash',
      cwd: null,
      persistent: true,
      attachment_count: -1,
    }]),
    /attachment_count/,
  );
}

async function validMutualAuthentication() {
  let opened = 0;
  let invalid = 0;
  const client = new HubClient({
    endpoint: 'ws://127.0.0.1:44777/ws',
    capabilityToken: TOKEN,
    onOpen: () => { opened += 1; },
    onInvalidMessage: () => { invalid += 1; },
  });
  client.connect();

  const socket = MockWebSocket.instances.at(-1);
  assert.deepEqual(socket.protocols, ['neoncode.v1']);
  await socket.emit('message', {
    data: JSON.stringify({ type: 'auth_challenge', nonce: SERVER_NONCE }),
  });

  assert.equal(opened, 0, 'client opened before server proof');
  assert.equal(socket.sent.length, 1);
  assert(!socket.sent[0].includes(TOKEN), 'raw capability token crossed the socket');
  const response = JSON.parse(socket.sent[0]);
  assert.equal(response.type, 'authenticate');
  assert.match(response.client_nonce, /^[0-9a-f]{64}$/);
  assert.equal(response.hmac, hmac(`client:${SERVER_NONCE}`));

  await socket.emit('message', {
    data: JSON.stringify({
      type: 'authenticated',
      hmac: hmac(`server:${response.client_nonce}`),
    }),
  });
  assert.equal(opened, 0, 'client opened before welcome');
  await socket.emit('message', {
    data: JSON.stringify({
      type: 'welcome',
      protocol_version: 1,
      boot_id: 'ab'.repeat(32),
    }),
  });

  assert.equal(opened, 1);
  assert.equal(invalid, 0);
  assert.equal(client.isOpen(), true);
}

async function rejectsMalformedWelcomeCapabilities() {
  let opened = 0;
  let invalid = 0;
  const client = new HubClient({
    endpoint: 'ws://127.0.0.1:44777/ws',
    capabilityToken: TOKEN,
    onOpen: () => { opened += 1; },
    onInvalidMessage: () => { invalid += 1; },
  });
  client.connect();

  const socket = MockWebSocket.instances.at(-1);
  await socket.emit('message', {
    data: JSON.stringify({ type: 'auth_challenge', nonce: SERVER_NONCE }),
  });
  const response = JSON.parse(socket.sent[0]);
  await socket.emit('message', {
    data: JSON.stringify({ type: 'authenticated', hmac: hmac(`server:${response.client_nonce}`) }),
  });
  await socket.emit('message', {
    data: JSON.stringify({
      type: 'welcome',
      protocol_version: 1,
      boot_id: 'ab'.repeat(32),
      capabilities: ['valid', 7],
    }),
  });
  assert.equal(opened, 0);
  assert.equal(invalid, 1);
  assert.equal(socket.readyState, MockWebSocket.CLOSED);
}

async function rejectsFakeHubProof() {
  let opened = 0;
  let invalid = 0;
  const client = new HubClient({
    endpoint: 'ws://127.0.0.1:44777/ws',
    capabilityToken: TOKEN,
    onOpen: () => { opened += 1; },
    onInvalidMessage: () => { invalid += 1; },
  });
  client.connect();

  const socket = MockWebSocket.instances.at(-1);
  await socket.emit('message', {
    data: JSON.stringify({ type: 'auth_challenge', nonce: SERVER_NONCE }),
  });
  await socket.emit('message', {
    data: JSON.stringify({ type: 'authenticated', hmac: '00'.repeat(32) }),
  });

  assert.equal(opened, 0);
  assert.equal(invalid, 1);
  assert.equal(socket.readyState, MockWebSocket.CLOSED);
  assert.equal(client.isOpen(), false);
}

Promise.resolve()
  .then(validatesSessionSummaries)
  .then(validatesReplayCheckpoints)
  .then(handshakeTimeoutsAreDeterministic)
  .then(validMutualAuthentication)
  .then(rejectsMalformedWelcomeCapabilities)
  .then(rejectsFakeHubProof)
  .then(() => console.log('hub-client mutual authentication tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

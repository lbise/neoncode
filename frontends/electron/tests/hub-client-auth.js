const assert = require('node:assert/strict');
const { createHmac, webcrypto } = require('node:crypto');

global.crypto = webcrypto;

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

global.WebSocket = MockWebSocket;

const { HubClient } = require('../renderer/hub-client');

const TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const SERVER_NONCE = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

function hmac(payload) {
  return createHmac('sha256', Buffer.from(TOKEN, 'hex')).update(payload).digest('hex');
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

  assert.equal(opened, 1);
  assert.equal(invalid, 0);
  assert.equal(client.isOpen(), true);
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
  .then(validMutualAuthentication)
  .then(rejectsFakeHubProof)
  .then(() => console.log('hub-client mutual authentication tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

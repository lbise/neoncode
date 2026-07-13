const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function hexToBytes(value) {
  if (!/^[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) {
    throw new Error('Invalid hexadecimal value');
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function importAuthenticationKey(capabilityToken, usages) {
  return crypto.subtle.importKey(
    'raw',
    hexToBytes(capabilityToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  );
}

async function createAuthenticationHmac(capabilityToken, payload) {
  const key = await importAuthenticationKey(capabilityToken, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return bytesToHex(new Uint8Array(signature));
}

async function verifyAuthenticationHmac(capabilityToken, payload, hmac) {
  const key = await importAuthenticationKey(capabilityToken, ['verify']);
  return crypto.subtle.verify('HMAC', key, hexToBytes(hmac), encoder.encode(payload));
}

function base64ToBytes(data) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

class HubClient {
  constructor({ endpoint, capabilityToken, sessionId, onOpen, onMessage, onInvalidMessage, onClose, onError }) {
    this.endpoint = endpoint;
    this.capabilityToken = capabilityToken;
    this.sessionId = sessionId;
    this.onOpen = onOpen;
    this.onMessage = onMessage;
    this.onInvalidMessage = onInvalidMessage;
    this.onClose = onClose;
    this.onError = onError;
    this.socket = undefined;
    this.authenticated = false;
    this.clientNonce = undefined;
  }

  connect() {
    const socket = new WebSocket(this.endpoint, ['neoncode.v1']);
    this.socket = socket;

    socket.addEventListener('message', async (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        this.onInvalidMessage?.(error, event.data);
        return;
      }

      if (!this.authenticated) {
        if (message.type === 'auth_challenge' && typeof message.nonce === 'string') {
          try {
            if (!/^[0-9a-f]{64}$/.test(message.nonce) || this.clientNonce) {
              throw new Error('Invalid authentication challenge');
            }
            this.clientNonce = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
            const hmac = await createAuthenticationHmac(
              this.capabilityToken,
              `client:${message.nonce}`,
            );
            socket.send(JSON.stringify({
              type: 'authenticate',
              client_nonce: this.clientNonce,
              hmac,
            }));
          } catch (error) {
            this.onInvalidMessage?.(error, event.data);
            socket.close();
          }
          return;
        }
        if (message.type === 'authenticated' && typeof message.hmac === 'string') {
          try {
            if (!this.clientNonce || !await verifyAuthenticationHmac(
              this.capabilityToken,
              `server:${this.clientNonce}`,
              message.hmac,
            )) {
              throw new Error('Hub authentication proof is invalid');
            }
            this.clientNonce = undefined;
            this.authenticated = true;
            this.onOpen?.();
          } catch (error) {
            this.onInvalidMessage?.(error, event.data);
            socket.close();
          }
          return;
        }
        this.onInvalidMessage?.(new Error('Unexpected message before authentication'), event.data);
        socket.close();
        return;
      }

      this.onMessage?.(message);
    });

    socket.addEventListener('close', (event) => {
      this.authenticated = false;
      this.clientNonce = undefined;
      this.onClose?.(event);
    });

    socket.addEventListener('error', (event) => {
      this.onError?.(event);
    });
  }

  isOpen() {
    return this.authenticated && this.socket?.readyState === WebSocket.OPEN;
  }

  send(message) {
    if (!this.isOpen()) {
      return false;
    }

    this.socket.send(JSON.stringify(message));
    return true;
  }

  listSessions() {
    return this.send({
      type: 'list_sessions',
    });
  }

  attach() {
    return this.send({
      type: 'attach',
      session_id: this.sessionId,
    });
  }

  start({ command = 'bash', args = [], cwd = null, rows = 30, cols = 120 }) {
    return this.send({
      type: 'start',
      session_id: this.sessionId,
      command,
      args,
      cwd,
      rows,
      cols,
    });
  }

  input(bytes) {
    return this.send({
      type: 'input',
      session_id: this.sessionId,
      data_b64: bytesToBase64(bytes),
    });
  }

  resize({ rows, cols }) {
    return this.send({
      type: 'resize',
      session_id: this.sessionId,
      rows,
      cols,
    });
  }

  detach() {
    return this.send({
      type: 'detach',
      session_id: this.sessionId,
    });
  }

  kill() {
    return this.send({
      type: 'kill',
      session_id: this.sessionId,
    });
  }

  close() {
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
  }
}

module.exports = {
  HubClient,
  base64ToBytes,
  decoder,
  encoder,
};

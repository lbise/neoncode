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

function normalizeSessionSummaries(sessions) {
  if (!Array.isArray(sessions) || sessions.length > 64) {
    throw new Error('session_list.sessions must contain at most 64 entries');
  }
  const seen = new Set();
  return sessions.map((summary) => {
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
      throw new Error('session_list summary must be an object');
    }
    const sessionId = summary.session_id;
    if (typeof sessionId !== 'string'
        || !/^[A-Za-z0-9_.-]{1,128}$/.test(sessionId)
        || seen.has(sessionId)) {
      throw new Error('session_list contains an invalid or duplicate session_id');
    }
    seen.add(sessionId);

    const metadataKeys = ['command', 'cwd', 'persistent', 'attachment_count'];
    const metadataFields = metadataKeys.filter((key) => Object.hasOwn(summary, key)).length;
    if (metadataFields !== 0 && metadataFields !== metadataKeys.length) {
      throw new Error(`session_list metadata is incomplete for ${sessionId}`);
    }
    if (metadataFields === 0) {
      return {
        sessionId,
        command: null,
        cwd: null,
        persistent: null,
        attachmentCount: null,
        metadataComplete: false,
      };
    }

    if (typeof summary.command !== 'string'
        || summary.command.length < 1
        || encoder.encode(summary.command).length > 4096) {
      throw new Error(`session_list command is invalid for ${sessionId}`);
    }
    if (summary.cwd !== null
        && (typeof summary.cwd !== 'string' || encoder.encode(summary.cwd).length > 4096)) {
      throw new Error(`session_list cwd is invalid for ${sessionId}`);
    }
    if (typeof summary.persistent !== 'boolean') {
      throw new Error(`session_list persistent flag is invalid for ${sessionId}`);
    }
    if (!Number.isInteger(summary.attachment_count)
        || summary.attachment_count < 0
        || summary.attachment_count > 128) {
      throw new Error(`session_list attachment_count is invalid for ${sessionId}`);
    }
    return {
      sessionId,
      command: summary.command,
      cwd: summary.cwd,
      persistent: summary.persistent,
      attachmentCount: summary.attachment_count,
      metadataComplete: true,
    };
  });
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
    this.ready = false;
    this.clientNonce = undefined;
    this.welcome = undefined;
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

      if (!this.ready) {
        if (message.type === 'welcome'
            && message.protocol_version === 1
            && /^[0-9a-f]{64}$/.test(message.boot_id || '')) {
          this.welcome = message;
          this.ready = true;
          this.onOpen?.(message);
          return;
        }
        this.onInvalidMessage?.(new Error('Invalid or unsupported hub welcome'), event.data);
        socket.close();
        return;
      }

      if (message.type === 'session_list') {
        try {
          message = { ...message, sessions: normalizeSessionSummaries(message.sessions) };
        } catch (error) {
          this.onInvalidMessage?.(error, event.data);
          socket.close();
          return;
        }
      }
      this.onMessage?.(message);
    });

    socket.addEventListener('close', (event) => {
      this.authenticated = false;
      this.ready = false;
      this.clientNonce = undefined;
      this.welcome = undefined;
      this.onClose?.(event);
    });

    socket.addEventListener('error', (event) => {
      this.onError?.(event);
    });
  }

  isOpen() {
    return this.ready && this.socket?.readyState === WebSocket.OPEN;
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

  start({ command = 'bash', args = [], cwd = null, rows = 30, cols = 120, persistent = false }) {
    return this.send({
      type: 'start',
      session_id: this.sessionId,
      command,
      args,
      cwd,
      persistent,
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
  normalizeSessionSummaries,
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
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
  constructor({ endpoint, sessionId, onOpen, onMessage, onInvalidMessage, onClose, onError }) {
    this.endpoint = endpoint;
    this.sessionId = sessionId;
    this.onOpen = onOpen;
    this.onMessage = onMessage;
    this.onInvalidMessage = onInvalidMessage;
    this.onClose = onClose;
    this.onError = onError;
    this.socket = undefined;
  }

  connect() {
    const socket = new WebSocket(this.endpoint);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.onOpen?.();
    });

    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        this.onInvalidMessage?.(error, event.data);
        return;
      }

      this.onMessage?.(message);
    });

    socket.addEventListener('close', (event) => {
      this.onClose?.(event);
    });

    socket.addEventListener('error', (event) => {
      this.onError?.(event);
    });
  }

  isOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
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

  start({ command = 'bash', rows = 30, cols = 120 }) {
    return this.send({
      type: 'start',
      session_id: this.sessionId,
      command,
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

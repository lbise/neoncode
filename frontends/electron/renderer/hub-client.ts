import type {
  HubWelcome,
  NormalizedSessionSummary,
  ReplayCheckpoint,
  RetainedExitSummary,
  SessionSummaryState,
} from '../shared/types';

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();
export const AUTHENTICATION_TIMEOUT_MS = 5000;
export const WELCOME_TIMEOUT_MS = 3000;

type TimerHandle = ReturnType<typeof setTimeout>;
export type UnknownMessage = Record<string, unknown>;

export interface HubClientOptions {
  endpoint: string;
  capabilityToken: string;
  sessionId?: string;
  onOpen?: (welcome: HubWelcome) => void;
  onMessage?: (message: UnknownMessage) => void;
  onInvalidMessage?: (error: unknown, raw?: unknown) => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (event: Event) => void;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  authenticationTimeoutMs?: number;
  welcomeTimeoutMs?: number;
}

interface AttachCursor {
  instanceId?: string;
  afterOutputSeq?: number;
}

interface StartOptions {
  command?: string;
  args?: string[];
  cwd?: string | null;
  rows?: number;
  cols?: number;
  persistent?: boolean;
}

interface TerminalSize {
  rows: number;
  cols: number;
}

function isRecord(value: unknown): value is UnknownMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function hexToBytes(value: string): Uint8Array {
  if (!/^[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) {
    throw new Error('Invalid hexadecimal value');
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function importAuthenticationKey(capabilityToken: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    hexToBytes(capabilityToken).buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  );
}

async function createAuthenticationHmac(capabilityToken: string, payload: string): Promise<string> {
  const key = await importAuthenticationKey(capabilityToken, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return bytesToHex(new Uint8Array(signature));
}

async function verifyAuthenticationHmac(
  capabilityToken: string,
  payload: string,
  hmac: string,
): Promise<boolean> {
  const key = await importAuthenticationKey(capabilityToken, ['verify']);
  return crypto.subtle.verify(
    'HMAC',
    key,
    hexToBytes(hmac).buffer as ArrayBuffer,
    encoder.encode(payload),
  );
}

function normalizeExitSummary(exit: unknown, sessionId: string): RetainedExitSummary {
  if (!isRecord(exit)) {
    throw new Error(`session_list latest_exit is invalid for ${sessionId}`);
  }
  if (typeof exit.attention_id !== 'string' || !/^[0-9a-f]{32}$/.test(exit.attention_id)) {
    throw new Error(`session_list attention_id is invalid for ${sessionId}`);
  }
  if (exit.status !== null && !Number.isInteger(exit.status)) {
    throw new Error(`session_list exit status is invalid for ${sessionId}`);
  }
  const reason = exit.reason;
  if (reason !== 'process_exit' && reason !== 'wait_failed' && reason !== 'killed') {
    throw new Error(`session_list exit reason is invalid for ${sessionId}`);
  }
  return {
    attentionId: exit.attention_id,
    status: exit.status as number | null,
    reason,
  };
}

export function normalizeSessionSummaries(sessions: unknown): NormalizedSessionSummary[] {
  if (!Array.isArray(sessions) || sessions.length > 64) {
    throw new Error('session_list.sessions must contain at most 64 entries');
  }
  const seen = new Set();
  return sessions.map((rawSummary) => {
    if (!isRecord(rawSummary)) {
      throw new Error('session_list summary must be an object');
    }
    const summary = rawSummary;
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
        state: 'running',
        latestExit: null,
        lifecycleComplete: false,
        instanceId: null,
        instanceComplete: false,
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
        || (summary.attachment_count as number) < 0
        || (summary.attachment_count as number) > 128) {
      throw new Error(`session_list attachment_count is invalid for ${sessionId}`);
    }
    let instanceId: string | null = null;
    let instanceComplete = false;
    if (Object.hasOwn(summary, 'instance_id')) {
      if (typeof summary.instance_id !== 'string' || !/^[0-9a-f]{32}$/.test(summary.instance_id)) {
        throw new Error(`session_list instance_id is invalid for ${sessionId}`);
      }
      instanceId = summary.instance_id;
      instanceComplete = true;
    }
    const lifecycleKeys = ['state', 'latest_exit'];
    const lifecycleFields = lifecycleKeys.filter((key) => Object.hasOwn(summary, key)).length;
    if (lifecycleFields !== 0 && lifecycleFields !== lifecycleKeys.length) {
      throw new Error(`session_list lifecycle metadata is incomplete for ${sessionId}`);
    }
    let state: SessionSummaryState = 'running';
    let latestExit: RetainedExitSummary | null = null;
    if (lifecycleFields === lifecycleKeys.length) {
      if (summary.state !== 'running' && summary.state !== 'exited') {
        throw new Error(`session_list state is invalid for ${sessionId}`);
      }
      state = summary.state;
      latestExit = summary.latest_exit === null
        ? null
        : normalizeExitSummary(summary.latest_exit, sessionId);
      if (state === 'exited' && latestExit === null) {
        throw new Error(`exited session is missing latest_exit for ${sessionId}`);
      }
    }
    return {
      sessionId,
      command: summary.command,
      cwd: summary.cwd,
      persistent: summary.persistent,
      attachmentCount: summary.attachment_count as number,
      metadataComplete: true,
      state,
      latestExit,
      lifecycleComplete: lifecycleFields === lifecycleKeys.length,
      instanceId,
      instanceComplete,
    };
  });
}

export function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function parseReplayCheckpoint(message: UnknownMessage): ReplayCheckpoint | null {
  const fields = [
    'instance_id', 'first_available_seq', 'replay_through_seq',
    'replay_truncated', 'reset_required',
  ];
  const present = fields.filter((field) => Object.hasOwn(message, field)).length;
  if (present === 0) return null;
  if (present !== fields.length
      || typeof message.instance_id !== 'string'
      || !/^[0-9a-f]{32}$/.test(message.instance_id)
      || typeof message.first_available_seq !== 'number'
      || !Number.isSafeInteger(message.first_available_seq)
      || message.first_available_seq < 1
      || typeof message.replay_through_seq !== 'number'
      || !Number.isSafeInteger(message.replay_through_seq)
      || message.replay_through_seq < 0
      || message.first_available_seq > message.replay_through_seq + 1
      || typeof message.replay_truncated !== 'boolean'
      || typeof message.reset_required !== 'boolean'
      || (message.replay_truncated && message.reset_required)) {
    throw new Error('Invalid attach replay checkpoint');
  }
  return {
    instanceId: message.instance_id,
    firstAvailableSeq: message.first_available_seq,
    replayThroughSeq: message.replay_through_seq,
    replayTruncated: message.replay_truncated,
    resetRequired: message.reset_required,
  };
}

export class HubClient {
  readonly endpoint: string;
  readonly capabilityToken: string;
  readonly sessionId: string | undefined;
  readonly onOpen: HubClientOptions['onOpen'];
  readonly onMessage: HubClientOptions['onMessage'];
  readonly onInvalidMessage: HubClientOptions['onInvalidMessage'];
  readonly onClose: HubClientOptions['onClose'];
  readonly onError: HubClientOptions['onError'];
  readonly setTimer: NonNullable<HubClientOptions['setTimer']>;
  readonly clearTimer: NonNullable<HubClientOptions['clearTimer']>;
  readonly authenticationTimeoutMs: number;
  readonly welcomeTimeoutMs: number;
  socket: WebSocket | undefined;
  authenticated = false;
  ready = false;
  clientNonce: string | undefined;
  welcome: HubWelcome | undefined;
  private handshakeTimer: TimerHandle | undefined;

  constructor({
    endpoint,
    capabilityToken,
    sessionId,
    onOpen,
    onMessage,
    onInvalidMessage,
    onClose,
    onError,
    setTimer = (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer = (timer) => clearTimeout(timer),
    authenticationTimeoutMs = AUTHENTICATION_TIMEOUT_MS,
    welcomeTimeoutMs = WELCOME_TIMEOUT_MS,
  }: HubClientOptions) {
    this.endpoint = endpoint;
    this.capabilityToken = capabilityToken;
    this.sessionId = sessionId;
    this.onOpen = onOpen;
    this.onMessage = onMessage;
    this.onInvalidMessage = onInvalidMessage;
    this.onClose = onClose;
    this.onError = onError;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.authenticationTimeoutMs = authenticationTimeoutMs;
    this.welcomeTimeoutMs = welcomeTimeoutMs;
  }

  clearHandshakeTimer(): void {
    if (this.handshakeTimer !== undefined) {
      this.clearTimer(this.handshakeTimer);
      this.handshakeTimer = undefined;
    }
  }

  armHandshakeTimer(socket: WebSocket, phase: string, delayMs: number): void {
    this.clearHandshakeTimer();
    this.handshakeTimer = this.setTimer(() => {
      this.handshakeTimer = undefined;
      if (socket !== this.socket || this.ready || socket.readyState === WebSocket.CLOSED) return;
      this.onInvalidMessage?.(new Error(`Hub ${phase} timed out`));
      socket.close();
    }, delayMs);
  }

  connect(): void {
    const socket = new WebSocket(this.endpoint, ['neoncode.v1']);
    this.socket = socket;
    this.authenticated = false;
    this.ready = false;
    this.clientNonce = undefined;
    this.welcome = undefined;
    this.armHandshakeTimer(socket, 'authentication', this.authenticationTimeoutMs);

    socket.addEventListener('message', async (event) => {
      if (socket !== this.socket || socket.readyState === WebSocket.CLOSED) return;
      let parsedMessage: unknown;
      try {
        parsedMessage = JSON.parse(event.data as string) as unknown;
      } catch (error) {
        this.onInvalidMessage?.(error, event.data);
        return;
      }
      if (!isRecord(parsedMessage)) {
        this.onInvalidMessage?.(new Error('Hub message must be an object'), event.data);
        socket.close();
        return;
      }
      let message = parsedMessage;

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
            if (socket !== this.socket || socket.readyState !== WebSocket.OPEN || this.authenticated) {
              return;
            }
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
            const clientNonce = this.clientNonce;
            const proofValid = clientNonce && await verifyAuthenticationHmac(
              this.capabilityToken,
              `server:${clientNonce}`,
              message.hmac,
            );
            if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) return;
            if (!proofValid) {
              throw new Error('Hub authentication proof is invalid');
            }
            this.clientNonce = undefined;
            this.authenticated = true;
            this.armHandshakeTimer(socket, 'welcome', this.welcomeTimeoutMs);
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
            && typeof message.boot_id === 'string'
            && /^[0-9a-f]{64}$/.test(message.boot_id)) {
          const capabilities = message.capabilities === undefined ? [] : message.capabilities;
          if (!Array.isArray(capabilities)
              || capabilities.length > 32
              || capabilities.some((capability) => typeof capability !== 'string' || capability.length > 64)) {
            this.onInvalidMessage?.(new Error('Invalid hub capabilities'), event.data);
            socket.close();
            return;
          }
          const welcome = {
            ...message,
            type: 'welcome' as const,
            protocol_version: 1 as const,
            boot_id: message.boot_id as string,
            capabilities: [...capabilities] as string[],
          };
          this.welcome = welcome;
          this.ready = true;
          this.clearHandshakeTimer();
          this.onOpen?.(welcome);
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
      if (socket !== this.socket) return;
      this.clearHandshakeTimer();
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

  isOpen(): boolean {
    return this.ready && this.socket?.readyState === WebSocket.OPEN;
  }

  send(message: UnknownMessage): boolean {
    if (!this.isOpen()) {
      return false;
    }

    this.socket!.send(JSON.stringify(message));
    return true;
  }

  listSessions(): boolean {
    return this.send({
      type: 'list_sessions',
    });
  }

  attach({ instanceId, afterOutputSeq }: AttachCursor = {}): boolean {
    const cursor = instanceId && Number.isSafeInteger(afterOutputSeq)
      ? { instance_id: instanceId, after_output_seq: afterOutputSeq }
      : {};
    return this.send({
      type: 'attach',
      session_id: this.sessionId,
      ...cursor,
    });
  }

  start({
    command = 'bash',
    args = [],
    cwd = null,
    rows = 30,
    cols = 120,
    persistent = false,
  }: StartOptions): boolean {
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

  input(bytes: Uint8Array): boolean {
    return this.send({
      type: 'input',
      session_id: this.sessionId,
      data_b64: bytesToBase64(bytes),
    });
  }

  resize({ rows, cols }: TerminalSize): boolean {
    return this.send({
      type: 'resize',
      session_id: this.sessionId,
      rows,
      cols,
    });
  }

  detach(): boolean {
    return this.send({
      type: 'detach',
      session_id: this.sessionId,
    });
  }

  kill(): boolean {
    return this.send({
      type: 'kill',
      session_id: this.sessionId,
    });
  }

  acknowledgeAttention(attentionId: string): boolean {
    return this.send({
      type: 'acknowledge_attention',
      session_id: this.sessionId,
      attention_id: attentionId,
    });
  }

  close(): void {
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
  }
}

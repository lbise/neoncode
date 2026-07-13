const { HubClient } = require('./hub-client');
const { SessionModel } = require('./session-model');
const { TerminalPane } = require('./terminal-pane');
const { installRendererTestApi } = require('./test-api');

const DEFAULT_ENDPOINT = 'ws://127.0.0.1:44777/ws';
const DEFAULT_TERMINAL_COUNT = 2;
const DEFAULT_SESSION_PREFIX = 'electron-xterm-shell';
const MAX_STATIC_TERMINAL_PANES = 2;
const STARTUP_SESSION_LIST_TIMEOUT_MS = 2000;
const DEFAULT_PANE_DEFINITIONS = Object.freeze([
  Object.freeze({ paneId: 'shell', sessionKey: 'shell', terminalElementId: 'terminal-1' }),
  Object.freeze({ paneId: 'tasks', sessionKey: 'tasks', terminalElementId: 'terminal-2' }),
]);

function parseTerminalCount(value) {
  return Number.parseInt(value || String(DEFAULT_TERMINAL_COUNT), 10) || DEFAULT_TERMINAL_COUNT;
}

function normalizeSessionKey(value, fallback) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function createSessionId(sessionPrefix, sessionKey) {
  return `${sessionPrefix}-${normalizeSessionKey(sessionKey, 'session')}`;
}

function createPaneDescriptors({ terminalCount, sessionPrefix }) {
  const count = Math.min(MAX_STATIC_TERMINAL_PANES, Math.max(1, terminalCount));
  return DEFAULT_PANE_DEFINITIONS.slice(0, count).map((definition, index) => ({
    ...definition,
    index,
    sessionId: createSessionId(sessionPrefix, definition.sessionKey),
  }));
}

function createAppConfig(env = process.env) {
  const terminalCount = parseTerminalCount(env.NEONCODE_TERMINAL_COUNT);
  const sessionPrefix = env.NEONCODE_SESSION_PREFIX || DEFAULT_SESSION_PREFIX;
  return {
    endpoint: env.NEONCODE_HUB_ENDPOINT || DEFAULT_ENDPOINT,
    terminalCount,
    sessionPrefix,
    persistSessions: env.NEONCODE_PERSIST_SESSIONS !== '0',
    testMode: env.NEONCODE_TEST_MODE === '1',
    panes: createPaneDescriptors({ terminalCount, sessionPrefix }),
  };
}

class NeonCodeApp {
  constructor({ documentRef = document, windowRef = window, env = process.env } = {}) {
    this.document = documentRef;
    this.window = windowRef;
    this.config = createAppConfig(env);
    this.statusElement = this.document.getElementById('status');
    this.terminalGrid = this.document.getElementById('terminal-grid');
    this.sessionModel = new SessionModel({ windowRef: this.window });
    this.sessionDiscoveryClient = undefined;
    this.knownSessionIds = new Set();
    this.panes = [];
    this.closed = false;
    this.closePromise = undefined;
    if (this.config.testMode) {
      installRendererTestApi(this);
    }
  }

  setStatus(text) {
    this.statusElement.textContent = text;
  }

  configureGrid() {
    const count = Math.max(1, this.config.panes.length);
    this.terminalGrid.style.gridTemplateColumns = `repeat(${count}, minmax(0, 1fr))`;

    for (let index = 0; index < MAX_STATIC_TERMINAL_PANES; index += 1) {
      const pane = this.document.getElementById(`terminal-${index + 1}`)?.parentElement;
      if (pane) {
        pane.style.display = index < count ? 'grid' : 'none';
      }
    }
  }

  async start() {
    this.configureGrid();
    this.knownSessionIds = new Set(await this.discoverSessions());
    if (this.closed) {
      return;
    }
    for (const descriptor of this.config.panes) {
      this.createPane(descriptor);
    }
  }

  discoverSessions() {
    this.sessionModel.setSessionDiscoveryStatus('connecting');

    return new Promise((resolve) => {
      let settled = false;
      const finish = (sessions) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        this.sessionDiscoveryClient?.close();
        resolve(sessions);
      };

      const timeoutHandle = setTimeout(() => {
        console.log('hub_session_list_timeout');
        this.sessionModel.setSessionDiscoveryStatus('timeout', 'Timed out waiting for session_list');
        finish([]);
      }, STARTUP_SESSION_LIST_TIMEOUT_MS);

      this.sessionDiscoveryClient = new HubClient({
        endpoint: this.config.endpoint,
        onOpen: () => {
          console.log('hub_session_list_requested');
          this.sessionModel.setSessionDiscoveryStatus('requested');
          this.sessionDiscoveryClient.listSessions();
        },
        onMessage: (message) => {
          if (message.type === 'session_list') {
            const sessions = (message.sessions || [])
              .map((session) => session.session_id)
              .filter((sessionId) => typeof sessionId === 'string' && sessionId.length > 0);
            console.log(`hub_session_list ${sessions.length} ${sessions.join(',')}`);
            this.sessionModel.recordSessionList(sessions);
            finish(sessions);
          } else if (message.type === 'error') {
            const error = message.message || 'Hub session discovery error';
            console.log(`hub_session_list_error ${error}`);
            this.sessionModel.setSessionDiscoveryStatus('error', error);
            finish([]);
          }
        },
        onInvalidMessage: (error) => {
          console.log(`hub_session_list_invalid_json ${error.message}`);
          this.sessionModel.setSessionDiscoveryStatus('error', error.message);
          finish([]);
        },
        onClose: () => {
          if (!settled) {
            console.log('hub_session_list_closed');
            this.sessionModel.setSessionDiscoveryStatus('closed', 'Session discovery WebSocket closed');
            finish([]);
          }
        },
        onError: () => {
          if (!settled) {
            console.log('hub_session_list_websocket_error');
            this.sessionModel.setSessionDiscoveryStatus('error', 'WebSocket error during session discovery');
            finish([]);
          }
        },
      });

      this.sessionDiscoveryClient.connect();
    });
  }

  createPane(descriptor) {
    const container = this.document.getElementById(descriptor.terminalElementId);
    if (!container) {
      return;
    }

    const pane = new TerminalPane({
      index: descriptor.index,
      paneId: descriptor.paneId,
      sessionKey: descriptor.sessionKey,
      sessionId: descriptor.sessionId,
      activationMode: this.knownSessionIds.has(descriptor.sessionId) ? 'attach' : 'start',
      endpoint: this.config.endpoint,
      container,
      statusElement: this.document.getElementById(`pane-status-${descriptor.index + 1}`),
      sessionModel: this.sessionModel,
      setStatus: (text) => this.setStatus(text),
    });
    this.panes.push(pane);
    pane.start();
  }

  prepareToClose() {
    if (this.closePromise) {
      return this.closePromise;
    }

    this.closed = true;
    this.sessionDiscoveryClient?.close();
    this.closePromise = this.config.persistSessions
      ? Promise.all(this.panes.map((pane) => pane.detachAndClose())).then(() => undefined)
      : Promise.resolve().then(() => {
        for (const pane of this.panes) {
          pane.close();
        }
      });
    return this.closePromise;
  }

  close() {
    this.closed = true;
    this.sessionDiscoveryClient?.close();
    for (const pane of this.panes) {
      pane.close();
    }
  }
}

function startRendererApp() {
  const app = new NeonCodeApp();
  window.addEventListener('DOMContentLoaded', () => {
    app.start().catch((error) => {
      console.error('app_start_failed', error);
      app.setStatus('Failed to start NeonCode app');
    });
  });
  window.addEventListener('beforeunload', () => {
    app.close();
  });
  return app;
}

module.exports = {
  DEFAULT_ENDPOINT,
  DEFAULT_PANE_DEFINITIONS,
  DEFAULT_SESSION_PREFIX,
  DEFAULT_TERMINAL_COUNT,
  STARTUP_SESSION_LIST_TIMEOUT_MS,
  NeonCodeApp,
  createAppConfig,
  createPaneDescriptors,
  createSessionId,
  normalizeSessionKey,
  parseTerminalCount,
  startRendererApp,
};

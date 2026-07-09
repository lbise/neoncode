const { SessionModel } = require('./session-model');
const { TerminalPane } = require('./terminal-pane');

const DEFAULT_ENDPOINT = 'ws://127.0.0.1:44777/ws';
const DEFAULT_TERMINAL_COUNT = 2;
const DEFAULT_SESSION_PREFIX = 'electron-xterm-shell';
const MAX_STATIC_TERMINAL_PANES = 2;
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
    this.panes = [];
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

  start() {
    this.configureGrid();
    for (const descriptor of this.config.panes) {
      this.createPane(descriptor);
    }
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
      endpoint: this.config.endpoint,
      container,
      sessionModel: this.sessionModel,
      setStatus: (text) => this.setStatus(text),
    });
    this.panes.push(pane);
    pane.start();
  }

  close() {
    for (const pane of this.panes) {
      pane.close();
    }
  }
}

function startRendererApp() {
  const app = new NeonCodeApp();
  window.addEventListener('DOMContentLoaded', () => {
    app.start();
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
  NeonCodeApp,
  createAppConfig,
  createPaneDescriptors,
  createSessionId,
  normalizeSessionKey,
  parseTerminalCount,
  startRendererApp,
};

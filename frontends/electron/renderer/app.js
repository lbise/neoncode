const { HubClient } = require('./hub-client');
const { SessionModel } = require('./session-model');
const { TerminalPane } = require('./terminal-pane');
const { installRendererTestApi } = require('./test-api');

const MAX_STATIC_TERMINAL_PANES = 2;
const STARTUP_SESSION_LIST_TIMEOUT_MS = 2000;

function createSessionId(sessionPrefix, sessionKey) {
  return `${sessionPrefix}-${sessionKey}`;
}

function createPaneDescriptors(bootstrap) {
  return (bootstrap.sessions || []).slice(0, MAX_STATIC_TERMINAL_PANES).map((session, index) => ({
    index,
    paneId: session.id,
    sessionKey: session.id,
    title: session.title,
    terminalElementId: `terminal-${index + 1}`,
    sessionId: createSessionId(bootstrap.sessionPrefix, session.id),
    launchProfile: { ...session.launchProfile },
  }));
}

function createAppConfig(bootstrap = {}) {
  return {
    schemaVersion: bootstrap.schemaVersion,
    configurationValid: bootstrap.configurationValid === true,
    endpoint: bootstrap.endpoint || '',
    capabilityToken: bootstrap.capabilityToken,
    sessionPrefix: bootstrap.sessionPrefix || '',
    persistencePolicy: bootstrap.persistencePolicy || 'detach',
    testMode: bootstrap.testMode === true,
    diagnostics: {
      configStatus: bootstrap.diagnostics?.configStatus || 'error',
      stateStatus: bootstrap.diagnostics?.stateStatus || 'error',
      warnings: [...(bootstrap.diagnostics?.warnings || [])],
      errors: [...(bootstrap.diagnostics?.errors || [])],
    },
    panes: createPaneDescriptors(bootstrap),
  };
}

class NeonCodeApp {
  constructor({ documentRef = document, windowRef = window, bootstrap = {} } = {}) {
    this.document = documentRef;
    this.window = windowRef;
    this.config = createAppConfig(bootstrap);
    this.statusElement = this.document.getElementById('status');
    this.configurationStatusElement = this.document.getElementById('configuration-status');
    this.terminalGrid = this.document.getElementById('terminal-grid');
    this.sessionModel = new SessionModel({ windowRef: this.window });
    this.sessionModel.setConfiguration({
      valid: this.config.configurationValid,
      configStatus: this.config.diagnostics.configStatus,
      stateStatus: this.config.diagnostics.stateStatus,
      warnings: this.config.diagnostics.warnings,
      errors: this.config.diagnostics.errors,
      persistencePolicy: this.config.persistencePolicy,
      sessions: this.config.panes.map(({ paneId, title, sessionId, launchProfile }) => ({
        id: paneId,
        title,
        sessionId,
        launchProfile,
      })),
    });
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

  showConfigurationDiagnostics() {
    const { warnings, errors } = this.config.diagnostics;
    if (errors.length > 0) {
      this.configurationStatusElement.textContent = `Configuration error: ${errors.join('; ')}`;
      this.configurationStatusElement.dataset.state = 'error';
    } else if (warnings.length > 0) {
      this.configurationStatusElement.textContent = warnings.join('; ');
      this.configurationStatusElement.dataset.state = 'warning';
    } else {
      this.configurationStatusElement.textContent = '';
      this.configurationStatusElement.dataset.state = 'ready';
    }
  }

  configureGrid() {
    const count = this.config.panes.length;
    this.terminalGrid.style.gridTemplateColumns = `repeat(${Math.max(1, count)}, minmax(0, 1fr))`;

    for (let index = 0; index < MAX_STATIC_TERMINAL_PANES; index += 1) {
      const descriptor = this.config.panes[index];
      const container = this.document.getElementById(`terminal-${index + 1}`);
      const pane = container?.parentElement;
      const title = this.document.getElementById(`pane-title-${index + 1}`);
      const status = this.document.getElementById(`pane-status-${index + 1}`);
      if (!pane) {
        continue;
      }
      pane.style.display = descriptor ? 'grid' : 'none';
      if (descriptor) {
        pane.dataset.testid = `terminal-pane-${descriptor.paneId}`;
        title.textContent = descriptor.title;
        title.dataset.testid = `pane-title-${descriptor.paneId}`;
        status.dataset.testid = `pane-status-${descriptor.paneId}`;
      }
    }
  }

  async start() {
    this.configureGrid();
    this.showConfigurationDiagnostics();
    if (!this.config.configurationValid) {
      const message = this.config.diagnostics.errors.join('; ') || 'Configuration is invalid';
      this.sessionModel.setSessionDiscoveryStatus('configuration_error', message);
      this.setStatus('Configuration error — edit %APPDATA%\\NeonCode\\config.json and restart');
      return;
    }

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
        capabilityToken: this.config.capabilityToken,
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
      capabilityToken: this.config.capabilityToken,
      launchProfile: descriptor.launchProfile,
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
    const closeMethod = this.config.persistencePolicy === 'kill' ? 'killAndClose' : 'detachAndClose';
    this.closePromise = Promise.all(this.panes.map((pane) => pane[closeMethod]())).then(() => undefined);
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

function startRendererApp(options = {}) {
  const app = new NeonCodeApp(options);
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
  MAX_STATIC_TERMINAL_PANES,
  STARTUP_SESSION_LIST_TIMEOUT_MS,
  NeonCodeApp,
  createAppConfig,
  createPaneDescriptors,
  createSessionId,
  startRendererApp,
};

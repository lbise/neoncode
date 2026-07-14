const { HubClient } = require('./hub-client');
const { SessionModel } = require('./session-model');
const { TerminalPane } = require('./terminal-pane');
const { installRendererTestApi } = require('./test-api');

const STARTUP_SESSION_LIST_TIMEOUT_MS = 2000;
const CONTROL_OPERATION_TIMEOUT_MS = 1500;

function createSessionId(sessionPrefix, sessionKey) {
  return `${sessionPrefix}-${sessionKey}`;
}

function createWorkspaceDescriptors(bootstrap) {
  return (bootstrap.workspaces || []).map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    layout: { columns: workspace.layout.columns },
    panes: workspace.sessions.map((session, index) => ({
      index,
      workspaceId: workspace.id,
      paneId: session.id,
      sessionKey: session.id,
      title: session.title,
      terminalElementId: `terminal-${workspace.id}-${session.id}`,
      sessionId: createSessionId(bootstrap.sessionPrefix, session.id),
      launchProfile: { ...session.launchProfile },
    })),
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
    terminal: bootstrap.terminal ? JSON.parse(JSON.stringify(bootstrap.terminal)) : null,
    testMode: bootstrap.testMode === true,
    activeWorkspaceId: bootstrap.activeWorkspaceId || null,
    diagnostics: {
      configStatus: bootstrap.diagnostics?.configStatus || 'error',
      stateStatus: bootstrap.diagnostics?.stateStatus || 'error',
      warnings: [...(bootstrap.diagnostics?.warnings || [])],
      errors: [...(bootstrap.diagnostics?.errors || [])],
    },
    workspaces: createWorkspaceDescriptors(bootstrap),
  };
}

class NeonCodeApp {
  constructor({ documentRef = document, windowRef = window, bootstrap = {} } = {}) {
    this.document = documentRef;
    this.window = windowRef;
    this.config = createAppConfig(bootstrap);
    this.statusElement = this.document.getElementById('status');
    this.configurationStatusElement = this.document.getElementById('configuration-status');
    this.workspaceList = this.document.getElementById('workspace-list');
    this.terminalGrid = this.document.getElementById('terminal-grid');
    this.sessionModel = new SessionModel({ windowRef: this.window });
    this.sessionModel.setConfiguration({
      valid: this.config.configurationValid,
      configStatus: this.config.diagnostics.configStatus,
      stateStatus: this.config.diagnostics.stateStatus,
      warnings: this.config.diagnostics.warnings,
      errors: this.config.diagnostics.errors,
      persistencePolicy: this.config.persistencePolicy,
      terminal: this.config.terminal,
      activeWorkspaceId: this.config.activeWorkspaceId,
      workspaces: this.config.workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        layout: workspace.layout,
        sessions: workspace.panes.map(({ paneId, title, sessionId, launchProfile }) => ({
          id: paneId,
          title,
          sessionId,
          launchProfile,
        })),
      })),
    });
    this.sessionDiscoveryClient = undefined;
    this.discoveredSessionIds = new Set();
    this.visitedSessionIds = new Set();
    this.workspaceSessionStates = new Map(
      this.config.workspaces.flatMap((workspace) => workspace.panes.map((pane) => [
        pane.sessionId,
        { workspaceId: workspace.id, lifecycle: 'idle', error: '' },
      ])),
    );
    this.panes = [];
    this.activeWorkspaceId = null;
    this.closed = false;
    this.closePromise = undefined;
    this.switchPromise = Promise.resolve();
    this.switching = false;
    if (this.config.testMode) {
      installRendererTestApi(this);
    }
  }

  setStatus(text) {
    this.statusElement.textContent = text;
  }

  addRuntimeWarning(warning) {
    if (!this.config.diagnostics.warnings.includes(warning)) {
      this.config.diagnostics.warnings.push(warning);
    }
    this.sessionModel.addConfigurationWarning(warning);
    this.showConfigurationDiagnostics();
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

  workspaceLocation(workspace) {
    const paths = new Set(workspace.panes.map((pane) => pane.launchProfile.cwd || '~'));
    if (paths.size === 1) return `WSL · ${[...paths][0]}`;
    return `WSL · ${paths.size} paths`;
  }

  workspaceSummary(workspace) {
    const states = workspace.panes.map((pane) => (
      this.workspaceSessionStates.get(pane.sessionId) || { lifecycle: 'idle', error: '' }
    ));
    const count = (lifecycles) => states.filter((state) => lifecycles.includes(state.lifecycle)).length;
    const errors = states.filter((state) => state.error).map((state) => state.error);
    if (errors.length > 0 || count(['error']) > 0) {
      return { state: 'error', label: 'Error', detail: errors[0] || 'Session error' };
    }
    if (count(['reconnecting']) > 0) {
      return { state: 'reconnecting', label: 'Reconnecting', detail: 'Session reconnecting' };
    }
    const stopped = count(['killed', 'exited']);
    if (stopped > 0) {
      return { state: 'stopped', label: `${stopped} stopped`, detail: `${stopped} sessions stopped` };
    }
    const running = count(['started', 'attached']);
    if (running > 0) {
      return { state: 'running', label: `${running} running`, detail: `${running} of ${states.length} sessions running` };
    }
    const transitional = count(['connecting', 'starting', 'attaching', 'detaching', 'killing']);
    if (transitional > 0) {
      return { state: 'connecting', label: 'Connecting', detail: 'Session transition in progress' };
    }
    const detached = count(['detached']);
    if (detached > 0) {
      return { state: 'detached', label: `${detached} detached`, detail: `${detached} sessions detached` };
    }
    const available = count(['available']);
    if (available > 0) {
      return { state: 'available', label: `${available} available`, detail: `${available} hub sessions available` };
    }
    return { state: 'idle', label: 'Not started', detail: 'No workspace sessions started' };
  }

  updateWorkspaceStatuses() {
    const summaries = this.config.workspaces.map((workspace) => ({
      id: workspace.id,
      location: this.workspaceLocation(workspace),
      ...this.workspaceSummary(workspace),
    }));
    this.sessionModel.setWorkspaceSummaries(summaries);
    for (const summary of summaries) {
      const button = this.workspaceList.querySelector(`[data-workspace-id="${summary.id}"]`);
      const status = button?.querySelector('.workspace-status');
      if (!button || !status) continue;
      button.dataset.state = summary.state;
      button.title = `${summary.location} — ${summary.detail}`;
      status.dataset.state = summary.state;
      status.textContent = summary.label;
    }
  }

  recordWorkspaceSessionState(sessionId, lifecycle, error = '') {
    const current = this.workspaceSessionStates.get(sessionId);
    if (!current) return;
    this.workspaceSessionStates.set(sessionId, { ...current, lifecycle, error });
    this.updateWorkspaceStatuses();
  }

  renderWorkspaceSelector() {
    this.workspaceList.replaceChildren();
    for (const workspace of this.config.workspaces) {
      const button = this.document.createElement('button');
      button.type = 'button';
      button.className = 'workspace-button';
      button.dataset.workspaceId = workspace.id;
      button.dataset.testid = `workspace-${workspace.id}`;
      button.setAttribute('aria-current', workspace.id === this.activeWorkspaceId ? 'true' : 'false');
      button.disabled = this.switching;

      const identity = this.document.createElement('span');
      identity.className = 'workspace-identity';
      const name = this.document.createElement('span');
      name.className = 'workspace-name';
      name.textContent = workspace.name;
      const location = this.document.createElement('span');
      location.className = 'workspace-location';
      location.textContent = this.workspaceLocation(workspace);
      identity.append(name, location);
      const status = this.document.createElement('span');
      status.className = 'workspace-status';
      status.dataset.testid = `workspace-status-${workspace.id}`;
      button.append(identity, status);
      button.addEventListener('click', () => {
        this.switchWorkspace(workspace.id).catch((error) => {
          console.error('workspace_switch_failed', error);
          this.setStatus(`Workspace switch failed: ${error.message}`);
        });
      });
      this.workspaceList.append(button);
    }
    this.updateWorkspaceStatuses();
  }

  updateWorkspaceSelector() {
    for (const button of this.workspaceList.querySelectorAll('.workspace-button')) {
      button.setAttribute('aria-current', button.dataset.workspaceId === this.activeWorkspaceId ? 'true' : 'false');
      button.disabled = this.switching;
    }
  }

  async start() {
    this.showConfigurationDiagnostics();
    if (!this.config.configurationValid) {
      const message = this.config.diagnostics.errors.join('; ') || 'Configuration is invalid';
      this.sessionModel.setSessionDiscoveryStatus('configuration_error', message);
      this.setStatus('Configuration error — edit %APPDATA%\\NeonCode\\config.json and restart');
      return;
    }

    this.renderWorkspaceSelector();
    this.discoveredSessionIds = new Set(await this.discoverSessions());
    for (const sessionId of this.discoveredSessionIds) {
      if (this.workspaceSessionStates.has(sessionId)) {
        const current = this.workspaceSessionStates.get(sessionId);
        this.workspaceSessionStates.set(sessionId, { ...current, lifecycle: 'available', error: '' });
      }
    }
    this.updateWorkspaceStatuses();
    if (this.closed) {
      return;
    }
    const initialWorkspace = this.config.workspaces.find(
      (workspace) => workspace.id === this.config.activeWorkspaceId,
    ) || this.config.workspaces[0];
    await this.switchWorkspace(initialWorkspace.id, { initial: true });
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

  switchWorkspace(workspaceId, { initial = false } = {}) {
    const operation = this.switchPromise.then(() => this.performWorkspaceSwitch(workspaceId, { initial }));
    this.switchPromise = operation.catch(() => {});
    return operation;
  }

  async performWorkspaceSwitch(workspaceId, { initial = false } = {}) {
    if (this.closed) {
      throw new Error('application is closing');
    }
    const workspace = this.config.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) {
      throw new Error(`unknown workspace: ${workspaceId}`);
    }
    if (!initial && workspaceId === this.activeWorkspaceId) {
      return;
    }

    this.switching = true;
    this.updateWorkspaceSelector();
    this.setStatus(`Switching to ${workspace.name}...`);
    try {
      try {
        await this.window.neoncodeDesktop.setActiveWorkspace(workspaceId);
      } catch (error) {
        if (!initial) {
          throw error;
        }
        this.addRuntimeWarning(`Active workspace could not be persisted: ${error.message}`);
      }
      if (this.panes.length > 0) {
        await Promise.all(this.panes.map((pane) => pane.detachAndClose()));
        for (const pane of this.panes) {
          pane.dispose();
        }
      }
      this.panes = [];
      if (this.closed) {
        return;
      }
      this.terminalGrid.replaceChildren();
      this.sessionModel.resetPanes(workspaceId);
      this.activeWorkspaceId = workspaceId;
      this.configureWorkspaceGrid(workspace);
      this.updateWorkspaceSelector();

      for (const descriptor of workspace.panes) {
        this.createPaneSurface(descriptor);
        this.createPane(descriptor);
        this.discoveredSessionIds.add(descriptor.sessionId);
        this.visitedSessionIds.add(descriptor.sessionId);
      }
      this.sessionModel.setActiveWorkspace(workspaceId);
      this.setStatus(`Workspace: ${workspace.name}`);
    } finally {
      this.switching = false;
      this.updateWorkspaceSelector();
    }
  }

  configureWorkspaceGrid(workspace) {
    const rows = Math.ceil(workspace.panes.length / workspace.layout.columns);
    this.terminalGrid.style.gridTemplateColumns = `repeat(${workspace.layout.columns}, minmax(0, 1fr))`;
    this.terminalGrid.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  }

  createPaneSurface(descriptor) {
    const pane = this.document.createElement('section');
    pane.className = 'terminal-pane';
    pane.dataset.testid = `terminal-pane-${descriptor.paneId}`;

    const titleBar = this.document.createElement('div');
    titleBar.className = 'pane-title';
    const title = this.document.createElement('span');
    title.textContent = descriptor.title;
    title.dataset.testid = `pane-title-${descriptor.paneId}`;
    const status = this.document.createElement('span');
    status.id = `pane-status-${descriptor.paneId}`;
    status.className = 'pane-status';
    status.dataset.state = 'connecting';
    status.dataset.testid = `pane-status-${descriptor.paneId}`;
    status.textContent = 'Connecting';
    titleBar.append(title, status);

    const terminal = this.document.createElement('div');
    terminal.id = descriptor.terminalElementId;
    terminal.className = 'terminal';
    terminal.dataset.testid = `terminal-${descriptor.paneId}`;
    pane.append(titleBar, terminal);
    this.terminalGrid.append(pane);
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
      activationMode: this.discoveredSessionIds.has(descriptor.sessionId) ? 'attach' : 'start',
      endpoint: this.config.endpoint,
      capabilityToken: this.config.capabilityToken,
      launchProfile: descriptor.launchProfile,
      terminalAppearance: this.config.terminal,
      container,
      statusElement: this.document.getElementById(`pane-status-${descriptor.paneId}`),
      sessionModel: this.sessionModel,
      setStatus: (text) => this.setStatus(text),
      onLifecycleChange: (lifecycle, error) => {
        this.recordWorkspaceSessionState(descriptor.sessionId, lifecycle, error);
      },
    });
    this.panes.push(pane);
    pane.start();
  }

  killDetachedSession(sessionId) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        client.close();
        resolve();
      };
      const timeoutHandle = setTimeout(finish, CONTROL_OPERATION_TIMEOUT_MS);
      const client = new HubClient({
        endpoint: this.config.endpoint,
        capabilityToken: this.config.capabilityToken,
        sessionId,
        onOpen: () => {
          if (!client.kill()) finish();
        },
        onMessage: (message) => {
          if ((message.type === 'killed' && message.session_id === sessionId)
              || (message.type === 'error' && (!message.session_id || message.session_id === sessionId))) {
            finish();
          }
        },
        onInvalidMessage: finish,
        onClose: finish,
        onError: () => {},
      });
      client.connect();
    });
  }

  prepareToClose() {
    if (this.closePromise) {
      return this.closePromise;
    }

    this.closed = true;
    this.sessionDiscoveryClient?.close();
    this.closePromise = (async () => {
      await this.switchPromise;
      if (this.config.persistencePolicy === 'kill') {
        for (const pane of this.panes) {
          pane.close();
        }
        await Promise.all([...this.visitedSessionIds].map((sessionId) => this.killDetachedSession(sessionId)));
        for (const pane of this.panes) {
          pane.dispose();
        }
      } else {
        await Promise.all(this.panes.map((pane) => pane.detachAndClose()));
      }
    })();
    return this.closePromise;
  }

  close() {
    this.closed = true;
    this.sessionDiscoveryClient?.close();
    for (const pane of this.panes) {
      pane.dispose();
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
  CONTROL_OPERATION_TIMEOUT_MS,
  STARTUP_SESSION_LIST_TIMEOUT_MS,
  NeonCodeApp,
  createAppConfig,
  createSessionId,
  createWorkspaceDescriptors,
  startRendererApp,
};

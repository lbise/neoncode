import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');

import {
  ConfigStore,
  applyEnvironmentOverrides,
  defaultConfig,
  defaultState,
  validateConfig,
  validateState,
} from '../config-store';
import {
  seedWorkspaceLayout,
  type LayoutNode,
  type WorkspaceLayoutState,
} from '../shared/layout-model';
import type {
  DesktopBootstrapResult,
  DesktopConfig,
  DesktopSessionConfig,
  DesktopState,
  DesktopWorkspaceConfig,
  TerminalAppearance,
} from '../shared/types';

interface SchemaTwoTerminalFixture {
  fontFamily: string;
  fontSize: number;
  cursorBlink: boolean;
  theme: {
    background: string;
    foreground: string;
    cursor: string;
    selectionBackground: string;
    ansi: string[];
  };
}

interface LegacyConfigFixture {
  schemaVersion: number;
  hub: DesktopConfig['hub'];
  sessionPrefix: string;
  persistence: Pick<DesktopConfig['persistence'], 'onWindowClose'> & Partial<DesktopConfig['persistence']>;
  terminal?: TerminalAppearance | SchemaTwoTerminalFixture;
  launchProfiles: DesktopConfig['launchProfiles'];
  sessions: DesktopSessionConfig[];
  workspaces?: DesktopWorkspaceConfig[];
}

function withStore<T>(run: (store: ConfigStore, directory: string) => T): T {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neoncode-config-test-'));
  try {
    return run(new ConfigStore(directory), directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function workspaceAt(config: DesktopConfig, index = 0): DesktopWorkspaceConfig {
  return config.workspaces[index]!;
}

function loadedConfig(result: DesktopBootstrapResult): DesktopConfig {
  return result.config!;
}

function sessionAt(workspace: DesktopWorkspaceConfig, index = 0): DesktopSessionConfig {
  return workspace.sessions[index]!;
}

function workspaceLayout(
  workspace = workspaceAt(defaultConfig()),
  prefix = workspace.id,
): WorkspaceLayoutState {
  return seedWorkspaceLayout(workspace, {
    tabId: `${prefix}-tab`,
    paneIds: workspace.sessions.map((session) => `${prefix}-pane-${session.id}`),
    splitIds: workspace.sessions.slice(1).map((_session, index) => `${prefix}-split-${index}`),
  });
}

function nestedWorkspaceLayout(depth: number): WorkspaceLayoutState {
  let root: LayoutNode = {
    type: 'pane',
    paneId: `depth-pane-${depth}`,
    sessionKey: `depth-session-${depth}`,
  };
  for (let index = depth - 1; index >= 1; index -= 1) {
    root = {
      type: 'split',
      splitId: `depth-split-${index}`,
      direction: 'vertical',
      ratio: 0.5,
      first: {
        type: 'pane',
        paneId: `depth-pane-${index}`,
        sessionKey: `depth-session-${index}`,
      },
      second: root,
    };
  }
  return {
    activeTabId: 'depth-tab',
    tabs: [{
      tabId: 'depth-tab',
      title: 'Depth',
      root,
      focusedPaneId: 'depth-pane-1',
    }],
  };
}

function schemaThreeConfig(): LegacyConfigFixture {
  const current = defaultConfig();
  const workspace = workspaceAt(current);
  const { workspaces, keybindings, ...legacy } = current;
  void workspaces;
  void keybindings;
  return {
    ...legacy,
    schemaVersion: 3,
    persistence: { onWindowClose: current.persistence.onWindowClose },
    sessions: workspace.sessions,
  };
}

function testFirstRunCreation() {
  withStore((store) => {
    const result = store.load({});
    assert.equal(result.diagnostics.configStatus, 'created');
    assert.equal(result.diagnostics.stateStatus, 'created');
    assert.deepEqual(result.config, defaultConfig());
    assert.equal(result.config?.persistence.confirmBeforeClosingTab, false);
    assert.equal(result.config?.persistence.confirmBeforeClosingTerminal, false);
    assert.deepEqual(readJson<DesktopConfig>(store.configPath), defaultConfig());
    assert.deepEqual(readJson<DesktopConfig>(store.configBackupPath), defaultConfig());
    assert.equal(result.diagnostics.errors.length, 0);
  });
}

function testEnvironmentOverridesAreNotPersisted() {
  withStore((store) => {
    store.load({});
    const result = store.load({
      NEONCODE_HUB_ENDPOINT: 'ws://127.0.0.1:45555/ws',
      NEONCODE_SESSION_PREFIX: 'override-prefix',
      NEONCODE_TERMINAL_COUNT: '1',
      NEONCODE_PERSIST_SESSIONS: '0',
    });
    assert.equal(loadedConfig(result).hub.endpoint, 'ws://127.0.0.1:45555/ws');
    assert.equal(loadedConfig(result).sessionPrefix, 'override-prefix');
    assert.equal(workspaceAt(loadedConfig(result)).sessions.length, 1);
    assert.equal(loadedConfig(result).persistence.onWindowClose, 'kill');

    const persisted = readJson<DesktopConfig>(store.configPath);
    assert.equal(persisted.hub.endpoint, 'ws://127.0.0.1:44777/ws');
    assert.equal(workspaceAt(persisted).sessions.length, 2);
    assert.equal(persisted.persistence.onWindowClose, 'detach');
  });
}

function testUnversionedTerminalConfigMigration() {
  withStore((store, directory) => {
    fs.mkdirSync(store.directory, { recursive: true });
    const legacy = {
      terminal: {
        fontFace: 'FiraCode Nerd Font Mono',
        fontSize: 14,
        background: '#0C0C0C',
      },
    };
    fs.writeFileSync(store.configPath, `${JSON.stringify(legacy)}\n`);

    const result = store.load({});
    assert.equal(result.diagnostics.configStatus, 'migrated');
    assert.equal(loadedConfig(result).terminal.fontFamily, 'FiraCode Nerd Font Mono');
    assert.equal(loadedConfig(result).terminal.theme.background, '#0c0c0c');
    assert.equal(readJson<DesktopConfig>(store.configPath).schemaVersion, 7);
    assert(result.diagnostics.warnings.some((warning) => warning.includes('were imported')));
    const preserved = fs.readdirSync(directory)
      .find((name) => name.startsWith('config.json.pre-migration-'));
    assert(preserved, 'legacy terminal config was not preserved');
    assert.deepEqual(readJson<unknown>(path.join(directory, preserved)), legacy);
  });
}

function testSchemaTwoColorArrayMigration() {
  withStore((store) => {
    fs.mkdirSync(store.directory, { recursive: true });
    const schemaTwo = schemaThreeConfig();
    const terminal = schemaTwo.terminal as TerminalAppearance;
    const named = terminal.theme;
    schemaTwo.schemaVersion = 2;
    schemaTwo.terminal = {
      ...terminal,
      theme: {
        background: named.background,
        foreground: named.foreground,
        cursor: named.cursorColor,
        selectionBackground: named.selectionBackground,
        ansi: [
          named.black, named.red, named.green, named.yellow,
          named.blue, named.purple, named.cyan, named.white,
          named.brightBlack, named.brightRed, named.brightGreen, named.brightYellow,
          named.brightBlue, named.brightPurple, named.brightCyan, named.brightWhite,
        ],
      },
    };
    fs.writeFileSync(store.configPath, `${JSON.stringify(schemaTwo)}\n`);

    const result = store.load({});
    assert.equal(loadedConfig(result).schemaVersion, 7);
    assert.equal(loadedConfig(result).terminal.theme.purple, named.purple);
    assert.equal(loadedConfig(result).terminal.theme.brightPurple, named.brightPurple);
    assert.equal(loadedConfig(result).terminal.theme.name, 'NeonCode Default');
    assert.equal(Object.hasOwn(loadedConfig(result).terminal.theme, 'ansi'), false);
  });
}

function testSchemaOneImportsPreservedLegacyAppearance() {
  withStore((store) => {
    fs.mkdirSync(store.directory, { recursive: true });
    const schemaOne = schemaThreeConfig();
    schemaOne.schemaVersion = 1;
    schemaOne.sessions[0]!.title = 'Keep Me';
    delete schemaOne.terminal;
    fs.writeFileSync(store.configPath, `${JSON.stringify(schemaOne)}\n`);
    fs.writeFileSync(`${store.configPath}.pre-migration-100`, JSON.stringify({
      terminal: { fontFace: 'Legacy Font', fontSize: 17, background: '#112233' },
    }));

    const result = store.load({});
    assert.equal(loadedConfig(result).schemaVersion, 7);
    assert.equal(sessionAt(workspaceAt(loadedConfig(result))).title, 'Keep Me');
    assert.equal(loadedConfig(result).terminal.fontFamily, 'Legacy Font');
    assert.equal(loadedConfig(result).terminal.fontSize, 17);
    assert.equal(loadedConfig(result).terminal.theme.background, '#112233');
  });
}

function testLegacyMigration() {
  withStore((store) => {
    fs.mkdirSync(store.directory, { recursive: true });
    fs.writeFileSync(store.configPath, JSON.stringify({
      schemaVersion: 0,
      endpoint: 'ws://127.0.0.1:45000/ws',
      persistSessions: false,
      sessionPrefix: 'legacy',
      terminalCount: 1,
    }));
    const result = store.load({});
    assert.equal(result.diagnostics.configStatus, 'migrated');
    assert.equal(loadedConfig(result).schemaVersion, 7);
    assert.equal(loadedConfig(result).hub.endpoint, 'ws://127.0.0.1:45000/ws');
    assert.equal(loadedConfig(result).persistence.onWindowClose, 'kill');
    assert.equal(loadedConfig(result).persistence.confirmBeforeClosingTab, false);
    assert.equal(loadedConfig(result).persistence.confirmBeforeClosingTerminal, false);
    assert.equal(workspaceAt(loadedConfig(result)).sessions.length, 1);
    assert.equal(readJson<DesktopConfig>(store.configPath).schemaVersion, 7);
  });
}

function testInvalidPrimaryRecoversBackup() {
  withStore((store, directory) => {
    store.load({});
    const backup = defaultConfig();
    sessionAt(workspaceAt(backup)).title = 'Recovered Shell';
    fs.writeFileSync(store.configBackupPath, `${JSON.stringify(backup)}\n`);
    fs.writeFileSync(store.configPath, '{ invalid json');

    const result = store.load({});
    assert.equal(result.diagnostics.configStatus, 'recovered');
    assert.equal(sessionAt(workspaceAt(loadedConfig(result))).title, 'Recovered Shell');
    assert(result.diagnostics.warnings.some((warning) => warning.includes('preserved')));
    assert(fs.readdirSync(directory).some((name) => name.startsWith('config.json.invalid-')));
  });
}

function testMissingPrimaryWithUnusableBackupIsFatal() {
  withStore((store) => {
    fs.mkdirSync(store.directory, { recursive: true });
    fs.writeFileSync(store.configBackupPath, '{ malformed backup');
    const result = store.load({});
    assert.equal(result.config, null);
    assert.equal(result.diagnostics.configStatus, 'error');
    assert(result.diagnostics.errors[0]!.includes('config.json is missing'));
    assert.equal(fs.existsSync(store.configPath), false);
    assert.equal(fs.readFileSync(store.configBackupPath, 'utf8'), '{ malformed backup');
  });
}

function testBackupWriteFailureKeepsValidatedPrimary() {
  withStore((store, directory) => {
    store.load({});
    const edited = defaultConfig();
    sessionAt(workspaceAt(edited)).title = 'Still Valid';
    fs.writeFileSync(store.configPath, `${JSON.stringify(edited)}\n`);

    const mutableFs = fs as { renameSync: typeof fs.renameSync };
    const originalRename = mutableFs.renameSync;
    mutableFs.renameSync = (source, destination) => {
      if (destination.toString().endsWith('.bak')) {
        const error = new Error('injected backup sharing failure') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return originalRename(source, destination);
    };
    let result: DesktopBootstrapResult;
    try {
      result = store.load({});
    } finally {
      mutableFs.renameSync = originalRename;
    }

    assert.equal(sessionAt(workspaceAt(loadedConfig(result))).title, 'Still Valid');
    assert.equal(result.diagnostics.configStatus, 'loaded');
    assert(result.diagnostics.warnings.some((warning) => warning.includes('could not be refreshed')));
    assert(!fs.readdirSync(directory).some((name) => name.startsWith('config.json.invalid-')));
  });
}

function testFutureSchemaIsPreservedAndFatal() {
  withStore((store) => {
    store.load({});
    fs.writeFileSync(store.configPath, `${JSON.stringify({ schemaVersion: 99 })}\n`);
    const result = store.load({});
    assert.equal(result.config, null);
    assert.equal(result.diagnostics.configStatus, 'error');
    assert(result.diagnostics.errors[0]!.includes('newer than supported'));
    assert.equal(readJson<{ schemaVersion: number }>(store.configPath).schemaVersion, 99);
  });
}

function testSchemaFourKeybindingMigration() {
  withStore((store, directory) => {
    fs.mkdirSync(directory, { recursive: true });
    const current = defaultConfig();
    const { keybindings, ...schemaFourConfig } = current;
    const schemaFour: Record<string, unknown> = {
      ...schemaFourConfig,
      persistence: { onWindowClose: current.persistence.onWindowClose },
    };
    void keybindings;
    schemaFour.workspaces = current.workspaces.map((workspace) => {
      const { path: workspacePath, defaultLaunchProfile, ...legacyWorkspace } = workspace;
      void workspacePath;
      void defaultLaunchProfile;
      return legacyWorkspace as DesktopWorkspaceConfig;
    });
    fs.writeFileSync(store.configPath, `${JSON.stringify({ ...schemaFour, schemaVersion: 4 })}\n`);
    const result = store.load({});
    assert.equal(result.diagnostics.configStatus, 'migrated');
    assert.equal(loadedConfig(result).schemaVersion, 7);
    assert.deepEqual(loadedConfig(result).keybindings, { overrides: [] });
    assert.equal(readJson<DesktopConfig>(store.configPath).schemaVersion, 7);
    assert(fs.readdirSync(directory).some((name) => name.startsWith('config.json.pre-migration-')));
  });
}

function testSettingsSaveMergesStoredConfigAndBacksUp() {
  withStore((store) => {
    const created = loadedConfig(store.load({}));
    const previous = structuredClone(created);
    previous.launchProfiles['preserved-profile'] = {
      type: 'process', command: 'bash', args: ['-l'], cwd: '/tmp',
    };
    previous.workspaces[0]!.sessions[0]!.title = 'Preserved Workspace';
    fs.writeFileSync(store.configPath, `${JSON.stringify(previous)}\n`);

    const effective = store.load({
      NEONCODE_HUB_ENDPOINT: 'ws://127.0.0.1:45555/ws',
      NEONCODE_SESSION_PREFIX: 'environment-prefix',
    });
    assert.equal(loadedConfig(effective).sessionPrefix, 'environment-prefix');
    const settings = store.getStoredSettings();
    assert.equal(settings.sessionPrefix, created.sessionPrefix);
    settings.sessionPrefix = 'saved-prefix';
    settings.terminal.fontSize = 18;
    settings.keybindings.overrides = [{
      command: { id: 'settings.open' },
      binding: {
        code: 'F8', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
      },
    }];
    const saved = store.saveSettings(settings);
    assert.equal(saved.sessionPrefix, 'saved-prefix');
    assert.equal(saved.terminal.fontSize, 18);
    assert.deepEqual(saved.launchProfiles, previous.launchProfiles);
    assert.deepEqual(saved.workspaces, previous.workspaces);
    assert.equal(readJson<DesktopConfig>(store.configBackupPath).sessionPrefix, created.sessionPrefix);
    assert.deepEqual(readJson<DesktopConfig>(store.configPath), saved);
  });
}

function testSettingsSaveValidationAndAtomicFailure() {
  withStore((store, directory) => {
    const previous = loadedConfig(store.load({}));
    const unknown = store.getStoredSettings() as ReturnType<ConfigStore['getStoredSettings']> & {
      unexpected?: boolean;
    };
    unknown.unexpected = true;
    assert.throws(() => store.saveSettings(unknown), /settings keys must be exactly/u);

    const conflicting = store.getStoredSettings();
    conflicting.keybindings.overrides = [{
      command: { id: 'settings.open' },
      binding: {
        code: 'F6', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
      },
    }];
    assert.throws(() => store.saveSettings(conflicting), /conflicts/u);
    assert.deepEqual(readJson<DesktopConfig>(store.configPath), previous);

    const replacement = store.getStoredSettings();
    replacement.sessionPrefix = 'atomic-replacement';
    const mutableFs = fs as { renameSync: typeof fs.renameSync };
    const originalRename = mutableFs.renameSync;
    mutableFs.renameSync = (source, destination) => {
      if (destination.toString() === store.configPath) {
        throw new Error('injected settings save failure');
      }
      return originalRename(source, destination);
    };
    try {
      assert.throws(() => store.saveSettings(replacement), /injected settings save failure/u);
    } finally {
      mutableFs.renameSync = originalRename;
    }
    assert.deepEqual(readJson<DesktopConfig>(store.configPath), previous);
    assert.deepEqual(readJson<DesktopConfig>(store.configBackupPath), previous);
    assert(!fs.readdirSync(directory).some((name) => name.startsWith('.config.json.tmp-')));
  });
}

function schemaFiveConfig(config = defaultConfig()): unknown {
  return {
    ...config,
    schemaVersion: 5,
    persistence: { onWindowClose: config.persistence.onWindowClose },
    workspaces: config.workspaces.map((workspace) => {
      const { path: workspacePath, defaultLaunchProfile, ...legacy } = workspace;
      void workspacePath;
      void defaultLaunchProfile;
      return legacy;
    }),
  };
}

function testSchemaFiveWorkspaceMigration() {
  const config = defaultConfig();
  config.launchProfiles.first = {
    type: 'process', command: 'bash', args: [], cwd: '/home/me/project',
  };
  config.launchProfiles.second = {
    type: 'process', command: 'bash', args: ['-l'], cwd: '/home/me/project',
  };
  const workspace = workspaceAt(config);
  workspace.id = 'preserved-id';
  workspace.name = 'Preserved Name';
  workspace.layout.columns = 2;
  workspace.sessions[0]!.launchProfile = 'first';
  workspace.sessions[1]!.launchProfile = 'second';
  const migrated = validateConfig(schemaFiveConfig(config));
  assert.equal(migrated.migrationSource, 'schema_5');
  assert.equal(migrated.value.schemaVersion, 7);
  assert.equal(workspaceAt(migrated.value).id, 'preserved-id');
  assert.equal(workspaceAt(migrated.value).name, 'Preserved Name');
  assert.equal(workspaceAt(migrated.value).defaultLaunchProfile, 'first');
  assert.equal(workspaceAt(migrated.value).path, '/home/me/project');
  assert.deepEqual(workspaceAt(migrated.value).sessions, workspace.sessions);

  config.launchProfiles.second!.cwd = '/home/me/other';
  const mixed = validateConfig(schemaFiveConfig(config)).value;
  assert.equal(workspaceAt(mixed).path, null);
}

function testSchemaSixWorkspacePathAndDefaultProfileValidation() {
  const unknownDefault = defaultConfig();
  workspaceAt(unknownDefault).defaultLaunchProfile = 'missing';
  assert.throws(() => validateConfig(unknownDefault), /unknown default launch profile/u);

  for (const badPath of ['', 'bad\0path', 'bad\npath', 'é'.repeat(2049)]) {
    const malformed = defaultConfig();
    workspaceAt(malformed).path = badPath;
    assert.throws(() => validateConfig(malformed), /path/u);
  }

  const unexpected = structuredClone(workspaceAt(defaultConfig())) as DesktopWorkspaceConfig & {
    unexpected?: boolean;
  };
  unexpected.unexpected = true;
  const malformed = defaultConfig();
  malformed.workspaces = [unexpected];
  assert.throws(() => validateConfig(malformed), /keys must be exactly/u);
}

function testWorkspaceCatalogSavePreservesConfigAndRemovesDeletedTargets() {
  withStore((store) => {
    const previous = loadedConfig(store.load({}));
    previous.hub.endpoint = 'ws://127.0.0.1:45555/ws';
    previous.terminal.fontSize = 19;
    previous.launchProfiles.preserved = {
      type: 'process', command: 'bash', args: ['-l'], cwd: '/tmp/preserved',
    };
    previous.workspaces.push({
      id: 'delete-me',
      name: 'Delete Me',
      path: '/tmp/preserved',
      defaultLaunchProfile: 'preserved',
      layout: { columns: 1 },
      sessions: [{ id: 'delete-shell', title: 'Delete Shell', launchProfile: 'preserved' }],
    });
    previous.keybindings.overrides = [
      {
        command: { id: 'workspace.open', args: { workspaceId: 'delete-me' } },
        binding: { code: 'F8', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false },
      },
      {
        command: { id: 'pane.focus', args: { paneId: 'delete-shell' } },
        binding: { code: 'F9', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false },
      },
    ];
    fs.writeFileSync(store.configPath, `${JSON.stringify(previous)}\n`);

    const catalog = store.getStoredWorkspaces().filter((workspace) => workspace.id !== 'delete-me');
    catalog[0]!.name = 'Renamed';
    const saved = store.saveWorkspaceCatalog(catalog);
    assert.equal(saved.hub.endpoint, previous.hub.endpoint);
    assert.equal(saved.terminal.fontSize, 19);
    assert.deepEqual(saved.launchProfiles, previous.launchProfiles);
    assert.equal(workspaceAt(saved).name, 'Renamed');
    assert.deepEqual(saved.keybindings.overrides, []);
    assert.deepEqual(readJson<DesktopConfig>(store.configBackupPath), previous);
    assert.deepEqual(readJson<DesktopConfig>(store.configPath), saved);
  });
}

function testWorkspaceCatalogBackupFailurePreservesPrimary() {
  withStore((store) => {
    const previous = loadedConfig(store.load({}));
    const replacement = store.getStoredWorkspaces();
    replacement[0]!.name = 'Not Saved';
    const mutableFs = fs as { renameSync: typeof fs.renameSync };
    const originalRename = mutableFs.renameSync;
    mutableFs.renameSync = (source, destination) => {
      if (destination.toString() === store.configBackupPath) {
        throw new Error('injected catalog backup failure');
      }
      return originalRename(source, destination);
    };
    try {
      assert.throws(
        () => store.saveWorkspaceCatalog(replacement),
        /injected catalog backup failure/u,
      );
    } finally {
      mutableFs.renameSync = originalRename;
    }
    assert.deepEqual(readJson<DesktopConfig>(store.configPath), previous);
  });
}

function testStaleTargetKeybindingsAreToleratedAtLoad() {
  const config = defaultConfig();
  config.keybindings.overrides = [{
    command: { id: 'workspace.open', args: { workspaceId: 'deleted-workspace' } },
    binding: { code: 'F8', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false },
  }];
  assert.deepEqual(validateConfig(config).value.keybindings, config.keybindings);
}

function testSchemaThreeWorkspaceMigration() {
  const legacy = schemaThreeConfig();
  legacy.sessions[0]!.title = 'Migrated Shell';
  const result = validateConfig(legacy);
  assert.equal(result.value.schemaVersion, 7);
  assert.equal(workspaceAt(result.value).id, 'default');
  assert.equal(workspaceAt(result.value).layout.columns, 2);
  assert.equal(sessionAt(workspaceAt(result.value)).title, 'Migrated Shell');
  assert.equal(result.migrationSource, 'schema_3');
}

function testWorkspaceValidationAndEightPanes() {
  const config = defaultConfig();
  config.workspaces.push({
    id: 'project',
    name: 'Project',
    path: '/tmp/project',
    defaultLaunchProfile: 'default-shell',
    layout: { columns: 4 },
    sessions: Array.from({ length: 8 }, (_, index) => ({
      id: `project-${index + 1}`,
      title: `Project ${index + 1}`,
      launchProfile: 'default-shell',
    })),
  });
  const validated = validateConfig(config).value;
  assert.equal(workspaceAt(validated, 1).sessions.length, 8);
  assert.equal(workspaceAt(validated, 1).layout.columns, 4);

  const badColumns = structuredClone(config);
  workspaceAt(badColumns, 1).layout.columns = 9;
  assert.throws(() => validateConfig(badColumns), /layout\.columns/);

  const duplicateWorkspace = structuredClone(config);
  workspaceAt(duplicateWorkspace, 1).id = 'default';
  assert.throws(() => validateConfig(duplicateWorkspace), /duplicate workspace id/);

  const duplicateSession = structuredClone(config);
  sessionAt(workspaceAt(duplicateSession, 1)).id = 'shell';
  assert.throws(() => validateConfig(duplicateSession), /duplicate session id across workspaces/);

  const tooManySessions = defaultConfig();
  tooManySessions.workspaces = Array.from({ length: 9 }, (_, workspaceIndex) => ({
    id: `workspace-${workspaceIndex}`,
    name: `Workspace ${workspaceIndex}`,
    path: null,
    defaultLaunchProfile: 'default-shell',
    layout: { columns: 4 },
    sessions: Array.from({ length: 8 }, (_, sessionIndex) => ({
      id: `workspace-${workspaceIndex}-session-${sessionIndex}`,
      title: `Session ${sessionIndex}`,
      launchProfile: 'default-shell',
    })),
  }));
  assert.throws(() => validateConfig(tooManySessions), /at most 64 sessions/);
}

function testStateSchemaOneMigration() {
  withStore((store) => {
    store.load({});
    fs.writeFileSync(store.statePath, JSON.stringify({
      schemaVersion: 1,
      window: { width: 1000, height: 700 },
    }));
    const result = store.load({});
    assert.equal(result.diagnostics.stateStatus, 'migrated');
    assert.equal(result.state.schemaVersion, 3);
    assert.equal(result.state.activeWorkspaceId, null);
    assert.deepEqual(result.state.workspaceLayouts, {});
    assert.equal(readJson<DesktopState>(store.statePath).schemaVersion, 3);
  });
}

function testStateSchemaTwoMigrationIsLossless() {
  withStore((store) => {
    store.load({});
    fs.writeFileSync(store.statePath, JSON.stringify({
      schemaVersion: 2,
      window: { width: 1111, height: 777 },
      activeWorkspaceId: 'default',
    }));
    const result = store.load({});
    assert.equal(result.diagnostics.stateStatus, 'migrated');
    assert.deepEqual(result.state, {
      schemaVersion: 3,
      window: { width: 1111, height: 777 },
      activeWorkspaceId: 'default',
      workspaceLayouts: {},
    });
    assert.deepEqual(readJson<DesktopState>(store.statePath), result.state);
  });
}

function testWorkspaceLayoutStateRoundTrip() {
  withStore((store) => {
    store.load({});
    const layout = workspaceLayout();
    const saved = store.saveState({
      schemaVersion: 3,
      window: { width: 1400, height: 900 },
      activeWorkspaceId: 'default',
      workspaceLayouts: { default: layout },
    });
    assert.deepEqual(saved.workspaceLayouts.default, layout);
    assert.notEqual(saved.workspaceLayouts.default, layout);
    assert.deepEqual(readJson<DesktopState>(store.statePath), saved);

    const reloaded = store.load({});
    assert.equal(reloaded.diagnostics.stateStatus, 'loaded');
    assert.deepEqual(reloaded.state, saved);
    assert.deepEqual(readJson<DesktopState>(store.stateBackupPath), saved);
  });
}

function testWorkspaceLayoutStateValidationLimits() {
  const base = defaultState();
  const layout = workspaceLayout();

  const malformed = structuredClone(layout) as WorkspaceLayoutState & { unexpected?: boolean };
  malformed.unexpected = true;
  assert.throws(
    () => validateState({ ...base, workspaceLayouts: { default: malformed } }),
    /keys must be exactly/,
  );

  const duplicate = structuredClone(layout);
  const root = duplicate.tabs[0]?.root;
  assert(root?.type === 'split');
  assert(root.first.type === 'pane');
  assert(root.second.type === 'pane');
  root.second.paneId = root.first.paneId;
  assert.throws(
    () => validateState({ ...base, workspaceLayouts: { default: duplicate } }),
    /duplicate layout id/,
  );

  assert.throws(
    () => validateState({ ...base, workspaceLayouts: { default: nestedWorkspaceLayout(9) } }),
    /depth may not exceed 8/,
  );

  const tooManyWorkspaces = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [
    `workspace-${index}`,
    workspaceLayout(undefined, `entry-${index}`),
  ]));
  assert.throws(
    () => validateState({ ...base, workspaceLayouts: tooManyWorkspaces }),
    /at most 16 workspaces/,
  );

  const eightPaneLayout = (prefix: string): WorkspaceLayoutState => seedWorkspaceLayout({
    name: prefix,
    layout: { columns: 2 },
    sessions: Array.from({ length: 8 }, (_, index) => ({
      id: `${prefix}-session-${index}`,
      title: `Pane ${index}`,
    })),
  }, {
    tabId: `${prefix}-tab`,
    paneIds: Array.from({ length: 8 }, (_, index) => `${prefix}-pane-${index}`),
    splitIds: Array.from({ length: 7 }, (_, index) => `${prefix}-split-${index}`),
  });
  const tooManyLeaves = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [
    `workspace-${index}`,
    eightPaneLayout(`leaves-${index}`),
  ]));
  assert.throws(
    () => validateState({ ...base, workspaceLayouts: tooManyLeaves }),
    /at most 64 panes in total/,
  );

  assert.throws(
    () => validateState({ ...base, padding: 'x'.repeat(70 * 1024) }),
    /exceeds 65536 bytes/,
  );
  assert.throws(
    () => validateState({ ...base, schemaVersion: 99 }),
    /newer than supported/,
  );
}

function testFutureStateRecoversBackupAndIsPreserved() {
  withStore((store, directory) => {
    store.load({});
    const backup = {
      ...defaultState(),
      activeWorkspaceId: 'default',
      workspaceLayouts: { default: workspaceLayout() },
    };
    fs.writeFileSync(store.stateBackupPath, `${JSON.stringify(backup)}\n`);
    fs.writeFileSync(store.statePath, `${JSON.stringify({ ...backup, schemaVersion: 99 })}\n`);

    const result = store.load({});
    assert.equal(result.diagnostics.stateStatus, 'recovered');
    assert.deepEqual(result.state, backup);
    const preservedName = fs.readdirSync(directory)
      .find((name) => name.startsWith('state.json.invalid-'));
    assert(preservedName);
    assert.equal(readJson<DesktopState & { schemaVersion: 99 }>(
      path.join(directory, preservedName),
    ).schemaVersion, 99);
  });
}

function testInjectedStateSaveFailureIsAtomic() {
  withStore((store, directory) => {
    store.load({});
    const previous = store.saveState({
      ...defaultState(),
      activeWorkspaceId: 'default',
      workspaceLayouts: { default: workspaceLayout() },
    });
    const replacement = {
      ...previous,
      window: { width: 1600, height: 1000 },
    };

    const mutableFs = fs as { renameSync: typeof fs.renameSync };
    const originalRename = mutableFs.renameSync;
    mutableFs.renameSync = (source, destination) => {
      if (destination.toString() === store.statePath) {
        const error = new Error('injected state save failure') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return originalRename(source, destination);
    };
    try {
      assert.throws(() => store.saveState(replacement), /injected state save failure/);
    } finally {
      mutableFs.renameSync = originalRename;
    }

    assert.deepEqual(readJson<DesktopState>(store.statePath), previous);
    assert.deepEqual(readJson<DesktopState>(store.stateBackupPath), previous);
    assert(!fs.readdirSync(directory).some((name) => name.startsWith('.state.json.tmp-')));
  });
}

function testStrictValidation() {
  const legacyUnknownKey = schemaThreeConfig();
  legacyUnknownKey.workspaces = [];
  assert.throws(() => validateConfig(legacyUnknownKey), /keys must be exactly/);

  const unknownKey = defaultConfig() as DesktopConfig & { unexpected?: boolean };
  unknownKey.unexpected = true;
  assert.throws(() => validateConfig(unknownKey), /keys must be exactly/);

  const remoteEndpoint = defaultConfig();
  remoteEndpoint.hub.endpoint = 'ws://192.168.1.2:44777/ws';
  assert.throws(() => validateConfig(remoteEndpoint), /127\.0\.0\.1/);

  const duplicate = defaultConfig();
  sessionAt(workspaceAt(duplicate), 1).id = sessionAt(workspaceAt(duplicate)).id;
  assert.throws(() => validateConfig(duplicate), /duplicate session id/);

  assert.throws(
    () => applyEnvironmentOverrides(defaultConfig(), { NEONCODE_TERMINAL_COUNT: '9' }),
    /between 1 and 8/,
  );

  const processLikeEnvironment = Object.create({ inherited: true }) as NodeJS.ProcessEnv;
  processLikeEnvironment.NEONCODE_HUB_ENDPOINT = 'ws://127.0.0.1:44999/ws';
  assert.equal(
    applyEnvironmentOverrides(defaultConfig(), processLikeEnvironment).hub.endpoint,
    'ws://127.0.0.1:44999/ws',
  );
}

function testStateClampAndPersistence() {
  withStore((store) => {
    store.load({});
    const saved = store.saveState({
      schemaVersion: 3,
      window: { width: 300, height: 200 },
      activeWorkspaceId: 'default',
      workspaceLayouts: {},
    });
    assert.deepEqual(saved.window, { width: 800, height: 600 });
    assert.equal(saved.activeWorkspaceId, 'default');
    const reloaded = store.load({});
    assert.deepEqual(reloaded.state.window, { width: 800, height: 600 });
    assert.deepEqual(validateState(readJson<DesktopState>(store.statePath)), reloaded.state);
    assert.throws(
      () => validateState({ ...saved, activeWorkspaceId: 'invalid workspace' }),
      /only ASCII letters/,
    );
  });
}

function testStaleTemporaryCleanup() {
  withStore((store) => {
    fs.mkdirSync(store.directory, { recursive: true });
    const stale = path.join(store.directory, '.config.json.tmp-stale');
    fs.writeFileSync(stale, 'partial');
    store.load({});
    assert.equal(fs.existsSync(stale), false);
  });
}

for (const test of [
  testFirstRunCreation,
  testEnvironmentOverridesAreNotPersisted,
  testUnversionedTerminalConfigMigration,
  testSchemaTwoColorArrayMigration,
  testSchemaOneImportsPreservedLegacyAppearance,
  testLegacyMigration,
  testInvalidPrimaryRecoversBackup,
  testMissingPrimaryWithUnusableBackupIsFatal,
  testBackupWriteFailureKeepsValidatedPrimary,
  testFutureSchemaIsPreservedAndFatal,
  testSchemaFourKeybindingMigration,
  testSettingsSaveMergesStoredConfigAndBacksUp,
  testSettingsSaveValidationAndAtomicFailure,
  testSchemaFiveWorkspaceMigration,
  testSchemaSixWorkspacePathAndDefaultProfileValidation,
  testWorkspaceCatalogSavePreservesConfigAndRemovesDeletedTargets,
  testWorkspaceCatalogBackupFailurePreservesPrimary,
  testStaleTargetKeybindingsAreToleratedAtLoad,
  testSchemaThreeWorkspaceMigration,
  testWorkspaceValidationAndEightPanes,
  testStateSchemaOneMigration,
  testStateSchemaTwoMigrationIsLossless,
  testWorkspaceLayoutStateRoundTrip,
  testWorkspaceLayoutStateValidationLimits,
  testFutureStateRecoversBackupAndIsPreserved,
  testInjectedStateSaveFailureIsAtomic,
  testStrictValidation,
  testStateClampAndPersistence,
  testStaleTemporaryCleanup,
]) {
  test();
}

console.log('config-store tests passed');

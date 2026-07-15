const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ConfigStore,
  applyEnvironmentOverrides,
  defaultConfig,
  validateConfig,
  validateState,
} = require('../config-store');

function withStore(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neoncode-config-test-'));
  try {
    return run(new ConfigStore(directory), directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function schemaThreeConfig() {
  const current = defaultConfig();
  const [workspace] = current.workspaces;
  const { workspaces, ...legacy } = current;
  return { ...legacy, schemaVersion: 3, sessions: workspace.sessions };
}

function testFirstRunCreation() {
  withStore((store) => {
    const result = store.load({});
    assert.equal(result.diagnostics.configStatus, 'created');
    assert.equal(result.diagnostics.stateStatus, 'created');
    assert.deepEqual(result.config, defaultConfig());
    assert.deepEqual(readJson(store.configPath), defaultConfig());
    assert.deepEqual(readJson(store.configBackupPath), defaultConfig());
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
    assert.equal(result.config.hub.endpoint, 'ws://127.0.0.1:45555/ws');
    assert.equal(result.config.sessionPrefix, 'override-prefix');
    assert.equal(result.config.workspaces[0].sessions.length, 1);
    assert.equal(result.config.persistence.onWindowClose, 'kill');

    const persisted = readJson(store.configPath);
    assert.equal(persisted.hub.endpoint, 'ws://127.0.0.1:44777/ws');
    assert.equal(persisted.workspaces[0].sessions.length, 2);
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
    assert.equal(result.config.terminal.fontFamily, 'FiraCode Nerd Font Mono');
    assert.equal(result.config.terminal.theme.background, '#0c0c0c');
    assert.equal(readJson(store.configPath).schemaVersion, 4);
    assert(result.diagnostics.warnings.some((warning) => warning.includes('were imported')));
    const preserved = fs.readdirSync(directory)
      .find((name) => name.startsWith('config.json.pre-migration-'));
    assert(preserved, 'legacy terminal config was not preserved');
    assert.deepEqual(readJson(path.join(directory, preserved)), legacy);
  });
}

function testSchemaTwoColorArrayMigration() {
  withStore((store) => {
    fs.mkdirSync(store.directory, { recursive: true });
    const schemaTwo = schemaThreeConfig();
    const named = schemaTwo.terminal.theme;
    schemaTwo.schemaVersion = 2;
    schemaTwo.terminal.theme = {
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
    };
    fs.writeFileSync(store.configPath, `${JSON.stringify(schemaTwo)}\n`);

    const result = store.load({});
    assert.equal(result.config.schemaVersion, 4);
    assert.equal(result.config.terminal.theme.purple, named.purple);
    assert.equal(result.config.terminal.theme.brightPurple, named.brightPurple);
    assert.equal(result.config.terminal.theme.name, 'NeonCode Default');
    assert.equal(Object.hasOwn(result.config.terminal.theme, 'ansi'), false);
  });
}

function testSchemaOneImportsPreservedLegacyAppearance() {
  withStore((store) => {
    fs.mkdirSync(store.directory, { recursive: true });
    const schemaOne = schemaThreeConfig();
    schemaOne.schemaVersion = 1;
    schemaOne.sessions[0].title = 'Keep Me';
    delete schemaOne.terminal;
    fs.writeFileSync(store.configPath, `${JSON.stringify(schemaOne)}\n`);
    fs.writeFileSync(`${store.configPath}.pre-migration-100`, JSON.stringify({
      terminal: { fontFace: 'Legacy Font', fontSize: 17, background: '#112233' },
    }));

    const result = store.load({});
    assert.equal(result.config.schemaVersion, 4);
    assert.equal(result.config.workspaces[0].sessions[0].title, 'Keep Me');
    assert.equal(result.config.terminal.fontFamily, 'Legacy Font');
    assert.equal(result.config.terminal.fontSize, 17);
    assert.equal(result.config.terminal.theme.background, '#112233');
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
    assert.equal(result.config.schemaVersion, 4);
    assert.equal(result.config.hub.endpoint, 'ws://127.0.0.1:45000/ws');
    assert.equal(result.config.persistence.onWindowClose, 'kill');
    assert.equal(result.config.workspaces[0].sessions.length, 1);
    assert.equal(readJson(store.configPath).schemaVersion, 4);
  });
}

function testInvalidPrimaryRecoversBackup() {
  withStore((store, directory) => {
    store.load({});
    const backup = defaultConfig();
    backup.workspaces[0].sessions[0].title = 'Recovered Shell';
    fs.writeFileSync(store.configBackupPath, `${JSON.stringify(backup)}\n`);
    fs.writeFileSync(store.configPath, '{ invalid json');

    const result = store.load({});
    assert.equal(result.diagnostics.configStatus, 'recovered');
    assert.equal(result.config.workspaces[0].sessions[0].title, 'Recovered Shell');
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
    assert(result.diagnostics.errors[0].includes('config.json is missing'));
    assert.equal(fs.existsSync(store.configPath), false);
    assert.equal(fs.readFileSync(store.configBackupPath, 'utf8'), '{ malformed backup');
  });
}

function testBackupWriteFailureKeepsValidatedPrimary() {
  withStore((store, directory) => {
    store.load({});
    const edited = defaultConfig();
    edited.workspaces[0].sessions[0].title = 'Still Valid';
    fs.writeFileSync(store.configPath, `${JSON.stringify(edited)}\n`);

    const originalRename = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (destination.endsWith('.bak')) {
        const error = new Error('injected backup sharing failure');
        error.code = 'EPERM';
        throw error;
      }
      return originalRename(source, destination);
    };
    let result;
    try {
      result = store.load({});
    } finally {
      fs.renameSync = originalRename;
    }

    assert.equal(result.config.workspaces[0].sessions[0].title, 'Still Valid');
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
    assert(result.diagnostics.errors[0].includes('newer than supported'));
    assert.equal(readJson(store.configPath).schemaVersion, 99);
  });
}

function testSchemaThreeWorkspaceMigration() {
  const legacy = schemaThreeConfig();
  legacy.sessions[0].title = 'Migrated Shell';
  const result = validateConfig(legacy);
  assert.equal(result.value.schemaVersion, 4);
  assert.equal(result.value.workspaces[0].id, 'default');
  assert.equal(result.value.workspaces[0].layout.columns, 2);
  assert.equal(result.value.workspaces[0].sessions[0].title, 'Migrated Shell');
  assert.equal(result.migrationSource, 'schema_3');
}

function testWorkspaceValidationAndEightPanes() {
  const config = defaultConfig();
  config.workspaces.push({
    id: 'project',
    name: 'Project',
    layout: { columns: 4 },
    sessions: Array.from({ length: 8 }, (_, index) => ({
      id: `project-${index + 1}`,
      title: `Project ${index + 1}`,
      launchProfile: 'default-shell',
    })),
  });
  const validated = validateConfig(config).value;
  assert.equal(validated.workspaces[1].sessions.length, 8);
  assert.equal(validated.workspaces[1].layout.columns, 4);

  const badColumns = structuredClone(config);
  badColumns.workspaces[1].layout.columns = 9;
  assert.throws(() => validateConfig(badColumns), /layout\.columns/);

  const duplicateWorkspace = structuredClone(config);
  duplicateWorkspace.workspaces[1].id = 'default';
  assert.throws(() => validateConfig(duplicateWorkspace), /duplicate workspace id/);

  const duplicateSession = structuredClone(config);
  duplicateSession.workspaces[1].sessions[0].id = 'shell';
  assert.throws(() => validateConfig(duplicateSession), /duplicate session id across workspaces/);

  const tooManySessions = defaultConfig();
  tooManySessions.workspaces = Array.from({ length: 9 }, (_, workspaceIndex) => ({
    id: `workspace-${workspaceIndex}`,
    name: `Workspace ${workspaceIndex}`,
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
    assert.equal(result.state.schemaVersion, 2);
    assert.equal(result.state.activeWorkspaceId, null);
    assert.equal(readJson(store.statePath).schemaVersion, 2);
  });
}

function testStrictValidation() {
  const legacyUnknownKey = schemaThreeConfig();
  legacyUnknownKey.workspaces = [];
  assert.throws(() => validateConfig(legacyUnknownKey), /keys must be exactly/);

  const unknownKey = defaultConfig();
  unknownKey.unexpected = true;
  assert.throws(() => validateConfig(unknownKey), /keys must be exactly/);

  const remoteEndpoint = defaultConfig();
  remoteEndpoint.hub.endpoint = 'ws://192.168.1.2:44777/ws';
  assert.throws(() => validateConfig(remoteEndpoint), /127\.0\.0\.1/);

  const duplicate = defaultConfig();
  duplicate.workspaces[0].sessions[1].id = duplicate.workspaces[0].sessions[0].id;
  assert.throws(() => validateConfig(duplicate), /duplicate session id/);

  assert.throws(
    () => applyEnvironmentOverrides(defaultConfig(), { NEONCODE_TERMINAL_COUNT: '9' }),
    /between 1 and 8/,
  );

  const processLikeEnvironment = Object.create({ inherited: true });
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
      schemaVersion: 2,
      window: { width: 300, height: 200 },
      activeWorkspaceId: 'default',
    });
    assert.deepEqual(saved.window, { width: 800, height: 600 });
    assert.equal(saved.activeWorkspaceId, 'default');
    const reloaded = store.load({});
    assert.deepEqual(reloaded.state.window, { width: 800, height: 600 });
    assert.deepEqual(validateState(readJson(store.statePath)), reloaded.state);
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
  testSchemaThreeWorkspaceMigration,
  testWorkspaceValidationAndEightPanes,
  testStateSchemaOneMigration,
  testStrictValidation,
  testStateClampAndPersistence,
  testStaleTemporaryCleanup,
]) {
  test();
}

console.log('config-store tests passed');

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
    assert.equal(result.config.sessions.length, 1);
    assert.equal(result.config.persistence.onWindowClose, 'kill');

    const persisted = readJson(store.configPath);
    assert.equal(persisted.hub.endpoint, 'ws://127.0.0.1:44777/ws');
    assert.equal(persisted.sessions.length, 2);
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
    assert.equal(readJson(store.configPath).schemaVersion, 3);
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
    const schemaTwo = defaultConfig();
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
    assert.equal(result.config.schemaVersion, 3);
    assert.equal(result.config.terminal.theme.purple, named.purple);
    assert.equal(result.config.terminal.theme.brightPurple, named.brightPurple);
    assert.equal(result.config.terminal.theme.name, 'NeonCode Default');
    assert.equal(Object.hasOwn(result.config.terminal.theme, 'ansi'), false);
  });
}

function testSchemaOneImportsPreservedLegacyAppearance() {
  withStore((store) => {
    fs.mkdirSync(store.directory, { recursive: true });
    const schemaOne = defaultConfig();
    schemaOne.schemaVersion = 1;
    schemaOne.sessions[0].title = 'Keep Me';
    delete schemaOne.terminal;
    fs.writeFileSync(store.configPath, `${JSON.stringify(schemaOne)}\n`);
    fs.writeFileSync(`${store.configPath}.pre-migration-100`, JSON.stringify({
      terminal: { fontFace: 'Legacy Font', fontSize: 17, background: '#112233' },
    }));

    const result = store.load({});
    assert.equal(result.config.schemaVersion, 3);
    assert.equal(result.config.sessions[0].title, 'Keep Me');
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
    assert.equal(result.config.schemaVersion, 3);
    assert.equal(result.config.hub.endpoint, 'ws://127.0.0.1:45000/ws');
    assert.equal(result.config.persistence.onWindowClose, 'kill');
    assert.equal(result.config.sessions.length, 1);
    assert.equal(readJson(store.configPath).schemaVersion, 3);
  });
}

function testInvalidPrimaryRecoversBackup() {
  withStore((store, directory) => {
    store.load({});
    const backup = defaultConfig();
    backup.sessions[0].title = 'Recovered Shell';
    fs.writeFileSync(store.configBackupPath, `${JSON.stringify(backup)}\n`);
    fs.writeFileSync(store.configPath, '{ invalid json');

    const result = store.load({});
    assert.equal(result.diagnostics.configStatus, 'recovered');
    assert.equal(result.config.sessions[0].title, 'Recovered Shell');
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
    edited.sessions[0].title = 'Still Valid';
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

    assert.equal(result.config.sessions[0].title, 'Still Valid');
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

function testStrictValidation() {
  const unknownKey = defaultConfig();
  unknownKey.unexpected = true;
  assert.throws(() => validateConfig(unknownKey), /keys must be exactly/);

  const remoteEndpoint = defaultConfig();
  remoteEndpoint.hub.endpoint = 'ws://192.168.1.2:44777/ws';
  assert.throws(() => validateConfig(remoteEndpoint), /127\.0\.0\.1/);

  const duplicate = defaultConfig();
  duplicate.sessions[1].id = duplicate.sessions[0].id;
  assert.throws(() => validateConfig(duplicate), /duplicate session id/);

  assert.throws(
    () => applyEnvironmentOverrides(defaultConfig(), { NEONCODE_TERMINAL_COUNT: '3' }),
    /between 1 and 2/,
  );
}

function testStateClampAndPersistence() {
  withStore((store) => {
    store.load({});
    const saved = store.saveState({
      schemaVersion: 1,
      window: { width: 300, height: 200 },
    });
    assert.deepEqual(saved.window, { width: 800, height: 600 });
    const reloaded = store.load({});
    assert.deepEqual(reloaded.state.window, { width: 800, height: 600 });
    assert.deepEqual(validateState(readJson(store.statePath)), reloaded.state);
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
  testStrictValidation,
  testStateClampAndPersistence,
  testStaleTemporaryCleanup,
]) {
  test();
}

console.log('config-store tests passed');

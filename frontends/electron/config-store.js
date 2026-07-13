const fs = require('node:fs');
const path = require('node:path');

const CONFIG_SCHEMA_VERSION = 1;
const STATE_SCHEMA_VERSION = 1;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_STATE_BYTES = 16 * 1024;
const MAX_SESSIONS = 2;
const MIN_WINDOW_WIDTH = 800;
const MIN_WINDOW_HEIGHT = 600;
const MAX_WINDOW_DIMENSION = 10000;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_.-]+$/;
const RESERVED_PROFILE_IDS = new Set(['__proto__', 'constructor', 'prototype']);

class ConfigurationError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.name = 'ConfigurationError';
    this.code = code;
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultConfig() {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    hub: {
      endpoint: 'ws://127.0.0.1:44777/ws',
    },
    sessionPrefix: 'electron-xterm-shell',
    persistence: {
      onWindowClose: 'detach',
    },
    launchProfiles: {
      'default-shell': {
        type: 'process',
        command: 'bash',
        args: [],
        cwd: null,
      },
    },
    sessions: [
      {
        id: 'shell',
        title: 'Shell',
        launchProfile: 'default-shell',
      },
      {
        id: 'tasks',
        title: 'Tasks',
        launchProfile: 'default-shell',
      },
    ],
  };
}

function defaultState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    window: {
      width: 1200,
      height: 800,
    },
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function requireObject(value, label) {
  if (!isPlainObject(value)) {
    throw new ConfigurationError(`${label} must be an object`);
  }
  return value;
}

function requireExactKeys(value, keys, label) {
  requireObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ConfigurationError(`${label} keys must be exactly: ${expected.join(', ')}`);
  }
}

function requireBoundedString(value, label, { min = 1, max = 4096 } = {}) {
  if (typeof value !== 'string' || value.length < min || Buffer.byteLength(value, 'utf8') > max) {
    throw new ConfigurationError(`${label} must contain ${min}-${max} bytes`);
  }
  return value;
}

function requireIdentifier(value, label, max = 128) {
  requireBoundedString(value, label, { max });
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new ConfigurationError(`${label} may contain only ASCII letters, digits, '.', '_', or '-'`);
  }
  return value;
}

function validateEndpoint(value) {
  requireBoundedString(value, 'hub.endpoint', { max: 256 });
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new ConfigurationError('hub.endpoint must be a valid URL');
  }
  if (endpoint.protocol !== 'ws:'
      || endpoint.hostname !== '127.0.0.1'
      || endpoint.pathname !== '/ws'
      || !endpoint.port
      || endpoint.username
      || endpoint.password
      || endpoint.search
      || endpoint.hash) {
    throw new ConfigurationError('hub.endpoint must be ws://127.0.0.1:<port>/ws without credentials, query, or fragment');
  }
  const port = Number.parseInt(endpoint.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError('hub.endpoint port must be between 1 and 65535');
  }
  return value;
}

function migrateConfig(raw) {
  requireObject(raw, 'config');
  if (raw.schemaVersion === CONFIG_SCHEMA_VERSION) {
    return { document: raw, migrated: false, migrationSource: null };
  }
  if (raw.schemaVersion === undefined
      && Object.keys(raw).length === 1
      && isPlainObject(raw.terminal)) {
    return {
      document: defaultConfig(),
      migrated: true,
      migrationSource: 'legacy_terminal',
    };
  }
  if (Number.isInteger(raw.schemaVersion) && raw.schemaVersion > CONFIG_SCHEMA_VERSION) {
    throw new ConfigurationError(
      `config schema ${raw.schemaVersion} is newer than supported schema ${CONFIG_SCHEMA_VERSION}`,
      'future_schema',
    );
  }
  if (raw.schemaVersion !== 0) {
    throw new ConfigurationError('config.schemaVersion must be 0 or 1');
  }

  requireExactKeys(
    raw,
    ['schemaVersion', 'endpoint', 'persistSessions', 'sessionPrefix', 'terminalCount'],
    'legacy config',
  );
  if (typeof raw.persistSessions !== 'boolean') {
    throw new ConfigurationError('legacy persistSessions must be boolean');
  }
  if (!Number.isInteger(raw.terminalCount) || raw.terminalCount < 1 || raw.terminalCount > MAX_SESSIONS) {
    throw new ConfigurationError(`legacy terminalCount must be between 1 and ${MAX_SESSIONS}`);
  }

  const migrated = defaultConfig();
  migrated.hub.endpoint = raw.endpoint;
  migrated.sessionPrefix = raw.sessionPrefix;
  migrated.persistence.onWindowClose = raw.persistSessions ? 'detach' : 'kill';
  migrated.sessions = migrated.sessions.slice(0, raw.terminalCount);
  return { document: migrated, migrated: true, migrationSource: 'schema_0' };
}

function validateConfig(raw) {
  const { document, migrated, migrationSource } = migrateConfig(raw);
  requireExactKeys(
    document,
    ['schemaVersion', 'hub', 'sessionPrefix', 'persistence', 'launchProfiles', 'sessions'],
    'config',
  );
  if (document.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new ConfigurationError(`config.schemaVersion must be ${CONFIG_SCHEMA_VERSION}`);
  }

  requireExactKeys(document.hub, ['endpoint'], 'config.hub');
  const endpoint = validateEndpoint(document.hub.endpoint);
  const sessionPrefix = requireIdentifier(document.sessionPrefix, 'config.sessionPrefix', 96);

  requireExactKeys(document.persistence, ['onWindowClose'], 'config.persistence');
  if (!['detach', 'kill'].includes(document.persistence.onWindowClose)) {
    throw new ConfigurationError('config.persistence.onWindowClose must be detach or kill');
  }

  const rawProfiles = requireObject(document.launchProfiles, 'config.launchProfiles');
  const profileEntries = Object.entries(rawProfiles);
  if (profileEntries.length < 1 || profileEntries.length > 16) {
    throw new ConfigurationError('config.launchProfiles must contain 1-16 profiles');
  }
  const launchProfiles = Object.fromEntries(profileEntries.map(([profileId, rawProfile]) => {
    requireIdentifier(profileId, `launch profile id '${profileId}'`, 64);
    if (RESERVED_PROFILE_IDS.has(profileId)) {
      throw new ConfigurationError(`launch profile id is reserved: ${profileId}`);
    }
    requireExactKeys(rawProfile, ['type', 'command', 'args', 'cwd'], `launchProfiles.${profileId}`);
    if (rawProfile.type !== 'process') {
      throw new ConfigurationError(`launchProfiles.${profileId}.type must be process`);
    }
    const command = requireBoundedString(rawProfile.command, `launchProfiles.${profileId}.command`);
    if (!Array.isArray(rawProfile.args) || rawProfile.args.length > 128) {
      throw new ConfigurationError(`launchProfiles.${profileId}.args must contain at most 128 strings`);
    }
    const args = rawProfile.args.map((argument, index) => (
      requireBoundedString(argument, `launchProfiles.${profileId}.args[${index}]`, { min: 0 })
    ));
    const cwd = rawProfile.cwd === null
      ? null
      : requireBoundedString(rawProfile.cwd, `launchProfiles.${profileId}.cwd`);
    return [profileId, { type: 'process', command, args, cwd }];
  }));

  if (!Array.isArray(document.sessions)
      || document.sessions.length < 1
      || document.sessions.length > MAX_SESSIONS) {
    throw new ConfigurationError(`config.sessions must contain 1-${MAX_SESSIONS} sessions`);
  }
  const seenSessionIds = new Set();
  const sessions = document.sessions.map((rawSession, index) => {
    requireExactKeys(rawSession, ['id', 'title', 'launchProfile'], `config.sessions[${index}]`);
    const id = requireIdentifier(rawSession.id, `config.sessions[${index}].id`, 64);
    if (seenSessionIds.has(id)) {
      throw new ConfigurationError(`duplicate session id: ${id}`);
    }
    seenSessionIds.add(id);
    const title = requireBoundedString(rawSession.title, `config.sessions[${index}].title`, { max: 64 });
    const launchProfile = requireIdentifier(
      rawSession.launchProfile,
      `config.sessions[${index}].launchProfile`,
      64,
    );
    if (!Object.hasOwn(launchProfiles, launchProfile)) {
      throw new ConfigurationError(`unknown launch profile '${launchProfile}' for session '${id}'`);
    }
    if (Buffer.byteLength(`${sessionPrefix}-${id}`, 'utf8') > 128) {
      throw new ConfigurationError(`combined hub session id exceeds 128 bytes: ${sessionPrefix}-${id}`);
    }
    return { id, title, launchProfile };
  });

  return {
    value: {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      hub: { endpoint },
      sessionPrefix,
      persistence: { onWindowClose: document.persistence.onWindowClose },
      launchProfiles,
      sessions,
    },
    migrated,
    migrationSource,
  };
}

function validateState(raw) {
  requireExactKeys(raw, ['schemaVersion', 'window'], 'state');
  if (raw.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new ConfigurationError(`state.schemaVersion must be ${STATE_SCHEMA_VERSION}`);
  }
  requireExactKeys(raw.window, ['width', 'height'], 'state.window');
  for (const dimension of ['width', 'height']) {
    const value = raw.window[dimension];
    if (!Number.isInteger(value) || value < 1 || value > MAX_WINDOW_DIMENSION) {
      throw new ConfigurationError(`state.window.${dimension} must be an integer between 1 and ${MAX_WINDOW_DIMENSION}`);
    }
  }
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    window: {
      width: Math.max(MIN_WINDOW_WIDTH, raw.window.width),
      height: Math.max(MIN_WINDOW_HEIGHT, raw.window.height),
    },
  };
}

function applyEnvironmentOverrides(config, env) {
  const effective = cloneJson(config);
  if (env.NEONCODE_HUB_ENDPOINT) {
    effective.hub.endpoint = env.NEONCODE_HUB_ENDPOINT;
  }
  if (env.NEONCODE_SESSION_PREFIX) {
    effective.sessionPrefix = env.NEONCODE_SESSION_PREFIX;
  }
  if (env.NEONCODE_TERMINAL_COUNT) {
    const count = Number.parseInt(env.NEONCODE_TERMINAL_COUNT, 10);
    if (!Number.isInteger(count) || count < 1 || count > MAX_SESSIONS) {
      throw new ConfigurationError(`NEONCODE_TERMINAL_COUNT must be between 1 and ${MAX_SESSIONS}`);
    }
    effective.sessions = effective.sessions.slice(0, count);
  }
  if (env.NEONCODE_PERSIST_SESSIONS) {
    effective.persistence.onWindowClose = env.NEONCODE_PERSIST_SESSIONS === '0' ? 'kill' : 'detach';
  }
  return validateConfig(effective).value;
}

function readJsonFile(filePath, maximumBytes) {
  const stat = fs.statSync(filePath);
  if (stat.size > maximumBytes) {
    throw new ConfigurationError(`${path.basename(filePath)} exceeds ${maximumBytes} bytes`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function flushDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch {
    // Directory fsync is not supported on every Windows filesystem.
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, payload, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
    flushDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

class ConfigStore {
  constructor(directory) {
    if (!path.isAbsolute(directory)) {
      throw new ConfigurationError('configuration directory must be absolute');
    }
    this.directory = directory;
    this.configPath = path.join(directory, 'config.json');
    this.configBackupPath = `${this.configPath}.bak`;
    this.statePath = path.join(directory, 'state.json');
    this.stateBackupPath = `${this.statePath}.bak`;
  }

  cleanTemporaryFiles() {
    if (!fs.existsSync(this.directory)) {
      return;
    }
    for (const name of fs.readdirSync(this.directory)) {
      if (/^\.(config|state)\.json\.tmp-/.test(name)) {
        fs.rmSync(path.join(this.directory, name), { force: true });
      }
    }
  }

  preserveInvalid(filePath) {
    if (!fs.existsSync(filePath)) {
      return undefined;
    }
    const preserved = `${filePath}.invalid-${Date.now()}`;
    fs.copyFileSync(filePath, preserved, fs.constants.COPYFILE_EXCL);
    return preserved;
  }

  preserveForMigration(warnings) {
    const preserved = `${this.configPath}.pre-migration-${Date.now()}`;
    try {
      fs.copyFileSync(this.configPath, preserved, fs.constants.COPYFILE_EXCL);
      warnings.push(`legacy config.json was preserved as ${path.basename(preserved)}`);
    } catch (error) {
      warnings.push(`legacy config.json could not be preserved before migration: ${error.message}`);
    }
  }

  preserveInvalidSafely(filePath, warnings, label) {
    try {
      const preserved = this.preserveInvalid(filePath);
      if (preserved) {
        warnings.push(`${label} was preserved as ${path.basename(preserved)}`);
      }
      return preserved;
    } catch (error) {
      warnings.push(`${label} could not be preserved: ${error.message}`);
      return undefined;
    }
  }

  loadConfig() {
    const warnings = [];
    if (!fs.existsSync(this.configPath)) {
      if (!fs.existsSync(this.configBackupPath)) {
        const created = defaultConfig();
        writeJsonAtomic(this.configPath, created);
        try {
          writeJsonAtomic(this.configBackupPath, created);
        } catch (error) {
          warnings.push(`config.json.bak could not be created: ${error.message}`);
        }
        return { config: created, status: 'created', warnings, errors: [] };
      }

      let recovered;
      try {
        recovered = validateConfig(readJsonFile(this.configBackupPath, MAX_CONFIG_BYTES)).value;
      } catch (backupError) {
        this.preserveInvalidSafely(this.configBackupPath, warnings, 'unusable config.json.bak');
        return {
          config: null,
          status: 'error',
          warnings,
          errors: [`config.json is missing and config.json.bak is unusable: ${backupError.message}`],
        };
      }
      try {
        writeJsonAtomic(this.configPath, recovered);
        warnings.push('config.json was missing and was restored from config.json.bak');
      } catch (error) {
        warnings.push(`config.json could not be restored from its valid backup: ${error.message}`);
      }
      return { config: recovered, status: 'recovered', warnings, errors: [] };
    }

    let primaryResult;
    try {
      primaryResult = validateConfig(readJsonFile(this.configPath, MAX_CONFIG_BYTES));
    } catch (primaryError) {
      if (primaryError instanceof ConfigurationError && primaryError.code === 'future_schema') {
        return { config: null, status: 'error', warnings, errors: [primaryError.message] };
      }

      this.preserveInvalidSafely(this.configPath, warnings, 'invalid config.json');
      if (!fs.existsSync(this.configBackupPath)) {
        return {
          config: null,
          status: 'error',
          warnings,
          errors: [`config.json is invalid: ${primaryError.message}`],
        };
      }

      let recovered;
      try {
        recovered = validateConfig(readJsonFile(this.configBackupPath, MAX_CONFIG_BYTES)).value;
      } catch (backupError) {
        return {
          config: null,
          status: 'error',
          warnings,
          errors: [
            `config.json is invalid: ${primaryError.message}`,
            `config.json.bak is unusable: ${backupError.message}`,
          ],
        };
      }
      try {
        writeJsonAtomic(this.configPath, recovered);
        warnings.push('config.json was restored from config.json.bak');
      } catch (error) {
        warnings.push(`config.json could not be restored from its valid backup: ${error.message}`);
      }
      return { config: recovered, status: 'recovered', warnings, errors: [] };
    }

    if (primaryResult.migrated) {
      this.preserveForMigration(warnings);
      try {
        writeJsonAtomic(this.configPath, primaryResult.value);
        const migrationDetail = primaryResult.migrationSource === 'legacy_terminal'
          ? '; legacy terminal theme settings remain in the preserved file and are not applied yet'
          : '';
        warnings.push(`config.json was migrated to schema ${CONFIG_SCHEMA_VERSION}${migrationDetail}`);
      } catch (error) {
        warnings.push(`migrated config.json could not be persisted: ${error.message}`);
      }
    }
    try {
      writeJsonAtomic(this.configBackupPath, primaryResult.value);
    } catch (error) {
      warnings.push(`config.json.bak could not be refreshed: ${error.message}`);
    }
    return {
      config: primaryResult.value,
      status: primaryResult.migrated ? 'migrated' : 'loaded',
      warnings,
      errors: [],
    };
  }

  loadState() {
    const warnings = [];
    if (fs.existsSync(this.statePath)) {
      let state;
      try {
        state = validateState(readJsonFile(this.statePath, MAX_STATE_BYTES));
      } catch (error) {
        this.preserveInvalidSafely(this.statePath, warnings, 'invalid state.json');
        warnings.push(`state.json will be recovered or reset: ${error.message}`);
      }
      if (state) {
        try {
          writeJsonAtomic(this.stateBackupPath, state);
        } catch (error) {
          warnings.push(`state.json.bak could not be refreshed: ${error.message}`);
        }
        return { state, status: 'loaded', warnings };
      }
    }

    if (fs.existsSync(this.stateBackupPath)) {
      try {
        const recovered = validateState(readJsonFile(this.stateBackupPath, MAX_STATE_BYTES));
        try {
          writeJsonAtomic(this.statePath, recovered);
          warnings.push('state.json was restored from state.json.bak');
        } catch (error) {
          warnings.push(`state.json could not be restored from its valid backup: ${error.message}`);
        }
        return { state: recovered, status: 'recovered', warnings };
      } catch (error) {
        this.preserveInvalidSafely(this.stateBackupPath, warnings, 'unusable state.json.bak');
        warnings.push(`state.json.bak could not be used: ${error.message}`);
      }
    }

    const state = defaultState();
    writeJsonAtomic(this.statePath, state);
    try {
      writeJsonAtomic(this.stateBackupPath, state);
    } catch (error) {
      warnings.push(`state.json.bak could not be created: ${error.message}`);
    }
    return { state, status: 'created', warnings };
  }

  load(env = process.env) {
    fs.mkdirSync(this.directory, { recursive: true });
    this.cleanTemporaryFiles();
    const configResult = this.loadConfig();
    const stateResult = this.loadState();
    let effectiveConfig = configResult.config;
    const errors = [...configResult.errors];
    if (effectiveConfig) {
      try {
        effectiveConfig = applyEnvironmentOverrides(effectiveConfig, env);
      } catch (error) {
        effectiveConfig = null;
        errors.push(`environment override is invalid: ${error.message}`);
      }
    }
    return {
      config: effectiveConfig,
      state: stateResult.state,
      diagnostics: {
        configStatus: configResult.status,
        stateStatus: stateResult.status,
        warnings: [...configResult.warnings, ...stateResult.warnings],
        errors,
      },
    };
  }

  saveState(state) {
    const validated = validateState(state);
    if (fs.existsSync(this.statePath)) {
      try {
        const previous = validateState(readJsonFile(this.statePath, MAX_STATE_BYTES));
        writeJsonAtomic(this.stateBackupPath, previous);
      } catch {
        // The new valid state replaces corrupt app-owned state.
      }
    }
    writeJsonAtomic(this.statePath, validated);
    return validated;
  }
}

module.exports = {
  CONFIG_SCHEMA_VERSION,
  STATE_SCHEMA_VERSION,
  ConfigStore,
  ConfigurationError,
  applyEnvironmentOverrides,
  defaultConfig,
  defaultState,
  validateConfig,
  validateEndpoint,
  validateState,
  writeJsonAtomic,
};

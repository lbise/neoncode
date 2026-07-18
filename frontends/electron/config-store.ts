import fs = require('node:fs');
import path = require('node:path');

import {
  orderedDepthFirstPanes,
  validateWorkspaceLayoutState,
} from './shared/layout-model';
import {
  createConcreteCommandInvocations,
  createDefaultKeybindings,
  validateKeybindingSettings,
} from './shared/keybindings';
import type {
  ConfigStorageStatus,
  DesktopBootstrapResult,
  DesktopConfig,
  DesktopDiagnostics,
  DesktopLaunchProfile,
  DesktopSettings,
  DesktopState,
  KeybindingSettings,
  DesktopWorkspaceConfig,
  StateStorageStatus,
  TerminalAppearance,
  TerminalTheme,
  AppTheme,
} from './shared/types';

export const CONFIG_SCHEMA_VERSION = 8;
export const STATE_SCHEMA_VERSION = 3;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_WORKSPACES = 16;
const MAX_STATE_WORKSPACE_LAYOUTS = 16;
const MAX_STATE_LAYOUT_LEAVES = 64;
const MAX_PANES_PER_WORKSPACE = 8;
const MAX_CONFIGURED_SESSIONS = 64;
const MIN_WINDOW_WIDTH = 800;
const MIN_WINDOW_HEIGHT = 600;
const MAX_WINDOW_DIMENSION = 10000;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_.-]+$/;
const RESERVED_PROFILE_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const TERMINAL_COLOR_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'purple', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightPurple', 'brightCyan', 'brightWhite',
] as const;
const THEME_COLOR_KEYS = [
  'background', 'foreground', 'cursorColor', 'selectionBackground',
  ...TERMINAL_COLOR_KEYS,
] as const;

type UnknownRecord = Record<string, unknown>;
type MigrationSource =
  | 'legacy_terminal'
  | 'schema_0'
  | 'schema_1'
  | 'schema_1_legacy_terminal'
  | 'schema_2'
  | 'schema_3'
  | 'schema_4'
  | 'schema_5'
  | 'schema_6'
  | 'schema_7';

interface ConfigMigrationResult {
  document: unknown;
  migrated: boolean;
  migrationSource: MigrationSource | null;
}

export interface ConfigValidationResult {
  value: DesktopConfig;
  migrated: boolean;
  migrationSource: MigrationSource | null;
}

interface ConfigLoadResult {
  config: DesktopConfig | null;
  status: ConfigStorageStatus;
  warnings: string[];
  errors: string[];
}

interface StateLoadResult {
  state: DesktopState;
  status: StateStorageStatus;
  warnings: string[];
}

export class ConfigurationError extends Error {
  readonly code: string;

  constructor(message: string, code = 'invalid') {
    super(message);
    this.name = 'ConfigurationError';
    this.code = code;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneJson<T>(value: T): T {
  const cloned: unknown = JSON.parse(JSON.stringify(value));
  return cloned as T;
}

export function defaultAppTheme(): AppTheme {
  return {
    sidebarBackground: '#0f172a',
    appBackground: '#0b1020',
    terminalBackground: '#0c0c0c',
    textColor: '#d1d5db',
    accent: '#ff4fd8',
    secondaryAccent: '#8a2c72',
    tertiaryAccent: '#3a173f',
  };
}

export function defaultTerminalAppearance(): TerminalAppearance {
  return {
    fontFamily: 'Cascadia Mono, FiraCode Nerd Font Mono, Consolas, monospace',
    fontSize: 14,
    cursorBlink: true,
    theme: {
      name: 'NeonCode Default',
      background: '#0c0c0c',
      foreground: '#cccccc',
      cursorColor: '#ffffff',
      selectionBackground: '#264f78',
      black: '#0c0c0c',
      red: '#c50f1f',
      green: '#13a10e',
      yellow: '#c19c00',
      blue: '#0037da',
      purple: '#881798',
      cyan: '#3a96dd',
      white: '#cccccc',
      brightBlack: '#767676',
      brightRed: '#e74856',
      brightGreen: '#16c60c',
      brightYellow: '#f9f1a5',
      brightBlue: '#3b78ff',
      brightPurple: '#b4009e',
      brightCyan: '#61d6d6',
      brightWhite: '#f2f2f2',
    },
  };
}

export function defaultConfig(): DesktopConfig {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    hub: {
      endpoint: 'ws://127.0.0.1:44777/ws',
    },
    sessionPrefix: 'electron-xterm-shell',
    persistence: {
      onWindowClose: 'detach',
      confirmBeforeClosingTab: false,
      confirmBeforeClosingTerminal: false,
    },
    terminal: defaultTerminalAppearance(),
    appTheme: defaultAppTheme(),
    keybindings: { overrides: [] },
    launchProfiles: {
      'default-shell': {
        type: 'process',
        command: 'bash',
        args: [],
        cwd: null,
      },
    },
    workspaces: [
      {
        id: 'default',
        name: 'Default',
        path: null,
        defaultLaunchProfile: 'default-shell',
        layout: { columns: 2 },
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
      },
    ],
  };
}

export function defaultState(): DesktopState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    window: {
      width: 1200,
      height: 800,
    },
    activeWorkspaceId: null,
    workspaceLayouts: {},
  };
}

function isObjectRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is UnknownRecord {
  return isObjectRecord(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function requireObject(value: unknown, label: string): UnknownRecord {
  if (!isPlainObject(value)) {
    throw new ConfigurationError(`${label} must be an object`);
  }
  return value;
}

function requireExactKeys(value: unknown, keys: readonly string[], label: string): UnknownRecord {
  const object = requireObject(value, label);
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ConfigurationError(`${label} keys must be exactly: ${expected.join(', ')}`);
  }
  return object;
}

function requireBoundedString(
  value: unknown,
  label: string,
  { min = 1, max = 4096 }: { min?: number; max?: number } = {},
): string {
  if (typeof value !== 'string' || value.length < min || Buffer.byteLength(value, 'utf8') > max) {
    throw new ConfigurationError(`${label} must contain ${min}-${max} bytes`);
  }
  return value;
}

function requireIdentifier(value: unknown, label: string, max = 128): string {
  const identifier = requireBoundedString(value, label, { max });
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new ConfigurationError(`${label} may contain only ASCII letters, digits, '.', '_', or '-'`);
  }
  return identifier;
}

export function validateWorkspacePath(value: unknown, label = 'workspace path'): string | null {
  if (value === null) return null;
  const workspacePath = requireBoundedString(value, label, { max: 4096 });
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(workspacePath)) {
    throw new ConfigurationError(`${label} may not contain NUL or control characters`);
  }
  return workspacePath;
}

function requireColor(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value)) {
    throw new ConfigurationError(`${label} must be a 6- or 8-digit CSS hex color`);
  }
  return value.toLowerCase();
}

export function validateEndpoint(value: unknown): string {
  const endpointText = requireBoundedString(value, 'hub.endpoint', { max: 256 });
  let endpoint: URL;
  try {
    endpoint = new URL(endpointText);
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
  return endpointText;
}

function migrateLegacyTerminal(rawTerminal: UnknownRecord): UnknownRecord {
  const defaults = defaultTerminalAppearance();
  const theme: UnknownRecord = { ...defaults.theme };
  const appearance: UnknownRecord = { ...defaults, theme };
  if (typeof rawTerminal.fontFace === 'string') appearance.fontFamily = rawTerminal.fontFace;
  if (typeof rawTerminal.fontSize === 'number' && Number.isInteger(rawTerminal.fontSize)) {
    appearance.fontSize = rawTerminal.fontSize;
  }
  if (typeof rawTerminal.cursorStyle === 'string') {
    appearance.cursorBlink = rawTerminal.cursorStyle.toLowerCase().includes('blinking');
  }
  for (const key of ['background', 'foreground', 'selectionBackground'] as const) {
    if (typeof rawTerminal[key] === 'string') theme[key] = rawTerminal[key];
  }
  const colorTable = rawTerminal.colorTable;
  if (Array.isArray(colorTable) && colorTable.length === 16) {
    TERMINAL_COLOR_KEYS.forEach((key, index) => {
      theme[key] = colorTable[index];
    });
  }
  return appearance;
}

function migrateSchemaTwoTerminal(rawTerminal: unknown): UnknownRecord {
  const terminal = requireObject(rawTerminal, 'schema 2 terminal');
  const oldTheme = requireObject(terminal.theme, 'schema 2 terminal.theme');
  const defaults = defaultTerminalAppearance();
  const theme: UnknownRecord = {
    ...defaults.theme,
    background: oldTheme.background,
    foreground: oldTheme.foreground,
    cursorColor: oldTheme.cursor,
    selectionBackground: oldTheme.selectionBackground,
  };
  const ansi = oldTheme.ansi;
  TERMINAL_COLOR_KEYS.forEach((key, index) => {
    theme[key] = Array.isArray(ansi) ? ansi[index] : undefined;
  });
  return {
    ...defaults,
    fontFamily: terminal.fontFamily,
    fontSize: terminal.fontSize,
    cursorBlink: terminal.cursorBlink,
    theme,
  };
}

function requireLegacyDesktopConfigKeys(document: UnknownRecord, { terminal }: { terminal: boolean }): void {
  const keys = ['schemaVersion', 'hub', 'sessionPrefix', 'persistence', 'launchProfiles', 'sessions'];
  if (terminal) keys.push('terminal');
  requireExactKeys(document, keys, `schema ${String(document.schemaVersion)} config`);
}

function migrateSchemaThreeConfig(document: UnknownRecord): UnknownRecord {
  const { sessions, ...rest } = document;
  return {
    ...rest,
    schemaVersion: 4,
    workspaces: [{
      id: 'default',
      name: 'Default',
      layout: { columns: Array.isArray(sessions) ? Math.min(2, sessions.length) : 0 },
      sessions,
    }],
  };
}

function migrateSchemaFourConfig(document: UnknownRecord): UnknownRecord {
  requireExactKeys(
    document,
    ['schemaVersion', 'hub', 'sessionPrefix', 'persistence', 'terminal', 'launchProfiles', 'workspaces'],
    'schema 4 config',
  );
  return {
    ...document,
    schemaVersion: 5,
    keybindings: { overrides: [] },
  };
}

function migrateSchemaFiveConfig(document: UnknownRecord): UnknownRecord {
  requireExactKeys(
    document,
    ['schemaVersion', 'hub', 'sessionPrefix', 'persistence', 'terminal', 'keybindings', 'launchProfiles', 'workspaces'],
    'schema 5 config',
  );
  const profiles = requireObject(document.launchProfiles, 'schema 5 launchProfiles');
  const workspaces = Array.isArray(document.workspaces) ? document.workspaces : [];
  return {
    ...document,
    schemaVersion: 6,
    workspaces: workspaces.map((rawWorkspace, workspaceIndex) => {
      const workspace = requireExactKeys(
        rawWorkspace,
        ['id', 'name', 'layout', 'sessions'],
        `schema 5 workspaces[${workspaceIndex}]`,
      );
      const sessions = Array.isArray(workspace.sessions) ? workspace.sessions : [];
      const profileIds = sessions.map((rawSession) => (
        isPlainObject(rawSession) && typeof rawSession.launchProfile === 'string'
          ? rawSession.launchProfile
          : null
      ));
      const cwds = profileIds.map((profileId) => {
        const profile = profileId === null ? undefined : profiles[profileId];
        return isPlainObject(profile) && typeof profile.cwd === 'string' ? profile.cwd : null;
      });
      const firstCwd = cwds[0] ?? null;
      const commonPath = firstCwd !== null && cwds.length > 0 && cwds.every((cwd) => cwd === firstCwd)
        ? firstCwd
        : null;
      return {
        ...workspace,
        path: commonPath,
        defaultLaunchProfile: profileIds[0],
      };
    }),
  };
}

function migrateSchemaSixConfig(document: UnknownRecord): UnknownRecord {
  requireExactKeys(
    document,
    ['schemaVersion', 'hub', 'sessionPrefix', 'persistence', 'terminal', 'keybindings', 'launchProfiles', 'workspaces'],
    'schema 6 config',
  );
  const persistence = requireExactKeys(document.persistence, ['onWindowClose'], 'schema 6 persistence');
  return {
    ...document,
    schemaVersion: 7,
    persistence: {
      ...persistence,
      confirmBeforeClosingTab: false,
      confirmBeforeClosingTerminal: false,
    },
  };
}

function migrateSchemaSevenConfig(document: UnknownRecord): UnknownRecord {
  requireExactKeys(
    document,
    ['schemaVersion', 'hub', 'sessionPrefix', 'persistence', 'terminal', 'keybindings', 'launchProfiles', 'workspaces'],
    'schema 7 config',
  );
  return {
    ...document,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    appTheme: defaultAppTheme(),
  };
}

function migrateToCurrentConfig(document: UnknownRecord): UnknownRecord {
  return migrateSchemaSevenConfig(document);
}

function migrateConfig(raw: unknown, legacyTerminal?: UnknownRecord): ConfigMigrationResult {
  const document = requireObject(raw, 'config');
  if (document.schemaVersion === CONFIG_SCHEMA_VERSION) {
    return { document, migrated: false, migrationSource: null };
  }
  if (document.schemaVersion === 7) {
    return {
      document: migrateSchemaSevenConfig(document),
      migrated: true,
      migrationSource: 'schema_7',
    };
  }
  if (document.schemaVersion === 6) {
    return {
      document: migrateToCurrentConfig(migrateSchemaSixConfig(document)),
      migrated: true,
      migrationSource: 'schema_6',
    };
  }
  if (document.schemaVersion === 5) {
    return {
      document: migrateToCurrentConfig(migrateSchemaSixConfig(migrateSchemaFiveConfig(document))),
      migrated: true,
      migrationSource: 'schema_5',
    };
  }
  if (document.schemaVersion === 4) {
    return {
      document: migrateToCurrentConfig(migrateSchemaSixConfig(migrateSchemaFiveConfig(migrateSchemaFourConfig(document)))),
      migrated: true,
      migrationSource: 'schema_4',
    };
  }
  if (document.schemaVersion === undefined
      && Object.keys(document).length === 1
      && isPlainObject(document.terminal)) {
    const migrated = defaultConfig();
    return {
      document: { ...migrated, terminal: migrateLegacyTerminal(document.terminal) },
      migrated: true,
      migrationSource: 'legacy_terminal',
    };
  }
  if (document.schemaVersion === 3) {
    requireLegacyDesktopConfigKeys(document, { terminal: true });
    return {
      document: migrateToCurrentConfig(migrateSchemaSixConfig(migrateSchemaFiveConfig(migrateSchemaFourConfig(migrateSchemaThreeConfig(document))))),
      migrated: true,
      migrationSource: 'schema_3',
    };
  }
  if (document.schemaVersion === 2) {
    requireLegacyDesktopConfigKeys(document, { terminal: true });
    const schemaThree = {
      ...document,
      schemaVersion: 3,
      terminal: migrateSchemaTwoTerminal(document.terminal),
    };
    return {
      document: migrateToCurrentConfig(migrateSchemaSixConfig(migrateSchemaFiveConfig(migrateSchemaFourConfig(migrateSchemaThreeConfig(schemaThree))))),
      migrated: true,
      migrationSource: 'schema_2',
    };
  }
  if (document.schemaVersion === 1) {
    requireLegacyDesktopConfigKeys(document, { terminal: false });
    const schemaThree = {
      ...document,
      schemaVersion: 3,
      terminal: legacyTerminal ? migrateLegacyTerminal(legacyTerminal) : defaultTerminalAppearance(),
    };
    return {
      document: migrateToCurrentConfig(migrateSchemaSixConfig(migrateSchemaFiveConfig(migrateSchemaFourConfig(migrateSchemaThreeConfig(schemaThree))))),
      migrated: true,
      migrationSource: legacyTerminal ? 'schema_1_legacy_terminal' : 'schema_1',
    };
  }
  if (typeof document.schemaVersion === 'number'
      && Number.isInteger(document.schemaVersion)
      && document.schemaVersion > CONFIG_SCHEMA_VERSION) {
    throw new ConfigurationError(
      `config schema ${document.schemaVersion} is newer than supported schema ${CONFIG_SCHEMA_VERSION}`,
      'future_schema',
    );
  }
  if (document.schemaVersion !== 0) {
    throw new ConfigurationError('config.schemaVersion must be 0, 1, 2, 3, 4, 5, 6, 7, or 8');
  }

  requireExactKeys(
    document,
    ['schemaVersion', 'endpoint', 'persistSessions', 'sessionPrefix', 'terminalCount'],
    'legacy config',
  );
  if (typeof document.persistSessions !== 'boolean') {
    throw new ConfigurationError('legacy persistSessions must be boolean');
  }
  if (typeof document.terminalCount !== 'number'
      || !Number.isInteger(document.terminalCount)
      || document.terminalCount < 1
      || document.terminalCount > 2) {
    throw new ConfigurationError('legacy terminalCount must be between 1 and 2');
  }

  const defaults = defaultConfig();
  const terminalCount = document.terminalCount;
  return {
    document: {
      ...defaults,
      hub: { endpoint: document.endpoint },
      sessionPrefix: document.sessionPrefix,
      persistence: {
        onWindowClose: document.persistSessions ? 'detach' : 'kill',
        confirmBeforeClosingTab: false,
        confirmBeforeClosingTerminal: false,
      },
      workspaces: defaults.workspaces.map((workspace, index) => index === 0
        ? {
            ...workspace,
            layout: { columns: terminalCount },
            sessions: workspace.sessions.slice(0, terminalCount),
          }
        : workspace),
    },
    migrated: true,
    migrationSource: 'schema_0',
  };
}

export function validateConfig(
  raw: unknown,
  { legacyTerminal }: { legacyTerminal?: UnknownRecord | undefined } = {},
): ConfigValidationResult {
  const { document: migratedDocument, migrated, migrationSource } = migrateConfig(raw, legacyTerminal);
  const document = requireExactKeys(
    migratedDocument,
    ['schemaVersion', 'hub', 'sessionPrefix', 'persistence', 'terminal', 'appTheme', 'keybindings', 'launchProfiles', 'workspaces'],
    'config',
  );
  if (document.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new ConfigurationError(`config.schemaVersion must be ${CONFIG_SCHEMA_VERSION}`);
  }

  const hub = requireExactKeys(document.hub, ['endpoint'], 'config.hub');
  const endpoint = validateEndpoint(hub.endpoint);
  const sessionPrefix = requireIdentifier(document.sessionPrefix, 'config.sessionPrefix', 96);

  const persistence = requireExactKeys(
    document.persistence,
    ['onWindowClose', 'confirmBeforeClosingTab', 'confirmBeforeClosingTerminal'],
    'config.persistence',
  );
  const onWindowClose = persistence.onWindowClose;
  if (onWindowClose !== 'detach' && onWindowClose !== 'kill') {
    throw new ConfigurationError('config.persistence.onWindowClose must be detach or kill');
  }
  if (typeof persistence.confirmBeforeClosingTab !== 'boolean') {
    throw new ConfigurationError('config.persistence.confirmBeforeClosingTab must be boolean');
  }
  if (typeof persistence.confirmBeforeClosingTerminal !== 'boolean') {
    throw new ConfigurationError('config.persistence.confirmBeforeClosingTerminal must be boolean');
  }

  const terminalDocument = requireExactKeys(
    document.terminal,
    ['fontFamily', 'fontSize', 'cursorBlink', 'theme'],
    'config.terminal',
  );
  const fontFamily = requireBoundedString(
    terminalDocument.fontFamily,
    'config.terminal.fontFamily',
    { max: 256 },
  );
  const fontSize = terminalDocument.fontSize;
  if (typeof fontSize !== 'number' || !Number.isInteger(fontSize) || fontSize < 8 || fontSize > 32) {
    throw new ConfigurationError('config.terminal.fontSize must be an integer between 8 and 32');
  }
  if (typeof terminalDocument.cursorBlink !== 'boolean') {
    throw new ConfigurationError('config.terminal.cursorBlink must be boolean');
  }
  const themeKeys = ['name', ...THEME_COLOR_KEYS] as const;
  const themeDocument = requireExactKeys(terminalDocument.theme, themeKeys, 'config.terminal.theme');
  const theme: TerminalTheme = defaultTerminalAppearance().theme;
  theme.name = requireBoundedString(themeDocument.name, 'config.terminal.theme.name', { max: 128 });
  for (const key of THEME_COLOR_KEYS) {
    theme[key] = requireColor(themeDocument[key], `config.terminal.theme.${key}`);
  }
  const terminal: TerminalAppearance = {
    fontFamily,
    fontSize,
    cursorBlink: terminalDocument.cursorBlink,
    theme,
  };

  const rawAppTheme = requireExactKeys(
    document.appTheme,
    ['sidebarBackground', 'appBackground', 'terminalBackground', 'textColor', 'accent', 'secondaryAccent', 'tertiaryAccent'],
    'config.appTheme',
  );
  const appTheme: AppTheme = {
    sidebarBackground: requireColor(rawAppTheme.sidebarBackground, 'config.appTheme.sidebarBackground'),
    appBackground: requireColor(rawAppTheme.appBackground, 'config.appTheme.appBackground'),
    terminalBackground: requireColor(rawAppTheme.terminalBackground, 'config.appTheme.terminalBackground'),
    textColor: requireColor(rawAppTheme.textColor, 'config.appTheme.textColor'),
    accent: requireColor(rawAppTheme.accent, 'config.appTheme.accent'),
    secondaryAccent: requireColor(rawAppTheme.secondaryAccent, 'config.appTheme.secondaryAccent'),
    tertiaryAccent: requireColor(rawAppTheme.tertiaryAccent, 'config.appTheme.tertiaryAccent'),
  };

  const rawProfiles = requireObject(document.launchProfiles, 'config.launchProfiles');
  const profileEntries = Object.entries(rawProfiles);
  if (profileEntries.length < 1 || profileEntries.length > 16) {
    throw new ConfigurationError('config.launchProfiles must contain 1-16 profiles');
  }
  const launchProfiles: Record<string, DesktopLaunchProfile> = Object.fromEntries(
    profileEntries.map(([profileId, rawProfile]) => {
      requireIdentifier(profileId, `launch profile id '${profileId}'`, 64);
      if (RESERVED_PROFILE_IDS.has(profileId)) {
        throw new ConfigurationError(`launch profile id is reserved: ${profileId}`);
      }
      const profile = requireExactKeys(
        rawProfile,
        ['type', 'command', 'args', 'cwd'],
        `launchProfiles.${profileId}`,
      );
      if (profile.type !== 'process') {
        throw new ConfigurationError(`launchProfiles.${profileId}.type must be process`);
      }
      const command = requireBoundedString(profile.command, `launchProfiles.${profileId}.command`);
      if (!Array.isArray(profile.args) || profile.args.length > 128) {
        throw new ConfigurationError(`launchProfiles.${profileId}.args must contain at most 128 strings`);
      }
      const args = profile.args.map((argument, index) => (
        requireBoundedString(argument, `launchProfiles.${profileId}.args[${index}]`, { min: 0 })
      ));
      const cwd = profile.cwd === null
        ? null
        : requireBoundedString(profile.cwd, `launchProfiles.${profileId}.cwd`);
      return [profileId, { type: 'process' as const, command, args, cwd }];
    }),
  );

  if (!Array.isArray(document.workspaces)
      || document.workspaces.length < 1
      || document.workspaces.length > MAX_WORKSPACES) {
    throw new ConfigurationError(`config.workspaces must contain 1-${MAX_WORKSPACES} workspaces`);
  }
  const seenWorkspaceIds = new Set<string>();
  const seenSessionIds = new Set<string>();
  let configuredSessionCount = 0;
  const workspaces: DesktopWorkspaceConfig[] = document.workspaces.map((rawWorkspace, workspaceIndex) => {
    const workspaceLabel = `config.workspaces[${workspaceIndex}]`;
    const workspace = requireExactKeys(
      rawWorkspace,
      ['id', 'name', 'path', 'defaultLaunchProfile', 'layout', 'sessions'],
      workspaceLabel,
    );
    const id = requireIdentifier(workspace.id, `${workspaceLabel}.id`, 64);
    if (seenWorkspaceIds.has(id)) {
      throw new ConfigurationError(`duplicate workspace id: ${id}`);
    }
    seenWorkspaceIds.add(id);
    const name = requireBoundedString(workspace.name, `${workspaceLabel}.name`, { max: 64 });
    const workspacePath = validateWorkspacePath(workspace.path, `${workspaceLabel}.path`);
    const defaultLaunchProfile = requireIdentifier(
      workspace.defaultLaunchProfile,
      `${workspaceLabel}.defaultLaunchProfile`,
      64,
    );
    if (!Object.hasOwn(launchProfiles, defaultLaunchProfile)) {
      throw new ConfigurationError(
        `unknown default launch profile '${defaultLaunchProfile}' for workspace '${id}'`,
      );
    }
    const layout = requireExactKeys(workspace.layout, ['columns'], `${workspaceLabel}.layout`);
    if (!Array.isArray(workspace.sessions)
        || workspace.sessions.length < 1
        || workspace.sessions.length > MAX_PANES_PER_WORKSPACE) {
      throw new ConfigurationError(`${workspaceLabel}.sessions must contain 1-${MAX_PANES_PER_WORKSPACE} sessions`);
    }
    configuredSessionCount += workspace.sessions.length;
    if (configuredSessionCount > MAX_CONFIGURED_SESSIONS) {
      throw new ConfigurationError(`config.workspaces may contain at most ${MAX_CONFIGURED_SESSIONS} sessions in total`);
    }
    const columns = layout.columns;
    if (typeof columns !== 'number'
        || !Number.isInteger(columns)
        || columns < 1
        || columns > workspace.sessions.length) {
      throw new ConfigurationError(`${workspaceLabel}.layout.columns must be between 1 and the session count`);
    }
    const sessions = workspace.sessions.map((rawSession, sessionIndex) => {
      const sessionLabel = `${workspaceLabel}.sessions[${sessionIndex}]`;
      const session = requireExactKeys(rawSession, ['id', 'title', 'launchProfile'], sessionLabel);
      const sessionId = requireIdentifier(session.id, `${sessionLabel}.id`, 64);
      if (seenSessionIds.has(sessionId)) {
        throw new ConfigurationError(`duplicate session id across workspaces: ${sessionId}`);
      }
      seenSessionIds.add(sessionId);
      const title = requireBoundedString(session.title, `${sessionLabel}.title`, { max: 64 });
      const launchProfile = requireIdentifier(
        session.launchProfile,
        `${sessionLabel}.launchProfile`,
        64,
      );
      if (!Object.hasOwn(launchProfiles, launchProfile)) {
        throw new ConfigurationError(`unknown launch profile '${launchProfile}' for session '${sessionId}'`);
      }
      if (Buffer.byteLength(`${sessionPrefix}-${sessionId}`, 'utf8') > 128) {
        throw new ConfigurationError(`combined hub session id exceeds 128 bytes: ${sessionPrefix}-${sessionId}`);
      }
      return { id: sessionId, title, launchProfile };
    });
    return {
      id,
      name,
      path: workspacePath,
      defaultLaunchProfile,
      layout: { columns },
      sessions,
    };
  });

  let keybindings: KeybindingSettings;
  try {
    keybindings = validateKeybindingSettings(
      document.keybindings,
      createDefaultKeybindings(workspaces.map((workspace) => workspace.id)),
      createConcreteCommandInvocations(
        workspaces.map((workspace) => workspace.id),
        workspaces.flatMap((workspace) => workspace.sessions.map((session) => session.id)),
      ),
      { tolerateUnavailable: true },
    );
  } catch (error) {
    throw new ConfigurationError(`config.${errorMessage(error)}`);
  }

  return {
    value: {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      hub: { endpoint },
      sessionPrefix,
      persistence: {
        onWindowClose,
        confirmBeforeClosingTab: persistence.confirmBeforeClosingTab,
        confirmBeforeClosingTerminal: persistence.confirmBeforeClosingTerminal,
      },
      terminal,
      appTheme,
      keybindings,
      launchProfiles,
      workspaces,
    },
    migrated,
    migrationSource,
  };
}

export function settingsFromConfig(config: DesktopConfig): DesktopSettings {
  return cloneJson({
    hub: config.hub,
    sessionPrefix: config.sessionPrefix,
    persistence: config.persistence,
    terminal: config.terminal,
    appTheme: config.appTheme,
    keybindings: config.keybindings,
  });
}

export function validateSettingsForConfig(raw: unknown, baseConfig: DesktopConfig): DesktopSettings {
  const settings = requireExactKeys(
    raw,
    ['hub', 'sessionPrefix', 'persistence', 'terminal', 'appTheme', 'keybindings'],
    'settings',
  );
  const validated = validateConfig({
    ...baseConfig,
    hub: settings.hub,
    sessionPrefix: settings.sessionPrefix,
    persistence: settings.persistence,
    terminal: settings.terminal,
    appTheme: settings.appTheme,
    keybindings: settings.keybindings,
  }).value;
  return settingsFromConfig(validated);
}

function requireWindowDimension(value: unknown, dimension: 'width' | 'height'): number {
  if (typeof value !== 'number'
      || !Number.isInteger(value)
      || value < 1
      || value > MAX_WINDOW_DIMENSION) {
    throw new ConfigurationError(
      `state.window.${dimension} must be an integer between 1 and ${MAX_WINDOW_DIMENSION}`,
    );
  }
  return value;
}

function requireStateSize(raw: unknown): void {
  let payload: string;
  try {
    payload = `${JSON.stringify(raw, null, 2)}\n`;
  } catch (error) {
    throw new ConfigurationError(`state must be JSON serializable: ${errorMessage(error)}`);
  }
  if (Buffer.byteLength(payload, 'utf8') > MAX_STATE_BYTES) {
    throw new ConfigurationError(`state exceeds ${MAX_STATE_BYTES} bytes`);
  }
}

export function validateState(raw: unknown): DesktopState {
  requireStateSize(raw);
  const rawDocument = requireObject(raw, 'state');
  let migratedDocument: unknown = rawDocument;
  if (rawDocument.schemaVersion === 1) {
    requireExactKeys(rawDocument, ['schemaVersion', 'window'], 'state');
    migratedDocument = {
      ...rawDocument,
      schemaVersion: STATE_SCHEMA_VERSION,
      activeWorkspaceId: null,
      workspaceLayouts: {},
    };
  } else if (rawDocument.schemaVersion === 2) {
    requireExactKeys(rawDocument, ['schemaVersion', 'window', 'activeWorkspaceId'], 'state');
    migratedDocument = {
      ...rawDocument,
      schemaVersion: STATE_SCHEMA_VERSION,
      workspaceLayouts: {},
    };
  }
  const document = requireExactKeys(
    migratedDocument,
    ['schemaVersion', 'window', 'activeWorkspaceId', 'workspaceLayouts'],
    'state',
  );
  if (typeof document.schemaVersion === 'number'
      && Number.isInteger(document.schemaVersion)
      && document.schemaVersion > STATE_SCHEMA_VERSION) {
    throw new ConfigurationError(
      `state schema ${document.schemaVersion} is newer than supported schema ${STATE_SCHEMA_VERSION}`,
      'future_schema',
    );
  }
  if (document.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new ConfigurationError(`state.schemaVersion must be 1, 2, or ${STATE_SCHEMA_VERSION}`);
  }
  const window = requireExactKeys(document.window, ['width', 'height'], 'state.window');
  const width = requireWindowDimension(window.width, 'width');
  const height = requireWindowDimension(window.height, 'height');
  const activeWorkspaceId = document.activeWorkspaceId === null
    ? null
    : requireIdentifier(document.activeWorkspaceId, 'state.activeWorkspaceId', 64);

  const rawWorkspaceLayouts = requireObject(document.workspaceLayouts, 'state.workspaceLayouts');
  const layoutEntries = Object.entries(rawWorkspaceLayouts);
  if (layoutEntries.length > MAX_STATE_WORKSPACE_LAYOUTS) {
    throw new ConfigurationError(
      `state.workspaceLayouts may contain at most ${MAX_STATE_WORKSPACE_LAYOUTS} workspaces`,
    );
  }
  let totalLeaves = 0;
  const workspaceLayouts = Object.fromEntries(layoutEntries.map(([workspaceId, rawLayout]) => {
    requireIdentifier(workspaceId, `state.workspaceLayouts workspace id '${workspaceId}'`, 64);
    try {
      const layout = validateWorkspaceLayoutState(rawLayout);
      totalLeaves += orderedDepthFirstPanes(layout).length;
      if (totalLeaves > MAX_STATE_LAYOUT_LEAVES) {
        throw new ConfigurationError(
          `state.workspaceLayouts may contain at most ${MAX_STATE_LAYOUT_LEAVES} panes in total`,
        );
      }
      return [workspaceId, layout];
    } catch (error) {
      if (error instanceof ConfigurationError) throw error;
      throw new ConfigurationError(
        `state.workspaceLayouts.${workspaceId} is invalid: ${errorMessage(error)}`,
      );
    }
  }));

  const state: DesktopState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    window: {
      width: Math.max(MIN_WINDOW_WIDTH, width),
      height: Math.max(MIN_WINDOW_HEIGHT, height),
    },
    activeWorkspaceId,
    workspaceLayouts,
  };
  requireStateSize(state);
  return state;
}

export function applyEnvironmentOverrides(config: DesktopConfig, env: unknown): DesktopConfig {
  if (!isObjectRecord(env)) {
    throw new ConfigurationError('environment must be an object');
  }
  const environment = env;
  const effective = cloneJson(config);
  if (environment.NEONCODE_HUB_ENDPOINT) {
    effective.hub.endpoint = validateEndpoint(environment.NEONCODE_HUB_ENDPOINT);
  }
  if (environment.NEONCODE_SESSION_PREFIX) {
    effective.sessionPrefix = requireIdentifier(
      environment.NEONCODE_SESSION_PREFIX,
      'config.sessionPrefix',
      96,
    );
  }
  if (environment.NEONCODE_TERMINAL_COUNT) {
    const countText = environment.NEONCODE_TERMINAL_COUNT;
    const count = typeof countText === 'string' ? Number.parseInt(countText, 10) : Number.NaN;
    if (!Number.isInteger(count) || count < 1 || count > MAX_PANES_PER_WORKSPACE) {
      throw new ConfigurationError(`NEONCODE_TERMINAL_COUNT must be between 1 and ${MAX_PANES_PER_WORKSPACE}`);
    }
    effective.workspaces = effective.workspaces.map((workspace) => ({
      ...workspace,
      layout: { columns: Math.min(workspace.layout.columns, count, workspace.sessions.length) },
      sessions: workspace.sessions.slice(0, count),
    }));
  }
  if (environment.NEONCODE_PERSIST_SESSIONS) {
    if (typeof environment.NEONCODE_PERSIST_SESSIONS !== 'string') {
      throw new ConfigurationError('NEONCODE_PERSIST_SESSIONS must be a string');
    }
    effective.persistence.onWindowClose = environment.NEONCODE_PERSIST_SESSIONS === '0'
      ? 'kill'
      : 'detach';
  }
  return effective;
}

function readJsonFile(filePath: string, maximumBytes: number): unknown {
  const stat = fs.statSync(filePath);
  if (stat.size > maximumBytes) {
    throw new ConfigurationError(`${path.basename(filePath)} exceeds ${maximumBytes} bytes`);
  }
  const document: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return document;
}

function flushDirectory(directory: string): void {
  let descriptor: number | undefined;
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

export function writeJsonAtomic(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  let descriptor: number | undefined;
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

export class ConfigStore {
  readonly directory: string;
  readonly configPath: string;
  readonly configBackupPath: string;
  readonly statePath: string;
  readonly stateBackupPath: string;

  constructor(directory: unknown) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
      throw new ConfigurationError('configuration directory must be absolute');
    }
    this.directory = directory;
    this.configPath = path.join(directory, 'config.json');
    this.configBackupPath = `${this.configPath}.bak`;
    this.statePath = path.join(directory, 'state.json');
    this.stateBackupPath = `${this.statePath}.bak`;
  }

  cleanTemporaryFiles(): void {
    if (!fs.existsSync(this.directory)) {
      return;
    }
    for (const name of fs.readdirSync(this.directory)) {
      if (/^\.(config|state)\.json\.tmp-/.test(name)) {
        fs.rmSync(path.join(this.directory, name), { force: true });
      }
    }
  }

  preserveInvalid(filePath: string): string | undefined {
    if (!fs.existsSync(filePath)) {
      return undefined;
    }
    const preserved = `${filePath}.invalid-${Date.now()}`;
    fs.copyFileSync(filePath, preserved, fs.constants.COPYFILE_EXCL);
    return preserved;
  }

  loadPreservedLegacyTerminal(): UnknownRecord | undefined {
    if (!fs.existsSync(this.directory)) return undefined;
    const candidates = fs.readdirSync(this.directory)
      .filter((name) => name.startsWith('config.json.pre-migration-'))
      .sort()
      .reverse();
    for (const name of candidates) {
      try {
        const document = readJsonFile(path.join(this.directory, name), MAX_CONFIG_BYTES);
        if (isPlainObject(document) && isPlainObject(document.terminal)) return document.terminal;
      } catch {
        // Try an older preserved file.
      }
    }
    return undefined;
  }

  validateStoredConfig(filePath: string): ConfigValidationResult {
    return validateConfig(readJsonFile(filePath, MAX_CONFIG_BYTES), {
      legacyTerminal: this.loadPreservedLegacyTerminal(),
    });
  }

  preserveForMigration(warnings: string[]): void {
    const preserved = `${this.configPath}.pre-migration-${Date.now()}`;
    try {
      fs.copyFileSync(this.configPath, preserved, fs.constants.COPYFILE_EXCL);
      warnings.push(`legacy config.json was preserved as ${path.basename(preserved)}`);
    } catch (error) {
      warnings.push(`legacy config.json could not be preserved before migration: ${errorMessage(error)}`);
    }
  }

  preserveInvalidSafely(filePath: string, warnings: string[], label: string): string | undefined {
    try {
      const preserved = this.preserveInvalid(filePath);
      if (preserved) {
        warnings.push(`${label} was preserved as ${path.basename(preserved)}`);
      }
      return preserved;
    } catch (error) {
      warnings.push(`${label} could not be preserved: ${errorMessage(error)}`);
      return undefined;
    }
  }

  loadConfig(): ConfigLoadResult {
    const warnings: string[] = [];
    if (!fs.existsSync(this.configPath)) {
      if (!fs.existsSync(this.configBackupPath)) {
        const created = defaultConfig();
        writeJsonAtomic(this.configPath, created);
        try {
          writeJsonAtomic(this.configBackupPath, created);
        } catch (error) {
          warnings.push(`config.json.bak could not be created: ${errorMessage(error)}`);
        }
        return { config: created, status: 'created', warnings, errors: [] };
      }

      let recovered: DesktopConfig;
      try {
        recovered = this.validateStoredConfig(this.configBackupPath).value;
      } catch (backupError) {
        this.preserveInvalidSafely(this.configBackupPath, warnings, 'unusable config.json.bak');
        return {
          config: null,
          status: 'error',
          warnings,
          errors: [`config.json is missing and config.json.bak is unusable: ${errorMessage(backupError)}`],
        };
      }
      try {
        writeJsonAtomic(this.configPath, recovered);
        warnings.push('config.json was missing and was restored from config.json.bak');
      } catch (error) {
        warnings.push(`config.json could not be restored from its valid backup: ${errorMessage(error)}`);
      }
      return { config: recovered, status: 'recovered', warnings, errors: [] };
    }

    let primaryResult: ConfigValidationResult;
    try {
      primaryResult = this.validateStoredConfig(this.configPath);
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
          errors: [`config.json is invalid: ${errorMessage(primaryError)}`],
        };
      }

      let recovered: DesktopConfig;
      try {
        recovered = this.validateStoredConfig(this.configBackupPath).value;
      } catch (backupError) {
        return {
          config: null,
          status: 'error',
          warnings,
          errors: [
            `config.json is invalid: ${errorMessage(primaryError)}`,
            `config.json.bak is unusable: ${errorMessage(backupError)}`,
          ],
        };
      }
      try {
        writeJsonAtomic(this.configPath, recovered);
        warnings.push('config.json was restored from config.json.bak');
      } catch (error) {
        warnings.push(`config.json could not be restored from its valid backup: ${errorMessage(error)}`);
      }
      return { config: recovered, status: 'recovered', warnings, errors: [] };
    }

    if (primaryResult.migrated) {
      this.preserveForMigration(warnings);
      try {
        writeJsonAtomic(this.configPath, primaryResult.value);
        const importedLegacyTerminal = primaryResult.migrationSource === 'legacy_terminal'
          || primaryResult.migrationSource === 'schema_1_legacy_terminal';
        const migrationDetail = importedLegacyTerminal
          ? '; compatible legacy terminal appearance settings were imported'
          : '';
        warnings.push(`config.json was migrated to schema ${CONFIG_SCHEMA_VERSION}${migrationDetail}`);
      } catch (error) {
        warnings.push(`migrated config.json could not be persisted: ${errorMessage(error)}`);
      }
    }
    try {
      writeJsonAtomic(this.configBackupPath, primaryResult.value);
    } catch (error) {
      warnings.push(`config.json.bak could not be refreshed: ${errorMessage(error)}`);
    }
    return {
      config: primaryResult.value,
      status: primaryResult.migrated ? 'migrated' : 'loaded',
      warnings,
      errors: [],
    };
  }

  loadState(): StateLoadResult {
    const warnings: string[] = [];
    if (fs.existsSync(this.statePath)) {
      let state: DesktopState | undefined;
      let stateMigrated = false;
      try {
        const rawState = readJsonFile(this.statePath, MAX_STATE_BYTES);
        stateMigrated = !isPlainObject(rawState) || rawState.schemaVersion !== STATE_SCHEMA_VERSION;
        state = validateState(rawState);
      } catch (error) {
        this.preserveInvalidSafely(this.statePath, warnings, 'invalid state.json');
        warnings.push(`state.json will be recovered or reset: ${errorMessage(error)}`);
      }
      if (state) {
        if (stateMigrated) {
          try {
            writeJsonAtomic(this.statePath, state);
            warnings.push(`state.json was migrated to schema ${STATE_SCHEMA_VERSION}`);
          } catch (error) {
            warnings.push(`migrated state.json could not be persisted: ${errorMessage(error)}`);
          }
        }
        try {
          writeJsonAtomic(this.stateBackupPath, state);
        } catch (error) {
          warnings.push(`state.json.bak could not be refreshed: ${errorMessage(error)}`);
        }
        return { state, status: stateMigrated ? 'migrated' : 'loaded', warnings };
      }
    }

    if (fs.existsSync(this.stateBackupPath)) {
      try {
        const recovered = validateState(readJsonFile(this.stateBackupPath, MAX_STATE_BYTES));
        try {
          writeJsonAtomic(this.statePath, recovered);
          warnings.push('state.json was restored from state.json.bak');
        } catch (error) {
          warnings.push(`state.json could not be restored from its valid backup: ${errorMessage(error)}`);
        }
        return { state: recovered, status: 'recovered', warnings };
      } catch (error) {
        this.preserveInvalidSafely(this.stateBackupPath, warnings, 'unusable state.json.bak');
        warnings.push(`state.json.bak could not be used: ${errorMessage(error)}`);
      }
    }

    const state = defaultState();
    writeJsonAtomic(this.statePath, state);
    try {
      writeJsonAtomic(this.stateBackupPath, state);
    } catch (error) {
      warnings.push(`state.json.bak could not be created: ${errorMessage(error)}`);
    }
    return { state, status: 'created', warnings };
  }

  load(env: unknown = process.env): DesktopBootstrapResult {
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
        errors.push(`environment override is invalid: ${errorMessage(error)}`);
      }
    }
    const diagnostics: DesktopDiagnostics = {
      configStatus: configResult.status,
      stateStatus: stateResult.status,
      warnings: [...configResult.warnings, ...stateResult.warnings],
      errors,
    };
    return {
      config: effectiveConfig,
      state: stateResult.state,
      diagnostics,
    };
  }

  getStoredSettings(): DesktopSettings {
    if (!fs.existsSync(this.configPath)) {
      throw new ConfigurationError('config.json is missing');
    }
    return settingsFromConfig(this.validateStoredConfig(this.configPath).value);
  }

  getStoredWorkspaces(): DesktopWorkspaceConfig[] {
    if (!fs.existsSync(this.configPath)) {
      throw new ConfigurationError('config.json is missing');
    }
    return cloneJson(this.validateStoredConfig(this.configPath).value.workspaces);
  }

  saveWorkspaceCatalog(workspaces: unknown): DesktopConfig {
    if (!fs.existsSync(this.configPath)) {
      throw new ConfigurationError('config.json is missing');
    }
    const previous = this.validateStoredConfig(this.configPath).value;
    const withCatalog = validateConfig({
      ...previous,
      workspaces,
      schemaVersion: CONFIG_SCHEMA_VERSION,
    }).value;
    const remainingWorkspaceIds = new Set(withCatalog.workspaces.map((workspace) => workspace.id));
    const remainingPaneIds = new Set(
      withCatalog.workspaces.flatMap((workspace) => workspace.sessions.map((session) => session.id)),
    );
    const keybindings = {
      overrides: withCatalog.keybindings.overrides.filter(({ command }) => {
        if (command.id === 'workspace.open'
            || command.id === 'workspace.dismissAttention'
            || command.id === 'workspace.rename'
            || command.id === 'workspace.delete') {
          return remainingWorkspaceIds.has(command.args.workspaceId);
        }
        if (command.id === 'pane.focus') return remainingPaneIds.has(command.args.paneId);
        return true;
      }),
    };
    const replacement = validateConfig({ ...withCatalog, keybindings }).value;
    writeJsonAtomic(this.configBackupPath, previous);
    writeJsonAtomic(this.configPath, replacement);
    return replacement;
  }

  saveSettings(settings: unknown): DesktopConfig {
    if (!fs.existsSync(this.configPath)) {
      throw new ConfigurationError('config.json is missing');
    }
    const previous = this.validateStoredConfig(this.configPath).value;
    const validatedSettings = validateSettingsForConfig(settings, previous);
    const replacement = validateConfig({
      ...previous,
      ...validatedSettings,
      schemaVersion: CONFIG_SCHEMA_VERSION,
    }).value;
    writeJsonAtomic(this.configBackupPath, previous);
    writeJsonAtomic(this.configPath, replacement);
    return replacement;
  }

  saveState(state: unknown): DesktopState {
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

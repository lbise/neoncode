import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from 'node:child_process';

export const TOKEN_PATTERN = /^[0-9a-fA-F]{64}$/;

export type HubTokenSource = 'environment' | 'wsl';

export interface HubTokenResult {
  token: string;
  source: HubTokenSource;
}

export interface TokenCommandResult {
  error?: unknown;
  status: unknown;
  stdout?: unknown;
  stderr?: unknown;
}

export type TokenSpawn = (
  command: string,
  arguments_: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => TokenCommandResult;

export interface EnsureWslHubTokenOptions {
  spawn?: TokenSpawn;
}

export interface LoadHubTokenOptions {
  env?: unknown;
  platform?: unknown;
  spawn?: TokenSpawn;
}

type UnknownRecord = Record<string, unknown>;

const ENSURE_WSL_TOKEN_SCRIPT = `set -eu
token_file="\${XDG_STATE_HOME:-$HOME/.local/state}/neoncode/hub-token"
token_dir=$(dirname "$token_file")
umask 077
mkdir -p "$token_dir"
chmod 700 "$token_dir"
if [ -L "$token_file" ]; then
  echo "hub token path must not be a symlink: $token_file" >&2
  exit 2
fi
if [ -e "$token_file" ]; then
  if [ ! -f "$token_file" ]; then
    echo "hub token path must be a regular file: $token_file" >&2
    exit 2
  fi
  token=$(tr -d '\r\n' < "$token_file")
  case "$token" in
    *[!0123456789abcdefABCDEF]*|'')
      echo "hub token file is malformed: expected 64 hexadecimal characters" >&2
      exit 2
      ;;
  esac
  if [ \${#token} -ne 64 ]; then
    echo "hub token file is malformed: expected 64 hexadecimal characters" >&2
    exit 2
  fi
  chmod 600 "$token_file"
  printf '%s\n' "$token"
  exit 0
fi
token=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
temporary=$(mktemp "$token_dir/.hub-token.tmp.XXXXXX")
if ! printf '%s\n' "$token" > "$temporary"; then
  rm -f "$temporary"
  exit 1
fi
chmod 600 "$temporary"
mv -f "$temporary" "$token_file"
printf '%s\n' "$token"
`;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function outputText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function validateToken(token: unknown, source: string): string {
  const normalized = String(token || '').trim();
  if (!TOKEN_PATTERN.test(normalized)) {
    throw new Error(`${source} must provide exactly 64 hexadecimal characters`);
  }
  return normalized;
}

export function ensureWslHubToken({
  spawn = spawnSync,
}: EnsureWslHubTokenOptions = {}): HubTokenResult {
  const result = spawn(
    'wsl.exe',
    ['--exec', 'sh', '-c', ENSURE_WSL_TOKEN_SCRIPT],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    },
  );
  if (result.error) {
    throw new Error(`failed to ensure the WSL hub token: ${errorMessage(result.error)}`);
  }
  if (result.status !== 0) {
    const detail = outputText(result.stderr).trim() || `wsl.exe exited ${String(result.status)}`;
    throw new Error(`failed to ensure the WSL hub token: ${detail}`);
  }
  return {
    token: validateToken(result.stdout, 'WSL hub token file'),
    source: 'wsl',
  };
}

export function loadHubToken({
  env = process.env,
  platform = process.platform,
  spawn = spawnSync,
}: LoadHubTokenOptions = {}): HubTokenResult {
  if (!isRecord(env)) {
    throw new Error('hub token environment must be an object');
  }

  const environmentToken = env.NEONCODE_HUB_TOKEN;
  if (environmentToken) {
    return {
      token: validateToken(environmentToken, 'NEONCODE_HUB_TOKEN'),
      source: 'environment',
    };
  }
  if (platform !== 'win32') {
    throw new Error('NEONCODE_HUB_TOKEN is required outside the Windows desktop runtime');
  }

  return ensureWslHubToken({ spawn });
}

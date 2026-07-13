const { spawnSync } = require('node:child_process');

const TOKEN_PATTERN = /^[0-9a-fA-F]{64}$/;

function validateToken(token, source) {
  const normalized = String(token || '').trim();
  if (!TOKEN_PATTERN.test(normalized)) {
    throw new Error(`${source} must provide exactly 64 hexadecimal characters`);
  }
  return normalized;
}

function loadHubToken({ env = process.env, platform = process.platform, spawn = spawnSync } = {}) {
  if (env.NEONCODE_HUB_TOKEN) {
    return { token: validateToken(env.NEONCODE_HUB_TOKEN, 'NEONCODE_HUB_TOKEN'), source: 'environment' };
  }
  if (platform !== 'win32') {
    throw new Error('NEONCODE_HUB_TOKEN is required outside the Windows desktop runtime');
  }

  const result = spawn(
    'wsl.exe',
    [
      '--exec',
      'sh',
      '-c',
      'token_file="${XDG_STATE_HOME:-$HOME/.local/state}/neoncode/hub-token"; cat "$token_file"',
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    },
  );
  if (result.error) {
    throw new Error(`failed to read the WSL hub token: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`failed to read the WSL hub token: ${(result.stderr || '').trim() || `wsl.exe exited ${result.status}`}`);
  }
  return { token: validateToken(result.stdout, 'WSL hub token file'), source: 'wsl' };
}

module.exports = {
  TOKEN_PATTERN,
  loadHubToken,
  validateToken,
};

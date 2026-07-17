#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function npmComponents(root) {
  const lock = readJson(path.join(root, 'frontends/electron/package-lock.json'));
  const packages = lock.packages && typeof lock.packages === 'object' ? lock.packages : {};
  return Object.entries(packages)
    .filter(([packagePath, entry]) => packagePath && entry && entry.version)
    .map(([packagePath, entry]) => ({
      ecosystem: 'npm',
      name: entry.name || packagePath.replace(/^node_modules\//, ''),
      version: entry.version,
      scope: entry.dev ? 'development' : 'runtime',
      path: packagePath,
      resolved: entry.resolved || null,
      integrity: entry.integrity || null,
    }))
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}

function cargoComponents(root) {
  const output = execFileSync('cargo', ['metadata', '--format-version', '1'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const metadata = JSON.parse(output);
  return metadata.packages.map((pkg) => ({
    ecosystem: 'cargo',
    name: pkg.name,
    version: pkg.version,
    id: pkg.id,
    source: pkg.source || null,
    license: pkg.license || null,
  })).sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}

const root = path.resolve(arg('--root', process.cwd()));
const output = path.resolve(arg('--output', path.join(root, 'release/windows-alpha/sbom.json')));
const version = arg('--version', '0.0.0');
const gitSha = arg('--git-sha', 'unknown');

const sbom = {
  schemaVersion: 1,
  format: 'neoncode-simple-sbom',
  product: 'NeonCode',
  channel: 'alpha',
  version,
  gitSha,
  generatedAtUtc: new Date().toISOString(),
  components: [...npmComponents(root), ...cargoComponents(root)],
};

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(sbom, null, 2)}\n`);
console.log(`Wrote SBOM with ${sbom.components.length} components: ${output}`);

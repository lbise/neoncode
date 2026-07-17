const fs = require('node:fs');
const path = require('node:path');
const {
  flipFuses,
  getCurrentFuseWire,
  FuseVersion,
  FuseV1Options,
  FuseState,
} = require('@electron/fuses');

function executableName(context) {
  const productFilename = context.packager?.appInfo?.productFilename || 'NeonCode';
  return `${productFilename}.exe`;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const executablePath = path.join(context.appOutDir, executableName(context));
  const fuseConfig = {
    version: FuseVersion.V1,
    strictlyRequireAllFuses: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
    [FuseV1Options.WasmTrapHandlers]: true,
  };

  await flipFuses(executablePath, fuseConfig);
  const fuseWire = await getCurrentFuseWire(executablePath);
  const fuseValue = (value) => {
    if (value === FuseState.ENABLE) return true;
    if (value === FuseState.DISABLE) return false;
    return value;
  };
  const report = {
    schemaVersion: 1,
    generatedAtUtc: new Date().toISOString(),
    platform: context.electronPlatformName,
    arch: context.arch,
    executable: path.basename(executablePath),
    fuses: Object.fromEntries(Object.entries(FuseV1Options)
      .filter(([name]) => Number.isNaN(Number(name)))
      .map(([name, index]) => [name, fuseValue(fuseWire[index])])),
  };
  const outputPath = path.join(context.outDir, 'neoncode-fuses.json');
  fs.mkdirSync(context.outDir, { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
};

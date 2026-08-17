// Installs the published @deepseek-ai/dsh harness runtime into harness/, so
// electron-builder can bundle it via extraResources. Uses the same native-module
// allowlist as the AUR PKGBUILD: node-pty/koffi/subprocess-local need their
// install scripts; @google/genai and protobufjs are no-ops left blocked.
//
// The version comes from package.json, or from the DSH_UPSTREAM_VERSION
// environment variable (used by CI for one-off builds of a specific release).
'use strict';

const { execSync } = require('node:child_process');
const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const harnessDir = path.join(root, 'harness');
const version =
  process.env.DSH_UPSTREAM_VERSION ||
  require(path.join(root, 'package.json')).version;

const manifest = {
  name: 'dsh-electron-harness',
  private: true,
  allowScripts: {
    'node-pty': true,
    koffi: true,
    '@deepseek-ai/dsh-subprocess-local': true,
  },
  dependencies: { '@deepseek-ai/dsh': version },
};

mkdirSync(harnessDir, { recursive: true });
writeFileSync(path.join(harnessDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');

const bin = path.join(harnessDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
if (existsSync(bin)) {
  console.log('[dsh-desktop] harness already installed; skipping (version ' + version + ')');
  process.exit(0);
}
console.log('[dsh-desktop] installing @deepseek-ai/dsh@' + version + ' (this takes a few minutes)');
execSync('npm install --no-audit --no-fund', { cwd: harnessDir, stdio: 'inherit' });
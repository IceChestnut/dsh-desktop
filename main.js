// Personal Electron shell for the DeepSeek Harness web GUI.
//
// This shell does NOT embed the harness. It spawns the same command you would
// run in a terminal (`pnpm dsh web --port 8642` by default), waits for the
// HTTP server, then opens a plain BrowserWindow pointed at http://127.0.0.1:8642.
// Closing the window tears the whole backend tree down with it, so there is no
// terminal to mis-close and no orphaned server. The harness keeps running under
// the system Node it already requires (^22.19 || >=24), so none of its native
// deps (node:sqlite, node-pty, sharp) are ever loaded into Electron's Node.
//
// Cross-platform:
//   Windows  resolves .cmd/.ps1 binaries through cmd.exe and kills the tree
//            with `taskkill /T /F`.
//   POSIX    runs the child detached (its own process group), signals SIGINT
//            first so the harness runs its own graceful teardown, then SIGKILL.

'use strict';

const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn, execFile } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const IS_WIN = process.platform === 'win32';

// Stable config dir across source/packaged runs and platforms (Linux ~/.config,
// macOS ~/Library/Application Support, Windows %APPDATA%).
app.setName('dsh-desktop');
const CONFIG_DIR = app.getPath('userData');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// ---------------------------------------------------------------------------
// Configuration. Resolution order: environment variable > config.json > default.
//   DSH_BIN    program to run (e.g. "dsh" when dsh is installed on PATH)
//   DSH_ARGS   space-separated extra args appended to the command (no spaces inside)
//   DSH_CWD    working directory (default: repository root in source mode)
//   DSH_PORT   port (default 8642)
//   DSH_HOST   bind host (default 127.0.0.1; the web app rejects 0.0.0.0 anyway)
// ---------------------------------------------------------------------------
const DEFAULTS = { port: 8642, host: '127.0.0.1' };

function readConfigFile() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
  } catch (err) {
    console.error('[dsh-desktop] could not read ' + CONFIG_FILE + ':', err.message);
    return {};
  }
}

// Resolve a system Node runtime (the harness needs ^22.19 || >=24, which
// Electron's bundled Node does not meet). Prefer the mise-managed Node, then a
// system install, then whatever `node` resolves to on PATH.
function resolveNode() {
  const candidates = [
    process.env.DSH_NODE,
    path.join(os.homedir(), '.local', 'share', 'mise', 'installs', 'node', 'latest', 'bin', 'node'),
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'node';
}

// Discover an existing built harness checkout (apps/cli/lib/bin.js). Used only
// when packaged and no explicit cwd/command is configured.
function discoverHarnessDir() {
  const candidates = [
    process.env.DSH_HARNESS_DIR,
    path.join(os.homedir(), 'repo', 'github.com', 'deepseek-ai', 'deepseek-harness'),
    path.join(os.homedir(), 'deepseek-harness'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'apps', 'cli', 'lib', 'bin.js'))) return c;
  }
  return undefined;
}

// The harness runtime bundled via electron-builder extraResources, when present.
function bundledHarnessDir() {
  const dir = path.join(process.resourcesPath, 'harness');
  return fs.existsSync(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')) ? dir : undefined;
}

function resolveConfig() {
  const file = readConfigFile();
  const cfg = {
    port: Number(process.env.DSH_PORT || file.port || DEFAULTS.port),
    host: process.env.DSH_HOST || file.host || DEFAULTS.host,
    command: process.env.DSH_COMMAND || file.command || undefined,
    bin: process.env.DSH_BIN || file.bin || undefined,
    args: String(process.env.DSH_ARGS || file.args || '').split(/\s+/).filter(Boolean),
    cwd: process.env.DSH_CWD || file.cwd || undefined,
  };
  if (!cfg.cwd) {
    // Source mode (electron .): the repository root is the parent of this dir.
    if (!app.isPackaged) {
      cfg.cwd = path.resolve(__dirname, '..');
    } else {
      // Packaged: discover an existing harness checkout on this machine.
      cfg.cwd = discoverHarnessDir();
    }
  }
  return cfg;
}

function buildCommand(cfg) {
  if (cfg.command) {
    const parts = cfg.command.split(/\s+/).filter(Boolean);
    return { cmd: parts[0], args: parts.slice(1), cwd: cfg.cwd };
  }
  const base = ['web', '--port', String(cfg.port), '--host', cfg.host];
  if (cfg.bin) {
    return { cmd: cfg.bin, args: [...base, ...cfg.args], cwd: cfg.cwd };
  }
  if (app.isPackaged) {
    // Packaged: run the backend under a system Node (Electron's bundled Node is
    // too old for the harness). Prefer the bundled harness, then a discovered
    // checkout.
    const bundled = bundledHarnessDir();
    if (bundled) {
      return { cmd: resolveNode(), args: [path.join(bundled, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), ...base, ...cfg.args], cwd: bundled };
    }
    if (cfg.cwd) {
      return { cmd: resolveNode(), args: [path.join(cfg.cwd, 'apps', 'cli', 'lib', 'bin.js'), ...base, ...cfg.args], cwd: cfg.cwd };
    }
  }
  // Source mode: via the root package.json "dsh" script.
  return { cmd: 'pnpm', args: ['dsh', ...base, ...cfg.args], cwd: cfg.cwd };
}

// ---------------------------------------------------------------------------
// Backend lifecycle
// ---------------------------------------------------------------------------
let backend = null;
let quitting = false;

function startBackend(cfg) {
  const { cmd, args, cwd } = buildCommand(cfg);
  if (!cwd || !fs.existsSync(cwd)) {
    throw new Error(
      'Backend working directory does not exist: ' + cwd + '\n' +
      'Set DSH_CWD, DSH_HARNESS_DIR (or "cwd"/"command" in ' + CONFIG_FILE + ') to a built DeepSeek Harness checkout.'
    );
  }

  console.log('[dsh-desktop] starting backend: ' + cmd + ' ' + args.join(' ') + '  (cwd=' + cwd + ')');

  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env },
    detached: !IS_WIN, // POSIX: own process group so the whole tree is signalable
    shell: IS_WIN,     // Windows: resolve .cmd/.ps1; child.pid becomes the cmd.exe root
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));
  child.once('error', (err) => {
    console.error('[dsh-desktop] spawn error:', err.message);
    onBackendDied(new Error('Could not start "' + cmd + '": ' + err.message));
  });
  child.on('exit', (code, signal) => {
    if (backend !== child) return;
    backend = null;
    console.log('[dsh-desktop] backend exited (code=' + code + ', signal=' + signal + ')');
    if (!quitting) onBackendDied(null);
  });

  backend = child;
  return child;
}

let reportedDied = false;
function onBackendDied(err) {
  if (reportedDied) return;
  reportedDied = true;
  let msg = 'The DeepSeek Harness backend stopped unexpectedly.';
  if (err) msg = err.message;
  msg += '\n\nCheck that the harness is built (pnpm run build) and that "pnpm" or "dsh" is on PATH.';
  dialog.showErrorBox('DeepSeek Harness stopped', msg);
  app.quit();
}

// SIGINT first so the harness runs its own teardown (it sweeps managed tool
// trees on exit); SIGKILL after the grace if it lingers. Windows tree support
// is best-effort, matching dsh-subprocess-local itself.
function terminateTree(child, graceMs = 2500) {
  if (!child || child.exitCode !== null) return;
  if (IS_WIN) {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {});
    return;
  }
  try { process.kill(-child.pid, 'SIGINT'); }
  catch { try { process.kill(child.pid, 'SIGINT'); } catch {} }
  const t = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch { try { process.kill(child.pid, 'SIGKILL'); } catch {} }
  }, graceMs);
  child.once('exit', () => clearTimeout(t));
}

function waitForServer(cfg, child, timeoutMs = 60000) {
  const url = 'http://' + cfg.host + ':' + cfg.port + '/';
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      if (child.exitCode !== null) {
        return reject(new Error('Backend exited before the server came up.'));
      }
      if (Date.now() > deadline) {
        return reject(new Error('Timed out waiting for ' + url));
      }
      const req = http.get(url, (res) => { res.resume(); resolve(); });
      req.on('error', () => setTimeout(poll, 400));
      req.setTimeout(2000, () => { req.destroy(); setTimeout(poll, 400); });
    })();
  });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
let win = null;

const LOADING_HTML = '<!doctype html><html><head><meta charset="utf-8"><style>' +
  'body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;' +
  'background:#0d1117;color:#c9d1d9;font:15px system-ui,sans-serif}' +
  '.box{text-align:center}.dot{display:inline-block;width:8px;height:8px;margin:0 3px;' +
  'border-radius:50%;background:#58a6ff;animation:b 1.2s infinite}' +
  '.dot:nth-child(2){animation-delay:.2s}.dot:nth-child(3){animation-delay:.4s}' +
  '@keyframes b{0%,100%{opacity:.2}50%{opacity:1}}' +
  '</style></head><body><div class="box"><div>' +
  '<span class="dot"></span><span class="dot"></span><span class="dot"></span>' +
  '</div><p>Starting DeepSeek Harness&hellip;</p></div></body></html>';

function createWindow() {
  const w = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    autoHideMenuBar: true,
    backgroundColor: '#0d1117',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(LOADING_HTML));
  w.once('ready-to-show', () => w.show());
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  w.on('closed', () => { win = null; });
  win = w;
  return w;
}

// ---------------------------------------------------------------------------
// App flow
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(main);
}

async function main() {
  const cfg = resolveConfig();
  const w = createWindow();
  try {
    const child = startBackend(cfg);
    await waitForServer(cfg, child);
    if (quitting) return;
    await w.loadURL('http://' + cfg.host + ':' + cfg.port + '/');
    w.show();
  } catch (err) {
    terminateTree(backend);
    dialog.showErrorBox('DeepSeek Harness failed to start', err && err.message ? err.message : String(err));
    app.quit();
  }
}

// Closing the window stops everything on every platform (personal-use choice;
// there is no background backend to keep alive).
app.on('window-all-closed', () => app.quit());

let teardownDone = false;
app.on('before-quit', (event) => {
  if (teardownDone || !backend) return;
  event.preventDefault();
  quitting = true;
  terminateTree(backend, 2000);
  const done = () => { teardownDone = true; app.quit(); };
  backend.once('exit', done);
  setTimeout(done, 2500); // safety net if the backend never reports exit
});

// Last-resort synchronous sweep in case before-quit raced a fast quit.
app.on('will-quit', () => { terminateTree(backend); });

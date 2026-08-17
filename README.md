# dsh-desktop

Electron shell for the DeepSeek Harness web GUI. Standalone project: the shell
code lives here and the harness itself is pulled from the published
`@deepseek-ai/dsh` npm package at build time — no upstream source checkout, no
fork to keep in sync. Transitional until the official desktop build ships.

## What it does

Double-click the app (or run `npm start`). The shell spawns the same command you
would type in a terminal — `dsh web --port 8642` by default — in the background,
waits for the HTTP server, then opens a plain window pointed at
`http://127.0.0.1:8642`. Closing the window tears the whole backend tree down
with it: no terminal to mis-close, no orphaned server.

The harness is **not** embedded in Electron. It runs under the system Node it
already requires (`^22.19 || >=24`), so its native dependencies (`node:sqlite`,
`node-pty`, `sharp`) are never loaded into Electron's Node and need no ABI
rebuild.

## Requirements

- Node `^22.19 || >=24`
- Windows / macOS / Linux (build packages natively on each OS)

## Run from source

```sh
npm install
npm start          # electron .
```

## Build local packages (this machine only)

electron-builder cannot reliably cross-compile (the harness bundles native
modules built for the build machine), so run each on its own OS:

```sh
npm run dist       # Linux:   AppImage
npm run dist:win   # Windows: portable .exe
npm run dist:mac   # macOS:   zip
```

Artifacts land in `dist/`.

## CI (GitHub Actions, hosted runners only)

- `.github/workflows/build.yml` — three-platform build matrix
  (`ubuntu-latest`, `windows-2025`, `macos-latest`), each building its native
  package and uploading it to the build. A push of a `v*` tag additionally
  publishes the packages to a GitHub Release.
- `.github/workflows/sync-upstream.yml` — polls the npm registry
  (`dist-tags.latest` of `@deepseek-ai/dsh`, every 6 hours or on manual
  dispatch). On a new upstream release it bumps `package.json`, commits, tags
  `v<version>`, and pushes — which triggers the release build above. The whole
  chain is automatic; the source of truth is the npm registry, not upstream's
  GitHub releases (which we cannot subscribe to cross-repo).

## Configuration

Copy `config.example.json` next to the app's user-data directory as
`config.json`, or use environment variables. Resolution order: environment
variable > `config.json` > default. The user-data directory is
`~/.config/dsh-desktop` on Linux, `~/Library/Application Support/dsh-desktop`
on macOS, `%APPDATA%\dsh-desktop` on Windows.

| Env var | `config.json` key | Default | Meaning |
|---|---|---|---|
| `DSH_COMMAND` | `command` | — | **Full command override** (program + args, no spaces inside an arg). Takes priority over everything below. |
| `DSH_BIN` | `bin` | — | Program to run; set to `dsh` when dsh is installed on PATH. Unset = bundled harness. |
| `DSH_CWD` | `cwd` | bundled harness dir | Working directory for the backend. |
| `DSH_PORT` | `port` | `8642` | Backend port. |
| `DSH_HOST` | `host` | `127.0.0.1` | Bind host (the web app rejects `0.0.0.0`). |
| `DSH_ARGS` | `args` | — | Extra space-separated args (no spaces inside each arg). |
| `DSH_NODE` | — | — | System Node binary to run the harness with (auto-detected otherwise). |

## License

MIT (shell code). The bundled harness is `@deepseek-ai/dsh` under its own
license.
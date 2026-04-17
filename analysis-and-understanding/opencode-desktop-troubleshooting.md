# OpenCode Desktop — Local Dev Troubleshooting (macOS)

Complement to [`opencode-desktop-dev-setup.md`](./opencode-desktop-dev-setup.md). This covers real failures encountered running the desktop shells locally and what actually fixed them, verified end-to-end.

Environment where this was reproduced and fixed:

- macOS 26.4.1 (Darwin 25.4), arm64 (Apple Silicon)
- Bun 1.3.12
- Rust 1.94.0 (Homebrew)

---

## Failure 1 — `tauri dev` aborts with `Smoke test failed ... exit code 137`

### Symptom

`bun run --cwd packages/desktop tauri dev` aborts during `predev` with output like:

```
building opencode-darwin-arm64
Running smoke test: dist/opencode-darwin-arm64/bin/opencode --version
Smoke test failed for opencode-darwin-arm64: ShellError: Failed with exit code 137
 exitCode: 137,
 stdout: "",
 stderr: "",
error: script "build" exited with code 1
error: script "predev" exited with code 1
Error The "beforeDevCommand" terminated with a non-zero status code.
```

### Root cause

Exit 137 is `128 + SIGKILL`. macOS is killing the freshly built `opencode` binary silently. The specific problem:

- `bun build --compile` embeds its own signature in the Mach-O (`LC_CODE_SIGNATURE` load command is present).
- On recent macOS releases (Sequoia / 26.x) the stricter code-signing verifier rejects that signature — `codesign -v` reports: **"invalid or unsupported format for signature"**.
- Any attempt to `exec()` the binary is then killed by `AMFI` with SIGKILL, producing zero stdout/stderr and exit 137.

Reproduce the diagnosis directly:

```bash
# Run the binary — it should exit 137 with no output
packages/opencode/dist/opencode-darwin-arm64/bin/opencode --version; echo "exit=$?"
# exit=137

# Why
codesign -dv packages/opencode/dist/opencode-darwin-arm64/bin/opencode
# -> "invalid or unsupported format for signature"
```

This is **not** quarantine (`com.apple.quarantine`); stripping `xattr -cr` alone does **not** fix it. The quarantine attribute is usually absent on a locally built binary.

### Fix — strip and ad-hoc re-sign

```bash
cd opencode
codesign --remove-signature packages/opencode/dist/opencode-darwin-arm64/bin/opencode 2>/dev/null
codesign --force --sign - packages/opencode/dist/opencode-darwin-arm64/bin/opencode
# Confirm
packages/opencode/dist/opencode-darwin-arm64/bin/opencode --version
# -> prints the version, exit 0
```

Now re-run `bun run --cwd packages/desktop tauri dev` — it proceeds through Rust compile (~1–2 min on a warm cache), sidecar spawn, health check, and opens the window.

### Permanent fix — patched `predev.ts`

The file `packages/desktop/scripts/predev.patched.ts` in this repo contains a drop-in replacement that:

1. **Skips** the sidecar rebuild when `../opencode/dist/opencode-darwin-arm64/bin/opencode` already exists. This turns every dev restart from "rebuild + Vite + Rust" (~3–5 min cold) into "Vite + Rust" (~10 s warm).
2. **Ad-hoc signs** the binary after building and again after copying it into `src-tauri/sidecars/` (`codesign` strips on copy on modern macOS).

To use it:

```bash
# from repo root
cd opencode
# back up the upstream predev
mv packages/desktop/scripts/predev.ts packages/desktop/scripts/predev.original.ts
# activate the patched version
cp packages/desktop/scripts/predev.patched.ts packages/desktop/scripts/predev.ts
```

To revert to upstream behavior:

```bash
mv packages/desktop/scripts/predev.original.ts packages/desktop/scripts/predev.ts
```

The patch is a local dev quality-of-life change, **not** something to upstream as-is — a proper upstream fix would add a `--skip-sign` flag to `script/build.ts` or run `codesign --force --sign -` inside the build itself, guarded on macOS.

---

## Failure 2 — Electron main window crashes after a few clicks

Not reproduced in testing (the app ran stably for several minutes), but `electron-log` output is the first thing to collect if it recurs:

```bash
tail -200 "$HOME/Library/Logs/OpenCode Dev/main.log"
```

Likely culprits the team has seen historically:

- **`@lydell/node-pty` native binding mismatch.** The platform-specific package (`@lydell/node-pty-darwin-arm64`) can end up out of sync after `fix-node-pty` runs. Symptom: stack trace mentioning `node-pty.node` or `dlopen` errors. Fix: `rm -rf node_modules packages/*/node_modules && bun install` from the repo root.
- **`virtual:opencode-server` not found.** The Electron build depends on `packages/opencode/dist/node/node.js` being present. If `predev` (which runs `cd ../opencode && bun script/build-node.ts`) failed silently, the main process crashes on import. Fix: `cd opencode/packages/opencode && bun script/build-node.ts`.
- **IPC handler drift.** The renderer calls `window.api.*`. If `preload/index.ts` exposes a method that `main/ipc.ts` doesn't register, Electron logs an unhandled-rejection trace when the user triggers that button. Fix: typecheck with `bun typecheck` in `packages/desktop-electron` — `preload/types.ts` is authored by hand, so drift is caught statically.

When you do reproduce it: grab the log, the exact button you clicked, and the Electron crash dump in `~/Library/Application Support/OpenCode Dev/Crashpad/completed/`.

---

## Failure 3 — "Open project" dialog shows "No folders found" in web dev loop

Not a bug. The web build (`bun dev` from `packages/app`) cannot show a native folder picker because there is no shell. The folder list is the project registry in SQLite (`~/.local/share/opencode/opencode.db`). Register a folder by running `opencode` inside it once:

```bash
cd ~/Documents/Projects/some-project
# use the installed CLI
opencode
# or use dev build
bun run --cwd /path/to/opencode/packages/opencode --conditions=browser ./src/index.ts
```

Then reload the web UI — the folder appears. Or run `tauri dev` / `electron-vite dev` which **do** expose a native directory picker.

---

## Failure 4 — Zombie sidecar holding a port after a hard kill

If `tauri dev` / `electron-vite dev` was force-killed (Ctrl+C during Rust compile, IDE crash, etc.), the sidecar subprocess / in-process server may still be running and holding its port. Next launch logs `Failed to bind to find free port` or silently picks a different port.

Find and kill:

```bash
# CLI-style sidecar (Tauri)
pgrep -fl "opencode-cli|opencode-desktop" | grep -v grep
kill -9 <pid>

# Or blanket
pkill -9 -f "opencode-desktop|opencode-cli "
pkill -9 -f "ai.opencode.desktop"   # Electron helpers
```

Also clear any leftover Vite:

```bash
pkill -f "packages/desktop/node_modules/.bin/vite"
pkill -f "electron-vite dev"
```

---

## Verified Working Flows (as of this doc)

All three were run end-to-end on the environment above:

### A. Tauri dev

```bash
cd opencode
# one-time per fresh binary
codesign --remove-signature packages/opencode/dist/opencode-darwin-arm64/bin/opencode 2>/dev/null
codesign --force --sign - packages/opencode/dist/opencode-darwin-arm64/bin/opencode
# run
bun run --cwd packages/desktop tauri dev
```

Expected log sequence:
```
Running BeforeDevCommand (`bun run dev`)
$ bun ./scripts/predev.ts
VITE ready in ~300 ms
Running DevCommand (`cargo run ...`)
Building ... [==>] opencode-desktop ... Finished in 1m 41s
opencode_lib: Initializing app
opencode_lib: Spawning sidecar on http://127.0.0.1:<port>
opencode_lib::cli: opencode server listening on http://127.0.0.1:<port>
opencode_lib::server: Server ready elapsed=~2s
opencode_lib: Sidecar health check OK
opencode_lib: Loading done, completing initialisation
```

Window titled "OpenCode Dev" appears.

### B. Electron dev

```bash
cd opencode
bun run --cwd packages/desktop-electron dev
```

No extra signing required — Electron runs the opencode server in-process via `virtual:opencode-server` and doesn't spawn a separate binary.

Expected log sequence:
```
Build complete
electron-vite dev: main + preload + renderer built
starting electron app...
app starting { version, packaged: false }
spawning sidecar { url: 'http://127.0.0.1:<port>' }
Loaded shell environment with -il (64 vars)
sidecar connection started
loading task finished
init step { step: { phase: 'done' } }
server ready { url: 'http://127.0.0.1:<port>' }
```

Window appears. First run creates `~/Library/Application Support/ai.opencode.desktop.dev/` and its SQLite DB.

### C. Web UI dev loop (no shell)

Two terminals:

```bash
# Terminal 1
cd opencode
bun run --cwd packages/opencode --conditions=browser ./src/index.ts serve --port 4096

# Terminal 2
cd opencode
bun run --cwd packages/app dev -- --port 4444
# open http://localhost:4444
```

This path avoids every issue above — no sidecar build, no Rust, no codesigning, no Electron. Recommended for 95% of UI work.

---

## Diagnostic commands cheat-sheet

```bash
# Is the sidecar binary runnable?
packages/opencode/dist/opencode-darwin-arm64/bin/opencode --version; echo "exit=$?"
# 0 = ok, 137 = SIGKILL (signing), 126 = exec denied, 127 = not found

# Signing status
codesign -dv packages/opencode/dist/opencode-darwin-arm64/bin/opencode
# Expected after fix: Signature=adhoc

# Quarantine / provenance attrs
xattr -lr packages/opencode/dist/opencode-darwin-arm64 | head

# System log for AMFI kills
log show --predicate 'eventMessage contains "opencode" or eventMessage contains "AMFI"' --last 5m --style compact | tail -50

# Logs
# Tauri:    ~/Library/Logs/ai.opencode.desktop.dev/
# Electron: ~/Library/Logs/OpenCode Dev/main.log
```

---

## TL;DR

- **Primary failure on macOS 26.x arm64 is `exit 137` during Tauri's sidecar smoke test.** Caused by an invalid Mach-O signature produced by `bun build --compile`. Fix: `codesign --remove-signature` + `codesign --force --sign -` on the built binary. A permanent patched `predev.ts` lives at `packages/desktop/scripts/predev.patched.ts`.
- **Electron is independently runnable** and does not need signing (it embeds the server in-process).
- **Web dev loop** (`bun dev serve` + `bun run --cwd packages/app dev`) avoids all shell issues and is the recommended path for UI work.
- **"No folders found"** in the web build is expected — register folders with `opencode` CLI or run a shell.

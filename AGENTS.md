# AGENTS.md

## Critical Rules
- **NEVER run `gnome-extensions install` or `gnome-extensions pack` from within this repo directory.** The install tool follows symlinks and will wipe the source directory contents.
- **Do not load ESModules via legacy `imports`** (e.g. `imports.ui.main` throws SyntaxError in GNOME 45+). Use static `import` or dynamic `await import()`.
- **Do not reassign ESModule exports directly** (e.g. `Main.notify = ...`). Monkeypatch mutable prototypes (e.g. `MessageTray.Source.prototype.addNotification`).
- **GJS constraint**: No `fetch`/`URLSearchParams` inside the shell process (use `Soup.Session` + `GLib.Bytes` as done in `extension.js`).

## Dev & Packaging Scripts
- **Safe Packaging**: Run `bash scripts/pack.sh` (compiles schemas, compiles translations, and packs via temporary directory safely).
- **Extension Reload**: Run `bash scripts/reload.sh` (executes disable/enable cycle).
- **Watch Logs**: Run `journalctl -f -o cat /usr/bin/gnome-shell`



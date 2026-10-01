# AGENTS.md

## Critical Rules
- NEVER run `gnome-extensions install` or `gnome-extensions pack` from within this repo directory.
- Load ESModules via static `import` or dynamic `await import()` only, never legacy `imports`.
- Never reassign ESModule exports directly; monkeypatch mutable prototypes instead.
- No `fetch`/`URLSearchParams` inside the shell process; use `Soup.Session` + `GLib.Bytes`.
- Keep `LICENSE` MIT (original © 2020 Lorenzo Carbonell); EGO requires GPL-2.0-or-later-compatible terms.

## Dev Commands
- Package only via `bash scripts/pack.sh` (schemas + translations via temp dir).
- Reload via `bash scripts/reload.sh`; watch logs with `journalctl -f -o cat /usr/bin/gnome-shell`.

## Testing & Sessions
- Do not remove the post-enable settle wait in `test/integration.sh` (timing tests fail on unsettled shells).
- If `enable` succeeds but state stays INACTIVE with no logs and stale version info, log out/in (host shell predates the changes).

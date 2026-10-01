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
- `test/eval-test.js` convention: Test 0 snapshots touched keys + resets to defaults; restore in `finally` (suite Eval is passed inside shell double quotes — no backticks, `$`, or backslashes in test code; use argv-style `GLib.spawn_sync`, never `spawn_command_line_sync`). Pump the mainloop once after settings writes before asserting.
- `npm test` is the fast gate (node unit + prefs + zip); `npm run test:integration` is the nested-shell suite.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`tazztone/translate-assistant`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context (one `GLOSSARY.md` + `docs/adr/` at repo root). See `docs/agents/domain.md`.

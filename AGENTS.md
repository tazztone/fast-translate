# AGENTS.md

## Extension Identity

- UUID: `translate-assistant@atareao.es`
- Installed path: `~/.local/share/gnome-shell/extensions/translate-assistant@atareao.es/`

## Deployment — CRITICAL RULES

- **NEVER run `gnome-extensions install` or `gnome-extensions pack` from within this repo directory.**
  The install tool follows symlinks and will wipe the source directory contents.
- The dev workflow is a **symlink**: `~/.local/share/gnome-shell/extensions/translate-assistant@atareao.es/` → this repo.
  Edits here take effect immediately on next extension reload — no install step needed.
- To reload after changes: `gnome-extensions disable translate-assistant@atareao.es && gnome-extensions enable translate-assistant@atareao.es`
- To verify the symlink is intact: `readlink ~/.local/share/gnome-shell/extensions/translate-assistant@atareao.es`
  Expected output: an absolute path pointing to this repo, not a real directory.

## DeepL API

- Free plan endpoint: `https://api-free.deepl.com/v2/translate` (not `api.deepl.com`).
- Auth: `Authorization: DeepL-Auth-Key <key>` header — form-body `auth_key` param is deprecated and returns 403.
- Request body must be `application/json`; `text` field must be an array: `{"text": ["Hello"]}`.

## GJS Constraints (GNOME Shell runtime)

- No `URLSearchParams`, no `fetch`, no Node.js globals — use `Soup.Session` + `GLib.Bytes`.
- Code runs as ESM (`"type": "module"` in metadata); use `import`/`export`, not `require`.
- Compile schemas after editing `.gschema.xml`: `glib-compile-schemas schemas/`

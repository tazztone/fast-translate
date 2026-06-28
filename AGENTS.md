# AGENTS.md

## Extension Identity

- UUID: `fast-translate@tazztone.github.io`
- Installed path: `~/.local/share/gnome-shell/extensions/fast-translate@tazztone.github.io/`

## Deployment — CRITICAL RULES

- **NEVER run `gnome-extensions install` or `gnome-extensions pack` from within this repo directory.**
  The install tool follows symlinks and will wipe the source directory contents.
- The dev workflow is a **symlink**: `~/.local/share/gnome-shell/extensions/fast-translate@tazztone.github.io/` → this repo.
  Edits here take effect immediately on next extension reload — no install step needed.
- To reload after changes: `gnome-extensions disable fast-translate@tazztone.github.io && gnome-extensions enable fast-translate@tazztone.github.io`
- To verify the symlink is intact: `readlink ~/.local/share/gnome-shell/extensions/fast-translate@tazztone.github.io`
  Expected output: an absolute path pointing to this repo, not a real directory.

## DeepL API

- Free plan endpoint: `https://api-free.deepl.com/v2/translate` (not `api.deepl.com`).
- Auth: `Authorization: DeepL-Auth-Key <key>` header — form-body `auth_key` param is deprecated and returns 403.
- Request body must be `application/json`; `text` field must be an array: `{"text": ["Hello"]}`.

## GJS Constraints (GNOME Shell runtime)

- No `URLSearchParams`, no `fetch`, no Node.js globals — use `Soup.Session` + `GLib.Bytes`.
- Code runs as ESM (`"type": "module"` in metadata); use `import`/`export`, not `require`.
- Compile schemas after editing `.gschema.xml`: `glib-compile-schemas schemas/`
- **DO NOT** load ESModules via legacy `imports` (e.g. `imports.ui.main` throws SyntaxError in GNOME 45+). Use static `import` or dynamic `await import()`.
- **DO NOT** reassign ESModule exports directly (e.g. `Main.notify = ...` throws TypeError). Mock system behaviors by monkeypatching mutable prototypes instead (e.g., `MessageTray.Source.prototype.addNotification`).
- Modern system notifications in GNOME 45+ are dispatched via `source.addNotification(notification)`, not `showNotification(notification)`.
- Always reset GSettings keys at the start of integration tests to prevent state leakage from persisting in the user's `dconf` store across runs.

## Development & Troubleshooting

- Manual Dev Setup (safe symlink method):
  ```bash
  mkdir -p ~/.local/share/gnome-shell/extensions/
  ln -s "$(pwd)" ~/.local/share/gnome-shell/extensions/fast-translate@tazztone.github.io
  ```
- Force reload extension (disable/enable cycle):
  ```bash
  gnome-extensions disable fast-translate@tazztone.github.io && gnome-extensions enable fast-translate@tazztone.github.io
  ```
- Watch GNOME Shell log stream in real time:
  ```bash
  journalctl -f -o cat /usr/bin/gnome-shell
  ```

## Packaging & Submission

To build the submission zip file safely without risking file erasure due to GNOME symlink quirks, package the extension via a temporary directory:

```bash
# Clean up any existing packaging archive
rm -f fast-translate@tazztone.github.io.shell-extension.zip

# Create a temporary packaging folder and copy required source files
mkdir -p /tmp/fast-translate-pack
cp -r extension.js prefs.js translation-helper.js metadata.json stylesheet.css icons/ po/ schemas/ /tmp/fast-translate-pack/

# Build the pack inside the temporary directory
(cd /tmp/fast-translate-pack && gnome-extensions pack --force --podir=po --extra-source=translation-helper.js --extra-source=icons)

# Move the compiled zip file back to the repository root
cp /tmp/fast-translate-pack/fast-translate@tazztone.github.io.shell-extension.zip .
rm -rf /tmp/fast-translate-pack
```


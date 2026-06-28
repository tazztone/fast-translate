#!/usr/bin/env bash
# reload.sh: Reloads the extension by disabling and re-enabling it.
set -euo pipefail

echo "🔄 Reloading Fast Translate extension..."
gnome-extensions disable fast-translate@tazztone.github.io || true
gnome-extensions enable fast-translate@tazztone.github.io

echo "✅ Reload complete!"

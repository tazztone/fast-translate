#!/usr/bin/env bash
# pack.sh: Safe extension packaging script.
set -euo pipefail

echo "🧹 Cleaning previous packages..."
rm -f *.zip

echo "📦 Copying files to temporary directory..."
mkdir -p /tmp/fast-translate-pack
cp -r extension.js prefs.js translation-helper.js metadata.json stylesheet.css icons/ po/ schemas/ /tmp/fast-translate-pack/

echo "⚡ Compiling GSettings schemas..."
glib-compile-schemas /tmp/fast-translate-pack/schemas/

echo "🎁 Packing extension via gnome-extensions pack..."
(cd /tmp/fast-translate-pack && gnome-extensions pack --force --podir=po --extra-source=translation-helper.js --extra-source=icons)

echo "💾 Moving package back to project root..."
cp /tmp/fast-translate-pack/*.zip .
rm -rf /tmp/fast-translate-pack

echo "✅ Packaging complete: $(ls *.zip)"

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

if [ -x "venv/bin/shexli" ]; then
    echo "🔍 Running shexli static analyzer..."
    venv/bin/shexli *.zip
else
    echo "⚙️ Setting up virtualenv to install shexli analyzer..."
    python3 -m venv venv
    venv/bin/pip install -U shexli --quiet
    # PIN: tree-sitter>=0.26 segfaults (exit 139) analyzing extension.js —
    # upstream heap corruption, unrelated to zip contents. Last good: 0.25.2.
    venv/bin/pip install 'tree-sitter==0.25.2' --quiet
    echo "🔍 Running shexli static analyzer..."
    venv/bin/shexli *.zip
fi

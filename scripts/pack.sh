#!/usr/bin/env bash
# pack.sh: Safe extension packaging script.
set -euo pipefail

# NOTE: never pack inside the repo dir (gnome-extensions follows symlinks
# and can wipe sources). Always stage in a temp dir outside the source tree.
# Use a repo-local temp dir: sandboxes/CI often mount /tmp read-only.
PACK_TMP="$(mktemp -d -p . .pack-XXXXXX)"
cleanup() { rm -rf "$PACK_TMP"; }
trap cleanup EXIT

echo "📦 Copying files to temporary directory..."
mkdir -p "$PACK_TMP/icons"
cp extension.js prefs.js translation-helper.js metadata.json stylesheet.css "$PACK_TMP/"
cp -r po schemas "$PACK_TMP/"
# Ship only icons actually referenced by the code (dynamic
# fast-translate-{active,paused}-{dark,light} + fast-translate-icon).
# The atareao/bmc/social leftovers stay in the repo but out of the zip.
cp icons/fast-translate-active-dark.svg icons/fast-translate-active-light.svg icons/fast-translate-paused-dark.svg icons/fast-translate-paused-light.svg icons/fast-translate-icon.svg icons/fast-translate-icon.png "$PACK_TMP/icons/"

echo "⚡ Compiling GSettings schemas..."
glib-compile-schemas --strict "$PACK_TMP/schemas/"

echo "🎁 Packing extension via gnome-extensions pack..."
(cd "$PACK_TMP" && gnome-extensions pack --force --podir=po --extra-source=translation-helper.js --extra-source=icons)

echo "💾 Moving package back to project root..."
# Only replace the old zip after the new one built successfully.
rm -f *.zip
cp "$PACK_TMP"/*.zip .

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

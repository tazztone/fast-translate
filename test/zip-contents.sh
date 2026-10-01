#!/usr/bin/env bash
# zip-contents.sh: asserts the packed extension zip contains the curated
# pack.sh file set and nothing an EGO reviewer would flag (sources,
# packaging scripts, tests, compiled schemas, VCS leftovers).
set -euo pipefail
cd "$(dirname "$0")/.."

ZIPS=( *.shell-extension.zip )
if [ "${#ZIPS[@]}" -ne 1 ]; then
    echo "❌ Expected exactly one *.shell-extension.zip, found ${#ZIPS[@]}."
    exit 1
fi
ZIP="${ZIPS[0]}"
echo "🔍 Checking $ZIP ..."
LIST=$(unzip -Z1 "$ZIP")

fail() { echo "❌ $1"; exit 1; }

# 1. Required files (mirrors scripts/pack.sh staging)
for f in extension.js prefs.js translation-helper.js metadata.json stylesheet.css \
    schemas/org.gnome.shell.extensions.fast-translate.gschema.xml \
    icons/fast-translate-active-dark.svg icons/fast-translate-active-light.svg \
    icons/fast-translate-paused-dark.svg icons/fast-translate-paused-light.svg \
    icons/fast-translate-icon.svg icons/fast-translate-icon.png; do
    echo "$LIST" | grep -qxF "$f" || fail "missing required file: $f"
done
echo "$LIST" | grep -q '^locale/.*/.*\.mo$' || fail "no compiled locale .mo files"

# 2. Denylist: must never ship
if echo "$LIST" | grep -qiE '(^|/)\.(git|pack)|~$|\.pyc$|__pycache__|\.(po|pot)$|gschemas\.compiled$|(^|/)(README|LICENSE|AGENTS)|screenshots?/|scratch|\.scratch|venv|test/|scripts/|mock-prefs|eval-test|integration\.sh|pack\.sh|reload\.sh|\.zip$'; then
    fail "zip contains files that must not ship (see matches above)"
fi

# 3. Zip basename must match the metadata uuid
UUID=$(python3 -c "import json; print(json.load(open('metadata.json'))['uuid'])")
[ "${ZIP%.shell-extension.zip}" = "$UUID" ] || fail "zip name $ZIP does not match metadata uuid $UUID"

echo "✅ Zip contents check passed ($ZIP)."

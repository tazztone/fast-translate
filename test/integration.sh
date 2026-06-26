#!/usr/bin/env bash
set -euo pipefail

echo "🔨 Compiling GSettings schemas..."
glib-compile-schemas schemas/

echo "📦 Deploying extension to local GNOME directory..."
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/translate-assistant@atareao.es"
mkdir -p "$EXT_DIR"
if [ "$(realpath "$EXT_DIR")" != "$(realpath .)" ]; then
    cp -rf extension.js prefs.js translation-helper.js metadata.json stylesheet.css icons schemas "$EXT_DIR/"
else
    echo "ℹ️  Extension directory is already linked to project directory."
fi

# Read JS code from file
JS_CODE=$(cat test/eval-test.js)
export JS_CODE
QUERY_CODE="global.testRunnerResult || JSON.stringify({ success: false, error: 'Asynchronous test run timed out or failed to resolve' })"
export QUERY_CODE

echo "⚡ Starting isolated DBus session for integration tests..."
dbus-run-session bash -c '
    echo "🔓 Enabling unsafe-mode for Eval in isolated session..."
    gsettings set org.gnome.desktop.interface unsafe-mode true

    export GSETTINGS_SCHEMA_DIR="$(pwd)/schemas"

    echo "🚀 Starting headless GNOME Shell session..."
    gnome-shell --headless --virtual-monitor 1024x768 --devkit --unsafe-mode &
    SHELL_PID=$!

    # Ensure cleanup
    trap '\''echo "🧹 Cleaning up nested GNOME Shell process..."; kill $SHELL_PID 2>/dev/null || true'\'' EXIT INT TERM

    echo "⏳ Waiting for GNOME Shell to initialize..."
    sleep 5

    echo "⚡ Enabling translate-assistant..."
    gnome-extensions enable translate-assistant@atareao.es

    echo "🔍 Fetching extension details..."
    INFO=$(gnome-extensions info translate-assistant@atareao.es || echo "Command failed")
    echo "-----------------------------------"
    echo "$INFO"
    echo "-----------------------------------"

    if echo "$INFO" | grep -iq "error"; then
        echo "❌ Integration test failed: Extension loaded with ERROR status!"
        exit 1
    fi

    if ! echo "$INFO" | grep -q "translate-assistant@atareao.es"; then
        echo "❌ Integration test failed: Extension could not be found or registered!"
        exit 1
    fi

    echo "🧪 Triggering programmatic JS tests via DBus Eval..."
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$JS_CODE" > /dev/null

    echo "⏳ Waiting for asynchronous assertions to complete..."
    sleep 2

    echo "🔍 Fetching test suite result..."
    RESULT=$(gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$QUERY_CODE")

    echo "📊 Test response: $RESULT"

    if [[ "$RESULT" == *success*true* ]]; then
        echo "✅ Programmatic integration tests passed successfully!"
        exit 0
    else
        echo "❌ Programmatic integration tests failed!"
        exit 1
    fi
'

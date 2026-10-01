#!/usr/bin/env bash
set -euo pipefail

echo "🔨 Compiling GSettings schemas..."
glib-compile-schemas schemas/

echo "📦 Deploying extension to local GNOME directory..."
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/fast-translate@tazztone.github.io"
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
LOG_FILE=$(mktemp /tmp/fast-translate-integration-XXXXXX.log)
export LOG_FILE

# Session-service spam (dbus-daemon, evolution, portals, DING, GSConnect, ...)
# inherits our terminal — filter it out, keep our own marked-up lines.
NOISE_FILTER='dbus-daemon|fusermount3|org\.a11y|atspi\.Registry|SpiRegistry daemon|org\.gtk\.vfs|org\.gnome\.(Shell\.CalendarServer|Shell\.Screencast|Shell\.Notifications|Shell\.Extensions|OnlineAccounts|Evolution|Identity|Nautilus|ArchiveManager1|ScreenSaver|Settings\.GlobalShortcuts)|org\.freedesktop\.(portal|impl\.portal|Tracker3|secrets)|goa-daemon|discover_other_daemon|GNOME_KEYRING|ibus-daemon|xdg-desktop-portal|GSConnect|DesktopAppInfo|Connecting to org\.freedesktop\.Tracker|Tracker-WARNING|DING:|Gdk-Message|GLib-GIO-CRITICAL|libedbus|e-backend|evolution-(source-registry|calendar-factory|addressbook-factory)|localsearch|GVFS-RemoteVolumeMonitor|Lost connection to|Broken pipe|cannot open display|ChildExited|Failed to close session|connection is closed|ConnectionStatus|Lost \(or failed to acquire\)|A connection to the bus|wayland|Wayland|libmutter|Clutter-WARNING|Gjs-CRITICAL.*file monitor|TemplatesScriptsManager|DesktopManager|ding\.js|Switcheroo|Gvfs daemon|File-roller|FileOperations|FileManager1|No translation file found|Unable to find default local file monitor|Failed to initialize file monitoring|_onHandleMethodCall.*clipboard|overrides/GLib\.js|core/_common\.js|daemon\.js|gsconnect@|Activating service name|Successfully activated service|became a monitor|Monitoring connection.*closed|^$|GVFS|gvfsd'
export NOISE_FILTER

echo "⚡ Starting isolated DBus session for integration tests (shell log: $LOG_FILE)..."
set +e
dbus-run-session bash -c '
    set -euo pipefail

    # Remove stale lockfile from previous runs sharing /run/user/$UID
    rm -f "${XDG_RUNTIME_DIR:-/run/user/$UID}/gnome-shell-disable-extensions" 2>/dev/null || true

    export GSETTINGS_SCHEMA_DIR="$(pwd)/schemas"

    echo "🚀 Starting headless GNOME Shell session..."
    gnome-shell --headless --virtual-monitor 1024x768 --devkit --unsafe-mode &> "$LOG_FILE" &
    SHELL_PID=$!

    cleanup() {
        echo "🧹 Cleaning up nested GNOME Shell process..."
        kill "$SHELL_PID" 2>/dev/null || true
        wait "$SHELL_PID" 2>/dev/null || true
        pkill -P "$SHELL_PID" 2>/dev/null || true
    }
    trap cleanup EXIT INT TERM

    echo "⏳ Waiting for GNOME Shell to initialize..."
    for i in $(seq 1 60); do
        if gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "true" &>/dev/null; then
            break
        fi
        sleep 0.5
        if [ "$i" -eq 60 ]; then
            echo "❌ Integration test failed: GNOME Shell did not become ready in time."
            tail -n 50 "$LOG_FILE" || true
            exit 1
        fi
    done

    echo "⚡ Enabling fast-translate..."
    gnome-extensions enable fast-translate@tazztone.github.io

    echo "⏳ Waiting for extension to become ACTIVE..."
    INFO=""
    for i in $(seq 1 40); do
        INFO=$(gnome-extensions info fast-translate@tazztone.github.io 2>/dev/null || echo "Command failed")
        if echo "$INFO" | grep -q "State: *ACTIVE"; then
            break
        fi
        if echo "$INFO" | grep -iq "State: *ERROR"; then
            echo "❌ Integration test failed: Extension loaded with ERROR status!"
            echo "$INFO"
            exit 1
        fi
        sleep 0.5
        if [ "$i" -eq 40 ]; then
            echo "❌ Integration test failed: Extension never reached ACTIVE state."
            echo "$INFO"
            exit 1
        fi
    done

    echo "🔍 Fetching extension details..."
    echo "-----------------------------------"
    echo "$INFO"
    echo "-----------------------------------"

    if ! echo "$INFO" | grep -q "fast-translate@tazztone.github.io"; then
        echo "❌ Integration test failed: Extension could not be found or registered!"
        exit 1
    fi

    # Let startup churn (DING/GSConnect/Tracker) settle: the debounce test
    # only has ~200ms of wall-clock margin, it must not run under load.
    echo "💤 Letting session settle before tests..."
    sleep 3

    echo "🧪 Triggering programmatic JS tests via DBus Eval..."
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$JS_CODE" > /dev/null

    echo "⏳ Waiting for asynchronous assertions to complete..."
    RESULT=""
    for i in $(seq 1 60); do
        RESULT=$(gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$QUERY_CODE" || true)
        CLEAN_POLL=${RESULT//\\/}
        if echo "$CLEAN_POLL" | grep -q "Asynchronous test run timed out"; then
            sleep 0.5
            continue
        fi
        break
    done

    echo "🔍 Fetching test suite result..."
    echo "📊 Test response: $RESULT"

    CLEAN_RESULT=${RESULT//\\/}
    if echo "$CLEAN_RESULT" | grep -q "\"success\": *true" && ! echo "$CLEAN_RESULT" | grep -q "\"success\": *false"; then
        echo "✅ Programmatic integration tests passed successfully!"
        rm -f "$LOG_FILE" || true
        exit 0
    else
        echo "❌ Programmatic integration tests failed!"
        echo "--- Filtered shell log (last 50 lines, known-harmless noise removed) ---"
        grep -v -E "Clutter-WARNING.*allocate|Unable to find default local file monitor|Failed to initialize file monitoring|GSConnect.*clipboard|Owner of volume monitor.*disconnected|Failed to register AuthenticationAgent|geolocation|scale-monitor-framebuffer|xwayland-native-scaling|Failed to create.*gnome-shell-disable-extensions" "$LOG_FILE" | tail -n 50 || tail -n 50 "$LOG_FILE" || true
        echo "--- Full log kept at: $LOG_FILE ---"
        exit 1
    fi
' 2>&1 | grep --line-buffered -v -E "$NOISE_FILTER"
PIPESTAT="${PIPESTATUS[0]:-1}"
set -e
exit "$PIPESTAT"

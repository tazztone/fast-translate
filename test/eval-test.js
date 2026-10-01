global.testRunnerResult = null;
global.testRunnerPromise = (async () => {
    try {
        const Main = await import("resource:///org/gnome/shell/ui/main.js");
        const ext = Main.extensionManager.lookup("fast-translate@tazztone.github.io");
        if (!ext) {
            return { success: false, error: "Extension not found" };
        }
        const indicator = ext.stateObj ? ext.stateObj._indicator : null;
        if (!indicator) {
            return { success: false, error: "Indicator not found" };
        }

        // Test 0: Settings hygiene + ship-state defaults audit.
        // Snapshot every key this suite may touch, reset to schema defaults
        // (reviewers check defaults first; resets also make reruns idempotent).
        // Snapshot is restored before the success return and in the catch
        // below; individual tests additionally use try/finally.
        const TOUCHED_KEYS = ['translation-service', 'source-lang', 'target-lang',
            'url', 'apikey', 'floating-auto-copy', 'floating-background-mode',
            'floating-background-toast', 'double-copy-enabled', 'double-copy-delay',
            'auto-paste', 'auto-translate', 'auto-copy',
            'keybinding-translate-clipboard', 'notifications'];
        const _settingsSnapshot = {};
        for (const _k of TOUCHED_KEYS) {
            try { _settingsSnapshot[_k] = indicator._settings.get_value(_k); } catch (e) { _settingsSnapshot[_k] = null; }
        }
        const _restoreSettingsSnapshot = () => {
            for (const _k of TOUCHED_KEYS) {
                try { if (_settingsSnapshot[_k]) indicator._settings.set_value(_k, _settingsSnapshot[_k]); } catch (e) {}
            }
        };
        for (const _k of TOUCHED_KEYS) {
            try { indicator._settings.reset(_k); } catch (e) {}
        }
        // Pump the mainloop so the reset propagates through _loadPreferences.
        const _pumpMainloop = () => new Promise(resolve => {
            const GLib = imports.gi.GLib;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { resolve(); return GLib.SOURCE_REMOVE; });
        });
        await _pumpMainloop();

        // Test 0b: audit schema *defaults* (state-independent: reads defaults,
        // not live values). Safe-default contract EGO reviewers check first.
        const _def = (k) => indicator._settings.get_default_value(k).unpack();
        const _safeDefaults = [
            ['double-copy-enabled', false],
            ['auto-paste', false],
            ['auto-copy', false],
            ['auto-translate', false],
            ['floating-auto-copy', false],
            ['floating-background-mode', false],
            ['floating-background-toast', true],
            ['notifications', false],
            ['apikey', ''],
            ['translation-service', 'Google Translate'],
        ];
        for (const [k, expected] of _safeDefaults) {
            const actual = _def(k);
            if (actual !== expected) {
                _restoreSettingsSnapshot();
                return { success: false, error: 'Unsafe ship-state default: ' + k + '=' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected) };
            }
        }
        if (!(_def('url') || '').startsWith('https://')) {
            _restoreSettingsSnapshot();
            return { success: false, error: 'Unsafe ship-state default: url=' + JSON.stringify(_def('url')) + ', must use https://' };
        }
        const _delayDef = _def('double-copy-delay');
        if (typeof _delayDef !== 'number' || _delayDef < 300 || _delayDef > 5000) {
            _restoreSettingsSnapshot();
            return { success: false, error: 'Unsafe ship-state default: double-copy-delay=' + JSON.stringify(_delayDef) + ', must be 300-5000' };
        }
        const _kbDef = _def('keybinding-translate-clipboard');
        if (!Array.isArray(_kbDef) || _kbDef.length !== 0) {
            _restoreSettingsSnapshot();
            return { success: false, error: 'Unsafe ship-state default: keybinding-translate-clipboard=' + JSON.stringify(_kbDef) + ', must ship empty' };
        }

        // Test 1: Verify elements exist
        if (!indicator.inputEntry) return { success: false, error: "inputEntry missing" };
        if (!indicator.outputEntry) return { success: false, error: "outputEntry missing" };
        if (!indicator.translateBtn) return { success: false, error: "translateBtn missing" };
        if (!indicator.swapBtn) return { success: false, error: "swapBtn missing" };
        if (!indicator.clearBtn) return { success: false, error: "clearBtn missing" };
        if (!indicator.pasteBtn) return { success: false, error: "pasteBtn missing" };
        if (!indicator.copyBtn) return { success: false, error: "copyBtn missing" };

        // Test 2: Swap Action
        indicator.inputEntry.get_clutter_text().set_text("Hello");
        indicator.outputEntry.get_clutter_text().set_text("World");
        indicator.swapBtn.emit('clicked', 0);
        if (indicator.inputEntry.get_clutter_text().get_text() !== "World" ||
            indicator.outputEntry.get_clutter_text().get_text() !== "Hello") {
            return { success: false, error: "Swap button failed to swap text" };
        }

        // Test 3: Clear Action
        indicator.clearBtn.emit('clicked', 0);
        if (indicator.inputEntry.get_clutter_text().get_text() !== "" ||
            indicator.outputEntry.get_clutter_text().get_text() !== "") {
            return { success: false, error: "Clear button failed to clear text" };
        }

        // Test 4: Mocked HTTP Translation (Offline)
        const originalService = indicator._settings.get_enum('translation-service');
        indicator._settings.set_enum('translation-service', 0); // Force DeepL mode first

        const originalSendReadAsync = indicator._httpSession.send_and_read_async;
        let mockCallback = null;
        let mockSession = null;
        let mockMessage = null;

        const Soup = imports.gi.Soup;
        let interceptedBody = null;
        const originalSetRequestBody = Soup.Message.prototype.set_request_body_from_bytes;
        Soup.Message.prototype.set_request_body_from_bytes = function(contentType, bytes) {
            try {
                const data = bytes.get_data();
                interceptedBody = typeof TextDecoder !== 'undefined' ? new TextDecoder().decode(data) : imports.byteArray.toString(data);
            } catch (e) {
                // Ignore conversion errors
            }
            return originalSetRequestBody.call(this, contentType, bytes);
        };

        indicator._httpSession.send_and_read_async = function(message, priority, cancellable, callback) {
            mockMessage = message;
            mockSession = this;
            mockCallback = callback;
        };

        // Input text and trigger translation
        indicator.inputEntry.get_clutter_text().set_text("Hello");
        indicator.translateBtn.emit('clicked', 0);

        // Restore prototype method immediately
        Soup.Message.prototype.set_request_body_from_bytes = originalSetRequestBody;

        // Verify button changed label to "Cancel"
        if (indicator.translateBtn.label !== "Cancel") {
            indicator._httpSession.send_and_read_async = originalSendReadAsync;
            return { success: false, error: "Translate button did not change to Cancel during operation" };
        }

        // Verify request payload schema
        if (!interceptedBody) {
            indicator._httpSession.send_and_read_async = originalSendReadAsync;
            return { success: false, error: "Request body was not set via set_request_body_from_bytes" };
        }

        let bodyObj;
        try {
            bodyObj = JSON.parse(interceptedBody);
        } catch (e) {
            indicator._httpSession.send_and_read_async = originalSendReadAsync;
            return { success: false, error: "Request body is not valid JSON: " + e.message };
        }

        if (typeof bodyObj.preserve_formatting !== 'boolean') {
            indicator._httpSession.send_and_read_async = originalSendReadAsync;
            return { success: false, error: "preserve_formatting is not a boolean: " + typeof bodyObj.preserve_formatting };
        }

        if (bodyObj.formality && bodyObj.formality === 'default') {
            indicator._httpSession.send_and_read_async = originalSendReadAsync;
            return { success: false, error: "formality should be omitted when set to default" };
        }

        // Complete the mock request
        if (!mockCallback) {
            indicator._httpSession.send_and_read_async = originalSendReadAsync;
            return { success: false, error: "send_and_read_async was not called" };
        }

        Object.defineProperty(mockMessage, 'status_code', { get: () => 200, configurable: true });

        const originalSendReadFinish = indicator._httpSession.send_and_read_finish;
        indicator._httpSession.send_and_read_finish = function(result) {
            const GLib = imports.gi.GLib;
            const text = JSON.stringify({
                translations: [{ text: "Bonjour" }]
            });
            return typeof TextEncoder !== 'undefined' ? new GLib.Bytes(new TextEncoder().encode(text)) : new GLib.Bytes(imports.byteArray.fromString(text));
        };

        // Call the callback
        mockCallback(mockSession, "dummy_result");

        // Verify result
        if (indicator.outputEntry.get_clutter_text().get_text() !== "Bonjour") {
            indicator._httpSession.send_and_read_async = originalSendReadAsync;
            indicator._httpSession.send_and_read_finish = originalSendReadFinish;
            return { success: false, error: "Translation did not populate outputEntry correctly" };
        }

        if (indicator.translateBtn.label !== "Translate") {
            indicator._httpSession.send_and_read_async = originalSendReadAsync;
            indicator._httpSession.send_and_read_finish = originalSendReadFinish;
            return { success: false, error: "Translate button label did not reset to Translate after success" };
        }

        // Test 4b: Mocked HTTP Translation (Google Translate - Offline)
        indicator._settings.set_enum('translation-service', 1); // 1 = Google Translate
        
        let googleInterceptedBody = null;
        let googleMockCallback = null;
        let googleMockSession = null;
        let googleMockMessage = null;

        const originalSetRequestBodyGoogle = Soup.Message.prototype.set_request_body_from_bytes;
        Soup.Message.prototype.set_request_body_from_bytes = function(contentType, bytes) {
            try {
                const data = bytes.get_data();
                googleInterceptedBody = typeof TextDecoder !== 'undefined' ? new TextDecoder().decode(data) : imports.byteArray.toString(data);
            } catch (e) {
                // Ignore conversion errors
            }
            return originalSetRequestBodyGoogle.call(this, contentType, bytes);
        };

        indicator._httpSession.send_and_read_async = function(message, priority, cancellable, callback) {
            googleMockMessage = message;
            googleMockSession = this;
            googleMockCallback = callback;
        };

        // Clear output first
        indicator.outputEntry.get_clutter_text().set_text("");
        indicator.inputEntry.get_clutter_text().set_text("Hello");
        indicator.translateBtn.emit('clicked', 0);

        // Restore prototype method immediately
        Soup.Message.prototype.set_request_body_from_bytes = originalSetRequestBodyGoogle;

        // Verify button changed label to "Cancel"
        if (indicator.translateBtn.label !== "Cancel") {
            indicator._httpSession.send_and_read_async = originalSendReadAsync;
            indicator._httpSession.send_and_read_finish = originalSendReadFinish;
            indicator._settings.set_enum('translation-service', originalService);
            return { success: false, error: "Google Translate: Translate button did not change to Cancel" };
        }

        // Verify request payload was interceptable
        if (!googleInterceptedBody) {
            indicator._httpSession.send_and_read_async = originalSendReadAsync;
            indicator._httpSession.send_and_read_finish = originalSendReadFinish;
            indicator._settings.set_enum('translation-service', originalService);
            return { success: false, error: "Google Translate: Request body was not set" };
        }

        if (googleInterceptedBody !== "q=Hello") {
            indicator._httpSession.send_and_read_async = originalSendReadAsync;
            indicator._httpSession.send_and_read_finish = originalSendReadFinish;
            indicator._settings.set_enum('translation-service', originalService);
            return { success: false, error: "Google Translate: Request body is not form urlencoded q=Hello, got: " + googleInterceptedBody };
        }

        const uri = googleMockMessage.uri ? googleMockMessage.uri.to_string() : (googleMockMessage.get_uri ? googleMockMessage.get_uri().to_string() : "");
        if (!uri.includes("translate.googleapis.com/translate_a/single") || !uri.includes("client=gtx")) {
            indicator._httpSession.send_and_read_async = originalSendReadAsync;
            indicator._httpSession.send_and_read_finish = originalSendReadFinish;
            indicator._settings.set_enum('translation-service', originalService);
            return { success: false, error: "Google Translate: Outgoing URL is incorrect: " + uri };
        }

        // Verify no Authorization header is set
        const authHeader = googleMockMessage.request_headers.get_one('Authorization');
        if (authHeader) {
            indicator._httpSession.send_and_read_async = originalSendReadAsync;
            indicator._httpSession.send_and_read_finish = originalSendReadFinish;
            indicator._settings.set_enum('translation-service', originalService);
            return { success: false, error: "Google Translate: Authorization header should not be set!" };
        }

        // Complete the mock request
        if (!googleMockCallback) {
            indicator._httpSession.send_and_read_async = originalSendReadAsync;
            indicator._httpSession.send_and_read_finish = originalSendReadFinish;
            indicator._settings.set_enum('translation-service', originalService);
            return { success: false, error: "Google Translate: send_and_read_async was not called" };
        }

        Object.defineProperty(googleMockMessage, 'status_code', { get: () => 200, configurable: true });

        indicator._httpSession.send_and_read_finish = function(result) {
            const GLib = imports.gi.GLib;
            const text = JSON.stringify([[["Bonjour", "Hello", null, null, 10]], null, "en"]);
            return typeof TextEncoder !== 'undefined' ? new GLib.Bytes(new TextEncoder().encode(text)) : new GLib.Bytes(imports.byteArray.fromString(text));
        };

        // Call the callback
        googleMockCallback(googleMockSession, "dummy_result");

        // Verify result
        if (indicator.outputEntry.get_clutter_text().get_text() !== "Bonjour") {
            indicator._httpSession.send_and_read_async = originalSendReadAsync;
            indicator._httpSession.send_and_read_finish = originalSendReadFinish;
            indicator._settings.set_enum('translation-service', originalService);
            return { success: false, error: "Google Translate: Translation did not populate outputEntry correctly" };
        }

        if (indicator.translateBtn.label !== "Translate") {
            indicator._httpSession.send_and_read_async = originalSendReadAsync;
            indicator._httpSession.send_and_read_finish = originalSendReadFinish;
            indicator._settings.set_enum('translation-service', originalService);
            return { success: false, error: "Google Translate: Translate button label did not reset to Translate after success" };
        }

        // Clean up / revert to DeepL
        indicator._settings.set_enum('translation-service', originalService);

        // Test 5: Cancel Translation Flow
        let cancelTriggered = false;
        indicator._httpSession.send_and_read_async = function(message, priority, cancellable, callback) {
            mockMessage = message;
            mockSession = this;
            mockCallback = callback;
            if (cancellable) {
                cancellable.connect(() => {
                    cancelTriggered = true;
                });
            }
        };

        // Trigger translation again
        indicator.translateBtn.emit('clicked', 0);

        if (indicator.translateBtn.label !== "Cancel") {
            indicator._httpSession.send_and_read_async = originalSendReadAsync;
            indicator._httpSession.send_and_read_finish = originalSendReadFinish;
            return { success: false, error: "Translate button did not transition to Cancel for Cancel test" };
        }

        // Simulate cancel click
        indicator.translateBtn.emit('clicked', 0);

        if (!cancelTriggered) {
            indicator._httpSession.send_and_read_async = originalSendReadAsync;
            indicator._httpSession.send_and_read_finish = originalSendReadFinish;
            return { success: false, error: "Cancellable was not cancelled when Cancel button was clicked" };
        }

        // Simulate Gio.IOErrorEnum.CANCELLED in send_and_read_finish
        indicator._httpSession.send_and_read_finish = function(result) {
            const Gio = imports.gi.Gio;
            const GLib = imports.gi.GLib;
            throw new GLib.Error(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED, "Operation was cancelled");
        };

        // Run the callback to finish the cancellation flow
        mockCallback(mockSession, "dummy_result");

        if (indicator.errorLabel.text !== "Cancelled") {
            indicator._httpSession.send_and_read_async = originalSendReadAsync;
            indicator._httpSession.send_and_read_finish = originalSendReadFinish;
            return { success: false, error: "Error label did not show 'Cancelled' on abort" };
        }

        if (indicator.translateBtn.label !== "Translate") {
            indicator._httpSession.send_and_read_async = originalSendReadAsync;
            indicator._httpSession.send_and_read_finish = originalSendReadFinish;
            return { success: false, error: "Translate button did not reset to Translate after cancellation" };
        }

        // Test 6: Toggle inline language selectors
        try {
            indicator._toggleLanguageSelector(true, true);
            indicator._toggleLanguageSelector(true, false);
            indicator._toggleLanguageSelector(false, true);
            indicator._toggleLanguageSelector(false, false);
        } catch (e) {
            indicator._httpSession.send_and_read_async = originalSendReadAsync;
            indicator._httpSession.send_and_read_finish = originalSendReadFinish;
            return { success: false, error: "Failed to toggle language selector: " + e.message };
        }

        // Test 7: Instantiate FloatingTranslationWindow
        try {
            let FloatingTranslationWindow = indicator.FloatingTranslationWindow;
            let win = new FloatingTranslationWindow("Hello World", "Bonjour le monde", "EN", "FR");
            if (!win.actor || !win.overlay) {
                indicator._httpSession.send_and_read_async = originalSendReadAsync;
                indicator._httpSession.send_and_read_finish = originalSendReadFinish;
                return { success: false, error: "FloatingTranslationWindow missing overlay or actor" };
            }
            win.destroy();
        } catch (e) {
            indicator._httpSession.send_and_read_async = originalSendReadAsync;
            indicator._httpSession.send_and_read_finish = originalSendReadFinish;
            return { success: false, error: "Failed to instantiate FloatingTranslationWindow: " + e.message };
        }

        // Test 8: Double-copy shortcut simulation
        const St = imports.gi.St;
        const Meta = imports.gi.Meta;
        const GLib = imports.gi.GLib;
        const Clipboard = St.Clipboard.get_default();

        const originalGetMonotonicTime = GLib.get_monotonic_time;
        let mockTime = 1000000;
        GLib.get_monotonic_time = function() {
            return mockTime;
        };

        const originalClipboardGetText = Clipboard.get_text;
        const originalClipboardSetText = Clipboard.set_text;
        let mockClipboardText = "";

        // Mock clipboard get_text to return our mock text
        Clipboard.get_text = function(type, callback) {
            callback(Clipboard, mockClipboardText);
        };

        // Mock _translateTextIndependent to avoid real HTTP requests
        const originalTranslateTextIndependent = indicator._translateTextIndependent;
        let independentTranslationText = "";
        let independentTranslationCallback = null;
        indicator._translateTextIndependent = function(fromText, callback) {
            independentTranslationText = fromText;
            independentTranslationCallback = callback;
        };

        try {
            // Reset state so startup events don't bleed into this test
            indicator._lastClipboardTime = null;
            indicator._lastClipboardText = null;
            if (indicator._internalCopyTimeoutId) {
                GLib.Source.remove(indicator._internalCopyTimeoutId);
                indicator._internalCopyTimeoutId = null;
            }
            indicator._isInternalCopy = false;
            indicator._settings.set_boolean('floating-auto-copy', false);
            indicator._settings.set_boolean('floating-background-mode', false);
            indicator._settings.set_boolean('floating-background-toast', true);
            // Gesture harness: Test 0 resets to ship-state (gesture OFF), so
            // each double-copy test must opt in explicitly.
            indicator._settings.set_boolean('double-copy-enabled', true);
            if (indicator._floatingWindow) {
                indicator._floatingWindow.destroy();
                indicator._floatingWindow = null;
            }

            // First copy
            mockTime = 1000000;
            mockClipboardText = "Double Copy Test input text";
            indicator._onSelectionChange(null, Meta.SelectionType.SELECTION_CLIPBOARD, null);

            // Check that the floating window is NOT created yet
            if (indicator._floatingWindow) {
                GLib.get_monotonic_time = originalGetMonotonicTime;
                Clipboard.get_text = originalClipboardGetText;
                Clipboard.set_text = originalClipboardSetText;
                indicator._translateTextIndependent = originalTranslateTextIndependent;
                return { success: false, error: "Floating window was created on a single copy!" };
            }

            // Simulate spurious duplicate signal <50ms — same content, must NOT trigger
            mockTime = 1010000;
            indicator._onSelectionChange(null, Meta.SelectionType.SELECTION_CLIPBOARD, null);

            if (independentTranslationCallback) {
                GLib.get_monotonic_time = originalGetMonotonicTime;
                Clipboard.get_text = originalClipboardGetText;
                Clipboard.set_text = originalClipboardSetText;
                indicator._translateTextIndependent = originalTranslateTextIndependent;
                return { success: false, error: "Spurious duplicate (<50ms) triggered translation!" };
            }

            // Second intentional copy — same content, 200ms later — must trigger
            mockTime = 1200000;
            indicator._onSelectionChange(null, Meta.SelectionType.SELECTION_CLIPBOARD, null);

            // Verify that _translateTextIndependent was triggered
            if (independentTranslationText !== "Double Copy Test input text" || !independentTranslationCallback) {
                GLib.get_monotonic_time = originalGetMonotonicTime;
                Clipboard.get_text = originalClipboardGetText;
                Clipboard.set_text = originalClipboardSetText;
                indicator._translateTextIndependent = originalTranslateTextIndependent;
                return { success: false, error: "Double-copy did not trigger independent translation!" };
            }

            // Call the callback to simulate translation completing
            independentTranslationCallback("Double Copy Test translated text");

            // Verify floating window is created
            if (!indicator._floatingWindow) {
                Clipboard.get_text = originalClipboardGetText;
                Clipboard.set_text = originalClipboardSetText;
                indicator._translateTextIndependent = originalTranslateTextIndependent;
                return { success: false, error: "Floating window was not created after double copy translation completed!" };
            }

            // Verify contents of the floating window
            let floatWin = indicator._floatingWindow;
            if (!floatWin.actor || !floatWin.overlay) {
                Clipboard.get_text = originalClipboardGetText;
                Clipboard.set_text = originalClipboardSetText;
                indicator._translateTextIndependent = originalTranslateTextIndependent;
                return { success: false, error: "Floating window structure is invalid!" };
            }

            // Verify children layout and close button click
            let children = floatWin.actor.get_children();
            if (children.length < 6) {
                Clipboard.get_text = originalClipboardGetText;
                Clipboard.set_text = originalClipboardSetText;
                indicator._translateTextIndependent = originalTranslateTextIndependent;
                return { success: false, error: "Floating window actor has insufficient children: " + children.length };
            }

            let closeBtn = children[0].get_children()[1];
            if (!(closeBtn instanceof St.Button)) {
                Clipboard.get_text = originalClipboardGetText;
                Clipboard.set_text = originalClipboardSetText;
                indicator._translateTextIndependent = originalTranslateTextIndependent;
                return { success: false, error: "Close button not found at expected layout position" };
            }

            // Verify copy button copies the text and destroys the window
            let copyBtn = children[5].get_children()[0];
            if (!(copyBtn instanceof St.Button)) {
                Clipboard.get_text = originalClipboardGetText;
                Clipboard.set_text = originalClipboardSetText;
                indicator._translateTextIndependent = originalTranslateTextIndependent;
                return { success: false, error: "Copy button not found at expected layout position" };
            }

            let copiedText = "";
            Clipboard.set_text = function(type, text) {
                copiedText = text;
            };

            copyBtn.emit('clicked', 0);
            if (copiedText !== "Double Copy Test translated text") {
                Clipboard.get_text = originalClipboardGetText;
                Clipboard.set_text = originalClipboardSetText;
                indicator._translateTextIndependent = originalTranslateTextIndependent;
                return { success: false, error: "Copy button did not copy targetText! Got: " + copiedText };
            }

            if (indicator._floatingWindow) {
                Clipboard.get_text = originalClipboardGetText;
                Clipboard.set_text = originalClipboardSetText;
                indicator._translateTextIndependent = originalTranslateTextIndependent;
                return { success: false, error: "Floating window was not destroyed after clicking Copy button!" };
            }

            // Test 8b: Auto Copy functionality for Double-copy
            const originalAutoCopyState = indicator._settings.get_boolean('floating-auto-copy');
            indicator._settings.set_boolean('floating-auto-copy', true);
            indicator._settings.set_boolean('double-copy-enabled', true);
            try {
                let autoCopiedText = "";
                Clipboard.set_text = function(type, text) {
                    autoCopiedText = text;
                };

                // Reset state for clean double-copy sequence
                indicator._lastClipboardTime = null;
                indicator._lastClipboardText = null;
                if (indicator._internalCopyTimeoutId) {
                    GLib.Source.remove(indicator._internalCopyTimeoutId);
                    indicator._internalCopyTimeoutId = null;
                }
                indicator._isInternalCopy = false;
                independentTranslationCallback = null;
                independentTranslationText = "";

                // Trigger double copy flow
                mockClipboardText = "Auto Copy Test input text";
                mockTime = 2000000;
                indicator._onSelectionChange(null, Meta.SelectionType.SELECTION_CLIPBOARD, null); // 1st
                mockTime = 2200000;
                indicator._onSelectionChange(null, Meta.SelectionType.SELECTION_CLIPBOARD, null); // 2nd (same text → triggers)

                if (!independentTranslationCallback) {
                    Clipboard.get_text = originalClipboardGetText;
                    Clipboard.set_text = originalClipboardSetText;
                    indicator._translateTextIndependent = originalTranslateTextIndependent;
                    return { success: false, error: "Auto-copy test did not trigger independent translation callback!" };
                }

                // Simulate translation completing
                independentTranslationCallback("Auto Copy Test translated text");

                // Verify that it auto-copied to clipboard immediately without clicking the copy button
                if (autoCopiedText !== "Auto Copy Test translated text") {
                    Clipboard.get_text = originalClipboardGetText;
                    Clipboard.set_text = originalClipboardSetText;
                    indicator._translateTextIndependent = originalTranslateTextIndependent;
                    return { success: false, error: "Auto-copy failed to automatically copy translated text! Got: " + autoCopiedText };
                }

                // Clean up the spawned window
                if (indicator._floatingWindow) {
                    indicator._floatingWindow.destroy();
                    indicator._floatingWindow = null;
                }
            } finally {
                indicator._settings.set_boolean('floating-auto-copy', originalAutoCopyState);
            }

            // Test 8c: Double-copy in background mode with toast enabled
            const originalBgMode = indicator._settings.get_boolean('floating-background-mode');
            const originalBgToast = indicator._settings.get_boolean('floating-background-toast');
            indicator._settings.set_boolean('floating-background-mode', true);
            indicator._settings.set_boolean('floating-background-toast', true);
            indicator._settings.set_boolean('double-copy-enabled', true);

            const MessageTray = await import("resource:///org/gnome/shell/ui/messageTray.js");
            const originalAddNotification = MessageTray.Source.prototype.addNotification;
            let notifyTitle = null;
            let notifyBody = null;
            let notifyCalled = false;
            MessageTray.Source.prototype.addNotification = function(notification) {
                notifyCalled = true;
                notifyTitle = notification.title;
                notifyBody = notification.body;
            };

            try {
                let bgCopiedText = "";
                Clipboard.set_text = function(type, text) {
                    bgCopiedText = text;
                };

                // Reset state
                indicator._lastClipboardTime = null;
                indicator._lastClipboardText = null;
                if (indicator._internalCopyTimeoutId) {
                    GLib.Source.remove(indicator._internalCopyTimeoutId);
                    indicator._internalCopyTimeoutId = null;
                }
                indicator._isInternalCopy = false;
                independentTranslationCallback = null;
                independentTranslationText = "";

                // Trigger double copy
                mockClipboardText = "Bg Mode Toast input text";
                mockTime = 3000000;
                indicator._onSelectionChange(null, Meta.SelectionType.SELECTION_CLIPBOARD, null); // 1st
                mockTime = 3200000;
                indicator._onSelectionChange(null, Meta.SelectionType.SELECTION_CLIPBOARD, null); // 2nd

                if (!independentTranslationCallback) {
                    Clipboard.get_text = originalClipboardGetText;
                    Clipboard.set_text = originalClipboardSetText;
                    indicator._translateTextIndependent = originalTranslateTextIndependent;
                    MessageTray.Source.prototype.addNotification = originalAddNotification;
                    return { success: false, error: "Bg Mode Toast test did not trigger translation callback!" };
                }

                // Simulate translation completing
                independentTranslationCallback("Bg Mode Toast translated text");

                // Verify that:
                // 1. Floating window was NOT created
                if (indicator._floatingWindow) {
                    Clipboard.get_text = originalClipboardGetText;
                    Clipboard.set_text = originalClipboardSetText;
                    indicator._translateTextIndependent = originalTranslateTextIndependent;
                    MessageTray.Source.prototype.addNotification = originalAddNotification;
                    return { success: false, error: "Floating window was created in background mode!" };
                }

                // 2. Translated text was copied to clipboard
                if (bgCopiedText !== "Bg Mode Toast translated text") {
                    Clipboard.get_text = originalClipboardGetText;
                    Clipboard.set_text = originalClipboardSetText;
                    indicator._translateTextIndependent = originalTranslateTextIndependent;
                    MessageTray.Source.prototype.addNotification = originalAddNotification;
                    return { success: false, error: "Bg Mode Toast test failed to copy translation to clipboard! Got: " + bgCopiedText };
                }

                // 3. Notification was shown
                if (!notifyCalled || !notifyTitle || notifyBody !== "Bg Mode Toast input text → Bg Mode Toast translated text") {
                    Clipboard.get_text = originalClipboardGetText;
                    Clipboard.set_text = originalClipboardSetText;
                    indicator._translateTextIndependent = originalTranslateTextIndependent;
                    MessageTray.Source.prototype.addNotification = originalAddNotification;
                    return { success: false, error: "Bg Mode Toast notification not shown or content incorrect! Got: " + notifyBody };
                }
            } finally {
                MessageTray.Source.prototype.addNotification = originalAddNotification;
                indicator._settings.set_boolean('floating-background-mode', originalBgMode);
                indicator._settings.set_boolean('floating-background-toast', originalBgToast);
            }

            // Test 8d: Double-copy in background mode with toast disabled
            const originalBgModeD = indicator._settings.get_boolean('floating-background-mode');
            const originalBgToastD = indicator._settings.get_boolean('floating-background-toast');
            indicator._settings.set_boolean('floating-background-mode', true);
            indicator._settings.set_boolean('floating-background-toast', false);
            indicator._settings.set_boolean('double-copy-enabled', true);

            let notifyCalledD = false;
            MessageTray.Source.prototype.addNotification = function(notification) {
                notifyCalledD = true;
            };

            try {
                let bgCopiedText = "";
                Clipboard.set_text = function(type, text) {
                    bgCopiedText = text;
                };

                // Reset state
                indicator._lastClipboardTime = null;
                indicator._lastClipboardText = null;
                if (indicator._internalCopyTimeoutId) {
                    GLib.Source.remove(indicator._internalCopyTimeoutId);
                    indicator._internalCopyTimeoutId = null;
                }
                indicator._isInternalCopy = false;
                independentTranslationCallback = null;
                independentTranslationText = "";

                // Trigger double copy
                mockClipboardText = "Bg Mode No Toast input text";
                mockTime = 4000000;
                indicator._onSelectionChange(null, Meta.SelectionType.SELECTION_CLIPBOARD, null); // 1st
                mockTime = 4200000;
                indicator._onSelectionChange(null, Meta.SelectionType.SELECTION_CLIPBOARD, null); // 2nd

                if (!independentTranslationCallback) {
                    Clipboard.get_text = originalClipboardGetText;
                    Clipboard.set_text = originalClipboardSetText;
                    indicator._translateTextIndependent = originalTranslateTextIndependent;
                    MessageTray.Source.prototype.addNotification = originalAddNotification;
                    return { success: false, error: "Bg Mode No Toast test did not trigger translation callback!" };
                }

                // Simulate translation completing
                independentTranslationCallback("Bg Mode No Toast translated text");

                // Verify that:
                // 1. Floating window was NOT created
                if (indicator._floatingWindow) {
                    Clipboard.get_text = originalClipboardGetText;
                    Clipboard.set_text = originalClipboardSetText;
                    indicator._translateTextIndependent = originalTranslateTextIndependent;
                    MessageTray.Source.prototype.addNotification = originalAddNotification;
                    return { success: false, error: "Floating window was created in background mode (no toast)!" };
                }

                // 2. Translated text was copied to clipboard
                if (bgCopiedText !== "Bg Mode No Toast translated text") {
                    Clipboard.get_text = originalClipboardGetText;
                    Clipboard.set_text = originalClipboardSetText;
                    indicator._translateTextIndependent = originalTranslateTextIndependent;
                    MessageTray.Source.prototype.addNotification = originalAddNotification;
                    return { success: false, error: "Bg Mode No Toast test failed to copy translation! Got: " + bgCopiedText };
                }

                // 3. Notification was NOT shown
                if (notifyCalledD) {
                    Clipboard.get_text = originalClipboardGetText;
                    Clipboard.set_text = originalClipboardSetText;
                    indicator._translateTextIndependent = originalTranslateTextIndependent;
                    MessageTray.Source.prototype.addNotification = originalAddNotification;
                    return { success: false, error: "Bg Mode notification was shown even though toast option is disabled!" };
                }
            } finally {
                MessageTray.Source.prototype.addNotification = originalAddNotification;
                indicator._settings.set_boolean('floating-background-mode', originalBgModeD);
                indicator._settings.set_boolean('floating-background-toast', originalBgToastD);
            }

        } catch (e) {
            GLib.get_monotonic_time = originalGetMonotonicTime;
            Clipboard.get_text = originalClipboardGetText;
            Clipboard.set_text = originalClipboardSetText;
            indicator._translateTextIndependent = originalTranslateTextIndependent;
            if (indicator._floatingWindow) {
                indicator._floatingWindow.destroy();
                indicator._floatingWindow = null;
            }
            return { success: false, error: "Double-copy shortcut test failed: " + e.message };
        } finally {
            GLib.get_monotonic_time = originalGetMonotonicTime;
            Clipboard.get_text = originalClipboardGetText;
            Clipboard.set_text = originalClipboardSetText;
            indicator._translateTextIndependent = originalTranslateTextIndependent;
        }

        // Test 8e: P0 gate — gesture OFF + auto-paste OFF → no clipboard read at all.
        // Regression test: system-wide copies must never be inspected when disarmed.
        try {
            const Meta = imports.gi.Meta;
            const St = imports.gi.St;
            const Clipboard = St.Clipboard.get_default();

            const origGesture = indicator._settings.get_boolean('double-copy-enabled');
            indicator._settings.set_boolean('double-copy-enabled', false);
            const origAutoPaste = indicator.autoPasteSwitch.state;
            indicator.autoPasteSwitch.setToggleState(false);
            const origAutoTranslate = indicator.autoTranslateSwitch.state;
            indicator.autoTranslateSwitch.setToggleState(false);
            indicator._lastClipboardTime = null;
            indicator._lastClipboardText = null;
            indicator._isInternalCopy = false;

            let readCount = 0;
            const origGetText = Clipboard.get_text;
            Clipboard.get_text = function(type, callback) {
                readCount++;
                callback(Clipboard, "P0 probe text");
            };
            try {
                indicator._onSelectionChange(null, Meta.SelectionType.SELECTION_CLIPBOARD, null);
                indicator._onSelectionChange(null, Meta.SelectionType.SELECTION_CLIPBOARD, null);
                if (readCount !== 0) {
                    return { success: false, error: "P0 gate violated: clipboard read " + readCount + "x with gesture OFF + auto-paste OFF" };
                }
            } finally {
                Clipboard.get_text = origGetText;
                indicator._settings.set_boolean('double-copy-enabled', origGesture);
                indicator.autoPasteSwitch.setToggleState(origAutoPaste);
                indicator.autoTranslateSwitch.setToggleState(origAutoTranslate);
            }
        } catch (e) {
            return { success: false, error: "P0 gate test failed: " + (e.message || String(e)) };
        }

        // Test 8f: kill-switch — gesture OFF + auto-paste ON reads but never triggers;
        // flipping the gesture back ON re-arms the double-copy trigger.
        try {
            const Meta = imports.gi.Meta;
            const GLib = imports.gi.GLib;
            const St = imports.gi.St;
            const Clipboard = St.Clipboard.get_default();

            const origMonotonic = GLib.get_monotonic_time;
            let mockTime = 10000000;
            GLib.get_monotonic_time = function() {
                return mockTime;
            };

            const origGetText = Clipboard.get_text;
            let mockClipboardText = "Kill switch probe";
            Clipboard.get_text = function(type, callback) {
                callback(Clipboard, mockClipboardText);
            };

            const origIndependent = indicator._translateTextIndependent;
            let triggeredText = null;
            indicator._translateTextIndependent = function(fromText, callback) {
                triggeredText = fromText;
            };

            const origGesture = indicator._settings.get_boolean('double-copy-enabled');
            const origAutoPaste = indicator.autoPasteSwitch.state;
            const origAutoTranslate = indicator.autoTranslateSwitch.state;
            indicator.autoTranslateSwitch.setToggleState(false);
            indicator.autoPasteSwitch.setToggleState(true);
            try {
                // Disarmed: two identical copies must NOT trigger...
                indicator._settings.set_boolean('double-copy-enabled', false);
                indicator._lastClipboardTime = null;
                indicator._lastClipboardText = null;
                indicator._isInternalCopy = false;
                mockTime = 10000000;
                indicator._onSelectionChange(null, Meta.SelectionType.SELECTION_CLIPBOARD, null);
                mockTime = 10200000;
                indicator._onSelectionChange(null, Meta.SelectionType.SELECTION_CLIPBOARD, null);
                if (triggeredText !== null) {
                    return { success: false, error: "Kill-switch violated: double-copy triggered with gesture OFF" };
                }
                if (indicator._lastClipboardText !== null) {
                    return { success: false, error: "Kill-switch violated: clipboard state armed while gesture OFF" };
                }

                // Re-armed: same sequence must trigger again.
                indicator._settings.set_boolean('double-copy-enabled', true);
                indicator._lastClipboardTime = null;
                indicator._lastClipboardText = null;
                triggeredText = null;
                mockTime = 11000000;
                indicator._onSelectionChange(null, Meta.SelectionType.SELECTION_CLIPBOARD, null);
                mockTime = 11200000;
                indicator._onSelectionChange(null, Meta.SelectionType.SELECTION_CLIPBOARD, null);
                if (triggeredText !== "Kill switch probe") {
                    return { success: false, error: "Kill-switch re-arm failed: double-copy did not trigger with gesture ON" };
                }
            } finally {
                GLib.get_monotonic_time = origMonotonic;
                Clipboard.get_text = origGetText;
                indicator._translateTextIndependent = origIndependent;
                indicator._settings.set_boolean('double-copy-enabled', origGesture);
                indicator.autoPasteSwitch.setToggleState(origAutoPaste);
                indicator.autoTranslateSwitch.setToggleState(origAutoTranslate);
                indicator._lastClipboardTime = null;
                indicator._lastClipboardText = null;
            }
        } catch (e) {
            return { success: false, error: "Kill-switch test failed: " + (e.message || String(e)) };
        }

        // Test 8f2: custom detection window — narrow window triggers inside
        // and ignores outside; helper clamps and falls back sanely.
        try {
            const Meta = imports.gi.Meta;
            const GLib = imports.gi.GLib;
            const St = imports.gi.St;
            const Clipboard = St.Clipboard.get_default();

            if (typeof indicator._getDoubleCopyWindowUs !== 'function') {
                return { success: false, error: "Custom window test failed: _getDoubleCopyWindowUs missing" };
            }
            const origDelay = indicator._settings.get_int('double-copy-delay');
            const origMonotonic = GLib.get_monotonic_time;
            let mockTime = 20000000;
            GLib.get_monotonic_time = function() {
                return mockTime;
            };
            const origGetText = Clipboard.get_text;
            let mockClipboardText = "Custom window probe";
            Clipboard.get_text = function(type, callback) {
                callback(Clipboard, mockClipboardText);
            };
            const origIndependent = indicator._translateTextIndependent;
            let triggeredText = null;
            indicator._translateTextIndependent = function(fromText, callback) {
                triggeredText = fromText;
            };
            const origGesture = indicator._settings.get_boolean('double-copy-enabled');
            const origAutoPaste = indicator.autoPasteSwitch.state;
            const origAutoTranslate = indicator.autoTranslateSwitch.state;
            indicator.autoTranslateSwitch.setToggleState(false);
            indicator.autoPasteSwitch.setToggleState(false);
            try {
                indicator._settings.set_boolean('double-copy-enabled', true);
                // Sanity: default helper returns 2000ms in microseconds.
                indicator._settings.set_int('double-copy-delay', 2000);
                if (indicator._getDoubleCopyWindowUs() !== 2000000) {
                    return { success: false, error: "Window helper returned " + indicator._getDoubleCopyWindowUs() + " instead of 2000000" };
                }
                // Narrow window: +400ms triggers, +800ms does not.
                indicator._settings.set_int('double-copy-delay', 500);
                if (indicator._getDoubleCopyWindowUs() !== 500000) {
                    return { success: false, error: "Window helper did not respect custom 500ms delay" };
                }
                indicator._lastClipboardTime = null;
                indicator._lastClipboardText = null;
                indicator._isInternalCopy = false;
                triggeredText = null;
                mockTime = 20000000;
                indicator._onSelectionChange(null, Meta.SelectionType.SELECTION_CLIPBOARD, null);
                mockTime = 20400000; // +400ms: inside 500ms window
                indicator._onSelectionChange(null, Meta.SelectionType.SELECTION_CLIPBOARD, null);
                if (triggeredText !== "Custom window probe") {
                    return { success: false, error: "Custom 500ms window failed: +400ms copy did not trigger" };
                }
                indicator._lastClipboardTime = null;
                indicator._lastClipboardText = null;
                indicator._isInternalCopy = false;
                triggeredText = null;
                mockTime = 21000000;
                indicator._onSelectionChange(null, Meta.SelectionType.SELECTION_CLIPBOARD, null);
                mockTime = 21800000; // +800ms: outside 500ms window
                indicator._onSelectionChange(null, Meta.SelectionType.SELECTION_CLIPBOARD, null);
                if (triggeredText !== null) {
                    return { success: false, error: "Custom 500ms window failed: +800ms copy triggered anyway" };
                }
            } finally {
                GLib.get_monotonic_time = origMonotonic;
                Clipboard.get_text = origGetText;
                indicator._translateTextIndependent = origIndependent;
                indicator._settings.set_int('double-copy-delay', origDelay);
                indicator._settings.set_boolean('double-copy-enabled', origGesture);
                indicator.autoPasteSwitch.setToggleState(origAutoPaste);
                indicator.autoTranslateSwitch.setToggleState(origAutoTranslate);
                indicator._lastClipboardTime = null;
                indicator._lastClipboardText = null;
            }
        } catch (e) {
            return { success: false, error: "Custom window test failed: " + (e.message || String(e)) };
        }

        // Test 8g: typing debounce — rapid typing collapses to a single translation;
        // with auto-translate OFF no debounce is even armed (synchronous check,
        // no wall-clock wait so the Eval stays well within the poll window).
        try {
            const GLib = imports.gi.GLib;
            const origTrigger = indicator._triggerTranslation;
            let triggerCount = 0;
            indicator._triggerTranslation = function() {
                triggerCount++;
            };
            const origAutoTranslate = indicator.autoTranslateSwitch.state;
            if (indicator._typingDebounceId) {
                GLib.Source.remove(indicator._typingDebounceId);
                indicator._typingDebounceId = null;
            }
            try {
                indicator.autoTranslateSwitch.setToggleState(true);
                indicator.inputEntry.get_clutter_text().set_text("d");
                indicator.inputEntry.get_clutter_text().set_text("de");
                indicator.inputEntry.get_clutter_text().set_text("deb");
                if (!indicator._typingDebounceId) {
                    return { success: false, error: "Debounce not armed: no pending translation after typing" };
                }
                await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
                    resolve();
                    return GLib.SOURCE_REMOVE;
                }));
                if (triggerCount !== 1) {
                    return { success: false, error: "Debounce failed: expected 1 translation after rapid typing, got " + triggerCount };
                }
                indicator.autoTranslateSwitch.setToggleState(false);
                indicator.inputEntry.get_clutter_text().set_text("debo");
                if (indicator._typingDebounceId !== null || triggerCount !== 1) {
                    return { success: false, error: "Auto-translate OFF failed: typing armed a translation while disarmed" };
                }
            } finally {
                indicator._triggerTranslation = origTrigger;
                indicator.autoTranslateSwitch.setToggleState(origAutoTranslate);
                if (indicator._typingDebounceId) {
                    GLib.Source.remove(indicator._typingDebounceId);
                    indicator._typingDebounceId = null;
                }
            }
        } catch (e) {
            return { success: false, error: "Debounce test failed: " + (e.message || String(e)) };
        }

        // Test 9: FloatingTranslationWindow layout, centering, and Escape key handler
        try {
            let FloatingTranslationWindow = indicator.FloatingTranslationWindow;
            let win = new FloatingTranslationWindow("Input text", "Output text", "EN", "FR", () => {
                indicator._floatingWindow = null;
            });

            // Verify initial overlay and actor properties
            if (win.overlay.style_class !== 'translate-floating-overlay') {
                win.destroy();
                return { success: false, error: "Overlay style class is incorrect" };
            }
            if (win.actor.style_class !== 'translate-floating-window') {
                win.destroy();
                return { success: false, error: "Actor style class is incorrect" };
            }

            // Simulate allocation event to trigger centering logic
            win.actor.notify('allocation');

            let monitor = Main.layoutManager.primaryMonitor;
            let expectedX = monitor.x + (monitor.width - win.actor.get_width()) / 2;
            let expectedY = monitor.y + (monitor.height - win.actor.get_height()) / 2;
            if (win.actor.x !== expectedX || win.actor.y !== expectedY) {
                win.destroy();
                return { success: false, error: "FloatingTranslationWindow was not centered correctly! Expected: " + expectedX + "," + expectedY + " Got: " + win.actor.x + "," + win.actor.y };
            }

            // Verify escape key event destroys the window
            let Clutter = imports.gi.Clutter;
            let mockEvent = {
                get_key_symbol: () => Clutter.KEY_Escape
            };

            // Set win to a property so we can track it or destroy it
            indicator._floatingWindow = win;

            // Trigger the keypress handler directly
            win._onKeyPress(global.stage, mockEvent);

            if (indicator._floatingWindow) {
                indicator._floatingWindow.destroy();
                indicator._floatingWindow = null;
                return { success: false, error: "Escape key did not destroy FloatingTranslationWindow!" };
            }
        } catch (e) {
            if (indicator._floatingWindow) {
                indicator._floatingWindow.destroy();
                indicator._floatingWindow = null;
            }
            return { success: false, error: "FloatingTranslationWindow centering/Escape test failed: " + e.message };
        }

        // Test 10: insecure DeepL URL is refused on BOTH translate paths.
        // Regression: the floating path once bypassed the https guard, which
        // would send the API key over plaintext http. Neither path may issue
        // HTTP, invoke its callback, or leave the UI in-flight.
        {
            const origService10 = indicator._settings.get_enum('translation-service');
            const origUrl10 = indicator._settings.get_string('url');
            const origAsync10 = indicator._httpSession.send_and_read_async;
            let httpIssued10 = false;
            try {
                indicator._settings.set_enum('translation-service', 0); // DeepL
                indicator._settings.set_string('url', 'http://api-free.deepl.com/v2/translate');
                await _pumpMainloop();
                indicator._httpSession.send_and_read_async = function() { httpIssued10 = true; };

                // Panel path
                let panelCb10 = false;
                indicator._translateText(true, 'Hello', () => { panelCb10 = true; });
                if (httpIssued10) return { success: false, error: 'Test 10: panel path sent HTTP over insecure URL' };
                if (panelCb10) return { success: false, error: 'Test 10: panel path invoked callback after https refusal' };
                if (indicator._cancellable !== null) return { success: false, error: 'Test 10: panel path leaked cancellable after refusal' };
                if (indicator.translateBtn.label !== 'Translate') return { success: false, error: 'Test 10: panel Translate button stuck after refusal' };
                const errText10 = String(indicator.errorLabel ? indicator.errorLabel.text : '');
                if (!errText10.includes('https')) return { success: false, error: 'Test 10: panel path did not surface the https error, got: ' + errText10 };

                // Independent (floating/background) path
                let indepCb10 = false;
                indicator._translateTextIndependent('Hello', () => { indepCb10 = true; });
                if (httpIssued10) return { success: false, error: 'Test 10: independent path sent HTTP over insecure URL' };
                if (indepCb10) return { success: false, error: 'Test 10: independent path invoked callback after https refusal' };
            } finally {
                indicator._httpSession.send_and_read_async = origAsync10;
                try { indicator._settings.set_enum('translation-service', origService10); } catch (e) {}
                try { indicator._settings.set_string('url', origUrl10); } catch (e) {}
                await _pumpMainloop();
            }
        }

        // Test 11: input-hardening matrix on the live instance.
        {
            if (indicator._isDeepLUrlSecure() !== true) return { success: false, error: 'Test 11: default https URL not recognised as secure' };
            const defUrl11 = indicator._settings.get_default_value('url').unpack();
            try {
                indicator._settings.set_string('url', 'http://plain.example/translate');
                await _pumpMainloop();
                if (indicator._isDeepLUrlSecure() !== false) return { success: false, error: 'Test 11: http URL recognised as secure' };
                indicator._settings.set_string('url', '');
                await _pumpMainloop();
                if (indicator._isDeepLUrlSecure() !== false) return { success: false, error: 'Test 11: empty URL recognised as secure' };
            } finally {
                try { indicator._settings.set_string('url', defUrl11); } catch (e) {}
                await _pumpMainloop();
            }
            if (indicator._get_country_code('Garbage (XX)') !== 'XX') return { success: false, error: 'Test 11: parenthesised tag misparsed' };
            if (typeof indicator._get_country_code('Garbage (XX)') !== 'string') return { success: false, error: 'Test 11: corrupt tag did not yield a string' };
            if (indicator._get_country_code(null) !== 'AUTO') return { success: false, error: 'Test 11: null language tag did not degrade to AUTO' };
            if (indicator._get_country_code('') !== 'AUTO') return { success: false, error: 'Test 11: empty language tag did not degrade to AUTO' };
            if (indicator._get_country_code('German (DE)') !== 'DE') return { success: false, error: 'Test 11: valid language tag misparsed' };
        }

        // Test 12: corrupt dconf (invalid enum nick, writable only via dconf
        // since GSettings validates API writes) degrades to sl=auto and a
        // working translation — never a TypeError crash.
        {
            const GLib12 = imports.gi.GLib;
            const DCONF_SRC = '/org/gnome/shell/extensions/fast-translate/source-lang';
            const [okR12, outR12] = GLib12.spawn_sync(null, ['dconf', 'read', DCONF_SRC], null, GLib12.SpawnFlags.SEARCH_PATH, null);
            const savedSrc12 = okR12 ? imports.byteArray.toString(outR12).trim() : '';
            const origService12 = indicator._settings.get_enum('translation-service');
            const origAsync12 = indicator._httpSession.send_and_read_async;
            const origFinish12 = indicator._httpSession.send_and_read_finish;
            let capturedMsg12 = null;
            let capturedCb12 = null;
            let capturedSession12 = null;
            try {
                const [okW12] = GLib12.spawn_sync(null, ['dconf', 'write', DCONF_SRC, "'Garbage'"], null, GLib12.SpawnFlags.SEARCH_PATH, null);
                if (!okW12) return { success: false, error: 'Test 12: dconf write of corrupt value failed' };
                indicator._settings.set_enum('translation-service', 1); // Google
                await _pumpMainloop();
                await _pumpMainloop();
                if (indicator._source_lang !== 'AUTO') return { success: false, error: 'Test 12: corrupt source-lang not degraded, got ' + indicator._source_lang };
                indicator._httpSession.send_and_read_async = function(message, priority, cancellable, callback) {
                    capturedMsg12 = message;
                    capturedSession12 = this;
                    capturedCb12 = callback;
                };
                indicator.outputEntry.get_clutter_text().set_text('');
                let out12 = null;
                indicator._translateText(true, 'Hello', (t) => { out12 = t; });
                if (!capturedCb12) return { success: false, error: 'Test 12: no HTTP issued after corrupt-dconf degradation' };
                const uri12 = capturedMsg12.uri ? capturedMsg12.uri.to_string() : (capturedMsg12.get_uri ? capturedMsg12.get_uri().to_string() : '');
                if (!uri12.includes('sl=auto')) return { success: false, error: 'Test 12: expected sl=auto in request, got: ' + uri12 };
                Object.defineProperty(capturedMsg12, 'status_code', { get: () => 200, configurable: true });
                indicator._httpSession.send_and_read_finish = function(result) {
                    const GLib = imports.gi.GLib;
                    const text = JSON.stringify([[["Hola", "Hello", null, null, 1]], null, "en"]);
                    return new GLib.Bytes(new TextEncoder().encode(text));
                };
                capturedCb12(capturedSession12, 'dummy_result');
                if (out12 !== 'Hola') return { success: false, error: 'Test 12: degraded translation did not return output' };
                if (indicator.translateBtn.label !== 'Translate') return { success: false, error: 'Test 12: button stuck after degraded translation' };
                if (indicator._cancellable !== null) return { success: false, error: 'Test 12: cancellable leaked after degraded translation' };
            } finally {
                indicator._httpSession.send_and_read_async = origAsync12;
                indicator._httpSession.send_and_read_finish = origFinish12;
                try {
                    if (savedSrc12) GLib12.spawn_sync(null, ['dconf', 'write', DCONF_SRC, savedSrc12], null, GLib12.SpawnFlags.SEARCH_PATH, null);
                    else GLib12.spawn_sync(null, ['dconf', 'reset', DCONF_SRC], null, GLib12.SpawnFlags.SEARCH_PATH, null);
                } catch (e) {}
                try { indicator._settings.set_enum('translation-service', origService12); } catch (e) {}
                await _pumpMainloop();
            }
        }

        // Restore mock functions
        indicator._httpSession.send_and_read_async = originalSendReadAsync;
        indicator._httpSession.send_and_read_finish = originalSendReadFinish;

        _restoreSettingsSnapshot();
        return { success: true };
    } catch (e) {
        try { _restoreSettingsSnapshot(); } catch (_) {}
        return { success: false, error: e.message || String(e) };
    }
})();

global.testRunnerPromise.then(res => {
    global.testRunnerResult = JSON.stringify(res);
}).catch(err => {
    global.testRunnerResult = JSON.stringify({ success: false, error: err.message || String(err) });
});

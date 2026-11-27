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
        // Snapshot every schema key (dynamic enumeration so new keys are
        // covered), reset to schema defaults (reviewers check defaults
        // first; resets also make reruns idempotent). Snapshot is restored
        // before the success return and in the catch below; individual
        // tests additionally use try/finally.
        let TOUCHED_KEYS = null;
        try { TOUCHED_KEYS = indicator._settings.settings_schema.list_keys(); } catch (e) { TOUCHED_KEYS = null; }
        if (!TOUCHED_KEYS || TOUCHED_KEYS.length === 0) {
            TOUCHED_KEYS = ['translation-service', 'source-lang', 'target-lang',
                'url', 'apikey', 'floating-auto-copy', 'floating-background-mode',
                'floating-background-toast', 'auto-paste', 'auto-translate', 'auto-copy',
                'keybinding-translate-clipboard', 'notifications'];
        }
        const _settingsSnapshot = {};
        for (const _k of TOUCHED_KEYS) {
            try { _settingsSnapshot[_k] = indicator._settings.get_value(_k); } catch (e) { _settingsSnapshot[_k] = null; }
        }
        const _restoreSettingsSnapshot = () => {
            for (const _k of TOUCHED_KEYS) {
                try { if (_settingsSnapshot[_k] != null) indicator._settings.set_value(_k, _settingsSnapshot[_k]); } catch (e) {}
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
        const _waitMainloop = milliseconds => new Promise(resolve => {
            const GLib = imports.gi.GLib;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => { resolve(); return GLib.SOURCE_REMOVE; });
        });
        await _pumpMainloop();

        // Speech UI limits: no network, restore text even on failure.
        const speechInput = indicator.inputEntry.get_text();
        const speechOutput = indicator.outputEntry.get_text();
        try {
            indicator.inputEntry.set_text("a".repeat(500));
            indicator.outputEntry.set_text("😀".repeat(500));
            if (!indicator.sourceSpeechBtn.reactive || !indicator.targetSpeechBtn.reactive)
                throw new Error("Speech buttons disabled at 500 code points");
            indicator.inputEntry.set_text("a".repeat(501));
            indicator.outputEntry.set_text("😀".repeat(501));
            if (indicator.sourceSpeechBtn.reactive || indicator.targetSpeechBtn.reactive)
                throw new Error("Speech buttons enabled above 500 code points");
            indicator.inputEntry.set_text("");
            if (indicator.sourceSpeechBtn.reactive)
                throw new Error("Speech enabled for empty text");
        } finally {
            indicator.inputEntry.set_text(speechInput);
            indicator.outputEntry.set_text(speechOutput);
        }

        const speechWindow = new indicator.FloatingTranslationWindow(
            "a".repeat(500), "a".repeat(501), "EN", "FR", null, null,
            indicator._settings, indicator._speech);
        try {
            if (!speechWindow.sourceSpeechBtn.reactive || speechWindow.targetSpeechBtn.reactive)
                throw new Error("Floating speech limit incorrect");
        } finally {
            speechWindow.destroy();
        }

        // Test 0b: audit schema *defaults* (state-independent: reads defaults,
        // not live values). Safe-default contract EGO reviewers check first.
        const _def = (k) => indicator._settings.get_default_value(k).deep_unpack();
        const _safeDefaults = [
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
        const _kbDef = _def('keybinding-translate-clipboard');
        if (!Array.isArray(_kbDef) || _kbDef.length !== 1 || _kbDef[0] !== '<Control><Alt>e') {
            _restoreSettingsSnapshot();
            return { success: false, error: 'Unexpected default shortcut: ' + JSON.stringify(_kbDef) };
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

        // Test 8: Quick Translate copies the active selection and routes it
        // to the floating/background translation pipeline.
        try {
            const originalCopySelection = indicator._copySelectionForQuickTranslate;
            const originalTriggerFloating = indicator._triggerFloatingTranslation;
            let mockSelectedText = "Quick Translate input";
            let triggeredText = null;

            indicator._copySelectionForQuickTranslate = function(callback) {
                callback(mockSelectedText);
            };
            indicator._triggerFloatingTranslation = function(text) {
                triggeredText = text;
            };

            try {
                indicator._translateClipboardShortcut();
                await _waitMainloop(350);
                if (!indicator._quickTranslateLoading) {
                    return { success: false, error: "Quick Translate did not show loading UI after the display delay" };
                }
                if (triggeredText !== "Quick Translate input") {
                    return { success: false, error: "Quick Translate did not route clipboard text to the popup pipeline" };
                }

                triggeredText = null;
                mockSelectedText = "   ";
                indicator._translateClipboardShortcut();
                if (triggeredText !== null) {
                    return { success: false, error: "Quick Translate must ignore an empty selection" };
                }
                await _waitMainloop(450);
                if (indicator._quickTranslateLoading) {
                    return { success: false, error: "Quick Translate left loading UI after an empty selection and minimum display time" };
                }
            } finally {
                indicator._copySelectionForQuickTranslate = originalCopySelection;
                indicator._triggerFloatingTranslation = originalTriggerFloating;
                indicator._hideQuickTranslateLoading();
            }
        } catch (e) {
            return { success: false, error: "Quick Translate shortcut test failed: " + (e.message || String(e)) };
        }

        // Loading popover stays visible until the matching translation settles,
        // then disappears only after the result popup has been created.
        try {
            const originalCopySelection = indicator._copySelectionForQuickTranslate;
            const originalIndependent = indicator._translateTextIndependent;
            const originalBackground = indicator._settings.get_boolean("floating-background-mode");
            const pending = [];

            indicator._settings.set_boolean("floating-background-mode", false);
            await _pumpMainloop();
            indicator._copySelectionForQuickTranslate = function(callback) {
                callback("Loading lifecycle input");
            };
            indicator._translateTextIndependent = function(text, callback, onSettled) {
                pending.push([callback, onSettled]);
            };

            try {
                indicator._translateClipboardShortcut();
                const compactLoading = indicator._quickTranslateLoading;
                if (!compactLoading || compactLoading.actor.width !== 36 ||
                    compactLoading.actor.height !== 36 || compactLoading.label.opacity !== 0) {
                    return { success: false, error: "Quick Translate did not expose its compact spinner frame first" };
                }
                const [pivotX, pivotY] = compactLoading.spinner.get_pivot_point();
                if (pivotX !== 0.5 || pivotY !== 0.5) {
                    return { success: false, error: "Quick Translate spinner does not rotate around its center" };
                }
                await _waitMainloop(350);
                const firstLoading = indicator._quickTranslateLoading;
                if (!firstLoading || !firstLoading.actor ||
                    firstLoading.actor.style_class !== "translate-loading-popover") {
                    return { success: false, error: "Quick Translate loading popover was not created" };
                }
                if (firstLoading.actor.width >= 200 || firstLoading.label.opacity !== 255) {
                    return { success: false, error: "Quick Translate loading popover did not expand compactly" };
                }

                firstLoading.actor.notify("allocation");
                const [ptrX, ptrY] = global.get_pointer();
                const monIdx = Math.max(0, Main.layoutManager.monitors.findIndex(m =>
                    ptrX >= m.x && ptrX < m.x + m.width && ptrY >= m.y && ptrY < m.y + m.height));
                const workArea = Main.layoutManager.getWorkAreaForMonitor(monIdx);
                const [, loadingWidth] = firstLoading.actor.get_preferred_width(-1);
                const [, loadingHeight] = firstLoading.actor.get_preferred_height(loadingWidth);
                if (firstLoading.actor.x < workArea.x || firstLoading.actor.y < workArea.y ||
                    firstLoading.actor.x + loadingWidth > workArea.x + workArea.width ||
                    firstLoading.actor.y + loadingHeight > workArea.y + workArea.height) {
                    return { success: false, error: "Quick Translate loading popover left the work area" };
                }

                pending[0][0]("Translated result", "EN");
                if (!indicator._floatingWindow) {
                    return { success: false, error: "Translation result popup was not created" };
                }
                if (indicator._floatingWindow.actor.x !== firstLoading.actor.x ||
                    indicator._floatingWindow.actor.y !== firstLoading.actor.y) {
                    return { success: false, error: "Translation popup did not replace the loader at the same coordinates" };
                }
                if (indicator._quickTranslateLoading !== firstLoading) {
                    return { success: false, error: "Loading popover disappeared before translation settled" };
                }
                pending[0][1]();
                await _waitMainloop(450);
                if (indicator._quickTranslateLoading) {
                    return { success: false, error: "Loading popover remained after its minimum display time" };
                }
                indicator._floatingWindow.destroy();
                indicator._floatingWindow = null;

                indicator._translateClipboardShortcut();
                await _waitMainloop(350);
                const oldSettled = pending[1][1];
                indicator._translateClipboardShortcut();
                await _waitMainloop(350);
                const currentLoading = indicator._quickTranslateLoading;
                oldSettled();
                if (!currentLoading || indicator._quickTranslateLoading !== currentLoading) {
                    return { success: false, error: "Old request hid the current loading popover" };
                }
                pending[2][1]();
                await _waitMainloop(450);
                if (indicator._quickTranslateLoading) {
                    return { success: false, error: "Current request did not hide its loading popover" };
                }

                indicator._copySelectionForQuickTranslate = function(callback, onFailure) {
                    onFailure();
                };
                indicator._translateClipboardShortcut();
                await _waitMainloop(450);
                if (indicator._quickTranslateLoading) {
                    return { success: false, error: "Copy failure left the loading popover visible after its minimum display time" };
                }

                // A stalled request changes the existing status label after
                // the slow threshold, then cancels and exposes retry at its
                // deadline. The shortened timings exercise production's
                // exact source ownership without slowing the full suite.
                indicator._copySelectionForQuickTranslate = function(callback) {
                    callback("Timeout lifecycle input");
                };
                indicator._quickTranslateTiming = {slowRequestMs: 50, requestTimeoutMs: 100};
                indicator._translateClipboardShortcut();
                await _waitMainloop(75);
                const timeoutLoading = indicator._quickTranslateLoading;
                if (!timeoutLoading || timeoutLoading.label.text !== "Still translating…") {
                    return { success: false, error: "Slow Quick Translate request did not modify its status text" };
                }
                await _waitMainloop(75);
                if (timeoutLoading.label.text !== "Translation timed out" ||
                    !timeoutLoading.retryButton.visible) {
                    return { success: false, error: "Quick Translate timeout did not expose retry" };
                }
                timeoutLoading.retryButton.emit("clicked", 0);
                await _waitMainloop(25);
                if (indicator._quickTranslateLoading === timeoutLoading ||
                    !indicator._quickTranslateLoading || indicator._quickTranslateLoading.retryButton.visible) {
                    return { success: false, error: "Quick Translate retry did not start a fresh loading state" };
                }
                const retrySettled = pending[pending.length - 1][1];
                retrySettled();
                await _waitMainloop(450);
                if (indicator._quickTranslateLoading) {
                    return { success: false, error: "Retried Quick Translate request left loading UI visible" };
                }

                // A response that arrives before the first spinner cycle is
                // complete must not cut off the compact-to-expanded feedback.
                delete indicator._quickTranslateTiming;
                indicator._translateClipboardShortcut();
                const fastResponseLoading = indicator._quickTranslateLoading;
                const fastResponse = pending[pending.length - 1];
                fastResponse[0]("Fast result", "EN");
                fastResponse[1]();
                if (indicator._quickTranslateLoading !== fastResponseLoading) {
                    return { success: false, error: "Fast response interrupted the first spinner cycle" };
                }
                await _waitMainloop(450);
                if (indicator._quickTranslateLoading) {
                    return { success: false, error: "Fast response did not close after the first spinner cycle" };
                }
                if (indicator._floatingWindow) {
                    indicator._floatingWindow.destroy();
                    indicator._floatingWindow = null;
                }
            } finally {
                indicator._copySelectionForQuickTranslate = originalCopySelection;
                indicator._translateTextIndependent = originalIndependent;
                indicator._settings.set_boolean("floating-background-mode", originalBackground);
                delete indicator._quickTranslateTiming;
                await _pumpMainloop();
                indicator._hideQuickTranslateLoading();
                if (indicator._floatingWindow) {
                    indicator._floatingWindow.destroy();
                    indicator._floatingWindow = null;
                }
            }
        } catch (e) {
            indicator._hideQuickTranslateLoading();
            return { success: false, error: "Quick Translate loading lifecycle test failed: " + (e.message || String(e)) };
        }

        // Test 8a: virtual Ctrl+C is emitted in the exact press/release order.
        try {
            const Clutter = imports.gi.Clutter;
            const originalVirtualKeyboard = indicator._virtualKeyboard;
            const originalLayoutCheck = indicator._isNonLatinLayoutActive;
            const events = [];
            indicator._virtualKeyboard = {
                notify_keyval: (time, keyval, state) => events.push([keyval, state]),
                notify_key: (time, key, state) => events.push(['evdev', key, state]),
            };
            try {
                indicator._isNonLatinLayoutActive = () => false;
                if (!indicator._sendVirtualCopyShortcut()) {
                    return { success: false, error: "Virtual Ctrl+C helper reported failure" };
                }
                const expected = [
                    [Clutter.KEY_Control_L, Clutter.KeyState.PRESSED],
                    [Clutter.KEY_c, Clutter.KeyState.PRESSED],
                    [Clutter.KEY_c, Clutter.KeyState.RELEASED],
                    [Clutter.KEY_Control_L, Clutter.KeyState.RELEASED],
                ];
                if (JSON.stringify(events) !== JSON.stringify(expected)) {
                    return { success: false, error: "Virtual Ctrl+C event order is incorrect: " + JSON.stringify(events) };
                }

                // Non-Latin layout (e.g. ru): KEY_c has no keycode in the
                // current group, so physical evdev Ctrl (29) + C (46) are sent.
                events.length = 0;
                indicator._isNonLatinLayoutActive = () => true;
                if (!indicator._sendVirtualCopyShortcut()) {
                    return { success: false, error: "Virtual Ctrl+C helper reported failure on non-Latin layout" };
                }
                const expectedEvdev = [
                    ['evdev', 29, Clutter.KeyState.PRESSED],
                    ['evdev', 46, Clutter.KeyState.PRESSED],
                    ['evdev', 46, Clutter.KeyState.RELEASED],
                    ['evdev', 29, Clutter.KeyState.RELEASED],
                ];
                if (JSON.stringify(events) !== JSON.stringify(expectedEvdev)) {
                    return { success: false, error: "Non-Latin virtual Ctrl+C event order is incorrect: " + JSON.stringify(events) };
                }
            } finally {
                indicator._virtualKeyboard = originalVirtualKeyboard;
                indicator._isNonLatinLayoutActive = originalLayoutCheck;
            }
        } catch (e) {
            return { success: false, error: "Virtual Ctrl+C test failed: " + (e.message || String(e)) };
        }

        // Clipboard owner notifications and late reads must not reuse old text.
        {
            const StCopy = (await import("gi://St")).default;
            const clipboardPrototype = StCopy.Clipboard.prototype;
            const originalRead = clipboardPrototype.get_text;
            const reads = [];
            let result = null;
            try {
                clipboardPrototype.get_text = function(type, callback) { reads.push(callback); };
                indicator._cancelQuickCopy();
                indicator._quickCopyInjected = true;
                indicator._quickCopyPreviousText = "old selection";
                indicator._readQuickCopyResult(text => { result = text; }, true);
                reads.shift()(null, "old selection");
                if (result !== null || !indicator._quickCopyInjected)
                    throw new Error("Owner notification accepted stale clipboard");
                indicator._readQuickCopyResult(text => { result = text; }, true);
                const oldRead = reads.shift();
                indicator._cancelQuickCopy();
                indicator._quickCopyInjected = true;
                indicator._quickCopyPreviousText = "old selection";
                oldRead(null, "previous request selection");
                if (result !== null) throw new Error("Late clipboard read crossed shortcut generations");
                indicator._readQuickCopyResult(text => { result = text; }, true);
                reads.shift()(null, "current selection");
                if (result !== "current selection") throw new Error("Fresh selection was ignored");
            } finally {
                clipboardPrototype.get_text = originalRead;
                indicator._cancelQuickCopy();
            }
        }

        // New translations take precedence over responses from earlier shortcuts.
        {
            const originalIndependent = indicator._translateTextIndependent;
            const background = indicator._settings.get_boolean("floating-background-mode");
            const responses = [];
            try {
                indicator._settings.set_boolean("floating-background-mode", false);
                await _pumpMainloop();
                indicator._translateTextIndependent = function(text, callback) { responses.push(callback); };
                indicator._triggerFloatingTranslation("old request");
                indicator._triggerFloatingTranslation("current request");
                responses[1]("current translation", "EN");
                const currentWindow = indicator._floatingWindow;
                responses[0]("old translation", "EN");
                if (!currentWindow || indicator._floatingWindow !== currentWindow)
                    throw new Error("Older translation replaced current popup");
            } finally {
                indicator._translateTextIndependent = originalIndependent;
                if (indicator._floatingWindow) indicator._floatingWindow.destroy();
                indicator._settings.set_boolean("floating-background-mode", background);
                await _pumpMainloop();
            }
        }

        // Test 8b: clipboard insertion helpers preserve the distinct button
        // (replace all) and Ctrl+V (replace selection / insert at cursor) semantics.
        try {
            const St = imports.gi.St;
            const Clipboard = St.Clipboard.get_default();
            const originalGetText = Clipboard.get_text;
            let mockClipboardText = "Replacement text";

            Clipboard.get_text = function(type, callback) {
                callback(Clipboard, mockClipboardText);
            };

            try {
                const textActor = indicator.inputEntry.get_clutter_text();
                const originalAutoTranslate = indicator.autoTranslateSwitch.state;
                indicator.autoTranslateSwitch.setToggleState(false);
                try {
                    textActor.set_text("Old text");
                    indicator._replaceInputFromClipboard();
                    if (textActor.get_text() !== "Replacement text") {
                        return { success: false, error: "Paste button helper did not replace the input" };
                    }

                    textActor.set_text("Hello world");
                    textActor.set_selection(6, 11);
                    mockClipboardText = "GNOME";
                    indicator._pasteClipboardAtCursor();
                    if (textActor.get_text() !== "Hello GNOME") {
                        return { success: false, error: "Ctrl+V helper did not replace the selected text" };
                    }

                    textActor.set_cursor_position(-1);
                    mockClipboardText = "!";
                    indicator._pasteClipboardAtCursor();
                    if (textActor.get_text() !== "Hello GNOME!") {
                        return { success: false, error: "Ctrl+V helper did not insert at the cursor" };
                    }
                } finally {
                    indicator.autoTranslateSwitch.setToggleState(originalAutoTranslate);
                }
            } finally {
                Clipboard.get_text = originalGetText;
            }
        } catch (e) {
            return { success: false, error: "Clipboard insertion test failed: " + (e.message || String(e)) };
        }

        // Test 8c: opening the panel reads the clipboard only when Auto Paste
        // is enabled, and Auto Translate schedules exactly one request.
        try {
            const St = imports.gi.St;
            const GLib = imports.gi.GLib;
            const Clipboard = St.Clipboard.get_default();
            const originalGetText = Clipboard.get_text;
            const originalTrigger = indicator._triggerTranslation;
            const originalAutoPaste = indicator.autoPasteSwitch.state;
            const originalAutoTranslate = indicator.autoTranslateSwitch.state;
            let readCount = 0;
            let triggerCount = 0;

            Clipboard.get_text = function(type, callback) {
                readCount++;
                callback(Clipboard, "Panel clipboard text");
            };
            indicator._triggerTranslation = function() {
                triggerCount++;
            };

            try {
                indicator.menu.close();
                indicator.autoPasteSwitch.setToggleState(false);
                indicator.autoTranslateSwitch.setToggleState(false);
                indicator.menu.open();
                if (readCount !== 0) {
                    return { success: false, error: "Panel read the clipboard while Auto Paste was disabled" };
                }
                indicator.menu.close();

                indicator.autoPasteSwitch.setToggleState(true);
                indicator.menu.open();
                if (readCount !== 1 || indicator.inputEntry.get_clutter_text().get_text() !== "Panel clipboard text") {
                    return { success: false, error: "Auto Paste did not fill the panel input" };
                }
                indicator.menu.close();

                indicator.autoTranslateSwitch.setToggleState(true);
                indicator.menu.open();
                await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
                    resolve();
                    return GLib.SOURCE_REMOVE;
                }));
                if (triggerCount !== 1) {
                    return { success: false, error: "Panel Auto Paste/Auto Translate expected 1 request, got " + triggerCount };
                }
            } finally {
                indicator.menu.close();
                Clipboard.get_text = originalGetText;
                indicator._triggerTranslation = originalTrigger;
                indicator.autoPasteSwitch.setToggleState(originalAutoPaste);
                indicator.autoTranslateSwitch.setToggleState(originalAutoTranslate);
                if (indicator._typingDebounceId) {
                    GLib.Source.remove(indicator._typingDebounceId);
                    indicator._typingDebounceId = null;
                }
            }
        } catch (e) {
            return { success: false, error: "Panel clipboard behavior test failed: " + (e.message || String(e)) };
        }

        // Test 8d: Quick Translate keeps the visible popup, auto-copy, and
        // background-copy modes that were previously used by the old gesture.
        try {
            const St = imports.gi.St;
            const Clipboard = St.Clipboard.get_default();
            const originalSetText = Clipboard.set_text;
            const originalTranslateIndependent = indicator._translateTextIndependent;
            const originalBackground = indicator._settings.get_boolean('floating-background-mode');
            const originalToast = indicator._settings.get_boolean('floating-background-toast');
            const originalAutoCopy = indicator._settings.get_boolean('floating-auto-copy');
            let copiedText = null;

            Clipboard.set_text = function(type, text) {
                copiedText = text;
            };
            indicator._translateTextIndependent = function(fromText, callback) {
                callback("Translated result");
            };

            try {
                indicator._settings.set_boolean('floating-background-mode', false);
                indicator._settings.set_boolean('floating-auto-copy', false);
                indicator._triggerFloatingTranslation("Visible popup source");
                if (!indicator._floatingWindow) {
                    return { success: false, error: "Quick Translate did not create the visible popup" };
                }
                indicator._floatingWindow.destroy();
                indicator._floatingWindow = null;

                copiedText = null;
                indicator._settings.set_boolean('floating-auto-copy', true);
                indicator._triggerFloatingTranslation("Auto-copy source");
                if (!indicator._floatingWindow || copiedText !== "Translated result") {
                    return { success: false, error: "Visible Quick Translate auto-copy failed" };
                }
                indicator._floatingWindow.destroy();
                indicator._floatingWindow = null;

                copiedText = null;
                indicator._settings.set_boolean('floating-background-mode', true);
                indicator._settings.set_boolean('floating-background-toast', false);
                indicator._triggerFloatingTranslation("Background source");
                if (indicator._floatingWindow || copiedText !== "Translated result") {
                    return { success: false, error: "Background Quick Translate did not copy silently" };
                }
            } finally {
                Clipboard.set_text = originalSetText;
                indicator._translateTextIndependent = originalTranslateIndependent;
                indicator._settings.set_boolean('floating-background-mode', originalBackground);
                indicator._settings.set_boolean('floating-background-toast', originalToast);
                indicator._settings.set_boolean('floating-auto-copy', originalAutoCopy);
                if (indicator._floatingWindow) {
                    indicator._floatingWindow.destroy();
                    indicator._floatingWindow = null;
                }
            }
        } catch (e) {
            return { success: false, error: "Quick Translate mode test failed: " + (e.message || String(e)) };
        }

        // Test 8e: typing debounce — rapid typing collapses to a single translation;
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

        // Test 9: FloatingTranslationWindow layout, placement, and Escape key handler
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

            // Simulate allocation event to trigger fit + placement logic
            win.actor.notify('allocation');

            // Popup opens next to the pointer (selection proxy), inside the work area.
            let [ptrX, ptrY] = global.get_pointer();
            let monIdx = Math.max(0, Main.layoutManager.monitors.findIndex(m =>
                ptrX >= m.x && ptrX < m.x + m.width && ptrY >= m.y && ptrY < m.y + m.height));
            let wa = Main.layoutManager.getWorkAreaForMonitor(monIdx);
            let [, pw] = win.actor.get_preferred_width(-1);
            let [, ph] = win.actor.get_preferred_height(pw);
            if (win.actor.x < wa.x || win.actor.y < wa.y ||
                win.actor.x + pw > wa.x + wa.width || win.actor.y + ph > wa.y + wa.height) {
                win.destroy();
                return { success: false, error: "FloatingTranslationWindow left the work area: " + win.actor.x + "," + win.actor.y };
            }
            let nearX = Math.abs(win.actor.x - ptrX) <= pw + 32;
            let nearY = Math.abs(win.actor.y - ptrY) <= ph + 32;
            if (!nearX || !nearY) {
                win.destroy();
                return { success: false, error: "FloatingTranslationWindow not placed near pointer " + ptrX + "," + ptrY + " Got: " + win.actor.x + "," + win.actor.y };
            }

            // Wrapped text must fit its scroll area (no overflow).
            let destLabel = win._destLabel;
            let [, needH] = destLabel.get_preferred_height(destLabel.get_width());
            if (needH <= 300 && win._destScroll.get_height() + 0.5 < needH) {
                win.destroy();
                return { success: false, error: "Translated text taller than its scroll area: " + needH };
            }

            // A saved Quick Translate anchor near the lower-right edge must
            // flip the final popup above and left instead of clipping it.
            let edgeWin = new FloatingTranslationWindow(
                "Input text", "Output text", "EN", "FR", null, null,
                indicator._settings, null,
                {x: wa.x + wa.width - 4, y: wa.y + wa.height - 4});
            edgeWin.actor.notify('allocation');
            let [, edgeWidth] = edgeWin.actor.get_preferred_width(-1);
            let [, edgeHeight] = edgeWin.actor.get_preferred_height(edgeWidth);
            if (edgeWin.actor.x < wa.x || edgeWin.actor.y < wa.y ||
                edgeWin.actor.x + edgeWidth > wa.x + wa.width ||
                edgeWin.actor.y + edgeHeight > wa.y + wa.height ||
                edgeWin.actor.x >= wa.x + wa.width - 4 ||
                edgeWin.actor.y >= wa.y + wa.height - 4) {
                edgeWin.destroy();
                win.destroy();
                return { success: false, error: "Anchored popup did not choose a fitting expansion direction" };
            }
            edgeWin.destroy();

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
            return { success: false, error: "FloatingTranslationWindow placement/Escape test failed: " + e.message };
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
                let indepSettled10 = false;
                indicator._translateTextIndependent(
                    'Hello',
                    () => { indepCb10 = true; },
                    () => { indepSettled10 = true; });
                if (httpIssued10) return { success: false, error: 'Test 10: independent path sent HTTP over insecure URL' };
                if (indepCb10) return { success: false, error: 'Test 10: independent path invoked callback after https refusal' };
                if (!indepSettled10) return { success: false, error: 'Test 10: independent path did not settle after https refusal' };
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

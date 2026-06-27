global.testRunnerResult = null;
global.testRunnerPromise = (async () => {
    try {
        const Main = await import("resource:///org/gnome/shell/ui/main.js");
        const ext = Main.extensionManager.lookup("translate-assistant@atareao.es");
        if (!ext) {
            return { success: false, error: "Extension not found" };
        }
        const indicator = ext.stateObj ? ext.stateObj._indicator : null;
        if (!indicator) {
            return { success: false, error: "Indicator not found" };
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

            // Simulate spurious copy signal (10ms monotonic time delta)
            mockTime = 1010000;
            indicator._onSelectionChange(null, Meta.SelectionType.SELECTION_CLIPBOARD, null);

            // Verify that independent translation was NOT triggered by the spurious signal
            if (independentTranslationCallback) {
                GLib.get_monotonic_time = originalGetMonotonicTime;
                Clipboard.get_text = originalClipboardGetText;
                Clipboard.set_text = originalClipboardSetText;
                indicator._translateTextIndependent = originalTranslateTextIndependent;
                return { success: false, error: "Spurious repeat event (<50ms) triggered translation!" };
            }

            // Simulate second copy (200ms monotonic time delta from the first press)
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
            const originalAutoCopyState = indicator.floatingAutoCopySwitch.state;
            indicator.floatingAutoCopySwitch.state = true;
            try {
                let autoCopiedText = "";
                Clipboard.set_text = function(type, text) {
                    autoCopiedText = text;
                };

                // Trigger double copy flow again
                mockClipboardText = "Auto Copy Test input text";
                mockTime = 2000000;
                indicator._onSelectionChange(null, Meta.SelectionType.SELECTION_CLIPBOARD, null); // 1st
                mockTime = 2200000;
                indicator._onSelectionChange(null, Meta.SelectionType.SELECTION_CLIPBOARD, null); // 2nd

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
                indicator.floatingAutoCopySwitch.state = originalAutoCopyState;
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

        // Restore mock functions
        indicator._httpSession.send_and_read_async = originalSendReadAsync;
        indicator._httpSession.send_and_read_finish = originalSendReadFinish;

        return { success: true };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
})();

global.testRunnerPromise.then(res => {
    global.testRunnerResult = JSON.stringify(res);
}).catch(err => {
    global.testRunnerResult = JSON.stringify({ success: false, error: err.message || String(err) });
});

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

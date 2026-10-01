#!/usr/bin/env gjs
// test/prefs-validator.js: Standalone headless verification of prefs.js syntax and widget properties.
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

try {
    // 1. Read prefs.js content
    const file = Gio.File.new_for_path('prefs.js');
    const [, content] = file.load_contents(null);
    let code = new TextDecoder().decode(content);

    // 2. Rewrite imports to use a mock base class that runs standalone
    code = code.replace(
        /import\s+\{\s*ExtensionPreferences,\s*gettext\s+as\s+_\s*\}\s+from\s+["']resource:\/\/\/org\/gnome\/Shell\/Extensions\/js\/extensions\/prefs.js["'];/,
        `
        class ExtensionPreferences {
            constructor(metadata) {
                this.metadata = metadata;
            }
            initTranslations() {}
            getSettings() {
                return {
                    settings_schema: {
                        get_key: (name) => ({
                            get_range: () => ({
                                deep_unpack: () => [null, {
                                    deep_unpack: () => ['Option1', 'Option2']
                                }]
                            })
                        })
                    },
                    get_enum: () => 0,
                    set_enum: () => {},
                    get_int: () => 2000,
                    set_int: () => {},
                    get_boolean: () => false,
                    set_boolean: () => {},
                    connect: () => {},
                    bind: () => {},
                    get_strv: () => ['<Super>t']
                };
            }
        }
        const _ = (s) => s;
        `
    );

    // 3. Write mock prefs to a temp file
    const tempFile = Gio.File.new_for_path('test/mock-prefs-runner.js');
    tempFile.replace_contents(
        new TextEncoder().encode(code),
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null
    );

    // 4. Initialize Gtk and Adw in headless mode
    Gtk.init();
    Adw.init();

    // 5. Import the mock prefs class
    const mockModule = await import('file://' + tempFile.get_path());
    const FastTranslatePreferences = mockModule.default;
    const prefsInstance = new FastTranslatePreferences({
        version: 1,
        description: 'Test'
    });

    // 6. Test fillPreferencesWindow
    const mockWindow = new Adw.PreferencesWindow();
    prefsInstance.fillPreferencesWindow(mockWindow);

    // 6b. Credential hygiene: the API key row must be masked
    // (Adw.PasswordEntryRow), never a plaintext Adw.EntryRow.
    // Note: PasswordEntryRow subclasses EntryRow, so the negative check
    // must exclude subclass instances.
    const findWidget = (root, pred) => {
        if (pred(root)) return root;
        let child = root.get_first_child ? root.get_first_child() : null;
        while (child) {
            const found = findWidget(child, pred);
            if (found) return found;
            child = child.get_next_sibling ? child.get_next_sibling() : null;
        }
        return null;
    };
    const maskedKeyRow = findWidget(mockWindow,
        (w) => (w instanceof Adw.PasswordEntryRow) && w.get_title && w.get_title() === 'API Key');
    if (!maskedKeyRow) {
        throw new Error('API Key row is not a masked Adw.PasswordEntryRow');
    }
    const plainKeyRow = findWidget(mockWindow,
        (w) => (w instanceof Adw.EntryRow) && !(w instanceof Adw.PasswordEntryRow) && w.get_title && w.get_title() === 'API Key');
    if (plainKeyRow) {
        throw new Error('Plaintext Adw.EntryRow exposes the API Key');
    }
    console.log('✅ Credential masking validation successful!');

    // Cleanup temp file
    tempFile.delete(null);

    console.log('✅ Preferences layout validation successful!');
} catch (e) {
    console.error('❌ Preferences validation failed:', e);
    // Exit with failure code
    imports.system.exit(1);
}

/*
 * fast-translate@tazztone.github.io
 *
 * Copyright (c) 2022 Lorenzo Carbonell Cerezo <a.k.a. atareao>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */

import Gtk from "gi://Gtk?version=4.0";
import Adw from "gi://Adw";
import Gio from "gi://Gio";
import Gdk from "gi://Gdk?version=4.0";
import { ExtensionPreferences, gettext as _ } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

// US QWERTY base-level characters by evdev keycode, used when the keymap
// exposes no Latin group for the pressed key (e.g. only "ru" is loaded).
const EVDEV_QWERTY = {
    2: '1', 3: '2', 4: '3', 5: '4', 6: '5', 7: '6', 8: '7', 9: '8', 10: '9', 11: '0',
    16: 'q', 17: 'w', 18: 'e', 19: 'r', 20: 't', 21: 'y', 22: 'u', 23: 'i', 24: 'o', 25: 'p',
    30: 'a', 31: 's', 32: 'd', 33: 'f', 34: 'g', 35: 'h', 36: 'j', 37: 'k', 38: 'l',
    44: 'z', 45: 'x', 46: 'c', 47: 'v', 48: 'b', 49: 'n', 50: 'm',
};
const XKB_EVDEV_OFFSET = 8;

function isAsciiKeyval(keyval) {
    return keyval >= 0x21 && keyval <= 0x7e;
}

/**
 * Returns a Latin keyval for the pressed physical key. When the active layout
 * is non-Latin (Cyrillic, Greek, ...), the recorded keyval (e.g. Cyrillic_u)
 * would never fire under the Latin layout, so resolve the same physical key
 * in another layout group, falling back to its US QWERTY letter.
 */
function latinKeyvalFor(controller, keyval, keycode) {
    if (keyval <= 0xff) {
        return keyval;
    }
    try {
        const display = controller.get_widget()?.get_display() ?? Gdk.Display.get_default();
        for (let group = 0; group < 4; group++) {
            const [ok, groupKeyval] = display.translate_key(keycode, 0, group);
            if (ok && isAsciiKeyval(groupKeyval)) {
                return Gdk.keyval_to_lower(groupKeyval);
            }
        }
    } catch (e) {
        console.error(`Fast Translate: keycode lookup failed: ${e.message || e}`);
    }
    const qwerty = EVDEV_QWERTY[keycode - XKB_EVDEV_OFFSET];
    return qwerty ? Gdk.unicode_to_keyval(qwerty.charCodeAt(0)) : keyval;
}

export default class FastTranslatePreferences extends ExtensionPreferences {
    constructor(metadata) {
        super(metadata);
        this.initTranslations(this.metadata['gettext-domain']);
    }

    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // ----------------- PREFERENCES PAGE -----------------
        const preferencesPage = new Adw.PreferencesPage({
            title: _('Preferences'),
            icon_name: 'preferences-other-symbolic',
        });
        window.add(preferencesPage);

        // Group 1: General
        const langGroup = new Adw.PreferencesGroup({
            title: _('General'),
        });
        preferencesPage.add(langGroup);

        // Translation Service Combo
        const serviceKey = settings.settings_schema.get_key('translation-service');
        const serviceEnums = serviceKey.get_range().deep_unpack()[1].deep_unpack();
        const serviceRow = new Adw.ComboRow({
            title: _('Translation Service'),
            subtitle: _('Google needs no key. DeepL needs an API key.'),
            model: Gtk.StringList.new(serviceEnums),
        });
        serviceRow.selected = settings.get_enum('translation-service');
        serviceRow.connect('notify::selected', () => {
            settings.set_enum('translation-service', serviceRow.selected);
            updateServiceVisibility();
        });
        settings.connect('changed::translation-service', () => {
            serviceRow.selected = settings.get_enum('translation-service');
            updateServiceVisibility();
        });
        langGroup.add(serviceRow);

        // Source Language Combo
        const sourceKey = settings.settings_schema.get_key('source-lang');
        const sourceEnums = sourceKey.get_range().deep_unpack()[1].deep_unpack();
        const sourceLangRow = new Adw.ComboRow({
            title: _('Source Language'),
            subtitle: _('Default source language'),
            model: Gtk.StringList.new(sourceEnums),
        });
        sourceLangRow.selected = settings.get_enum('source-lang');
        sourceLangRow.connect('notify::selected', () => {
            settings.set_enum('source-lang', sourceLangRow.selected);
        });
        settings.connect('changed::source-lang', () => {
            sourceLangRow.selected = settings.get_enum('source-lang');
        });
        langGroup.add(sourceLangRow);

        // Target Language Combo
        const targetKey = settings.settings_schema.get_key('target-lang');
        const targetEnums = targetKey.get_range().deep_unpack()[1].deep_unpack();
        const targetLangRow = new Adw.ComboRow({
            title: _('Target Language'),
            subtitle: _('Default target language'),
            model: Gtk.StringList.new(targetEnums),
        });
        targetLangRow.selected = settings.get_enum('target-lang');
        targetLangRow.connect('notify::selected', () => {
            settings.set_enum('target-lang', targetLangRow.selected);
        });
        settings.connect('changed::target-lang', () => {
            targetLangRow.selected = settings.get_enum('target-lang');
        });
        langGroup.add(targetLangRow);

        // Group 2: DeepL (API key + advanced options, DeepL only)
        const apiGroup = new Adw.PreferencesGroup({
            title: _('DeepL'),
            description: _('API key and advanced options. Only used when DeepL is selected.'),
        });
        preferencesPage.add(apiGroup);

        // API Key Entry (masked: this is a credential)
        const apikeyRow = new Adw.PasswordEntryRow({
            title: _('API Key'),
            use_markup: false,
        });
        settings.bind('apikey', apikeyRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        apiGroup.add(apikeyRow);

        // Advanced expander: endpoint + niche DeepL flags most users never touch
        const advancedExpander = new Adw.ExpanderRow({
            title: _('Advanced'),
            subtitle: _('URL, formality and formatting'),
        });
        apiGroup.add(advancedExpander);

        // URL Entry
        const urlRow = new Adw.EntryRow({
            title: _('API URL'),
        });
        settings.bind('url', urlRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        advancedExpander.add_row(urlRow);

        // Formality Combo (DeepL only, lives here instead of General)
        const formalityKey = settings.settings_schema.get_key('formality');
        const formalityEnums = formalityKey.get_range().deep_unpack()[1].deep_unpack();
        const formalityRow = new Adw.ComboRow({
            title: _('Formality'),
            subtitle: _('Prefer formal or informal wording'),
            model: Gtk.StringList.new(formalityEnums),
        });
        formalityRow.selected = settings.get_enum('formality');
        formalityRow.connect('notify::selected', () => {
            settings.set_enum('formality', formalityRow.selected);
        });
        settings.connect('changed::formality', () => {
            formalityRow.selected = settings.get_enum('formality');
        });
        advancedExpander.add_row(formalityRow);

        const splitRow = new Adw.SwitchRow({
            title: _('Split Sentences'),
            subtitle: _('Split input into sentences before translating'),
        });
        settings.bind('split-sentences', splitRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        advancedExpander.add_row(splitRow);

        const preserveRow = new Adw.SwitchRow({
            title: _('Preserve Formatting'),
            subtitle: _('Keep capitalization, spacing and newlines'),
        });
        settings.bind('preserve-formatting', preserveRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        advancedExpander.add_row(preserveRow);

        // Group 3: Panel Popup
        const autoGroup = new Adw.PreferencesGroup({
            title: _('Panel Popup'),
            description: _('What happens when the top-bar popup opens.'),
        });
        preferencesPage.add(autoGroup);

        const autoPasteRow = new Adw.SwitchRow({
            title: _('Auto Paste'),
            subtitle: _('Fill input with clipboard when popup opens'),
        });
        settings.bind('auto-paste', autoPasteRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        autoGroup.add(autoPasteRow);

        const autoTranslateRow = new Adw.SwitchRow({
            title: _('Auto Translate'),
            subtitle: _('Translate while typing'),
        });
        settings.bind('auto-translate', autoTranslateRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        autoGroup.add(autoTranslateRow);

        const autoCopyRow = new Adw.SwitchRow({
            title: _('Auto Copy Result'),
            subtitle: _('Copy panel result to clipboard'),
        });
        settings.bind('auto-copy', autoCopyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        autoGroup.add(autoCopyRow);

        // Group 4: Quick Translate
        const quickTranslateGroup = new Adw.PreferencesGroup({
            title: _('Quick Translate'),
            description: _('Select text in any application, then use the shortcut to copy and translate it.'),
        });
        preferencesPage.add(quickTranslateGroup);

        const shortcutRow = new Adw.ActionRow({
            title: _('Quick Translate Shortcut'),
            subtitle: _('Click this row, then press keys to set the shortcut. Press Esc to clear it.'),
            activatable: true,
            focusable: true,
        });
        const shortcutLabel = new Gtk.Label({
            valign: Gtk.Align.CENTER,
            css_classes: ['dim-label'],
        });
        shortcutRow.add_suffix(shortcutLabel);

        const updateShortcutLabel = () => {
            const shortcut = settings.get_strv('keybinding-translate-clipboard')[0] || '';
            if (shortcut) {
                const [, keyval, mods] = Gtk.accelerator_parse(shortcut);
                shortcutLabel.label = Gtk.accelerator_get_label(keyval, mods);
            } else {
                shortcutLabel.label = _('None');
            }
        };
        updateShortcutLabel();
        settings.connect('changed::keybinding-translate-clipboard', updateShortcutLabel);

        shortcutRow.connect('activated', () => {
            shortcutRow.grab_focus();
        });

        const shortcutFocus = new Gtk.EventControllerFocus();
        shortcutRow.add_controller(shortcutFocus);
        const shortcutHintDefault = _('Click this row, then press keys to set the shortcut. Press Esc to clear it.');
        const shortcutHintCapturing = _('Press keys now, Esc to clear…');
        shortcutFocus.connect('enter', () => {
            shortcutRow.subtitle = shortcutHintCapturing;
        });
        shortcutFocus.connect('leave', () => {
            shortcutRow.subtitle = shortcutHintDefault;
        });

        const controller = new Gtk.EventControllerKey();
        shortcutRow.add_controller(controller);
        controller.connect('key-pressed', (controller, keyval, keycode, state) => {
            // Ignore pure-modifier presses; wait for the real combo.
            switch (keyval) {
                case Gdk.KEY_Control_L:
                case Gdk.KEY_Control_R:
                case Gdk.KEY_Shift_L:
                case Gdk.KEY_Shift_R:
                case Gdk.KEY_Alt_L:
                case Gdk.KEY_Alt_R:
                case Gdk.KEY_Meta_L:
                case Gdk.KEY_Meta_R:
                case Gdk.KEY_Super_L:
                case Gdk.KEY_Super_R:
                case Gdk.KEY_Hyper_L:
                case Gdk.KEY_Hyper_R:
                case Gdk.KEY_ISO_Level3_Shift:
                case Gdk.KEY_Caps_Lock:
                case Gdk.KEY_Num_Lock:
                    return true;
            }

            const mask = state & Gtk.accelerator_get_default_mod_mask();

            if (keyval === Gdk.KEY_Escape) {
                settings.set_strv('keybinding-translate-clipboard', []);
                updateShortcutLabel();
                return true;
            }

            // Bare BackSpace clears; Ctrl/Alt+BackSpace is a valid shortcut.
            if (keyval === Gdk.KEY_BackSpace && mask === 0) {
                settings.set_strv('keybinding-translate-clipboard', []);
                updateShortcutLabel();
                return true;
            }

            // Accept modified shortcuts and standalone function keys.
            if (mask === 0 && (keyval < Gdk.KEY_F1 || keyval > Gdk.KEY_F12)) {
                return false;
            }

            // Recording under a non-Latin layout (e.g. Russian) yields keyvals
            // like Cyrillic_u that never fire in the Latin layout. Store the
            // Latin keyval of the same physical key, as GNOME Settings does.
            const accelName = Gtk.accelerator_name(latinKeyvalFor(controller, keyval, keycode), mask);
            if (accelName) {
                settings.set_strv('keybinding-translate-clipboard', [accelName]);
                updateShortcutLabel();
                return true;
            }
            return false;
        });
        quickTranslateGroup.add(shortcutRow);

        const floatingAutoCopyRow = new Adw.SwitchRow({
            title: _('Auto Copy Popup Result'),
            subtitle: _('Copy popup result to clipboard'),
        });
        settings.bind('floating-auto-copy', floatingAutoCopyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        quickTranslateGroup.add(floatingAutoCopyRow);

        const backgroundModeRow = new Adw.SwitchRow({
            title: _('Run in Background'),
            subtitle: _('Translate without showing the popup. The result is always copied.'),
        });
        settings.bind('floating-background-mode', backgroundModeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        quickTranslateGroup.add(backgroundModeRow);

        const backgroundToastRow = new Adw.SwitchRow({
            title: _('Background Notification'),
            subtitle: _('Show the result in a notification when running in background'),
        });
        settings.bind('floating-background-toast', backgroundToastRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        quickTranslateGroup.add(backgroundToastRow);

        const syncBackgroundSensitive = () => {
            backgroundToastRow.sensitive = backgroundModeRow.active;
        };
        backgroundModeRow.connect('notify::active', syncBackgroundSensitive);
        syncBackgroundSensitive();

        // Group 5: System
        const systemGroup = new Adw.PreferencesGroup({
            title: _('System'),
        });
        preferencesPage.add(systemGroup);

        const notificationsRow = new Adw.SwitchRow({
            title: _('Panel Notification'),
            subtitle: _('Also show a notification when a panel translation finishes'),
        });
        settings.bind('notifications', notificationsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        systemGroup.add(notificationsRow);


        // ----------------- ABOUT PAGE -----------------
        const aboutPage = new Adw.PreferencesPage({
            title: _('About'),
            icon_name: 'help-about-symbolic',
        });
        window.add(aboutPage);

        const aboutGroup = new Adw.PreferencesGroup({
            title: _('Extension Details'),
        });
        aboutPage.add(aboutGroup);

        // Note: no Version row — EGO sets metadata.version on upload,
        // so a local version string would be stale or 'Unknown'.
        const authorRow = new Adw.ActionRow({
            title: _('Author'),
            subtitle: 'tazztone (Original by Lorenzo Carbonell / atareao)',
        });
        aboutGroup.add(authorRow);

        const descRow = new Adw.ActionRow({
            title: _('Description'),
            subtitle: this.metadata.description,
        });
        aboutGroup.add(descRow);

        // Links Group
        const linksGroup = new Adw.PreferencesGroup({
            title: _('Links and Support'),
        });
        aboutPage.add(linksGroup);

        const homepageRow = new Adw.ActionRow({
            title: _('Project Homepage'),
            subtitle: 'https://github.com/tazztone/translate-assistant',
        });
        const homepageBtn = new Gtk.Button({
            icon_name: 'web-browser-symbolic',
            valign: Gtk.Align.CENTER,
            has_frame: false,
        });
        homepageBtn.connect('clicked', () => {
            Gio.AppInfo.launch_default_for_uri('https://github.com/tazztone/translate-assistant', null);
        });
        homepageRow.add_suffix(homepageBtn);
        linksGroup.add(homepageRow);

        const coffeeRow = new Adw.ActionRow({
            title: _('Buy me a coffee'),
            subtitle: 'https://buymeacoffee.com/tazztone',
        });
        const coffeeBtn = new Gtk.Button({
            icon_name: 'heart-symbolic',
            valign: Gtk.Align.CENTER,
            has_frame: false,
        });
        coffeeBtn.connect('clicked', () => {
            Gio.AppInfo.launch_default_for_uri('https://buymeacoffee.com/tazztone', null);
        });
        coffeeRow.add_suffix(coffeeBtn);
        linksGroup.add(coffeeRow);

        // Helper function for service-specific visibility
        function updateServiceVisibility() {
            const isDeepL = (settings.get_enum('translation-service') === 0);
            apiGroup.visible = isDeepL;

            if (isDeepL) {
                autoTranslateRow.subtitle = _('Translate while typing');
            } else {
                autoTranslateRow.subtitle = _('Translate while typing. May be rate-limited.');
            }
        }
        updateServiceVisibility();
    }
}

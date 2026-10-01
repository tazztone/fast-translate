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
import GLib from "gi://GLib";
import { ExtensionPreferences, gettext as _ } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

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

        // API Key Entry
        const apikeyRow = new Adw.EntryRow({
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

        // Group 4: Double Ctrl+C
        const doubleCopyGroup = new Adw.PreferencesGroup({
            title: _('Double Ctrl+C'),
            description: _('Copy the same text twice to translate it instantly.'),
        });
        preferencesPage.add(doubleCopyGroup);

        const doubleCopyEnabledRow = new Adw.SwitchRow({
            title: _('Enable Gesture'),
            subtitle: _('Translate when the same text is copied twice quickly. Turn off if popups appear unwantedly.'),
        });
        settings.bind('double-copy-enabled', doubleCopyEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        doubleCopyGroup.add(doubleCopyEnabledRow);

        // Detection window (ms). Manual sync: SpinRow.value is double,
        // GSettings key is int, so bind() with its type mismatch can't be used.
        const delayAdjustment = new Gtk.Adjustment({
            lower: 300,
            upper: 5000,
            step_increment: 100,
            page_increment: 500,
            value: 500,
        });
        const delayRow = new Adw.SpinRow({
            title: _('Detection Window'),
            subtitle: _('Max time between the two copies in milliseconds. Larger values trigger more easily but can cause unwanted popups.'),
            adjustment: delayAdjustment,
        });
        const syncDelayFromSettings = () => {
            try {
                const v = settings.get_int('double-copy-delay');
                if (Number.isFinite(v) && Math.round(delayRow.value) !== v)
                    delayRow.value = v;
            } catch (e) {
                // Old schema without the key: leave the default visible.
            }
        };
        syncDelayFromSettings();
        let _delayUpdating = false;
        delayRow.connect('notify::value', () => {
            if (_delayUpdating) return;
            try {
                settings.set_int('double-copy-delay', Math.round(delayRow.value));
            } catch (e) {
                // Ignore writes while the new schema isn't installed yet.
            }
        });
        settings.connect('changed::double-copy-delay', () => {
            _delayUpdating = true;
            try { syncDelayFromSettings(); } finally { _delayUpdating = false; }
        });
        doubleCopyGroup.add(delayRow);

        const floatingAutoCopyRow = new Adw.SwitchRow({
            title: _('Auto Copy Popup Result'),
            subtitle: _('Copy popup result to clipboard'),
        });
        settings.bind('floating-auto-copy', floatingAutoCopyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        doubleCopyGroup.add(floatingAutoCopyRow);

        const backgroundModeRow = new Adw.SwitchRow({
            title: _('Run in Background'),
            subtitle: _('Translate without showing the popup. The result is always copied.'),
        });
        settings.bind('floating-background-mode', backgroundModeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        doubleCopyGroup.add(backgroundModeRow);

        const backgroundToastRow = new Adw.SwitchRow({
            title: _('Background Notification'),
            subtitle: _('Show the result in a notification when running in background'),
        });
        settings.bind('floating-background-toast', backgroundToastRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        doubleCopyGroup.add(backgroundToastRow);

        // Dim gesture-dependent rows while the master switch is OFF so the UI
        // never suggests options that currently do nothing.
        const syncDoubleCopySensitive = () => {
            const enabled = doubleCopyEnabledRow.active;
            delayRow.sensitive = enabled;
            floatingAutoCopyRow.sensitive = enabled;
            backgroundModeRow.sensitive = enabled;
            backgroundToastRow.sensitive = enabled && backgroundModeRow.active;
        };
        doubleCopyEnabledRow.connect('notify::active', syncDoubleCopySensitive);
        backgroundModeRow.connect('notify::active', syncDoubleCopySensitive);
        syncDoubleCopySensitive();

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

        const shortcutRow = new Adw.ActionRow({
            title: _('Clipboard Shortcut'),
            subtitle: _('Translate clipboard instantly. Click this row, then press keys to set, Esc to clear.'),
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

        // Click/Enter grabs keyboard focus so the key controller below receives events.
        // Without activatable + focusable the row can never be focused (the reported bug).
        shortcutRow.connect('activated', () => {
            shortcutRow.grab_focus();
        });

        // Hint while capturing: swap subtitle on focus enter/leave.
        const shortcutFocus = new Gtk.EventControllerFocus();
        shortcutRow.add_controller(shortcutFocus);
        const shortcutHintDefault = _('Translate clipboard instantly. Click this row, then press keys to set, Esc to clear.');
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

            // We only accept shortcuts with modifiers (e.g. Ctrl, Super, Alt) or function keys
            if (mask === 0 && (keyval < Gdk.KEY_F1 || keyval > Gdk.KEY_F12)) {
                return false;
            }

            const accelName = Gtk.accelerator_name(keyval, mask);
            if (accelName) {
                settings.set_strv('keybinding-translate-clipboard', [accelName]);
                updateShortcutLabel();
                return true;
            }
            return false;
        });
        systemGroup.add(shortcutRow);


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

        const versionRow = new Adw.ActionRow({
            title: _('Version'),
            subtitle: this.metadata.version ? this.metadata.version.toString() : 'Unknown',
        });
        aboutGroup.add(versionRow);

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

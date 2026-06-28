/*
 * fast-translate@tazztone.github.io
 *
 * Copyright (c) 2022 Lorenzo Carbonell Cerezo <a.k.a. atareao>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation documentation files (the "Software"), to
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
import GObject from "gi://GObject";
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

        // Group 1: Language Settings
        const langGroup = new Adw.PreferencesGroup({
            title: _('Language Settings'),
        });
        preferencesPage.add(langGroup);

        // Translation Service Combo
        const serviceKey = settings.settings_schema.get_key('translation-service');
        const serviceEnums = serviceKey.get_range().deep_unpack()[1].deep_unpack();
        const serviceRow = new Adw.ComboRow({
            title: _('Translation Service'),
            subtitle: _('Choose between Google Translate (unlimited) and DeepL (requires API key)'),
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
            subtitle: _('Default source language for new translations'),
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
            subtitle: _('Default target language for new translations'),
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

        // Formality Combo
        const formalityKey = settings.settings_schema.get_key('formality');
        const formalityEnums = formalityKey.get_range().deep_unpack()[1].deep_unpack();
        const formalityRow = new Adw.ComboRow({
            title: _('Formality'),
            subtitle: _('Lean towards formal or informal language structure (DeepL only)'),
            model: Gtk.StringList.new(formalityEnums),
        });
        formalityRow.selected = settings.get_enum('formality');
        formalityRow.connect('notify::selected', () => {
            settings.set_enum('formality', formalityRow.selected);
        });
        settings.connect('changed::formality', () => {
            formalityRow.selected = settings.get_enum('formality');
        });
        langGroup.add(formalityRow);

        // Group 2: API Configuration
        const apiGroup = new Adw.PreferencesGroup({
            title: _('DeepL Translation API Configuration'),
        });
        preferencesPage.add(apiGroup);

        // URL Entry
        const urlRow = new Adw.EntryRow({
            title: _('DeepL API URL'),
            subtitle: _('The endpoint URL for DeepL Translation API requests'),
        });
        settings.bind('url', urlRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        apiGroup.add(urlRow);

        // API Key Entry
        const apikeyRow = new Adw.EntryRow({
            title: _('API Key'),
            subtitle: _('Your private DeepL API authentication key'),
            use_markup: false,
        });
        settings.bind('apikey', apikeyRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        apiGroup.add(apikeyRow);

        // Group 3: Formatting Options
        const formattingGroup = new Adw.PreferencesGroup({
            title: _('Formatting Options'),
        });
        preferencesPage.add(formattingGroup);

        const splitRow = new Adw.SwitchRow({
            title: _('Split Sentences'),
            subtitle: _('Split the input text into sentences to improve translation context and quality'),
        });
        settings.bind('split-sentences', splitRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        formattingGroup.add(splitRow);

        const preserveRow = new Adw.SwitchRow({
            title: _('Preserve Formatting'),
            subtitle: _('Retain original formatting details like capitalization, spacing, and newlines'),
        });
        settings.bind('preserve-formatting', preserveRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        formattingGroup.add(preserveRow);

        // Group 4: Panel Menu Automation
        const autoGroup = new Adw.PreferencesGroup({
            title: _('Panel Menu Automation'),
        });
        preferencesPage.add(autoGroup);

        const autoPasteRow = new Adw.SwitchRow({
            title: _('Auto Paste from clipboard'),
            subtitle: _('Automatically paste clipboard contents into the input box when the panel popup opens'),
        });
        settings.bind('auto-paste', autoPasteRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        autoGroup.add(autoPasteRow);

        const autoTranslateRow = new Adw.SwitchRow({
            title: _('Auto Translate'),
            subtitle: _('Translate automatically while typing in the input box'),
        });
        settings.bind('auto-translate', autoTranslateRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        autoGroup.add(autoTranslateRow);

        const autoCopyRow = new Adw.SwitchRow({
            title: _('Auto Copy to clipboard'),
            subtitle: _('Automatically copy translation results to the clipboard when translation completes'),
        });
        settings.bind('auto-copy', autoCopyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        autoGroup.add(autoCopyRow);

        // Group 5: Double-Copy Instant Translation
        const doubleCopyGroup = new Adw.PreferencesGroup({
            title: _('Double-Copy Instant Translation'),
        });
        preferencesPage.add(doubleCopyGroup);

        const floatingAutoCopyRow = new Adw.SwitchRow({
            title: _('Auto Copy (Floating)'),
            subtitle: _('Automatically copy the translated text to the clipboard when using the floating window'),
        });
        settings.bind('floating-auto-copy', floatingAutoCopyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        doubleCopyGroup.add(floatingAutoCopyRow);

        const backgroundModeRow = new Adw.SwitchRow({
            title: _('Double-copy Background Mode'),
            subtitle: _('Translate silently in the background on double-copy (Ctrl+C Ctrl+C) without showing the floating UI'),
        });
        settings.bind('floating-background-mode', backgroundModeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        doubleCopyGroup.add(backgroundModeRow);

        const backgroundToastRow = new Adw.SwitchRow({
            title: _('Show Notification in Background Mode'),
            subtitle: _('Show a desktop notification with the translation result when running in background mode'),
        });
        settings.bind('floating-background-toast', backgroundToastRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        doubleCopyGroup.add(backgroundToastRow);

        backgroundModeRow.bind_property('active', backgroundToastRow, 'sensitive', GObject.BindingFlags.DEFAULT | GObject.BindingFlags.SYNC_CREATE);

        // Group 6: System & Shortcuts Integration
        const systemGroup = new Adw.PreferencesGroup({
            title: _('System & Shortcuts Integration'),
        });
        preferencesPage.add(systemGroup);

        const notificationsRow = new Adw.SwitchRow({
            title: _('Show Notifications'),
            subtitle: _('Show a system notification when a panel translation completes'),
        });
        settings.bind('notifications', notificationsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        systemGroup.add(notificationsRow);

        const darkthemeRow = new Adw.SwitchRow({
            title: _('Dark Theme Indicator'),
            subtitle: _('Use dark theme friendly status icons in the top panel'),
        });
        settings.bind('darktheme', darkthemeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        systemGroup.add(darkthemeRow);

        const shortcutRow = new Adw.ActionRow({
            title: _('Clipboard Translation Shortcut'),
            subtitle: _('Key combination to instantly translate clipboard contents (opens panel menu with result)'),
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

        const controller = new Gtk.EventControllerKey();
        shortcutRow.add_controller(controller);
        controller.connect('key-pressed', (controller, keyval, keycode, state) => {
            const mask = state & Gtk.accelerator_get_default_mod_mask();
            
            if (keyval === Gdk.KEY_Escape || keyval === Gdk.KEY_BackSpace) {
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
            title: _('Links & Support'),
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
            formattingGroup.visible = isDeepL;
            formalityRow.visible = isDeepL;

            if (isDeepL) {
                autoTranslateRow.subtitle = _('Translate automatically while typing in the input box');
            } else {
                autoTranslateRow.subtitle = _('Translate automatically while typing in the input box. Warning: Your IP address may get banned for API abuse.');
            }
        }
        updateServiceVisibility();
    }
}

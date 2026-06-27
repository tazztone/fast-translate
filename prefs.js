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

        // ----------------- GENERAL PAGE -----------------
        const generalPage = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-other-symbolic',
        });
        window.add(generalPage);

        // Language Group
        const langGroup = new Adw.PreferencesGroup({
            title: _('Language Settings'),
        });
        generalPage.add(langGroup);

        // Translation Service Combo
        const serviceKey = settings.settings_schema.get_key('translation-service');
        const serviceEnums = serviceKey.get_range().deep_unpack()[1].deep_unpack();
        const serviceRow = new Adw.ComboRow({
            title: _('Translation Service'),
            subtitle: _('The translation service provider to use'),
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
            subtitle: _('Language of the text to be translated'),
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
            subtitle: _('The language into which the text should be translated'),
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
            subtitle: _('Sets whether the translated text should lean towards formal or informal language'),
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

        // API Configuration Group
        const apiGroup = new Adw.PreferencesGroup({
            title: _('DeepL Translation API Configuration'),
        });
        generalPage.add(apiGroup);

        // URL Entry
        const urlRow = new Adw.EntryRow({
            title: _('DeepL API URL'),
        });
        settings.bind('url', urlRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        apiGroup.add(urlRow);

        // API Key Entry
        const apikeyRow = new Adw.EntryRow({
            title: _('API Key'),
            use_markup: false,
        });
        settings.bind('apikey', apikeyRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        apiGroup.add(apikeyRow);

        // Formatting options Group
        const formattingGroup = new Adw.PreferencesGroup({
            title: _('Formatting Options'),
        });
        generalPage.add(formattingGroup);

        const splitRow = new Adw.SwitchRow({
            title: _('Split Sentences'),
            subtitle: _('Split the input text into sentences before translating'),
        });
        settings.bind('split-sentences', splitRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        formattingGroup.add(splitRow);

        const preserveRow = new Adw.SwitchRow({
            title: _('Preserve Formatting'),
            subtitle: _('Respect original formatting details'),
        });
        settings.bind('preserve-formatting', preserveRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        formattingGroup.add(preserveRow);


        // ----------------- BEHAVIOR PAGE -----------------
        const behaviorPage = new Adw.PreferencesPage({
            title: _('Behavior'),
            icon_name: 'preferences-system-details-symbolic',
        });
        window.add(behaviorPage);

        // Auto Options Group
        const autoGroup = new Adw.PreferencesGroup({
            title: _('Automatic Actions'),
        });
        behaviorPage.add(autoGroup);

        const autoPasteRow = new Adw.SwitchRow({
            title: _('Auto Paste from clipboard'),
            subtitle: _('Paste clipboard content automatically into the input field'),
        });
        settings.bind('auto-paste', autoPasteRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        autoGroup.add(autoPasteRow);

        const autoTranslateRow = new Adw.SwitchRow({
            title: _('Auto Translate'),
            subtitle: _('Translate automatically when input is populated'),
        });
        settings.bind('auto-translate', autoTranslateRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        autoGroup.add(autoTranslateRow);

        const autoCopyRow = new Adw.SwitchRow({
            title: _('Auto Copy to clipboard'),
            subtitle: _('Copy translations automatically to the clipboard'),
        });
        settings.bind('auto-copy', autoCopyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        autoGroup.add(autoCopyRow);

        const floatingAutoCopyRow = new Adw.SwitchRow({
            title: _('Auto Copy (Floating) to clipboard'),
            subtitle: _('Copy floating translation results automatically to the clipboard'),
        });
        settings.bind('floating-auto-copy', floatingAutoCopyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        autoGroup.add(floatingAutoCopyRow);

        const backgroundModeRow = new Adw.SwitchRow({
            title: _('Double-copy Background Mode'),
            subtitle: _('Translate in background on double-copy instead of showing the floating window'),
        });
        settings.bind('floating-background-mode', backgroundModeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        autoGroup.add(backgroundModeRow);

        const backgroundToastRow = new Adw.SwitchRow({
            title: _('Show Notification in Background Mode'),
            subtitle: _('Display a notification when background translation finishes'),
        });
        settings.bind('floating-background-toast', backgroundToastRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        autoGroup.add(backgroundToastRow);

        backgroundModeRow.bind_property('active', backgroundToastRow, 'sensitive', GObject.BindingFlags.DEFAULT | GObject.BindingFlags.SYNC_CREATE);


        // ----------------- STYLE & SYSTEM PAGE -----------------
        const stylePage = new Adw.PreferencesPage({
            title: _('System & Style'),
            icon_name: 'style',
        });
        window.add(stylePage);

        // Style Settings Group
        const styleGroup = new Adw.PreferencesGroup({
            title: _('Style & Integration'),
        });
        stylePage.add(styleGroup);

        const notificationsRow = new Adw.SwitchRow({
            title: _('Show Notifications'),
            subtitle: _('Show system notifications upon translation completions'),
        });
        settings.bind('notifications', notificationsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        styleGroup.add(notificationsRow);

        const darkthemeRow = new Adw.SwitchRow({
            title: _('Dark Theme Indicator'),
            subtitle: _('Use dark theme panel icons (disable for light theme icons)'),
        });
        settings.bind('darktheme', darkthemeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        styleGroup.add(darkthemeRow);

        // Shortcut Settings Group
        const shortcutGroup = new Adw.PreferencesGroup({
            title: _('Keyboard Shortcuts'),
        });
        stylePage.add(shortcutGroup);

        const shortcutRow = new Adw.ActionRow({
            title: _('Clipboard Translation Shortcut'),
            subtitle: _('Click and press key combination to set shortcut. Escape/Backspace to clear'),
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
        shortcutGroup.add(shortcutRow);


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
            subtitle: 'Lorenzo Carbonell (atareao)',
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
                autoTranslateRow.subtitle = _('Translate automatically when input is populated');
            } else {
                autoTranslateRow.subtitle = _('Translate automatically when input is populated. Warning: Your IP address may get banned for API abuse.');
            }
        }
        updateServiceVisibility();
    }
}

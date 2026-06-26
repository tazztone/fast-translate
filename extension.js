/*
 * translate-assistant@atareao.es
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

import Gio from "gi://Gio";
import Clutter from "gi://Clutter";
import St from "gi://St";
import GObject from "gi://GObject";
import GLib from "gi://GLib";
import Pango from "gi://Pango";
import Meta from "gi://Meta";
import Shell from "gi://Shell";
import Soup from "gi://Soup?version=3.0";

import { Extension, gettext as _ } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

const Clipboard = St.Clipboard.get_default();
const CLIPBOARD_TYPE = St.ClipboardType.CLIPBOARD;

const SHELL_KEYBINDINGS_SCHEMA = "org.gnome.shell.keybindings";
const SHORTCUT_SETTING_KEY = "keybinding-translate-clipboard";
const TIMEOUT_MS = 500;

var TranslateAssistant = GObject.registerClass(
    class TranslateAssistant extends PanelMenu.Button {
        _init(extension) {
            super._init(0.5, 'TranslateAssistant', false);
            this._extension = extension;
            this._settings = extension.getSettings();

            this._destroyed = false;
            this._httpSession = new Soup.Session({ timeout: 10 });

            this._settingsChangedId = null;
            this._clipboardTimeoutId = null;
            this._selectionOwnerChangedId = null;

            /* Icon indicator */
            let box = new St.BoxLayout();
            this.icon = new St.Icon({ style_class: 'system-status-icon' });
            box.add_child(this.icon);
            this.add_child(box);

            this._source_lang = this._get_country_code(this._getValue('source-lang'));
            this._target_lang = this._get_country_code(this._getValue('target-lang'));

            /* Translation block */
            this.menu.addMenuItem(this._menuTranslationBlock());

            /* Separator */
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            /* Toggles at the bottom */
            this.autoPasteSwitch = new PopupMenu.PopupSwitchMenuItem(
                _('Auto Paste'), this._getValue("auto-paste"), {});
            this.menu.addMenuItem(this.autoPasteSwitch);
            this.autoPasteSwitch.connect('toggled', (item, state) => {
                this._settings.set_boolean('auto-paste', state);
                this._set_icon_indicator();
            });

            this.autoTranslateSwitch = new PopupMenu.PopupSwitchMenuItem(
                _('Auto Translate'), this._getValue("auto-translate"), {});
            this.menu.addMenuItem(this.autoTranslateSwitch);
            this.autoTranslateSwitch.connect('toggled', (item, state) => {
                this._settings.set_boolean('auto-translate', state);
            });

            this.autoCopySwitch = new PopupMenu.PopupSwitchMenuItem(
                _('Auto Copy'), this._getValue("auto-copy"), {});
            this.menu.addMenuItem(this.autoCopySwitch);
            this.autoCopySwitch.connect('toggled', (item, state) => {
                this._settings.set_boolean('auto-copy', state);
            });

            /* Separator */
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            /* Settings */
            this.settingsMenuItem = new PopupMenu.PopupMenuItem(_("Settings"));
            this.settingsMenuItem.connect('activate', () => {
                this._extension.openPreferences();
            });
            this.menu.addMenuItem(this.settingsMenuItem);

            /* Init */
            this._set_icon_indicator();
            this._settingsChanged();
            this._settingsChangedId = this._settings.connect('changed', () => {
                this._settingsChanged();
            });

            this._setupListener();
        }

        _setupListener() {
            const metaDisplay = global.display;
            if (metaDisplay && typeof metaDisplay.get_selection === 'function') {
                const selection = metaDisplay.get_selection();
                this._setupSelectionTracking(selection);
            } else {
                this._setupTimeout();
            }
        }

        _setupSelectionTracking(selection) {
            this.selection = selection;
            this._selectionOwnerChangedId = selection.connect('owner-changed', (selection, selectionType, selectionSource) => {
                this._onSelectionChange(selection, selectionType, selectionSource);
            });
        }

        _translateIfAutoPaste() {
            if (this.autoPasteSwitch.state === true) {
                Clipboard.get_text(CLIPBOARD_TYPE, (_, fromText) => {
                    if (fromText && fromText !== "") {
                        this.inputEntry.get_clutter_text().set_text(fromText);
                        if (this.autoTranslateSwitch.state === true) {
                            this._translateText(true, fromText, (toText) => {
                                this.outputEntry.get_clutter_text().set_text(toText);
                                if (this.autoCopySwitch.state === true) {
                                    this._copyToClipboard(toText);
                                }
                            });
                        }
                    }
                });
            }
        }

        _onSelectionChange(_a, selectionType, _b) {
            if (selectionType === Meta.SelectionType.SELECTION_CLIPBOARD) {
                this._translateIfAutoPaste();
            }
        }

        _setupTimeout(reiterate) {
            reiterate = typeof reiterate === 'boolean' ? reiterate : true;

            this._clipboardTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TIMEOUT_MS, () => {
                this._translateIfAutoPaste();

                if (reiterate === false) {
                    this._clipboardTimeoutId = null;
                }

                return reiterate;
            });
        }

        _clearClipboardTimeout() {
            if (!this._clipboardTimeoutId) {
                return;
            }

            GLib.Source.remove(this._clipboardTimeoutId);
            this._clipboardTimeoutId = null;
        }

        _disconnectSelectionListener() {
            if (!this._selectionOwnerChangedId || !this.selection) {
                return;
            }

            this.selection.disconnect(this._selectionOwnerChangedId);
            this._selectionOwnerChangedId = null;
        }

        _disconnectSettings() {
            if (!this._settingsChangedId) {
                return;
            }

            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        _loadPreferences() {
            this._source_lang = this._get_country_code(this._getValue('source-lang'));
            this._target_lang = this._get_country_code(this._getValue('target-lang'));
            this._split_sentences = this._getValue('split-sentences');
            this._preserve_formatting = this._getValue('preserve-formatting');
            this._formality = this._getValue('formality');
            this._url = this._getValue('url');
            this._apikey = this._getValue('apikey');
            this._keybinding_translate_clipboard = this._getValue(SHORTCUT_SETTING_KEY);
            this._notifications = this._getValue('notifications');
            this._darktheme = this._getValue('darktheme');

            this.autoPasteSwitch.setToggleState(this._getValue('auto-paste'));
            this.autoTranslateSwitch.setToggleState(this._getValue('auto-translate'));
            this.autoCopySwitch.setToggleState(this._getValue('auto-copy'));

            this._set_icon_indicator();
            this._unbindShortcut();
            this._bindShortcut();
        }

        _bindShortcut() {
            Main.wm.addKeybinding(
                SHORTCUT_SETTING_KEY,
                this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => {
                    Clipboard.get_text(CLIPBOARD_TYPE, (_, fromText) => {
                        if (fromText && fromText !== "") {
                            this.inputEntry.get_clutter_text().set_text(fromText);
                            this._triggerTranslation();
                        }
                    });
                }
            );
        }

        _unbindShortcut() {
            Main.wm.removeKeybinding(SHORTCUT_SETTING_KEY);
        }

        _translateText(fromOrTo, fromText, callback) {
            if (fromText && fromText !== "") {
                let split_sentences = this._split_sentences ? "1" : "0";
                let preserve_formatting = this._preserve_formatting ? "1" : "0";
                let params = {
                    auth_key: this._apikey,
                    text: fromText,
                    source_lang: fromOrTo === true ? this._source_lang : this._target_lang,
                    target_lang: fromOrTo === true ? this._target_lang : this._source_lang,
                    split_sentences: split_sentences,
                    preserve_formatting: preserve_formatting,
                    formality: this._formality,
                };
                
                const query = new URLSearchParams(params).toString();
                const bytes = new GLib.Bytes(query);
                
                let message;
                try {
                    message = Soup.Message.new('POST', this._url);
                    if (!message) {
                        throw new Error(_("Invalid URL"));
                    }
                } catch (e) {
                    Main.notify("Translate Assistant", `${_("Error")}: ${e.message}`);
                    return;
                }
                
                message.set_request_body_from_bytes('application/x-www-form-urlencoded', bytes);
                
                if (this._destroyed || !this._httpSession) {
                    return;
                }

                this._httpSession.send_and_read_async(
                    message,
                    GLib.PRIORITY_DEFAULT,
                    null,
                    (session, result) => {
                        if (this._destroyed) {
                            return;
                        }
                        try {
                            const resBytes = session.send_and_read_finish(result);
                            if (this._destroyed) {
                                return;
                            }
                            if (message.status_code === 200) {
                                let decoder = new TextDecoder("utf-8");
                                let response = decoder.decode(resBytes.get_data());
                                let json = JSON.parse(response);
                                let translations = json.translations;
                                let toText = (translations && translations.length > 0) ? translations[0].text : "";
                                if (this._notifications) {
                                    Main.notify("Translate Assistant", _("Translated"));
                                }
                                callback(toText);
                            } else if (message.status_code === 403) {
                                Main.notify("Translate Assistant", _("Set API Key of DeepL"));
                            } else {
                                Main.notify("Translate Assistant", `Error: ${message.status_code}`);
                            }
                        } catch (e) {
                            if (!this._destroyed) {
                                Main.notify("Translate Assistant", `Error: ${e}`);
                            }
                        }
                    }
                );
            }
        }

        _get_country_code(description) {
            if (!description) return null;
            const regex = /^[^(]*\(([^)]*)\)$/gm;
            let m = regex.exec(description);
            if (m && m.length > 1) {
                return m[1];
            }
            return null;
        }

        _copyToClipboard(inText) {
            if (this.autoPasteSwitch.state === true) {
                this.autoPasteSwitch.setToggleState(false);
                Clipboard.set_text(CLIPBOARD_TYPE, inText);
                this.autoPasteSwitch.setToggleState(true);
            } else {
                Clipboard.set_text(CLIPBOARD_TYPE, inText);
            }
        }

        _menuTranslationBlock() {
            let container = new St.BoxLayout({
                vertical: true,
                style_class: 'translate-container'
            });

            // 1. Language Row
            let langRow = new St.BoxLayout({
                vertical: false,
                style_class: 'translate-lang-row',
                x_align: Clutter.ActorAlign.CENTER
            });
            this.sourceLabel = new St.Label({
                text: this._source_lang || '',
                style_class: 'translate-lang-label'
            });
            let swapBtn = new St.Button({
                label: '⇄',
                style_class: 'translate-swap-button'
            });
            swapBtn.connect('clicked', () => {
                const oldTargetLang = this._target_lang;
                this._target_lang = this._source_lang;
                this._source_lang = oldTargetLang;
                this.sourceLabel.text = this._source_lang || '';
                this.targetLabel.text = this._target_lang || '';
                
                // Swap text in entry boxes
                let inText = this.inputEntry.get_clutter_text().get_text();
                let outText = this.outputEntry.get_clutter_text().get_text();
                this.inputEntry.get_clutter_text().set_text(outText);
                this.outputEntry.get_clutter_text().set_text(inText);
            });
            this.targetLabel = new St.Label({
                text: this._target_lang || '',
                style_class: 'translate-lang-label'
            });
            langRow.add_child(this.sourceLabel);
            langRow.add_child(swapBtn);
            langRow.add_child(this.targetLabel);
            container.add_child(langRow);

            // 2. Input Box
            let inputWrapper = new St.BoxLayout({
                vertical: true,
                style_class: 'translate-entry-wrapper'
            });
            this.inputEntry = new St.Entry({
                name: 'inputEntry',
                style_class: 'translate-entry',
                hint_text: _('Type or paste text...'),
                can_focus: true,
                track_hover: true
            });
            this.inputEntry.get_clutter_text().set_line_wrap(true);
            this.inputEntry.get_clutter_text().set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
            this.inputEntry.get_clutter_text().set_single_line_mode(false);
            this.inputEntry.get_clutter_text().set_activatable(true);
            
            let inputScroll = new St.ScrollView({
                style_class: 'translate-scroll'
            });
            inputScroll.add_child(this.inputEntry);
            inputWrapper.add_child(inputScroll);
            
            // Input Action Row (Paste / Clear)
            let inputActions = new St.BoxLayout({
                vertical: false,
                style_class: 'translate-actions-row'
            });
            let pasteBtn = new St.Button({
                label: _("Paste"),
                style_class: 'translate-action-btn'
            });
            pasteBtn.connect('clicked', () => {
                Clipboard.get_text(CLIPBOARD_TYPE, (_, inText) => {
                    if (inText && inText !== "") {
                        this.inputEntry.get_clutter_text().set_text(inText);
                        if (this.autoTranslateSwitch.state === true) {
                            this._triggerTranslation();
                        }
                    }
                });
            });
            let clearBtn = new St.Button({
                label: _("Clear"),
                style_class: 'translate-action-btn'
            });
            clearBtn.connect('clicked', () => {
                this.inputEntry.get_clutter_text().set_text("");
                this.outputEntry.get_clutter_text().set_text("");
            });
            inputActions.add_child(pasteBtn);
            inputActions.add_child(clearBtn);
            inputWrapper.add_child(inputActions);
            
            container.add_child(inputWrapper);

            // 3. Middle Action Row (Translate Button)
            let middleRow = new St.BoxLayout({
                vertical: false,
                style_class: 'translate-middle-row',
                x_align: Clutter.ActorAlign.CENTER
            });
            let translateBtn = new St.Button({
                label: _("Translate"),
                style_class: 'translate-submit-btn'
            });
            translateBtn.connect('clicked', () => {
                this._triggerTranslation();
            });
            middleRow.add_child(translateBtn);
            container.add_child(middleRow);

            // 4. Output Box
            let outputWrapper = new St.BoxLayout({
                vertical: true,
                style_class: 'translate-entry-wrapper'
            });
            this.outputEntry = new St.Entry({
                name: 'outputEntry',
                style_class: 'translate-entry read-only',
                hint_text: _('Translation will appear here...'),
                can_focus: true,
                track_hover: true
            });
            this.outputEntry.get_clutter_text().set_line_wrap(true);
            this.outputEntry.get_clutter_text().set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
            this.outputEntry.get_clutter_text().set_single_line_mode(false);
            this.outputEntry.get_clutter_text().set_activatable(true);
            
            let outputScroll = new St.ScrollView({
                style_class: 'translate-scroll'
            });
            outputScroll.add_child(this.outputEntry);
            outputWrapper.add_child(outputScroll);

            // Output Action Row (Copy)
            let outputActions = new St.BoxLayout({
                vertical: false,
                style_class: 'translate-actions-row'
            });
            let copyBtn = new St.Button({
                label: _("Copy"),
                style_class: 'translate-action-btn'
            });
            copyBtn.connect('clicked', () => {
                let outText = this.outputEntry.get_clutter_text().get_text();
                if (outText && outText !== "") {
                    this._copyToClipboard(outText);
                }
            });
            outputActions.add_child(copyBtn);
            outputWrapper.add_child(outputActions);

            container.add_child(outputWrapper);

            let menuItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false
            });
            menuItem.add_child(container);
            return menuItem;
        }

        _triggerTranslation() {
            let fromText = this.inputEntry.get_clutter_text().get_text();
            this._translateText(true, fromText, (toText) => {
                this.outputEntry.get_clutter_text().set_text(toText);
                if (this.autoCopySwitch.state === true) {
                    this._copyToClipboard(toText);
                }
            });
        }

        _getValue(keyName) {
            return this._settings.get_value(keyName).deep_unpack();
        }

        _set_icon_indicator() {
            let active = this.autoPasteSwitch.state;
            let themeString = (this._darktheme ? 'dark' : 'light');
            let statusString = (active ? 'active' : 'paused');
            let iconString = `translate-assistant-${statusString}-${themeString}`;
            this.icon.set_gicon(this._get_icon(iconString));
        }

        _get_icon(iconName) {
            const iconsDir = this._extension.dir.get_child("icons");
            let fileIcon = iconsDir.get_child(`${iconName}.svg`);
            if (fileIcon.query_exists(null) === false) {
                fileIcon = iconsDir.get_child(`${iconName}.png`);
            }
            if (fileIcon.query_exists(null) === false) {
                return null;
            }
            return Gio.Icon.new_for_string(fileIcon.get_path());
        }

        _settingsChanged() {
            this._loadPreferences();
            if (this.sourceLabel) {
                this.sourceLabel.text = this._source_lang || '';
            }
            if (this.targetLabel) {
                this.targetLabel.text = this._target_lang || '';
            }
        }

        destroy() {
            this._destroyed = true;
            this._disconnectSettings();
            this._unbindShortcut();
            this._clearClipboardTimeout();
            this._disconnectSelectionListener();
            if (this._httpSession) {
                this._httpSession.abort();
                this._httpSession = null;
            }
            super.destroy();
        }
    }
);

export default class TranslateAssistantExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this.initTranslations(this.metadata['gettext-domain']);
    }

    enable() {
        this._indicator = new TranslateAssistant(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
    }
}

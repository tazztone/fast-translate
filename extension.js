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
import { parseCountryCode, buildRequestQuery, formatLanguageLabel, parseLanguageName, getFlagEmoji } from "./translation-helper.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

// Clipboard access is the core, user-visible purpose of this extension
// (translate clipboard/pasted text, copy results back). Reads happen only on:
// explicit Paste button press, menu-open while "Auto Paste" is ON (default OFF),
// a user-set clipboard shortcut, or the double-Ctrl+C gesture (default OFF).
// Writes happen only on: explicit Copy button press, or while "Auto Copy"/
// "Floating Auto Copy" is ON (defaults OFF). No background harvesting,
// no persistence; text is sent only to the user-selected translation service
// as the translation request payload.
const CLIPBOARD_TYPE = St.ClipboardType.CLIPBOARD;
function getClipboard() {
    return St.Clipboard.get_default();
}

const SHELL_KEYBINDINGS_SCHEMA = "org.gnome.shell.keybindings";
const SHORTCUT_SETTING_KEY = "keybinding-translate-clipboard";
const TIMEOUT_MS = 500;
// Double-copy gesture timing. MIN filters event-loop duplicate owner-changed
// signals; the max window is user-configurable via double-copy-delay (ms).
const DOUBLE_COPY_MIN_US = 50 * 1000;
const DOUBLE_COPY_DELAY_FALLBACK_MS = 500;
const DOUBLE_COPY_DELAY_MIN_MS = 300;
const DOUBLE_COPY_DELAY_MAX_MS = 5000;
// Untrusted-input guard: clipboard text is attacker-controlled. Cap request size
// so a multi-MB copy can't freeze the UI, choke notifications, or blast the API.
const MAX_INPUT_CHARS = 5000;
const MAX_NOTIFY_CHARS = 150;

class Tooltip {
    constructor(actor, text) {
        this._actor = actor;
        this._text = text;
        this._tooltipActor = null;
        this._timeoutId = null;

        this._hoverId = this._actor.connect('notify::hover', () => {
            if (this._actor.hover) {
                this._startTimer();
            } else {
                this._cancelTimer();
                this._hide();
            }
        });

        this._destroyId = this._actor.connect('destroy', () => {
            // Actor is dying; handlers die with it. Null the IDs so destroy()
            // skips disconnecting the currently-emitting handler.
            this._hoverId = null;
            this._destroyId = null;
            this.destroy();
        });
    }

    _startTimer() {
        this._cancelTimer();
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TIMEOUT_MS, () => {
            this._show();
            this._timeoutId = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelTimer() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = null;
        }
    }

    _show() {
        this._hide();

        this._tooltipActor = new St.Label({
            text: typeof this._text === 'function' ? this._text() : this._text,
            style_class: 'translate-tooltip'
        });

        Main.uiGroup.add_child(this._tooltipActor);

        let allocationId = this._tooltipActor.connect('notify::allocation', () => {
            if (!this._tooltipActor) return;
            this._tooltipActor.disconnect(allocationId);

            let [x, y] = this._actor.get_transformed_position();
            let width = this._actor.get_width();
            let height = this._actor.get_height();

            let tooltipWidth = this._tooltipActor.get_width();
            let tooltipHeight = this._tooltipActor.get_height();

            let tx = x + (width - tooltipWidth) / 2;
            let ty = y - tooltipHeight - 6;

            if (ty < 0) {
                ty = y + height + 6;
            }
            if (tx < 5) tx = 5;

            this._tooltipActor.set_position(Math.round(tx), Math.round(ty));
        });
    }

    _hide() {
        this._cancelTimer();
        if (this._tooltipActor) {
            this._tooltipActor.destroy();
            this._tooltipActor = null;
        }
    }

    destroy() {
        this._hide();
        if (this._hoverId) {
            this._actor.disconnect(this._hoverId);
            this._hoverId = null;
        }
        if (this._destroyId) {
            this._actor.disconnect(this._destroyId);
            this._destroyId = null;
        }
    }
}

// All widget signals connected below store their handler IDs (this._*Id)
// and are explicitly disconnected in destroy() via _disconnectWidgetSignals().
// One-shot GLib.idle_add sources go through this._trackIdle() and pending ones
// are cancelled in destroy() via _clearIdleSources(). Actors destroyed with the
// menu also auto-drop handlers, but explicit disconnects leave nothing behind.
var FastTranslate = GObject.registerClass(
    class FastTranslate extends PanelMenu.Button {
        _init(extension) {
            super._init(0.5, 'FastTranslate', false);
            this._extension = extension;
            this._settings = extension.getSettings();

            this._destroyed = false;
            this._httpSession = new Soup.Session({ timeout: 10 });
            this._cancellable = null;
            this._tooltips = [];
            // Test seam: eval-test.js instantiates the floating window via
            // indicator.FloatingTranslationWindow (module scope is unreachable
            // from Shell Eval). Unused by production code paths.
            this.FloatingTranslationWindow = FloatingTranslationWindow;

            this._settingsChangedId = null;
            this._clipboardTimeoutId = null;
            this._selectionOwnerChangedId = null;
            this._isInternalCopy = false;
            this._internalCopyTimeoutId = null;
            this._shortcutBound = false;
            this._interfaceSettings = null;
            this._colorSchemeChangedId = null;
            this._gtkThemeChangedId = null;
            // Debounced typing translation (see _menuTranslationBlock).
            this._inputTextChangedId = null;
            this._typingDebounceId = null;
            // Lazily-created refs.
            this.selection = null;
            this._lastClipboardTime = null;
            this._lastClipboardText = null;
            this._floatingWindow = null;
            this.sourceSelector = null;
            this.targetSelector = null;
            // Handler IDs for every widget signal, disconnected in destroy().
            this._menuOpenStateChangedId = null;
            this._autoPasteToggledId = null;
            this._autoTranslateToggledId = null;
            this._autoCopyToggledId = null;
            this._settingsMenuActivateId = null;
            this._sourceLabelClickedId = null;
            this._swapBtnClickedId = null;
            this._targetLabelClickedId = null;
            this._inputBtnPressId = null;
            this._pasteBtnClickedId = null;
            this._clearBtnClickedId = null;
            this._translateBtnClickedId = null;
            this._copyBtnClickedId = null;
            // Pending one-shot idle sources, removed in destroy().
            this._idleSources = new Set();
            // Dynamically created language-selector buttons ([actor, handlerId]).
            this._langSelectorBtns = [];

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
                _('Auto Paste from clipboard'), this._getValue("auto-paste"), {});
            this.autoPasteSwitch.activate = function(event) { this.toggle(); };
            this.menu.addMenuItem(this.autoPasteSwitch);
            this._autoPasteToggledId = this.autoPasteSwitch.connect('toggled', (item, state) => {
                this._settings.set_boolean('auto-paste', state);
                this._set_icon_indicator();
            });

            this.autoTranslateSwitch = new PopupMenu.PopupSwitchMenuItem(
                _('Auto Translate'), this._getValue("auto-translate"), {});
            this.autoTranslateSwitch.activate = function(event) { this.toggle(); };
            this.menu.addMenuItem(this.autoTranslateSwitch);
            this._autoTranslateToggledId = this.autoTranslateSwitch.connect('toggled', (item, state) => {
                this._settings.set_boolean('auto-translate', state);
            });

            this.autoCopySwitch = new PopupMenu.PopupSwitchMenuItem(
                _('Auto Copy to clipboard'), this._getValue("auto-copy"), {});
            this.autoCopySwitch.activate = function(event) { this.toggle(); };
            this.menu.addMenuItem(this.autoCopySwitch);
            this._autoCopyToggledId = this.autoCopySwitch.connect('toggled', (item, state) => {
                this._settings.set_boolean('auto-copy', state);
            });

            /* Separator */
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            /* Settings */
            this.settingsMenuItem = new PopupMenu.PopupMenuItem(_("Settings"));
            this._settingsMenuActivateId = this.settingsMenuItem.connect('activate', () => {
                this._extension.openPreferences();
            });
            this.menu.addMenuItem(this.settingsMenuItem);

            /* System theme tracking for auto dark icons */
            try {
                this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
                this._colorSchemeChangedId = this._interfaceSettings.connect('changed::color-scheme', () => {
                    this._updateDarkTheme();
                });
                this._gtkThemeChangedId = this._interfaceSettings.connect('changed::gtk-theme', () => {
                    this._updateDarkTheme();
                });
            } catch (e) {
                this._interfaceSettings = null;
            }

            /* Init */
            this._set_icon_indicator();
            this._settingsChanged();
            this._settingsChangedId = this._settings.connect('changed', () => {
                this._settingsChanged();
            });

            this._setupListener();

            this._addTooltip(this.autoPasteSwitch, _("Automatically paste clipboard text when menu opens"));
            this._addTooltip(this.autoTranslateSwitch, _("Translate input text automatically while typing"));
            this._addTooltip(this.autoCopySwitch, _("Copy translation results to clipboard automatically"));
            this._addTooltip(this.settingsMenuItem, _("Open extension preferences"));

            this._menuOpenStateChangedId = this.menu.connect('open-state-changed', (menu, isOpen) => {
                if (this._destroyed) {
                    return;
                }
                if (this._tooltips) {
                    this._tooltips.forEach(t => t._hide());
                }
                if (!isOpen) {
                    this._toggleLanguageSelector(true, false);
                } else {
                    if (this.autoPasteSwitch.state === true) {
                        // User-gated read: only when "Auto Paste" is ON.
                        getClipboard().get_text(CLIPBOARD_TYPE, (_, clipboardText) => {
                            if (this._destroyed) {
                                return;
                            }
                            if (clipboardText) {
                                this.inputEntry.get_clutter_text().set_text(clipboardText);
                            }
                        });
                    }
                    // Give keyboard focus to the input box so the user can type immediately
                    this._trackIdle(() => {
                        if (this._destroyed) {
                            return GLib.SOURCE_REMOVE;
                        }
                        global.stage.set_key_focus(this.inputEntry.get_clutter_text());
                        return GLib.SOURCE_REMOVE;
                    });
                }
            });
        }

        _addTooltip(actor, text) {
            let t = new Tooltip(actor, text);
            this._tooltips.push(t);
            return t;
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
                // User-gated read: only when "Auto Paste" is ON.
                getClipboard().get_text(CLIPBOARD_TYPE, (_, fromText) => {
                    if (this._destroyed) {
                        return;
                    }
                    if (fromText && fromText !== "") {
                        this.inputEntry.get_clutter_text().set_text(fromText);
                        if (this.autoTranslateSwitch.state === true) {
                            this._translateText(true, fromText, (toText) => {
                                if (this._destroyed) {
                                    return;
                                }
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

        _getDoubleCopyWindowUs() {
            // Live-read so dconf/prefs changes apply without reload.
            // Falls back to 500ms when the key is missing
            // (e.g. old compiled schema still installed).
            let ms = DOUBLE_COPY_DELAY_FALLBACK_MS;
            try {
                ms = this._settings.get_int('double-copy-delay');
            } catch (e) {
                ms = DOUBLE_COPY_DELAY_FALLBACK_MS;
            }
            if (!Number.isFinite(ms)) ms = DOUBLE_COPY_DELAY_FALLBACK_MS;
            ms = Math.max(DOUBLE_COPY_DELAY_MIN_MS, Math.min(DOUBLE_COPY_DELAY_MAX_MS, ms));
            return ms * 1000;
        }

        _onSelectionChange(_a, selectionType, _b) {
            if (selectionType !== Meta.SelectionType.SELECTION_CLIPBOARD) return;
            if (this._isInternalCopy) {
                this._isInternalCopy = false;
                if (this._internalCopyTimeoutId) {
                    GLib.Source.remove(this._internalCopyTimeoutId);
                    this._internalCopyTimeoutId = null;
                }
                return;
            }

            // Don't even read the clipboard unless a consumer is armed —
            // otherwise every system-wide copy would be inspected.
            const doubleCopyEnabled = this._settings.get_boolean('double-copy-enabled');
            const autoPasteArmed = this.autoPasteSwitch && this.autoPasteSwitch.state === true;
            if (!doubleCopyEnabled && !autoPasteArmed) {
                return;
            }

            // Read for the double-Ctrl+C gesture / auto-paste pipeline.
            // Timestamp is sampled here (not before the async call) so the
            // interval measures actual event spacing under event-loop jitter.
            getClipboard().get_text(CLIPBOARD_TYPE, (_, text) => {
                if (this._destroyed) {
                    return;
                }
                if (!text || text.trim() === '') return;

                const now = GLib.get_monotonic_time();
                if (doubleCopyEnabled && this._lastClipboardTime && this._lastClipboardText !== null) {
                    let diff = now - this._lastClipboardTime;
                    // Trigger only if same content AND within the detection window.
                    // Identical content means the user pressed Ctrl+C on the same selection.
                    // Clipboard managers (e.g. GSConnect) always change the content slightly,
                    // so they won't accidentally trigger the floating window.
                    if (diff >= DOUBLE_COPY_MIN_US && diff < this._getDoubleCopyWindowUs() && text === this._lastClipboardText) {
                        this._lastClipboardText = null; // consume — triple-C won't re-trigger
                        this._triggerFloatingTranslation(text);
                        return;
                    }
                }

                if (doubleCopyEnabled) {
                    this._lastClipboardTime = now;
                    this._lastClipboardText = text;
                }
                this._translateIfAutoPaste();
            });
        }

        _setupTimeout() {
            this._clipboardTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TIMEOUT_MS, () => {
                if (this._destroyed) {
                    this._clipboardTimeoutId = null;
                    return GLib.SOURCE_REMOVE;
                }
                this._translateIfAutoPaste();
                return GLib.SOURCE_CONTINUE;
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

        // Auto dark icons: follow the system color-scheme instead of a manual
        // toggle (the top bar follows the system theme). The 'darktheme'
        // schema key is left unused for backward compatibility.
        _resolveDarkTheme() {
            if (this._interfaceSettings) {
                try {
                    const scheme = this._interfaceSettings.get_string('color-scheme');
                    if (scheme === 'prefer-dark') return true;
                    if (scheme === 'prefer-light' || scheme === 'default') return false;
                } catch (e) {
                    // Fall through to gtk-theme check.
                }
                try {
                    const gtkTheme = this._interfaceSettings.get_string('gtk-theme');
                    if (gtkTheme && gtkTheme.toLowerCase().includes('dark')) return true;
                } catch (e) {
                    // Schema key missing; assume light.
                }
            }
            return false;
        }

        _updateDarkTheme() {
            if (this._destroyed) {
                return;
            }
            this._darktheme = this._resolveDarkTheme();
            this._set_icon_indicator();
        }

        _disconnectInterfaceSettings() {
            if (this._interfaceSettings) {
                if (this._colorSchemeChangedId) {
                    this._interfaceSettings.disconnect(this._colorSchemeChangedId);
                    this._colorSchemeChangedId = null;
                }
                if (this._gtkThemeChangedId) {
                    this._interfaceSettings.disconnect(this._gtkThemeChangedId);
                    this._gtkThemeChangedId = null;
                }
                this._interfaceSettings = null;
            }
        }

        // Register a one-shot idle source so a pending callback can be cancelled
        // in destroy(). The wrapper unregisters the id on dispatch; callbacks must
        // return GLib.SOURCE_REMOVE (one-shot).
        _trackIdle(callback) {
            const id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._idleSources.delete(id);
                return callback();
            });
            this._idleSources.add(id);
            return id;
        }

        _clearIdleSources() {
            for (const id of this._idleSources) {
                GLib.Source.remove(id);
            }
            this._idleSources.clear();
        }

        _disconnectLanguageSelectorButtons() {
            for (const [btn, btnId] of this._langSelectorBtns) {
                try {
                    btn.disconnect(btnId);
                } catch (e) {
                    // Actor may already be destroyed with its parent; ignore.
                }
            }
            this._langSelectorBtns = [];
        }

        // Disconnect every widget signal connected in _init() and
        // _menuTranslationBlock(). Called from destroy() before super.destroy().
        _disconnectWidgetSignals() {
            if (this.autoPasteSwitch && this._autoPasteToggledId) {
                this.autoPasteSwitch.disconnect(this._autoPasteToggledId);
                this._autoPasteToggledId = null;
            }
            if (this.autoTranslateSwitch && this._autoTranslateToggledId) {
                this.autoTranslateSwitch.disconnect(this._autoTranslateToggledId);
                this._autoTranslateToggledId = null;
            }
            if (this.autoCopySwitch && this._autoCopyToggledId) {
                this.autoCopySwitch.disconnect(this._autoCopyToggledId);
                this._autoCopyToggledId = null;
            }
            if (this.settingsMenuItem && this._settingsMenuActivateId) {
                this.settingsMenuItem.disconnect(this._settingsMenuActivateId);
                this._settingsMenuActivateId = null;
            }
            if (this.menu && this._menuOpenStateChangedId) {
                this.menu.disconnect(this._menuOpenStateChangedId);
                this._menuOpenStateChangedId = null;
            }
            if (this.sourceLabel && this._sourceLabelClickedId) {
                this.sourceLabel.disconnect(this._sourceLabelClickedId);
                this._sourceLabelClickedId = null;
            }
            if (this.swapBtn && this._swapBtnClickedId) {
                this.swapBtn.disconnect(this._swapBtnClickedId);
                this._swapBtnClickedId = null;
            }
            if (this.targetLabel && this._targetLabelClickedId) {
                this.targetLabel.disconnect(this._targetLabelClickedId);
                this._targetLabelClickedId = null;
            }
            if (this.inputEntry && this._inputBtnPressId) {
                this.inputEntry.disconnect(this._inputBtnPressId);
                this._inputBtnPressId = null;
            }
            if (this.inputEntry && this._inputTextChangedId) {
                this.inputEntry.get_clutter_text().disconnect(this._inputTextChangedId);
                this._inputTextChangedId = null;
            }
            if (this._typingDebounceId) {
                GLib.Source.remove(this._typingDebounceId);
                this._typingDebounceId = null;
            }
            if (this.pasteBtn && this._pasteBtnClickedId) {
                this.pasteBtn.disconnect(this._pasteBtnClickedId);
                this._pasteBtnClickedId = null;
            }
            if (this.clearBtn && this._clearBtnClickedId) {
                this.clearBtn.disconnect(this._clearBtnClickedId);
                this._clearBtnClickedId = null;
            }
            if (this.translateBtn && this._translateBtnClickedId) {
                this.translateBtn.disconnect(this._translateBtnClickedId);
                this._translateBtnClickedId = null;
            }
            if (this.copyBtn && this._copyBtnClickedId) {
                this.copyBtn.disconnect(this._copyBtnClickedId);
                this._copyBtnClickedId = null;
            }
        }

        _loadPreferences() {
            this._translation_service = this._settings.get_enum('translation-service');
            this._source_lang = this._get_country_code(this._getValue('source-lang'));
            this._target_lang = this._get_country_code(this._getValue('target-lang'));
            this._split_sentences = this._getValue('split-sentences');
            this._preserve_formatting = this._getValue('preserve-formatting');
            this._formality = this._getValue('formality');
            this._url = this._getValue('url');
            this._apikey = this._getValue('apikey');
            this._notifications = this._getValue('notifications');
            this._darktheme = this._resolveDarkTheme();

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
                    // User-initiated read: explicit shortcut action.
                    getClipboard().get_text(CLIPBOARD_TYPE, (_, fromText) => {
                        if (this._destroyed) {
                            return;
                        }
                        if (fromText && fromText !== "") {
                            this.inputEntry.get_clutter_text().set_text(fromText);
                            this._triggerTranslation();
                            this.menu.open();
                        }
                    });
                }
            );
            this._shortcutBound = true;
        }

        _unbindShortcut() {
            // Guard: removeKeybinding() logs "Trying to remove non-existent
            // keybinding" if nothing is registered (e.g. first _loadPreferences
            // call in _init, before any _bindShortcut ran).
            if (!this._shortcutBound) {
                return;
            }
            Main.wm.removeKeybinding(SHORTCUT_SETTING_KEY);
            this._shortcutBound = false;
        }

        // The DeepL endpoint URL is user-editable: refuse to send the API key
        // over plaintext. Called by both translation paths before any request.
        _isDeepLUrlSecure() {
            return /^https:\/\//i.test(this._url || "");
        }

        _translateText(fromOrTo, fromText, callback) {
            if (fromText && fromText !== "") {
                if (fromText.length > MAX_INPUT_CHARS) {
                    this._showError(_("Text too long (max %d characters)").format(MAX_INPUT_CHARS));
                    return;
                }
                if (this.errorLabel) {
                    this.errorLabel.text = "";
                }

                // Cancel any in-flight request so rapid triggers don't race;
                // its callback is ignored via the stale-cancellable guard below.
                if (this._cancellable) {
                    this._cancellable.cancel();
                }
                const cancellable = new Gio.Cancellable();
                this._cancellable = cancellable;
                if (this.translateBtn) {
                    this.translateBtn.label = _("Cancel");
                }

                const targetLang = fromOrTo === true ? this._target_lang : this._source_lang;
                const sourceLang = fromOrTo === true ? this._source_lang : this._target_lang;

                let message;
                if (this._translation_service === 1) {
                    // Google Translate (Auth-Free)
                    const sl = sourceLang === 'AUTO' ? 'auto' : sourceLang.toLowerCase();
                    const tl = targetLang.toLowerCase();
                    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t`;

                    const bodyObj = { q: fromText };
                    const body = buildRequestQuery(bodyObj);
                    const bytes = new GLib.Bytes(body);

                    try {
                        message = Soup.Message.new('POST', url);
                        if (!message) {
                            throw new Error(_("Invalid URL"));
                        }
                    } catch (e) {
                        this._showError(`${_("Error")}: ${e.message}`);
                        this._cancellable = null;
                        if (this.translateBtn) {
                            this.translateBtn.label = _("Translate");
                        }
                        return;
                    }

                    message.set_request_body_from_bytes('application/x-www-form-urlencoded', bytes);
                    message.request_headers.replace('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
                } else {
                    // DeepL
                    const bodyObj = {
                        text: [fromText],
                        target_lang: targetLang,
                        split_sentences: this._split_sentences ? "1" : "0",
                        preserve_formatting: !!this._preserve_formatting,
                    };

                    if (!this._isDeepLUrlSecure()) {
                        this._showError(_("DeepL URL must use https://"));
                        this._cancellable = null;
                        if (this.translateBtn) {
                            this.translateBtn.label = _("Translate");
                        }
                        return;
                    }

                    if (sourceLang && sourceLang !== 'AUTO') {
                        bodyObj.source_lang = sourceLang;
                    }

                    if (this._formality && this._formality !== 'default') {
                        if (this._formality === 'more') {
                            bodyObj.formality = 'prefer_more';
                        } else if (this._formality === 'less') {
                            bodyObj.formality = 'prefer_less';
                        } else {
                            bodyObj.formality = this._formality;
                        }
                    }

                    const body = JSON.stringify(bodyObj);
                    const bytes = new GLib.Bytes(body);

                    try {
                        message = Soup.Message.new('POST', this._url);
                        if (!message) {
                            throw new Error(_("Invalid URL"));
                        }
                    } catch (e) {
                        this._showError(`${_("Error")}: ${e.message}`);
                        this._cancellable = null;
                        if (this.translateBtn) {
                            this.translateBtn.label = _("Translate");
                        }
                        return;
                    }

                    message.request_headers.replace('Authorization', `DeepL-Auth-Key ${this._apikey}`);
                    message.set_request_body_from_bytes('application/json', bytes);
                }
                
                if (this._destroyed || !this._httpSession) {
                    if (this._cancellable === cancellable) {
                        this._cancellable = null;
                    }
                    if (this.translateBtn) {
                        this.translateBtn.label = _("Translate");
                    }
                    return;
                }

                this._httpSession.send_and_read_async(
                    message,
                    GLib.PRIORITY_DEFAULT,
                    cancellable,
                    (session, result) => {
                        let resBytes;
                        try {
                            resBytes = session.send_and_read_finish(result);
                        } catch (e) {
                            if (this._destroyed) {
                                return;
                            }
                            // Stale request superseded by a newer one: ignore.
                            if (this._cancellable !== cancellable) {
                                return;
                            }
                            this._cancellable = null;
                            if (this.translateBtn) {
                                this.translateBtn.label = _("Translate");
                            }
                            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) || e.code === Gio.IOErrorEnum.CANCELLED) {
                                this._showError(_("Cancelled"));
                            } else {
                                this._showError(`Error: ${e.message || e}`);
                            }
                            return;
                        }

                        if (this._destroyed) {
                            return;
                        }
                        // Stale request superseded by a newer one: ignore.
                        if (this._cancellable !== cancellable) {
                            return;
                        }
                        this._cancellable = null;
                        if (this.translateBtn) {
                            this.translateBtn.label = _("Translate");
                        }
                        try {
                            if (message.status_code === 200) {
                                let decoder = new TextDecoder("utf-8");
                                let response = decoder.decode(resBytes.get_data());
                                let json = JSON.parse(response);
                                
                                let toText = "";
                                if (this._translation_service === 1) {
                                    toText = (json && json[0]) ? json[0].map(part => part[0]).join('') : "";
                                } else {
                                    let translations = json.translations;
                                    toText = (translations && translations.length > 0) ? translations[0].text : "";
                                }
                                
                                if (this._notifications) {
                                    const shortText = toText.length > MAX_NOTIFY_CHARS ? `${toText.slice(0, MAX_NOTIFY_CHARS)}…` : toText;
                                    Main.notify(_("Translated"), shortText);
                                }
                                callback(toText);
                            } else if (this._translation_service === 1 && (message.status_code === 403 || message.status_code === 429)) {
                                this._showError(_("Rate-limited or blocked by Google Translate. Please try again later."));
                            } else if (message.status_code === 403) {
                                this._showError(_("Auth failed (403): check API key and URL in settings"));
                            } else {
                                this._showError(`Error: ${message.status_code}`);
                            }
                        } catch (e) {
                            this._showError(`Error: ${e.message || e}`);
                        }
                    }
                );
            }
        }

        _triggerFloatingTranslation(fromText) {
            if (this._floatingWindow) {
                this._floatingWindow.destroy();
                this._floatingWindow = null;
            }

            let isBackground = this._settings.get_boolean('floating-background-mode');

            this._translateTextIndependent(fromText, (toText) => {
                if (toText && toText.trim() !== "") {
                    if (this._destroyed) return;

                    if (isBackground) {
                        this._copyToClipboard(toText);
                        if (this._settings.get_boolean('floating-background-toast')) {
                            const shortFrom = fromText.length > MAX_NOTIFY_CHARS ? `${fromText.slice(0, MAX_NOTIFY_CHARS)}…` : fromText;
                            const shortTo = toText.length > MAX_NOTIFY_CHARS ? `${toText.slice(0, MAX_NOTIFY_CHARS)}…` : toText;
                            Main.notify(_("Translated"), `${shortFrom} → ${shortTo}`);
                        }
                    } else {
                        this._floatingWindow = new FloatingTranslationWindow(
                            fromText,
                            toText,
                            this._source_lang,
                            this._target_lang,
                            () => {
                                this._floatingWindow = null;
                            },
                            (text) => {
                                this._copyToClipboard(text);
                            },
                            this._settings
                        );
                        if (this._settings.get_boolean('floating-auto-copy') === true) {
                            this._copyToClipboard(toText);
                        }
                    }
                }
            });
        }

        _translateTextIndependent(fromText, callback) {
            if (!fromText || fromText.trim() === "") return;
            if (fromText.length > MAX_INPUT_CHARS) {
                Main.notify("Fast Translate", _("Text too long (max %d characters)").format(MAX_INPUT_CHARS));
                return;
            }

            let message;
            if (this._translation_service === 1) {
                // Google Translate (Auth-Free)
                const sl = this._source_lang === 'AUTO' ? 'auto' : this._source_lang.toLowerCase();
                const tl = this._target_lang.toLowerCase();
                const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t`;

                const bodyObj = { q: fromText };
                const body = buildRequestQuery(bodyObj);
                const bytes = new GLib.Bytes(body);

                try {
                    message = Soup.Message.new('POST', url);
                    if (!message) throw new Error(_("Invalid URL"));
                } catch (e) {
                    Main.notify("Fast Translate", `${_("Error")}: ${e.message}`);
                    return;
                }

                message.set_request_body_from_bytes('application/x-www-form-urlencoded', bytes);
                message.request_headers.replace('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
            } else {
                // DeepL
                const bodyObj = {
                    text: [fromText],
                    target_lang: this._target_lang,
                    split_sentences: this._split_sentences ? "1" : "0",
                    preserve_formatting: !!this._preserve_formatting,
                };

                if (this._source_lang && this._source_lang !== 'AUTO') {
                    bodyObj.source_lang = this._source_lang;
                }

                if (this._formality && this._formality !== 'default') {
                    if (this._formality === 'more') {
                        bodyObj.formality = 'prefer_more';
                    } else if (this._formality === 'less') {
                        bodyObj.formality = 'prefer_less';
                    } else {
                        bodyObj.formality = this._formality;
                    }
                }

                const body = JSON.stringify(bodyObj);
                const bytes = new GLib.Bytes(body);

                // The DeepL endpoint URL is user-editable: never send the key over plaintext.
                if (!this._isDeepLUrlSecure()) {
                    Main.notify("Fast Translate", _("DeepL URL must use https://"));
                    return;
                }

                try {
                    message = Soup.Message.new('POST', this._url);
                    if (!message) throw new Error(_("Invalid URL"));
                } catch (e) {
                    Main.notify("Fast Translate", `${_("Error")}: ${e.message}`);
                    return;
                }

                message.request_headers.replace('Authorization', `DeepL-Auth-Key ${this._apikey}`);
                message.set_request_body_from_bytes('application/json', bytes);
            }
            
            if (this._destroyed || !this._httpSession) return;

            this._httpSession.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null,
                (session, result) => {
                    let resBytes;
                    try {
                        resBytes = session.send_and_read_finish(result);
                    } catch (e) {
                        if (this._destroyed) return;
                        Main.notify("Fast Translate", `Error: ${e.message || e}`);
                        return;
                    }

                    if (this._destroyed) return;
                    try {
                        if (message.status_code === 200) {
                            let decoder = new TextDecoder("utf-8");
                            let response = decoder.decode(resBytes.get_data());
                            let json = JSON.parse(response);
                            
                            let toText = "";
                            if (this._translation_service === 1) {
                                toText = (json && json[0]) ? json[0].map(part => part[0]).join('') : "";
                            } else {
                                let translations = json.translations;
                                toText = (translations && translations.length > 0) ? translations[0].text : "";
                            }
                            callback(toText);
                        } else if (this._translation_service === 1 && (message.status_code === 403 || message.status_code === 429)) {
                            Main.notify("Fast Translate", _("Rate-limited or blocked by Google Translate. Please try again later."));
                        } else if (message.status_code === 403) {
                            Main.notify("Fast Translate", _("Auth failed (403): check API key and URL in settings"));
                        } else {
                            Main.notify("Fast Translate", `Error: ${message.status_code}`);
                        }
                    } catch (e) {
                        Main.notify("Fast Translate", `Error: ${e.message || e}`);
                    }
                }
            );
        }

        _showError(messageText) {
            if (this.errorLabel) {
                this.errorLabel.text = messageText;
            } else {
                Main.notify("Fast Translate", messageText);
            }
        }

        _get_country_code(description) {
            // Never return null: callers call .toLowerCase() on the result.
            // A corrupt dconf value degrades to an API error, not a crash.
            return parseCountryCode(description) || 'AUTO';
        }

        _copyToClipboard(inText) {
            this._isInternalCopy = true;
            if (this._internalCopyTimeoutId) {
                GLib.Source.remove(this._internalCopyTimeoutId);
            }
            this._internalCopyTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                this._isInternalCopy = false;
                this._internalCopyTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            });

            // The _isInternalCopy guard above already suppresses the
            // owner-changed feedback loop; write unconditionally.
            getClipboard().set_text(CLIPBOARD_TYPE, inText);
        }

        _menuTranslationBlock() {
            let container = new St.BoxLayout({
                vertical: true,
                style_class: 'translate-container'
            });
            this.translationBlockContainer = container;

            // 1. Language Row
            let langRow = new St.BoxLayout({
                vertical: false,
                style_class: 'translate-lang-row',
                x_align: Clutter.ActorAlign.CENTER
            });
             this.sourceLabel = new St.Button({
                label: formatLanguageLabel(this._source_lang),
                style_class: 'translate-lang-label',
                reactive: true
            });
            this._sourceLabelClickedId = this.sourceLabel.connect('clicked', () => {
                const isVisible = !!this.sourceSelector;
                this._trackIdle(() => {
                    if (this._destroyed) {
                        return GLib.SOURCE_REMOVE;
                    }
                    this._toggleLanguageSelector(true, !isVisible);
                    return GLib.SOURCE_REMOVE;
                });
            });
            this.swapBtn = new St.Button({
                label: '⇄',
                style_class: 'translate-swap-button',
                reactive: true
            });
            this._swapBtnClickedId = this.swapBtn.connect('clicked', () => {
                if (this.sourceSelector || this.targetSelector) {
                    this._trackIdle(() => {
                        if (this._destroyed) {
                            return GLib.SOURCE_REMOVE;
                        }
                        this._toggleLanguageSelector(true, false);
                        return GLib.SOURCE_REMOVE;
                    });
                }
                const oldTargetLang = this._target_lang;
                this._target_lang = this._source_lang;
                this._source_lang = oldTargetLang;
                this.sourceLabel.label = formatLanguageLabel(this._source_lang);
                this.targetLabel.label = formatLanguageLabel(this._target_lang);
                
                // Swap text in entry boxes
                let inText = this.inputEntry.get_clutter_text().get_text();
                let outText = this.outputEntry.get_clutter_text().get_text();
                this.inputEntry.get_clutter_text().set_text(outText);
                this.outputEntry.get_clutter_text().set_text(inText);
            });
            this.targetLabel = new St.Button({
                label: formatLanguageLabel(this._target_lang),
                style_class: 'translate-lang-label',
                reactive: true
            });
            this._targetLabelClickedId = this.targetLabel.connect('clicked', () => {
                const isVisible = !!this.targetSelector;
                this._trackIdle(() => {
                    if (this._destroyed) {
                        return GLib.SOURCE_REMOVE;
                    }
                    this._toggleLanguageSelector(false, !isVisible);
                    return GLib.SOURCE_REMOVE;
                });
            });
            langRow.add_child(this.sourceLabel);
            langRow.add_child(this.swapBtn);
            langRow.add_child(this.targetLabel);
            container.add_child(langRow);

            // 2. Input Box
            let inputWrapper = new St.BoxLayout({
                vertical: true,
                style_class: 'translate-entry-wrapper'
            });
            this.inputWrapper = inputWrapper;
            this.inputEntry = new St.Entry({
                name: 'inputEntry',
                style_class: 'translate-entry',
                hint_text: _('Type or paste text...'),
                can_focus: true,
                track_hover: true,
                reactive: true
            });
            this.inputEntry.get_clutter_text().set_line_wrap(true);
            this.inputEntry.get_clutter_text().set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
            this.inputEntry.get_clutter_text().set_single_line_mode(false);
            this.inputEntry.get_clutter_text().set_activatable(true);
            
            let inputScroll = new St.ScrollView({
                style_class: 'translate-scroll',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC
            });
            let inputScrollBox = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_expand: true
            });
            this.inputEntry.x_expand = true;
            this.inputEntry.y_expand = true;
            this.inputEntry.x_align = Clutter.ActorAlign.FILL;
            this.inputEntry.y_align = Clutter.ActorAlign.FILL;
            // Clicking anywhere in the entry grabs keyboard focus
            this._inputBtnPressId = this.inputEntry.connect('button-press-event', () => {
                global.stage.set_key_focus(this.inputEntry.get_clutter_text());
                return Clutter.EVENT_PROPAGATE;
            });
            // Auto-translate while typing (debounced). Only acts while the
            // "Auto Translate" switch is ON; _triggerTranslation no-ops on empty.
            this._inputTextChangedId = this.inputEntry.get_clutter_text().connect('text-changed', () => {
                if (this._typingDebounceId) {
                    GLib.Source.remove(this._typingDebounceId);
                    this._typingDebounceId = null;
                }
                if (!this.autoTranslateSwitch || this.autoTranslateSwitch.state !== true) {
                    return;
                }
                this._typingDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
                    this._typingDebounceId = null;
                    if (this._destroyed) {
                        return GLib.SOURCE_REMOVE;
                    }
                    if (this.autoTranslateSwitch.state === true) {
                        this._triggerTranslation();
                    }
                    return GLib.SOURCE_REMOVE;
                });
            });
            inputScrollBox.add_child(this.inputEntry);
            inputScroll.add_child(inputScrollBox);
            inputWrapper.add_child(inputScroll);
            
            // Input Action Row (Paste / Clear)
            let inputActions = new St.BoxLayout({
                vertical: false,
                style_class: 'translate-actions-row'
            });
            this.pasteBtn = new St.Button({
                style_class: 'translate-action-btn',
                reactive: true
            });
            this.pasteBtn.set_child(new St.Icon({
                icon_name: 'edit-paste-symbolic',
                style_class: 'translate-btn-icon'
            }));
            this._pasteBtnClickedId = this.pasteBtn.connect('clicked', () => {
                // User-initiated read: explicit Paste button press.
                getClipboard().get_text(CLIPBOARD_TYPE, (_, inText) => {
                    if (this._destroyed) {
                        return;
                    }
                    if (inText && inText !== "") {
                        this.inputEntry.get_clutter_text().set_text(inText);
                        if (this.autoTranslateSwitch.state === true) {
                            this._triggerTranslation();
                        }
                    }
                });
            });
            this.clearBtn = new St.Button({
                style_class: 'translate-action-btn',
                reactive: true
            });
            this.clearBtn.set_child(new St.Icon({
                icon_name: 'edit-clear-symbolic',
                style_class: 'translate-btn-icon'
            }));
            this._clearBtnClickedId = this.clearBtn.connect('clicked', () => {
                this.inputEntry.get_clutter_text().set_text("");
                this.outputEntry.get_clutter_text().set_text("");
                if (this.errorLabel) {
                    this.errorLabel.text = "";
                }
            });
            inputActions.add_child(this.pasteBtn);
            inputActions.add_child(this.clearBtn);
            inputWrapper.add_child(inputActions);
            
            container.add_child(inputWrapper);

            // 3. Middle Action Row (Translate Button & Error Label)
            let middleRow = new St.BoxLayout({
                vertical: true,
                style_class: 'translate-middle-row',
                x_align: Clutter.ActorAlign.CENTER
            });
            this.middleRow = middleRow;
            this.translateBtn = new St.Button({
                label: _("Translate"),
                style_class: 'translate-submit-btn',
                reactive: true
            });
            this._translateBtnClickedId = this.translateBtn.connect('clicked', () => {
                if (this._cancellable) {
                    this._cancellable.cancel();
                } else {
                    this._triggerTranslation();
                }
            });
            middleRow.add_child(this.translateBtn);

            this.errorLabel = new St.Label({
                style_class: 'translate-error-label',
                text: '',
                x_align: Clutter.ActorAlign.CENTER
            });
            middleRow.add_child(this.errorLabel);

            container.add_child(middleRow);

            // 4. Output Box
            let outputWrapper = new St.BoxLayout({
                vertical: true,
                style_class: 'translate-entry-wrapper'
            });
            this.outputWrapper = outputWrapper;
            this.outputEntry = new St.Entry({
                name: 'outputEntry',
                style_class: 'translate-entry read-only',
                hint_text: _('Translation will appear here...'),
                can_focus: true,
                track_hover: true,
                reactive: true
            });
            this.outputEntry.get_clutter_text().set_line_wrap(true);
            this.outputEntry.get_clutter_text().set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
            this.outputEntry.get_clutter_text().set_single_line_mode(false);
            this.outputEntry.get_clutter_text().set_activatable(true);
            this.outputEntry.get_clutter_text().set_editable(false);
            
            let outputScroll = new St.ScrollView({
                style_class: 'translate-scroll',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC
            });
            let outputScrollBox = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_expand: true
            });
            this.outputEntry.x_expand = true;
            this.outputEntry.y_expand = true;
            this.outputEntry.x_align = Clutter.ActorAlign.FILL;
            this.outputEntry.y_align = Clutter.ActorAlign.FILL;
            outputScrollBox.add_child(this.outputEntry);
            outputScroll.add_child(outputScrollBox);
            outputWrapper.add_child(outputScroll);

            // Output Action Row (Copy)
            let outputActions = new St.BoxLayout({
                vertical: false,
                style_class: 'translate-actions-row'
            });
            this.copyBtn = new St.Button({
                style_class: 'translate-action-btn',
                reactive: true
            });
            this.copyBtn.set_child(new St.Icon({
                icon_name: 'edit-copy-symbolic',
                style_class: 'translate-btn-icon'
            }));
            this._copyBtnClickedId = this.copyBtn.connect('clicked', () => {
                let outText = this.outputEntry.get_clutter_text().get_text();
                if (outText && outText !== "") {
                    this._copyToClipboard(outText);
                }
            });
            outputActions.add_child(this.copyBtn);
            outputWrapper.add_child(outputActions);

            container.add_child(outputWrapper);

            // Bind tooltips
            this._addTooltip(this.swapBtn, _("Swap languages"));
            this._addTooltip(this.pasteBtn, _("Paste from clipboard"));
            this._addTooltip(this.clearBtn, _("Clear text"));
            this._addTooltip(this.copyBtn, _("Copy translation to clipboard"));
            this._addTooltip(this.translateBtn, () => {
                return this.translateBtn.label === _("Cancel") ? _("Cancel translation") : _("Translate text");
            });
            this._addTooltip(this.sourceLabel, () => {
                return _("Source language: ") + (this.sourceLabel.label || _("Auto"));
            });
            this._addTooltip(this.targetLabel, () => {
                return _("Target language: ") + (this.targetLabel.label || "");
            });

            let menuItem = new PopupMenu.PopupBaseMenuItem({
                reactive: true,
                can_focus: true
            });
            menuItem.activate = () => {};
            menuItem.actor.track_hover = false;
            menuItem.actor.style_class = 'translate-menu-item-container';
            menuItem.add_child(container);
            return menuItem;
        }

        _triggerTranslation() {
            let fromText = this.inputEntry.get_clutter_text().get_text();
            if (!fromText || fromText.trim() === "") {
                return;
            }
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
            let iconString = `fast-translate-${statusString}-${themeString}`;
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
                this.sourceLabel.label = formatLanguageLabel(this._source_lang);
            }
            if (this.targetLabel) {
                this.targetLabel.label = formatLanguageLabel(this._target_lang);
            }
        }

        _toggleLanguageSelector(isSource, show) {
            if (show) {
                // Hide input, middle row, and output
                this.inputWrapper.visible = false;
                this.middleRow.visible = false;
                this.outputWrapper.visible = false;
                
                // Hide other selectors
                this._disconnectLanguageSelectorButtons();
                if (this.sourceSelector) {
                    this.sourceSelector.destroy();
                    this.sourceSelector = null;
                }
                if (this.targetSelector) {
                    this.targetSelector.destroy();
                    this.targetSelector = null;
                }
                
                // Create new selector scroll view
                const keyName = isSource ? 'source-lang' : 'target-lang';
                const key = this._settings.settings_schema.get_key(keyName);
                const enums = key.get_range().deep_unpack()[1].deep_unpack();
                const selectedIndex = this._settings.get_enum(keyName);
                
                let selectorScroll = new St.ScrollView({
                    style_class: 'translate-scroll translate-selector-scroll',
                    hscrollbar_policy: St.PolicyType.NEVER,
                    vscrollbar_policy: St.PolicyType.AUTOMATIC
                });
                
                let scrollBox = new St.BoxLayout({
                    vertical: true,
                    x_expand: true,
                    style_class: 'translate-selector-box'
                });
                
                let colCount = 2;
                let row = null;
                enums.forEach((enumStr, index) => {
                    if (index % colCount === 0) {
                        row = new St.BoxLayout({
                            vertical: false,
                            x_expand: true,
                            style_class: 'translate-lang-selector-row'
                        });
                        scrollBox.add_child(row);
                    }
                    
                    const code = parseCountryCode(enumStr);
                    const flag = getFlagEmoji(code);
                    const name = parseLanguageName(enumStr);
                    const buttonText = flag ? `${flag} ${name}` : name;
                    
                    let isSelected = (index === selectedIndex);
                    let btn = new St.Button({
                        label: buttonText,
                        style_class: isSelected ? 'translate-lang-selector-btn selected' : 'translate-lang-selector-btn',
                        x_expand: true,
                        reactive: true
                    });

                    const btnId = btn.connect('clicked', () => {
                        this._settings.set_enum(keyName, index);
                        this._trackIdle(() => {
                            if (this._destroyed) {
                                return GLib.SOURCE_REMOVE;
                            }
                            this._toggleLanguageSelector(isSource, false);
                            this._triggerTranslation();
                            return GLib.SOURCE_REMOVE;
                        });
                    });
                    this._langSelectorBtns.push([btn, btnId]);

                    row.add_child(btn);
                });
                
                selectorScroll.add_child(scrollBox);
                this.translationBlockContainer.add_child(selectorScroll);
                
                if (isSource) {
                    this.sourceSelector = selectorScroll;
                } else {
                    this.targetSelector = selectorScroll;
                }
            } else {
                // Destroy selectors (buttons disconnect with their parent actor;
                // drop tracked handler IDs first for balanced enable()/disable()).
                this._disconnectLanguageSelectorButtons();
                if (this.sourceSelector) {
                    this.sourceSelector.destroy();
                    this.sourceSelector = null;
                }
                if (this.targetSelector) {
                    this.targetSelector.destroy();
                    this.targetSelector = null;
                }
                
                // Restore input, middle row, and output
                this.inputWrapper.visible = true;
                this.middleRow.visible = true;
                this.outputWrapper.visible = true;
            }
        }

        destroy() {
            this._destroyed = true;
            this._clearIdleSources();
            this._disconnectWidgetSignals();
            this._disconnectLanguageSelectorButtons();
            if (this._floatingWindow) {
                this._floatingWindow.destroy();
                this._floatingWindow = null;
            }
            if (this.sourceSelector) {
                this.sourceSelector.destroy();
                this.sourceSelector = null;
            }
            if (this.targetSelector) {
                this.targetSelector.destroy();
                this.targetSelector = null;
            }
            if (this._tooltips) {
                this._tooltips.forEach(t => t.destroy());
                this._tooltips = null;
            }
            this._disconnectSettings();
            this._disconnectInterfaceSettings();
            this._unbindShortcut();
            this._clearClipboardTimeout();
            this._disconnectSelectionListener();
            if (this._cancellable) {
                try {
                    this._cancellable.cancel();
                } catch (e) {
                    // Already cancelled/finished; ignore.
                }
                this._cancellable = null;
            }
            if (this._internalCopyTimeoutId) {
                GLib.Source.remove(this._internalCopyTimeoutId);
                this._internalCopyTimeoutId = null;
            }
            if (this._httpSession) {
                this._httpSession.abort();
                this._httpSession = null;
            }
            super.destroy();
        }
    }
);

export default class FastTranslateExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this.initTranslations(this.metadata['gettext-domain']);
    }

    enable() {
        this._indicator = new FastTranslate(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    disable() {
        // Idempotent: enable() may have failed partway, or disable() may run twice.
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}

class FloatingTranslationWindow {
    constructor(sourceText, targetText, sourceLang, targetLang, onDestroy, onCopyClicked, settings) {
        this._onDestroy = onDestroy;
        this._settings = settings;
        // Widget handler IDs, explicitly disconnected in destroy().
        this._overlayPressId = null;
        this._closeBtnClickedId = null;
        this._copyBtnClickedId = null;
        this._autoCopyBtnClickedId = null;
        this._allocationId = null;
        this._destroyedFloating = false;
        this.overlay = new St.Widget({
            style_class: 'translate-floating-overlay',
            reactive: true,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height
        });
        Main.uiGroup.add_child(this.overlay);

        this._overlayPressId = this.overlay.connect('button-press-event', () => {
            this.destroy();
            return Clutter.EVENT_STOP;
        });

        this.actor = new St.BoxLayout({
            style_class: 'translate-floating-window',
            vertical: true,
            reactive: true
        });
        Main.uiGroup.add_child(this.actor);

        // Header Row (Title + Close Button)
        let header = new St.BoxLayout({
            vertical: false,
            style_class: 'translate-floating-header'
        });
        
        let titleText = `${formatLanguageLabel(sourceLang)}  ➜  ${formatLanguageLabel(targetLang)}`;
        let title = new St.Label({
            text: titleText,
            style_class: 'translate-floating-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        header.add_child(title);

        let closeBtn = new St.Button({
            style_class: 'translate-floating-close-btn',
            reactive: true
        });
        closeBtn.set_child(new St.Icon({
            icon_name: 'window-close-symbolic',
            style_class: 'translate-btn-icon'
        }));
        this.closeBtn = closeBtn;
        this._closeBtnClickedId = closeBtn.connect('clicked', () => this.destroy());
        header.add_child(closeBtn);
        this.actor.add_child(header);

        // Divider
        let divider = new St.Widget({
            style_class: 'translate-floating-divider'
        });
        this.actor.add_child(divider);

        // Source Text (scrollable)
        let srcScroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            style_class: 'translate-floating-src-scroll'
        });
        let srcBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true
        });
        let srcLabel = new St.Label({
            text: sourceText,
            style_class: 'translate-floating-text-src'
        });
        srcLabel.get_clutter_text().set_line_wrap(true);
        srcLabel.get_clutter_text().set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        srcBox.add_child(srcLabel);
        srcScroll.add_child(srcBox);
        this.actor.add_child(srcScroll);

        // Divider 2
        let divider2 = new St.Widget({
            style_class: 'translate-floating-divider'
        });
        this.actor.add_child(divider2);

        // Translated Text (scrollable)
        let destScroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            style_class: 'translate-floating-dest-scroll'
        });
        let destBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true
        });
        let destLabel = new St.Label({
            text: targetText,
            style_class: 'translate-floating-text-dest'
        });
        destLabel.get_clutter_text().set_line_wrap(true);
        destLabel.get_clutter_text().set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        destBox.add_child(destLabel);
        destScroll.add_child(destBox);
        this.actor.add_child(destScroll);

        // Actions Row (Copy Button & Auto Copy Checkbox)
        let actions = new St.BoxLayout({
            vertical: false,
            style_class: 'translate-floating-actions'
        });
        let copyBtn = new St.Button({
            style_class: 'translate-action-btn',
            reactive: true
        });
        copyBtn.set_child(new St.Icon({
            icon_name: 'edit-copy-symbolic',
            style_class: 'translate-btn-icon'
        }));
        
        this.copyBtn = copyBtn;
        this._copyBtnClickedId = copyBtn.connect('clicked', () => {
            if (onCopyClicked) {
                onCopyClicked(targetText);
            } else {
                // Fallback write: explicit Copy button press only.
                getClipboard().set_text(CLIPBOARD_TYPE, targetText);
            }
            this.destroy();
        });
        actions.add_child(copyBtn);

        let spacer = new St.Widget({ x_expand: true });
        actions.add_child(spacer);

        if (this._settings) {
            let autoCopyBox = new St.BoxLayout({
                vertical: false,
                style_class: 'translate-floating-autocopy-box',
                y_align: Clutter.ActorAlign.CENTER
            });
            let autoCopyLabel = new St.Label({
                text: _("Auto Copy"),
                style_class: 'translate-floating-autocopy-label',
                y_align: Clutter.ActorAlign.CENTER
            });
            
            let isAutoCopy = this._settings.get_boolean('floating-auto-copy');
            let autoCopyBtn = new St.Button({
                style_class: isAutoCopy ? 'translate-floating-toggle-btn active' : 'translate-floating-toggle-btn',
                reactive: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER
            });
            
            let toggleIcon = new St.Icon({
                icon_name: isAutoCopy ? 'checkbox-checked-symbolic' : 'checkbox-symbolic',
                style_class: 'translate-btn-icon'
            });
            autoCopyBtn.set_child(toggleIcon);

            this.autoCopyBtn = autoCopyBtn;
            this._autoCopyBtnClickedId = autoCopyBtn.connect('clicked', () => {
                let current = this._settings.get_boolean('floating-auto-copy');
                let next = !current;
                this._settings.set_boolean('floating-auto-copy', next);
                
                autoCopyBtn.style_class = next ? 'translate-floating-toggle-btn active' : 'translate-floating-toggle-btn';
                toggleIcon.icon_name = next ? 'checkbox-checked-symbolic' : 'checkbox-symbolic';
            });
            
            autoCopyBox.add_child(autoCopyBtn);
            autoCopyBox.add_child(autoCopyLabel);
            actions.add_child(autoCopyBox);
        }

        this.actor.add_child(actions);

        // Center on primary monitor
        let monitor = Main.layoutManager.primaryMonitor;
        this._allocationId = this.actor.connect('notify::allocation', () => {
            this.actor.disconnect(this._allocationId);
            this._allocationId = null;
            let width = this.actor.get_width();
            let height = this.actor.get_height();
            let x = monitor.x + (monitor.width - width) / 2;
            let y = monitor.y + (monitor.height - height) / 2;
            this.actor.set_position(x, y);
        });

        // Key Press ID to close on Escape
        this.keyPressId = global.stage.connect('key-press-event', this._onKeyPress.bind(this));
    }

    _onKeyPress(actor, event) {
        let symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Escape) {
            this.destroy();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    destroy() {
        if (this._destroyedFloating) return;
        this._destroyedFloating = true;
        if (this.keyPressId) {
            global.stage.disconnect(this.keyPressId);
            this.keyPressId = null;
        }
        if (this.overlay && this._overlayPressId) {
            try { this.overlay.disconnect(this._overlayPressId); } catch (e) {}
            this._overlayPressId = null;
        }
        if (this.closeBtn && this._closeBtnClickedId) {
            try { this.closeBtn.disconnect(this._closeBtnClickedId); } catch (e) {}
            this._closeBtnClickedId = null;
        }
        if (this.copyBtn && this._copyBtnClickedId) {
            try { this.copyBtn.disconnect(this._copyBtnClickedId); } catch (e) {}
            this._copyBtnClickedId = null;
        }
        if (this.autoCopyBtn && this._autoCopyBtnClickedId) {
            try { this.autoCopyBtn.disconnect(this._autoCopyBtnClickedId); } catch (e) {}
            this._autoCopyBtnClickedId = null;
        }
        // Child widgets would die with overlay/actor below, but destroy owned
        // buttons explicitly and release refs so disable() leaves nothing behind.
        if (this.closeBtn) { this.closeBtn.destroy(); this.closeBtn = null; }
        if (this.copyBtn) { this.copyBtn.destroy(); this.copyBtn = null; }
        if (this.autoCopyBtn) { this.autoCopyBtn.destroy(); this.autoCopyBtn = null; }
        if (this.actor && this._allocationId) {
            try { this.actor.disconnect(this._allocationId); } catch (e) {}
            this._allocationId = null;
        }
        if (this.overlay) {
            this.overlay.destroy();
            this.overlay = null;
        }
        if (this.actor) {
            this.actor.destroy();
            this.actor = null;
        }
        if (this._onDestroy) {
            this._onDestroy();
            this._onDestroy = null;
        }
    }
}


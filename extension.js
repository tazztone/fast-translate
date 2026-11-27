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

import {SpeechController} from './speech.js';
import {canSpeak} from './speech-helper.js';

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
import { parseCountryCode, buildRequestQuery, formatLanguageLabel, parseLanguageName, getFlagEmoji, isNonLatinXkbLayout } from "./translation-helper.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import { getInputSourceManager } from "resource:///org/gnome/shell/ui/status/keyboard.js";

// Clipboard access is the core, user-visible purpose of this extension
// (translate clipboard/pasted text, copy results back). Reads happen only on:
// explicit Paste button press, menu-open while "Auto Paste" is ON (default OFF),
// Ctrl+V in the focused input, or the user-configurable quick-translate shortcut.
// Writes happen only on: explicit Copy button press, or while "Auto Copy"/
// "Floating Auto Copy" is ON (defaults OFF). No background harvesting,
// no persistence; text is sent only to the user-selected translation service
// as the translation request payload.
const CLIPBOARD_TYPE = St.ClipboardType.CLIPBOARD;
function getClipboard() {
    return St.Clipboard.get_default();
}

const SHORTCUT_SETTING_KEY = "keybinding-translate-clipboard";
// Linux evdev keycodes (input-event-codes.h) for the physical Ctrl+C keys.
const EVDEV_KEY_LEFTCTRL = 29;
const EVDEV_KEY_C = 46;
const TIMEOUT_MS = 500;
const QUICK_COPY_POLL_MS = 25;
const QUICK_COPY_RELEASE_TIMEOUT_MS = 1000;
const QUICK_COPY_CLIPBOARD_TIMEOUT_MS = 800;
const QUICK_TRANSLATE_EXPAND_DURATION_MS = 300;
const QUICK_TRANSLATE_MIN_DISPLAY_MS = 400;
const QUICK_TRANSLATE_SPINNER_CYCLE_MS = 400;
const QUICK_TRANSLATE_SLOW_REQUEST_MS = 3000;
const QUICK_TRANSLATE_REQUEST_TIMEOUT_MS = 15000;
const SHORTCUT_MODIFIER_MASK = Clutter.ModifierType.CONTROL_MASK |
    Clutter.ModifierType.SHIFT_MASK |
    Clutter.ModifierType.MOD1_MASK |
    Clutter.ModifierType.SUPER_MASK |
    Clutter.ModifierType.META_MASK |
    Clutter.ModifierType.HYPER_MASK;
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

    showMessage(text) {
        this._show(text);
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
            this._timeoutId = null;
            this._hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    _show(message = null) {
        this._hide();

        this._tooltipActor = new St.Label({
            text: message ?? (typeof this._text === 'function' ? this._text() : this._text),
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

            const monitor = Main.layoutManager.monitors.find(m =>
                x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height)
                ?? Main.layoutManager.primaryMonitor;
            let tx = x + width + 6;
            let ty = y + (height - tooltipHeight) / 2;
            if (tx + tooltipWidth > monitor.x + monitor.width - 5)
                tx = x - tooltipWidth - 6;
            tx = Math.max(monitor.x + 5, Math.min(tx, monitor.x + monitor.width - tooltipWidth - 5));
            ty = Math.max(monitor.y + 5, Math.min(ty, monitor.y + monitor.height - tooltipHeight - 5));

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
            this._speech = new SpeechController((_error, button) => button?._speechTooltip?.showMessage(
                _('Unable to read text. Check your connection, language support and GStreamer audio installation.')));
            this._cancellable = null;
            this._tooltips = [];
            // Test seam: eval-test.js instantiates the floating window via
            // indicator.FloatingTranslationWindow (module scope is unreachable
            // from Shell Eval). Unused by production code paths.
            this.FloatingTranslationWindow = FloatingTranslationWindow;

            this._settingsChangedId = null;
            this._shortcutBound = false;
            this._virtualKeyboard = null;
            this._quickCopyWaitId = null;
            this._quickCopyFallbackId = null;
            this._quickCopyOwnerChangedId = null;
            this._quickCopySelection = null;
            this._quickCopyInjected = false;
            this._quickCopyPreviousText = null;
            this._quickCopyGeneration = 0;
            this._floatingTranslationGeneration = 0;
            this._quickTranslateLoading = null;
            this._quickTranslateLoadingGeneration = null;
            this._quickTranslateHideId = null;
            this._quickTranslateSlowId = null;
            this._quickTranslateTimeoutId = null;
            this._quickTranslateShownAtUs = 0;
            this._quickTranslateCancellable = null;
            this._quickTranslateText = null;
            this._quickTranslatePointerAnchor = null;
            this._quickTranslateTimedOutGeneration = null;
            this._interfaceSettings = null;
            this._colorSchemeChangedId = null;
            this._gtkThemeChangedId = null;
            // Debounced typing translation (see _menuTranslationBlock).
            this._inputTextChangedId = null;
            this._typingDebounceId = null;
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
            this._inputKeyPressId = null;
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
                    this._speech.stop(this.sourceSpeechBtn);
                    this._speech.stop(this.targetSpeechBtn);
                    this._toggleLanguageSelector(true, false);
                } else {
                    if (this.autoPasteSwitch.state === true) {
                        // User-gated read: only when "Auto Paste" is ON.
                        this._replaceInputFromClipboard();
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

        _disconnectSettings() {
            if (!this._settingsChangedId) {
                return;
            }

            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        // Auto dark icons: follow the system color-scheme instead of a manual
        // toggle (the top bar follows the system theme).
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
            if (this.inputEntry && this._inputKeyPressId) {
                this.inputEntry.get_clutter_text().disconnect(this._inputKeyPressId);
                this._inputKeyPressId = null;
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
                () => this._translateClipboardShortcut()
            );
            this._shortcutBound = true;
        }

        _translateClipboardShortcut() {
            this._cancelQuickTranslateRequest();
            const requestGeneration = ++this._floatingTranslationGeneration;
            const [pointerX, pointerY] = global.get_pointer();
            this._quickTranslatePointerAnchor = {x: pointerX, y: pointerY};
            this._showQuickTranslateLoading(requestGeneration);
            this._copySelectionForQuickTranslate((selectedText) => {
                if (this._destroyed || !selectedText || selectedText.trim() === "") {
                    this._hideQuickTranslateLoading(requestGeneration);
                    return;
                }
                this._quickTranslateText = selectedText;
                this._triggerFloatingTranslation(selectedText, requestGeneration);
            }, () => this._hideQuickTranslateLoading(requestGeneration));
        }

        _showQuickTranslateLoading(requestGeneration) {
            this._hideQuickTranslateLoading(null, true);
            if (this._destroyed) return;

            this._quickTranslateLoadingGeneration = requestGeneration;
            try {
                this._quickTranslateLoading = new QuickTranslateLoadingPopover(
                    () => this._cancelQuickTranslateRequest(requestGeneration),
                    () => this._retryQuickTranslate(requestGeneration),
                    this._quickTranslatePointerAnchor
                );
                this._quickTranslateShownAtUs = GLib.get_monotonic_time();
            } catch (e) {
                this._quickTranslateLoading = null;
                this._quickTranslateLoadingGeneration = null;
                console.error(`Fast Translate: could not show loading popover: ${e.message || e}`);
            }
        }

        _clearQuickTranslateLoadingTimers() {
            if (this._quickTranslateHideId) {
                GLib.Source.remove(this._quickTranslateHideId);
                this._quickTranslateHideId = null;
            }
        }

        _hideQuickTranslateLoading(requestGeneration = null, immediate = false) {
            if (requestGeneration !== null &&
                requestGeneration !== this._quickTranslateLoadingGeneration) {
                return;
            }

            this._clearQuickTranslateLoadingTimers();
            const destroy = () => {
                if (this._quickTranslateLoading) {
                    this._quickTranslateLoading.destroy();
                    this._quickTranslateLoading = null;
                }
                this._quickTranslateLoadingGeneration = null;
                this._quickTranslateShownAtUs = 0;
            };

            const destroyAfterMinimumDisplay = () => {
                if (!this._quickTranslateLoading || !this._quickTranslateShownAtUs) {
                    destroy();
                    return;
                }
                const elapsedMs = (GLib.get_monotonic_time() - this._quickTranslateShownAtUs) / 1000;
                const remainingMs = QUICK_TRANSLATE_MIN_DISPLAY_MS - elapsedMs;
                if (remainingMs > 0) {
                    this._quickTranslateHideId = GLib.timeout_add(
                        GLib.PRIORITY_DEFAULT,
                        Math.ceil(remainingMs),
                        () => {
                            this._quickTranslateHideId = null;
                            if (requestGeneration === null || requestGeneration === this._quickTranslateLoadingGeneration)
                                destroy();
                            return GLib.SOURCE_REMOVE;
                        }
                    );
                    return;
                }
                destroy();
            };

            if (immediate) {
                destroy();
                return;
            }
            if (this._quickTranslateLoading) {
                this._quickTranslateLoading.finish(destroyAfterMinimumDisplay);
                return;
            }
            destroyAfterMinimumDisplay();
        }

        _clearQuickTranslateRequestTimeout() {
            if (this._quickTranslateSlowId) {
                GLib.Source.remove(this._quickTranslateSlowId);
                this._quickTranslateSlowId = null;
            }
            if (this._quickTranslateTimeoutId) {
                GLib.Source.remove(this._quickTranslateTimeoutId);
                this._quickTranslateTimeoutId = null;
            }
        }

        _cancelQuickTranslateRequest(requestGeneration = null) {
            if (requestGeneration !== null && requestGeneration !== this._quickTranslateLoadingGeneration)
                return;

            if (requestGeneration !== null && requestGeneration === this._floatingTranslationGeneration)
                this._floatingTranslationGeneration++;
            this._cancelQuickCopy();
            this._clearQuickTranslateRequestTimeout();
            if (this._quickTranslateCancellable) {
                this._quickTranslateCancellable.cancel();
                this._quickTranslateCancellable = null;
            }
            this._quickTranslateText = null;
            this._quickTranslateTimedOutGeneration = null;
            this._hideQuickTranslateLoading(requestGeneration, true);
        }

        _beginQuickTranslateRequestTimeout(requestGeneration) {
            this._clearQuickTranslateRequestTimeout();
            // Integration tests override these values to exercise the full
            // timeout lifecycle without waiting fifteen seconds.
            const slowRequestMs = this._quickTranslateTiming?.slowRequestMs ??
                QUICK_TRANSLATE_SLOW_REQUEST_MS;
            const requestTimeoutMs = this._quickTranslateTiming?.requestTimeoutMs ??
                QUICK_TRANSLATE_REQUEST_TIMEOUT_MS;
            this._quickTranslateSlowId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                slowRequestMs,
                () => {
                    this._quickTranslateSlowId = null;
                    if (requestGeneration === this._quickTranslateLoadingGeneration)
                        this._quickTranslateLoading?.showSlowMessage();
                    return GLib.SOURCE_REMOVE;
                }
            );
            this._quickTranslateTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                requestTimeoutMs,
                () => {
                    this._quickTranslateTimeoutId = null;
                    this._handleQuickTranslateTimeout(requestGeneration);
                    return GLib.SOURCE_REMOVE;
                }
            );
        }

        _handleQuickTranslateTimeout(requestGeneration) {
            if (this._destroyed || requestGeneration !== this._quickTranslateLoadingGeneration)
                return;
            this._quickTranslateTimedOutGeneration = requestGeneration;
            this._quickTranslateCancellable?.cancel();
            this._quickTranslateCancellable = null;
            if (requestGeneration === this._floatingTranslationGeneration)
                this._floatingTranslationGeneration++;
            this._quickTranslateLoading?.showRetry();
        }

        _retryQuickTranslate(requestGeneration) {
            if (requestGeneration !== this._quickTranslateLoadingGeneration || !this._quickTranslateText)
                return;
            const text = this._quickTranslateText;
            this._quickTranslateTimedOutGeneration = null;
            this._hideQuickTranslateLoading(requestGeneration, true);
            const retryGeneration = ++this._floatingTranslationGeneration;
            this._showQuickTranslateLoading(retryGeneration);
            this._triggerFloatingTranslation(text, retryGeneration);
        }

        _copySelectionForQuickTranslate(callback, onFailure = null) {
            this._cancelQuickCopy();
            const generation = this._quickCopyGeneration;

            // Snapshot the current clipboard so a failed Ctrl+C never
            // translates stale content from an earlier copy operation.
            getClipboard().get_text(CLIPBOARD_TYPE, (_clipboard, previousText) => {
                if (this._destroyed || generation !== this._quickCopyGeneration) {
                    return;
                }

                try {
                    this._quickCopyPreviousText = previousText || null;
                    this._quickCopySelection = global.display.get_selection();
                    this._quickCopyOwnerChangedId = this._quickCopySelection.connect(
                        'owner-changed', (_selection, selectionType, selectionSource) => {
                            if (!this._quickCopyInjected || !selectionSource ||
                                selectionType !== Meta.SelectionType.SELECTION_CLIPBOARD) {
                                return;
                            }
                            this._readQuickCopyResult(callback, true, onFailure);
                        }
                    );
                } catch (e) {
                    console.error(`Fast Translate: could not monitor clipboard selection: ${e.message || e}`);
                    this._cancelQuickCopy();
                    Main.notify("Fast Translate", _("Could not copy the selected text"));
                    onFailure?.();
                    return;
                }

                const startedUs = GLib.get_monotonic_time();
                this._quickCopyWaitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, QUICK_COPY_POLL_MS, () => {
                    if (this._destroyed) {
                        this._quickCopyWaitId = null;
                        return GLib.SOURCE_REMOVE;
                    }

                    const [, , modifiers] = global.get_pointer();
                    const elapsedMs = (GLib.get_monotonic_time() - startedUs) / 1000;
                    if ((modifiers & SHORTCUT_MODIFIER_MASK) !== 0) {
                        if (elapsedMs < QUICK_COPY_RELEASE_TIMEOUT_MS) {
                            return GLib.SOURCE_CONTINUE;
                        }
                        this._quickCopyWaitId = null;
                        this._cancelQuickCopy();
                        Main.notify("Fast Translate", _("Release the shortcut keys and try again"));
                        onFailure?.();
                        return GLib.SOURCE_REMOVE;
                    }

                    this._quickCopyWaitId = null;
                    this._quickCopyInjected = true;
                    if (!this._sendVirtualCopyShortcut()) {
                        this._cancelQuickCopy();
                        Main.notify("Fast Translate", _("Could not copy the selected text"));
                        onFailure?.();
                        return GLib.SOURCE_REMOVE;
                    }
                    if (!this._quickCopyInjected) {
                        return GLib.SOURCE_REMOVE;
                    }

                    this._quickCopyFallbackId = GLib.timeout_add(
                        GLib.PRIORITY_DEFAULT,
                        QUICK_COPY_CLIPBOARD_TIMEOUT_MS,
                        () => {
                            this._quickCopyFallbackId = null;
                            this._readQuickCopyResult(callback, false, onFailure);
                            return GLib.SOURCE_REMOVE;
                        }
                    );
                    return GLib.SOURCE_REMOVE;
                });
            });
        }

        _sendVirtualCopyShortcut() {
            try {
                if (!this._virtualKeyboard) {
                    const seat = Clutter.get_default_backend().get_default_seat();
                    this._virtualKeyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
                }

                const pressed = Clutter.KeyState.PRESSED;
                const released = Clutter.KeyState.RELEASED;
                const timeUs = GLib.get_monotonic_time();
                const kb = this._virtualKeyboard;

                // Mutter resolves a synthetic keyval only in the current layout
                // group, so KEY_c is untypeable under e.g. a Russian layout
                // ("No keycode found for keyval 63 in current group"). There,
                // press the physical Ctrl+C keys instead, like a user would;
                // apps map Ctrl+<Cyrillic es> back to Copy via their Latin group.
                if (this._isNonLatinLayoutActive()) {
                    kb.notify_key(timeUs, EVDEV_KEY_LEFTCTRL, pressed);
                    kb.notify_key(timeUs + 1000, EVDEV_KEY_C, pressed);
                    kb.notify_key(timeUs + 2000, EVDEV_KEY_C, released);
                    kb.notify_key(timeUs + 3000, EVDEV_KEY_LEFTCTRL, released);
                    return true;
                }

                // Keyval path keeps Ctrl+C correct on non-QWERTY Latin layouts
                // (Dvorak, Colemak) where the physical C key is another letter.
                kb.notify_keyval(timeUs, Clutter.KEY_Control_L, pressed);
                kb.notify_keyval(timeUs + 1000, Clutter.KEY_c, pressed);
                kb.notify_keyval(timeUs + 2000, Clutter.KEY_c, released);
                kb.notify_keyval(timeUs + 3000, Clutter.KEY_Control_L, released);
                return true;
            } catch (e) {
                console.error(`Fast Translate: virtual Ctrl+C failed: ${e.message || e}`);
                this._virtualKeyboard = null;
                return false;
            }
        }

        _isNonLatinLayoutActive() {
            try {
                const source = getInputSourceManager()?.currentSource;
                return !!source && isNonLatinXkbLayout(source.xkbId);
            } catch (e) {
                console.error(`Fast Translate: could not read input source: ${e.message || e}`);
                return false;
            }
        }

        _readQuickCopyResult(callback, ownerChanged, onFailure = null) {
            const generation = this._quickCopyGeneration;
            getClipboard().get_text(CLIPBOARD_TYPE, (_clipboard, selectedText) => {
                if (this._destroyed || generation !== this._quickCopyGeneration || !this._quickCopyInjected) {
                    return;
                }

                const hasText = !!selectedText && selectedText.trim() !== "";
                const changed = selectedText !== this._quickCopyPreviousText;
                // Clipboard managers may announce a new owner before Ctrl+C has
                // supplied fresh text. An owner event alone is not proof.
                if (!hasText || !changed) {
                    if (!ownerChanged) {
                        this._cancelQuickCopy();
                        Main.notify("Fast Translate", _("Select text and try again"));
                        onFailure?.();
                    }
                    return;
                }

                this._cancelQuickCopy();
                callback(selectedText);
            });
        }

        _cancelQuickCopy() {
            this._quickCopyGeneration++;
            if (this._quickCopyWaitId) {
                GLib.Source.remove(this._quickCopyWaitId);
                this._quickCopyWaitId = null;
            }
            if (this._quickCopyFallbackId) {
                GLib.Source.remove(this._quickCopyFallbackId);
                this._quickCopyFallbackId = null;
            }
            if (this._quickCopyOwnerChangedId && this._quickCopySelection) {
                this._quickCopySelection.disconnect(this._quickCopyOwnerChangedId);
            }
            this._quickCopyOwnerChangedId = null;
            this._quickCopySelection = null;
            this._quickCopyInjected = false;
            this._quickCopyPreviousText = null;
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
                    this.errorLabel.visible = false;
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
                                callback(toText, this._translation_service === 1 ? json[2]
                                    : json.translations?.[0]?.detected_source_language);
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

        _triggerFloatingTranslation(fromText, requestGeneration = null) {
            if (requestGeneration === null) {
                requestGeneration = ++this._floatingTranslationGeneration;
            } else if (requestGeneration !== this._floatingTranslationGeneration) {
                return;
            }

            if (this._floatingWindow) {
                this._floatingWindow.destroy();
                this._floatingWindow = null;
            }

            let isBackground = this._settings.get_boolean('floating-background-mode');
            const isQuickTranslate = requestGeneration === this._quickTranslateLoadingGeneration;
            let cancellable = null;
            if (isQuickTranslate) {
                this._quickTranslateCancellable?.cancel();
                this._quickTranslateCancellable = new Gio.Cancellable();
                cancellable = this._quickTranslateCancellable;
                this._beginQuickTranslateRequestTimeout(requestGeneration);
            }

            const sourceLang = this._source_lang;
            const targetLang = this._target_lang;
            this._translateTextIndependent(
                fromText,
                (toText, detectedLanguage) => {
                    if (this._destroyed || requestGeneration !== this._floatingTranslationGeneration) return;
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
                            // Keep the initial Quick Translate anchor even if
                            // the pointer moved during the request. The result
                            // still runs its own fit-to-work-area placement.
                            const placementAnchor = isQuickTranslate
                                ? this._quickTranslatePointerAnchor
                                : null;
                            this._floatingWindow = new FloatingTranslationWindow(
                                fromText,
                                toText,
                                detectedLanguage || sourceLang,
                                targetLang,
                                () => {
                                    this._floatingWindow = null;
                                },
                                (text) => {
                                    this._copyToClipboard(text);
                                },
                                this._settings,
                                this._speech,
                                placementAnchor
                            );
                            if (this._settings.get_boolean('floating-auto-copy') === true) {
                                this._copyToClipboard(toText);
                            }
                        }
                    }
                },
                () => {
                    if (!isQuickTranslate || requestGeneration !== this._quickTranslateLoadingGeneration)
                        return;
                    this._clearQuickTranslateRequestTimeout();
                    if (this._quickTranslateCancellable === cancellable)
                        this._quickTranslateCancellable = null;
                    if (this._quickTranslateTimedOutGeneration === requestGeneration)
                        return;
                    this._quickTranslateText = null;
                    this._hideQuickTranslateLoading(requestGeneration);
                },
                cancellable
            );
        }

        _translateTextIndependent(fromText, callback, onSettled = null, cancellable = null) {
            let settled = false;
            const settle = () => {
                if (settled) return;
                settled = true;
                try {
                    onSettled?.();
                } catch (e) {
                    console.error(`Fast Translate: completion callback failed: ${e.message || e}`);
                }
            };

            if (!fromText || fromText.trim() === "") {
                settle();
                return;
            }
            if (fromText.length > MAX_INPUT_CHARS) {
                Main.notify("Fast Translate", _("Text too long (max %d characters)").format(MAX_INPUT_CHARS));
                settle();
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
                    settle();
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
                    settle();
                    return;
                }

                try {
                    message = Soup.Message.new('POST', this._url);
                    if (!message) throw new Error(_("Invalid URL"));
                } catch (e) {
                    Main.notify("Fast Translate", `${_("Error")}: ${e.message}`);
                    settle();
                    return;
                }

                message.request_headers.replace('Authorization', `DeepL-Auth-Key ${this._apikey}`);
                message.set_request_body_from_bytes('application/json', bytes);
            }
            
            if (this._destroyed || !this._httpSession) {
                settle();
                return;
            }

            try {
                this._httpSession.send_and_read_async(
                    message,
                    GLib.PRIORITY_DEFAULT,
                    cancellable,
                    (session, result) => {
                        let resBytes;
                        try {
                            resBytes = session.send_and_read_finish(result);
                        } catch (e) {
                            if (!this._destroyed && !cancellable?.is_cancelled()) {
                                Main.notify("Fast Translate", `Error: ${e.message || e}`);
                            }
                            settle();
                            return;
                        }

                        if (this._destroyed) {
                            settle();
                            return;
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
                                callback(toText, this._translation_service === 1 ? json[2]
                                        : json.translations?.[0]?.detected_source_language);
                            } else if (this._translation_service === 1 && (message.status_code === 403 || message.status_code === 429)) {
                                Main.notify("Fast Translate", _("Rate-limited or blocked by Google Translate. Please try again later."));
                            } else if (message.status_code === 403) {
                                Main.notify("Fast Translate", _("Auth failed (403): check API key and URL in settings"));
                            } else {
                                Main.notify("Fast Translate", `Error: ${message.status_code}`);
                            }
                        } catch (e) {
                            Main.notify("Fast Translate", `Error: ${e.message || e}`);
                        } finally {
                            settle();
                        }
                    }
                );
            } catch (e) {
                if (!this._destroyed && !cancellable?.is_cancelled()) {
                    Main.notify("Fast Translate", `Error: ${e.message || e}`);
                }
                settle();
            }
        }

        _showError(messageText) {
            if (this.errorLabel) {
                this.errorLabel.text = messageText;
                this.errorLabel.visible = true;
            } else {
                Main.notify("Fast Translate", messageText);
            }
        }

        _get_country_code(description) {
            // Never return null: callers call .toLowerCase() on the result.
            // A corrupt dconf value degrades to an API error, not a crash.
            return parseCountryCode(description) || 'AUTO';
        }

        _queueAutoTranslation() {
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
        }

        _replaceInputFromClipboard() {
            getClipboard().get_text(CLIPBOARD_TYPE, (_, text) => {
                if (this._destroyed || !text) {
                    return;
                }
                this.inputEntry.get_clutter_text().set_text(text);
                // set_text() may not emit when the clipboard matches the current
                // value, so explicitly re-arm the single debounced translation.
                this._queueAutoTranslation();
            });
        }

        _pasteClipboardAtCursor() {
            getClipboard().get_text(CLIPBOARD_TYPE, (_, text) => {
                if (this._destroyed || !text) {
                    return;
                }
                const clutterText = this.inputEntry.get_clutter_text();
                clutterText.delete_selection();
                const position = clutterText.get_cursor_position();
                clutterText.insert_text(text, position);
            });
        }

        _copyToClipboard(inText) {
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
                this._speech.stop(this.sourceSpeechBtn);
                this._speech.stop(this.targetSpeechBtn);
                this._outputLanguage = this._detectedSource?.language || this._source_lang;
                this._detectedSource = null;
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
            this._inputKeyPressId = this.inputEntry.get_clutter_text().connect('key-press-event', (_actor, event) => {
                const symbol = event.get_key_symbol();
                const state = event.get_state();
                const isCtrlV = (state & Clutter.ModifierType.CONTROL_MASK) !== 0 &&
                    (symbol === Clutter.KEY_v || symbol === Clutter.KEY_V);
                if (!isCtrlV) {
                    return Clutter.EVENT_PROPAGATE;
                }

                this._pasteClipboardAtCursor();
                return Clutter.EVENT_STOP;
            });
            // Auto-translate while typing (debounced). Only acts while the
            // "Auto Translate" switch is ON; _triggerTranslation no-ops on empty.
            this._inputTextChangedId = this.inputEntry.get_clutter_text().connect('text-changed', () => {
                this._queueAutoTranslation();
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
                this._replaceInputFromClipboard();
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
                    this.errorLabel.visible = false;
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
                visible: false,
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

            this.sourceSpeechBtn = addSpeechButton(inputWrapper, this.inputEntry.get_clutter_text(),
                this._speech, () => this._detectedSource?.setting === this._source_lang && this._detectedSource?.text === this.inputEntry.get_text()
                    ? this._detectedSource.language : this._source_lang, () => { this._detectedSource = null; });
            this.targetSpeechBtn = addSpeechButton(outputWrapper, this.outputEntry.get_clutter_text(),
                this._speech, () => this._outputLanguage ?? this._target_lang);
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
            const sourceSetting = this._source_lang;
            const outputLanguage = this._target_lang;
            this._translateText(true, fromText, (toText, detectedLanguage) => {
                this._detectedSource = {text: fromText, setting: sourceSetting, language: detectedLanguage || sourceSetting};
                this._outputLanguage = outputLanguage;
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
            this._clearQuickTranslateRequestTimeout();
            this._hideQuickTranslateLoading(null, true);
            this._speech?.destroy();
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
            this._cancelQuickCopy();
            this._virtualKeyboard = null;
            if (this._cancellable) {
                try {
                    this._cancellable.cancel();
                } catch (e) {
                    // Already cancelled/finished; ignore.
                }
                this._cancellable = null;
            }
            if (this._httpSession) {
                this._httpSession.abort();
                this._httpSession = null;
            }
            super.destroy();
        }
    }
);

// Each binding owns its signals and tooltip; controller owns network/playback.
function addSpeechButton(container, textActor, controller, getLanguage, onTextChanged = null) {
    const row = new St.BoxLayout({x_align: Clutter.ActorAlign.END, reactive: true, track_hover: true});
    const button = new St.Button({style_class: 'translate-action-btn',
        track_hover: true, can_focus: true});
    const icon = new St.Icon({icon_name: 'audio-speakers-symbolic', icon_size: 16});
    button.set_child(icon);
    row.add_child(button);
    container.insert_child_at_index(row, 0);
    let status = 'idle';
    const description = () => !canSpeak(textActor.get_text())
        ? _('Speech is available for text up to 500 characters')
        : status === 'idle' ? _('Read aloud') : _('Stop reading');
    const state = value => {
        status = value;
        icon.icon_name = value === 'idle' ? 'audio-speakers-symbolic'
            : value === 'loading' ? 'content-loading-symbolic' : 'media-playback-stop-symbolic';
        button.accessible_name = description();
    };
    const update = () => {
        controller.stop(button);
        const enabled = canSpeak(textActor.get_text());
        button.reactive = enabled;
        button.can_focus = enabled;
        button.opacity = enabled ? 255 : 100;
        button.accessible_name = description();
    };
    const changed = textActor.connect('text-changed', () => {
        onTextChanged?.();
        update();
    });
    const clicked = button.connect('clicked', () =>
        controller.toggle(button, textActor.get_text(), getLanguage(), state));
    const tooltip = new Tooltip(row, description);
    button._speechTooltip = tooltip;
    button.connect('destroy', () => {
        controller.stop(button);
        textActor.disconnect(changed);
        button.disconnect(clicked);
        tooltip.destroy();
        button._speechTooltip = null;
    });
    update();
    return button;
}

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

class QuickTranslateLoadingPopover {
    constructor(onCancel = null, onRetry = null, pointerAnchor = null) {
        this._destroyed = false;
        this._overlayPressId = null;
        this._retryClickedId = null;
        this._firstPaintId = null;
        this._expandFallbackId = null;
        this._expanded = false;
        this._firstSpinnerCycleComplete = false;
        this._finishCallback = null;
        this._spinnerRepaintId = null;
        this._onCancel = onCancel;
        this._onRetry = onRetry;
        this.overlay = new St.Widget({
            style_class: 'translate-loading-overlay',
            reactive: true,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height
        });
        Main.uiGroup.add_child(this.overlay);
        this._overlayPressId = this.overlay.connect('button-press-event', () => {
            this._onCancel?.();
            return Clutter.EVENT_STOP;
        });
        this.actor = new St.BoxLayout({
            style_class: 'translate-loading-popover',
            reactive: true,
            can_focus: false,
            accessible_name: _("Translating…"),
            y_align: Clutter.ActorAlign.CENTER
        });

        this.spinnerBox = new St.Widget({
            style_class: 'translate-loading-spinner-box',
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
        });
        this.spinner = new St.DrawingArea({
            style_class: 'translate-loading-spinner',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.spinner.set_size(18, 18);
        // Clutter otherwise rotates around the actor's top-left corner,
        // making the ring orbit inside the popover instead of spinning in place.
        this.spinner.set_pivot_point(0.5, 0.5);
        this._spinnerRepaintId = this.spinner.connect('repaint', area => {
            const cr = area.get_context();
            const size = 18;
            const radius = 6.5;
            cr.setSourceRGBA(0.21, 0.52, 0.89, 1);
            cr.setLineWidth(2.5);
            cr.setLineCap(1);
            cr.arc(size / 2, size / 2, radius, -Math.PI / 2, Math.PI * 1.15);
            cr.stroke();
            cr.$dispose();
        });
        this.spinnerBox.add_child(this.spinner);
        this.actor.add_child(this.spinnerBox);

        this.label = new St.Label({
            text: _("Translating…"),
            style_class: 'translate-loading-label',
            y_align: Clutter.ActorAlign.CENTER
        });
        this.label.opacity = 0;
        this.actor.add_child(this.label);

        this.retryButton = new St.Button({
            label: _("Retry"),
            style_class: 'translate-loading-retry-btn',
            visible: false,
            reactive: true,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        this.retryButton.opacity = 0;
        this._retryClickedId = this.retryButton.connect('clicked', () => this._onRetry?.());
        this.actor.add_child(this.retryButton);
        Main.uiGroup.add_child(this.actor);

        const [currentPointerX, currentPointerY] = global.get_pointer();
        const pointerX = pointerAnchor?.x ?? currentPointerX;
        const pointerY = pointerAnchor?.y ?? currentPointerY;
        const monitorIndex = Math.max(0, Main.layoutManager.monitors.findIndex(monitor =>
            pointerX >= monitor.x && pointerX < monitor.x + monitor.width &&
            pointerY >= monitor.y && pointerY < monitor.y + monitor.height
        ));
        const monitor = Main.layoutManager.monitors[monitorIndex] ??
            Main.layoutManager.primaryMonitor;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex) ?? monitor;
        this._pointerX = pointerX;
        this._pointerY = pointerY;
        this._workArea = workArea;
        this._gap = 16;
        this._compactSize = 36;
        this.actor.set_style('height: 36px; padding: 0px; spacing: 0px;');
        this.actor.set_size(this._compactSize, this._compactSize);
        this.spinnerBox.set_size(this._compactSize, this._compactSize);
        const [compactX, compactY] = this._positionForWidth(this._compactSize, false);
        this.actor.set_position(compactX, compactY);

        // The compact spinner must be painted before its expansion starts.
        // Otherwise Clutter coalesces both states into one frame and users only
        // see the delayed, wide popover. A short fallback keeps the UI moving
        // if a compositor does not emit after-paint (e.g. a nested test shell).
        this._firstPaintId = global.stage.connect('after-paint', () => this._startExpansion());
        this._expandFallbackId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 32, () => {
            this._expandFallbackId = null;
            this._startExpansion();
            return GLib.SOURCE_REMOVE;
        });
        this.actor.queue_relayout();
        this.actor.queue_redraw();
        this.spinner.queue_repaint();
    }

    _positionForWidth(width, expandLeft) {
        const workArea = this._workArea;
        const minX = workArea.x + 8;
        const maxX = workArea.x + workArea.width - width - 8;
        const minY = workArea.y + 8;
        const maxY = workArea.y + workArea.height - this._compactSize - 8;
        let x = expandLeft
            ? this._pointerX - this._gap - width
            : this._pointerX + this._gap;
        let y = this._pointerY + this._gap;
        if (y > maxY)
            y = this._pointerY - this._gap - this._compactSize;
        return [
            Math.round(Math.max(minX, Math.min(x, Math.max(minX, maxX)))),
            Math.round(Math.max(workArea.y + 8, Math.min(y, Math.max(workArea.y + 8, maxY)))),
        ];
    }

    getPosition() {
        if (!this.actor) return null;
        return {x: this.actor.x, y: this.actor.y};
    }

    _contentWidth(includeRetry = false) {
        this.label.ensure_style();
        const labelWidth = this.label.get_preferred_width(-1)[1];
        let width = this._compactSize + 6 + labelWidth + 12;
        if (includeRetry) {
            this.retryButton.ensure_style();
            width += 6 + this.retryButton.get_preferred_width(-1)[1];
        }
        return Math.min(
            Math.max(this._compactSize, Math.ceil(width)),
            Math.max(this._compactSize, this._workArea.width - 16)
        );
    }

    _startExpansion() {
        if (this._destroyed || this._expanded || !this.actor) return;
        this._expanded = true;
        if (this._firstPaintId) {
            try { global.stage.disconnect(this._firstPaintId); } catch (e) {}
            this._firstPaintId = null;
        }
        if (this._expandFallbackId) {
            GLib.Source.remove(this._expandFallbackId);
            this._expandFallbackId = null;
        }

        const width = this._contentWidth(false);
        const expandsLeft = this._pointerX + this._gap + width >
            this._workArea.x + this._workArea.width - 8;
        const [expandedX] = this._positionForWidth(width, expandsLeft);
        this.actor.set_style('height: 40px; padding: 0px 6px; spacing: 6px;');
        this.actor.ease({
            width,
            x: expandsLeft ? expandedX : this.actor.x,
            duration: QUICK_TRANSLATE_EXPAND_DURATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this.label.ease({
            opacity: 255,
            duration: Math.floor(QUICK_TRANSLATE_EXPAND_DURATION_MS / 2),
            delay: Math.floor(QUICK_TRANSLATE_EXPAND_DURATION_MS / 2),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._startSpinnerCycle();
    }

    _startSpinnerCycle() {
        if (this._destroyed || !this.spinner)
            return;
        if (this._firstSpinnerCycleComplete && this._finishCallback) {
            const finish = this._finishCallback;
            this._finishCallback = null;
            finish();
            return;
        }
        this.spinner.rotation_angle_z = 0;
        this.spinner.ease({
            rotation_angle_z: 360,
            duration: QUICK_TRANSLATE_SPINNER_CYCLE_MS,
            mode: Clutter.AnimationMode.LINEAR,
            onComplete: () => {
                if (this._destroyed || !this.spinner) return;
                this.spinner.rotation_angle_z = 0;
                this._firstSpinnerCycleComplete = true;
                if (this._finishCallback) {
                    const finish = this._finishCallback;
                    this._finishCallback = null;
                    finish();
                    return;
                }
                this._startSpinnerCycle();
            },
        });
    }

    finish(callback) {
        if (this._destroyed) {
            callback();
            return;
        }
        this._finishCallback = callback;
        if (this._firstSpinnerCycleComplete) {
            this._finishCallback = null;
            callback();
        }
    }

    _resizeForContent(includeRetry = false) {
        if (this._destroyed || !this.actor) return;
        this._startExpansion();
        const width = this._contentWidth(includeRetry);
        const expandsLeft = this._pointerX + this._gap + width >
            this._workArea.x + this._workArea.width - 8;
        const [x] = this._positionForWidth(width, expandsLeft);
        this.actor.ease({
            width,
            x: expandsLeft ? x : this.actor.x,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    showSlowMessage() {
        if (this._destroyed || !this.label) return;
        this.label.text = _("Still translating…");
        this._resizeForContent(false);
    }

    showRetry() {
        if (this._destroyed || !this.label) return;
        this.spinner?.remove_all_transitions();
        this.label.text = _("Translation timed out");
        if (this.retryButton) {
            this.retryButton.visible = true;
            this.retryButton.ease({
                opacity: 255,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        this._resizeForContent(true);
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;

        if (this._firstPaintId) {
            try { global.stage.disconnect(this._firstPaintId); } catch (e) {}
            this._firstPaintId = null;
        }
        if (this._expandFallbackId) {
            GLib.Source.remove(this._expandFallbackId);
            this._expandFallbackId = null;
        }
        if (this.overlay && this._overlayPressId) {
            try { this.overlay.disconnect(this._overlayPressId); } catch (e) {}
            this._overlayPressId = null;
        }
        if (this.retryButton && this._retryClickedId) {
            try { this.retryButton.disconnect(this._retryClickedId); } catch (e) {}
            this._retryClickedId = null;
        }
        if (this.spinner && this._spinnerRepaintId) {
            try { this.spinner.disconnect(this._spinnerRepaintId); } catch (e) {}
            this._spinnerRepaintId = null;
        }
        if (this.spinner) {
            this.spinner.remove_all_transitions();
            this.spinner.destroy();
            this.spinner = null;
        }
        if (this.spinnerBox) {
            this.spinnerBox.destroy();
            this.spinnerBox = null;
        }
        if (this.label) {
            this.label.destroy();
            this.label = null;
        }
        if (this.retryButton) {
            this.retryButton.destroy();
            this.retryButton = null;
        }
        if (this.overlay) {
            this.overlay.destroy();
            this.overlay = null;
        }
        if (this.actor) {
            this.actor.destroy();
            this.actor = null;
        }
        this._onCancel = null;
        this._onRetry = null;
    }
}

class FloatingTranslationWindow {
    constructor(sourceText, targetText, sourceLang, targetLang, onDestroy, onCopyClicked, settings, speech = null, positionOverride = null) {
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
        srcLabel.get_clutter_text().set_single_line_mode(false);
        srcLabel.get_clutter_text().set_ellipsize(Pango.EllipsizeMode.NONE);
        srcLabel.get_clutter_text().set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        srcBox.add_child(srcLabel);
        srcScroll.add_child(srcBox);
        this.actor.add_child(srcScroll);

        if (speech) {
            const sourceContainer = new St.BoxLayout({vertical: true});
            this.actor.remove_child(srcScroll);
            sourceContainer.add_child(srcScroll);
            this.sourceSpeechBtn = addSpeechButton(sourceContainer, srcLabel.get_clutter_text(), speech, () => sourceLang);
            this.actor.add_child(sourceContainer);
        }

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
        destLabel.get_clutter_text().set_single_line_mode(false);
        destLabel.get_clutter_text().set_ellipsize(Pango.EllipsizeMode.NONE);
        destLabel.get_clutter_text().set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        destBox.add_child(destLabel);
        destScroll.add_child(destBox);
        this.actor.add_child(destScroll);

        if (speech) {
            const targetContainer = new St.BoxLayout({vertical: true});
            this.actor.remove_child(destScroll);
            targetContainer.add_child(destScroll);
            this.targetSpeechBtn = addSpeechButton(targetContainer, destLabel.get_clutter_text(), speech, () => targetLang);
            this.actor.add_child(targetContainer);
        }

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

        // Compact adaptive translation popup
        const [currentPointerX, currentPointerY] = global.get_pointer();
        const pointerX = positionOverride?.x ?? currentPointerX;
        const pointerY = positionOverride?.y ?? currentPointerY;
        const popupMonitorIndex = Math.max(0, Main.layoutManager.monitors.findIndex(monitor =>
            pointerX >= monitor.x && pointerX < monitor.x + monitor.width &&
            pointerY >= monitor.y && pointerY < monitor.y + monitor.height
        ));
        const popupMonitor = Main.layoutManager.monitors[popupMonitorIndex] ??
            Main.layoutManager.primaryMonitor;

        closeBtn.get_child().set_style('icon-size: 16px;');
        copyBtn.get_child().set_style('icon-size: 16px;');
        if (this.autoCopyBtn)
            this.autoCopyBtn.get_child().set_style('icon-size: 16px;');

        // St.Label only copies its CSS font onto the inner ClutterText on
        // style-changed. Force style resolution for the whole tree first,
        // otherwise text is measured with the default font and the computed
        // heights end up too small (text overflowing the popup).
        const ensureStyleTree = actor => {
            if (actor instanceof St.Widget)
                actor.ensure_style();
            for (const child of actor.get_children())
                ensureStyleTree(child);
        };
        ensureStyleTree(this.actor);

        // Measure styled text rather than guessing from character counts.
        const naturalWidth = Math.max(
            srcLabel.get_preferred_width(-1)[1],
            destLabel.get_preferred_width(-1)[1],
            header.get_preferred_width(-1)[1],
            actions.get_preferred_width(-1)[1]
        );
        const contentWidth = Math.min(
            Math.max(280, Math.min(460, naturalWidth + 16)),
            Math.max(1, popupMonitor.width - 64)
        );
        this.actor.set_style(`width: ${contentWidth}px;`);

        const textBlocks = [
            [srcLabel, srcScroll, 110],
            [destLabel, destScroll, Math.min(300, popupMonitor.height * 0.35)]
        ];
        for (const [label, scroll] of textBlocks) {
            scroll.x_expand = true;
            scroll.y_expand = false;
            label.get_parent().y_expand = false;
            label.set_width(contentWidth - 16);
            label.x_expand = true;
            label.y_expand = false;
            const textActor = label.get_clutter_text();
            textActor.set_single_line_mode(false);
            textActor.set_line_wrap(true);
            textActor.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
            textActor.set_ellipsize(Pango.EllipsizeMode.NONE);
        }
        const fitTextHeights = () => {
            for (const [label, scroll, maxHeight] of textBlocks) {
                const [, naturalHeight] = label.get_preferred_height(label.get_width());
                scroll.set_height(Math.ceil(Math.min(maxHeight, naturalHeight + 8)));
            }
        };
        this._destLabel = destLabel;
        this._destScroll = destScroll;
        fitTextHeights();

        // Open next to the selection: the pointer is the best available proxy
        // (Wayland exposes no selection geometry). Prefer below-right of the
        // pointer, flip above/left when it would leave the work area.
        const workArea = Main.layoutManager.getWorkAreaForMonitor(popupMonitorIndex) ?? popupMonitor;
        const GAP = 16;
        const place = () => {
            const [, width] = this.actor.get_preferred_width(-1);
            const [, height] = this.actor.get_preferred_height(width);
            const minX = workArea.x + 8;
            const maxX = workArea.x + workArea.width - width - 8;
            const minY = workArea.y + 8;
            const maxY = workArea.y + workArea.height - height - 8;

            let x = pointerX + GAP;
            if (x > maxX)
                x = pointerX - GAP - width;
            let y = pointerY + GAP;
            if (y > maxY)
                y = pointerY - GAP - height;

            x = Math.max(minX, Math.min(x, Math.max(minX, maxX)));
            y = Math.max(minY, Math.min(y, Math.max(minY, maxY)));
            this.actor.set_position(Math.round(x), Math.round(y));
        };
        place();

        // Re-check once real layout exists (fonts are guaranteed applied by now).
        this._allocationId = this.actor.connect('notify::allocation', () => {
            this.actor.disconnect(this._allocationId);
            this._allocationId = null;
            fitTextHeights();
            place();
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
        this._destLabel = null;
        this._destScroll = null;
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


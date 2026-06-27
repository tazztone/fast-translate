
<!-- start project-info -->
<!--
project_title: Translate assistant
github_project: https://github.com/tazztone/translate-assistant
license: MIT
icon: icons/translate-assistant-icon.svg
homepage: https://github.com/tazztone/translate-assistant
license-badge: True
contributors-badge: True
lastcommit-badge: True
--->

<!-- end project-info -->

<!-- start badges -->

![License MIT](https://img.shields.io/badge/license-MIT-green)
![Contributors](https://img.shields.io/github/contributors-anon/tazztone/translate-assistant)
![Last commit](https://img.shields.io/github/last-commit/tazztone/translate-assistant)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-tazztone-yellow?logo=buy-me-a-coffee)](https://buymeacoffee.com/tazztone)
<!-- end badges -->

<!-- start description -->
<h1 align="center">Welcome to <span id="project_title">Translate Assistant for GNOME Shell</span> 👋</h1>
<p>
<a href="https://github.com/tazztone/translate-assistant" id="homepage" rel="nofollow">
<img align="right" height="128" id="icon" src="icons/translate-assistant-icon.svg" width="128"/>
</a>
</p>
<h2>🏠 <a href="https://github.com/tazztone/translate-assistant" id="homepage">Homepage</a></h2>

<span id="project_title">Translate Assistant for GNOME Shell</span> is a GNOME Shell extension that brings **Google Translate and DeepL-powered translation** directly into your desktop — translate text from a panel popup or trigger instant clipboard translation with a double-copy shortcut.

## ✨ Features

- **Panel menu translator** — a clean popover accessible from the GNOME top bar lets you type or paste text and translate it instantly.
- **Inline language selector** — switch source and target languages directly inside the popup using a flag-emoji grid, no settings window needed.
- **Double-copy translation** — press the copy shortcut (`Ctrl+C` `Ctrl+C`) twice in rapid succession to trigger instant translation. Choose between displaying the result in a floating window, or running silently in the background to auto-copy the translation directly to your clipboard for immediate pasting (`Ctrl+V`).
- **Configurable shortcut** — the clipboard-translate keybinding can be customised in the extension preferences.
- **Multiple Backends** — choose between Google Translate (works instantly out-of-the-box, no key required) and DeepL (Free & Pro tiers).

<!-- end description -->

<!-- start prerequisites -->

## Prerequisites

| Requirement | Details |
|---|---|
| GNOME Shell | 45 – 50 |
| DeepL API key | (Optional) [Free or Pro](https://www.deepl.com/pro-api) — only needed if choosing DeepL as your active provider |

<!-- end prerequisites -->

<!-- start installing -->

## Installing <span id="project_title">Translate Assistant for GNOME Shell</span>

### From GNOME Extensions (recommended)

1. Visit the [Translate Assistant page on extensions.gnome.org](https://extensions.gnome.org/extension/5124/translate-assistant/).
2. Toggle the switch to **On** — the browser integration installs and enables the extension automatically.

### Manual installation

```bash
git clone https://github.com/tazztone/translate-assistant.git
ln -s "$(pwd)/translate-assistant" \
  ~/.local/share/gnome-shell/extensions/translate-assistant@atareao.es
gnome-extensions enable translate-assistant@atareao.es
```

> **Note**: Do **not** use `gnome-extensions install` from inside the repo — it follows symlinks and will overwrite the source directory. The symlink approach above is the safe dev workflow.

<!-- end installing -->

<!-- start using -->

## Using <span id="project_title">Translate Assistant for GNOME Shell</span>

Once enabled, the extension icon appears in the GNOME top bar. Click it to open the translation popup, type or paste text, choose your languages, and hit **Translate**.

![Panel popup showing the translation interface](./screenshots/main.webp)

### Double-copy clipboard translation

Copy any text normally, then press `Ctrl+C` a second time within ~500 ms. Depending on your preferences:

- **Default mode**: A floating window appears with the translated result — no focus stealing, no screen dimming.
- **Background mode**: The translation runs silently in the background and automatically updates your clipboard, allowing you to instantly paste (`Ctrl+V`) the translated text without distraction. An optional desktop toast notification is shown on completion.

![Floating window triggered by the double-copy shortcut](./screenshots/CTRLCC.webp)

### Preferences

Open **GNOME Settings → Extensions → Translate Assistant → Settings** to configure:

- Active translation service (Google Translate or DeepL)
- DeepL API key & URL (automatically hidden when Google Translate is selected)
- Default source and target languages
- Clipboard-translate keybinding
- Auto-translate behavior
- Dark/light theme icons and notifications
- **Double-copy Background Mode** (enable silent clipboard-to-clipboard translation)
- **Show Notification in Background Mode** (enable/disable completion toasts)

<!-- end using -->

## 🛠 Development

```bash
# Compile GSettings schemas after editing .gschema.xml
glib-compile-schemas schemas/

# Reload the extension after changes
gnome-extensions disable translate-assistant@atareao.es
gnome-extensions enable translate-assistant@atareao.es

# Watch logs in real time
journalctl -f -o cat /usr/bin/gnome-shell
```

<!-- start contributing -->

## Contributing to <span id="project_title">Translate Assistant for GNOME Shell</span>

1. Fork this repository.
2. Create a branch: `git checkout -b <branch_name>`.
3. Make your changes and commit them: `git commit -m '<commit_message>'`
4. Push to the original branch: `git push origin <branch_name>`
5. Create a pull request.

See the GitHub docs on [creating a pull request](https://help.github.com/en/github/collaborating-with-issues-and-pull-requests/creating-a-pull-request) for help.

<!-- end contributing -->

<!-- start contributors -->

## 👤 Contributors ✨

Thanks goes to these wonderful people ([emoji key](https://allcontributors.org/docs/en/emoji-key)):

<!-- end contributors -->

<!-- start table-contributors -->

<table id="contributors">
    <tr id="info_avatar">
        <td id="daPhipz" align="center">
            <a href="https://github.com/daPhipz">
                <img src="https://avatars3.githubusercontent.com/u/30795174?v=4" width="100px"/>
            </a>
        </td>
        <td id="fabricio8800" align="center">
            <a href="https://github.com/fabricio8800">
                <img src="https://avatars3.githubusercontent.com/u/7343464?v=4" width="100px"/>
            </a>
        </td>
        <td id="Vistaus" align="center">
            <a href="https://github.com/Vistaus">
                <img src="https://avatars3.githubusercontent.com/u/1716229?v=4" width="100px"/>
            </a>
        </td>
        <td id="atareao" align="center">
            <a href="https://github.com/atareao">
                <img src="https://avatars3.githubusercontent.com/u/298055?v=4" width="100px"/>
            </a>
        </td>
    </tr>
    <tr id="info_name">
        <td id="daPhipz" align="center">
            <a href="https://github.com/daPhipz">
                <strong>Philipp Kiemle</strong>
            </a>
        </td>
        <td id="fabricio8800" align="center">
            <a href="https://github.com/fabricio8800">
                <strong>Fabrício Müller</strong>
            </a>
        </td>
        <td id="Vistaus" align="center">
            <a href="https://github.com/Vistaus">
                <strong>Heimen Stoffels</strong>
            </a>
        </td>
        <td id="atareao" align="center">
            <a href="https://github.com/atareao">
                <strong>Lorenzo Carbonell</strong>
            </a>
        </td>
    </tr>
    <tr id="info_commit">
        <td id="daPhipz" align="center">
            <a href="/commits?author=daPhipz">
                <span id="role">💻</span>
            </a>
        </td>
        <td id="fabricio8800" align="center">
            <a href="/commits?author=fabricio8800">
                <span id="role">💻</span>
            </a>
        </td>
        <td id="Vistaus" align="center">
            <a href="/commits?author=Vistaus">
                <span id="role">💻</span>
            </a>
        </td>
        <td id="atareao" align="center">
            <a href="/commits?author=atareao">
                <span id="role">💻</span>
            </a>
        </td>
    </tr>
</table>

<!-- end table-contributors -->

---

## 📄 License

[MIT](./LICENSE) © Lorenzo Carbonell Cerezo (atareao) & contributors

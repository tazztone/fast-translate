import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {canSpeak, speechChunks, speechLanguage} from './speech-helper.js';

// One controller per extension. No text/audio is retained after playback.
export class SpeechController {
    constructor(onError, dependencies = {}) {
        this._session = dependencies.session ?? new Soup.Session({timeout: 15});
        this._play = dependencies.play ?? (path => Gio.Subprocess.new(
            ['gst-play-1.0', '--no-interactive', '--quiet', path],
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE));
        this._message = dependencies.message ?? (url => Soup.Message.new('GET', url));
        this._onError = onError;
        this._active = null;
    }

    stop(owner = null) {
        const task = this._active;
        if (!task || (owner && task.owner !== owner)) return;
        this._active = null;
        task.cancel.cancel();
        if (task.process) task.process.force_exit();
        if (task.path) GLib.unlink(task.path);
        task.state('idle');
    }

    async _request(url, task) {
        const message = this._message(url);
        const bytes = await new Promise((resolve, reject) => {
            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, task.cancel, (session, result) => {
                try { resolve(session.send_and_read_finish(result)); } catch (error) { reject(error); }
            });
        });
        if (this._active !== task) throw new Error('Cancelled');
        if (message.status_code !== 200) throw new Error('HTTP ' + message.status_code);
        return bytes;
    }

    async toggle(owner, text, language, state) {
        if (this._active?.owner === owner) { this.stop(); return; }
        this.stop();
        if (!canSpeak(text)) return;
        const task = {owner, state, cancel: new Gio.Cancellable(), process: null, path: null};
        this._active = task;
        state('loading');
        try {
            let lang = speechLanguage(language);
            if (!lang) {
                const bytes = await this._request('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=' + encodeURIComponent(text), task);
                lang = speechLanguage(JSON.parse(new TextDecoder().decode(bytes.get_data()))[2]);
                if (!lang) throw new Error('Language detection failed');
            }
            for (const chunk of speechChunks(text)) {
                if (!chunk.trim()) continue;
                state('loading');
                const bytes = await this._request('https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=' + encodeURIComponent(lang) + '&q=' + encodeURIComponent(chunk), task);
                const [fd, path] = GLib.file_open_tmp('fast-translate-speech-XXXXXX.mp3');
                GLib.close(fd);
                task.path = path;
                Gio.File.new_for_path(path).replace_contents(bytes.get_data(), null, false, Gio.FileCreateFlags.PRIVATE, task.cancel);
                task.process = this._play(path);
                state('playing');
                await new Promise((resolve, reject) => task.process.wait_check_async(null, (process, result) => {
                    try { process.wait_check_finish(result); resolve(); } catch (error) { reject(error); }
                }));
                if (this._active !== task) return;
                task.process = null;
                GLib.unlink(task.path);
                task.path = null;
            }
            this.stop();
        } catch (error) {
            if (this._active !== task) return;
            this.stop();
            this._onError(error, task.owner);
        }
    }

    destroy() {
        this.stop();
        this._session.abort();
    }
}

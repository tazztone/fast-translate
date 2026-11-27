import GLib from 'gi://GLib';
import {SpeechController} from '../speech.js';
function assert(value, message) { if (!value) throw new Error(message); }
const loop = new GLib.MainLoop(null, false);
let failed = false;
async function run() {
    let requests = [];
    let pending = [];
    let errors = 0;
    let paths = [];
    let exits = 0;
    const session = {
        send_and_read_async(message, priority, cancel, callback) {
            requests.push(message.get_uri().to_string());
            pending.push(() => { message.status_code = 200; callback(session, {}); });
        },
        send_and_read_finish() { return new GLib.Bytes(new TextEncoder().encode('mock mp3')); },
        abort() {},
    };
    let finishPlay;
    const controller = new SpeechController(() => errors++, {session, message: url => ({status_code: 0, get_uri: () => ({to_string: () => url})}), play(path) {
        paths.push(path);
        return {
            force_exit() { exits++; },
            wait_check_async(cancel, callback) { finishPlay = () => callback(this, {}); },
            wait_check_finish() {},
        };
    }});
    const states = [];
    const state = value => states.push(value);
    await controller.toggle('source', 'a'.repeat(501), 'AUTO', state);
    assert(requests.length === 0, 'Oversized text sent over network');
    let task = controller.toggle('source', 'Hello', 'en', state);
    pending.shift()();
    await Promise.resolve(); await Promise.resolve();
    assert(paths.length === 1 && GLib.file_test(paths[0], GLib.FileTest.EXISTS), 'Audio not created');
    finishPlay();
    await task;
    assert(!GLib.file_test(paths[0], GLib.FileTest.EXISTS), 'Audio leaked after completion');
    task = controller.toggle('source', 'Hello', 'en', state);
    controller.stop('other');
    assert(controller._active !== null, 'Other window stopped playback');
    await controller.toggle('source', 'Hello', 'en', state);
    pending.shift()();
    await task;
    assert(paths.length === 1, 'Cancelled request started playback');
    task = controller.toggle('target', 'Bonjour', 'fr', state);
    pending.shift()();
    await Promise.resolve(); await Promise.resolve();
    controller.destroy();
    finishPlay();
    await task;
    assert(exits === 1, 'Player not terminated');
    assert(paths.every(path => !GLib.file_test(path, GLib.FileTest.EXISTS)), 'Temporary audio leaked');
    assert(errors === 0 && states.at(-1) === 'idle', 'Unexpected error or stale state');
    // AUTO detection precedes speech, and cancellation suppresses stale errors.
    session.send_and_read_finish = () => new GLib.Bytes(new TextEncoder().encode('[null,null,"ru"]'));
    task = controller.toggle('auto', 'Привет', 'AUTO', state);
    pending.shift()();
    await Promise.resolve(); await Promise.resolve();
    assert(requests.at(-1).includes('tl=ru'), 'Detected source language not used');
    controller.stop();
    pending.shift()();
    await task;
    session.send_and_read_finish = () => { throw new Error('Network unavailable'); };
    task = controller.toggle('failure', 'Hello', 'en', state);
    pending.shift()();
    await task;
    assert(errors === 1 && states.at(-1) === 'idle', 'Network failure did not reset state');
    controller.destroy();
    print('Speech controller completion, cancellation and cleanup passed');
}
run().catch(error => { printerr(String(error) + "\n" + error.stack); failed = true; }).finally(() => loop.quit());
loop.run();
if (failed) throw new Error('Speech controller tests failed');

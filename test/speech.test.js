import assert from 'node:assert/strict';
import {canSpeak, speechChunks, speechLanguage} from '../speech-helper.js';
for (const length of [499, 500, 501]) {
    for (const character of ['a', '😀']) {
        const text = character.repeat(length);
        assert.equal(canSpeak(text), length <= 500);
        const chunks = speechChunks(text);
        if (length <= 500) {
            assert.equal(chunks.join(''), text);
            assert.ok(chunks.every(chunk => Array.from(chunk).length <= 100));
        } else assert.deepEqual(chunks, []);
    }
}
for (const text of ['', '   ', '\n\t']) assert.equal(canSpeak(text), false);
const text = ('Hello world! Привет мир. 😀\n').repeat(12);
assert.equal(speechChunks(text).join(''), text);

// Audio request boundaries should land on nearby punctuation even when a
// later whitespace boundary is closer to character 100.
const punctuationBoundary = 'a'.repeat(80) + '. ' + 'b'.repeat(40);
const punctuationChunks = speechChunks(punctuationBoundary);
assert.equal(punctuationChunks[0], 'a'.repeat(80) + '.');
assert.equal(punctuationChunks.join(''), punctuationBoundary);

// Punctuation outside the natural 65-character search window should not
// create an awkwardly short request; use the nearest word boundary instead.
const distantPunctuation = 'a'.repeat(20) + '. ' + 'b'.repeat(77) + ' ' + 'c'.repeat(20);
const distantChunks = speechChunks(distantPunctuation);
assert.equal(distantChunks[0], 'a'.repeat(20) + '. ' + 'b'.repeat(77) + ' ');
assert.equal(distantChunks.join(''), distantPunctuation);

const clauseBoundary = 'a'.repeat(75) + ', ' + 'b'.repeat(45);
assert.equal(speechChunks(clauseBoundary)[0], 'a'.repeat(75) + ',');

const unicodePunctuation = '字'.repeat(85) + '。' + '文'.repeat(20);
assert.equal(speechChunks(unicodePunctuation)[0], '字'.repeat(85) + '。');
assert.equal(speechLanguage('AUTO'), null);
assert.equal(speechLanguage('ZH-TW'), 'zh-TW');
assert.equal(speechLanguage('PT-BR'), 'pt');
console.log('Speech limits, Unicode, chunking and languages passed');

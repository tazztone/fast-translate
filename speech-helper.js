// Count Unicode code points, not UTF-16 code units.
export function canSpeak(text) {
    return typeof text === 'string' && text.trim().length > 0 && Array.from(text).length <= 500;
}

export function speechLanguage(code) {
    if (!code || code.toUpperCase() === 'AUTO') return null;
    const normalized = code.toLowerCase();
    return ({'zh': 'zh-CN', 'zh-cn': 'zh-CN', 'zh-tw': 'zh-TW',
        'pt-br': 'pt', 'en-us': 'en', 'en-gb': 'en'})[normalized] ?? normalized;
}

export function speechChunks(text) {
    if (!canSpeak(text)) return [];
    const chars = Array.from(text);
    const chunks = [];
    while (chars.length) {
        let length = Math.min(100, chars.length);
        if (length < chars.length) {
            // Prefer an audible phrase boundary over a closer word boundary.
            // A 65-character search window lets a normal sentence finish
            // naturally instead of cutting at a space near character 100.
            // Keep at least 35 characters in a chunk so a short opening
            // clause does not become a request on its own.
            const punctuationSearchStart = Math.max(35, length - 65);
            let foundPunctuation = false;
            for (let i = length - 1; i >= punctuationSearchStart; i--) {
                if (/[.!?…;:,—–。！？，、]/u.test(chars[i])) {
                    length = i + 1;
                    foundPunctuation = true;
                    break;
                }
            }
            // If no nearby punctuation exists, retain the old word-boundary
            // fallback; a long unbroken token must still be capped at 100.
            if (!foundPunctuation) {
                for (let i = length - 1; i > 0; i--) {
                    if (/\s/u.test(chars[i])) {
                        length = i + 1;
                        break;
                    }
                }
            }
        }
        chunks.push(chars.splice(0, length).join(''));
    }
    return chunks;
}

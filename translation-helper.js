/**
  * Pure helper functions for Translate Assistant.
  * These functions do not rely on GJS-specific window manager APIs and can be tested in Node.js.
  */

/**
 * Parses out standard language ISO codes (e.g., 'English (EN)' -> 'EN')
 * @param {string} description - The language description string from preferences
 * @returns {string|null} The country code or null
 */
export function parseCountryCode(description) {
    if (!description) return null;
    const regex = /^[^(]*\(([^)]*)\)$/gm;
    let m = regex.exec(description);
    if (m && m.length > 1) {
        return m[1];
    }
    return null;
}

/**
 * Safely formats query parameters for post request payload
 * @param {Object} params - Key-value pair parameters
 * @returns {string} The query string
 */
export function buildRequestQuery(params) {
    return Object.keys(params)
        .map(key => {
            const value = params[key];
            if (value === undefined || value === null) {
                return '';
            }
            const escapedKey = encodeURIComponent(key)
                .replace(/%20/g, '+')
                .replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
            const escapedValue = encodeURIComponent(value)
                .replace(/%20/g, '+')
                .replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
            return `${escapedKey}=${escapedValue}`;
        })
        .filter(part => part !== '')
        .join('&');
}

/**
 * Converts a 2-letter country code or language code to a regional flag emoji
 * @param {string} countryCode - The ISO country or language code (e.g. 'ES', 'PT-BR')
 * @returns {string} The regional flag emoji or empty string
 */
export function getFlagEmoji(countryCode) {
    if (!countryCode) return "";
    let code = countryCode.toUpperCase();
    if (code === 'AUTO') return "🌐";
    if (code.includes('-')) {
        code = code.split('-')[1];
    }
    
    // Custom language-to-country overrides
    const overrides = {
        'EN': 'GB',
        'JA': 'JP',
        'ZH': 'CN',
        'CS': 'CZ',
        'EL': 'GR',
        'SV': 'SE',
        'DA': 'DK',
        'SL': 'SI',
        'ET': 'EE'
    };
    
    if (overrides[code]) {
        code = overrides[code];
    }
    
    if (code.length === 2) {
        return String.fromCodePoint(
            code.codePointAt(0) - 65 + 0x1F1E6,
            code.codePointAt(1) - 65 + 0x1F1E6
        );
    }
    return "";
}

/**
 * Formats a language code with its flag emoji.
 * @param {string} langCode - The ISO country/language code
 * @returns {string} The formatted label text
 */
export function formatLanguageLabel(langCode) {
    if (!langCode) return "";
    if (langCode.toUpperCase() === 'AUTO') return "🌐 Auto";
    const flag = getFlagEmoji(langCode);
    return flag ? `${flag} ${langCode}` : langCode;
}

/**
 * Extracts the human-readable language name from GSchema enum description
 * (e.g. "English American (EN-US)" -> "English American")
 * @param {string} description - The description from preferences
 * @returns {string} The language name
 */
export function parseLanguageName(description) {
    if (!description) return "";
    const idx = description.indexOf('(');
    if (idx !== -1) {
        return description.substring(0, idx).trim();
    }
    return description;
}



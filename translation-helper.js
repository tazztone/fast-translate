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

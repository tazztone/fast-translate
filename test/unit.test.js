import assert from "assert";
import { parseCountryCode, buildRequestQuery, getFlagEmoji, formatLanguageLabel, parseLanguageName, isNonLatinXkbLayout } from "../translation-helper.js";

// ==========================================
// 1. parseCountryCode Tests
// ==========================================
console.log("⏳ Running parseCountryCode tests...");

assert.strictEqual(parseCountryCode("English (EN)"), "EN", "Should extract EN");
assert.strictEqual(parseCountryCode("Spanish (ES)"), "ES", "Should extract ES");
assert.strictEqual(parseCountryCode("Portuguese Brazilian (PT-BR)"), "PT-BR", "Should extract PT-BR");
assert.strictEqual(parseCountryCode("Bulgarian (BG)"), "BG", "Should extract BG");
assert.strictEqual(parseCountryCode(null), null, "Should return null on null");
assert.strictEqual(parseCountryCode(""), null, "Should return null on empty string");
assert.strictEqual(parseCountryCode("NoParentheses"), null, "Should return null on missing parentheses");

console.log("✅ parseCountryCode tests passed successfully!\n");

// ==========================================
// 2. buildRequestQuery Tests
// ==========================================
console.log("⏳ Running buildRequestQuery tests...");

const params = {
    text: "hello world!",
    target_lang: "ES",
    auth_key: "abc-123",
    split_sentences: "1"
};

const query = buildRequestQuery(params);
assert.strictEqual(
    query, 
    "text=hello+world%21&target_lang=ES&auth_key=abc-123&split_sentences=1",
    "Should correctly format and escape URL search queries"
);

console.log("✅ buildRequestQuery tests passed successfully!\n");

// ==========================================
// 3. getFlagEmoji and formatLanguageLabel Tests
// ==========================================
console.log("⏳ Running getFlagEmoji and formatLanguageLabel tests...");

assert.strictEqual(getFlagEmoji("ES"), "🇪🇸", "ES should map to Spain flag");
assert.strictEqual(getFlagEmoji("EN"), "🇬🇧", "EN should map to UK flag");
assert.strictEqual(getFlagEmoji("EN-US"), "🇺🇸", "EN-US should map to US flag");
assert.strictEqual(getFlagEmoji("PT-BR"), "🇧🇷", "PT-BR should map to Brazil flag");
assert.strictEqual(getFlagEmoji("ET"), "🇪🇪", "ET should map to Estonia flag");
assert.strictEqual(getFlagEmoji("ZH"), "🇨🇳", "ZH should map to China flag");
assert.strictEqual(getFlagEmoji(null), "", "Null should return empty string");
assert.strictEqual(getFlagEmoji(""), "", "Empty string should return empty string");

assert.strictEqual(formatLanguageLabel("DE"), "🇩🇪 DE", "DE should be formatted as 🇩🇪 DE");
assert.strictEqual(formatLanguageLabel(null), "", "Null should be formatted as empty string");
assert.strictEqual(formatLanguageLabel(""), "", "Empty string should be formatted as empty string");

assert.strictEqual(parseLanguageName("English American (EN-US)"), "English American", "Should extract English American");
assert.strictEqual(parseLanguageName("Spanish (ES)"), "Spanish", "Should extract Spanish");
assert.strictEqual(parseLanguageName("NoParens"), "NoParens", "Should return string directly if no parentheses");
assert.strictEqual(parseLanguageName(null), "", "Null should return empty string");

console.log("✅ getFlagEmoji and formatLanguageLabel tests passed successfully!\n");

// ==========================================
// isNonLatinXkbLayout Tests
// ==========================================
console.log("⏳ Running isNonLatinXkbLayout tests...");

assert.strictEqual(isNonLatinXkbLayout("ru"), true, "ru is Cyrillic");
assert.strictEqual(isNonLatinXkbLayout("ua+phonetic"), true, "ua variants stay Cyrillic");
assert.strictEqual(isNonLatinXkbLayout("us+rus"), true, "us+rus is Russian phonetic");
assert.strictEqual(isNonLatinXkbLayout("gr"), true, "gr is Greek");
assert.strictEqual(isNonLatinXkbLayout("rs+latin"), false, "rs+latin is Latin");
assert.strictEqual(isNonLatinXkbLayout("de"), false, "de is Latin");
assert.strictEqual(isNonLatinXkbLayout("us+dvorak"), false, "Dvorak is Latin");
assert.strictEqual(isNonLatinXkbLayout(""), false, "Empty id is treated as Latin");
assert.strictEqual(isNonLatinXkbLayout(null), false, "Null id is treated as Latin");

console.log("✅ isNonLatinXkbLayout tests passed successfully!\n");

console.log("🎉 All unit tests passed successfully!");


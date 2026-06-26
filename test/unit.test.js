import assert from "assert";
import { parseCountryCode, buildRequestQuery } from "../translation-helper.js";

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

console.log("🎉 All unit tests passed successfully!");

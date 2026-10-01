# Google 429: free endpoint vs Cloud API — verdict: support both

**Verdict:** keep the free `client=gtx` endpoint as default, add Cloud Translation **Basic v2 with API key** as opt-in. They fail differently and need different messages; one error string can't cover both.

| Provider | Endpoint | Auth | Use when |
|---|---|---|---|
| Google (free, default) | `translate_a/single?client=gtx` | none | zero-setup, light use |
| Google Cloud (new) | `translation.googleapis.com/language/translate/v2` | user API key | free endpoint keeps 429ing; you want your own quota |
| DeepL (existing) | `api-free.deepl.com` | user key | quality/formality |

- Free-429 = **this IP is throttled** (shared NAT/VPN fate, nothing to raise in a console). Community clients document per-IP `TooManyRequestsError` with proxy-rotation as the only bypass — unshippable in a GNOME extension, so our fix is backoff + reduced auto-fire, not proxies. ([vitalets README](https://github.com/vitalets/google-translate-api), [issue #107](https://github.com/vitalets/google-translate-api/issues/107))
- Cloud quota-exceed = **403** `Daily/User Rate Limit Exceeded` (actionable in Cloud Console; Basic+key still scopes per-user quota by IP, so Cloud raises the ceiling but isn't magic). ([Quotas](https://docs.cloud.google.com/translate/quotas))
- Cloud v2 request: `POST …/language/translate/v2` with `q`, `target`, optional `source`/`format`/`model`, `?key=` or OAuth; response is `{data:{translations:[{translatedText…}]}}`, not the free `json[0][i][0]` array. ([v2 ref](https://docs.cloud.google.com/translate/docs/reference/rest/v2/translate), [guide](https://docs.cloud.google.com/translate/docs/translate-text))
- Cloud pricing: **500k chars/mo free** ($10 credit), then **$20/M**. A clipboard user stays free forever; the cost is setup (project → enable API → key → billing). ([Pricing](https://cloud.google.com/products/translate/pricing))
- Free endpoint is unofficial ("to be 100% legal use the official API" — [same README](https://github.com/vitalets/google-translate-api)); API ToS requires documented means of access ([ToS](https://console.cloud.google.com/tos?id=universal)). Keep it for onboarding, don't build on it as if it had an SLA.
- DeepL model to copy: retry 429/5xx with backoff + `Retry-After`, treat 456 as stop, 403 as key fix. ([DeepL errors](https://developers.deepl.com/docs/best-practices/error-handling))

## What changed on re-review (critique of v1 plan)

1. **Sequence it: hardening first, provider second.** v1 jumped to the new provider. But `extension.js` mishandles 429/456 on *every* backend today (DeepL 429/456 fall through to generic `Error: <code>`; free 403/429 share one vague string). Phase 0 below fixes messages + backoff with no schema change, so users benefit even if they never get a key.
2. **Deduplicate, don't triplicate.** `_translateText` and `_translateTextIndependent` already duplicate the Google/DeepL builders and parsers. A third `if` in both doubles the drift. Put `build*`/`parse*`/code-map/error-map in `translation-helper.js` (pure, Node-testable like the existing `unit.test.js`) and call from both paths.
3. **Language codes don't transfer 1:1.** Our schema has `EN-GB`, `EN-US`, `PT-PT`, `PT-BR`, `ZH`. Cloud v2 wants BCP-47 like `en`, `pt`, `es` (docs: [Language Support](https://cloud.google.com/translate/docs/languages)). Need a small `toGoogleCloudCode()` map + test; v1 omitted this and the Cloud branch would 400 on day one.
4. **Handle Cloud 429 too, and parse the body.** Docs emphasize 403 for quota, but JSON APIs can surface `429 RESOURCE_EXHAUSTED`; the error body carries `Daily Limit Exceeded` vs auth-failure detail. Map on **status + body message**, not status alone.
5. **Add a post-429 cooldown for the free endpoint.** Debounce (600 ms, `extension.js:1178`) already exists for typing, but double-copy/shortcut fire immediately and auto-translate re-fires. After a free-429, suppress auto-translate/background triggers ~60 s with a "paused, tap to retry" hint. This is the actual 429 fix for users who never add a key.
6. **Key hygiene specifics.** New `google-apikey` key (don't reuse DeepL's — users may hold both); `?key=${encodeURIComponent(key)}` over https only; never log the URL/body; masked `PasswordEntryRow` like DeepL. GSettings plaintext matches existing DeepL precedent — note it, don't re-architect to keyring in this change.

## Plan

**Phase 0 — hardening (no schema change)**
- `translation-helper.js`: add `mapGoogleCloudCode()`, `classifyGoogleFreeError()`, `classifyDeepLError()` (covers 429/456), `classifyCloudError()` (403/429 + body match).
- `extension.js` (both translate paths): per-backend messages — free 429/403 → "Google throttled this network — wait, disable Auto Translate, or add a Cloud key"; DeepL 429 → backoff-retry, 456 → "quota reached, check usage endpoint"; DeepL 403 → keep "check key/URL".
- Free-endpoint cooldown: timestamp of last 429; skip auto/background triggers for 60 s; manual Translate always allowed.
- Tests: extend `unit.test.js` for the helpers; `eval-test.js` asserts DeepL 429/456 and free-429 strings.

**Phase 1 — Cloud provider (opt-in)**
- `gschema.xml`: **append** `'Google Cloud'` to `translation-service` enum (append-only; stored ints), add `google-apikey` string. Recompile via `scripts/pack.sh` only.
- `extension.js`: third builder branch (v2 `?key=`, `format=text`, single `q`) + `data.translations[0].translatedText` parser, via the Phase-0 helpers so both translate paths gain it.
- `prefs.js`: credentials group shows DeepL rows *or* Cloud key row per provider; Cloud row links Console key-creation; fix `"Google needs no key"` subtitle (true only for free variant).
- Tests: `eval-test.js` 4c — Cloud URL/body/`q`/`target`/`format`, key in URL not header, v2-response fixture parses; free-path assertions unchanged.
- Docs: README provider table + prefs note. No silent free→paid fallback (would bill without consent); free-429 error hints at the Cloud option instead.

## Non-goals

- No v3/Advanced (service-account OAuth is unjustifiable in Shell-process code).
- No proxy rotation, no keyring migration, no auto-fallback to paid.
- `MAX_INPUT_CHARS=5000` already satisfies Cloud's ~5K recommended / 100K-byte max — no change.

## Sources

- In-repo: `extension.js` gtx builders + `403/429` handlers, 600 ms debounce, `MAX_INPUT_CHARS`; `prefs.js` key promise; `translation-service` enum; `eval-test.js` gtx mock.
- [v2 translate ref](https://docs.cloud.google.com/translate/docs/reference/rest/v2/translate) · [Quotas](https://docs.cloud.google.com/translate/quotas) · [Overview (Basic=v2, Advanced=v3)](https://docs.cloud.google.com/translate/docs/api-overview) · [Auth](https://docs.cloud.google.com/translate/docs/authentication) · [Pricing](https://cloud.google.com/products/translate/pricing) · [API ToS](https://console.cloud.google.com/tos?id=universal) · [Translate ToS](https://console.cloud.google.com/tos?id=translate)
- [DeepL error handling](https://developers.deepl.com/docs/best-practices/error-handling) · [DeepL error messages](https://support.deepl.com/hc/en-us/articles/9773964275868-DeepL-API-error-messages) · [DeepL limits](https://developers.deepl.com/docs/resources/usage-limits)
- [vitalets/google-translate-api](https://github.com/vitalets/google-translate-api) (+ [#107](https://github.com/vitalets/google-translate-api/issues/107)) · [py-googletrans#268](https://github.com/ssut/py-googletrans/issues/268)

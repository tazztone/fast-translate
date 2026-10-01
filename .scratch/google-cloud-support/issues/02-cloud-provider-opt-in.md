# 02: Google Cloud provider opt-in

**What to build:** a third translation-service choice that translates end-to-end through the official API with the user's own key — selectable in preferences, working from the panel popup and double-copy flows, with the free default untouched for users without a key.

**Blocked by:** 01 (Truthful errors and free-endpoint cooldown).

**Status:** ready-for-agent

- [ ] New provider is selectable; its masked key field shows only for it and existing users keep their current provider
- [ ] Translating with the new provider returns and displays official-API results in popup and floating flows
- [ ] Quota failures say check console/billing and auth failures say check key — never the free-throttle text, and the Cloud quota never inherits the free-IP cooldown
- [ ] No silent paid fallback: free-429 only hints at the Cloud option, never bills without consent
- [ ] Mocked backend tests cover the new provider shapes and the setup docs describe key creation

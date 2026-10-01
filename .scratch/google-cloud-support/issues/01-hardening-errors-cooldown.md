# 01: Truthful errors and free-endpoint cooldown

**What to build:** every translation backend fails honestly end-to-end: the panel popup and floating window show which backend failed and what to do next, DeepL throttling backs off instead of hammering, quota stops instead of retrying, and after a free-endpoint throttle the automatic triggers pause with a hint while manual Translate keeps working.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Forcing a free-endpoint 429/403 shows a throttling message with a next action, in both the panel popup and the floating-window path
- [ ] Forcing DeepL 429 retries with backoff, 456 shows quota-reached stop, 403 shows check-key — no generic code dump
- [ ] After a free-endpoint 429, auto-translate and background double-copy pause (~60s) with a paused hint; manual Translate still sends immediately
- [ ] Official-API error classification (quota vs auth, status + body) is centralized in tested helpers with code mapping covered
- [ ] Existing unit plus integration suites stay green

---
"executor": patch
---

- OpenAPI sources now support OAuth2 authorization-code onboarding directly from the dashboard, including a popup flow that stores and refreshes access tokens for you.
- Remote to the Executor Web Dashboard from a locally-running CLI.
- Faster source-add: secret provider lookups and header resolution now run in parallel.
- Fixed a bug where secrets could become unreachable after upgrading between builds that changed storage layout — secret rows are now preserved across the migration.
- Fixed MCP stdio tools failing to run when the CLI was launched with a custom code executor.
- Fixed OpenAPI spec fetching on Workers (Cloud) and polished the Sentry / OpenAI preset icons.
- Backend errors now return a stable trace id you can hand us for lookup, instead of leaking stack traces.

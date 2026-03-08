# Personal Notes

- Credential system direction: keep `SecretRef { providerId, handle }` as the stable runtime abstraction, but move durable auth ownership to first-class `credentials` records instead of source-centric bindings.
- Local-first is fine with `postgres`, `keychain`, dangerous `env`, and `params`, but future cloud/team support needs scoped credentials, policy around use/manage/reveal, and source-to-credential binding by `credentialId`.
- Avoid leaking durable auth state into generic interaction history or source-specific public APIs; keep the current provider model, but treat current source-level binding as transitional.

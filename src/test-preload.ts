// Preloaded by bunfig.toml before any test module loads. config.ts reads the
// auth secrets from the environment at import time and is cached process-wide,
// so the only reliable way to test the configured-auth paths is to populate the
// env here, before the first `import "./config.ts"` anywhere in the suite.

export const TEST_PASSWORD = "correct horse battery";
export const TEST_TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // RFC test secret (base32)

// Force the test fixtures (=, not ||=) so the suite is deterministic even when a
// real .env exists in the repo (Bun auto-loads it). This only affects the test
// process — the .env file and the running app are untouched.
process.env.SERVERMIND_PASSWORD_HASH = await Bun.password.hash(TEST_PASSWORD, "argon2id");
process.env.SERVERMIND_TOTP_SECRET = TEST_TOTP_SECRET;
// A settings encryption key so the settings service never bootstraps one into .env during tests.
process.env.SETTINGS_KEY = "dGVzdC1rZXktMzItYnl0ZXMtMDAwMDAwMDAwMDAwMDA=";
// A fleet join token so the hub's auth path can be exercised in tests.
process.env.FLEET_JOIN_TOKEN = "test-join-token";

// Tests for the settings service: secret masking and schema validation.
// (Runs in CI where zod is installed; the reject paths never persist to disk.)

import { test, expect, describe } from "bun:test";
import { settingsForApi, updateSettings } from "./settings.ts";

describe("settings service", () => {
  test("settingsForApi never returns secrets in clear", () => {
    const s = settingsForApi();
    for (const v of [s.email.smtpPass, s.email.resendKey, s.ai.apiKey]) {
      expect(v === "" || v === "••••••••").toBe(true);
    }
  });

  test("rejects out-of-range disk threshold (schema validation, no persist)", async () => {
    const r = await updateSettings({ alerts: { diskPct: 999 } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("diskPct");
  });

  test("rejects an out-of-range daily report hour", async () => {
    const r = await updateSettings({ alerts: { digestHour: 50 } });
    expect(r.ok).toBe(false);
  });

  test("an unknown AI backend is ignored, store stays valid", async () => {
    await updateSettings({ ai: { backend: "hackend" } });
    expect(["openai", "claude-code"]).toContain(settingsForApi().ai.backend);
  });
});

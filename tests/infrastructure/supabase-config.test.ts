import { describe, expect, it } from "vitest";
import { readCloudConfiguration } from "../../src/infrastructure/supabase-config";

describe("Supabase public configuration", () => {
  it("keeps the existing local app when no cloud environment is supplied", () => {
    expect(readCloudConfiguration({})).toBeNull();
  });
  it("rejects partial settings and private keys instead of exposing an editable fallback", () => {
    expect(() =>
      readCloudConfiguration({
        VITE_SUPABASE_URL: "https://example.supabase.co",
      })
    ).toThrow();
    expect(() =>
      readCloudConfiguration({
        VITE_SUPABASE_URL: "https://example.supabase.co",
        VITE_SUPABASE_PUBLISHABLE_KEY: "sb_secret_private",
      })
    ).toThrow();
  });

  it("supports public keys and localhost while rejecting non-HTTPS remote URLs and embedded credentials", () => {
    expect(
      readCloudConfiguration({
        VITE_SUPABASE_URL: "http://127.0.0.1:54321",
        VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
      })
    ).toEqual({
      url: "http://127.0.0.1:54321",
      publicKey: "sb_publishable_example",
    });
    const anon = `header.${btoa(JSON.stringify({ role: "anon" }))}.signature`;
    expect(
      readCloudConfiguration({
        VITE_SUPABASE_URL: "https://example.supabase.co/",
        VITE_SUPABASE_PUBLISHABLE_KEY: anon,
      })?.publicKey
    ).toBe(anon);
    const privateKey = `header.${btoa(JSON.stringify({ role: "service_role" }))}.signature`;
    expect(() =>
      readCloudConfiguration({
        VITE_SUPABASE_URL: "https://example.supabase.co/",
        VITE_SUPABASE_PUBLISHABLE_KEY: privateKey,
      })
    ).toThrow("私密");
    for (const url of [
      "http://example.supabase.co",
      "https://user:password@example.supabase.co",
      "https://example.supabase.co/path",
      "https://example.supabase.co/?secret=x",
    ]) {
      expect(() =>
        readCloudConfiguration({
          VITE_SUPABASE_URL: url,
          VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
        })
      ).toThrow();
    }
  });
});

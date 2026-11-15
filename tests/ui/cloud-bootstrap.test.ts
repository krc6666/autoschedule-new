// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountConfiguredApplication } from "../../src/bootstrap";
import { settleLit } from "./lit-test-helpers";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  vi.unstubAllEnvs();
  window.location.hash = "";
  document.body.replaceChildren();
});

describe("configured app entry", () => {
  it("retains the original editable local application with no cloud settings", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "");
    const root = document.createElement("div");
    document.body.append(root);
    const mounted = await mountConfiguredApplication(root);
    dispose = mounted.dispose;
    await settleLit();
    expect(root.querySelector("autoschedule-app")).not.toBeNull();
    expect(root.textContent).toContain("本地工作台");
    expect(root.querySelector("autoschedule-cloud-panel")).toBeNull();
  });

  it("never falls back to a local editor for incomplete cloud config or an unconfigured public link", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "");
    const root = document.createElement("div");
    document.body.append(root);
    const invalid = await mountConfiguredApplication(root);
    invalid.dispose();
    expect(root.querySelector("autoschedule-app")).toBeNull();
    vi.stubEnv("VITE_SUPABASE_URL", "");
    window.location.hash = "schedule=00000000-0000-4000-8000-000000000099";
    const publicRoute = await mountConfiguredApplication(root);
    dispose = publicRoute.dispose;
    expect(root.textContent).toContain("尚未配置云端");
    expect(root.querySelector("autoschedule-app")).toBeNull();
  });
});

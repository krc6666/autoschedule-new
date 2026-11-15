// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountConfiguredApplication } from "../../src/bootstrap";
import { mountAutoscheduleApp } from "../../src/app";
import { createAutoscheduleStore } from "../../src/app/store/autoschedule-store";
import { cloudModel } from "../helpers/cloud";
import { settleLit } from "./lit-test-helpers";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  vi.unstubAllEnvs();
  window.location.hash = "";
  document.body.replaceChildren();
});

describe("configured app entry", () => {
  it("retains local unexported exit warnings and clears them only after local export", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const model = cloudModel();
    const store = createAutoscheduleStore({
      initialState: model,
      persistence: {
        load: () => model,
        save: (state) => ({ state, sizeBytes: 0, nearCapacity: false }),
        clear: () => {},
      },
    });
    dispose = mountAutoscheduleApp(root, { store }).dispose;
    const warns = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(warns()).toBe(false);
    store.getState().configuration.addStaff();
    expect(warns()).toBe(true);
    store.getState().markExported();
    expect(warns()).toBe(false);
    dispose();
    expect(warns()).toBe(false);
  });
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

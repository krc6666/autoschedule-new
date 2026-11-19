// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountAutoscheduleApp } from "../../src/app";
import { mountCloudApplication } from "../../src/app/cloud-application";
import type { AppState } from "../../src/model";
import type { UiCommand } from "../../src/ui/events/ui-command";
import type { AutoscheduleAppElement } from "../../src/ui/components/autoschedule-app";
import type {
  CloudCommand,
  CloudPanelElement,
} from "../../src/ui/components/cloud-panel";
import { createTestAutoscheduleStore } from "../helpers/application";
import { createDefaultState } from "../../src/defaults";
import { cloudFixture, MemoryCloudStorage } from "../helpers/cloud";
import { createBrowserCloudPersistence } from "../../src/infrastructure/cloud-recovery-store";
import { settleLit } from "./lit-test-helpers";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const warnsOnClose = () => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

async function mountLocal(model: AppState = createDefaultState()) {
  const root = document.createElement("div");
  document.body.append(root);
  const store = createTestAutoscheduleStore(model);
  const mounted = mountAutoscheduleApp(root, {
    store,
    shouldWarnOnExit: () => false,
  });
  dispose = mounted.dispose;
  await settleLit();
  const element =
    root.querySelector<AutoscheduleAppElement>("autoschedule-app")!;
  const command = async (command: UiCommand) => {
    await element.commandHandler.handle(command);
    await settleLit();
  };
  await command({ type: "navigate", section: "policy" });
  return { root, store, mounted, command };
}

describe("rules editing through the mounted entry", () => {
  it("keeps one draft across priority and general subpages for save and discard", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true)
    );
    const app = await mountLocal();
    const before = structuredClone(app.store.getState().model.settings);
    const switchTo = async (section: string) => {
      app.root
        .querySelector<HTMLButtonElement>(`[data-policy-section="${section}"]`)!
        .click();
      await settleLit();
    };
    await switchTo("priority");
    const toggle = app.root.querySelector<HTMLInputElement>(
      '[data-policy-setting="positionRotationEnabled"]'
    )!;
    toggle.checked = !before.positionRotationEnabled;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await settleLit();
    await switchTo("general");
    expect(app.mounted.hasUnsavedRules()).toBe(true);
    expect(app.store.getState().model.settings).toEqual(before);
    const hours = app.root.querySelector<HTMLInputElement>(
      '[data-policy-setting="maxDailyHours"]'
    )!;
    hours.value = "15";
    hours.dispatchEvent(new Event("input", { bubbles: true }));
    await settleLit();
    await switchTo("priority");
    expect(toggle.checked).toBe(!before.positionRotationEnabled);
    await app.command({ type: "save-policy" });
    expect(app.store.getState().model.settings).toMatchObject({
      positionRotationEnabled: !before.positionRotationEnabled,
      maxDailyHours: 15,
    });
    expect(app.mounted.hasUnsavedRules()).toBe(false);
    toggle.checked = before.positionRotationEnabled;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await settleLit();
    await switchTo("general");
    await app.command({ type: "discard-policy" });
    await switchTo("priority");
    expect(toggle.checked).toBe(!before.positionRotationEnabled);
    expect(app.mounted.hasUnsavedRules()).toBe(false);
  });

  it("captures unblurred scalar/text inputs, keeps raw list typing, and protects cancellation", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const app = await mountLocal();
    const before = structuredClone(app.store.getState().model);
    expect(warnsOnClose()).toBe(false);
    const input = app.root.querySelector<HTMLInputElement>(
      '[data-policy-setting="maxTodayFatigueDifference"]'
    )!;
    input.value = "8";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settleLit();
    const codes = app.root.querySelector<HTMLInputElement>(
      'input[aria-label="尽量避免只在这些航司内搭配"]'
    )!;
    codes.value = "KE,";
    codes.dispatchEvent(new Event("input", { bubbles: true }));
    await settleLit();
    expect(codes.value).toBe("KE,");
    expect(warnsOnClose()).toBe(true);
    expect(app.store.getState().model).toEqual(before);
    await app.command({ type: "navigate", section: "schedule" });
    expect(confirm).toHaveBeenCalledOnce();
    expect(app.root.querySelector("autoschedule-policy-page")).not.toBeNull();
    expect(input.value).toBe("8");
    expect(codes.value).toBe("KE,");
    codes.value = "KE, TR";
    codes.dispatchEvent(new Event("input", { bubbles: true }));
    await settleLit();
    const search = app.root.querySelector<HTMLInputElement>(
      'input[type="search"]'
    )!;
    search.value = "互斥";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await settleLit();
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await settleLit();
    expect(app.mounted.hasUnsavedRules()).toBe(true);
    app.root
      .querySelector<HTMLButtonElement>(".policy-save-bar .btn-primary")!
      .click();
    await settleLit();
    expect(app.store.getState().model.settings).toMatchObject({
      maxTodayFatigueDifference: 8,
    });
    expect(
      app.store.getState().model.settings.airlineMixPolicies[0]?.airlineCodes
    ).toEqual(["KE", "TR"]);
    expect(warnsOnClose()).toBe(false);
  });

  it("saves an unfinished supervisor editor with the whole page even after the card is closed", async () => {
    const model = createDefaultState();
    const flightNo = model.templates[0]!.flightNo;
    model.positionRules.push({
      ...model.positionRules[0]!,
      id: "editor-source",
      flightNo,
      name: "测试督导",
      category: "机动督导",
    });
    const target = model.positionRules.find(
      (rule) => rule.flightNo === flightNo && rule.category === "常规"
    )!;
    model.settings.mobileSupervisorFillRules = [];
    const app = await mountLocal(model);
    const card = app.root.querySelector<HTMLDetailsElement>(
      "[data-supervisor-fill]"
    )!;
    [...card.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("新增补位"))!
      .click();
    await settleLit();
    expect(app.mounted.hasUnsavedRules()).toBe(true);
    expect(warnsOnClose()).toBe(true);
    const change = async (label: string, value: string) => {
      const select = card.querySelector<HTMLSelectElement>(
        `select[aria-label="${label}"]`
      )!;
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await settleLit();
    };
    await change("航班", flightNo);
    await change("督导岗位", "测试督导");
    await change("补位岗位", target.name);
    await app.command({
      type: "edit-policy-input",
      input: { maxTodayFatigueDifference: 8 },
    });
    card.open = false;
    expect(
      app.store.getState().model.settings.mobileSupervisorFillRules
    ).toEqual([]);
    app.root
      .querySelector<HTMLButtonElement>(".policy-save-bar .btn-primary")!
      .click();
    await settleLit();
    expect(
      app.store.getState().model.settings.mobileSupervisorFillRules
    ).toEqual([
      expect.objectContaining({
        sourceFlightNo: flightNo,
        sourcePositionKeyword: "测试督导",
        targetPositionKeyword: target.name,
      }),
    ]);
    expect(app.store.getState().model.settings.maxTodayFatigueDifference).toBe(
      8
    );
    expect(app.mounted.hasUnsavedRules()).toBe(false);
    expect(card.querySelector('[aria-label="编辑督导补位关系"]')).toBeNull();
  });

  it("rejects incomplete supervisor selections without saving the other draft rules", async () => {
    const app = await mountLocal();
    const before = structuredClone(app.store.getState().model);
    await app.command({ type: "edit-supervisor-fill" });
    await app.command({
      type: "edit-policy-input",
      input: { maxTodayFatigueDifference: 8 },
    });
    await app.command({ type: "save-policy" });
    expect(app.store.getState().model).toEqual(before);
    expect(app.mounted.hasUnsavedRules()).toBe(true);
    expect(app.root.textContent).toContain("规则未保存");
    await app.command({ type: "cancel-supervisor-fill-editor" });
    expect(app.mounted.hasUnsavedRules()).toBe(true);
    await app.command({ type: "save-policy" });
    expect(app.store.getState().model.settings.maxTodayFatigueDifference).toBe(
      8
    );
    expect(app.mounted.hasUnsavedRules()).toBe(false);
  });
});

describe("rules drafts and the cloud shell", () => {
  it("refuses stale cloud saves, permits cancelled audit/logout, then saves the complete rules", async () => {
    const fixture = cloudFixture();
    const confirm = vi.fn(() => false);
    const alert = vi.fn();
    const root = document.createElement("div");
    document.body.append(root);
    const mounted = mountCloudApplication(
      root,
      fixture.backend,
      "policy-lifecycle",
      {
        persistence: (scope, id) =>
          createBrowserCloudPersistence(scope, id, new MemoryCloudStorage()),
        location: { href: "https://example.invalid/", hash: "" },
        confirm,
        alert,
      }
    );
    dispose = mounted.dispose;
    await settleLit();
    const element =
      root.querySelector<AutoscheduleAppElement>("autoschedule-app")!;
    const command = async (command: UiCommand) => {
      await element.commandHandler.handle(command);
      await settleLit();
    };
    const cloud = async (detail: CloudCommand) => {
      root
        .querySelector("autoschedule-cloud-panel")!
        .dispatchEvent(new CustomEvent("cloud-command", { detail }));
      for (let i = 0; i < 6; i++) {
        await Promise.resolve();
        await settleLit();
      }
    };
    await command({ type: "navigate", section: "policy" });
    await command({
      type: "edit-policy-input",
      input: { maxTodayFatigueDifference: 8 },
    });
    const panel = root.querySelector<CloudPanelElement>(
      "autoschedule-cloud-panel"
    )!;
    expect(panel.state.dirty).toBe(true);
    expect(warnsOnClose()).toBe(true);
    await cloud({ type: "save" });
    expect(fixture.backend.save).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith(expect.stringContaining("保存规则"));
    expect(panel.state.saveFeedback.phase).toBe("failed");
    await cloud({ type: "audit" });
    expect(root.querySelector("autoschedule-operation-audit")).toBeNull();
    expect(element.parentElement?.hidden).toBe(false);
    await cloud({ type: "logout" });
    expect(fixture.backend.signOut).not.toHaveBeenCalled();
    expect(element.view.policyEditing?.dirty).toBe(true);
    await command({ type: "save-policy" });
    expect(fixture.backend.save).not.toHaveBeenCalled();
    expect(warnsOnClose()).toBe(true);
    await cloud({ type: "save" });
    expect(fixture.backend.save).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        settings: expect.objectContaining({ maxTodayFatigueDifference: 8 }),
      }),
      expect.any(String)
    );
    expect(panel.state.saveFeedback.phase).toBe("saved");
    expect(warnsOnClose()).toBe(false);
    await command({
      type: "edit-policy-input",
      input: { maxTodayFatigueDifference: 9 },
    });
    confirm.mockReturnValue(true);
    await cloud({ type: "logout" });
    expect(fixture.backend.signOut).toHaveBeenCalledOnce();
    expect(root.querySelector("autoschedule-app")).toBeNull();
    expect(fixture.backend.save).toHaveBeenCalledOnce();
  });
});

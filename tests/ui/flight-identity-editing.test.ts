// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { mountAutoscheduleApp } from "../../src/app";
import { createDefaultState } from "../../src/defaults";
import { mountCloudApplication } from "../../src/app/cloud-application";
import { cloudFixture, MemoryCloudStorage } from "../helpers/cloud";
import { createBrowserCloudPersistence } from "../../src/infrastructure/cloud-recovery-store";
import type { AutoscheduleAppElement } from "../../src/ui/components/autoschedule-app";
import {
  createMemoryStatePersistence,
  createTestAutoscheduleStore,
} from "../helpers/application";
import { settleLit } from "./lit-test-helpers";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function mount(failSave = false) {
  const model = createDefaultState();
  model.shared.flightIdentities = [
    {
      id: "cx",
      displayName: "国泰",
      aliases: [{ flightNo: "CX937早" }, { flightNo: "CX937" }],
    },
  ];
  const persistence = createMemoryStatePersistence();
  if (failSave)
    persistence.save = () => {
      throw new Error("测试存储失败");
    };
  const store = createTestAutoscheduleStore(model, persistence);
  const root = document.createElement("div");
  document.body.append(root);
  const mounted = mountAutoscheduleApp(root, {
    store,
    shouldWarnOnExit: () => false,
  });
  dispose = mounted.dispose;
  await settleLit();
  const app = root.querySelector<AutoscheduleAppElement>("autoschedule-app")!;
  await app.commandHandler.handle({ type: "navigate", section: "config" });
  await settleLit();
  const edit = async (name: string) => {
    const field = root.querySelector<HTMLInputElement>(
      '[aria-label="航班档案统一名称"]'
    )!;
    field.value = name;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await settleLit();
  };
  const save = async () => {
    const button = [
      ...root.querySelectorAll<HTMLButtonElement>(
        "autoschedule-flight-identities button"
      ),
    ].find((b) => b.textContent?.includes("确认并保存"))!;
    button.click();
    await settleLit();
  };
  return { root, app, store, mounted, edit, save };
}

it("protects an unblurred directory draft on navigation, group switch and export", async () => {
  vi.stubGlobal(
    "confirm",
    vi.fn(() => false)
  );
  const x = await mount();
  await x.edit("国泰统一");
  expect(
    x.store.getState().model.shared.flightIdentities![0]!.displayName
  ).toBe("国泰");
  expect(x.mounted.hasUnsavedRules()).toBe(true);
  await x.app.commandHandler.handle({ type: "navigate", section: "policy" });
  expect(x.app.view.section).toBe("config");
  await x.app.commandHandler.handle({ type: "switch-group", groupId: "B" });
  expect(x.store.getState().model.activeGroupId).toBe("A");
  await x.app.commandHandler.handle({ type: "export-config" });
  expect(x.app.view.toast?.message).toContain("尚未保存");
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true)
  );
  await x.app.commandHandler.handle({ type: "navigate", section: "policy" });
  expect(x.mounted.hasUnsavedRules()).toBe(false);
  expect(
    x.store.getState().model.shared.flightIdentities![0]!.displayName
  ).toBe("国泰");
});

it("resets the saved preview so a second edit can be saved", async () => {
  const x = await mount();
  await x.edit("第一版");
  await x.save();
  expect(x.mounted.hasUnsavedRules()).toBe(false);
  await x.edit("第二版");
  await x.save();
  expect(
    x.store.getState().model.shared.flightIdentities![0]!.displayName
  ).toBe("第二版");
  expect(x.mounted.hasUnsavedRules()).toBe(false);
});

it("retains both formal state and editable draft when storage rejects a save", async () => {
  const x = await mount(true);
  await x.edit("存储失败草稿");
  await x.save();
  expect(
    x.store.getState().model.shared.flightIdentities![0]!.displayName
  ).toBe("国泰");
  expect(x.mounted.hasUnsavedRules()).toBe(true);
  expect(
    x.root.querySelector<HTMLInputElement>('[aria-label="航班档案统一名称"]')!
      .value
  ).toBe("存储失败草稿");
  expect(x.app.view.toast?.message).toContain("未保存");
});

it("cloud save, logout and exit protection also include the directory draft", async () => {
  vi.stubGlobal(
    "confirm",
    vi.fn(() => false)
  );
  const fixture = cloudFixture(),
    alert = vi.fn();
  const root = document.createElement("div");
  document.body.append(root);
  const cloud = mountCloudApplication(
    root,
    fixture.backend,
    "identity-lifecycle",
    {
      persistence: (scope, id) =>
        createBrowserCloudPersistence(scope, id, new MemoryCloudStorage()),
      location: { href: "https://example.invalid/", hash: "" },
      confirm: () => false,
      alert,
    }
  );
  dispose = cloud.dispose;
  await settleLit();
  const element =
    root.querySelector<AutoscheduleAppElement>("autoschedule-app")!;
  await element.commandHandler.handle({
    type: "edit-flight-identities",
    identities: [
      { id: "cx", displayName: "草稿", aliases: [{ flightNo: "CX937" }] },
    ],
  });
  await settleLit();
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  for (const type of ["save", "logout"] as const) {
    root
      .querySelector("autoschedule-cloud-panel")!
      .dispatchEvent(new CustomEvent("cloud-command", { detail: { type } }));
    for (let i = 0; i < 6; i++) {
      await Promise.resolve();
      await settleLit();
    }
  }
  expect(fixture.backend.save).not.toHaveBeenCalled();
  expect(fixture.backend.signOut).not.toHaveBeenCalled();
  expect(element.view.flightIdentityEditing?.dirty).toBe(true);
});

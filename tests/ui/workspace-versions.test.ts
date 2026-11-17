// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountCloudApplication } from "../../src/app/cloud-application";
import type { AutoscheduleAppElement } from "../../src/ui/components/autoschedule-app";
import type { MountedAutoscheduleApp } from "../../src/app";
import type { AutoscheduleStore } from "../../src/app/store/autoschedule-store";
import type { CloudPanelElement } from "../../src/ui/components/cloud-panel";
import { createBrowserCloudPersistence } from "../../src/infrastructure/cloud-recovery-store";
import { cloudFixture, cloudModel, MemoryCloudStorage } from "../helpers/cloud";
import { settleLit } from "./lit-test-helpers";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
});
async function settle() {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
    await settleLit();
  }
}
const entry = {
  id: "1",
  version: 1,
  createdAt: "2026-11-17T01:00:00Z",
  actor: "uploader@example.invalid",
};

function mount(running = false) {
  const fixture = cloudFixture();
  fixture.backend.listVersions.mockResolvedValue([entry]);
  const root = document.createElement("div");
  document.body.append(root);
  const confirm = vi.fn((_message?: string) => true);
  const rules = { dirty: false };
  let store!: AutoscheduleStore;
  const persistence = createBrowserCloudPersistence(
    "versions",
    "admin",
    new MemoryCloudStorage()
  );
  dispose = mountCloudApplication(root, fixture.backend, "versions", {
    persistence: () => persistence,
    confirm,
    alert: vi.fn(),
    mountEditor: (_root, options): MountedAutoscheduleApp => {
      store = options!.store!;
      return {
        dispose: vi.fn(),
        canTransferWorkspace: () => !running,
        hasUnsavedRules: () => rules.dirty,
        confirmLeaveRules: () => {
          if (rules.dirty && !confirm()) return false;
          rules.dirty = false;
          return true;
        },
      };
    },
  }).dispose;
  const click = async (action: string) => {
    const button = root.querySelector<HTMLButtonElement>(
      `[data-cloud-action="${action}"]`
    );
    expect(button, action).not.toBeNull();
    button!.click();
    await settle();
  };
  return {
    fixture,
    root,
    confirm,
    click,
    rules,
    persistence,
    getStore: () => store,
  };
}

describe("workspace version history through cloud entry", () => {
  it("uses the real editor to cancel rule departure, retain failed drafts, and replace the editor only on success", async () => {
    const fixture = cloudFixture();
    fixture.backend.listVersions.mockResolvedValue([entry]);
    const root = document.createElement("div");
    document.body.append(root);
    const confirm = vi.fn(() => false);
    dispose = mountCloudApplication(root, fixture.backend, "real-versions", {
      persistence: (scope, user) =>
        createBrowserCloudPersistence(scope, user, new MemoryCloudStorage()),
      confirm,
      alert: vi.fn(),
    }).dispose;
    await settle();
    const editor =
      root.querySelector<AutoscheduleAppElement>("autoschedule-app")!;
    await editor.commandHandler.handle({ type: "navigate", section: "policy" });
    await editor.commandHandler.handle({
      type: "edit-policy-input",
      input: { maxTodayFatigueDifference: 8 },
    });
    await settle();
    root
      .querySelector<HTMLButtonElement>('[data-cloud-action="versions"]')!
      .click();
    await settle();
    expect(root.querySelector("autoschedule-workspace-versions")).toBeNull();
    expect(editor.view.policyEditing?.dirty).toBe(true);
    // Confirm rule departure under the original rules contract, then browse without remounting.
    confirm.mockReturnValue(true);
    root
      .querySelector<HTMLButtonElement>('[data-cloud-action="versions"]')!
      .click();
    await settle();
    expect(root.querySelector("autoschedule-app")).toBe(editor);
    expect(editor.view.policyEditing?.dirty).toBe(false);
    fixture.backend.restoreVersion.mockRejectedValueOnce(new Error("网络失败"));
    root
      .querySelector<HTMLButtonElement>(
        '[data-cloud-action="version-restore-1"]'
      )!
      .click();
    await settle();
    expect(root.querySelector("autoschedule-app")).toBe(editor);
    expect(root.textContent).toContain("网络失败");
    const restored = cloudModel();
    restored.staff[0]!.name = restored.groups.A.staff[0]!.name = "恢复示例人员";
    fixture.backend.restoreVersion.mockResolvedValueOnce({
      version: 2,
      model: restored,
    });
    root
      .querySelector<HTMLButtonElement>(
        '[data-cloud-action="version-restore-1"]'
      )!
      .click();
    await settle();
    expect(root.querySelector("autoschedule-app")).not.toBe(editor);
    expect(root.querySelector("autoschedule-app")!.textContent).toContain(
      "云端工作台"
    );
    expect(
      root.querySelector<CloudPanelElement>("autoschedule-cloud-panel")!.state
        .dirty
    ).toBe(false);
  });

  it("renders hostile uploader labels as text", async () => {
    const app = mount();
    app.fixture.backend.listVersions.mockResolvedValue([
      { ...entry, actor: '<img src=x onerror="alert(1)">' },
    ]);
    await settle();
    await app.click("versions");
    const page = app.root.querySelector("autoschedule-workspace-versions")!;
    expect(page.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(page.querySelector("img,script")).toBeNull();
  });

  it("lists original uploader/time, preserves edits when browsing, and restores only after confirmation", async () => {
    const app = mount();
    await settle();
    app.getStore().getState().configuration.addStaff();
    const edited = structuredClone(app.getStore().getState().model);
    await app.click("versions");
    const page = app.root.querySelector("autoschedule-workspace-versions")!;
    expect(page.textContent).toContain(entry.actor);
    expect(page.querySelector("time")?.getAttribute("datetime")).toBe(
      entry.createdAt
    );
    expect(app.getStore().getState().model).toEqual(edited);
    app.confirm.mockReturnValueOnce(false);
    await app.click("version-restore-1");
    expect(app.fixture.backend.restoreVersion).not.toHaveBeenCalled();
    expect(app.getStore().getState().model).toEqual(edited);
    const restored = cloudModel();
    restored.staff[0]!.remark = restored.groups.A.staff[0]!.remark = "restored";
    app.fixture.backend.restoreVersion.mockResolvedValue({
      version: 2,
      model: restored,
    });
    await app.click("version-restore-1");
    expect(app.confirm.mock.calls[0]![0]).toContain("未上传");
    expect(app.fixture.backend.restoreVersion).toHaveBeenCalledWith(1, "1");
    expect(app.getStore().getState().model).toEqual(restored);
    expect(app.persistence.recovery.read()).toMatchObject({
      baseVersion: 2,
      unsaved: false,
    });
    const panel = app.root.querySelector<CloudPanelElement>(
      "autoschedule-cloud-panel"
    )!;
    expect(panel.state.version).toBe(2);
    expect(panel.state.dirty).toBe(false);
    expect(page.closest("div")!.hidden).toBe(true);
    expect(app.fixture.backend.publish).not.toHaveBeenCalled();
  });

  it("shows list failures with retry rather than empty history, and handles unknown pre-feature uploader", async () => {
    const app = mount();
    await settle();
    app.fixture.backend.listVersions.mockRejectedValueOnce(
      new Error("读取失败")
    );
    await app.click("versions");
    const page = app.root.querySelector("autoschedule-workspace-versions")!;
    expect(page.textContent).toContain("读取失败");
    expect(page.textContent).not.toContain("暂无历史版本");
    app.fixture.backend.listVersions.mockResolvedValue([
      { ...entry, actor: null },
    ]);
    await app.click("versions-refresh");
    expect(page.textContent).toContain("上传账号未知");
    expect(page.textContent).not.toContain("读取失败");
  });

  it("keeps editing state/cache/version on restore failure, including unsaved rules", async () => {
    const app = mount();
    await settle();
    await app.click("versions");
    app.getStore().getState().configuration.addStaff();
    app.getStore().getState().persist();
    app.rules.dirty = true;
    const before = structuredClone(app.getStore().getState().model);
    const cached = app.persistence.recovery.raw();
    app.fixture.backend.restoreVersion.mockRejectedValue(new Error("版本冲突"));
    await app.click("version-restore-1");
    expect(app.root.textContent).toContain("版本冲突");
    expect(app.getStore().getState().model).toEqual(before);
    expect(app.persistence.recovery.raw()).toBe(cached);
    expect(app.rules.dirty).toBe(true);
    expect(
      app.root.querySelector<CloudPanelElement>("autoschedule-cloud-panel")!
        .state.version
    ).toBe(1);
  });

  it("blocks entry when rule departure is cancelled and blocks restoration while calculating", async () => {
    const app = mount(true);
    await settle();
    app.rules.dirty = true;
    app.confirm.mockReturnValueOnce(false);
    await app.click("versions");
    expect(app.fixture.backend.listVersions).not.toHaveBeenCalled();
    app.rules.dirty = false;
    await app.click("versions");
    await app.click("version-restore-1");
    expect(app.fixture.backend.restoreVersion).not.toHaveBeenCalled();
    expect(app.root.textContent).toContain("请先结束排班计算");
  });

  it("ignores late history results and late restore receipts after session expiry", async () => {
    const app = mount();
    await settle();
    let complete!: (value: (typeof entry)[]) => void;
    app.fixture.backend.listVersions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    await app.click("versions");
    app.fixture.expire();
    await settle();
    complete([entry]);
    await settle();
    expect(
      app.root.querySelector("autoschedule-workspace-versions")
    ).toBeNull();
    expect(app.root.textContent).not.toContain(entry.actor);
  });

  it("disables repeated restoration and never updates the old editor after sign out", async () => {
    const app = mount();
    await settle();
    await app.click("versions");
    let complete!: (value: {
      version: number;
      model: ReturnType<typeof cloudModel>;
    }) => void;
    app.fixture.backend.restoreVersion.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const old = app.getStore();
    const before = structuredClone(old.getState().model);
    await app.click("version-restore-1");
    expect(
      app.root.querySelector("autoschedule-workspace-versions")!.textContent
    ).toContain("正在处理");
    expect(
      app.root.querySelector<HTMLButtonElement>(
        '[data-cloud-action="version-restore-1"]'
      )!.disabled
    ).toBe(true);
    app.fixture.expire();
    await settle();
    complete({ version: 2, model: cloudModel() });
    await settle();
    expect(old.getState().model).toEqual(before);
    expect(app.root.textContent).not.toContain("已恢复");
    expect(
      app.root.querySelector("autoschedule-workspace-versions")
    ).toBeNull();
  });
});

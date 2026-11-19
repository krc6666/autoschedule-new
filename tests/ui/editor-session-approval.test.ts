// @vitest-environment happy-dom
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountCloudApplication } from "../../src/app/cloud-application";
import {
  CloudError,
  type EditorLoginRequest,
} from "../../src/app/cloud-contract";
import type { MountedAutoscheduleApp } from "../../src/app";
import type { AutoscheduleStore } from "../../src/app/store/autoschedule-store";
import { createBrowserCloudPersistence } from "../../src/infrastructure/cloud-recovery-store";
import type {
  CloudCommand,
  CloudPanelElement,
} from "../../src/ui/components/cloud-panel";
import type { AutoscheduleAppElement } from "../../src/ui/components/autoschedule-app";
import { cloudFixture, MemoryCloudStorage } from "../helpers/cloud";
import { settleLit } from "./lit-test-helpers";

const incoming: EditorLoginRequest = {
  id: "request-from-device-b",
  status: "pending",
  expiresAt: "2026-11-18T12:00:00Z",
};
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
  sessionStorage.clear();
  document.body.replaceChildren();
});
async function settle() {
  for (let i = 0; i < 12; ++i) {
    await Promise.resolve();
    await settleLit();
  }
}
function mount(fixture = cloudFixture()) {
  const root = document.createElement("div");
  document.body.append(root);
  let store!: AutoscheduleStore;
  const flags = { rulesDirty: false, transfer: true };
  const input = document.createElement("input");
  input.value = "未提交的输入";
  const disposeEditor = vi.fn();
  const mountEditor = vi.fn((target, options): MountedAutoscheduleApp => {
    store = options.store;
    target.append(input);
    return {
      dispose: disposeEditor,
      hasUnsavedRules: () => flags.rulesDirty,
      canTransferWorkspace: () => flags.transfer,
      confirmLeaveRules: () => true,
    };
  });
  const storage = new MemoryCloudStorage();
  const app = mountCloudApplication(root, fixture.backend, "approval-test", {
    persistence: (scope, user) =>
      createBrowserCloudPersistence(scope, user, storage),
    mountEditor,
    alert: vi.fn(),
    confirm: () => true,
  });
  disposers.push(app.dispose);
  const panel = () =>
    root.querySelector<CloudPanelElement>("autoschedule-cloud-panel")!;
  const command = async (detail: CloudCommand) => {
    panel().dispatchEvent(new CustomEvent("cloud-command", { detail }));
    await settle();
  };
  return {
    root,
    panel,
    command,
    mountEditor,
    disposeEditor,
    input,
    flags,
    store: () => store,
    dispose: app.dispose,
  };
}

describe("login approval in the cloud application", () => {
  it("preserves real rules-page input and exit warnings when the user refuses login", async () => {
    const fixture = cloudFixture();
    fixture.backend.pollSessionRequest.mockResolvedValue(incoming);
    fixture.backend.decideSessionRequest.mockImplementation(async () => {
      fixture.backend.pollSessionRequest.mockResolvedValue(null);
    });
    const root = document.createElement("div");
    document.body.append(root);
    const app = mountCloudApplication(
      root,
      fixture.backend,
      "real-rules-approval",
      {
        persistence: (scope, id) =>
          createBrowserCloudPersistence(scope, id, new MemoryCloudStorage()),
        alert: vi.fn(),
        confirm: () => false,
      }
    );
    disposers.push(app.dispose);
    await settle();
    const editor =
      root.querySelector<AutoscheduleAppElement>("autoschedule-app")!;
    await editor.commandHandler.handle({ type: "navigate", section: "policy" });
    await settle();
    const input = root.querySelector<HTMLInputElement>(
      '[data-policy-setting="maxTodayFatigueDifference"]'
    )!;
    input.value = "8";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    root.querySelector("autoschedule-cloud-panel")!.dispatchEvent(
      new CustomEvent("cloud-command", {
        detail: { type: "decide-login", id: incoming.id, allow: true },
      })
    );
    await settle();
    expect(fixture.backend.decideSessionRequest).not.toHaveBeenCalled();
    root.querySelector("autoschedule-cloud-panel")!.dispatchEvent(
      new CustomEvent("cloud-command", {
        detail: { type: "decide-login", id: incoming.id, allow: false },
      })
    );
    await settle();
    expect(root.querySelector("autoschedule-app")).toBe(editor);
    expect(
      root.querySelector<HTMLInputElement>(
        '[data-policy-setting="maxTodayFatigueDifference"]'
      )!.value
    ).toBe("8");
    expect(editor.view.policyEditing?.dirty).toBe(true);
    const exit = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(exit);
    expect(exit.defaultPrevented).toBe(true);
    expect(fixture.backend.save).not.toHaveBeenCalled();
    writeFileSync(
      "docs/acceptance/evidence/2026-11-18-session-approval-original-device.json",
      JSON.stringify(
        {
          inputValue: "8",
          dirty: true,
          sameEditor: true,
          refused: true,
          exitWarning: exit.defaultPrevented,
          cloudSaves: fixture.backend.save.mock.calls.length,
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
  });
  it("rejects an applicant without saving, closing, or losing the current input", async () => {
    const fixture = cloudFixture();
    fixture.backend.pollSessionRequest.mockResolvedValue(incoming);
    fixture.backend.decideSessionRequest.mockImplementation(async () => {
      fixture.backend.pollSessionRequest.mockResolvedValue(null);
    });
    const a = mount(fixture);
    await settle();
    a.flags.rulesDirty = true;
    const before = JSON.stringify(a.store().getState().model);
    const reject = [...a.root.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "拒绝登录"
    )!;
    expect(reject).toBeTruthy();
    reject.click();
    await settle();
    expect(fixture.backend.decideSessionRequest).toHaveBeenCalledWith(
      expect.any(String),
      incoming.id,
      false
    );
    expect(a.input.isConnected).toBe(true);
    expect(a.input.value).toBe("未提交的输入");
    expect(a.disposeEditor).not.toHaveBeenCalled();
    expect(fixture.backend.save).not.toHaveBeenCalled();
    expect(fixture.backend.releaseSession).not.toHaveBeenCalled();
    expect(JSON.stringify(a.store().getState().model)).toBe(before);
    expect(a.root.textContent).toContain("已拒绝另一台设备登录");
    await a.command({ type: "decide-login", id: incoming.id, allow: true });
    expect(fixture.backend.decideSessionRequest).toHaveBeenCalledTimes(1);
  });

  it("saves dirty workspace data before approving, and then closes only this editor", async () => {
    const fixture = cloudFixture();
    fixture.backend.pollSessionRequest.mockResolvedValue(incoming);
    const a = mount(fixture);
    await settle();
    a.store().getState().configuration.addStaff();
    await a.command({ type: "decide-login", id: incoming.id, allow: true });
    expect(fixture.backend.save).toHaveBeenCalledOnce();
    expect(fixture.backend.decideSessionRequest).toHaveBeenCalledWith(
      expect.any(String),
      incoming.id,
      true
    );
    expect(fixture.backend.save.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.backend.decideSessionRequest.mock.invocationCallOrder[0]!
    );
    expect(a.disposeEditor).toHaveBeenCalledOnce();
    expect(fixture.backend.signOut).not.toHaveBeenCalled();
    expect(a.root.textContent).toContain("本设备已结束编辑");
  });

  it("keeps unsaved data and never approves when cloud saving fails", async () => {
    const fixture = cloudFixture();
    fixture.backend.pollSessionRequest.mockResolvedValue(incoming);
    fixture.backend.save.mockRejectedValueOnce(
      new CloudError("unavailable", "网络中断")
    );
    const a = mount(fixture);
    await settle();
    a.store().getState().configuration.addStaff();
    const before = JSON.stringify(a.store().getState().model);
    await a.command({ type: "decide-login", id: incoming.id, allow: true });
    expect(fixture.backend.decideSessionRequest).not.toHaveBeenCalled();
    expect(a.disposeEditor).not.toHaveBeenCalled();
    expect(a.input.value).toBe("未提交的输入");
    expect(JSON.stringify(a.store().getState().model)).toBe(before);
    expect(a.panel().state.saveFeedback.phase).toBe("failed");
    expect(a.root.textContent).toContain("当前修改保留");
    await a.command({ type: "decide-login", id: incoming.id, allow: false });
    expect(fixture.backend.decideSessionRequest).toHaveBeenCalledWith(
      expect.any(String),
      incoming.id,
      false
    );
  });

  it.each(["rules", "running"])(
    "blocks handoff for uncommitted %s but still permits rejection",
    async (kind) => {
      const fixture = cloudFixture();
      fixture.backend.pollSessionRequest.mockResolvedValue(incoming);
      const a = mount(fixture);
      await settle();
      a.flags.rulesDirty = kind === "rules";
      a.flags.transfer = kind !== "running";
      await a.command({ type: "decide-login", id: incoming.id, allow: true });
      expect(fixture.backend.save).not.toHaveBeenCalled();
      expect(fixture.backend.decideSessionRequest).not.toHaveBeenCalled();
      expect(a.input.isConnected).toBe(true);
      await a.command({ type: "decide-login", id: incoming.id, allow: false });
      expect(fixture.backend.decideSessionRequest).toHaveBeenCalledWith(
        expect.any(String),
        incoming.id,
        false
      );
    }
  );

  function applicant() {
    const fixture = cloudFixture();
    fixture.backend.acquireSession.mockRejectedValueOnce(
      new CloudError("session", "SESSION_ACTIVE")
    );
    let request: EditorLoginRequest;
    fixture.backend.requestSession.mockImplementation(
      async (_id, id) => (request = { ...incoming, id })
    );
    fixture.backend.pollSessionRequest.mockImplementation(async () => request);
    return {
      fixture,
      setStatus: (status: EditorLoginRequest["status"]) => {
        request = { ...request, status };
      },
    };
  }

  it.each(["rejected", "expired"] as const)(
    "reports %s to device B without reading or opening the workspace",
    async (status) => {
      vi.useFakeTimers();
      const peer = applicant();
      const b = mount(peer.fixture);
      await settle();
      expect(b.root.textContent).toContain("等待原设备确认");
      peer.setStatus(status);
      await vi.advanceTimersByTimeAsync(3000);
      await settle();
      expect(b.root.textContent).toContain(
        status === "rejected" ? "原设备已拒绝" : "申请已超时"
      );
      expect(b.mountEditor).not.toHaveBeenCalled();
      expect(peer.fixture.backend.load).not.toHaveBeenCalled();
      expect(peer.fixture.backend.acquireSession).toHaveBeenCalledTimes(1);
      if (status === "rejected")
        writeFileSync(
          "docs/acceptance/evidence/2026-11-18-session-approval-rejected.html",
          b.root.outerHTML,
          "utf8"
        );
    }
  );

  it("loads the latest workspace only after server approval", async () => {
    vi.useFakeTimers();
    const peer = applicant();
    const b = mount(peer.fixture);
    await settle();
    peer.setStatus("approved");
    await vi.advanceTimersByTimeAsync(3000);
    await settle();
    expect(b.mountEditor).toHaveBeenCalledOnce();
    expect(peer.fixture.backend.load).toHaveBeenCalledOnce();
    expect(peer.fixture.backend.acquireSession).toHaveBeenCalledTimes(2);
  });

  it("cancels waiting on logout and ignores a late approval response", async () => {
    vi.useFakeTimers();
    const peer = applicant();
    const b = mount(peer.fixture);
    await settle();
    let finish!: (request: EditorLoginRequest) => void;
    peer.fixture.backend.pollSessionRequest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await vi.advanceTimersByTimeAsync(3000);
    await b.command({ type: "logout" });
    expect(peer.fixture.backend.cancelSessionRequest).toHaveBeenCalledOnce();
    finish({ ...incoming, status: "approved" });
    await settle();
    expect(b.mountEditor).not.toHaveBeenCalled();
    expect(b.panel().state.phase).toBe("login");
  });

  it("preserves drafts on session loss, blocks writes, and resumes without remounting", async () => {
    vi.useFakeTimers();
    const fixture = cloudFixture();
    const a = mount(fixture);
    await settle();
    a.flags.rulesDirty = true;
    fixture.backend.touchSession.mockRejectedValueOnce(
      new CloudError("session", "SESSION_EXPIRED")
    );
    await vi.advanceTimersByTimeAsync(30000);
    await settle();
    expect(a.panel().state.sessionPaused).toBe(true);
    expect(a.input.isConnected).toBe(true);
    expect(a.input.value).toBe("未提交的输入");
    expect(a.disposeEditor).not.toHaveBeenCalled();
    await a.command({ type: "save" });
    expect(fixture.backend.save).not.toHaveBeenCalled();
    await a.command({ type: "resume-session" });
    expect(a.panel().state.sessionPaused).toBe(false);
    expect(a.mountEditor).toHaveBeenCalledTimes(1);
    expect(a.flags.rulesDirty).toBe(true);
  });
});

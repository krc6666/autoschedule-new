// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountCloudApplication } from "../../src/app/cloud-application";
import { CloudError } from "../../src/app/cloud-contract";
import { createBrowserCloudPersistence } from "../../src/infrastructure/cloud-recovery-store";
import {
  cloudFixture,
  cloudModel,
  publishableCloudModel,
  MemoryCloudStorage,
} from "../helpers/cloud";
import type {
  CloudCommand,
  CloudPanelElement,
} from "../../src/ui/components/cloud-panel";
import type { MountedAutoscheduleApp } from "../../src/app";
import { settleLit } from "./lit-test-helpers";
import type { AutoscheduleStore } from "../../src/app/store/autoschedule-store";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

async function settle() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await settleLit();
  }
}

describe("cloud entry controls and public view", () => {
  function mount(
    fixture = cloudFixture(),
    hash = "",
    running = false,
    storage = new MemoryCloudStorage()
  ) {
    const root = document.createElement("div");
    document.body.append(root);
    let store: AutoscheduleStore | undefined;
    const mountEditor = vi.fn((_root, options): MountedAutoscheduleApp => {
      store = options?.store;
      return {
        dispose: vi.fn(),
        canTransferWorkspace: () => !running,
        hasUnsavedRules: () => false,
        confirmLeaveRules: () => true,
      };
    });
    const download = vi.fn();
    const alert = vi.fn();
    const confirm = vi.fn((_message: string) => true);
    const app = mountCloudApplication(root, fixture.backend, "project", {
      persistence: (scope, user) =>
        createBrowserCloudPersistence(scope, user, storage),
      location: { hash, href: `https://example.invalid/autoschedule/${hash}` },
      mountEditor,
      confirm,
      alert,
      download,
      now: () => new Date(2026, 10, 15, 14, 30, 15).getTime(),
    });
    dispose = app.dispose;
    const command = async (detail: CloudCommand) => {
      root
        .querySelector("autoschedule-cloud-panel")!
        .dispatchEvent(
          new CustomEvent("cloud-command", { detail, bubbles: true })
        );
      await settle();
    };
    return {
      root,
      storage,
      mountEditor,
      command,
      download,
      alert,
      confirm,
      getStore: () => store!,
    };
  }

  it("does not mount editor before login and logs in through real form controls", async () => {
    const fixture = cloudFixture();
    fixture.setUser(null);
    const app = mount(fixture);
    await settle();
    expect(app.mountEditor).not.toHaveBeenCalled();
    const email = app.root.querySelector<HTMLInputElement>(
      'input[name="email"]'
    )!;
    email.value = "admin@example.invalid";
    app.root.querySelector<HTMLInputElement>('input[name="password"]')!.value =
      "test-password-not-a-secret";
    app.root
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(fixture.backend.signIn).toHaveBeenCalledWith(
      "admin@example.invalid",
      "test-password-not-a-secret"
    );
    expect(app.mountEditor).toHaveBeenCalledOnce();
    expect(app.root.textContent).toContain("已与云端同步");
    expect(app.root.querySelector("time")).toBeNull();
  });

  it("preserves the editor and its unsaved inputs when the heartbeat is rejected", async () => {
    vi.useFakeTimers();
    const fixture = cloudFixture();
    fixture.backend.touchSession.mockRejectedValueOnce(
      new CloudError("session", "账号已在其他地方登录")
    );
    const app = mount(fixture);
    await settle();
    expect(app.mountEditor).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(
      app.mountEditor.mock.results[0]!.value.dispose
    ).not.toHaveBeenCalled();
    const panel = app.root.querySelector<CloudPanelElement>(
      "autoschedule-cloud-panel"
    )!;
    expect(panel.state.phase).toBe("editor");
    expect(panel.state.sessionPaused).toBe(true);
    vi.useRealTimers();
  });

  it("requests permission after an active-session rejection without mounting an editor", async () => {
    const fixture = cloudFixture();
    fixture.backend.acquireSession.mockRejectedValueOnce(
      new CloudError("session", "此账号已在别处使用")
    );
    const app = mount(fixture);
    await settle();
    const panel = app.root.querySelector<CloudPanelElement>(
      "autoschedule-cloud-panel"
    )!;
    expect(panel.state.phase).toBe("error");
    expect(panel.state.sessionActive).toBe(true);
    expect(fixture.backend.requestSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String)
    );
    expect(app.mountEditor).not.toHaveBeenCalled();
    expect(app.root.textContent).toContain("等待原设备确认");
    expect(app.root.textContent).not.toContain("接管此账号");
  });

  it("leaves no password after failed login and returns an empty password input after logout", async () => {
    const fixture = cloudFixture();
    fixture.setUser(null);
    fixture.backend.signIn.mockRejectedValueOnce(
      new CloudError("unauthorized", "登录未成功")
    );
    const app = mount(fixture);
    await settle();
    const submit = () => {
      app.root.querySelector<HTMLInputElement>('input[name="email"]')!.value =
        "admin@example.invalid";
      app.root.querySelector<HTMLInputElement>(
        'input[name="password"]'
      )!.value = "synthetic-password";
      app.root
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true })
        );
    };
    submit();
    await settle();
    expect(app.mountEditor).not.toHaveBeenCalled();
    expect(app.root.textContent).toContain("登录未成功");
    expect(
      app.root.querySelector<HTMLInputElement>('input[name="password"]')!.value
    ).toBe("");
    submit();
    await settle();
    expect(app.mountEditor).toHaveBeenCalledOnce();
    await app.command({ type: "logout" });
    const password = app.root.querySelector<HTMLInputElement>(
      'input[name="password"]'
    )!;
    expect(password.value).toBe("");
    expect(password.getAttribute("autocomplete")).toBe("off");
    expect(fixture.backend.signOut).toHaveBeenCalledOnce();
  });

  it("actual save button uploads edited model and reports failure without marking it saved", async () => {
    const fixture = cloudFixture();
    const app = mount(fixture);
    await settle();
    app.getStore().getState().configuration.addStaff();
    app.getStore().getState().persist();
    await settle();
    expect(app.root.textContent).toContain("有修改未上传");
    fixture.backend.save.mockRejectedValueOnce(
      new CloudError("unavailable", "保存网络失败")
    );
    const save = [...app.root.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "保存到云端"
    )!;
    save.click();
    await settle();
    expect(app.root.textContent).toContain("保存失败，点击重试");
    expect(app.root.textContent).toContain("网络或服务暂不可用");
    expect(
      app.root.querySelector<CloudPanelElement>("autoschedule-cloud-panel")!
        .state.dirty
    ).toBe(true);
    expect(app.alert).toHaveBeenCalledOnce();
    expect(app.alert.mock.calls[0]![0]).toContain("云端保存失败");
    expect(app.alert.mock.calls[0]![0]).toContain("保存网络失败");
    expect(app.alert.mock.calls[0]![0]).not.toMatch(/副本|发布|导出/);
    const shouldWarn = app.mountEditor.mock.calls[0]![1].shouldWarnOnExit;
    app.getStore().getState().markExported();
    expect(shouldWarn()).toBe(true);
    app.root.querySelector<HTMLButtonElement>(".cloud-save-retry")!.click();
    await settle();
    expect(app.root.textContent).toContain("已保存 14:30:15");
    expect(
      app.root.querySelector<CloudPanelElement>("autoschedule-cloud-panel")!
        .state.version
    ).toBe(2);
    expect(fixture.backend.save).toHaveBeenCalledTimes(2);
    expect(app.alert).toHaveBeenCalledOnce();
    expect(shouldWarn()).toBe(false);
    expect(
      app.root.querySelector("[data-cloud-save-status]")!.textContent
    ).not.toMatch(/副本|发布|导出/);
    await app.command({ type: "download" });
    expect(app.download).toHaveBeenCalledOnce();
    expect(JSON.parse(app.download.mock.calls[0]![0]).model.staff.length).toBe(
      app.getStore().getState().model.staff.length
    );
  });

  it("prevents cloud transfer during compute or history edit", async () => {
    const fixture = cloudFixture();
    const app = mount(fixture, "", true);
    await settle();
    await app.command({ type: "save" });
    await app.command({ type: "publish" });
    expect(fixture.backend.save).not.toHaveBeenCalled();
    expect(fixture.backend.publish).not.toHaveBeenCalled();
    expect(app.root.textContent).toContain("先结束排班计算");
    expect(app.alert).toHaveBeenCalledOnce();
    expect(app.alert.mock.calls[0]![0]).toContain("云端保存失败");
  });

  it.each([
    ["unauthorized", "权限问题"],
    ["conflict", "版本冲突"],
    ["invalid", "数据校验未通过"],
  ] as const)(
    "classifies %s save errors and exposes a pending retry",
    async (kind, label) => {
      const fixture = cloudFixture();
      fixture.backend.save.mockRejectedValueOnce(
        new CloudError(kind, "服务端拒绝")
      );
      const app = mount(fixture);
      await settle();
      app.getStore().getState().configuration.addStaff();
      await app.command({ type: "save" });
      expect(app.root.textContent).toContain(label);
      expect(
        app.root.querySelector<HTMLElement>("[data-cloud-save-status]")!.title
      ).toBe("服务端拒绝");
      expect(
        app.root.querySelector<CloudPanelElement>("autoschedule-cloud-panel")!
          .state.version
      ).toBe(1);
      expect(app.mountEditor.mock.calls[0]![1].shouldWarnOnExit()).toBe(true);
      let finish!: (version: number) => void;
      fixture.backend.save.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
      app.root.querySelector<HTMLButtonElement>(".cloud-save-retry")!.click();
      await settle();
      expect(app.root.textContent).toContain("正在保存到云端...");
      expect(app.root.textContent).not.toContain("保存失败");
      finish(2);
      await settle();
      expect(app.root.textContent).toContain("已保存 14:30:15");
      expect(app.alert).toHaveBeenCalledOnce();
      app.getStore().getState().configuration.addStaff();
      await settle();
      expect(app.root.textContent).toContain("有修改未上传");
      expect(
        app.root.querySelector("[data-cloud-save-status]")!.textContent
      ).not.toContain("已保存");
    }
  );

  it.each(["expire", "dispose"] as const)(
    "does not restore a late save success after %s",
    async (ending) => {
      const fixture = cloudFixture();
      let finish!: (version: number) => void;
      fixture.backend.save.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
      const app = mount(fixture);
      await settle();
      await app.command({ type: "save" });
      if (ending === "expire") fixture.expire();
      else dispose?.();
      await settle();
      finish(2);
      await settle();
      expect(app.root.querySelector("time")).toBeNull();
      expect(app.root.querySelector("[data-cloud-save-status]")).toBeNull();
      expect(app.alert).not.toHaveBeenCalled();
    }
  );

  it("reminds about cloud saving before logout and keeps editing when cancelled", async () => {
    const fixture = cloudFixture();
    const app = mount(fixture);
    await settle();
    app.getStore().getState().configuration.addStaff();
    app.confirm.mockReturnValueOnce(false);
    await app.command({ type: "logout" });
    expect(app.confirm).toHaveBeenCalledOnce();
    expect(app.confirm.mock.calls[0]![0]).toContain("保存到云端");
    expect(app.confirm.mock.calls[0]![0]).not.toMatch(/副本|发布|导出/);
    expect(fixture.backend.signOut).not.toHaveBeenCalled();
    expect(app.root.textContent).toContain("有修改未上传");
    await app.command({ type: "save" });
    await app.command({ type: "logout" });
    expect(app.confirm).toHaveBeenCalledOnce();
    expect(fixture.backend.signOut).toHaveBeenCalledOnce();
  });

  it("warns throughout a pending save even when the model was already saved", async () => {
    const fixture = cloudFixture();
    let finish!: (version: number) => void;
    fixture.backend.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const app = mount(fixture);
    await settle();
    const shouldWarn = app.mountEditor.mock.calls[0]![1].shouldWarnOnExit;
    expect(shouldWarn()).toBe(false);
    await app.command({ type: "save" });
    expect(shouldWarn()).toBe(true);
    expect(app.root.textContent).toContain("正在保存到云端...");
    expect(
      app.root.querySelector<HTMLButtonElement>('[data-cloud-action="save"]')!
        .disabled
    ).toBe(true);
    expect(app.root.querySelector("time")).toBeNull();
    const logout = [...app.root.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "退出登录"
    )!;
    expect(logout.disabled).toBe(true);
    await app.command({ type: "logout" });
    expect(fixture.backend.signOut).not.toHaveBeenCalled();
    finish(2);
    await settle();
    expect(shouldWarn()).toBe(false);
    expect(app.root.textContent).toContain("已保存 14:30:15");
    expect(app.alert).not.toHaveBeenCalled();
  });

  it.each(["expire", "dispose"] as const)(
    "does not show late save failure after %s",
    async (ending) => {
      const fixture = cloudFixture();
      let reject!: (error: Error) => void;
      fixture.backend.save.mockImplementationOnce(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail;
          })
      );
      const app = mount(fixture);
      await settle();
      await app.command({ type: "save" });
      if (ending === "expire") fixture.expire();
      else dispose?.();
      await settle();
      reject(new Error("迟到的保存错误"));
      await settle();
      expect(app.alert).not.toHaveBeenCalled();
    }
  );

  it("keeps warning for edits made after the saved snapshot was captured", async () => {
    const fixture = cloudFixture();
    let finish!: (version: number) => void;
    fixture.backend.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const app = mount(fixture);
    await settle();
    await app.command({ type: "save" });
    app.getStore().getState().configuration.addStaff();
    finish(2);
    await settle();
    expect(app.mountEditor.mock.calls[0]![1].shouldWarnOnExit()).toBe(true);
    expect(app.root.textContent).toContain("有修改未上传");
    expect(app.alert).not.toHaveBeenCalled();
  });

  it("does not turn a local cache problem into a cloud save failure popup", async () => {
    const fixture = cloudFixture();
    const app = mount(fixture);
    await settle();
    vi.spyOn(app.storage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    app.getStore().getState().configuration.addStaff();
    await app.command({ type: "save" });
    expect(app.root.textContent).toContain("已保存 14:30:15");
    expect(
      app.root.querySelector("[data-cloud-save-status]")!.textContent
    ).not.toMatch(/副本|发布|导出/);
    expect(app.alert).not.toHaveBeenCalled();
    expect(app.mountEditor.mock.calls[0]![1].shouldWarnOnExit()).toBe(false);
  });

  it("keeps version conflict protection and requires explicit confirmation to use cloud contents", async () => {
    const fixture = cloudFixture();
    const storage = new MemoryCloudStorage();
    const key = "autoschedule.cloud.v1:project:admin:recovery";
    const original = JSON.stringify({
      baseVersion: 0,
      unsaved: true,
      model: cloudModel(),
    });
    storage.setItem(key, original);
    const app = mount(fixture, "", false, storage);
    await settle();
    const panel = app.root.querySelector("autoschedule-cloud-panel")!;
    expect(panel.textContent).toContain("云端版本已变化");
    expect(panel.querySelector<HTMLDetailsElement>("details")!.open).toBe(
      false
    );
    app.confirm.mockReturnValueOnce(false);
    await app.command({ type: "discard" });
    expect(storage.getItem(key)).toBe(original);
    expect(app.confirm.mock.calls[0]![0]).toContain("放弃");
    await app.command({ type: "discard" });
    expect(storage.getItem(key)).toBeNull();
    expect(fixture.backend.save).not.toHaveBeenCalled();
    expect(panel.textContent).not.toContain("云端版本已变化");
  });

  it("does not expose the editor on auth failure and permits signing out of a non-admin account", async () => {
    const fixture = cloudFixture();
    fixture.backend.load.mockRejectedValueOnce(new Error("没有管理员权限"));
    const app = mount(fixture);
    await settle();
    expect(app.mountEditor).not.toHaveBeenCalled();
    expect(app.root.textContent).toContain("没有管理员权限");
    await app.command({ type: "logout" });
    expect(fixture.backend.signOut).toHaveBeenCalled();
    expect(app.root.querySelector('input[type="password"]')).not.toBeNull();
  });

  it("uses only anonymous publication read and escapes names and remarks as text", async () => {
    const fixture = cloudFixture();
    fixture.publication.snapshot.rows = [
      {
        flightNo: "TEST100",
        position: "柜台",
        staffName: '<img src=x onerror="alert(1)">',
        startTime: "08:00",
        endTime: "10:00",
        remark: "<script>evil()</script>",
        status: "assigned",
      },
    ];
    const app = mount(fixture, `#schedule=${fixture.publication.token}`);
    await settle();
    expect(fixture.backend.readPublication).toHaveBeenCalledWith(
      fixture.publication.token
    );
    expect(fixture.backend.currentUser).not.toHaveBeenCalled();
    expect(fixture.backend.load).not.toHaveBeenCalled();
    expect(app.mountEditor).not.toHaveBeenCalled();
    expect(
      app.root.querySelector(
        "input,button,img,script,autoschedule-cloud-panel,autoschedule-app"
      )
    ).toBeNull();
    expect(app.root.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(app.root.textContent).not.toContain(cloudModel().staff[0]!.name);
  });

  it("rejects malformed public tokens without falling through to the editor", async () => {
    const fixture = cloudFixture();
    const app = mount(fixture, "#schedule=invalid");
    await settle();
    expect(app.root.textContent).toContain("查看链接不完整");
    expect(fixture.backend.readPublication).not.toHaveBeenCalled();
    expect(app.mountEditor).not.toHaveBeenCalled();
  });

  it("removes editor and stops accepting changes when the auth session ends", async () => {
    const fixture = cloudFixture();
    const app = mount(fixture);
    await settle();
    app.getStore().getState().configuration.addStaff();
    fixture.expire();
    await settle();
    expect(app.root.querySelector('input[type="password"]')).not.toBeNull();
    expect(app.root.textContent).toContain("登录已结束");
    await app.command({ type: "save" });
    expect(fixture.backend.save).not.toHaveBeenCalled();
  });

  it("only shows the save action outside collapsed more operations, including an empty workspace", async () => {
    const fixture = cloudFixture();
    fixture.backend.load.mockResolvedValueOnce({ version: 0, model: null });
    const app = mount(fixture);
    await settle();
    const panel = app.root.querySelector("autoschedule-cloud-panel")!;
    expect(
      [...panel.querySelectorAll("button")]
        .filter((button) => !button.closest("details"))
        .map((button) => button.textContent?.trim())
    ).toEqual(["保存到云端", "操作记录", "历史版本"]);
    const menu = panel.querySelector<HTMLDetailsElement>("details")!;
    expect(menu.open).toBe(false);
    expect(
      [...menu.querySelectorAll("button")].map((button) =>
        button.textContent?.trim()
      )
    ).toEqual(["发布当前组班表", "下载恢复副本", "导入恢复副本", "退出登录"]);
    expect(
      panel.querySelector<HTMLInputElement>('input[type="file"]')!.hidden
    ).toBe(true);
    expect(panel.textContent).toContain("有修改未上传");
  });

  it("keeps publication and its previous link within collapsed more operations after failure", async () => {
    const fixture = cloudFixture(publishableCloudModel());
    const app = mount(fixture);
    await settle();
    await app.command({ type: "publish" });
    const panel = app.root.querySelector<CloudPanelElement>(
      "autoschedule-cloud-panel"
    )!;
    const link = panel.state.shareUrl;
    expect(link).toBe(
      `https://example.invalid/autoschedule/#schedule=${fixture.publication.token}`
    );
    fixture.backend.publish.mockRejectedValueOnce(new Error("本次发布失败"));
    await app.command({ type: "publish" });
    expect(panel.state.shareUrl).toBe(link);
    expect(
      panel.querySelector<HTMLInputElement>("details input[readonly]")!.value
    ).toBe(link);
    expect(panel.querySelector<HTMLDetailsElement>("details")!.open).toBe(
      false
    );
    expect(app.root.textContent).toContain("本次发布失败");
  });

  it("does not expose a late publication response after session expiry", async () => {
    const fixture = cloudFixture(publishableCloudModel());
    let finish!: (value: typeof fixture.publication) => void;
    fixture.backend.publish.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const app = mount(fixture);
    await settle();
    const publishing = app.command({ type: "publish" });
    await settle();
    fixture.expire();
    await settle();
    finish(fixture.publication);
    await publishing;
    await settle();
    expect(app.root.querySelector("input[readonly]")).toBeNull();
    expect(
      app.root.querySelector<CloudPanelElement>("autoschedule-cloud-panel")!
        .state.shareUrl
    ).toBe("");
    expect(app.root.querySelector('input[type="password"]')).not.toBeNull();
    expect(app.root.textContent).not.toContain("已发布 A");
  });

  it("mounts the real editor and keeps its ordinary local save distinct from explicit cloud upload", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const fixture = cloudFixture();
    const storage = new MemoryCloudStorage();
    const app = mountCloudApplication(root, fixture.backend, "project", {
      persistence: (scope, user) =>
        createBrowserCloudPersistence(scope, user, storage),
      location: { hash: "", href: "https://example.invalid/autoschedule/" },
      confirm: () => true,
    });
    dispose = app.dispose;
    await settle();
    const editor = root.querySelector("autoschedule-app")!;
    expect(editor.textContent).toContain("云端工作台");
    editor.dispatchEvent(
      new CustomEvent("autoschedule-command", {
        bubbles: true,
        detail: { type: "navigate", section: "config" },
      })
    );
    await settle();
    const before = fixture.backend.save.mock.calls.length;
    const add = [...editor.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("新增人员")
    )!;
    expect(add).toBeDefined();
    add.click();
    await settle();
    expect(root.textContent).toContain("有修改未上传");
    expect(fixture.backend.save).toHaveBeenCalledTimes(before);
    const unsavedExit = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unsavedExit);
    expect(unsavedExit.defaultPrevented).toBe(true);
    [...root.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "保存到云端")!
      .click();
    await settle();
    expect(fixture.backend.save).toHaveBeenCalledOnce();
    expect(
      root.querySelector<CloudPanelElement>("autoschedule-cloud-panel")!.state
        .version
    ).toBe(2);
    expect(
      root.querySelector("[data-cloud-save-status]")!.textContent
    ).toContain("已保存");
    const savedExit = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(savedExit);
    expect(savedExit.defaultPrevented).toBe(false);
  });
});

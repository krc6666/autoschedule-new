// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CloudPanelElement,
  type CloudPanelState,
} from "../../src/ui/components/cloud-panel";
import { settleLit } from "./lit-test-helpers";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

async function panel(patch: Partial<CloudPanelState> = {}) {
  const element = new CloudPanelElement();
  element.state = {
    phase: "editor",
    busy: false,
    dirty: false,
    version: 3,
    conflict: false,
    canImport: false,
    cacheWarning: "",
    shareUrl: "",
    message: "",
    saveFeedback: { phase: "idle" },
    notice: null,
    ...patch,
  };
  document.body.append(element);
  await settleLit();
  return element;
}

describe("minimal cloud toolbar", () => {
  it("requests no password autofill and clears the submitted password before emitting login", async () => {
    const element = await panel({ phase: "login" });
    const form = element.querySelector("form")!;
    const email = form.querySelector<HTMLInputElement>('input[name="email"]')!;
    const password = form.querySelector<HTMLInputElement>(
      'input[name="password"]'
    )!;
    expect(form.getAttribute("autocomplete")).toBe("off");
    expect(password.getAttribute("autocomplete")).toBe("off");
    expect(password.type).toBe("password");
    expect(password.required).toBe(true);
    expect(password.value).toBe("");
    email.value = "admin@example.invalid";
    password.value = "synthetic-password";
    const handler = vi.fn((event: Event) => {
      expect(password.value).toBe("");
      expect((event as CustomEvent).detail).toEqual({
        type: "login",
        email: "admin@example.invalid",
        password: "synthetic-password",
      });
    });
    element.addEventListener("cloud-command", handler);
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );
    expect(handler).toHaveBeenCalledOnce();
    expect(password.getAttribute("value")).toBeNull();
  });

  it("keeps only save outside a closed native disclosure and removes instruction paragraphs", async () => {
    const element = await panel({
      message: "已读取云端数据，修改后请点击保存到云端。",
    });
    const menu = element.querySelector("details")!;
    expect(menu).not.toBeNull();
    expect(menu.open).toBe(false);
    expect(element.querySelector("summary")?.getAttribute("aria-label")).toBe(
      "更多操作"
    );
    expect(
      [...element.querySelectorAll("button")]
        .filter((button) => !button.closest("details"))
        .map((button) => button.textContent?.trim())
    ).toEqual(["保存到云端", "操作记录", "历史版本"]);
    expect(
      [...menu.querySelectorAll("button")].map((button) =>
        button.textContent?.trim()
      )
    ).toEqual(["发布当前组班表", "下载恢复副本", "导入恢复副本", "退出登录"]);
    expect(element.querySelector("p")).toBeNull();
    expect(element.textContent).not.toContain("已读取云端数据");
  });

  it("renders progress beside a disabled save button", async () => {
    const element = await panel({
      busy: true,
      saveFeedback: { phase: "saving" },
    });
    expect(
      element.querySelector("[data-cloud-save-status]")?.textContent
    ).toContain("正在保存到云端...");
    expect(
      element.querySelector<HTMLButtonElement>('[data-cloud-action="save"]')!
        .disabled
    ).toBe(true);
  });

  it("offers takeover when another editor owns the account session", async () => {
    const element = await panel({
      phase: "error",
      sessionActive: true,
      message: "此账号已在别处使用",
    });
    const handler = vi.fn();
    element.addEventListener("cloud-command", handler);
    const takeover = [...element.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("接管")
    );
    expect(takeover).toBeTruthy();
    takeover!.click();
    expect((handler.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      type: "takeover",
    });
  });

  it("shows the completion time for five seconds and retains the full tooltip afterward", async () => {
    vi.useFakeTimers();
    const at = new Date(2026, 10, 15, 14, 30, 15).getTime();
    const element = await panel({
      saveFeedback: { phase: "saved", savedAt: at },
    });
    const status = element.querySelector<HTMLElement>(
      "[data-cloud-save-status]"
    )!;
    expect(status.textContent).toContain("已保存 14:30:15");
    expect(status.title).toContain("14:30:15");
    await vi.advanceTimersByTimeAsync(5_000);
    await settleLit();
    expect(status.textContent).toContain("已保存");
    expect(status.textContent).not.toContain("14:30:15");
    expect(status.title).toContain("14:30:15");
    element.remove();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let a previous success hide newer edits", async () => {
    const element = await panel({
      dirty: true,
      saveFeedback: { phase: "saved", savedAt: Date.now() },
    });
    expect(
      element.querySelector("[data-cloud-save-status]")?.textContent
    ).toContain("有修改未上传");
  });

  it.each([
    ["unavailable", "网络或服务"],
    ["unauthorized", "权限"],
    ["conflict", "版本冲突"],
    ["invalid", "数据校验"],
    ["unknown", "原因待确认"],
  ] as const)(
    "shows %s failure and lets its retry control emit save",
    async (kind, reason) => {
      const element = await panel({
        dirty: true,
        saveFeedback: { phase: "failed", kind, message: "具体错误详情" },
      });
      const handler = vi.fn();
      element.addEventListener("cloud-command", handler);
      const status = element.querySelector<HTMLElement>(
        "[data-cloud-save-status]"
      )!;
      expect(status.textContent).toContain("保存失败，点击重试");
      expect(status.textContent).toContain(reason);
      expect(status.title).toContain("具体错误详情");
      status.querySelector("button")!.click();
      expect((handler.mock.calls[0]![0] as CustomEvent).detail).toEqual({
        type: "save",
      });
    }
  );

  it("closes on Escape, outside pointer and menu actions; emits the original commands", async () => {
    const element = await panel();
    const menu = element.querySelector("details")!;
    const handler = vi.fn();
    element.addEventListener("cloud-command", handler);
    menu.open = true;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(menu.open).toBe(false);
    menu.open = true;
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(menu.open).toBe(false);
    menu.open = true;
    element
      .querySelector<HTMLButtonElement>('[data-cloud-action="download"]')!
      .click();
    expect(menu.open).toBe(false);
    expect((handler.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      type: "download",
    });
    const file = new File(["{}"], "recovery.json", {
      type: "application/json",
    });
    const input =
      element.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect((handler.mock.calls[1]![0] as CustomEvent).detail).toEqual({
      type: "restore",
      file,
    });
  });
});

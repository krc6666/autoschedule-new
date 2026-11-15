// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountCloudApplication } from "../../src/app/cloud-application";
import { mountAutoscheduleApp } from "../../src/app";
import type { AutoscheduleStore } from "../../src/app/store/autoschedule-store";
import { createBrowserCloudPersistence } from "../../src/infrastructure/cloud-recovery-store";
import { cloudFixture, MemoryCloudStorage } from "../helpers/cloud";
import { settleLit } from "./lit-test-helpers";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
});
const entry = {
  id: "10",
  actor: "audit@example.invalid",
  occurredAt: "2026-11-15T10:00:00Z",
  version: 2,
  changeCount: 1,
};
const change = {
  index: 1,
  scope: "A",
  area: "assignments",
  key: "slot",
  operation: "update",
  before: {
    date: "2026-11-18",
    flightNo: "CX931",
    position: "G14",
    staffName: "示例甲",
  },
  after: {
    date: "2026-11-18",
    flightNo: "CX931",
    position: "G14",
    staffName: "示例乙",
  },
};
async function mount() {
  const fixture = cloudFixture();
  const listAudit = vi.fn(async (_cursor: string | null = null) => ({
    entries: [entry],
    nextCursor: null as string | null,
  }));
  const auditDetails = vi.fn(async (_id: string, _cursor = 0) => ({
    changes: [change],
    staffLabels: {},
    nextCursor: null as number | null,
  }));
  Object.assign(fixture.backend, { listAudit, auditDetails });
  const root = document.createElement("div");
  document.body.append(root);
  let store!: AutoscheduleStore;
  const app = mountCloudApplication(root, fixture.backend, "audit-test", {
    persistence: (scope, id) =>
      createBrowserCloudPersistence(scope, id, new MemoryCloudStorage()),
    location: { href: "https://example.invalid/", hash: "" },
    confirm: () => true,
    mountEditor: (target, options) => {
      store = options!.store!;
      return mountAutoscheduleApp(target, options);
    },
  });
  dispose = app.dispose;
  await settleLit();
  const click = async (action: string) => {
    const button = root.querySelector<HTMLButtonElement>(
      `[data-cloud-action="${action}"]`
    );
    expect(button, action).not.toBeNull();
    button!.click();
    await settleLit();
  };
  return { fixture, root, click, listAudit, auditDetails, store };
}

describe("independent operation records page", () => {
  it("opens a separate page, shows exact human-readable before/after and preserves the mounted editor", async () => {
    const app = await mount();
    const editor = app.root.querySelector("autoschedule-app")!;
    const originalCount = app.store.getState().model.staff.length;
    app.store.getState().configuration.addStaff();
    await app.click("audit");
    const page = app.root.querySelector("autoschedule-operation-audit")!;
    expect(page).not.toBeNull();
    expect(editor.parentElement!.hidden).toBe(true);
    expect(page.textContent).toContain("操作记录");
    expect(page.textContent).toContain("audit@example.invalid");
    await app.click("audit-expand-10");
    expect(page.textContent).toContain("CX931");
    expect(page.textContent).toContain("G14");
    expect(page.textContent).toContain("2026-11-18");
    expect(page.textContent).toContain("示例甲");
    expect(page.textContent).toContain("示例乙");
    expect(page.textContent).toContain("人员姓名");
    await app.click("workspace");
    expect(app.root.querySelector("autoschedule-app")).toBe(editor);
    expect(editor.parentElement!.hidden).toBe(false);
    expect(app.store.getState().model.staff.length).toBe(originalCount + 1);
    expect(app.fixture.backend.save).not.toHaveBeenCalled();
  });

  it("continues detail pages, preserves earlier rows after failure, and retries the same cursor", async () => {
    const app = await mount();
    app.auditDetails.mockResolvedValueOnce({
      changes: [change],
      staffLabels: {},
      nextCursor: 1,
    });
    await app.click("audit");
    await app.click("audit-expand-10");
    app.auditDetails.mockRejectedValueOnce(new Error("详情读取失败"));
    await app.click("audit-details-more-10");
    expect(app.root.textContent).toContain("示例甲");
    expect(app.root.textContent).toContain("详情读取失败");
    app.auditDetails.mockResolvedValueOnce({
      changes: [
        {
          ...change,
          index: 2,
          after: { ...change.after, staffName: "第二项示例" },
        },
      ],
      staffLabels: {},
      nextCursor: null,
    });
    await app.click("audit-details-more-10");
    expect(app.auditDetails).toHaveBeenLastCalledWith("10", 1);
    expect(app.root.textContent).toContain("示例甲");
    expect(app.root.textContent).toContain("第二项示例");
    expect(app.root.textContent).not.toContain("详情读取失败");
  });

  it("uses bounded paging, retry on read failure, and never reports a failed read as empty", async () => {
    const app = await mount();
    app.listAudit.mockRejectedValueOnce(new Error("暂时无法读取"));
    await app.click("audit");
    expect(app.root.textContent).toContain("暂时无法读取");
    expect(app.root.textContent).not.toContain("暂无操作记录");
    app.listAudit.mockResolvedValueOnce({ entries: [entry], nextCursor: "10" });
    await app.click("audit-refresh");
    app.listAudit.mockResolvedValueOnce({
      entries: [{ ...entry, id: "9" }],
      nextCursor: null,
    });
    await app.click("audit-more");
    expect(app.listAudit).toHaveBeenLastCalledWith("10");
  });

  it("clears records on session expiry and ignores a late response", async () => {
    const app = await mount();
    let finish!: (value: {
      entries: (typeof entry)[];
      nextCursor: null;
    }) => void;
    app.listAudit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await app.click("audit");
    app.fixture.expire();
    await settleLit();
    finish({ entries: [entry], nextCursor: null });
    await settleLit();
    expect(app.root.textContent).not.toContain(entry.actor);
    expect(app.root.querySelector("autoschedule-operation-audit")).toBeNull();
    expect(app.root.querySelector('input[type="password"]')).not.toBeNull();
  });

  it("renders hostile audit content as text and preserves empty/false/zero values", async () => {
    const app = await mount();
    const hostile = '<img src=x onerror="alert(1)">';
    app.auditDetails.mockResolvedValueOnce({
      changes: [
        {
          ...change,
          before: { ...change.before, staffName: hostile },
          after: { ...change.after, staffName: "" },
        },
      ],
      nextCursor: null,
      staffLabels: {},
    });
    await app.click("audit");
    await app.click("audit-expand-10");
    const page = app.root.querySelector("autoschedule-operation-audit")!;
    expect(page.textContent).toContain(hostile);
    expect(page.querySelector("img,script")).toBeNull();
    expect(page.textContent).toContain("（空）");
  });
});

// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { projectAuditChange } from "../../src/ui/projections/operation-audit-view";
import type {
  AuditChange,
  AuditStaffLabels,
} from "../../src/app/operation-audit-contract";
import "../../src/ui/components/operation-audit-page";
import {
  mountElement,
  settleLit,
  type LitTestElement,
} from "./lit-test-helpers";

const labels: AuditStaffLabels = {
  before: { A: { keep: "保留人员", old: "钱七", next: "赵六" } },
  after: { A: { keep: "保留人员", old: "钱七", next: "赵六" } },
};
function change(
  before: unknown,
  after: unknown,
  patch: Partial<AuditChange> = {}
): AuditChange {
  return {
    index: 1,
    scope: "A",
    area: "settings",
    key: "crossFlightPriorityPolicies",
    operation: "update",
    before,
    after,
    ...patch,
  };
}
const rules = [
  { id: "stable", enabled: true, flightNo: "UNTOUCHED", staffIds: ["keep"] },
  { id: "edit", enabled: true, flightNo: "AK151", staffIds: ["keep", "old"] },
];

describe("audit text contains only actual changes", () => {
  it("shows only membership differences inside one changed rule, preserving context and historical names", () => {
    const next = structuredClone(rules);
    next[1]!.staffIds = ["keep", "next"];
    const lines = projectAuditChange(change(rules, next), labels).lines;
    expect(lines).toEqual([
      "跨航班人员优先 / AK151 / 人员名单：新增赵六；移除钱七",
    ]);
    expect(lines.join()).not.toContain("保留人员");
    expect(lines.join()).not.toContain("启用");
    expect(lines.join()).not.toContain("UNTOUCHED");
  });

  it("combines occupant ID and name into one line while excluding unchanged dates, hours and remarks", () => {
    const before = {
      id: "slot",
      date: "2026-11-18",
      flightNo: "AK151",
      position: "G08",
      staffId: "old",
      staffName: "钱七",
      workHours: 2,
      remark: "不变备注",
    };
    const projection = projectAuditChange(
      change(
        before,
        { ...before, staffId: "next", staffName: "赵六" },
        { area: "assignments", key: "slot" }
      ),
      labels
    );
    expect(projection.title).toContain("2026-11-18 / AK151 / G08");
    expect(projection.lines).toEqual(["人员姓名：钱七 → 赵六"]);
  });

  it("compares nested leaves regardless of object property order and preserves false, zero, blank and missing", () => {
    const before = {
      stable: { a: 1, b: 2 },
      config: {
        enabled: true,
        fatiguePoints: 4,
        remark: "旧",
        unknownField: 1,
      },
    };
    const after = {
      stable: { b: 2, a: 1 },
      config: {
        enabled: false,
        fatiguePoints: 0,
        remark: "",
        unknownField: 2,
        extra: null,
      },
    };
    const lines = projectAuditChange(
      change(before, after, { key: "unknownSetting" }),
      {}
    ).lines;
    expect(lines).toContain("config / 启用：是 → 否");
    expect(lines).toContain("config / 疲劳点数：4 → 0");
    expect(lines).toContain("config / 备注：旧 → （空）");
    expect(lines).toContain("config / unknownField：1 → 2");
    expect(lines).toContain("config / extra：新增（空）");
    expect(lines.join()).not.toContain("stable");
    expect(
      projectAuditChange(change({ x: undefined }, { x: null }), {}).lines
    ).toEqual(["x：新增（空）"]);
  });

  it("handles rule additions, removals, order-only changes and keyed positions without listing unchanged rules", () => {
    const lines = projectAuditChange(
      change(rules, [
        rules[0],
        { id: "new", flightNo: "TR121", enabled: true, staffIds: ["next"] },
      ]),
      labels
    ).lines;
    expect(lines.join()).toContain("新增");
    expect(lines.join()).toContain("删除");
    expect(lines.join()).not.toContain("UNTOUCHED");
    expect(
      projectAuditChange(
        change(rules, [...rules].reverse()),
        labels
      ).lines.join()
    ).toContain("顺序");
    const before = [
      { flightNo: "TR121", position: "H02", movable: false },
      { flightNo: "TR121", position: "H03", movable: true },
    ];
    const after = [{ ...before[0], movable: true }, before[1]];
    expect(
      projectAuditChange(
        change(before, after, { key: "teamLeaderGapFillPositionPolicies" }),
        labels
      ).lines
    ).toEqual(["分队长补差保护 / TR121 / H02 / 允许调动：否 → 是"]);
  });

  it("retains unknown arrays, duplicate items and empty values without losing changes", () => {
    expect(
      projectAuditChange(change(["AK", "AK"], ["AK"]), {}).lines.join()
    ).toContain("移除AK");
    expect(
      projectAuditChange(change(["AK", "TR"], ["TR", "AK"]), {}).lines.join()
    ).toContain("顺序");
    expect(
      projectAuditChange(
        change([{ x: 1, same: "unchanged" }], [{ x: 2, same: "unchanged" }]),
        {}
      ).lines.join()
    ).toContain("x：1 → 2");
    expect(
      projectAuditChange(change({ a: [1, 2] }, { a: [1, 2] }), {}).lines
    ).toEqual([]);
  });

  it("keeps a large rule list compact when only one person changes", () => {
    const before = Array.from({ length: 500 }, (_, i) => ({
      id: `rule-${i}`,
      enabled: true,
      flightNo: `AK${i}`,
      staffIds: ["keep", "old"],
    }));
    const after = structuredClone(before);
    after[350]!.staffIds = ["keep", "next"];
    const snapshot = structuredClone({ before, after, labels });
    expect(projectAuditChange(change(before, after), labels).lines).toEqual([
      "跨航班人员优先 / AK350 / 人员名单：新增赵六；移除钱七",
    ]);
    expect({ before, after, labels }).toEqual(snapshot);
  });

  it("renders plain text lines instead of tables, keeps paging metadata and escapes hostile content", async () => {
    const next = structuredClone(rules);
    next[1]!.staffIds = ["keep", "next"];
    const changes = [
      change(rules, next),
      change(
        { remark: "旧" },
        { remark: '<img src=x onerror="alert(1)">' },
        { index: 2, area: "staff", key: "person" }
      ),
    ];
    const view = {
      loading: false,
      loaded: true,
      error: "",
      entries: [
        {
          id: "1",
          actor: "audit@example.invalid",
          occurredAt: "2026-11-17T10:00:00Z",
          version: 7,
          changeCount: 2,
        },
      ],
      nextCursor: null,
      details: {
        "1": {
          open: true,
          loading: false,
          error: "",
          data: { changes, staffLabels: labels, nextCursor: 2 },
        },
      },
    };
    const snapshot = structuredClone(view);
    const page = await mountElement<LitTestElement & { view: typeof view }>(
      "autoschedule-operation-audit",
      { view }
    );
    await settleLit();
    const details = page.querySelector(".operation-audit-details")!;
    expect(details.querySelector("table")).toBeNull();
    expect(
      [...details.querySelectorAll(".operation-audit-text li")].map((p) =>
        p.textContent!.trim()
      )
    ).toEqual([
      "2026/11/17 18:00：跨航班人员优先 / AK151 / 人员名单：新增赵六；移除钱七",
      '2026/11/17 18:00：备注：旧 → <img src=x onerror="alert(1)">',
    ]);
    expect(
      [...details.querySelectorAll(".operation-audit-text li time")].map(
        (time) => time.getAttribute("datetime")
      )
    ).toEqual(["2026-11-17T10:00:00Z", "2026-11-17T10:00:00Z"]);
    expect(details.querySelector("img,script")).toBeNull();
    expect(page.textContent).toContain("2 项变化");
    expect(
      page.querySelector('[data-cloud-action="audit-details-more-1"]')
    ).not.toBeNull();
    expect(view).toEqual(snapshot);
    if (process.env.AUDIT_TEXT_ARTIFACT === "1")
      writeFileSync(
        "docs/acceptance/evidence/2026-11-17-audit-text.html",
        page.outerHTML
      );
  });
});

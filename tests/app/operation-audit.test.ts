import { describe, expect, it, vi } from "vitest";
import { OperationAuditController } from "../../src/app/operation-audit-controller";
import {
  parseAuditDetails,
  parseAuditPage,
} from "../../src/infrastructure/operation-audit-response";
import {
  projectAuditChange,
  auditValue,
} from "../../src/ui/projections/operation-audit-view";

describe("audit query and display contract", () => {
  const entry = {
    id: "2",
    actor: "admin@example.invalid",
    occurredAt: "2026-11-15T10:00:00Z",
    version: 2,
    changeCount: 1,
  };
  it("resolves historical qualification names and preserves false, zero, blank and missing values", () => {
    const projection = projectAuditChange(
      {
        index: 1,
        scope: "A",
        area: "positionRules",
        key: "position",
        operation: "update",
        before: {
          flightNo: "CX931",
          name: "G14",
          qualifiedStaffIds: ["one"],
          fatiguePoints: 4,
          manual: true,
        },
        after: {
          flightNo: "CX931",
          name: "G14",
          qualifiedStaffIds: [],
          fatiguePoints: 0,
          manual: false,
        },
      },
      { before: { A: { one: "旧名字" } }, after: { A: { one: "新名字" } } }
    );
    expect(projection.title).toContain("CX931 / G14");
    expect(projection.fields).toContainEqual({
      label: "资质人员",
      before: "旧名字（one）",
      after: "（空列表）",
    });
    expect(projection.fields).toContainEqual({
      label: "疲劳点数",
      before: "4",
      after: "0",
    });
    expect(projection.fields).toContainEqual({
      label: "手动补位",
      before: "是",
      after: "否",
    });
    expect(auditValue(undefined)).toBe("（未设置）");
    expect(auditValue("")).toBe("（空）");
  });
  it("rejects malformed and non-advancing response cursors rather than looping pages", () => {
    expect(() =>
      parseAuditPage({ entries: [entry, entry], nextCursor: "2" })
    ).toThrow();
    expect(() =>
      parseAuditPage({ entries: [entry], nextCursor: "9" })
    ).toThrow();
    expect(() =>
      parseAuditPage({
        entries: [{ ...entry, occurredAt: "bad" }],
        nextCursor: null,
      })
    ).toThrow();
    expect(() =>
      parseAuditDetails({ changes: [], staffLabels: {}, nextCursor: 50 })
    ).toThrow();
    expect(() =>
      parseAuditDetails({
        changes: [],
        staffLabels: { before: { A: { one: 1 } } },
        nextCursor: null,
      })
    ).toThrow();
  });
  it("ignores late detail after a refresh and does not retain another session's query state", async () => {
    let finish!: (value: {
      changes: [];
      staffLabels: {};
      nextCursor: null;
    }) => void;
    const backend = {
      listAudit: vi.fn(async () => ({ entries: [entry], nextCursor: null })),
      auditDetails: vi.fn(
        () =>
          new Promise<{ changes: []; staffLabels: {}; nextCursor: null }>(
            (resolve) => {
              finish = resolve;
            }
          )
      ),
    };
    const controller = new OperationAuditController(backend);
    await controller.load();
    const pending = controller.expand("2");
    await controller.load();
    finish({ changes: [], staffLabels: {}, nextCursor: null });
    await pending;
    expect(controller.view.details).toEqual({});
    const onChange = vi.fn();
    controller.onChange = onChange;
    controller.dispose();
    await controller.load();
    expect(controller.view.entries).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
  });
});

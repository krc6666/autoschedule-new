import { describe, expect, it } from "vitest";
import { loadPreflightDrafts } from "../../src/infrastructure/preflight-draft-storage";
import type { PreflightDraft } from "../../src/app/preflight-drafts";

const draft: PreflightDraft = {
  groupId: "A",
  date: "2026-11-13",
  adminSupportEnabled: false,
  flights: [{ flightNo: "TEST1", selected: false, bookedPassengers: 0 }],
  staffStatuses: { anonymous: "leave:custom" },
  dutyRoster: {
    date: "2026-11-13",
    cxPreflightStaffId: null,
    dutyStaffId: null,
    standbyStaffIds: [null, null],
  },
};

describe("准备草稿存储边界", () => {
  it("原样恢复显式空值，组日重复取最后一份，坏记录不影响其他日期", () => {
    const next = { ...draft, date: "2026-11-15", dutyRoster: undefined };
    const last = { ...draft, adminSupportEnabled: true };
    expect(
      loadPreflightDrafts({
        getItem: () => JSON.stringify([draft, null, next, last]),
      })
    ).toEqual([last, next]);
  });

  it.each([
    { ...draft, groupId: "C" },
    { ...draft, date: "2026-02-30" },
    { ...draft, adminSupportEnabled: "false" },
    {
      ...draft,
      flights: [{ flightNo: "TEST1", selected: true, bookedPassengers: -1 }],
    },
    {
      ...draft,
      flights: [{ flightNo: "TEST1", selected: true, bookedPassengers: 1.5 }],
    },
    {
      ...draft,
      flights: [{ flightNo: "TEST1", selected: "false", bookedPassengers: 0 }],
    },
    { ...draft, flights: [...draft.flights, ...draft.flights] },
    { ...draft, staffStatuses: { anonymous: "unknown" } },
    { ...draft, staffStatuses: { anonymous: "leave:" } },
    { ...draft, dutyRoster: { ...draft.dutyRoster, date: "2026-11-15" } },
    { ...draft, dutyRoster: { ...draft.dutyRoster, standbyStaffIds: [null] } },
    { ...draft, dutyRoster: { ...draft.dutyRoster, dutyStaffId: 123 } },
  ])("拒绝损坏记录 %#，不作为已保存选择恢复", (bad) => {
    expect(
      loadPreflightDrafts({ getItem: () => JSON.stringify([bad]) })
    ).toEqual([]);
  });

  it("无法读取存储时使用原默认，不阻止启动", () => {
    expect(
      loadPreflightDrafts({
        getItem: () => {
          throw new Error("blocked");
        },
      })
    ).toEqual([]);
  });
});

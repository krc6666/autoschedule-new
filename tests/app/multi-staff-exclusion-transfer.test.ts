import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx-js-style";
import { createDefaultState } from "../../src/defaults";
import { updatePolicyEntityField } from "../../src/app/policy-actions";
import { applyWorkbookImport } from "../../src/app/workbook-actions";
import {
  buildConfigWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { saveState, loadState } from "../../src/infrastructure/storage";
import { createScheduleGenerationFacts } from "../../src/domain/shared/scheduling-facts";
import type {
  ScheduleWorkerRequest,
  ScheduleWorkerResponse,
} from "../../src/infrastructure/schedule-worker-protocol";
import { createTestAutoscheduleStore } from "../helpers/application";
import { diagnoseManualAssignmentEligibility } from "../../src/domain/candidates/assignment-eligibility";

it("preserves multi-person mutual exclusion through editing, Excel bytes, empty device, restart and real Worker", async () => {
  const source = createDefaultState();
  const members = source.staff.slice(0, 3).map((p) => p.id);
  source.settings.sameFlightStaffExclusions = [
    { id: "group", enabled: true, flightNo: "", staffIds: members.slice(0, 2) },
  ];
  expect(
    updatePolicyEntityField(
      source,
      "same-flight-staff-exclusion",
      "group",
      "staffIds",
      members.join(",")
    )
  ).toBe("saved");
  const bytes = XLSX.write(buildConfigWorkbook(source), {
    type: "buffer",
    bookType: "xlsx",
  });
  const parsed = parseWorkbook(XLSX.read(bytes, { type: "buffer" }), []);
  expect(parsed.warnings).toEqual([]);
  const empty = createDefaultState();
  empty.staff = [];
  empty.positionRules = [];
  empty.assignments = [];
  const otherGroup = structuredClone(empty.groups.B);
  expect(
    applyWorkbookImport(empty, parsed, "all", {
      restoreFlightConfiguration: true,
    }).errors
  ).toBeUndefined();
  expect(empty.groups.B).toEqual(otherGroup);
  let saved = "";
  saveState(empty, {
    setItem: (_key, value) => {
      saved = value;
    },
  });
  const state = loadState({ getItem: () => saved });
  expect(
    new Set(state.settings.sameFlightStaffExclusions[0]!.staffIds)
  ).toEqual(new Set(members));
  expect(state.settings.sameFlightStaffExclusions[0]!.enabled).toBe(true);

  // The transferred rule must control an actual schedule, including members B/C.
  state.staff = state.staff.filter((p) => members.includes(p.id));
  const flight = state.flights[0]!;
  state.flights = [flight];
  state.positionRules = [0, 1, 2].map((index) => ({
    id: `p-${index}`,
    flightNo: flight.flightNo,
    name: `G0${index + 1}`,
    category: "常规",
    qualifiedStaffIds: [members[index]!],
    manual: false,
    remark: "",
    fatiguePoints: 1,
    minPassengers: 0,
    earlyReleaseMinutes: 0,
  }));
  state.history = [];
  state.dutyRosterOverrides = [
    {
      date: "2026-11-18",
      cxPreflightStaffId: null,
      dutyStaffId: null,
      standbyStaffIds: [null, null],
    },
  ];
  state.settings.dailyPrimaryPositionUniqueEnabled = false;
  state.settings.lateShiftRecoveryEnabled = false;
  state.settings.positionRotationEnabled = false;
  const responses: ScheduleWorkerResponse[] = [];
  const host: {
    onmessage:
      ((event: MessageEvent<ScheduleWorkerRequest>) => Promise<void>) | null;
    postMessage: (message: ScheduleWorkerResponse) => void;
  } = {
    onmessage: null,
    postMessage: (message) => responses.push(structuredClone(message)),
  };
  vi.stubGlobal("self", host);
  try {
    await import("../../src/schedule.worker");
    await host.onmessage!(
      new MessageEvent<ScheduleWorkerRequest>("message", {
        data: {
          state: createScheduleGenerationFacts(state),
          date: "2026-11-18",
          preferences: { halfRestStaffIds: [] },
        },
      })
    );
    expect(responses.filter((r) => r.type === "error")).toEqual([]);
    const response = responses.find((r) => r.type === "result");
    if (response?.type !== "result")
      throw new Error("Worker did not return a schedule");
    const store = createTestAutoscheduleStore(state);
    store.getState().schedule.install("2026-11-18", response.result);
    const final = store.getState().model;
    const assigned = final.assignments.filter((a) => a.status === "assigned");
    expect(assigned).toHaveLength(1);
    const vacant = final.assignments.find((a) => a.status === "unfilled")!;
    const another = members.find((id) => id !== assigned[0]!.staffId)!;
    expect(
      diagnoseManualAssignmentEligibility(
        final,
        vacant.id,
        another
      ).violations.some((v) => v.code === "same-flight-staff-exclusion")
    ).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
}, 30_000);

it.each(["single", "duplicate", "unknown"])(
  "rejects invalid multi-person Excel groups atomically: %s",
  (kind) => {
    const state = createDefaultState();
    const ids = state.staff.slice(0, 3).map((p) => p.id);
    const book = XLSX.utils.book_new();
    const bad =
      kind === "single"
        ? ids[0]
        : kind === "duplicate"
          ? [ids[0], ids[0]].join(",")
          : [ids[0], "missing-member"].join(",");
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ["规则ID", "适用航班", "人员编号", "人员姓名", "启用"],
        ["good", "", ids.join(","), "", "是"],
        ["bad", "", bad, "", "是"],
      ]),
      "同航班人员互斥"
    );
    const parsed = parseWorkbook(book, state.staff);
    expect(parsed.settings?.sameFlightStaffExclusions).toBeUndefined();
    expect(parsed.warnings.some((w) => w.includes("同航班人员互斥第3行"))).toBe(
      true
    );
  }
);

it("ships the same multi-person columns in the downloadable workbook template", () => {
  const book = XLSX.read(
    readFileSync("public/template/排班工具配置模板.xlsx"),
    { type: "buffer" }
  );
  const rows = XLSX.utils.sheet_to_json<unknown[]>(
    book.Sheets["同航班人员互斥"]!,
    { header: 1 }
  );
  expect(rows[0]).toContain("人员编号");
  expect(rows[0]).toContain("启用");
  expect(rows[0]).not.toContain("人员A编号");
});

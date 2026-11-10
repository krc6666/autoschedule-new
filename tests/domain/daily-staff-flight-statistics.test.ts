import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../src/defaults";
import { buildDailyStaffFlightStatistics } from "../../src/domain/statistics/daily-staff-flight-statistics";
import type { Assignment, HistoryRecord } from "../../src/model";

function assignment(
  id: string,
  staffId: string,
  staffName: string,
  flightNo: string,
  position: string,
  startTime = "08:00"
): Assignment {
  return {
    id,
    flightId: `flight-${flightNo}`,
    flightNo,
    positionRuleId: null,
    position,
    staffId,
    staffName,
    startTime,
    endTime: "10:00",
    workHours: 2,
    fatiguePoints: 1,
    remark: "",
    manualRemark: "",
    status: "assigned",
  };
}

function historyRecord(
  id: string,
  date: string,
  staffId: string,
  staffName: string,
  flightNo: string,
  historyCoverage?: HistoryRecord["historyCoverage"]
): HistoryRecord {
  return {
    id,
    date,
    flightNo,
    position: "G01",
    staffId,
    staffName,
    startTime: "08:00",
    endTime: "10:00",
    workHours: 2,
    fatiguePoints: 1,
    remark: "",
    ...(historyCoverage ? { historyCoverage } : {}),
  };
}

describe("daily staff flight statistics", () => {
  it("counts each flight once per regular person and excludes administrative support", () => {
    const state = createDefaultState();
    const regular = state.staff.find((person) => person.staffType === "常规")!;
    const administrative = {
      ...regular,
      id: "administrative",
      name: "行政人员",
      staffType: "行政支援" as const,
    };
    state.staff = [regular, administrative];
    state.activeScheduleDate = "2026-09-13";
    state.assignments = [
      assignment("cx-g18", regular.id, regular.name, "CX931", "G18"),
      assignment("cx-g20", regular.id, regular.name, " cx931 ", "G20"),
      assignment("tr-h02", regular.id, regular.name, "TR121", "H02", "12:00"),
      assignment(
        "admin-cx",
        administrative.id,
        administrative.name,
        "CX931",
        "G01"
      ),
    ];

    const result = buildDailyStaffFlightStatistics(state, "2026-09-13");

    expect(result.source).toBe("current");
    expect(result.rows).toEqual([
      {
        staffId: regular.id,
        staffName: regular.name,
        flightNumbers: ["CX931", "TR121"],
        flightCount: 2,
      },
    ]);
    expect(result.allRows).toEqual([
      {
        staffId: regular.id,
        staffName: regular.name,
        flightNumbers: ["CX931", "TR121"],
        flightCount: 2,
      },
    ]);
    expect(result.totalFlightCount).toBe(2);
    expect(result.staffCount).toBe(1);
    expect(result.assignedStaffCount).toBe(1);
    expect(result.unassignedStaffCount).toBe(0);
    expect(result.unassignedStaffNames).toEqual([]);
  });

  it("counts KE166 supervisor, counter, guide, and zero-hour supervisor fill as one assignment-level flight", () => {
    const state = createDefaultState();
    const regular = state.staff.find((person) => person.staffType === "常规")!;
    state.staff = [regular];
    state.activeScheduleDate = "2026-09-13";
    state.assignments = [
      assignment("ke166-supervisor", regular.id, regular.name, "KE166", "督导"),
      assignment("ke166-counter", regular.id, regular.name, "KE166", "H04"),
      assignment("ke166-guide", regular.id, regular.name, "KE166", "柜台引导"),
      {
        ...assignment("ke166-fill", regular.id, regular.name, "KE166", "H05"),
        workHours: 0,
        supervisorSourceAssignmentId: "ke166-supervisor",
        supervisorFillRuleId: "fill-rule",
      },
    ];

    const result = buildDailyStaffFlightStatistics(state, "2026-09-13");

    expect(result.rows).toMatchObject([
      { staffId: regular.id, flightNumbers: ["KE166"], flightCount: 1 },
    ]);
    expect(result.totalFlightCount).toBe(1);
  });

  it("queries a complete archived workday without mixing in the current schedule", () => {
    const state = createDefaultState();
    const [first, second] = state.staff.filter(
      (person) => person.staffType === "常规"
    );
    state.staff = [first!, second!];
    state.activeScheduleDate = "2026-09-13";
    state.assignments = [
      assignment("current", first!.id, first!.name, "CURRENT1", "G01"),
    ];
    state.history = [
      historyRecord(
        "archived-1",
        "2026-09-11",
        second!.id,
        second!.name,
        "KE166",
        "complete"
      ),
      historyRecord(
        "archived-2",
        "2026-09-11",
        second!.id,
        second!.name,
        "KE166"
      ),
    ];

    const result = buildDailyStaffFlightStatistics(state, "2026-09-11");

    expect(result.source).toBe("history");
    expect(result.rows).toEqual([
      {
        staffId: second!.id,
        staffName: second!.name,
        flightNumbers: ["KE166"],
        flightCount: 1,
      },
    ]);
    expect(result.allRows).toEqual([
      {
        staffId: first!.id,
        staffName: first!.name,
        flightNumbers: [],
        flightCount: 0,
      },
      {
        staffId: second!.id,
        staffName: second!.name,
        flightNumbers: ["KE166"],
        flightCount: 1,
      },
    ]);
    expect(result.totalFlightCount).toBe(1);
    expect(result.staffCount).toBe(2);
    expect(result.assignedStaffCount).toBe(1);
    expect(result.unassignedStaffCount).toBe(1);
    expect(result.unassignedStaffNames).toEqual([first!.name]);
  });

  it.each(["current", "history"] as const)(
    "lists every regular person with their current leave label from %s without warning about leave",
    (source) => {
      const state = createDefaultState();
      const regular = state.staff.find(
        (person) => person.staffType === "常规"
      )!;
      const sick = {
        ...regular,
        id: "sick",
        name: "病假人员",
        status: "病假" as const,
      };
      const leave = {
        ...regular,
        id: "leave",
        name: "休假人员",
        status: "休假" as const,
      };
      const idle = { ...regular, id: "idle", name: "未安排人员" };
      state.leaveTypes = [
        { id: "flight-leave", name: "飞行假", enabled: true },
        { id: "old-leave", name: "旧假别", enabled: false },
      ];
      state.staff = [
        regular,
        idle,
        sick,
        leave,
        { ...leave, id: "custom", leaveTypeId: "flight-leave" },
        { ...leave, id: "disabled", leaveTypeId: "old-leave" },
        { ...leave, id: "missing", leaveTypeId: "missing" },
        { ...regular, id: "admin", staffType: "行政支援" },
      ];
      if (source === "current") {
        state.activeScheduleDate = "2026-09-13";
        state.assignments = [
          assignment("regular", regular.id, regular.name, "CX931", "G01"),
        ];
      } else {
        state.history = [
          historyRecord(
            "regular",
            "2026-09-13",
            regular.id,
            regular.name,
            "CX931",
            "complete"
          ),
        ];
      }
      const before = structuredClone(state);

      const result = buildDailyStaffFlightStatistics(state, "2026-09-13");

      expect(result.assignedStaffCount).toBe(1);
      expect(result.staffCount).toBe(7);
      expect(result.unassignedStaffCount).toBe(6);
      expect(result.unassignedStaffNames).toEqual([idle.name]);
      expect(result.allRows.map((row) => row.flightCount)).toEqual([
        1, 0, 0, 0, 0, 0, 0,
      ]);
      expect(result.allRows.map((row) => row.leaveLabel)).toEqual([
        undefined,
        undefined,
        "病假",
        "休假",
        "飞行假",
        "旧假别",
        "休假（类别缺失）",
      ]);
      expect(result.rows.map((row) => row.staffName)).toEqual([regular.name]);
      expect(result.totalFlightCount).toBe(1);
      expect(state).toEqual(before);
    }
  );

  it("keeps actual historical flights even when the person is currently on leave", () => {
    const state = createDefaultState();
    const person = state.staff.find((row) => row.staffType === "常规")!;
    state.staff = [{ ...person, status: "病假" }];
    state.history = [
      historyRecord(
        "one",
        "2026-09-11",
        person.id,
        person.name,
        "CX931",
        "complete"
      ),
      historyRecord(
        "duplicate",
        "2026-09-11",
        person.id,
        person.name,
        " cx931 "
      ),
    ];
    const result = buildDailyStaffFlightStatistics(state, "2026-09-11");
    expect(result.rows).toMatchObject([
      {
        staffId: person.id,
        flightCount: 1,
        flightNumbers: ["CX931"],
        leaveLabel: "病假",
      },
    ]);
    expect(result.staffCount).toBe(1);
    expect(result.assignedStaffCount).toBe(1);
    expect(result.totalFlightCount).toBe(1);
    expect(result.unassignedStaffCount).toBe(0);
    expect(result.unassignedStaffNames).toEqual([]);
  });

  it("does not present late-priority-only history as a complete daily result", () => {
    const state = createDefaultState();
    const regular = state.staff.find((person) => person.staffType === "常规")!;
    state.staff = [regular];
    state.history = [
      historyRecord(
        "partial",
        "2026-09-05",
        regular.id,
        regular.name,
        "TR121",
        "late-priority-only"
      ),
    ];

    const result = buildDailyStaffFlightStatistics(state, "2026-09-05");

    expect(result.source).toBe("partial-history");
    expect(result.rows).toEqual([]);
    expect(result.allRows).toEqual([]);
    expect(result.totalFlightCount).toBe(0);
    expect(result.assignedStaffCount).toBe(0);
    expect(result.unassignedStaffCount).toBe(0);
    expect(result.unassignedStaffNames).toEqual([]);
  });

  it("keeps every regular person when the entire current table is unassigned", () => {
    const state = createDefaultState();
    const regular = state.staff.find((person) => person.staffType === "常规")!;
    state.staff = [
      regular,
      { ...regular, id: "sick", status: "病假" },
      { ...regular, id: "leave", status: "休假" },
    ];
    state.activeScheduleDate = "2026-09-13";
    state.assignments = [
      {
        ...assignment("empty", "", "", "CX931", "G01"),
        staffId: null,
        status: "unfilled",
      },
    ];
    const result = buildDailyStaffFlightStatistics(state, "2026-09-13");
    expect(result.allRows.map((row) => row.staffId)).toEqual([
      regular.id,
      "sick",
      "leave",
    ]);
    expect(result.allRows.map((row) => row.flightCount)).toEqual([0, 0, 0]);
    expect(result.staffCount).toBe(3);
    expect(result.unassignedStaffCount).toBe(3);
    expect(result.unassignedStaffNames).toEqual([regular.name]);
    expect(result.assignedStaffCount).toBe(0);
    expect(result.totalFlightCount).toBe(0);
  });

  it("does not invent complete zero-flight facts when the workday has no records", () => {
    const state = createDefaultState();
    state.history = [];
    state.assignments = [];
    const result = buildDailyStaffFlightStatistics(state, "2026-09-13");
    expect(result.source).toBe("none");
    expect(result.allRows).toEqual([]);
    expect(result.unassignedStaffNames).toEqual([]);
  });
});

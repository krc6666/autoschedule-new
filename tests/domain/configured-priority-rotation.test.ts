import { describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx-js-style";
import type { Assignment, PositionRule } from "../../src/model";
import { createOrdinarySchedulingState } from "../helpers/scheduling-scenario";
import { defaultHighsSolver } from "../../src/infrastructure/solver/highs-solver";
import { isOrdinaryPriorityPosition } from "../../src/domain/reviews/position-rotation-policy";
import { reviewConsecutivePositionRotation } from "../../src/domain/reviews/position-rotation-review";
import { reviewSamePositionFrequency } from "../../src/domain/reviews/position-frequency-review";
import { refreshPositionRotationEvidence } from "../../src/domain/reviews/position-rotation-evidence";
import { reassignmentSafetyReasons } from "../../src/domain/reviews/rotation-review-safety";
import { createScheduleFrequencyFacts } from "../../src/domain/statistics/schedule-frequency";
import {
  buildConfigWorkbook,
  buildScheduleWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { updateConfigurationField } from "../../src/app/configuration-actions";
import { configuredFlightPositions } from "../../src/domain/flights/configured-flight-positions";
import { consecutivePositionAssignments } from "../../src/domain/statistics/schedule-frequency";
import { restorePersistedState } from "../../src/infrastructure/state-restoration";
import { createScheduleGenerationFacts } from "../../src/domain/shared/scheduling-facts";
import type {
  ScheduleWorkerRequest,
  ScheduleWorkerResponse,
} from "../../src/infrastructure/schedule-worker-protocol";
import { createTestAutoscheduleStore } from "../helpers/application";

const date = "2026-11-18";

function scenario(
  category: PositionRule["category"],
  flightNo = "KE160",
  linked = false
) {
  const state = createOrdinarySchedulingState();
  state.staff = state.staff
    .filter((p) => p.status === "正常")
    .slice(0, 2)
    .map((p, i) => ({
      ...p,
      id: `person-${i}`,
      name: `人员${i}`,
      dutyQualified: false,
      cxPreflightQualified: false,
    }));
  Object.assign(state.settings, {
    lateShiftRecoveryEnabled: false,
    highLoadProtectionEnabled: false,
    rollingLoadProtectionEnabled: false,
    workloadBalanceEnabled: false,
    positionTransitionPolicies: [],
    crossWorkdayQualificationReservations: [],
    airlineMixPolicies: [],
    positionRotationEnabled: true,
  });
  const flight = {
    id: "flight",
    flightNo,
    startTime: "09:50",
    endTime: "11:50",
    positions: [],
    remark: "",
    bookedPassengers: 100,
  };
  state.flights = [flight];
  state.positionRules = [
    {
      ...state.positionRules[0]!,
      id: "priority",
      flightNo,
      name: "督导",
      category,
      manual: false,
      earlyReleaseMinutes: 0,
      remark: "",
      fatiguePoints: 4,
      qualifiedStaffIds: state.staff.map((p) => p.id),
    },
    {
      ...state.positionRules[0]!,
      id: "ordinary",
      flightNo,
      name: "H03",
      category: "常规",
      manual: false,
      earlyReleaseMinutes: 0,
      remark: "",
      fatiguePoints: 2,
      qualifiedStaffIds: state.staff.map((p) => p.id),
    },
  ];
  state.settings.ordinaryPriorityPositions = [
    { airlineCode: flightNo.slice(0, 2), position: "督导" },
  ];
  state.history = [
    {
      id: "previous",
      date: "2026-11-16",
      flightNo: flightNo.slice(0, 2) + "999",
      position: "督导",
      staffId: state.staff[0]!.id,
      staffName: state.staff[0]!.name,
      startTime: "09:15",
      endTime: "11:15",
      workHours: 2,
      fatiguePoints: 4,
      remark: "",
    },
  ];
  const row = (rule: PositionRule, person = state.staff[0]!): Assignment => ({
    id: rule.id,
    flightId: flight.id,
    flightNo,
    positionRuleId: rule.id,
    position: rule.name,
    staffId: person.id,
    staffName: person.name,
    startTime: flight.startTime,
    endTime: flight.endTime,
    workHours: 2,
    fatiguePoints: rule.fatiguePoints,
    remark: "",
    manualRemark: "",
    status: "assigned",
  });
  const assignments = [
    row(state.positionRules[0]!),
    row(state.positionRules[1]!, state.staff[1]!),
  ];
  if (linked) {
    const counter: PositionRule = {
      ...state.positionRules[1]!,
      id: "linked",
      name: "H05",
    };
    state.positionRules.push(counter);
    state.settings.mobileSupervisorFillRules = [
      {
        id: "fill",
        enabled: true,
        sourceFlightNo: flightNo,
        sourcePositionKeyword: "督导",
        targetFlightNo: flightNo,
        targetPositionKeyword: "H05",
        allowAutomatic: true,
        allowManual: true,
      },
    ];
    assignments.push({
      ...row(counter),
      workHours: 0,
      fatiguePoints: 0,
      supervisorSourceAssignmentId: "priority",
      supervisorFillRuleId: "fill",
    });
  }
  state.assignments = assignments;
  return {
    state,
    assignments,
    primary: assignments[0]!,
    replacement: state.staff[1]!,
  };
}

describe("已配置普通重点的跨分类自动轮换", () => {
  it.each(["常规", "分流", "机动督导"] as const)(
    "%s 按航司和岗位命中，不绑定航班号",
    (category) => {
      const { state } = scenario(category);
      expect(
        isOrdinaryPriorityPosition(
          state.positionRules[0]!,
          state.settings.ordinaryPriorityPositions
        )
      ).toBe(true);
      expect(
        isOrdinaryPriorityPosition(
          { ...state.positionRules[0]!, flightNo: "KE777" },
          state.settings.ordinaryPriorityPositions
        )
      ).toBe(true);
      expect(
        isOrdinaryPriorityPosition(
          { ...state.positionRules[0]!, flightNo: "CX777" },
          state.settings.ordinaryPriorityPositions
        )
      ).toBe(false);
    }
  );

  it.each(["引导", "行政支援"] as const)(
    "%s 不因加入名单启用自动轮换",
    (category) => {
      const { state } = scenario(category);
      expect(
        isOrdinaryPriorityPosition(
          state.positionRules[0]!,
          state.settings.ordinaryPriorityPositions
        )
      ).toBe(false);
    }
  );

  it.each(["常规", "分流", "机动督导"] as const)(
    "%s 重点频率改给未承担者",
    async (category) => {
      const { state, assignments, primary, replacement } = scenario(category);
      await reviewSamePositionFrequency(
        defaultHighsSolver,
        state,
        assignments,
        date,
        new Set()
      );
      expect(primary.staffId).toBe(replacement.id);
      expect(
        primary.decisionTrace?.some(
          (d) => d.ruleId === "position-frequency-review"
        )
      ).toBe(true);
    }
  );

  it.each(["KE160", "MF8683"])(
    "%s 已配置机动督导与补位柜台整组解除连续",
    async (flightNo) => {
      const { state, assignments, primary, replacement } = scenario(
        "机动督导",
        flightNo,
        true
      );
      await reviewConsecutivePositionRotation(
        defaultHighsSolver,
        state,
        assignments,
        date,
        new Set(["linked"])
      );
      expect(primary.staffId).toBe(replacement.id);
      expect(assignments.find((a) => a.id === "linked")?.staffId).toBe(
        replacement.id
      );
      expect(assignments.find((a) => a.id === "linked")?.workHours).toBe(0);
      expect(assignments.every((a) => a.staffId)).toBe(true);
    }
  );

  it("机动重点兼任组也执行频率轮次公平", async () => {
    const { state, assignments, primary, replacement } = scenario(
      "机动督导",
      "KE160",
      true
    );
    await reviewSamePositionFrequency(
      defaultHighsSolver,
      state,
      assignments,
      date,
      new Set(["linked"])
    );
    expect(primary.staffId).toBe(replacement.id);
    expect(assignments.find((a) => a.id === "linked")?.staffId).toBe(
      replacement.id
    );
  });

  it("无整组资质替代时保留原合法安排并解释", async () => {
    const { state, assignments, primary } = scenario("机动督导", "KE160", true);
    state.positionRules.find((r) => r.id === "linked")!.qualifiedStaffIds = [
      state.staff[0]!.id,
    ];
    const before = assignments.map((a) => a.staffId);
    const warnings = await reviewConsecutivePositionRotation(
      defaultHighsSolver,
      state,
      assignments,
      date,
      new Set()
    );
    expect(assignments.map((a) => a.staffId)).toEqual(before);
    expect(warnings.join(" ")).toContain("资质");
    expect(primary.decisionTrace?.some((d) => d.outcome === "fallback")).toBe(
      true
    );
  });

  it("名单外非KE166机动督导与人工/值班锁定不自动换人", async () => {
    for (const kind of ["unconfigured", "manual", "duty"] as const) {
      const { state, assignments, primary } = scenario("机动督导");
      if (kind === "unconfigured")
        state.settings.ordinaryPriorityPositions = [];
      if (kind === "manual") state.positionRules[0]!.manual = true;
      if (kind === "duty")
        primary.decisionTrace = [
          {
            ruleId: "duty-position",
            stage: "reserved-assignment",
            outcome: "selected",
            message: "值班目标",
          },
        ];
      const original = primary.staffId;
      await reviewConsecutivePositionRotation(
        defaultHighsSolver,
        state,
        assignments,
        date,
        kind === "duty" ? new Set([primary.id]) : new Set()
      );
      expect(primary.staffId).toBe(original);
    }
  });

  it("人工之后仍按同源事实提示机动重点连续，不自动改人", () => {
    const { state, primary } = scenario("机动督导");
    refreshPositionRotationEvidence(state, date);
    expect(primary.staffId).toBe(state.staff[0]!.id);
    expect(
      primary.decisionTrace?.some(
        (d) => d.ruleId === "position-rotation" && d.outcome === "fallback"
      )
    ).toBe(true);
  });

  it.each(["consecutive", "frequency"] as const)(
    "%s 周边重点换人不能间接移动被锁定的督导组",
    async (review) => {
      const { state, assignments } = scenario("机动督导", "KE160", true);
      state.settings.ordinaryPriorityPositions.push({
        airlineCode: "KE",
        position: "H03",
      });
      state.history = state.history.map((h) => ({
        ...h,
        position: "H03",
        staffId: state.staff[1]!.id,
        staffName: state.staff[1]!.name,
      }));
      const before = assignments.map((a) => a.staffId);
      const locked = new Set(["priority", "linked"]);
      if (review === "consecutive")
        await reviewConsecutivePositionRotation(
          defaultHighsSolver,
          state,
          assignments,
          date,
          locked
        );
      else
        await reviewSamePositionFrequency(
          defaultHighsSolver,
          state,
          assignments,
          date,
          locked
        );
      expect(assignments.map((a) => a.staffId)).toEqual(before);
    }
  );

  it("先轮换合法结果，后置恢复尝试换回连续人员必须拒绝", async () => {
    const { state, assignments, primary, replacement } = scenario("机动督导");
    await reviewConsecutivePositionRotation(
      defaultHighsSolver,
      state,
      assignments,
      date,
      new Set()
    );
    expect(primary.staffId).toBe(replacement.id);
    const reasons = reassignmentSafetyReasons({
      kind: "plan",
      state,
      assignments,
      changes: [
        { assignmentId: primary.id, staffId: state.staff[0]!.id },
        { assignmentId: "ordinary", staffId: replacement.id },
      ],
      primaryAssignmentId: primary.id,
      date,
      frequencyFacts: createScheduleFrequencyFacts(state, date),
      intent: { kind: "late-shift-recovery-review" },
    });
    expect(reasons.join(" ")).toMatch(/连续|频率/);
  });

  it("模板同航司换号和时段联动，不重置重点配置与归档次数", () => {
    const { state } = scenario("机动督导");
    state.templates = [{ ...state.flights[0]!, id: "template" }];
    const originalHistory = structuredClone(state.history);
    expect(
      updateConfigurationField(
        state,
        "template",
        "template",
        "flightNo",
        "KE777"
      )
    ).toBe("updated");
    expect(state.positionRules.every((r) => r.flightNo === "KE777")).toBe(true);
    expect(state.flights[0]!.flightNo).toBe("KE777");
    expect(state.settings.ordinaryPriorityPositions).toEqual([
      { airlineCode: "KE", position: "督导" },
    ]);
    expect(
      consecutivePositionAssignments(
        state,
        state.staff[0]!.id,
        "KE777",
        "督导",
        "",
        date
      )
    ).toBe(1);
    expect(state.history).toEqual(originalHistory);
    expect(
      updateConfigurationField(
        state,
        "template",
        "template",
        "startTime",
        "10:00"
      )
    ).toBe("updated");
    expect(state.flights[0]!.startTime).toBe("10:00");
    expect(configuredFlightPositions(state.positionRules)("KE777")).toEqual([
      "督导",
      "H03",
    ]);
  });

  it("岗位显示以当前组岗位配置为准，跨航司不借用旧重点名单", () => {
    const { state } = scenario("机动督导");
    state.templates = [{ ...state.flights[0]!, id: "template" }];
    expect(
      isOrdinaryPriorityPosition(
        state.positionRules[0]!,
        state.settings.ordinaryPriorityPositions
      )
    ).toBe(true);
    expect(
      updateConfigurationField(state, "position", "ordinary", "name", "H04")
    ).toBe("updated");
    expect(configuredFlightPositions(state.positionRules)("KE160")).toEqual([
      "督导",
      "H04",
    ]);
    expect(
      updateConfigurationField(
        state,
        "template",
        "template",
        "flightNo",
        "CX777"
      )
    ).toBe("updated");
    expect(
      isOrdinaryPriorityPosition(
        state.positionRules[0]!,
        state.settings.ordinaryPriorityPositions
      )
    ).toBe(false);
    expect(state.settings.ordinaryPriorityPositions[0]!.airlineCode).toBe("KE");
  });

  it("集合与机动分类通过配置Excel和保存恢复保持同一轮换事实", () => {
    const { state } = scenario("机动督导");
    const workbook = XLSX.read(
      XLSX.write(buildConfigWorkbook(state), {
        type: "array",
        bookType: "xlsx",
      }),
      { type: "array" }
    );
    const imported = parseWorkbook(workbook, []);
    expect(imported.settings?.ordinaryPriorityPositions).toEqual(
      state.settings.ordinaryPriorityPositions
    );
    expect(
      imported.positionRules?.find((r) => r.name === "督导")?.category
    ).toBe("机动督导");
    state.groups[state.activeGroupId].settings = structuredClone(
      state.settings
    );
    state.groups[state.activeGroupId].positionRules = structuredClone(
      state.positionRules
    );
    state.groups[state.activeGroupId].staff = structuredClone(state.staff);
    state.groups[state.activeGroupId].flights = structuredClone(state.flights);
    state.groups[state.activeGroupId].history = structuredClone(state.history);
    const restored = restorePersistedState(
      JSON.parse(JSON.stringify(state)),
      state
    )!;
    expect(restored.settings.ordinaryPriorityPositions).toEqual(
      state.settings.ordinaryPriorityPositions
    );
    expect(
      isOrdinaryPriorityPosition(
        restored.positionRules[0]!,
        restored.settings.ordinaryPriorityPositions
      )
    ).toBe(true);
    expect(restored.groups.B.settings.ordinaryPriorityPositions).toEqual(
      state.groups.B.settings.ordinaryPriorityPositions
    );
  });

  it("真实Worker/WASM完成所有后置与Store安装，最终Excel仍由未连续者承担重点", async () => {
    const { state, replacement } = scenario("机动督导");
    state.assignments = [];
    state.settings.earlyDepartureBalanceEnabled = false;
    state.settings.afternoonRestBalanceEnabled = false;
    const messages: ScheduleWorkerResponse[] = [];
    const worker: {
      onmessage:
        ((event: MessageEvent<ScheduleWorkerRequest>) => Promise<void>) | null;
      postMessage: (message: ScheduleWorkerResponse) => void;
    } = {
      onmessage: null,
      postMessage: (m) => messages.push(structuredClone(m)),
    };
    vi.stubGlobal("self", worker);
    try {
      await import("../../src/schedule.worker");
      await worker.onmessage!(
        new MessageEvent<ScheduleWorkerRequest>("message", {
          data: {
            state: createScheduleGenerationFacts(state),
            date,
            preferences: { halfRestStaffIds: [], halfRestModes: {} },
          },
        })
      );
      expect(messages.filter((m) => m.type === "error")).toEqual([]);
      const final = messages.find((m) => m.type === "result");
      if (final?.type !== "result") throw new Error("未产生最终安全班表");
      expect(final.result.safetyCredential?.phase).toBe("final");
      expect(
        final.result.assignments.find((a) => a.position === "督导")?.staffId
      ).toBe(replacement.id);
      expect(final.result.unfilledCount).toBe(0);
      const store = createTestAutoscheduleStore(state);
      store.getState().schedule.install(date, final.result);
      const installed = store.getState().model;
      const bytes = XLSX.write(buildScheduleWorkbook(installed, date), {
        type: "array",
        bookType: "xlsx",
      });
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
        XLSX.read(bytes, { type: "array" }).Sheets["排班结果"]!
      );
      const supervisorRow = rows.find((row) =>
        Object.values(row).includes("督导")
      );
      expect(Object.values(supervisorRow ?? {})).toContain(replacement.name);
      expect(rows).toHaveLength(2);
      if (process.env.AUTOSCHEDULE_PRIORITY_EVIDENCE) {
        const destination = process.env.AUTOSCHEDULE_PRIORITY_EVIDENCE;
        writeFileSync(
          join(destination, "2026-11-16-priority-final.xlsx"),
          Buffer.from(bytes)
        );
        const finalSupervisor = final.result.assignments.find(
          (a) => a.position === "督导"
        )!;
        const previous = state.history.filter(
          (h) =>
            h.position === "督导" &&
            h.flightNo.startsWith("KE") &&
            h.date < date
        );
        expect(previous.map((h) => h.staffId)).not.toContain(
          finalSupervisor.staffId
        );
        const counts = state.staff.map((p) => ({
          staffId: p.id,
          before: previous.filter((h) => h.staffId === p.id).length,
          after:
            previous.filter((h) => h.staffId === p.id).length +
            Number(finalSupervisor.staffId === p.id),
        }));
        expect(counts.map((c) => c.after)).toEqual([1, 1]);
        writeFileSync(
          join(destination, "2026-11-16-priority-final.json"),
          JSON.stringify(
            {
              date,
              flightNo: "KE160",
              previousFlightNo: "KE999",
              previousWorkday: "2026-11-16",
              category: "机动督导",
              priority: state.settings.ordinaryPriorityPositions,
              counts,
              finalAssignments: final.result.assignments,
              exportedRows: rows,
              unfilledCount: final.result.unfilledCount,
              credentialPhase: final.result.safetyCredential?.phase,
            },
            null,
            2
          ) + "\n"
        );
      }
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);
});

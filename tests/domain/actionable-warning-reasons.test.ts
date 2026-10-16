import { describe, expect, it } from "vitest";
import { warningScenario } from "../helpers/actionable-warning-scenario";
import { generateSchedule } from "../helpers/generate-schedule";
import { diagnoseManualAssignmentEligibility } from "../../src/domain/candidates/assignment-eligibility";
import {
  conciseAssignmentWarningReason,
  plainSwapAnalysisReason,
} from "../../src/domain/reviews/schedule-warning-message";
import { buildHistoricalScheduleDraft } from "../../src/app/history-actions";
import { refreshVacancyDiagnostics } from "../../src/domain/reviews/vacancy-diagnostics";
import { createScheduleRunFacts } from "../../src/domain/shared/schedule-run-facts";
import { prepareSchedule } from "../../src/domain/kernel/schedule-preparation";
import { evaluateAutomaticHardConstraints } from "../../src/domain/rules/built-in-rule-registry";
import { buildScheduleFeedback } from "../../src/domain/feedback/schedule-feedback";
import { rotationCycleReason } from "../../src/domain/reviews/rotation-review-safety";
import { isManualOverrideSafetyReason } from "../../src/domain/candidates/manual-assignment-override";

describe("actionable warning evidence", () => {
  it("keeps real rule names, thresholds and every recorded reason", () => {
    const reasons = [
      "人员甲在KE166/H03 09:15–11:15已有排班，时间冲突",
      "严格跨工作日恢复：10月15日TR121/H02至23:55",
      "岗位衔接间隔90分钟，要求180分钟",
    ];
    const message = conciseAssignmentWarningReason(reasons);
    reasons.forEach((reason) => expect(message).toContain(reason));
    expect(plainSwapAnalysisReason(reasons[2]!)).toContain("90分钟");
    expect(conciseAssignmentWarningReason([])).toContain("原因未记录");
  });

  it("reports the final mixed recovery and priority blockers without changing assignments", async () => {
    const state = warningScenario();
    const result = await generateSchedule(state, "2026-10-17");
    const cx = result.assignments.find((a) => a.position === "G18")!;
    expect(cx.status).toBe("unfilled");
    expect(
      result.assignments.find((a) => a.flightNo === "KE166")?.staffId
    ).toBe("p1");
    const explanation = cx.systemNotes?.join("\n") ?? "";
    expect(explanation).toContain("严格跨工作日恢复 3 人");
    expect(explanation).toContain("跨航班优先 1 人");
    expect(explanation).toContain("2026-10-15 TR121/H02");
    expect(explanation).toContain("23:55");
    expect(explanation).toContain("KE166");
    expect(explanation).not.toMatch(/因抽调至|时段冲突 4 人|没有其他安全人选/);
    expect(result.warnings.join("\n")).toContain("严格跨工作日恢复 3 人");
  });

  it("names the actual conflicting assignment in manual warnings and retains warning codes", () => {
    const state = warningScenario();
    state.assignments = state.flights.map((f, i) => ({
      id: `a${i}`,
      flightId: f.id,
      flightNo: f.flightNo,
      positionRuleId: state.positionRules[i]!.id,
      position: state.positionRules[i]!.name,
      staffId: i ? "p1" : null,
      staffName: i ? "人员1" : "",
      startTime: f.startTime,
      endTime: f.endTime,
      workHours: 2,
      fatiguePoints: 1,
      remark: "",
      manualRemark: "",
      status: i ? ("assigned" as const) : ("unfilled" as const),
    }));
    const warning = diagnoseManualAssignmentEligibility(
      state,
      "a0",
      "p1"
    ).violations.find((v) => v.code === "time-conflict")!;
    expect(warning.message).toContain("KE166/H03");
    expect(warning.message).toContain("09:15");
    expect(warning.message).toContain("11:15");
    state.settings.maxDailyHours = 3;
    const hours = diagnoseManualAssignmentEligibility(
      state,
      "a0",
      "p1"
    ).violations.find((v) => v.code === "daily-hours")!;
    expect(hours.message).toContain("安排后 4 小时");
    expect(hours.message).toContain("上限 3 小时");
  });

  it("removes an old vacancy explanation after filling and does not guess priority from configuration alone", async () => {
    const state = warningScenario();
    const result = await generateSchedule(state, "2026-10-17");
    const preparation = prepareSchedule(
      state,
      "2026-10-17",
      evaluateAutomaticHardConstraints
    );
    const cx = result.assignments.find((a) => a.position === "G18")!;
    const facts = createScheduleRunFacts(state, "2026-10-17");
    refreshVacancyDiagnostics(
      state,
      result.assignments,
      preparation.tasks,
      facts
    );
    expect(cx.systemNotes?.join("\n")).not.toContain("跨航班优先规则先保留");
    Object.assign(cx, {
      status: "assigned",
      staffId: "p5",
      staffName: "人员5",
    });
    refreshVacancyDiagnostics(
      state,
      result.assignments,
      preparation.tasks,
      facts
    );
    expect(cx.systemNotes).toBeUndefined();
  });

  it("keeps recorded vacancy stage evidence and unrelated notes when refreshing", async () => {
    const state = warningScenario();
    const result = await generateSchedule(state, "2026-10-17");
    const preparation = prepareSchedule(
      state,
      "2026-10-17",
      evaluateAutomaticHardConstraints
    );
    const cx = result.assignments.find((a) => a.position === "G18")!;
    cx.vacancyEvidence = {
      reason: "daily-flight-count-balance",
      blockers: ["候选人员航班数差值超过1"],
    };
    cx.systemNotes = ["这一轮督导换人未采用：另一固定一号岗位不能移动"];
    preparation.tasks.find(
      (t) => t.rule.id === cx.positionRuleId
    )!.rule.category = "机动督导";
    cx.systemNotes.push(
      "人员2不能调到督导：TR121/H02 21:55–23:55与该岗位冲突，换人计算达到时间上限"
    );
    const facts = createScheduleRunFacts(state, "2026-10-17");
    refreshVacancyDiagnostics(
      state,
      result.assignments,
      preparation.tasks,
      facts
    );
    expect(cx.systemNotes?.join("\n")).toContain(
      "航班数均衡回退；候选人员航班数差值超过1"
    );
    expect(cx.systemNotes?.join("\n")).toContain("另一固定一号岗位不能移动");
    expect(cx.systemNotes?.join("\n")).toContain(
      "TR121/H02 21:55–23:55与该岗位冲突，换人计算达到时间上限"
    );
    cx.systemNotes!.push("其他仍有效的系统说明");
    Object.assign(cx, {
      status: "assigned",
      staffId: "p5",
      staffName: "人员5",
    });
    refreshVacancyDiagnostics(
      state,
      result.assignments,
      preparation.tasks,
      facts
    );
    expect(cx.systemNotes).toEqual(["其他仍有效的系统说明"]);
  });

  it("retains the detailed rotation safety reason and the existing manual override classification", () => {
    const detail = "人员1 时间冲突：KE166/H03 09:15–11:15已有排班";
    const reason = rotationCycleReason(detail);
    expect(reason).toContain(detail);
    expect(isManualOverrideSafetyReason(reason)).toBe(true);
  });

  it("names the configured transition policy and actual assignments in feedback", async () => {
    const state = warningScenario();
    const result = await generateSchedule(state, "2026-10-17");
    const first = result.assignments.find((a) => a.position === "G18")!;
    const next = result.assignments.find((a) => a.position === "H03")!;
    Object.assign(first, {
      status: "assigned",
      staffId: "p1",
      staffName: "人员1",
      startTime: "08:30",
      endTime: "10:00",
      workHours: 1.5,
    });
    Object.assign(next, {
      status: "assigned",
      staffId: "p1",
      staffName: "人员1",
      startTime: "10:30",
      endTime: "11:30",
      workHours: 1,
    });
    state.assignments = [first, next];
    state.flights = state.flights.map((f) => ({
      ...f,
      ...(f.id === first.flightId
        ? { startTime: first.startTime, endTime: first.endTime }
        : { startTime: next.startTime, endTime: next.endTime }),
    }));
    state.settings.minimumRegularTransitionMinutes = 0;
    state.settings.positionTransitionPolicies = [
      {
        id: "test",
        enabled: true,
        name: "控制后接KE柜台",
        mode: "forbid",
        sourceFlightNo: first.flightNo,
        sourcePositions: [first.position],
        targetFlightNo: next.flightNo,
        targetPosition: next.position,
        minimumGapMinutes: 90,
      },
    ];
    const feedback = buildScheduleFeedback(state, "2026-10-17").find(
      (f) => f.key === "connections"
    )!;
    expect(feedback.evidence).toContain("控制后接KE柜台");
    expect(feedback.evidence).toContain("90 分钟");
    expect(feedback.evidence).toContain("30 分钟");
    expect(feedback.evidence).toContain("08:30–10:00");
    expect(feedback.evidence).toContain("KE166/H03");
  });

  it("distinguishes a missing historical position from a missing flight without changing history", () => {
    const state = warningScenario();
    state.templates = [];
    state.history = [
      { ...state.history[0]!, flightNo: "KE166", position: "历史原岗位" },
    ];
    const before = structuredClone(state.history);
    const draft = buildHistoricalScheduleDraft(state, "2026-10-15");
    expect(draft.warnings.join("\n")).toContain("历史岗位“历史原岗位”");
    expect(draft.warnings.join("\n")).toContain("H03");
    expect(draft.warnings.join("\n")).toContain("未载入");
    expect(state.history).toEqual(before);
  });
});

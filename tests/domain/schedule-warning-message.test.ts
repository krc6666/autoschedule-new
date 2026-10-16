import { describe, expect, it } from "vitest";

import {
  assignmentWarningMessage,
  conciseAssignmentWarningReason,
  rotationCandidateWarningMessage,
} from "../../src/domain/reviews/schedule-warning-message";
import { dailyScheduleFailureMessage } from "../../src/domain/solver/solver-user-message";

const TECHNICAL_TERMS =
  /infeasible|changed-assignment-count|双向岗位资质|完整重排方案/;

describe("user-facing schedule warnings", () => {
  it("names each blocked H02 replacement and its previous late shift without merging reasons", () => {
    const message = rotationCandidateWarningMessage({
      staffName: "当前人员",
      fact: "已连续1次承担KE166/H02",
      targetFlightNo: "KE166",
      candidates: [
        {
          staffName: "人员甲",
          reasons: ["严格跨工作日恢复限制不允许该人员承担次班目标岗位"],
          previousLateWork: { date: "2026-09-18", flightNo: "TR121" },
        },
        {
          staffName: "人员乙",
          reasons: ["严格跨工作日恢复限制不允许该人员承担次班目标岗位"],
          previousLateWork: { date: "2026-09-18", flightNo: "TR121" },
        },
      ],
      timedOut: false,
    });
    expect(message).toContain(
      "人员甲 —— 严格跨工作日恢复限制不允许该人员承担次班目标岗位；上一工作班 2026-09-18 TR121，本次目标KE166"
    );
    expect(message).toContain(
      "人员乙 —— 严格跨工作日恢复限制不允许该人员承担次班目标岗位；上一工作班 2026-09-18 TR121，本次目标KE166"
    );
    expect(message).toContain("这次自动排班没有找到能完成的换人办法");
    expect(message).not.toMatch(/候选排除|其他人员处于/);
    expect((message.match(/[。！？]/g) ?? []).length).toBeLessThanOrEqual(2);
  });

  it("keeps a half-rest rejection more specific than a generic qualification reason", () => {
    expect(
      conciseAssignmentWarningReason([
        "没有具备连续腾挪岗位资质的人员",
        "该岗位的其他资质人员已设置半休，不能重新安排到后续岗位",
      ])
    ).toContain("该岗位的其他资质人员已设置半休，不能重新安排到后续岗位");
  });

  it("turns solver diagnostics into one plain business reason", () => {
    expect(
      conciseAssignmentWarningReason([
        "求解目标 changed-assignment-count 结束状态：infeasible",
        "没有具备双向岗位资质的完整重排方案",
      ])
    ).toBe("没有具备双方岗位资质的完整换人方案");
  });

  it("uses the person-fact-reason-decision-result order in at most two sentences", () => {
    const message = assignmentWarningMessage({
      staffName: "测试人员",
      fact: "已连续2次承担TEST100/G20",
      reasons: [
        "求解目标 changed-assignment-count 结束状态：infeasible",
        "没有具备双向岗位资质的完整重排方案",
      ],
      result: "保留原安排，当前连续第3次",
    });

    expect(message).toBe(
      "测试人员 已连续2次承担TEST100/G20；岗位完整性优先，保留原安排，当前连续第3次。\n本次未找到完整换人方案：没有具备双方岗位资质的完整换人方案"
    );
    expect(message).not.toMatch(TECHNICAL_TERMS);
    expect((message.match(/[。！？]/g) ?? []).length).toBeLessThanOrEqual(2);
  });

  it("does not expose solver terms in a failed daily schedule message", () => {
    const message = dailyScheduleFailureMessage("infeasible");

    expect(message).toContain(
      "请检查人员状态、岗位资质、夜班能力、时间冲突和工时上限"
    );
    expect(message).not.toMatch(TECHNICAL_TERMS);
  });

  it("keeps actionable flight and configuration facts for an infeasible day", () => {
    const message = dailyScheduleFailureMessage("infeasible", [
      "CX937/G18：严格次班恢复禁止空缺，基础合格的 1 人全部被上一班末班重点岗位避让排除。可检查严格/优先模式。",
    ]);

    expect(message).toContain("CX937/G18");
    expect(message).toContain("严格/优先模式");
    expect(message).not.toMatch(TECHNICAL_TERMS);
  });

  it("reports the bounded adaptive daily schedule limit", () => {
    expect(dailyScheduleFailureMessage("timed-out")).toBe(
      "当天排班计算超过允许时间（最长5分钟），请重试"
    );
  });
});

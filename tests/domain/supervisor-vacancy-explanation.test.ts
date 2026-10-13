import { describe, expect, it } from "vitest";
import { supervisorSearchFailureNotes } from "../../src/domain/assignments/supervisor-vacancy-explanation";
import { createLatePriorityPressureState } from "../performance/fixtures/late-priority";

describe("supervisor vacancy evidence", () => {
  it("explains the actual protection instead of saying nobody is qualified", () => {
    const target = createLatePriorityPressureState().assignments[1]!;
    const notes = supervisorSearchFailureNotes(
      target,
      {
        changes: null,
        termination: "infeasible",
        attemptedReasons: [],
        candidateRejections: [
          {
            staffId: "P0",
            staffName: "测试人",
            reasons: ["交换后会让末班重点岗位人员承担截止时间后的航班"],
          },
          {
            staffId: "unqualified",
            staffName: "无关人",
            reasons: ["not relevant"],
          },
        ],
      },
      ["P0"]
    );
    expect(notes.join("；")).toContain("上一班做了需要休息保护的晚班岗位");
    expect(notes.join("；")).not.toContain("无关人");
  });
  it("does not describe a timed out search as proven impossible", () => {
    const target = createLatePriorityPressureState().assignments[1]!;
    expect(
      supervisorSearchFailureNotes(
        target,
        { changes: null, termination: "timed-out", attemptedReasons: [] },
        []
      ).join("；")
    ).toContain("这不代表一定没有可安排的人");
  });
});

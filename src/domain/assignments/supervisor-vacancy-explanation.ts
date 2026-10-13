import type { Assignment } from "../../model";
import type { ReassignmentOptimizationResult } from "../solver/reassignment-contract";

/** Only translates collected evidence; does not decide who may work. */
export function supervisorSearchFailureNotes(
  target: Assignment,
  result: ReassignmentOptimizationResult,
  qualifiedStaffIds: readonly string[]
): string[] {
  const prefix = `${target.flightNo}/${target.position}`;
  const notes = [
    result.termination === "timed-out" ||
    result.termination === "time-limited-feasible"
      ? `${prefix}：换人计算达到时间上限，尚未找到可以采用的完整方案；这不代表一定没有可安排的人。`
      : `${prefix}：尝试换人后，仍未找到能同时保住其他岗位的合法方案。`,
  ];
  for (const candidate of result.candidateRejections ?? []) {
    if (!qualifiedStaffIds.includes(candidate.staffId)) continue;
    const reasons = candidate.reasons
      .map(readableSupervisorRejection)
      .filter(Boolean);
    if (reasons.length)
      notes.push(
        `${candidate.staffName}不能调到${prefix}：${[...new Set(reasons)].join("；")}。`
      );
  }
  const failedChecks = result.attemptedReasons
    .filter(
      (reason) =>
        !result.candidateRejections?.some((candidate) =>
          candidate.reasons.includes(reason)
        )
    )
    .map(readableSupervisorRejection)
    .filter(Boolean);
  if (failedChecks.length)
    notes.push(
      `${prefix}的完整换人方案未采用：${[...new Set(failedChecks)].join("；")}。`
    );
  return notes;
}

export function readableSupervisorRejection(reason: string): string {
  if (/求解目标|结束状态|infeasible|changed-assignment-count/i.test(reason))
    return "";
  if (reason === "交换后会让末班重点岗位人员承担截止时间后的航班")
    return "上一班做了需要休息保护的晚班岗位，这次换人会让他超过设置规定的下班时间";
  if (reason === "严格跨工作日恢复限制不允许该人员承担次班目标岗位")
    return "上一班做了需要休息保护的晚班岗位，设置规定这一班要避开这个岗位";
  if (/双向岗位资质.*完整重排方案/.test(reason))
    return "没有找到每一步都有人能接替、且不影响其他岗位的完整换人办法";
  if (reason === "候选人不具备未连续的机动督导资质")
    return "不符合这次督导的人选条件";
  return reason;
}

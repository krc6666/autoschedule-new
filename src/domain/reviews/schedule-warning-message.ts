import type { Assignment } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import type { ScheduleRunFacts } from "../shared/schedule-run-facts";
import { assignmentRule } from "../flights/schedule-position-rules";
import { previousWorkdayLateProtection } from "./cross-day-recovery";

export interface AssignmentWarningMessageOptions {
  staffName: string;
  fact: string;
  reasons: readonly string[];
  decision?: string;
  result?: string;
  attempt?: string;
}

export const FAIRNESS_TIME_LIMITED_WARNING =
  "班表已满足全部硬性要求和核心排班规则；人员恢复与公平已在可用时间内尽量优化，仍可能存在小幅改善空间。";

export const FAIRNESS_GAP_LIMITED_WARNING =
  "班表已满足全部硬性要求和核心排班规则；人员恢复与公平已优化到允许的小幅差距内。";

export const FAIRNESS_USER_STOPPED_WARNING =
  "班表已满足全部硬性要求和核心排班规则；人员恢复与公平只采用了停止时已经完成的优化结果。";

export function scheduleOptimizationWarning(
  quality:
    | "all-objectives-optimal"
    | "fairness-gap-limited"
    | "fairness-time-limited"
    | "fairness-user-stopped"
): string | null {
  if (quality === "fairness-user-stopped") return FAIRNESS_USER_STOPPED_WARNING;
  if (quality === "fairness-time-limited") return FAIRNESS_TIME_LIMITED_WARNING;
  if (quality === "fairness-gap-limited") return FAIRNESS_GAP_LIMITED_WARNING;
  return null;
}

/** Display recorded business evidence without guessing its cause. */
function readableReason(reason: string): string | null {
  const text = reason.trim();
  if (
    !text ||
    /求解目标|结束状态|infeasible|changed-assignment-count/i.test(text)
  )
    return null;
  return text
    .replaceAll("双向岗位资质", "双方岗位资质")
    .replaceAll("完整重排方案", "完整换人方案");
}

export function conciseAssignmentWarningReason(
  reasons: readonly string[]
): string {
  const recorded = [
    ...new Set(
      reasons.map(readableReason).filter((r): r is string => Boolean(r))
    ),
  ];
  return recorded.length
    ? recorded.join("；")
    : "具体原因未记录，不能确定是否可换人";
}

export function assignmentWarningMessage({
  staffName,
  fact,
  reasons,
  decision = "岗位完整性优先",
  result = "保留原安排",
  attempt = "本次未找到完整换人方案",
}: AssignmentWarningMessageOptions): string {
  return `${staffName} ${fact}；${decision}，${result}。\n${attempt}：${conciseAssignmentWarningReason(reasons)}`;
}
export interface RotationWarningCandidate {
  staffName: string;
  reasons: readonly string[];
  previousLateWork?: {
    date: string;
    flightNo: string;
    position?: string;
    startTime?: string;
    endTime?: string;
  };
}

export function rotationWarningCandidates(
  state: ScheduleGenerationFacts,
  primary: Assignment,
  date: string,
  rejections: readonly { staffId: string; reasons: readonly string[] }[],
  facts?: ScheduleRunFacts
): RotationWarningCandidate[] {
  const rule = assignmentRule(state, primary);
  if (!rule) return [];
  const protectedRecords = (
    facts?.crossDayRecovery.previousWorkday ??
    previousWorkdayLateProtection(state, date)
  ).protectedRecords;
  return state.staff
    .filter(
      (person) =>
        person.id !== primary.staffId &&
        rule.qualifiedStaffIds.includes(person.id)
    )
    .map((person) => ({
      staffName: person.name,
      reasons:
        person.status !== "正常" || person.staffType !== "常规"
          ? [
              `该人员今天${person.status !== "正常" ? person.status : "不是常规人员"}`,
            ]
          : rejections
              .filter((item) => item.staffId === person.id)
              .flatMap((item) => item.reasons),
      previousLateWork: protectedRecords.find(
        (record) => record.staffId === person.id
      ),
    }));
}

function plainRotationReason(
  candidate: RotationWarningCandidate,
  targetFlightNo: string,
  timedOut: boolean
): string {
  if (!candidate.reasons.length)
    return timedOut
      ? "换人计算未完成，不能确定是否可换人"
      : "未找到完整换人方案，具体原因未记录";
  const recorded = conciseAssignmentWarningReason(candidate.reasons);
  const record = candidate.previousLateWork;
  if (/严格跨工作日恢复/.test(recorded) && record)
    return `${recorded}；上一工作班 ${record.date} ${record.flightNo}${record.position ? `/${record.position}` : ""}${record.startTime && record.endTime ? ` ${record.startTime}–${record.endTime}` : ""}，本次目标${targetFlightNo}`;
  return recorded;
}

export function rotationCandidateWarningMessage({
  staffName,
  fact,
  targetFlightNo,
  candidates,
  timedOut,
}: {
  staffName: string;
  fact: string;
  targetFlightNo: string;
  candidates: readonly RotationWarningCandidate[];
  timedOut: boolean;
}): string {
  const lines = candidates.map(
    (candidate) =>
      `${candidate.staffName} —— ${plainRotationReason(candidate, targetFlightNo, timedOut)}`
  );
  const conclusion = timedOut
    ? "这次自动排班没来得及算出完整换法，原安排保留。"
    : candidates.length === 0
      ? "当前没有第二位具备这个岗位资质的人，原安排保留。"
      : "这次自动排班没有找到能完成的换人办法，原安排保留。";
  return [`${staffName} ${fact}。`, ...lines, conclusion].join("\n");
}

export function plainSwapAnalysisReason(reason: string): string {
  return readableReason(reason) ?? "具体原因未记录";
}

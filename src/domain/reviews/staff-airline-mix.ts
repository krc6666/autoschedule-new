import type { Assignment } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import type { FinalScheduleReviewContext } from "../rules/rule-registry";
import { airlineCode } from "../rules/airline-rotation";
import { enabledAirlineMixPolicies } from "../rules/airline-mix-policy";
import { groupStaffFlightsByNormalizedNumber } from "../statistics/staff-flight-count";
import { staffWorkContinuity } from "./staff-work-continuity";
import { isRotationLocked } from "./rotation-review-safety";
import { optimizeReassignment } from "../solver/reassignment-optimizer";
import { applyConfiguredEarlyReleases } from "../assignments/assignment-timing";
import {
  rebuildAutomaticAssignmentEvidence,
  replaceAssignmentDecisions,
} from "../assignments/assignment-evidence";
import { schedulingDecision } from "../rules/schedule-rule-contract";
import { preservesRelaxedShiftBalance } from "./relaxed-shift-balance";
import { ScheduleGuardError } from "../kernel/schedule-guard";

export interface StaffAirlineMix {
  staffId: string;
  flightNumbers: string[];
  policyIds: string[];
}

/** A day containing only group carriers is explicitly exempt from that row. */
export function applicableAirlineMixPolicies(
  state: ScheduleGenerationFacts,
  assignments: readonly Assignment[]
) {
  const scheduledIds = new Set(assignments.map((a) => a.flightId));
  const carriers = state.flights
    .filter((f) => scheduledIds.has(f.id))
    .map((f) => airlineCode(f.flightNo));
  return enabledAirlineMixPolicies(state.settings).filter((p) =>
    carriers.some((code) => !p.airlineCodes.includes(code))
  );
}

/** Sole projection for execution and feedback. A single flight is never a mix. */
export function staffAirlineMix(
  state: ScheduleGenerationFacts,
  assignments: readonly Assignment[]
): StaffAirlineMix[] {
  const grouped = groupStaffFlightsByNormalizedNumber(
    assignments.flatMap((a) =>
      a.status === "assigned" && a.staffId
        ? [{ staffId: a.staffId, flightNo: a.flightNo }]
        : []
    )
  );
  const policies = applicableAirlineMixPolicies(state, assignments);
  return state.staff
    .filter((p) => p.staffType === "常规" && p.status === "正常")
    .map((p) => {
      const flightNumbers = [...(grouped.get(p.id)?.keys() ?? [])];
      return {
        staffId: p.id,
        flightNumbers,
        policyIds:
          flightNumbers.length < 2
            ? []
            : policies
                .filter((rule) =>
                  flightNumbers.every((f) =>
                    rule.airlineCodes.includes(airlineCode(f))
                  )
                )
                .map((rule) => rule.id),
      };
    });
}

/** Keep flight counts and resolve the target without creating any new group violation. */
function improvesMix(
  before: readonly StaffAirlineMix[],
  after: readonly StaffAirlineMix[],
  staffId: string,
  policyId: string
): boolean {
  const previous = new Map(before.map((p) => [p.staffId, p]));
  return (
    !after.some((p) => {
      const old = previous.get(p.staffId);
      return (
        !old ||
        old.flightNumbers.length !== p.flightNumbers.length ||
        p.policyIds.some((id) => !old.policyIds.includes(id))
      );
    }) &&
    !after.find((p) => p.staffId === staffId)?.policyIds.includes(policyId)
  );
}

const MIX_REVIEW_BUDGET_MS = 4000;

export async function improveStaffAirlineMix(
  context: FinalScheduleReviewContext
): Promise<Assignment[]> {
  const { state, date, solver, facts, lockedAssignmentIds, assertSafe } =
    context;
  let current = structuredClone([...context.assignments]);
  const deadline = Date.now() + MIX_REVIEW_BUDGET_MS;
  const targets = staffAirlineMix(state, current).flatMap((p) =>
    p.policyIds.map((policyId) => ({ staffId: p.staffId, policyId }))
  );
  for (const target of targets) {
    const before = staffAirlineMix(state, current);
    if (
      !before
        .find((p) => p.staffId === target.staffId)
        ?.policyIds.includes(target.policyId)
    )
      continue;
    const policy = state.settings.airlineMixPolicies.find(
      (p) => p.id === target.policyId
    )!;
    const inGroup = (a: Assignment) =>
      policy.airlineCodes.includes(airlineCode(a.flightNo));
    const groups = [
      ...groupStaffFlightsByNormalizedNumber(
        current.flatMap((a) =>
          a.status === "assigned" && a.staffId
            ? [{ staffId: a.staffId, flightNo: a.flightNo, assignment: a }]
            : []
        )
      ).values(),
    ].flatMap((flights) =>
      [...flights.values()].map((entries) => entries.map((e) => e.assignment))
    );
    const movableGroups = groups.filter((rows) =>
      rows.every(
        (a) =>
          state.staff.find((p) => p.id === a.staffId)?.staffType === "常规" &&
          !a.manualRemark &&
          !a.teamLeaderGapFill &&
          !isRotationLocked(state, a, lockedAssignmentIds)
      )
    );
    const movable = movableGroups.flat();
    const primaries = movableGroups
      .filter(
        (rows) => rows[0]?.staffId === target.staffId && rows.every(inGroup)
      )
      .map((rows) => rows[0]!);
    const reasons = new Set<string>();
    const attendanceBefore = staffWorkContinuity(
      state,
      current,
      facts.currentDutyStaffId
    );
    let improved = false;
    if (!movable.some((a) => !inGroup(a)))
      reasons.add(
        "没有可安全移动的组外航班岗位（当天仅有组内航班、组外尚未安排或岗位受保护）"
      );
    else
      for (const [index, primary] of primaries.entries()) {
        if (Date.now() >= deadline) {
          reasons.add("搭配复核达到计算时限，尚未找到完整安全方案");
          break;
        }
        let accepted: Assignment[] | undefined;
        const result = await optimizeReassignment({
          state,
          date,
          solver,
          facts,
          assignments: current,
          primary,
          movableAssignments: movable,
          intent: { kind: "staff-airline-mix-review" },
          primaryCandidateAllowed: (p) => p.id !== target.staffId,
          candidateAllowed: (a, p) =>
            p.staffType === "常规" &&
            (p.id !== target.staffId ||
              a.staffId === target.staffId ||
              !inGroup(a)),
          coupledAssignmentGroups: movableGroups.map((rows) =>
            rows.map((a) => a.id)
          ),
          preserveStaffAssignmentCounts: true,
          maxParticipants: 5,
          timeoutMs: Math.max(
            1,
            Math.floor((deadline - Date.now()) / (primaries.length - index))
          ),
          validateChanges: (changes) => {
            const byId = new Map(
              changes.map((c) => [c.assignmentId, c.staffId])
            );
            const proposal = structuredClone(current);
            const changedStaff = new Set<string>();
            for (const a of proposal) {
              const incoming = byId.get(a.id);
              if (!incoming || incoming === a.staffId) continue;
              if (a.staffId) changedStaff.add(a.staffId);
              changedStaff.add(incoming);
              a.staffId = incoming;
              a.staffName = state.staff.find((p) => p.id === incoming)!.name;
              rebuildAutomaticAssignmentEvidence(a, [
                schedulingDecision(
                  "staff-airline-mix",
                  "selected",
                  "通过整体安全换人搭配组外航司，个人航班数保持。"
                ),
              ]);
            }
            applyConfiguredEarlyReleases(proposal, state, changedStaff);
            if (
              !improvesMix(
                before,
                staffAirlineMix(state, proposal),
                target.staffId,
                target.policyId
              )
            )
              return ["目标搭配未改善，或个人航班数改变、问题转移给他人"];
            const attendanceAfter = staffWorkContinuity(
              state,
              proposal,
              facts.currentDutyStaffId
            );
            if (
              attendanceAfter.some((p) => {
                const old = attendanceBefore.find(
                  (o) => o.staffId === p.staffId
                );
                return (
                  !old ||
                  (p.split && !old.split) ||
                  p.spanMinutes > old.spanMinutes ||
                  p.maximumGapMinutes > old.maximumGapMinutes
                );
              })
            )
              return ["换人会增加普通员工的全天跨度、最长空挡或新增早晚割裂"];
            if (!preservesRelaxedShiftBalance(state, date, current, proposal))
              return ["换人会使月度休息预算或公平退步"];
            try {
              assertSafe(proposal);
            } catch (error) {
              if (error instanceof ScheduleGuardError)
                return ["最终安全复核拒绝方案，保留原安排"];
              throw error;
            }
            accepted = proposal;
            return [];
          },
        });
        if (result.changes && accepted) {
          current = accepted;
          improved = true;
          break;
        }
        result.attemptedReasons.forEach((r) => reasons.add(r));
      }
    if (!improved) {
      if (!primaries.length) reasons.add("目标人员的航班岗位均不可自动移动");
      const message = `${policy.airlineCodes.join("、")}：保留原搭配；${[...reasons].join("；") || "本次尚未找到完整安全换人方案"}。软偏好允许此安排，有限搜索不代表已证明无解。`;
      for (const a of current.filter((a) => a.staffId === target.staffId)) {
        replaceAssignmentDecisions(a, "staff-airline-mix", [
          schedulingDecision("staff-airline-mix", "fallback", message),
        ]);
      }
    }
  }
  return current;
}

import type { Assignment } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import type { FinalScheduleReviewContext } from "../rules/rule-registry";
import { airlineCode } from "../rules/airline-rotation";
import { enabledAirlineMixPolicies } from "../rules/airline-mix-policy";
import { groupStaffFlightsByNormalizedNumber } from "../statistics/staff-flight-count";
import {
  staffWorkContinuity,
  preservesStaffWorkContinuity,
} from "./staff-work-continuity";
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
import {
  isRotationLateAssignment,
  preservesLateAirlineRotation,
  staffLateAirlineRotation,
  type StaffLateAirlineRotation,
} from "./late-airline-rotation";

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
  return (
    preservesMix(before, after) &&
    !after.find((p) => p.staffId === staffId)?.policyIds.includes(policyId)
  );
}

const MIX_REVIEW_BUDGET_MS = 4000;

function movableAirlineGroups(
  context: FinalScheduleReviewContext,
  current: Assignment[]
) {
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
  return groups.filter((rows) =>
    rows.every(
      (a) =>
        context.state.staff.find((p) => p.id === a.staffId)?.staffType ===
          "常规" &&
        !a.manualRemark &&
        !a.teamLeaderGapFill &&
        !isRotationLocked(context.state, a, context.lockedAssignmentIds)
    )
  );
}

function airlineProposal(
  context: FinalScheduleReviewContext,
  current: Assignment[],
  changes: readonly { assignmentId: string; staffId: string }[],
  message: string
) {
  const byId = new Map(changes.map((c) => [c.assignmentId, c.staffId]));
  const proposal = structuredClone(current),
    changedStaff = new Set<string>();
  for (const a of proposal) {
    const incoming = byId.get(a.id);
    if (!incoming || incoming === a.staffId) continue;
    if (a.staffId) changedStaff.add(a.staffId);
    changedStaff.add(incoming);
    a.staffId = incoming;
    a.staffName = context.state.staff.find((p) => p.id === incoming)!.name;
    rebuildAutomaticAssignmentEvidence(a, [
      schedulingDecision("staff-airline-mix", "selected", message),
    ]);
  }
  applyConfiguredEarlyReleases(proposal, context.state, changedStaff);
  return proposal;
}

function airlineProposalSafetyReasons(
  context: FinalScheduleReviewContext,
  current: Assignment[],
  proposal: Assignment[]
): string[] {
  const { state, date, facts, assertSafe } = context;
  const attendanceBefore = staffWorkContinuity(
    state,
    current,
    facts.currentDutyStaffId
  );
  const jointRotation = staffLateAirlineRotation(state, current, date).some(
    (p) => p.previousAirlines.length > 0 && p.currentAirlines.length > 0
  );
  if (
    !preservesStaffWorkContinuity(
      attendanceBefore,
      staffWorkContinuity(state, proposal, facts.currentDutyStaffId),
      jointRotation
    )
  )
    return [
      jointRotation
        ? "联合轮换会使全队出勤跨度/空挡负担变差或新增早晚割裂"
        : "换人会增加普通员工的全天跨度、最长空挡或新增早晚割裂",
    ];
  if (!preservesRelaxedShiftBalance(state, date, current, proposal))
    return ["换人会使月度休息预算或公平退步"];
  try {
    assertSafe(proposal);
  } catch (error) {
    if (error instanceof ScheduleGuardError)
      return ["最终安全复核拒绝方案，保留原安排"];
    throw error;
  }
  return [];
}

function preservesMix(
  before: readonly StaffAirlineMix[],
  after: readonly StaffAirlineMix[],
  mayYield: ReadonlySet<string> = new Set()
): boolean {
  return after.every((row) => {
    const old = before.find((p) => p.staffId === row.staffId);
    return (
      old &&
      old.flightNumbers.length === row.flightNumbers.length &&
      (mayYield.has(row.staffId) ||
        row.policyIds.every((id) => old.policyIds.includes(id)))
    );
  });
}

function improvesLateRotation(
  before: readonly StaffLateAirlineRotation[],
  after: readonly StaffLateAirlineRotation[],
  staffId: string
): boolean {
  return (
    preservesLateAirlineRotation(before, after) &&
    (after.find((p) => p.staffId === staffId)?.repeatedAirlines.length ?? 0) <
      (before.find((p) => p.staffId === staffId)?.repeatedAirlines.length ??
        0) &&
    after.every(
      (p) =>
        p.flightNumbers.length ===
        before.find((old) => old.staffId === p.staffId)?.flightNumbers.length
    )
  );
}

async function improveLateAirlineRotation(
  context: FinalScheduleReviewContext
): Promise<Assignment[]> {
  let current = structuredClone([...context.assignments]);
  const { state, date, solver, facts } = context;
  const deadline = Date.now() + MIX_REVIEW_BUDGET_MS;
  const targetIds = staffLateAirlineRotation(state, current, date)
    .filter((p) => p.repeatedAirlines.length)
    .map((p) => p.staffId);
  for (const staffId of targetIds) {
    const before = staffLateAirlineRotation(state, current, date),
      target = before.find((p) => p.staffId === staffId)!;
    if (!target.repeatedAirlines.length) continue;
    const beforeMix = staffAirlineMix(state, current),
      groups = movableAirlineGroups(context, current);
    const primaries = groups
      .filter(
        (rows) =>
          rows[0]?.staffId === staffId &&
          rows.some(
            (a) =>
              isRotationLateAssignment(state, a, date) &&
              target.repeatedAirlines.includes(airlineCode(a.flightNo))
          )
      )
      .map((rows) => rows[0]!);
    const reasons = new Set<string>();
    let improved = false;
    // First search an all-day plan preserving both preferences. Only then permit
    // the mix preference to yield for workers whose late rotation really improves.
    for (const mayYield of [false, true]) {
      if (improved || Date.now() >= deadline) break;
      const phaseDeadline = mayYield
        ? deadline
        : Date.now() + Math.max(1, Math.floor((deadline - Date.now()) / 2));
      for (const [index, primary] of primaries.entries()) {
        if (Date.now() >= phaseDeadline) break;
        let accepted: Assignment[] | undefined;
        const result = await optimizeReassignment({
          state,
          date,
          solver,
          facts,
          assignments: current,
          primary,
          movableAssignments: groups.flat(),
          intent: { kind: "staff-airline-mix-review" },
          primaryCandidateAllowed: (p) => p.id !== staffId,
          candidateAllowed: (a, p) =>
            p.staffType === "常规" &&
            (p.id !== staffId ||
              !isRotationLateAssignment(state, a, date) ||
              !target.previousAirlines.includes(airlineCode(a.flightNo))),
          coupledAssignmentGroups: groups.map((rows) => rows.map((a) => a.id)),
          preserveStaffAssignmentCounts: true,
          maxParticipants: 5,
          timeoutMs: Math.max(
            1,
            Math.floor(
              (phaseDeadline - Date.now()) / (primaries.length - index)
            )
          ),
          validateChanges: (changes) => {
            const proposal = airlineProposal(
              context,
              current,
              changes,
              "联合调整全天岗位，尽量交替末班航司；必要时航司搭配软偏好让步。"
            );
            const after = staffLateAirlineRotation(state, proposal, date);
            if (!improvesLateRotation(before, after, staffId))
              return ["末班交替未改善，或重复转移给他人、个人末班数量改变"];
            const improvedStaff = new Set(
              mayYield
                ? after
                    .filter(
                      (p) =>
                        p.repeatedAirlines.length <
                        (before.find((old) => old.staffId === p.staffId)
                          ?.repeatedAirlines.length ?? 0)
                    )
                    .map((p) => p.staffId)
                : []
            );
            if (
              !preservesMix(
                beforeMix,
                staffAirlineMix(state, proposal),
                improvedStaff
              )
            )
              return ["尚未找到同时满足末班交替与全天航司搭配的方案"];
            const safety = airlineProposalSafetyReasons(
              context,
              current,
              proposal
            );
            if (safety.length) return safety;
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
    }
    if (!improved) {
      if (!primaries.length)
        reasons.add("末班岗位受人工、值班或其他锁定保护，不能自动移动");
      const message = `末班航司交替：保留原安排；${[...reasons].join("；") || "有限计算时间内尚未找到兼顾资质、覆盖和公平的完整方案"}。软偏好允许连续同航司，不留空岗。`;
      for (const a of current.filter((a) => a.staffId === staffId))
        replaceAssignmentDecisions(a, "staff-airline-mix", [
          schedulingDecision("staff-airline-mix", "fallback", message),
        ]);
    }
  }
  return current;
}

export async function improveStaffAirlineMix(
  context: FinalScheduleReviewContext
): Promise<Assignment[]> {
  const { state, date, solver, facts } = context;
  let current = await improveLateAirlineRotation(context);
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
    const movableGroups = movableAirlineGroups(context, current);
    const movable = movableGroups.flat();
    const primaries = movableGroups
      .filter(
        (rows) => rows[0]?.staffId === target.staffId && rows.every(inGroup)
      )
      .map((rows) => rows[0]!);
    const reasons = new Set<string>();
    const rotationBefore = staffLateAirlineRotation(state, current, date);
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
            const proposal = airlineProposal(
              context,
              current,
              changes,
              "通过整体安全换人搭配组外航司，个人航班数保持。"
            );
            if (
              !improvesMix(
                before,
                staffAirlineMix(state, proposal),
                target.staffId,
                target.policyId
              )
            )
              return ["目标搭配未改善，或个人航班数改变、问题转移给他人"];
            if (
              !preservesLateAirlineRotation(
                rotationBefore,
                staffLateAirlineRotation(state, proposal, date)
              )
            )
              return ["航司搭配不能把已经改善的末班交替换回连续同航司"];
            const safety = airlineProposalSafetyReasons(
              context,
              current,
              proposal
            );
            if (safety.length) return safety;
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

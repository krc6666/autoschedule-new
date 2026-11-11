import type { Assignment } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import {
  dailyFlightCountParticipantIds,
  groupStaffFlightsByNormalizedNumber,
  type DailyFlightCountParticipants,
} from "../statistics/staff-flight-count";

/** One-sided duty catch-up; ordinary staff keep their separate balance rule. */
export function dutyFlightCountStatus(
  state: Pick<ScheduleGenerationFacts, "staff" | "settings" | "positionRules">,
  assignments: readonly Assignment[],
  options: DailyFlightCountParticipants
) {
  const duty = state.staff.find(
    (p) =>
      p.id === options.dutyStaffId &&
      p.status === "正常" &&
      p.staffType === "常规"
  );
  const groups = groupStaffFlightsByNormalizedNumber(
    assignments.flatMap((r) =>
      r.status === "assigned" && r.staffId
        ? [{ staffId: r.staffId, flightNo: r.flightNo }]
        : []
    )
  );
  const participants = dailyFlightCountParticipantIds(state, options);
  const maximum = Math.max(
    0,
    ...[...participants].map((id) => groups.get(id)?.size ?? 0)
  );
  const dutyCount = duty ? (groups.get(duty.id)?.size ?? 0) : 0;
  return {
    applicable: Boolean(duty) && participants.size > 0,
    maximum,
    dutyCount,
    shortfall: duty ? Math.max(0, maximum - dutyCount - 1) : 0,
  };
}

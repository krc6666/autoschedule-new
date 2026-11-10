import type { PositionRule } from "../../model";
import type { MobileSupervisorFillRule } from "../rules/structured-policy-contract";

export const normalizeFillReference = (value: string) =>
  value.trim().toUpperCase();
export function isSameFlightSupervisorFillRule(
  rule: Pick<MobileSupervisorFillRule, "sourceFlightNo" | "targetFlightNo">
): boolean {
  const flightNo = normalizeFillReference(rule.sourceFlightNo);
  return (
    Boolean(flightNo) &&
    flightNo === normalizeFillReference(rule.targetFlightNo)
  );
}
export function fillPositionMatches(
  position: PositionRule,
  flightNo: string,
  keyword: string
): boolean {
  return (
    normalizeFillReference(position.flightNo) ===
      normalizeFillReference(flightNo) &&
    Boolean(keyword.trim()) &&
    normalizeFillReference(position.name).includes(
      normalizeFillReference(keyword)
    )
  );
}

export function supervisorFillRelationsForTarget(
  state: {
    settings: {
      mobileSupervisorFillRules: readonly MobileSupervisorFillRule[];
    };
  },
  position: PositionRule | undefined
): MobileSupervisorFillRule[] {
  if (!position) return [];
  return state.settings.mobileSupervisorFillRules.filter((rule) =>
    fillPositionMatches(
      position,
      rule.targetFlightNo,
      rule.targetPositionKeyword
    )
  );
}

export function isSupervisorFillTarget(
  state: {
    settings: {
      mobileSupervisorFillRules: readonly MobileSupervisorFillRule[];
    };
  },
  position: PositionRule | undefined
): boolean {
  return Boolean(
    position && supervisorFillRelationsForTarget(state, position).length > 0
  );
}

/** One-time conversion; marker-only targets stay visible without guessing a source. */
export function migrateLegacySupervisorFillConfiguration(
  positions: PositionRule[],
  relations: MobileSupervisorFillRule[]
): void {
  for (const relation of relations) {
    if (!isSameFlightSupervisorFillRule(relation))
      relation.requiresConfirmation = true;
    if (relation.requiresConfirmation !== undefined) continue;
    const targets = positions.filter((position) =>
      fillPositionMatches(
        position,
        relation.targetFlightNo,
        relation.targetPositionKeyword
      )
    );
    relation.requiresConfirmation =
      !targets.length ||
      targets.some((position) => position.coverageRole !== "supervisor-fill");
  }
  for (const position of positions) {
    if (
      position.coverageRole === "supervisor-fill" &&
      !relations.some((rule) =>
        fillPositionMatches(
          position,
          rule.targetFlightNo,
          rule.targetPositionKeyword
        )
      )
    ) {
      relations.push({
        id: `review-${position.id}`,
        enabled: false,
        sourceFlightNo: "",
        sourcePositionKeyword: "",
        targetFlightNo: position.flightNo,
        targetPositionKeyword: position.name,
        allowAutomatic: false,
        allowManual: false,
        requiresConfirmation: true,
      });
    }
    delete position.coverageRole;
  }
}

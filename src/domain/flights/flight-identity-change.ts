import type {
  FlightIdentity,
  GroupWorkspace,
  ScheduleGroupId,
  ScheduleSettings,
  SharedScheduleData,
} from "../../model";
import { fnv64Fingerprint } from "../rules/schedule-rule-fingerprint";
import {
  FLIGHT_RULE_REFERENCE_FIELDS,
  groupFlightReferenceNumbers,
  renameGroupFlightReferences,
} from "./group-flight-references";
import {
  flightIdentities,
  flightIdentityKey,
  validateFlightIdentities,
} from "./flight-identities";

export interface FlightIdentityChangePreview {
  fingerprint: string;
  identities: FlightIdentity[];
  errors: string[];
  groups: Array<{
    groupId: "A" | "B";
    affectedRules: number;
    historyRecords: number;
    needsReschedule: boolean;
  }>;
}

export type FlightIdentityChangeFacts = GroupWorkspace & {
  shared: SharedScheduleData;
  groups: Record<ScheduleGroupId, GroupWorkspace>;
  activeGroupId: ScheduleGroupId;
};

export function flightIdentityChangeFingerprint(
  state: FlightIdentityChangeFacts
): string {
  return fnv64Fingerprint(
    {
      shared: state.shared,
      groups: state.groups,
      active: {
        id: state.activeGroupId,
        settings: state.settings,
        positionRules: state.positionRules,
        history: state.history,
        adjustments: state.latePriorityFrequencyAdjustments,
        flights: state.flights,
        assignments: state.assignments,
        staff: state.staff,
        date: state.activeScheduleDate,
        season: state.flightSeasonOverrides,
      },
    },
    "flight-identity-change-v1"
  );
}

export function flightIdentityReferenceMapper(
  state: FlightIdentityChangeFacts,
  identities: FlightIdentity[]
): (reference: string) => string {
  const next = { flightIdentities: identities };
  return (reference) => {
    if (!reference) return reference;
    const priorKey = flightIdentityKey(state, reference);
    const priorIdentity = flightIdentities(state).find(
      (i) => `@${i.id.toUpperCase()}` === priorKey
    );
    if (priorIdentity) {
      const targets = new Set(
        priorIdentity.aliases.map((a) =>
          flightIdentityKey(next, a.flightNo, a.from ?? a.until)
        )
      );
      if (targets.size === 1 && [...targets][0]!.startsWith("@"))
        return [...targets][0]!;
      if (identities.some((i) => `@${i.id.toUpperCase()}` === priorKey))
        return priorKey;
    }
    return flightIdentityKey(next, reference);
  };
}

function conflictingRules(settings: ScheduleSettings): string[] {
  const errors: string[] = [];
  const gap = new Map<string, boolean>();
  for (const row of settings.teamLeaderGapFillPositionPolicies) {
    const key = `${row.flightNo}|${row.position.trim().toUpperCase()}`;
    if (gap.has(key) && gap.get(key) !== row.movable)
      errors.push(`${row.flightNo}/${row.position}同时设置允许移动和保护`);
    gap.set(key, row.movable);
  }
  const coverage = new Map<string, string>();
  for (const row of settings.mobileSupervisorCoverageRules.filter(
    (r) => r.enabled
  )) {
    const key = `${row.flightNo}|${row.matchField}|${row.keyword.trim().toUpperCase()}`;
    if (coverage.has(key) && coverage.get(key) !== row.mode)
      errors.push(`${row.flightNo}/${row.keyword}兼任规则同时允许和禁止`);
    coverage.set(key, row.mode);
  }
  const transitions = new Map<string, string>();
  for (const row of settings.positionTransitionPolicies.filter(
    (r) => r.enabled
  )) {
    const key = JSON.stringify([
      row.sourceFlightNo,
      [...row.sourcePositions].map((p) => p.trim().toUpperCase()).sort(),
      row.targetFlightNo,
      row.targetPosition.trim().toUpperCase(),
    ]);
    const value = JSON.stringify([row.mode, row.minimumGapMinutes]);
    if (transitions.has(key) && transitions.get(key) !== value)
      errors.push(
        `${row.sourceFlightNo}→${row.targetFlightNo}/${row.targetPosition}的衔接方式或间隔冲突，请先统一规则`
      );
    transitions.set(key, value);
  }
  const fills = new Map<string, string>();
  for (const row of settings.mobileSupervisorFillRules.filter(
    (r) => r.enabled && !r.requiresConfirmation
  )) {
    const key = JSON.stringify([
      row.sourceFlightNo,
      row.sourcePositionKeyword.trim().toUpperCase(),
      row.targetFlightNo,
      row.targetPositionKeyword.trim().toUpperCase(),
    ]);
    const value = JSON.stringify([row.allowAutomatic, row.allowManual]);
    if (fills.has(key) && fills.get(key) !== value)
      errors.push(
        `${row.sourceFlightNo}/${row.sourcePositionKeyword}的督导补位允许范围冲突，请先统一规则`
      );
    fills.set(key, value);
  }
  const cutoffs = new Map<string, string>();
  for (const row of settings.lateShiftRecoveryPositionRules.filter(
    (r) => r.enabled
  )) {
    const key = JSON.stringify([
      row.flightNo,
      row.matchField,
      row.keyword.trim().toUpperCase(),
    ]);
    if (cutoffs.has(key) && cutoffs.get(key) !== row.nextWorkdayCutoffTime)
      errors.push(
        `${row.flightNo}/${row.keyword}的次班恢复截止时间冲突，请先统一规则`
      );
    cutoffs.set(key, row.nextWorkdayCutoffTime);
  }
  return errors;
}

/** Shared by page preview, commit and import. No mutation before all checks pass. */
export function previewFlightIdentityChange(
  state: FlightIdentityChangeFacts,
  identities: FlightIdentity[]
): FlightIdentityChangePreview {
  const errors = validateFlightIdentities(identities);
  const result: FlightIdentityChangePreview = {
    fingerprint: flightIdentityChangeFingerprint(state),
    identities,
    errors,
    groups: [],
  };
  if (errors.length) return result;
  const map = flightIdentityReferenceMapper(state, identities);
  const ids = new Set(identities.map((i) => `@${i.id.toUpperCase()}`));
  const next = { flightIdentities: identities };
  for (const groupId of ["A", "B"] as const) {
    const workspace =
      groupId === state.activeGroupId ? state : state.groups[groupId];
    const settings = JSON.parse(
      JSON.stringify(workspace.settings)
    ) as ScheduleSettings;
    const references = groupFlightReferenceNumbers([], settings);
    for (const reference of references) {
      const mapped = map(reference);
      if (mapped.startsWith("@") && !ids.has(mapped))
        errors.push(`${groupId}组规则引用的航班档案${reference}不能删除或拆分`);
      if (
        !mapped.startsWith("@") &&
        identities.filter((i) =>
          i.aliases.some(
            (a) =>
              a.flightNo.trim().toUpperCase() === reference.trim().toUpperCase()
          )
        ).length > 1
      )
        errors.push(
          `${groupId}组规则${reference}跨期归属不唯一，请先选明确档案`
        );
    }
    renameGroupFlightReferences([], settings, map);
    errors.push(...conflictingRules(settings).map((e) => `${groupId}组：${e}`));
    // Canonical ledgers already include a nonlinear clamp/reset. A merge with
    // these ledgers requires a separate reconciliation, never arithmetic guessing.
    for (const a of workspace.latePriorityFrequencyAdjustments) {
      if (
        a.flightNo.startsWith("@") &&
        map(a.flightNo) !== a.flightNo.toUpperCase()
      )
        errors.push(
          `${groupId}组${a.month}已有档案级人工次数，请先导出并对账后再合并或拆分该档案`
        );
      if (a.flightNo.startsWith("@") && !ids.has(map(a.flightNo)))
        errors.push(`${groupId}组次数引用的档案不能删除`);
      const start = `${a.month}-01`,
        end = `${a.month}-31`;
      const owners = identities.filter((i) =>
        i.aliases.some(
          (alias) =>
            alias.flightNo.trim().toUpperCase() ===
              a.flightNo.trim().toUpperCase() &&
            (!alias.from || alias.from <= end) &&
            (!alias.until || alias.until >= start)
        )
      );
      if (owners.length > 1)
        errors.push(
          `${groupId}组${a.month}/${a.flightNo}人工次数跨两个档案，需先明确归属`
        );
    }
    for (const [collection, fields] of Object.entries(
      FLIGHT_RULE_REFERENCE_FIELDS
    )) {
      for (const row of workspace.settings[
        collection as keyof typeof FLIGHT_RULE_REFERENCE_FIELDS
      ]) {
        const ref = row as unknown as Record<string, unknown>;
        for (const field of fields) {
          const raw = String(ref[field] ?? "");
          if (
            raw.startsWith("@") &&
            !ids.has(flightIdentityKey(next, map(raw)))
          )
            errors.push(`${groupId}组存在无效档案引用${raw}`);
        }
      }
    }
    result.groups.push({
      groupId,
      affectedRules: references.filter((r) => map(r) !== r).length,
      historyRecords: workspace.history.filter((h) =>
        flightIdentityKey(next, h.flightNo, h.date).startsWith("@")
      ).length,
      needsReschedule: workspace.assignments.length > 0,
    });
  }
  result.errors = [...new Set(errors)];
  return result;
}

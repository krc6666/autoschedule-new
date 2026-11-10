import { isSameFlightSupervisorFillRule } from "../coverage/supervisor-fill-configuration";
import type {
  CrossWorkdayQualificationReservation,
  CrossFlightPriorityPolicy,
  DutyPositionPriority,
  LateShiftRecoveryPositionRule,
  MobileSupervisorCoverageRule,
  MobileSupervisorFillRule,
  NextWorkdayRecoveryTarget,
  PositionTransitionPolicy,
  SameFlightStaffExclusion,
  StructuredPolicyKey,
  StructuredSchedulePolicies,
  TeamLeaderGapFillPositionPolicy,
} from "./structured-policy-contract";

const CLOCK_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const DEFAULT_STRUCTURED_POLICIES: StructuredSchedulePolicies = {
  sameFlightStaffExclusions: [],
  crossWorkdayQualificationReservations: [],
  crossFlightPriorityPolicies: [],
  teamLeaderGapFillPositionPolicies: [],
  lateShiftRecoveryPositionRules: [
    {
      id: "late-recovery-supervisor",
      enabled: true,
      flightNo: "",
      matchField: "position",
      keyword: "督导",
      nextWorkdayCutoffTime: "",
    },
    {
      id: "late-recovery-one",
      enabled: true,
      flightNo: "",
      matchField: "remark",
      keyword: "一号",
      nextWorkdayCutoffTime: "",
    },
    {
      id: "late-recovery-declaration",
      enabled: true,
      flightNo: "",
      matchField: "remark",
      keyword: "申报",
      nextWorkdayCutoffTime: "",
    },
    {
      id: "late-recovery-delivery",
      enabled: true,
      flightNo: "",
      matchField: "remark",
      keyword: "送资料",
      nextWorkdayCutoffTime: "",
    },
  ],
  nextWorkdayRecoveryTargets: [
    {
      id: "recovery-target-cx937-one",
      flightNo: "CX937",
      positionKeyword: "一号",
      enabled: true,
    },
    {
      id: "recovery-target-cx937-control",
      flightNo: "CX937",
      positionKeyword: "控制",
      enabled: true,
    },
    {
      id: "recovery-target-ke166-one",
      flightNo: "KE166",
      positionKeyword: "一号",
      enabled: true,
    },
  ],
  dutyPositionPriorities: [
    {
      id: "duty-priority-tr121-h02",
      flightNo: "TR121",
      positionKeyword: "H02",
      enabled: true,
    },
    {
      id: "duty-priority-tw616-one",
      flightNo: "TW616",
      positionKeyword: "一号",
      enabled: true,
    },
  ],
  mobileSupervisorCoverageRules: [
    {
      id: "supervisor-forbid-one",
      enabled: true,
      flightNo: "",
      matchField: "remark",
      keyword: "一号",
      mode: "forbid",
    },
    {
      id: "supervisor-forbid-declare",
      enabled: true,
      flightNo: "",
      matchField: "remark",
      keyword: "申报",
      mode: "forbid",
    },
    {
      id: "supervisor-forbid-check",
      enabled: true,
      flightNo: "",
      matchField: "remark",
      keyword: "排查",
      mode: "forbid",
    },
  ],
  mobileSupervisorFillRules: [
    {
      id: "ke166-h05-supervisor-fill",
      requiresConfirmation: true,
      enabled: true,
      sourceFlightNo: "KE166",
      sourcePositionKeyword: "督导",
      targetFlightNo: "KE166",
      targetPositionKeyword: "H05",
      allowAutomatic: true,
      allowManual: true,
    },
  ],
  positionTransitionPolicies: [
    {
      id: "transition-cx931-tr121-h02",
      name: "TR121 H02 准备保护",
      enabled: true,
      sourceFlightNo: "CX931",
      sourcePositions: ["督导", "G20", "G19"],
      targetFlightNo: "TR121",
      targetPosition: "H02",
      minimumGapMinutes: 180,
      mode: "prefer",
    },
  ],
};

function normalizeTeamLeaderGapFillPositionPolicies(
  value: unknown,
  fallback: TeamLeaderGapFillPositionPolicy[]
): TeamLeaderGapFillPositionPolicy[] {
  const normalized = new Map<string, TeamLeaderGapFillPositionPolicy>();
  sourceArray(value, fallback)
    .filter((item) => item && typeof item === "object")
    .forEach((item) => {
      const policy = item as Partial<TeamLeaderGapFillPositionPolicy>;
      const flightNo = String(policy.flightNo ?? "")
        .trim()
        .toUpperCase();
      const position = String(policy.position ?? "").trim();
      if (!flightNo || !position || typeof policy.movable !== "boolean") return;
      normalized.set(`${flightNo}\u0000${position.toUpperCase()}`, {
        flightNo,
        position,
        movable: policy.movable,
      });
    });
  return [...normalized.values()];
}

function normalizeSameFlightStaffExclusions(
  value: unknown,
  fallback: SameFlightStaffExclusion[]
): SameFlightStaffExclusion[] {
  const unique = new Map<string, SameFlightStaffExclusion>();
  sourceArray(value, fallback)
    .filter((item) => item && typeof item === "object")
    .forEach((item, index) => {
      const exclusion = item as Partial<SameFlightStaffExclusion>;
      const firstStaffId = String(exclusion.firstStaffId ?? "").trim();
      const secondStaffId = String(exclusion.secondStaffId ?? "").trim();
      if (!firstStaffId || !secondStaffId || firstStaffId === secondStaffId)
        return;
      const flightNo = String(exclusion.flightNo ?? "")
        .trim()
        .toUpperCase();
      const pair = [firstStaffId, secondStaffId].sort();
      const key = `${pair[0]}\u0000${pair[1]}\u0000${flightNo}`;
      if (unique.has(key)) return;
      unique.set(key, {
        id:
          String(exclusion.id ?? "").trim() ||
          `same-flight-staff-exclusion-${index + 1}`,
        enabled: exclusion.enabled !== false,
        firstStaffId: pair[0]!,
        secondStaffId: pair[1]!,
        flightNo,
      });
    });
  return [...unique.values()];
}

function sourceArray<T>(value: unknown, fallback: T[]): T[] {
  return Array.isArray(value) ? value : fallback;
}

function normalizeTransitionPolicies(
  value: unknown,
  fallback: PositionTransitionPolicy[]
): PositionTransitionPolicy[] {
  return sourceArray(value, fallback)
    .filter((item) => item && typeof item === "object")
    .map((item, index) => {
      const policy = item as Partial<PositionTransitionPolicy>;
      const minimumGapMinutes = Number(policy.minimumGapMinutes);
      return {
        id: String(policy.id ?? "").trim() || `transition-policy-${index + 1}`,
        name: String(policy.name ?? "").trim() || "未命名衔接规则",
        enabled: policy.enabled !== false,
        sourceFlightNo: String(policy.sourceFlightNo ?? "")
          .trim()
          .toUpperCase(),
        sourcePositions: Array.isArray(policy.sourcePositions)
          ? policy.sourcePositions
              .map((position) => String(position).trim())
              .filter(Boolean)
          : [],
        targetFlightNo: String(policy.targetFlightNo ?? "")
          .trim()
          .toUpperCase(),
        targetPosition: String(policy.targetPosition ?? "").trim(),
        minimumGapMinutes: Math.min(
          1440,
          Math.max(
            0,
            Number.isFinite(minimumGapMinutes)
              ? Math.round(minimumGapMinutes)
              : 0
          )
        ),
        mode: policy.mode === "forbid" ? "forbid" : "prefer",
      };
    });
}

function normalizeDutyPriorities(
  value: unknown,
  fallback: DutyPositionPriority[]
): DutyPositionPriority[] {
  return sourceArray(value, fallback)
    .filter((item) => item && typeof item === "object")
    .map((item, index) => {
      const priority = item as Partial<DutyPositionPriority>;
      return {
        id: String(priority.id ?? "").trim() || `duty-priority-${index + 1}`,
        flightNo: String(priority.flightNo ?? "")
          .trim()
          .toUpperCase(),
        positionKeyword: String(priority.positionKeyword ?? "").trim(),
        enabled: priority.enabled !== false,
      };
    });
}

function normalizeRecoveryTargets(
  value: unknown,
  fallback: NextWorkdayRecoveryTarget[]
): NextWorkdayRecoveryTarget[] {
  return sourceArray(value, fallback)
    .filter((item) => item && typeof item === "object")
    .map((item, index) => {
      const target = item as Partial<NextWorkdayRecoveryTarget>;
      return {
        id: String(target.id ?? "").trim() || `recovery-target-${index + 1}`,
        flightNo: String(target.flightNo ?? "")
          .trim()
          .toUpperCase(),
        positionKeyword: String(target.positionKeyword ?? "").trim(),
        enabled: target.enabled !== false,
      };
    });
}

function normalizeLateShiftRules(
  value: unknown,
  fallback: LateShiftRecoveryPositionRule[]
): LateShiftRecoveryPositionRule[] {
  return sourceArray(value, fallback)
    .filter((item) => item && typeof item === "object")
    .map((item, index) => {
      const rule = item as Partial<LateShiftRecoveryPositionRule>;
      const cutoff = String(rule.nextWorkdayCutoffTime ?? "");
      return {
        id:
          String(rule.id ?? "").trim() || `late-recovery-position-${index + 1}`,
        enabled: rule.enabled !== false,
        flightNo: String(rule.flightNo ?? "")
          .trim()
          .toUpperCase(),
        matchField: rule.matchField === "position" ? "position" : "remark",
        keyword: String(rule.keyword ?? "").trim(),
        nextWorkdayCutoffTime: CLOCK_PATTERN.test(cutoff) ? cutoff : "",
      };
    });
}

function normalizeSupervisorRules(
  value: unknown,
  fallback: MobileSupervisorCoverageRule[]
): MobileSupervisorCoverageRule[] {
  return sourceArray(value, fallback)
    .filter((item) => item && typeof item === "object")
    .map((item, index) => {
      const rule = item as Partial<MobileSupervisorCoverageRule>;
      return {
        id: String(rule.id ?? "").trim() || `supervisor-coverage-${index + 1}`,
        enabled: rule.enabled !== false,
        flightNo: String(rule.flightNo ?? "")
          .trim()
          .toUpperCase(),
        matchField: rule.matchField === "position" ? "position" : "remark",
        keyword: String(rule.keyword ?? "").trim(),
        mode: rule.mode === "allow" ? "allow" : "forbid",
      };
    });
}

function normalizeSupervisorFillRules(
  value: unknown,
  fallback: MobileSupervisorFillRule[]
): MobileSupervisorFillRule[] {
  const unique = new Map<string, MobileSupervisorFillRule>();
  sourceArray(value, fallback)
    .filter((item) => item && typeof item === "object")
    .forEach((item, index) => {
      const rule = item as Partial<MobileSupervisorFillRule>;
      const sourceFlightNo = String(rule.sourceFlightNo ?? "")
        .trim()
        .toUpperCase();
      const sourcePositionKeyword = String(
        rule.sourcePositionKeyword ?? ""
      ).trim();
      const targetFlightNo = String(rule.targetFlightNo ?? "")
        .trim()
        .toUpperCase();
      const targetPositionKeyword = String(
        rule.targetPositionKeyword ?? ""
      ).trim();
      const requiresConfirmation = !isSameFlightSupervisorFillRule({
        sourceFlightNo,
        targetFlightNo,
      })
        ? true
        : rule.requiresConfirmation === undefined
          ? undefined
          : rule.requiresConfirmation !== false;
      if (
        (!sourceFlightNo && !requiresConfirmation) ||
        (!sourcePositionKeyword && !requiresConfirmation) ||
        !targetFlightNo ||
        !targetPositionKeyword
      )
        return;
      const normalized: MobileSupervisorFillRule = {
        id: String(rule.id ?? "").trim() || `supervisor-fill-${index + 1}`,
        enabled: rule.enabled !== false,
        sourceFlightNo,
        sourcePositionKeyword,
        targetFlightNo,
        targetPositionKeyword,
        allowAutomatic: rule.allowAutomatic !== false,
        allowManual: rule.allowManual !== false,
        ...(requiresConfirmation !== undefined ? { requiresConfirmation } : {}),
      };
      unique.set(
        [
          sourceFlightNo,
          sourcePositionKeyword.toLocaleLowerCase("zh-CN"),
          targetFlightNo,
          targetPositionKeyword.toLocaleLowerCase("zh-CN"),
        ].join("\u0000"),
        normalized
      );
    });
  return [...unique.values()];
}

function normalizeCrossWorkdayReservations(
  value: unknown,
  fallback: CrossWorkdayQualificationReservation[]
): CrossWorkdayQualificationReservation[] {
  return sourceArray(value, fallback)
    .filter((item) => item && typeof item === "object")
    .map((item, index) => {
      const reservation = item as Partial<CrossWorkdayQualificationReservation>;
      const minimumStaffCount = Number(reservation.minimumStaffCount);
      return {
        id:
          String(reservation.id ?? "").trim() ||
          `cross-workday-reservation-${index + 1}`,
        enabled: reservation.enabled !== false,
        flightNo: String(reservation.flightNo ?? "")
          .trim()
          .toUpperCase(),
        matchField:
          reservation.matchField === "position" ? "position" : "remark",
        keyword: String(reservation.keyword ?? "").trim(),
        minimumStaffCount: Math.min(
          50,
          Math.max(
            1,
            Number.isFinite(minimumStaffCount)
              ? Math.round(minimumStaffCount)
              : 1
          )
        ),
      };
    });
}

function normalizeCrossFlightPriorityPolicies(
  value: unknown,
  fallback: CrossFlightPriorityPolicy[]
): CrossFlightPriorityPolicy[] {
  return sourceArray(value, fallback)
    .filter((item) => item && typeof item === "object")
    .map((item, index) => {
      const policy = item as Partial<CrossFlightPriorityPolicy>;
      return {
        id:
          String(policy.id ?? "").trim() ||
          `cross-flight-priority-${index + 1}`,
        enabled: policy.enabled !== false,
        flightNo: String(policy.flightNo ?? "")
          .trim()
          .toUpperCase(),
        staffIds: Array.isArray(policy.staffIds)
          ? [
              ...new Set(
                policy.staffIds
                  .map((staffId) => String(staffId).trim())
                  .filter(Boolean)
              ),
            ]
          : [],
      };
    });
}

export interface StructuredPolicyDefinition<K extends StructuredPolicyKey> {
  key: K;
  createDefault: () => StructuredSchedulePolicies[K];
  normalize: (
    value: unknown,
    fallback: StructuredSchedulePolicies[K]
  ) => StructuredSchedulePolicies[K];
  excelSheet: string;
  uiCollection: string;
  uiEntity: string;
}

type StructuredPolicyDefinitionMap = {
  [K in StructuredPolicyKey]: StructuredPolicyDefinition<K>;
};

export const STRUCTURED_POLICY_DEFINITIONS = {
  sameFlightStaffExclusions: {
    key: "sameFlightStaffExclusions",
    createDefault: () =>
      structuredClone(DEFAULT_STRUCTURED_POLICIES.sameFlightStaffExclusions),
    normalize: normalizeSameFlightStaffExclusions,
    excelSheet: "同航班人员互斥",
    uiCollection: "same-flight-staff-exclusion",
    uiEntity: "same-flight-staff-exclusion",
  },
  positionTransitionPolicies: {
    key: "positionTransitionPolicies",
    createDefault: () =>
      structuredClone(DEFAULT_STRUCTURED_POLICIES.positionTransitionPolicies),
    normalize: normalizeTransitionPolicies,
    excelSheet: "岗位衔接规则",
    uiCollection: "transition",
    uiEntity: "transition-policy",
  },
  dutyPositionPriorities: {
    key: "dutyPositionPriorities",
    createDefault: () =>
      structuredClone(DEFAULT_STRUCTURED_POLICIES.dutyPositionPriorities),
    normalize: normalizeDutyPriorities,
    excelSheet: "值班岗位优先",
    uiCollection: "duty",
    uiEntity: "duty-priority",
  },
  nextWorkdayRecoveryTargets: {
    key: "nextWorkdayRecoveryTargets",
    createDefault: () =>
      structuredClone(DEFAULT_STRUCTURED_POLICIES.nextWorkdayRecoveryTargets),
    normalize: normalizeRecoveryTargets,
    excelSheet: "次班恢复目标",
    uiCollection: "recovery-target",
    uiEntity: "recovery-target",
  },
  lateShiftRecoveryPositionRules: {
    key: "lateShiftRecoveryPositionRules",
    createDefault: () =>
      structuredClone(
        DEFAULT_STRUCTURED_POLICIES.lateShiftRecoveryPositionRules
      ),
    normalize: normalizeLateShiftRules,
    excelSheet: "末班重点岗位",
    uiCollection: "late-position",
    uiEntity: "late-shift-recovery-position",
  },
  mobileSupervisorCoverageRules: {
    key: "mobileSupervisorCoverageRules",
    createDefault: () =>
      structuredClone(
        DEFAULT_STRUCTURED_POLICIES.mobileSupervisorCoverageRules
      ),
    normalize: normalizeSupervisorRules,
    excelSheet: "机动督导范围",
    uiCollection: "supervisor",
    uiEntity: "supervisor-coverage",
  },
  mobileSupervisorFillRules: {
    key: "mobileSupervisorFillRules",
    createDefault: () =>
      structuredClone(DEFAULT_STRUCTURED_POLICIES.mobileSupervisorFillRules),
    normalize: normalizeSupervisorFillRules,
    excelSheet: "督导补位关系",
    uiCollection: "supervisor-fill",
    uiEntity: "supervisor-fill",
  },
  crossWorkdayQualificationReservations: {
    key: "crossWorkdayQualificationReservations",
    createDefault: () =>
      structuredClone(
        DEFAULT_STRUCTURED_POLICIES.crossWorkdayQualificationReservations
      ),
    normalize: normalizeCrossWorkdayReservations,
    excelSheet: "跨工作日资质预留",
    uiCollection: "cross-workday-reservation",
    uiEntity: "cross-workday-reservation",
  },
  crossFlightPriorityPolicies: {
    key: "crossFlightPriorityPolicies",
    createDefault: () =>
      structuredClone(DEFAULT_STRUCTURED_POLICIES.crossFlightPriorityPolicies),
    normalize: normalizeCrossFlightPriorityPolicies,
    excelSheet: "跨航班重点人员优先",
    uiCollection: "cross-flight-priority",
    uiEntity: "cross-flight-priority",
  },
  teamLeaderGapFillPositionPolicies: {
    key: "teamLeaderGapFillPositionPolicies",
    createDefault: () =>
      structuredClone(
        DEFAULT_STRUCTURED_POLICIES.teamLeaderGapFillPositionPolicies
      ),
    normalize: normalizeTeamLeaderGapFillPositionPolicies,
    excelSheet: "分队长补差保护范围",
    uiCollection: "team-leader-gap-fill",
    uiEntity: "team-leader-gap-fill",
  },
} as const satisfies StructuredPolicyDefinitionMap;

export const STRUCTURED_POLICY_KEYS = Object.keys(
  STRUCTURED_POLICY_DEFINITIONS
) as StructuredPolicyKey[];

export function createDefaultStructuredPolicies(): StructuredSchedulePolicies {
  const defaults = {} as StructuredSchedulePolicies;
  for (const definition of Object.values(STRUCTURED_POLICY_DEFINITIONS)) {
    defaults[definition.key] = definition.createDefault() as never;
  }
  return defaults;
}

function normalizeStructuredPolicy<K extends StructuredPolicyKey>(
  key: K,
  input: Partial<StructuredSchedulePolicies>,
  fallback: StructuredSchedulePolicies
): StructuredSchedulePolicies[K] {
  const definition = STRUCTURED_POLICY_DEFINITIONS[
    key
  ] as unknown as StructuredPolicyDefinition<K>;
  return definition.normalize(input[definition.key], fallback[definition.key]);
}

export function normalizeStructuredPolicies(
  input: Partial<StructuredSchedulePolicies>,
  fallback = createDefaultStructuredPolicies()
): StructuredSchedulePolicies {
  const normalized = {} as StructuredSchedulePolicies;
  for (const key of STRUCTURED_POLICY_KEYS) {
    normalized[key] = normalizeStructuredPolicy(key, input, fallback) as never;
  }
  return normalized;
}

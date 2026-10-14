import { describe, expect, it } from "vitest";
import {
  applyTeamLeaderGapFillPreview,
  planTeamLeaderGapFill,
  teamLeaderGapFillFingerprint,
} from "../../src/domain/coverage/team-leader-gap-fill";
import { defaultHighsSolver } from "../../src/infrastructure/solver/highs-solver";
import type { Assignment, PositionRule } from "../../src/model";
import {
  createSupervisorGapFillScenario,
  SUPERVISOR_GAP_FILL_DATE,
} from "../helpers/supervisor-gap-fill";

type Scenario = ReturnType<typeof createSupervisorGapFillScenario>;

function plan({ state, leader, vacancy }: Scenario, vacancyIds = [vacancy.id]) {
  return planTeamLeaderGapFill({
    solver: defaultHighsSolver,
    state,
    date: SUPERVISOR_GAP_FILL_DATE,
    teamLeaderId: leader.id,
    vacancyAssignmentIds: vacancyIds,
  });
}

describe("team leader supervisor gap fill", () => {
  it("directly fills a qualified non-KE166 mobile supervisor and clears old vacancy evidence", async () => {
    const scenario = createSupervisorGapFillScenario(true);
    const before = structuredClone(scenario.state.assignments);
    const result = await plan(scenario);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error(result.reasons.join("；"));
    expect(scenario.state.assignments).toEqual(before);
    expect(result.preview.changes).toEqual([
      expect.objectContaining({
        assignmentId: scenario.vacancy.id,
        toStaffId: scenario.leader.id,
        workHours: 2,
      }),
    ]);
    const applied = applyTeamLeaderGapFillPreview(
      scenario.state,
      result.preview
    );
    expect(applied.kind).toBe("applied");
    if (applied.kind !== "applied") throw new Error(applied.reasons.join("；"));
    expect(
      applied.assignments.find((row) => row.id === scenario.vacancy.id)
    ).toMatchObject({
      staffId: scenario.leader.id,
      status: "assigned",
      workHours: 2,
      fatiguePoints: 9,
      teamLeaderGapFill: true,
    });
    expect(
      applied.assignments.find((row) => row.id === scenario.vacancy.id)
        ?.systemNotes
    ).toBeUndefined();
    expect(
      applied.assignments.find((row) => row.id === scenario.source.id)
    ).toEqual(scenario.source);
  });

  it("fills the supervisor through a qualification chain when the leader cannot take it", async () => {
    const scenario = createSupervisorGapFillScenario();
    expect(scenario.vacancyRule.qualifiedStaffIds).not.toContain(
      scenario.leader.id
    );
    const before = structuredClone(scenario.state.assignments);
    const result = await plan(scenario);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error(result.reasons.join("；"));
    expect(scenario.state.assignments).toEqual(before);
    expect(result.preview.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assignmentId: scenario.source.id,
          toStaffId: scenario.leader.id,
        }),
        expect.objectContaining({
          assignmentId: scenario.vacancy.id,
          toStaffId: scenario.worker.id,
        }),
      ])
    );
    const applied = applyTeamLeaderGapFillPreview(
      scenario.state,
      result.preview
    );
    expect(applied.kind).toBe("applied");
    if (applied.kind !== "applied") throw new Error(applied.reasons.join("；"));
    expect(
      applied.assignments.filter(
        (row) => row.status === "assigned" && row.staffId
      )
    ).toHaveLength(2);
    expect(
      applied.assignments.every((row) => !row.supervisorSourceAssignmentId)
    ).toBe(true);
    expect(
      applied.assignments.find((row) => row.id === scenario.source.id)
        ?.teamLeaderGapFill
    ).toBe(true);
    expect(
      applied.assignments.find((row) => row.id === scenario.vacancy.id)
        ?.teamLeaderGapFill
    ).toBeUndefined();
  });

  it("fills regular and supervisor vacancies in one atomic batch", async () => {
    const scenario = createSupervisorGapFillScenario(true);
    const extraWorker = { ...scenario.worker, id: "extra", name: "员工丙" };
    scenario.state.staff.push(extraWorker);
    const extraRule: PositionRule = {
      ...scenario.vacancyRule,
      id: "counter-rule",
      name: "G12",
      category: "常规",
      qualifiedStaffIds: [extraWorker.id],
    };
    const extraVacancy: Assignment = {
      ...scenario.vacancy,
      id: "counter-vacancy",
      positionRuleId: extraRule.id,
      position: extraRule.name,
    };
    scenario.state.positionRules.push(extraRule);
    scenario.state.assignments.push(extraVacancy);
    const result = await plan(scenario, [scenario.vacancy.id, extraVacancy.id]);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error(result.reasons.join("；"));
    const applied = applyTeamLeaderGapFillPreview(
      scenario.state,
      result.preview
    );
    expect(applied.kind).toBe("applied");
    if (applied.kind !== "applied") throw new Error(applied.reasons.join("；"));
    expect(
      applied.assignments.filter((row) => row.status === "unfilled")
    ).toHaveLength(0);
    expect(
      applied.assignments.find((row) => row.id === extraVacancy.id)?.staffId
    ).toBe(extraWorker.id);
  });

  const excluded: { label: string; change: (scenario: Scenario) => void }[] = [
    {
      label: "KE166",
      change: ({ vacancy, vacancyRule, vacancyFlight }) => {
        vacancy.flightNo =
          vacancyRule.flightNo =
          vacancyFlight.flightNo =
            "KE166";
      },
    },
    {
      label: "manual position",
      change: ({ vacancyRule }) => {
        vacancyRule.manual = true;
      },
    },
    {
      label: "administrative position",
      change: ({ vacancyRule }) => {
        vacancyRule.category = "行政支援";
      },
    },
    {
      label: "ordinary guide target",
      change: ({ vacancyRule }) => {
        vacancyRule.category = "引导";
      },
    },
    {
      label: "diversion target",
      change: ({ vacancyRule }) => {
        vacancyRule.category = "分流";
      },
    },
  ];
  it.each(excluded)(
    "keeps $label outside the target range in planning and confirmation",
    async ({ change }) => {
      const scenario = createSupervisorGapFillScenario(true);
      change(scenario);
      const before = structuredClone(scenario.state.assignments);
      expect(await plan(scenario)).toMatchObject({ kind: "unavailable" });
      expect(
        applyTeamLeaderGapFillPreview(scenario.state, {
          date: SUPERVISOR_GAP_FILL_DATE,
          teamLeaderId: scenario.leader.id,
          vacancyAssignmentIds: [scenario.vacancy.id],
          baselineFingerprint: teamLeaderGapFillFingerprint(
            scenario.state.assignments
          ),
          changes: [
            {
              assignmentId: scenario.vacancy.id,
              flightNo: scenario.vacancy.flightNo,
              position: scenario.vacancy.position,
              fromStaffId: null,
              fromStaffName: "",
              toStaffId: scenario.leader.id,
              toStaffName: scenario.leader.name,
              workHours: 2,
            },
          ],
          warnings: [],
          rejectedCandidates: [],
        })
      ).toMatchObject({ kind: "rejected" });
      expect(scenario.state.assignments).toEqual(before);
    }
  );

  it("does not unlock an occupied mobile supervisor to close a qualification chain", async () => {
    const scenario = createSupervisorGapFillScenario();
    scenario.state.positionRules[0]!.category = "机动督导";
    scenario.state.positionRules[0]!.name = scenario.source.position = "督导";
    const before = structuredClone(scenario.state.assignments);
    const result = await plan(scenario);
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable")
      throw new Error("protected source moved");
    expect(result.reasons.join("；")).toContain("机动督导岗位默认保护");
    expect(scenario.state.assignments).toEqual(before);
  });

  it("rejects a real overlap with another protected supervisor instead of enabling parallel supervision", async () => {
    const scenario = createSupervisorGapFillScenario(true);
    scenario.state.positionRules[0]!.category = "机动督导";
    scenario.state.positionRules[0]!.name = scenario.source.position = "督导";
    scenario.source.staffId = scenario.leader.id;
    scenario.source.staffName = scenario.leader.name;
    const before = structuredClone(scenario.state.assignments);
    const result = await plan(scenario);
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable")
      throw new Error("parallel supervision allowed");
    expect(result.reasons.join("；")).toMatch(/时间冲突/);
    expect(scenario.state.assignments).toEqual(before);
  });

  it("rejects an unqualified leader without a complete chain and leaves the original schedule", async () => {
    const scenario = createSupervisorGapFillScenario();
    scenario.vacancyRule.qualifiedStaffIds = [];
    const before = structuredClone(scenario.state.assignments);
    const result = await plan(scenario);
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable")
      throw new Error("unqualified supervisor assigned");
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(scenario.state.assignments).toEqual(before);
  });

  const laterChanges: {
    label: string;
    change: (scenario: Scenario) => void;
  }[] = [
    {
      label: "supervisor qualification removed",
      change: ({ vacancyRule }) => {
        vacancyRule.qualifiedStaffIds = [];
      },
    },
    {
      label: "leader loses night capability",
      change: ({ leader }) => {
        leader.nightShift = false;
      },
    },
    {
      label: "supervisor becomes manual",
      change: ({ vacancyRule }) => {
        vacancyRule.manual = true;
      },
    },
    {
      label: "supervisor category changes",
      change: ({ vacancyRule }) => {
        vacancyRule.category = "引导";
      },
    },
    {
      label: "source becomes protected",
      change: ({ state, source }) => {
        state.settings.teamLeaderGapFillPositionPolicies.push({
          flightNo: source.flightNo,
          position: source.position,
          movable: false,
        });
      },
    },
    {
      label: "hours limit decreases",
      change: ({ state }) => {
        state.settings.maxDailyHours = 1;
      },
    },
  ];
  it.each(laterChanges)(
    "rejects a previously legal chain after $label",
    async ({ change }) => {
      const scenario = createSupervisorGapFillScenario();
      const result = await plan(scenario);
      expect(result.kind).toBe("ready");
      if (result.kind !== "ready") throw new Error(result.reasons.join("；"));
      change(scenario);
      const before = structuredClone(scenario.state.assignments);
      expect(
        applyTeamLeaderGapFillPreview(scenario.state, result.preview)
      ).toMatchObject({ kind: "rejected" });
      expect(scenario.state.assignments).toEqual(before);
    }
  );
});

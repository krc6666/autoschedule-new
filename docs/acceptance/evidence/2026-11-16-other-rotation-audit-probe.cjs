const { createRequire } = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
const req = createRequire(process.cwd() + "/package.json");

(async () => {
  const { createServer } = await import(
    pathToFileURL(req.resolve("vite")).href
  );
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const load = (p) => server.ssrLoadModule("/src/" + p + ".ts");
    const { createDefaultState } = await load("defaults");
    const frequency = await load("domain/statistics/schedule-frequency");
    const lateFrequency = await load(
      "domain/statistics/late-priority-frequency"
    );
    const { reassignmentSafetyReasons } = await load(
      "domain/reviews/rotation-review-safety"
    );
    const { defaultHighsSolver } = await load(
      "infrastructure/solver/highs-solver"
    );
    const { reviewSamePositionFrequency } = await load(
      "domain/reviews/position-frequency-review"
    );
    const { reviewConsecutivePositionRotation } = await load(
      "domain/reviews/position-rotation-review"
    );
    const { generateSchedule } = await load("domain/kernel/scheduling-kernel");
    const { createScheduleRunFacts } = await load(
      "domain/shared/schedule-run-facts"
    );
    const { createScheduleSafetySession } = await load(
      "domain/kernel/schedule-safety-session"
    );
    const { balanceRelaxedShifts } = await load(
      "domain/reviews/relaxed-shift-balance"
    );
    const { improveStaffWorkContinuity, staffWorkContinuity } = await load(
      "domain/reviews/staff-work-continuity"
    );
    const date = "2026-11-18";
    function scenario(category = "常规") {
      const state = createDefaultState();
      state.staff = state.staff
        .filter((p) => p.status === "正常")
        .slice(0, 2)
        .map((p, i) => ({
          ...p,
          id: "person-" + i,
          name: "人员" + i,
          teamLeader: false,
          dutyQualified: false,
          cxPreflightQualified: false,
          standbyQualified: false,
          nightShift: true,
        }));
      Object.assign(state.settings, {
        dailyPrimaryPositionUniqueEnabled: false,
        lateShiftRecoveryEnabled: false,
        highLoadProtectionEnabled: false,
        rollingLoadProtectionEnabled: false,
        workloadBalanceEnabled: false,
        positionRotationEnabled: true,
        positionTransitionPolicies: [],
        crossWorkdayQualificationReservations: [],
        airlineMixPolicies: [],
        latePriorityFlightNumbers: [],
        earlyDepartureBalanceEnabled: false,
        afternoonRestBalanceEnabled: false,
        highLoadFatigueThreshold: 4,
      });
      const f = {
        id: "flight",
        flightNo: "KE160",
        startTime: "09:50",
        endTime: "11:50",
        bookedPassengers: 100,
        positions: [],
        remark: "",
      };
      state.flights = [f];
      const base = state.positionRules[0];
      state.positionRules = [
        {
          ...base,
          id: "priority",
          flightNo: f.flightNo,
          name: "督导",
          category,
          manual: false,
          fatiguePoints: 2,
          earlyReleaseMinutes: 0,
          remark: "",
          qualifiedStaffIds: state.staff.map((p) => p.id),
        },
        {
          ...base,
          id: "ordinary",
          flightNo: f.flightNo,
          name: "H03",
          category: "常规",
          manual: false,
          fatiguePoints: 1,
          earlyReleaseMinutes: 0,
          remark: "",
          qualifiedStaffIds: state.staff.map((p) => p.id),
        },
      ];
      state.settings.ordinaryPriorityPositions = [
        { airlineCode: "KE", position: "督导" },
      ];
      const row = (rule, person) => ({
        id: rule.id,
        flightId: f.id,
        flightNo: f.flightNo,
        positionRuleId: rule.id,
        position: rule.name,
        staffId: person.id,
        staffName: person.name,
        startTime: f.startTime,
        endTime: f.endTime,
        workHours: 2,
        fatiguePoints: rule.fatiguePoints,
        remark: "",
        manualRemark: "",
        status: "assigned",
      });
      state.assignments = [
        row(state.positionRules[0], state.staff[0]),
        row(state.positionRules[1], state.staff[1]),
      ];
      const history = (
        person,
        day,
        position = "督导",
        flightNo = "KE999",
        startTime = "09:50",
        endTime = "11:50"
      ) => ({
        id: day + "-" + person.id + "-" + position,
        date: day,
        flightNo,
        position,
        staffId: person.id,
        staffName: person.name,
        startTime,
        endTime,
        workHours: 2,
        fatiguePoints: 2,
        remark: "",
      });
      state.history = [
        history(state.staff[0], "2026-11-16"),
        history(state.staff[1], "2026-11-10"),
        history(state.staff[1], "2026-11-12"),
        history(state.staff[1], "2026-11-14"),
      ];
      return { state, history };
    }
    const report = {
      date,
      scope:
        "read-only anonymous domain probes; no product implementation edits",
      consecutiveVersusFrequency: [],
      monthlyFinalizer: [],
      continuityFinalizer: null,
    };
    for (const category of ["常规", "分流", "机动督导"]) {
      const { state } = scenario(category);
      const profile = (id) =>
        frequency.positionFrequencyProfileForAssignment(
          state,
          state.assignments[0],
          id,
          date
        );
      const before = {
        staffId: state.assignments[0].staffId,
        profile: profile(state.assignments[0].staffId),
        runs: frequency.consecutivePositionAssignments(
          state,
          state.assignments[0].staffId,
          "KE160",
          "督导",
          "",
          date
        ),
      };
      const safety = {};
      for (const kind of [
        "consecutive-rotation-review",
        "staff-work-continuity-review",
        "late-shift-recovery-review",
      ]) {
        safety[kind] = reassignmentSafetyReasons({
          kind: "plan",
          state,
          assignments: state.assignments,
          changes: [
            { assignmentId: "priority", staffId: "person-1" },
            { assignmentId: "ordinary", staffId: "person-0" },
          ],
          primaryAssignmentId: "priority",
          date,
          frequencyFacts: frequency.createScheduleFrequencyFacts(state, date),
          intent: { kind },
        });
      }
      await reviewSamePositionFrequency(
        defaultHighsSolver,
        state,
        state.assignments,
        date,
        new Set()
      );
      const afterFrequency = state.assignments[0].staffId;
      const consecutiveWarnings = await reviewConsecutivePositionRotation(
        defaultHighsSolver,
        state,
        state.assignments,
        date,
        new Set()
      );
      const afterConsecutive = {
        staffId: state.assignments[0].staffId,
        profile: profile(state.assignments[0].staffId),
        runs: frequency.consecutivePositionAssignments(
          state,
          state.assignments[0].staffId,
          "KE160",
          "督导",
          "",
          date
        ),
      };
      const generated = await generateSchedule(
        { ...state, assignments: [] },
        date,
        { solver: defaultHighsSolver }
      );
      const generatedPriority = generated.assignments.find(
        (a) => a.positionRuleId === "priority"
      );
      report.consecutiveVersusFrequency.push({
        category,
        before,
        safety,
        afterFrequency,
        afterConsecutive,
        consecutiveWarnings,
        fullKernelPriorityStaffId: generatedPriority?.staffId,
        fullKernelUnfilledCount: generated.unfilledCount,
        fullKernelCredentialPhase: generated.safetyCredential?.phase,
      });
    }
    for (const variant of [
      "ordinary-priority",
      "high-fatigue-ordinary",
      "low-fatigue-ordinary",
      "late-priority",
    ]) {
      const { state, history } = scenario();
      const targetName =
        variant === "ordinary-priority" || variant === "late-priority"
          ? "督导"
          : "H07";
      if (variant !== "ordinary-priority")
        state.settings.ordinaryPriorityPositions = [];
      state.positionRules[0].name = targetName;
      state.positionRules[0].fatiguePoints =
        variant === "high-fatigue-ordinary" ? 6 : 2;
      const early = {
        ...state.flights[0],
        id: "early",
        flightNo: "CX100",
        startTime: "09:00",
        endTime: "11:00",
      };
      const late = {
        ...state.flights[0],
        id: "late",
        flightNo: "KE160",
        startTime: "17:00",
        endTime: "19:00",
      };
      if (variant === "late-priority") {
        late.startTime = "21:55";
        late.endTime = "23:55";
        state.settings.lateShiftEndTime = "23:00";
        state.settings.latePriorityFlightNumbers = ["KE160", "KE999"];
      }
      state.flights = [early, late];
      state.positionRules[0].flightNo = late.flightNo;
      state.positionRules[1].flightNo = early.flightNo;
      if (variant === "late-priority")
        state.positionRules.push({
          ...state.positionRules[0],
          id: "history-rule",
          flightNo: "KE999",
        });
      state.assignments = [
        {
          ...state.assignments[0],
          position: targetName,
          fatiguePoints: state.positionRules[0].fatiguePoints,
          flightId: late.id,
          flightNo: late.flightNo,
          staffId: "person-1",
          staffName: "人员1",
          startTime: late.startTime,
          endTime: late.endTime,
        },
        {
          ...state.assignments[1],
          flightId: early.id,
          flightNo: early.flightNo,
          staffId: "person-0",
          staffName: "人员0",
          startTime: early.startTime,
          endTime: early.endTime,
        },
      ];
      state.history = [
        history(state.staff[0], "2026-11-10", "H03", "CX100", "09:00", "11:00"),
        history(state.staff[0], "2026-11-12", "H03", "CX100", "09:00", "11:00"),
        history(
          state.staff[0],
          "2026-11-14",
          targetName,
          "KE999",
          "17:00",
          "19:00"
        ),
        history(
          state.staff[0],
          "2026-11-16",
          targetName,
          "KE999",
          "17:00",
          "19:00"
        ),
      ];
      if (variant === "late-priority")
        state.history
          .filter((h) => h.flightNo === "KE999")
          .forEach((h) => {
            h.startTime = late.startTime;
            h.endTime = late.endTime;
          });
      Object.assign(state.settings, {
        earlyDepartureBalanceEnabled: true,
        earlyDepartureCutoffTime: "16:00",
        earlyDepartureMaxDifference: 0,
        afternoonRestBalanceEnabled: false,
      });
      const facts = createScheduleRunFacts(state, date);
      const session = createScheduleSafetySession({
        state,
        date,
        phase: "final",
        runFacts: facts,
        warningSink: [],
      });
      const primary = state.assignments[0];
      const before = {
        staffId: primary.staffId,
        profile: frequency.positionFrequencyProfileForAssignment(
          state,
          primary,
          primary.staffId,
          date
        ),
        runs: frequency.consecutivePositionAssignments(
          state,
          primary.staffId,
          "KE160",
          targetName,
          "",
          date
        ),
      };
      session.assertAssignmentsSafe(state.assignments);
      const result = balanceRelaxedShifts({
        state,
        date,
        assignments: state.assignments,
        lockedAssignmentIds: new Set(),
        assertSafe: (p) => session.assertAssignmentsSafe(p),
      });
      const changed = result.find((a) => a.positionRuleId === "priority");
      const generated = await generateSchedule(
        { ...state, assignments: [] },
        date,
        { solver: defaultHighsSolver }
      );
      report.monthlyFinalizer.push({
        variant,
        before,
        after: {
          staffId: changed.staffId,
          profile: frequency.positionFrequencyProfileForAssignment(
            state,
            changed,
            changed.staffId,
            date
          ),
          runs: frequency.consecutivePositionAssignments(
            state,
            changed.staffId,
            "KE160",
            targetName,
            "",
            date
          ),
        },
        ...(variant === "late-priority"
          ? {
              latePriorityBefore:
                lateFrequency.latePriorityFrequencyProfileForRule(
                  state,
                  primary.staffId,
                  late,
                  state.positionRules[0],
                  date
                ),
              latePriorityAfter:
                lateFrequency.latePriorityFrequencyProfileForRule(
                  state,
                  changed.staffId,
                  late,
                  state.positionRules[0],
                  date
                ),
            }
          : {}),
        finalSessionAccepted: true,
        warnings: session.warnings(),
        assignments: result.map((a) => ({
          position: a.position,
          staffId: a.staffId,
        })),
        fullKernelPriorityStaffId: generated.assignments.find(
          (a) => a.positionRuleId === "priority"
        )?.staffId,
        fullKernelUnfilledCount: generated.unfilledCount,
        fullKernelCredentialPhase: generated.safetyCredential?.phase,
      });
    }
    {
      const { state, history } = scenario();
      state.flights = [
        ["morning", "CX100", "08:00", "10:00"],
        ["middle", "MF100", "12:00", "14:00"],
        ["afternoon", "TW100", "15:00", "17:00"],
        ["last", "KE160", "20:00", "22:00"],
      ].map(([id, flightNo, startTime, endTime]) => ({
        id,
        flightNo,
        startTime,
        endTime,
        positions: [],
        remark: "",
        bookedPassengers: 100,
      }));
      const base = state.positionRules[0];
      state.positionRules = state.flights.map((f) => ({
        ...base,
        id: f.id,
        flightNo: f.flightNo,
        name: f.id === "last" ? "督导" : "H03",
        category: "常规",
        fatiguePoints: 2,
      }));
      state.assignments = state.flights.map((f, i) => {
        const rule = state.positionRules[i],
          p = state.staff[i === 0 || i === 3 ? 0 : 1];
        return {
          id: f.id,
          flightId: f.id,
          flightNo: f.flightNo,
          positionRuleId: rule.id,
          position: rule.name,
          staffId: p.id,
          staffName: p.name,
          startTime: f.startTime,
          endTime: f.endTime,
          workHours: 2,
          fatiguePoints: 2,
          remark: "",
          manualRemark: "",
          status: "assigned",
        };
      });
      state.history = ["2026-11-10", "2026-11-12", "2026-11-14"].map((d) =>
        history(state.staff[1], d)
      );
      state.history.push(
        history(state.staff[0], "2026-11-16", "H03", "CX999", "08:00", "10:00")
      );
      const facts = createScheduleRunFacts(state, date);
      const session = createScheduleSafetySession({
        state,
        date,
        phase: "final",
        runFacts: facts,
        warningSink: [],
      });
      const before = {
        staffId: state.assignments[3].staffId,
        profile: frequency.positionFrequencyProfileForAssignment(
          state,
          state.assignments[3],
          state.assignments[3].staffId,
          date
        ),
        continuity: staffWorkContinuity(state, state.assignments, null),
      };
      const result = await improveStaffWorkContinuity({
        state,
        date,
        assignments: state.assignments,
        lockedAssignmentIds: new Set(),
        facts,
        solver: defaultHighsSolver,
        halfRestStaffIds: new Set(),
        assertSafe: (p) => session.assertAssignmentsSafe(p),
      });
      const target = result.find((a) => a.positionRuleId === "last");
      report.continuityFinalizer = {
        before,
        after: {
          staffId: target.staffId,
          profile: frequency.positionFrequencyProfileForAssignment(
            state,
            target,
            target.staffId,
            date
          ),
          continuity: staffWorkContinuity(state, result, null),
        },
        warnings: session.warnings(),
      };
    }
    report.healthChecks = [
      ...report.consecutiveVersusFrequency.map((p) => ({
        name:
          p.category +
          ": consecutive must preserve ordinary-priority frequency",
        passed:
          p.afterConsecutive.profile.currentMonthCount <=
          p.before.profile.currentMonthCount,
      })),
      ...report.monthlyFinalizer.map((p) => ({
        name: p.variant + ": monthly balance must preserve completed rotation",
        passed: p.after.runs <= p.before.runs,
      })),
      {
        name: "continuity must preserve ordinary-priority frequency",
        passed:
          report.continuityFinalizer.after.profile.currentMonthCount <=
          report.continuityFinalizer.before.profile.currentMonthCount,
      },
    ];
    const destination = path.join(
      process.cwd(),
      "docs/acceptance/evidence/2026-11-16-other-rotation-audit-probe.json"
    );
    fs.writeFileSync(destination, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
    if (report.healthChecks.some((c) => !c.passed)) process.exitCode = 1;
  } finally {
    await server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

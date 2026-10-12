// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createDefaultState } from "../../src/defaults";
import {
  buildConfigWorkbook,
  parseWorkbook,
} from "../../src/infrastructure/excel";
import { saveState, loadState } from "../../src/infrastructure/storage";
import { applyWorkbookImport } from "../../src/app/workbook-actions";
import { diagnosePolicyConfiguration } from "../../src/domain/rules/policy-configuration-diagnostics";
import "../../src/ui/components/policy-page";
import { mountElement } from "../ui/lit-test-helpers";

function scenario() {
  const state = createDefaultState();
  state.templates = [{ ...state.templates[0]!, id: "tw", flightNo: "TW616" }];
  state.flights = [];
  const base = state.positionRules[0]!;
  state.positionRules = [
    {
      ...base,
      id: "source",
      flightNo: "TW616",
      name: "督导",
      category: "机动督导",
      coverageRole: "none",
    },
    {
      ...base,
      id: "target",
      flightNo: "TW616",
      name: "G16",
      category: "常规",
      coverageRole: "supervisor-fill",
    },
  ];
  state.settings.mobileSupervisorFillRules = [
    {
      id: "fill",
      enabled: true,
      sourceFlightNo: "TW616",
      sourcePositionKeyword: "督导",
      targetFlightNo: "TW616",
      targetPositionKeyword: "G16",
      allowAutomatic: true,
      allowManual: true,
    },
  ];
  return state;
}

describe("configuration diagnostics after persistence", () => {
  it("recomputes the same explanation after a localStorage round trip", async () => {
    const state = scenario();
    let serialized = "";
    expect(
      saveState(state, {
        setItem: (_key, value) => {
          serialized = value;
        },
      }).sizeBytes
    ).toBeGreaterThan(0);
    const restored = loadState({ getItem: () => serialized });
    expect(
      diagnosePolicyConfiguration(restored, "mobileSupervisorFillRules", "fill")
    ).toEqual(
      diagnosePolicyConfiguration(state, "mobileSupervisorFillRules", "fill")
    );
    const page = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-policy-page", { model: restored });
    expect(
      page.querySelector("[data-supervisor-fill]")?.textContent
    ).not.toContain("TW616 不存在");
    expect(
      page.querySelector(
        "[data-supervisor-fill] details[data-policy-diagnostic]"
      )?.textContent
    ).toContain("取消旧航班");
    expect(JSON.parse(serialized).settings).not.toHaveProperty(
      "policyDiagnostics"
    );
  });

  it("recomputes matching and missing-role help after Excel export and config import", async () => {
    const state = scenario();
    state.positionRules[1]!.coverageRole = "none";
    const workbook = buildConfigWorkbook(state);
    const parsed = parseWorkbook(workbook, state.staff);
    const imported = createDefaultState();
    imported.flights = [];
    expect(applyWorkbookImport(imported, parsed, "config").changedConfig).toBe(
      true
    );
    const fill = imported.settings.mobileSupervisorFillRules[0]!;
    expect(
      diagnosePolicyConfiguration(
        imported,
        "mobileSupervisorFillRules",
        fill.id
      )[0]
    ).toMatchObject({ code: "target-position-not-fill", severity: "warning" });
    const page = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-policy-page", { model: imported });
    const details = page.querySelector<HTMLDetailsElement>(
      "[data-supervisor-fill] details[data-policy-diagnostic]"
    )!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("补位性质");
    expect(details.textContent).toContain("配置 → 岗位配置");
  });
});

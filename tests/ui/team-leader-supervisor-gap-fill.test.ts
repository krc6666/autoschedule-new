// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import "../../src/ui/components/team-leader-gap-fill-dialog";
import {
  UI_COMMAND_EVENT,
  type UiCommandEvent,
} from "../../src/ui/events/ui-command";
import { createSupervisorGapFillScenario } from "../helpers/supervisor-gap-fill";
import { mountElement } from "./lit-test-helpers";

describe("supervisor vacancy selection", () => {
  it("lists the actual mobile supervisor vacancy alongside a regular vacancy and emits its ID", async () => {
    const { state, leader, vacancy, vacancyRule } =
      createSupervisorGapFillScenario();
    const regularRule = {
      ...vacancyRule,
      id: "regular",
      name: "G12",
      category: state.positionRules[0]!.category,
    };
    state.positionRules.push(regularRule);
    state.assignments.push({
      ...vacancy,
      id: "regular-vacancy",
      positionRuleId: regularRule.id,
      position: regularRule.name,
    });
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-team-leader-gap-fill-dialog", {
      model: state,
      dialog: {
        kind: "team-leader-gap-fill",
        selectedTeamLeaderId: leader.id,
        selectedVacancyAssignmentIds: [],
        planning: false,
        preview: null,
        reasons: [],
      },
    });
    const labels = [
      ...element.querySelectorAll<HTMLLabelElement>(".list-group-item"),
    ];
    expect(
      labels.map((label) => label.textContent.replace(/\s+/g, " ").trim())
    ).toEqual(["TW616 / 督导/引导", "TW616 / G12"]);
    const checkbox = labels
      .find((label) => label.textContent.includes("督导/引导"))
      ?.querySelector<HTMLInputElement>("input");
    expect(checkbox).toBeTruthy();
    if (!checkbox) throw new Error("supervisor target missing");
    let command: unknown;
    element.addEventListener(UI_COMMAND_EVENT, (event) => {
      command = (event as UiCommandEvent).detail;
    });
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(command).toEqual({
      type: "update-team-leader-gap-fill-vacancies",
      assignmentIds: [vacancy.id],
    });
  });

  it("continues to hide KE166, manual, administrative, guide and diversion targets", async () => {
    const { state, leader, vacancy, vacancyRule } =
      createSupervisorGapFillScenario();
    const rules = [
      { ...vacancyRule, id: "ke", flightNo: "KE166" },
      { ...vacancyRule, id: "manual", manual: true },
      { ...vacancyRule, id: "admin", category: "行政支援" as const },
      { ...vacancyRule, id: "guide", category: "引导" as const },
      { ...vacancyRule, id: "diversion", category: "分流" as const },
    ];
    state.positionRules.push(...rules);
    state.assignments.push(
      ...rules.map((rule) => ({
        ...vacancy,
        id: rule.id,
        flightNo: rule.flightNo,
        positionRuleId: rule.id,
      }))
    );
    const element = await mountElement<
      HTMLElement & { updateComplete: Promise<unknown> }
    >("autoschedule-team-leader-gap-fill-dialog", {
      model: state,
      dialog: {
        kind: "team-leader-gap-fill",
        selectedTeamLeaderId: leader.id,
        selectedVacancyAssignmentIds: [],
        planning: false,
        preview: null,
        reasons: [],
      },
    });
    expect(element.querySelectorAll(".list-group-item")).toHaveLength(1);
    expect(element.querySelector(".list-group-item")?.textContent).toContain(
      "TW616 / 督导/引导"
    );
  });
});

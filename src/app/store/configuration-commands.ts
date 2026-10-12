import {
  addAdministrativeStaff,
  addFlight,
  addPositions,
  copyPositionRules,
  addStaff,
  addTemplate,
  addTemplateFlight,
  applyFlightPlanReconciliation,
  deleteFlight,
  deletePosition,
  deleteStaff,
  deleteTemplate,
  movePosition,
  renameCurrentFlightToTemplate,
  saveQualified,
  setWeeklyFlightPlanFlight,
  sortCountersDescending,
  updateConfigurationField,
} from "../configuration-actions";
import type { FlightPlanReconciliation } from "../../domain/flights/flight-plan-reconciliation";
import type { ConfigurationValue } from "../configuration-actions";
import type { IsoWeekday } from "../../model";
import type { StateCommand } from "./store-command";

export function createConfigurationCommands(command: StateCommand) {
  return {
    addFlight: () => command(addFlight),
    deleteFlight: (id: string) => command((state) => deleteFlight(state, id)),
    addTemplate: () => command(addTemplate),
    deleteTemplate: (id: string) =>
      command((state) => deleteTemplate(state, id)),
    renameCurrentFlightToTemplate: (flightId: string, templateId: string) =>
      command((state) =>
        renameCurrentFlightToTemplate(state, flightId, templateId)
      ),
    setWeeklyFlightPlanFlight: (
      weekday: IsoWeekday,
      flightNo: string,
      selected: boolean
    ) =>
      command((state) =>
        setWeeklyFlightPlanFlight(state, weekday, flightNo, selected)
      ),
    addTemplateFlight: (id: string) =>
      command((state) => addTemplateFlight(state, id)),
    addStaff: () => command(addStaff),
    addAdministrativeStaff: () => command(addAdministrativeStaff),
    deleteStaff: (id: string) => command((state) => deleteStaff(state, id)),
    addPositions: (flightNo: string, count: number) =>
      command((state) => addPositions(state, flightNo, count)),
    copyPositionRules: (
      sourceFlightNo: string,
      targetFlightNo: string,
      overwrite = false
    ) =>
      command((state) =>
        copyPositionRules(state, sourceFlightNo, targetFlightNo, overwrite)
      ),
    deletePosition: (id: string) =>
      command((state) => deletePosition(state, id)),
    movePosition: (id: string, direction: -1 | 1) =>
      command((state) => movePosition(state, id, direction)),
    sortCountersDescending: (flightNo: string) =>
      command((state) => sortCountersDescending(state, flightNo)),
    saveQualified: (id: string, manual: boolean, staffIds: string[]) =>
      command((state) => saveQualified(state, id, manual, staffIds)),
    updateField: (
      entity: string,
      id: string,
      field: string,
      value: ConfigurationValue
    ) =>
      command((state) =>
        updateConfigurationField(state, entity, id, field, value)
      ),
    applyFlightPlan: (
      reconciliation: FlightPlanReconciliation,
      templateIds: string[],
      flightIds: string[]
    ) =>
      command((state) =>
        applyFlightPlanReconciliation(
          state,
          reconciliation,
          templateIds,
          flightIds
        )
      ),
  };
}

export type ConfigurationCommands = ReturnType<
  typeof createConfigurationCommands
>;

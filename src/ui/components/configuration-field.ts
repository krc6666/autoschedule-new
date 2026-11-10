import { html } from "lit";

import { dispatchUiCommand, inputValue } from "../events/ui-command";
import { dynamicSelectValue } from "./dynamic-select";

export function configurationInput(
  target: EventTarget,
  entity: string,
  id: string,
  field: string,
  value: string | number,
  label: string,
  options: {
    type?: string;
    className?: string;
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
  } = {}
) {
  return html`<input
    class="form-control form-control-sm ${options.className ?? ""}"
    type=${options.type ?? "text"}
    .value=${String(value)}
    min=${options.min ?? ""}
    max=${options.max ?? ""}
    step=${options.step ?? ""}
    ?disabled=${options.disabled}
    aria-label=${label}
    @change=${(event: Event) =>
      dispatchUiCommand(target, {
        type: "update-configuration",
        entity,
        id,
        field,
        value: inputValue(event.currentTarget as HTMLInputElement),
      })}
  />`;
}

export function configurationToggle(
  target: EventTarget,
  entity: string,
  id: string,
  field: string,
  checked: boolean,
  label: string,
  disabled = false
) {
  return html`<div class="form-check form-switch m-0">
    <input
      class="form-check-input"
      type="checkbox"
      .checked=${checked}
      ?disabled=${disabled}
      aria-label=${label}
      @change=${(event: Event) =>
        dispatchUiCommand(target, {
          type: "update-configuration",
          entity,
          id,
          field,
          value: (event.currentTarget as HTMLInputElement).checked,
        })}
    />
  </div>`;
}

export function configurationSelect(
  target: EventTarget,
  entity: string,
  id: string,
  field: string,
  value: string,
  label: string,
  options: readonly (string | { value: string; label: string })[]
) {
  return html`<select
    ${dynamicSelectValue(value)}
    class="form-select form-select-sm"
    .value=${value}
    aria-label=${label}
    @change=${(event: Event) =>
      dispatchUiCommand(target, {
        type: "update-configuration",
        entity,
        id,
        field,
        value: (event.currentTarget as HTMLSelectElement).value,
      })}
  >
    ${options.map(
      (option) =>
        html`<option
          .value=${typeof option === "string" ? option : option.value}
        >
          ${typeof option === "string" ? option : option.label}
        </option>`
    )}
  </select>`;
}

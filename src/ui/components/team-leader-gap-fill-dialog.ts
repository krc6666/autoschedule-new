import { html, nothing } from "lit";

import type { ApplicationDialog } from "../../app/application-view-state";
import type { AppState } from "../../model";
import { isTeamLeaderGapFillVacancy } from "../../domain/coverage/team-leader-gap-fill-protection";
import { dispatchUiCommand } from "../events/ui-command";
import { LightDomElement } from "./light-dom-element";

type GapFillDialog = Extract<
  ApplicationDialog,
  { kind: "team-leader-gap-fill" }
>;

export class TeamLeaderGapFillDialogElement extends LightDomElement {
  static override properties = {
    model: { attribute: false },
    dialog: { attribute: false },
  };

  model!: AppState;
  dialog!: GapFillDialog;

  protected override render() {
    const leaders = this.model.staff.filter(
      (person) =>
        person.teamLeader &&
        person.status === "正常" &&
        person.staffType === "常规"
    );
    const vacancies = this.model.assignments.filter((assignment) =>
      isTeamLeaderGapFillVacancy(this.model, assignment)
    );
    const selected = new Set(this.dialog.selectedVacancyAssignmentIds);
    return html`
      <div class="modal-body">
        <label class="form-label" for="gap-fill-team-leader">分队长</label>
        <select
          id="gap-fill-team-leader"
          class="form-select mb-3"
          .value=${this.dialog.selectedTeamLeaderId}
          ?disabled=${this.dialog.planning}
          @change=${(event: Event) =>
            dispatchUiCommand(this, {
              type: "update-team-leader-gap-fill-leader",
              staffId: (event.currentTarget as HTMLSelectElement).value,
            })}
        >
          ${leaders.map(
            (person) => html`<option value=${person.id}>${person.name}</option>`
          )}
        </select>

        <fieldset>
          <legend class="fs-6">选择要补的空缺</legend>
          <div class="list-group">
            ${vacancies.map(
              (assignment) =>
                html`<label class="list-group-item d-flex gap-2">
                  <input
                    class="form-check-input flex-shrink-0"
                    type="checkbox"
                    .checked=${selected.has(assignment.id)}
                    ?disabled=${this.dialog.planning}
                    @change=${(event: Event) =>
                      this.toggleVacancy(
                        assignment.id,
                        (event.currentTarget as HTMLInputElement).checked
                      )}
                  />
                  <span>${assignment.flightNo} / ${assignment.position}</span>
                </label>`
            )}
          </div>
        </fieldset>

        ${
          this.dialog.reasons.length
            ? html`<div class="alert alert-warning mt-3 mb-0" role="status">
                ${this.dialog.reasons.join("；")}
              </div>`
            : nothing
        }
        ${
          this.dialog.preview
            ? html`<section class="mt-3">
                <h3 class="fs-6">整体补差方案</h3>
                <p class="mb-2">
                  已补空缺：${this.dialog.preview.vacancyAssignmentIds.length}
                  个；
                  共改变岗位：${new Set(this.dialog.preview.changes.map((change) => change.assignmentId)).size}
                  个
                </p>
                <p class="mb-2">
                  补上的空缺：${this.dialog.preview.vacancyAssignmentIds
                    .map((id) =>
                      this.model.assignments.find(
                        (assignment) => assignment.id === id
                      )
                    )
                    .filter(
                      (
                        assignment
                      ): assignment is NonNullable<typeof assignment> =>
                        Boolean(assignment)
                    )
                    .map(
                      (assignment) =>
                        `${assignment.flightNo}/${assignment.position}`
                    )
                    .join("、")}
                </p>
                <p class="mb-2">
                  ${this.model.staff.find((person) => person.id === this.dialog.preview?.teamLeaderId)?.name ?? "分队长"}最终承担：${this.dialog.preview.changes
                    .filter(
                      (change) =>
                        change.toStaffId === this.dialog.preview?.teamLeaderId
                    )
                    .map((change) => `${change.flightNo}/${change.position}`)
                    .join("、")}
                </p>
                <ol class="mb-0">
                  ${this.dialog.preview.changes.map(
                    (change) =>
                      html`<li>
                        ${change.flightNo}/${change.position}：${
                          change.fromStaffName || "空缺"
                        }
                        → ${change.toStaffName}
                      </li>`
                  )}
                </ol>
                ${
                  this.dialog.preview.warnings.length
                    ? html`<div
                        class="alert alert-warning mt-3 mb-0"
                        role="status"
                      >
                        <strong>黄灯提醒</strong>
                        <ul class="mb-0">
                          ${this.dialog.preview.warnings.map(
                            (warning) => html`<li>${warning}</li>`
                          )}
                        </ul>
                      </div>`
                    : nothing
                }
                ${
                  this.dialog.preview.rejectedCandidates.length
                    ? html`<details class="mt-3">
                        <summary>未采用的候选方案</summary>
                        <ul class="mb-0 mt-2">
                          ${this.dialog.preview.rejectedCandidates.map(
                            (reason) => html`<li>${reason}</li>`
                          )}
                        </ul>
                      </details>`
                    : nothing
                }
              </section>`
            : nothing
        }
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-light" data-bs-dismiss="modal">
          取消
        </button>
        ${
          this.dialog.preview
            ? html`<button
                type="button"
                class="btn btn-primary"
                @click=${() =>
                  dispatchUiCommand(this, {
                    type: "confirm-team-leader-gap-fill",
                  })}
              >
                确认应用
              </button>`
            : html`<button
                type="button"
                class="btn btn-primary"
                ?disabled=${
                  this.dialog.planning ||
                  !this.dialog.selectedTeamLeaderId ||
                  !selected.size
                }
                @click=${() =>
                  dispatchUiCommand(this, {
                    type: "preview-team-leader-gap-fill",
                  })}
              >
                ${this.dialog.planning ? "正在计算" : "生成补差预览"}
              </button>`
        }
      </div>
    `;
  }

  private toggleVacancy(assignmentId: string, checked: boolean): void {
    const selected = new Set(this.dialog.selectedVacancyAssignmentIds);
    if (checked) selected.add(assignmentId);
    else selected.delete(assignmentId);
    dispatchUiCommand(this, {
      type: "update-team-leader-gap-fill-vacancies",
      assignmentIds: [...selected],
    });
  }
}

customElements.define(
  "autoschedule-team-leader-gap-fill-dialog",
  TeamLeaderGapFillDialogElement
);

declare global {
  interface HTMLElementTagNameMap {
    "autoschedule-team-leader-gap-fill-dialog": TeamLeaderGapFillDialogElement;
  }
}

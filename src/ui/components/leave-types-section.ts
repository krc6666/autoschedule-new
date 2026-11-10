import { html } from "lit";
import type { AppState } from "../../model";
import { dispatchUiCommand } from "../events/ui-command";
import { LightDomElement } from "./light-dom-element";

export class LeaveTypesSectionElement extends LightDomElement {
  static override properties = { model: { attribute: false } };
  model!: AppState;

  protected override render() {
    return html`<details class="mb-3" aria-label="休假类别管理">
      <summary class="btn btn-sm btn-outline-secondary">管理休假类别</summary>
      <div class="mt-2">
        <p class="small text-secondary">
          自建类别与“休假”使用相同排班限制。新增后可在人员状态中选择；已使用的类别可停用，停用不改变人员状态。
        </p>
        <form
          class="d-flex gap-2 mb-2"
          @submit=${(event: Event) => {
            event.preventDefault();
            const input = this.querySelector<HTMLInputElement>(
              '[aria-label="新增休假类别名称"]'
            )!;
            dispatchUiCommand(this, {
              type: "add-leave-type",
              name: input.value,
            });
          }}
        >
          <input
            class="form-control form-control-sm"
            style="min-width: 0"
            aria-label="新增休假类别名称"
            placeholder="例如：飞行假"
          />
          <button
            class="btn btn-sm btn-outline-primary text-nowrap"
            type="submit"
            aria-label="新增休假类别"
          >
            新增休假类别
          </button>
        </form>
        ${
          this.model.leaveTypes.length
            ? html`<div class="table-responsive">
                <table class="table table-sm align-middle">
                  <thead>
                    <tr>
                      <th>名称</th>
                      <th>启用</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${this.model.leaveTypes.map((type) => {
                      const used = this.model.staff.some(
                        (person) => person.leaveTypeId === type.id
                      );
                      return html`<tr>
                        <td>
                          <input
                            class="form-control form-control-sm"
                            .value=${type.name}
                            aria-label=${`休假类别名称：${type.name}`}
                            @change=${(event: Event) => {
                              const input =
                                event.currentTarget as HTMLInputElement;
                              const name = input.value;
                              input.value = type.name;
                              dispatchUiCommand(this, {
                                type: "update-leave-type",
                                id: type.id,
                                patch: { name },
                              });
                            }}
                          />
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            class="form-check-input"
                            .checked=${type.enabled}
                            aria-label=${`启用休假类别：${type.name}`}
                            @change=${(event: Event) => dispatchUiCommand(this, { type: "update-leave-type", id: type.id, patch: { enabled: (event.currentTarget as HTMLInputElement).checked } })}
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            class="btn btn-sm btn-outline-danger"
                            ?disabled=${used}
                            title=${used ? "仍有人员使用，请先停用或修改人员状态" : "删除未使用的类别"}
                            aria-label=${`删除休假类别：${type.name}`}
                            @click=${() => dispatchUiCommand(this, { type: "delete-leave-type", id: type.id })}
                          >
                            删除
                          </button>
                        </td>
                      </tr>`;
                    })}
                  </tbody>
                </table>
              </div>`
            : html`<p class="small text-secondary">尚未添加自建休假类别。</p>`
        }
      </div>
    </details>`;
  }
}
customElements.define("autoschedule-leave-types", LeaveTypesSectionElement);

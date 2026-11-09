import { html } from "lit";

import type { AppState } from "../../model";
import { dispatchUiCommand } from "../events/ui-command";
import {
  configurationInput,
  configurationSelect,
  configurationToggle,
} from "./configuration-field";
import { LightDomElement } from "./light-dom-element";

export class StaffConfigSectionElement extends LightDomElement {
  static override properties = { model: { attribute: false } };
  model!: AppState;

  protected override render() {
    const regular = this.model.staff.filter(
      (person) => person.staffType === "常规"
    );
    return html`<details class="workspace-section config-collapsible">
      <summary>
        <span
          ><strong>人员信息</strong
          ><small>
            ${this.model.staff.length} 人 ·
            ${regular.filter((person) => person.teamLeader).length} 人分队长 ·
            ${regular.filter((person) => person.dutyQualified).length}
            人值班资质 ·
            ${regular.filter((person) => person.standbyQualified).length}
            人备勤资质 ·
            ${this.model.staff.filter((person) => person.staffType === "行政支援").length}
            人行政支援 ·
            ${this.model.staff.filter((person) => person.status !== "正常").length}
            人不可用
          </small></span
        ><i class="bi bi-chevron-down"></i>
      </summary>
      <div class="config-collapsible-content">
        <div class="config-collapsible-toolbar">
          <button
            class="btn btn-outline-secondary"
            type="button"
            @click=${() => dispatchUiCommand(this, { type: "open-import", mode: "config" })}
          >
            <i class="bi bi-file-earmark-arrow-up me-2"></i>导入配置模板
          </button>
          <a
            class="btn btn-outline-secondary"
            href="./template/排班工具配置模板.xlsx"
            download
          >
            <i class="bi bi-download me-2"></i>下载模板
          </a>
          <button
            class="btn btn-outline-primary"
            type="button"
            @click=${() => dispatchUiCommand(this, { type: "add-staff", administrative: true })}
          >
            <i class="bi bi-person-plus me-2"></i>新增行政支援
          </button>
          <button
            class="btn btn-primary"
            type="button"
            @click=${() => dispatchUiCommand(this, { type: "add-staff", administrative: false })}
          >
            <i class="bi bi-person-plus me-2"></i>新增人员
          </button>
        </div>
        <div class="table-responsive">
          <table class="table align-middle data-table">
            <thead>
              <tr>
                <th>编号</th>
                <th>姓名</th>
                <th>人员类型</th>
                <th>分队长</th>
                <th>CX航前资质</th>
                <th>值班资质</th>
                <th>备勤资质</th>
                <th>夜班</th>
                <th>状态</th>
                <th>备注</th>
                <th class="action-col">
                  <span class="visually-hidden">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              ${this.model.staff.map(
                (person) =>
                  html`<tr>
                    <td>
                      ${configurationInput(this, "staff", person.id, "id", person.id, "编号", { className: "code-input" })}
                    </td>
                    <td>
                      ${configurationInput(this, "staff", person.id, "name", person.name, "姓名")}
                    </td>
                    <td>
                      ${configurationSelect(this, "staff", person.id, "staffType", person.staffType, "人员类型", ["常规", "行政支援"])}
                    </td>
                    <td>
                      ${configurationToggle(this, "staff", person.id, "teamLeader", person.teamLeader, "是否为分队长", person.staffType === "行政支援")}
                    </td>
                    <td>
                      ${configurationToggle(this, "staff", person.id, "cxPreflightQualified", person.cxPreflightQualified, "CX航前资质", person.staffType === "行政支援")}
                    </td>
                    <td>
                      ${configurationToggle(this, "staff", person.id, "dutyQualified", person.dutyQualified, "值班资质", person.staffType === "行政支援")}
                    </td>
                    <td>
                      ${configurationToggle(this, "staff", person.id, "standbyQualified", person.standbyQualified, "备勤资质", person.staffType === "行政支援")}
                    </td>
                    <td>
                      ${configurationToggle(this, "staff", person.id, "nightShift", person.nightShift, "可上夜班")}
                    </td>
                    <td>
                      ${configurationSelect(this, "staff", person.id, "status", person.status, "状态", ["正常", "病假", "休假"])}
                    </td>
                    <td>
                      ${configurationInput(this, "staff", person.id, "remark", person.remark, "备注")}
                    </td>
                    <td>
                      <button
                        class="btn btn-sm btn-outline-danger icon-btn"
                        type="button"
                        title="删除人员"
                        aria-label="删除人员"
                        @click=${() => dispatchUiCommand(this, { type: "delete-staff", id: person.id })}
                      >
                        <i class="bi bi-trash3"></i>
                      </button>
                    </td>
                  </tr>`
              )}
            </tbody>
          </table>
        </div>
      </div>
    </details>`;
  }
}

customElements.define("autoschedule-staff-config", StaffConfigSectionElement);

declare global {
  interface HTMLElementTagNameMap {
    "autoschedule-staff-config": StaffConfigSectionElement;
  }
}

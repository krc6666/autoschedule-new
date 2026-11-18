import { html } from "lit";
import type { OverlapStaffingCheck } from "../../domain/feedback/overlap-staffing-check";

export function renderOverlapStaffingCheck(check: OverlapStaffingCheck) {
  return html`<div class="overlap-staffing-check" role="status">
    <strong>重叠航班人手检查：</strong>
    <span>${check.message}</span>
    ${
      check.windows.length
        ? html`<details>
            <summary>查看时段与空闲人员</summary>
            <p>
              空闲仅表示该时段没有岗位；“直接检查通过”按整个目标岗位核对，仍需人工确认完整方案。同一人不能同时补多个岗位，未列出直接人选也不代表换人无解。
            </p>
            ${check.windows.map(
              (window) =>
                html`<section class="overlap-staffing-window">
                  <strong
                    >${window.startTime}—${window.endTime} ·
                    ${window.flightNumbers.join("、")}</strong
                  >
                  <p>
                    该时段空闲：${window.idleStaff.length ? window.idleStaff.map((person) => `${person.name}${person.teamLeader ? "（分队长，需人工补差）" : ""}`).join("、") : "无"}
                  </p>
                  ${window.targets.map(
                    (target) =>
                      html`<div class="overlap-staffing-target">
                        <p>
                          ${target.label}：${target.kind === "vacancy" ? "缺岗" : "机动督导补位"}；直接检查通过：${target.directStaffNames.join("、") || "无"}
                        </p>
                        ${
                    target.blockedStaff.length
                      ? html`<details>
                          <summary>空闲人员未通过的原因</summary>
                          <ul>
                            ${target.blockedStaff.map((person) => html`<li>${person.name}：${person.reasons.join("；")}</li>`)}
                          </ul>
                        </details>`
                      : null
                  }
                      </div>`
                  )}
                </section>`
            )}
          </details>`
        : null
    }
  </div>`;
}

import { html } from "lit";
import type { PublicSchedule } from "../../app/cloud-contract";
import { LightDomElement } from "./light-dom-element";
import { visiblePositionRemark } from "../../utils";

export class PublicScheduleElement extends LightDomElement {
  static override properties = { schedule: { attribute: false }, message: {} };
  schedule: PublicSchedule | null = null;
  message = "正在读取已发布班表…";

  protected override render() {
    const s = this.schedule;
    return html`<main class="container py-4">
      <h1 class="h3">已发布班表</h1>
      ${
        s
          ? html`
              <p>${s.groupId} 组 · ${s.date}</p>
              <p class="small text-secondary">
                发布时间：${new Date(s.publishedAt).toLocaleString("zh-CN")}
              </p>
              <div class="table-responsive">
                <table class="table table-bordered align-middle">
                  <thead>
                    <tr>
                      <th>航班</th>
                      <th>岗位</th>
                      <th>人员</th>
                      <th>开始</th>
                      <th>结束</th>
                      <th>备注</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${s.rows.map(
                      (row) =>
                        html`<tr>
                          <td>${row.flightNo}</td>
                          <td>${row.position}</td>
                          <td
                            class=${row.status === "unfilled" ? "text-danger" : ""}
                          >
                            ${row.staffName || "待补位"}
                          </td>
                          <td>${row.startTime}</td>
                          <td>${row.endTime}</td>
                          <td>${visiblePositionRemark(row.remark)}</td>
                        </tr>`
                    )}
                  </tbody>
                </table>
              </div>
              <p class="small text-secondary">
                此页只展示已发布版本。班表调整后，请重新打开或刷新本页查看最新发布。
              </p>
            `
          : html`<p role="status">${this.message}</p>`
      }
    </main>`;
  }
}

customElements.define("autoschedule-public-schedule", PublicScheduleElement);

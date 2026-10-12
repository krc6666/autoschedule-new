import { html, nothing } from "lit";
import type { PolicyDiagnostic } from "../../domain/rules/policy-diagnostic";

export function renderPolicyDiagnostics(
  issues: readonly PolicyDiagnostic[],
  reference: string
) {
  if (!issues.length) return nothing;
  return html`<div
    class="policy-diagnostics"
    data-policy-diagnostics=${reference}
  >
    ${issues.map(
      (issue) =>
        html`<div
          class=${`policy-diagnostic alert ${issue.severity === "warning" ? "alert-warning" : "alert-light border"} py-2 mb-0`}
          role=${issue.severity === "warning" ? "alert" : "note"}
        >
          <div class="policy-diagnostic-message">${issue.message}</div>
          <details data-policy-diagnostic data-diagnostic-code=${issue.code}>
            <summary>查看原因与处理方法</summary>
            <p>${issue.explanation}</p>
            <ol>
              ${issue.steps.map((step) => html`<li>${step}</li>`)}
            </ol>
          </details>
        </div>`
    )}
  </div>`;
}

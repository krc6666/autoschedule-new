/** Read-only configuration explanation; never an assignment eligibility result. */
export interface PolicyDiagnostic {
  code: string;
  severity: "warning" | "info";
  message: string;
  explanation: string;
  steps: string[];
}

export function policyDiagnostic(
  code: string,
  message: string,
  explanation: string,
  steps: string[],
  severity: PolicyDiagnostic["severity"] = "warning"
): PolicyDiagnostic {
  return { code, message, explanation, steps, severity };
}

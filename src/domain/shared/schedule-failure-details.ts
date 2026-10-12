/** Read-only explanation produced by a failed schedule check, not a new rule. */
export interface ScheduleFailureDetails {
  readonly code:
    | "ke166-distinct-staff-capacity"
    | "schedule-check"
    | "calculation-timeout"
    | "no-safe-schedule"
    | "calculation-incomplete"
    | "program-error"
    | "local-vacancies";
  readonly reason: string;
  readonly facts: readonly string[];
  readonly steps: readonly string[];
  /** Original errors for the diagnostic export only, never ordinary UI text. */
  readonly diagnosticMessages?: readonly string[];
}

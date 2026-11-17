/** Independent cloud archive, excluded from AppState, browser recovery copies and workbook exports. */
export interface WorkspaceVersion {
  id: string;
  version: number;
  createdAt: string;
  /** Null for a workspace saved before uploader tracking was enabled. */
  actor: string | null;
}

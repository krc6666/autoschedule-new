import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("CI workflow", () => {
  it("runs verify for pull requests as well as pushes", () => {
    const validation = readFileSync(
      join(process.cwd(), ".github", "workflows", "validate.yml"),
      "utf8"
    );
    expect(validation).toMatch(/\n\s*push:\s*(?:\n|$)/);
    expect(validation).toMatch(/\n\s*pull_request:\s*(?:\n|$)/);
    expect(validation).toContain("npm run verify");
  });

  it("only lets a successful main validation run publish Pages", () => {
    const deployment = readFileSync(
      join(process.cwd(), ".github", "workflows", "deploy-pages.yml"),
      "utf8"
    );
    expect(deployment).toContain("workflow_run:");
    expect(deployment).toContain(
      "github.event.workflow_run.conclusion == 'success'"
    );
    expect(deployment).toContain(
      "github.event.workflow_run.head_branch == 'main'"
    );
    expect(deployment).toContain(
      "node scripts/check-acceptance.mjs --fingerprint"
    );
    expect(deployment).not.toContain("npm run verify");
  });
});

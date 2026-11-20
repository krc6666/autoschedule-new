import { expect, it } from "vitest";
import { createDefaultState } from "../../src/defaults";
import { flightIdentityOptions } from "../../src/ui/projections/flight-identity-options";
import { matchesFlightPolicySearch } from "../../src/ui/projections/policy-search";

it("lists history-only directories and finds stable rules by current or old names", () => {
  const state = createDefaultState();
  state.shared.flightIdentities = [
    {
      id: "cx",
      displayName: "国泰长期航班",
      aliases: [{ flightNo: "CX937早" }, { flightNo: "AB999" }],
    },
  ];
  expect(flightIdentityOptions(state)).toContainEqual(["@CX", "国泰长期航班"]);
  for (const query of ["国泰", "cx937早", "ab999"])
    expect(matchesFlightPolicySearch(state, query, ["@CX", "H02"])).toBe(true);
  expect(matchesFlightPolicySearch(state, "CX938", ["@CX"])).toBe(false);
});

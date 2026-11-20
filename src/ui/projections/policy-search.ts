import {
  flightIdentities,
  flightIdentityKey,
  type FlightIdentityFacts,
} from "../../domain/flights/flight-identities";

export function matchesFlightPolicySearch(
  context: FlightIdentityFacts,
  query: string,
  ...values: readonly unknown[]
): boolean {
  const expanded = values.flat(Infinity).flatMap((value) => {
    if (typeof value !== "string") return [value];
    const key = flightIdentityKey(context, value);
    const identity = flightIdentities(context).find(
      (i) => `@${i.id.toUpperCase()}` === key
    );
    return identity
      ? [
          value,
          identity.displayName,
          ...identity.aliases.map((a) => a.flightNo),
        ]
      : [value];
  });
  return matchesPolicySearch(query, expanded);
}

export function normalizePolicySearchQuery(query: string): string {
  return query.trim().toLocaleLowerCase("zh-CN");
}

export function matchesPolicySearch(
  query: string,
  ...values: readonly unknown[]
): boolean {
  const normalizedQuery = normalizePolicySearchQuery(query);
  if (!normalizedQuery) return true;
  return values
    .flat(Infinity)
    .filter((value) => value !== null && value !== undefined)
    .some((value) =>
      String(value).toLocaleLowerCase("zh-CN").includes(normalizedQuery)
    );
}

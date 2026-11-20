import { expect, it } from "vitest";
import ts from "typescript";
import { FLIGHT_RULE_REFERENCE_FIELDS } from "../../src/domain/flights/group-flight-references";

it("every flight target declared by a structured setting is registered for identity propagation", () => {
  const program = ts.createProgram(["src/model.ts"], {
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile("src/model.ts")!;
  const declaration = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === "ScheduleSettings"
  )!;
  const settings = checker.getTypeAtLocation(declaration);
  const actual: Record<string, string[]> = {};
  for (const property of settings.getProperties()) {
    const type = checker.getNonNullableType(
      checker.getTypeOfSymbolAtLocation(property, declaration)
    );
    if (!checker.isArrayType(type)) continue;
    const [element] = checker.getTypeArguments(type as ts.TypeReference);
    const fields = element
      ?.getProperties()
      .map((field) => field.name)
      .filter((name) => /(?:^flightNo$|FlightNo$)/.test(name));
    if (fields?.length) actual[property.name] = fields.sort();
  }
  expect(actual).toEqual(
    Object.fromEntries(
      Object.entries(FLIGHT_RULE_REFERENCE_FIELDS).map(([name, fields]) => [
        name,
        [...fields].sort(),
      ])
    )
  );
});

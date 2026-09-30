import { expect, test } from "bun:test";
import { undeclaredArguments } from "./tool-arguments.ts";

const schema = { properties: { notebook: {}, project: {} } };

test("declared arguments pass", () => {
  expect(undeclaredArguments(schema, { notebook: "x", project: "/p" })).toEqual(
    [],
  );
  expect(undeclaredArguments(schema, undefined)).toEqual([]);
});

test("every undeclared argument is named", () => {
  expect(
    undeclaredArguments(schema, {
      notebok: "x",
      projects: "/p",
      project: "/p",
    }),
  ).toEqual(["notebok", "projects"]);
});

test("a schema without properties declares nothing", () => {
  expect(undeclaredArguments({}, { anything: 1 })).toEqual(["anything"]);
});

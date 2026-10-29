import { expect, it } from "@effect/vitest";
import { independentReviewer, specialistBrief } from "./specialists.ts";
it("requires known distinct model families and fails closed for aliases", () => {
  expect(independentReviewer("gpt-6.1", "claude-opus-5.5")).toBe(true);
  expect(independentReviewer("gpt-6.1", "gpt-6.2")).toBe(false);
  expect(independentReviewer("my-local-alias", "claude-opus-5.5")).toBe(false);
  expect(independentReviewer("gpt-6.1", "unknown")).toBe(false);
});
it("loads only the matching brief", () => {
  expect(specialistBrief("docs", "planning")).toContain("Specialist: documentation.");
  expect(specialistBrief("reviewer", "review")).toContain("Specialist: skeptical reviewer.");
  expect(specialistBrief("crew", "build")).not.toContain("Specialist: researcher.");
});

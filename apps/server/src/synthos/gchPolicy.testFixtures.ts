import * as GchPolicy from "./gchPolicy.ts";

export const fixtureGchRules = "# Fixture GCH rules\n\nFixtures carry no private policy text.\n";
export const fixtureGchSources: GchPolicy.GchPolicySources = {
  version: "fixture/rules1",
  canonicalRules: null,
  canonicalRulesSha256: "37b820fb3529376264aac0b97ee3be50f5cd93767f55dcea3519e42ca8f6ad31",
  sourceRepository: "https://github.com/example/gch",
  capturedAt: "2026-11-13",
  sourceFolder: "https://example.test/gch-sources",
  sources: [{ path: "rules/AGENTS.md", sha256: "a".repeat(64) }],
  sourceCommit: "b".repeat(40),
};
export const fixtureGchFingerprint =
  "81f7e7a5d48a80141826f0f9dd5dfd9688e1b9381006e2212b8c040f7bd959bb";

const state = GchPolicy.verifyGchRules(fixtureGchSources, fixtureGchRules);
if (state.status !== "available") throw new Error("Fixture GCH rules must match their digest.");
export const fixtureGchPolicy = state;

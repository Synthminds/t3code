import { expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import { sealManifest, verifyManifest } from "./manifest.ts";

it("binds supplied context and accounting, and reseals after optional source removal", () => {
  const manifest = sealManifest({
    version: 1,
    projectId: ProjectId.make("project"),
    settingsVersion: 1,
    role: "lead",
    repositoryRevision: null,
    routes: [],
    sources: [
      {
        kind: "obsidian",
        path: "memory.md",
        version: "revision",
        tier: 1,
        reason: "Task match",
        excerpt: "Source evidence",
        required: false,
      },
    ],
    omissions: [],
    status: "ready",
    neighborhoodUsed: false,
    query: "Read source evidence",
  });
  expect(verifyManifest(manifest)).toBe(true);
  expect(verifyManifest({ ...manifest, bytes: 0 })).toBe(false);
  expect(verifyManifest({ ...manifest, estimatedTokens: 0 })).toBe(false);
  expect(verifyManifest({ ...manifest, sources: [] })).toBe(false);
  const withGraph = sealManifest({ ...manifest, graphRevision: "graph-one" });
  expect(verifyManifest(withGraph)).toBe(true);
  expect(verifyManifest({ ...withGraph, graphRevision: "graph-two" })).toBe(false);
  const trimmed = sealManifest({
    ...manifest,
    sources: [],
    omissions: [{ path: "memory.md", reason: "Optional budget omission" }],
    status: "degraded",
  });
  expect(trimmed.hash).not.toBe(manifest.hash);
  expect(trimmed.bytes).toBe(0);
  expect(verifyManifest(trimmed)).toBe(true);
});

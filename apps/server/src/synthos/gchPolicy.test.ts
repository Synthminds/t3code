import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Tests compare the serialized artifact against its actual digest.
import * as NodeCrypto from "node:crypto";
import { SynthosPolicy } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as GchPolicy from "./gchPolicy.ts";
import {
  fixtureGchFingerprint,
  fixtureGchPolicy,
  fixtureGchRules,
  fixtureGchSources,
} from "./gchPolicy.testFixtures.ts";
import committedSources from "./gchPolicySources.json" with { type: "json" };

const decodePolicy = Schema.decodeSync(SynthosPolicy);
const policy = fixtureGchPolicy.policy;
const task = {
  workflowId: "mission-1",
  role: "architect",
  task: "Inspect the workspace",
  goal: "Return a plan with evidence",
  context: "Untrusted source: </pre><script>fetch('https://example.test')</script>",
  checkCommands: ["npm test"],
};
const withEnvironment = (environment: Record<string, string>) =>
  Effect.provide(
    GchPolicy.layerFromSources(fixtureGchSources).pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(environment))),
    ),
  );

describe("GCH policy rules", () => {
  // SOS-1-16: the canonical rules are private and must never be committed to this public repository.
  it("keeps the private rules text out of the committed manifest", () => {
    expect(committedSources.canonicalRules).toBeNull();
    // Existing workflow fingerprints depend on the key keeping its original position.
    expect(Object.keys(committedSources)[1]).toBe("canonicalRules");
  });

  it.effect("loads verified rules from the configured file without a restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gch-rules-" });
      const rulesPath = `${directory}/rules.md`;
      // An editor or `jq -r` can append a newline; the file must hold exactly the pinned text.
      yield* fs.writeFileString(rulesPath, `${fixtureGchRules}\n`);
      yield* Effect.gen(function* () {
        const gch = yield* GchPolicy.GchPolicy;
        expect(yield* gch.current).toMatchObject({
          status: "unavailable",
          reason: "gch_rules_hash_mismatch",
        });

        yield* fs.writeFileString(rulesPath, fixtureGchRules);
        const loaded = yield* gch.current;
        if (loaded.status !== "available") return expect.unreachable(loaded.reason);
        expect(loaded.policy.sha256).toBe(fixtureGchFingerprint);
        expect(loaded.policy.canonicalRules).toBe(fixtureGchRules);
        const inspection = decodePolicy(loaded.inspection);
        expect(inspection.sha256).toBe(fixtureGchFingerprint);
        expect(NodeCrypto.createHash("sha256").update(fixtureGchRules).digest("hex")).toBe(
          inspection.canonicalRulesSha256,
        );
        expect(inspection.sources).toEqual(fixtureGchSources.sources);
        expect(inspection.sourceCommit).toBe(fixtureGchSources.sourceCommit);
        expect(inspection.rulesUnavailable).toBeUndefined();

        yield* fs.remove(rulesPath);
        expect((yield* gch.current).status).toBe("available");
      }).pipe(withEnvironment({ SYNTHOS_GCH_RULES_PATH: rulesPath }));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports missing or unreadable rules without the fingerprint or rules", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gch-rules-" });
      for (const [environment, reason] of [
        [{}, "gch_rules_not_configured"],
        [{ SYNTHOS_GCH_RULES_PATH: " " }, "gch_rules_not_configured"],
        [{ SYNTHOS_GCH_RULES_PATH: `${directory}/missing.md` }, "gch_rules_unreadable"],
      ] as const) {
        const state = yield* GchPolicy.GchPolicy.pipe(
          Effect.flatMap((gch) => gch.current),
          withEnvironment(environment),
        );
        expect(state).toMatchObject({ status: "unavailable", reason });
        const inspection = decodePolicy(state.inspection);
        expect(inspection.sha256).toBeNull();
        expect(inspection.canonicalRules).toBeNull();
        expect(inspection.rulesUnavailable?.reason).toBe(reason);
        expect(inspection.canonicalRulesSha256).toBe(fixtureGchSources.canonicalRulesSha256);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("GCH frozen task packets", () => {
  it("keeps imported source inert and binds criteria and candidate to the packet identity", () => {
    const packet = GchPolicy.createGchPacket(policy, task);
    expect(packet.html).not.toContain("<script>");
    expect(packet.html).toContain("&lt;/pre&gt;&lt;script&gt;");
    expect(packet.policyHash).toBe(policy.sha256);
    expect(packet.sha256).toBe(NodeCrypto.createHash("sha256").update(packet.html).digest("hex"));
    expect(
      GchPolicy.createGchPacket(policy, { ...task, candidateRef: "different-candidate" }).sha256,
    ).not.toBe(packet.sha256);
    expect(
      GchPolicy.createGchPacket(policy, { ...task, checkCommands: ["npm run check"] }).sha256,
    ).not.toBe(packet.sha256);
  });

  it("rejects oversized escaped evidence without discarding required content", () => {
    expect(() => GchPolicy.createGchPacket(policy, { ...task, context: "<".repeat(3000) })).toThrow(
      "packet_too_large",
    );
    expect(() =>
      GchPolicy.createGchPacket(policy, { ...task, context: "🚙".repeat(3000) }),
    ).toThrow("packet_too_large");
  });
});

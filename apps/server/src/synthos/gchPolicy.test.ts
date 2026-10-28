import { describe, expect, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Tests compare the serialized artifact against its actual digest.
import * as NodeCrypto from "node:crypto";
import { SynthosPolicy } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { createGchPacket, GCH_POLICY, GCH_POLICY_INSPECTION } from "./gchPolicy.ts";
import sources from "./gchPolicySources.json" with { type: "json" };

const decodePolicy = Schema.decodeSync(SynthosPolicy);
const task = {
  workflowId: "mission-1",
  role: "architect",
  task: "Inspect the workspace",
  goal: "Return a plan with evidence",
  context: "Untrusted source: </pre><script>fetch('https://example.test')</script>",
  checkCommands: ["npm test"],
};

describe("GCH frozen task packets", () => {
  it("exposes the exact bounded policy artifact without changing existing workflow identity", () => {
    const policy = decodePolicy(GCH_POLICY_INSPECTION);
    const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
    expect(policy.sha256).toBe(
      NodeCrypto.createHash("sha256")
        .update(
          encode({ sources, enforced: GCH_POLICY.enforced, limitations: GCH_POLICY.limitations }),
        )
        .digest("hex"),
    );
    expect(NodeCrypto.createHash("sha256").update(policy.canonicalRules).digest("hex")).toBe(
      policy.canonicalRulesSha256,
    );
    expect(policy.sources).toEqual(sources.sources);
    expect(policy.sourceCommit).toBe(sources.sourceCommit);
    expect(Buffer.byteLength(encode(policy), "utf8")).toBeLessThan(96 * 1024);
  });

  it("keeps imported source inert and binds criteria and candidate to the packet identity", () => {
    const packet = createGchPacket(task);
    expect(packet.html).not.toContain("<script>");
    expect(packet.html).toContain("&lt;/pre&gt;&lt;script&gt;");
    expect(packet.policyHash).toBe(GCH_POLICY.sha256);
    expect(packet.sha256).toBe(NodeCrypto.createHash("sha256").update(packet.html).digest("hex"));
    expect(createGchPacket({ ...task, candidateRef: "different-candidate" }).sha256).not.toBe(
      packet.sha256,
    );
    expect(createGchPacket({ ...task, checkCommands: ["npm run check"] }).sha256).not.toBe(
      packet.sha256,
    );
  });

  it("rejects oversized escaped evidence without discarding required content", () => {
    expect(() => createGchPacket({ ...task, context: "<".repeat(3000) })).toThrow(
      "packet_too_large",
    );
    expect(() => createGchPacket({ ...task, context: "🚙".repeat(3000) })).toThrow(
      "packet_too_large",
    );
  });
});

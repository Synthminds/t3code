import { describe, expect, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Tests compare the serialized artifact against its actual digest.
import * as NodeCrypto from "node:crypto";
import { createGchPacket, GCH_POLICY } from "./gchPolicy.ts";

const task = {
  workflowId: "mission-1",
  role: "architect",
  task: "Inspect the workspace",
  goal: "Return a plan with evidence",
  context: "Untrusted source: </pre><script>fetch('https://example.test')</script>",
  checkCommands: ["npm test"],
};

describe("GCH frozen task packets", () => {
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

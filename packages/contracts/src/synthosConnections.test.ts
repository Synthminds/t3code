import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { SynthosConnectionCommand, SynthosConnectionResult } from "./synthosConnections.ts";

const decodeResult = Schema.decodeUnknownSync(SynthosConnectionResult);
const accepts = Schema.is(SynthosConnectionCommand);

describe("SynthosConnectionResult", () => {
  it("drops a connection id this client does not know instead of failing the status list", () => {
    const dam = {
      id: "dam",
      label: "DAM Library",
      state: "configured",
      capabilities: ["library.search"],
      reason: "DAM checkout configured.",
    };
    expect(decodeResult({ connections: [dam, { ...dam, id: "future-connection" }] })).toEqual({
      connections: [dam],
    });
  });
});

describe("SynthosConnectionCommand", () => {
  it("accepts library ids up to DAM's own limits", () => {
    expect(accepts({ type: "library.principle", id: "p".repeat(41) })).toBe(true);
    expect(accepts({ type: "library.principle", id: "p".repeat(42) })).toBe(false);
    expect(accepts({ type: "library.asset", id: "a".repeat(80) })).toBe(true);
    expect(accepts({ type: "library.asset", id: "a".repeat(81) })).toBe(false);
  });
});

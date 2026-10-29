import { describe, expect, it } from "vite-plus/test";
import { synthosAttention } from "./synthosAttention";

describe("synthosAttention", () => {
  it("classifies current gates without reviving a superseded failed check", () => {
    const failed = { stage: "check", status: "failed", checkPassed: false } as const;
    const passed = { stage: "check", status: "completed", checkPassed: true } as const;
    const classify = (
      status: Parameters<typeof synthosAttention>[0]["status"],
      stage: Parameters<typeof synthosAttention>[0]["stage"],
      attempts: readonly (typeof failed | typeof passed)[],
    ) => synthosAttention({ status, stage, attempts });
    expect(classify("blocked", "check", [failed])).toBe("failed_check");
    expect(classify("waiting_decision", "decision", [failed, passed])).toBe("decision");
    expect(classify("blocked", "review", [failed, passed])).toBe("blocked");
    expect(classify("running", "build", [failed])).toBeNull();
    expect(classify("completed", "publication", [failed, passed])).toBeNull();
    expect(classify("cancelled", "check", [failed])).toBeNull();
  });
});

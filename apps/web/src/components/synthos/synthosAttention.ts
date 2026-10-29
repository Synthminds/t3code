import type { SynthosAttempt, SynthosWorkflow } from "@t3tools/contracts";

export function synthosAttention(
  workflow: Pick<SynthosWorkflow, "status" | "stage"> & {
    attempts: readonly Pick<SynthosAttempt, "stage" | "status" | "checkPassed">[];
  },
) {
  if (workflow.status === "waiting_decision") return "decision";
  if (workflow.status !== "blocked") return null;
  const check = workflow.attempts.findLast((attempt) => attempt.stage === "check");
  return workflow.stage === "check" && (check?.checkPassed === false || check?.status === "failed")
    ? "failed_check"
    : "blocked";
}

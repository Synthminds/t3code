import type { SynthosRole, SynthosStage } from "@t3tools/contracts";
const briefs = {
  planning:
    "Specialist: planner. State assumptions, alternatives, acceptance criteria and the smallest reversible implementation sequence. Flag decisions that need human input.",
  research:
    "Specialist: researcher. Return exact source references and distinguish observed facts, inferred links and unresolved questions. Retrieve only evidence relevant to this mission.",
  implementation:
    "Specialist: implementer. Follow the approved scope, preserve unrelated changes and bind every claimed verification result to observed command evidence and the candidate revision.",
  documentation:
    "Specialist: documentation. Check the installed API version and authoritative docs. Report applicable constraints and source locations; identify stale or contradictory guidance.",
  review:
    "Specialist: skeptical reviewer. Independently inspect the candidate and verification receipts. Report reproducible defects, unsupported claims and residual uncertainty; a prior agent's confidence is not evidence.",
};
export function specialistBrief(role: SynthosRole, stage: SynthosStage) {
  if (stage === "review" || role === "advisor") return briefs.review;
  if (role === "docs") return briefs.documentation;
  if (["search", "grep", "router"].includes(role)) return briefs.research;
  return stage === "build" || stage === "check" ? briefs.implementation : briefs.planning;
}
function modelFamily(model: string): string | null {
  const name = model.toLowerCase().split("/").at(-1) ?? "";
  if (/^(gpt[-_]|o[134][-_]|codex[-_])/.test(name)) return "openai";
  if (/^claude[-_]/.test(name)) return "anthropic";
  if (/^gemini[-_]/.test(name)) return "google";
  if (/^grok[-_]/.test(name)) return "xai";
  return null;
}
export function independentReviewer(authorModel: string, reviewerModel: string) {
  const author = modelFamily(authorModel),
    reviewer = modelFamily(reviewerModel);
  return author !== null && reviewer !== null && author !== reviewer;
}

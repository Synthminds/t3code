import { SynthosContextManifest } from "./synthosContext.ts";
import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { CommandId, ProjectId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

const ShortText = TrimmedNonEmptyString.check(Schema.isMaxLength(240));
const Description = TrimmedNonEmptyString.check(Schema.isMaxLength(12000));
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const SynthosPolicy = Schema.Struct({
  version: ShortText,
  sha256: Sha256,
  applicationScope: Schema.Literal("synthos_workflows"),
  sourceRepository: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
  sourceCommit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  capturedAt: ShortText,
  canonicalRulesSha256: Sha256,
  canonicalRules: Schema.String.check(Schema.isMaxLength(65536)),
  sources: Schema.Array(
    Schema.Struct({
      path: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
      sha256: Sha256,
    }),
  ).check(Schema.isMaxLength(512)),
  enforced: Schema.Array(Description).check(Schema.isMaxLength(32)),
  limitations: Schema.Array(Description).check(Schema.isMaxLength(32)),
});
export type SynthosPolicy = typeof SynthosPolicy.Type;

export const SynthosRole = Schema.Literals([
  "architect",
  "pm",
  "crew",
  "lead",
  "search",
  "grep",
  "docs",
  "router",
  "advisor",
  "reviewer",
]);
export type SynthosRole = typeof SynthosRole.Type;
export const SynthosStage = Schema.Literals([
  "intake",
  "planning",
  "build",
  "check",
  "review",
  "decision",
  "publication",
]);
export type SynthosStage = typeof SynthosStage.Type;
export const SynthosStatus = Schema.Literals([
  "proposed",
  "running",
  "waiting_decision",
  "blocked",
  "completed",
  "cancelled",
]);
export const SynthosBinding = Schema.Struct({
  role: SynthosRole,
  modelSelection: ModelSelection,
  backupModelSelection: Schema.optionalKey(ModelSelection),
  inputTokenLimit: PositiveInt.check(Schema.isLessThanOrEqualTo(125000)),
  outputTokenLimit: PositiveInt.check(Schema.isLessThanOrEqualTo(64000)),
});
export type SynthosBinding = typeof SynthosBinding.Type;
export const SynthosBudget = Schema.Struct({
  durationMs: PositiveInt.check(Schema.isLessThanOrEqualTo(1800000)),
  maxLoops: PositiveInt.check(Schema.isLessThanOrEqualTo(5)),
  maxBuilds: PositiveInt.check(Schema.isLessThanOrEqualTo(3)),
  maxAdvisorCalls: NonNegativeInt.check(Schema.isLessThanOrEqualTo(3)),
  maxAdvisorTokens: NonNegativeInt.check(Schema.isLessThanOrEqualTo(125000)),
  maxTokens: PositiveInt,
});
export const SYNTHOS_DEFAULT_BUDGET: typeof SynthosBudget.Type = {
  durationMs: 1800000,
  maxLoops: 5,
  maxBuilds: 3,
  maxAdvisorCalls: 3,
  maxAdvisorTokens: 125000,
  maxTokens: 500000,
};
export const SynthosUsage = Schema.Struct({
  loops: NonNegativeInt,
  builds: NonNegativeInt,
  calls: NonNegativeInt,
  advisorCalls: NonNegativeInt,
  advisorTokens: NonNegativeInt,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reservedTokens: NonNegativeInt,
  incompleteUsage: Schema.Boolean,
});
export const SynthosAttempt = Schema.Struct({
  id: ShortText,
  commandId: CommandId,
  threadId: ThreadId,
  modelSelection: Schema.optionalKey(ModelSelection),
  stage: SynthosStage,
  role: SynthosRole,
  status: Schema.Literals(["pending", "running", "completed", "failed", "cancelled"]),
  loop: PositiveInt,
  inputReserved: NonNegativeInt,
  outputReserved: NonNegativeInt,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  usageComplete: Schema.Boolean,
  result: Schema.String.check(Schema.isMaxLength(32000)),
  evidenceHash: Schema.NullOr(Schema.String),
  candidateRef: Schema.NullOr(Schema.String),
  checkPassed: Schema.NullOr(Schema.Boolean),
  packetHtml: Schema.String,
  packetHash: Schema.String,
  contextManifest: Schema.optional(SynthosContextManifest),
  packetOmitted: Schema.optional(Schema.Boolean),
  resultOmitted: Schema.optional(Schema.Boolean),
});
export type SynthosAttempt = typeof SynthosAttempt.Type;
export const SynthosWorkflow = Schema.Struct({
  id: ShortText,
  projectId: ProjectId,
  title: ShortText,
  task: Description,
  reviewMode: Schema.optionalKey(Schema.Literals(["standard", "independent"])),
  policyHash: Schema.String,
  policyVersion: Schema.String,
  detailOmitted: Schema.optional(Schema.Boolean),
  stage: SynthosStage,
  status: SynthosStatus,
  revision: NonNegativeInt,
  bindings: Schema.Array(SynthosBinding).check(Schema.isMaxLength(10)),
  checkCommands: Schema.Array(ShortText).check(Schema.isMaxLength(20)),
  baseRef: ShortText,
  budget: SynthosBudget,
  usage: SynthosUsage,
  attempts: Schema.Array(SynthosAttempt),
  activeAttemptId: Schema.NullOr(ShortText),
  worktreePath: Schema.NullOr(Schema.String),
  createdAt: NonNegativeInt,
  startedAt: Schema.NullOr(NonNegativeInt),
  updatedAt: NonNegativeInt,
  deadlineAt: Schema.NullOr(NonNegativeInt),
  blockReason: Schema.NullOr(Schema.String),
  decision: Schema.NullOr(
    Schema.Struct({
      actorId: ShortText,
      action: Schema.Literals(["approve", "reject", "revise"]),
      evidenceHash: Schema.String,
      reason: Schema.String,
      at: NonNegativeInt,
    }),
  ),
  publication: Schema.Struct({
    status: Schema.Literals(["not_requested", "package_ready", "unconfigured"]),
    evidenceHash: Schema.NullOr(Schema.String),
    candidateRef: Schema.NullOr(Schema.String),
  }),
});
export type SynthosWorkflow = typeof SynthosWorkflow.Type;
export const SynthosCreateInput = Schema.Struct({
  commandId: CommandId,
  workflowId: ShortText,
  projectId: ProjectId,
  title: ShortText,
  task: Description,
  reviewMode: Schema.optionalKey(Schema.Literals(["standard", "independent"])),
  bindings: Schema.Array(SynthosBinding).check(Schema.isMaxLength(10)),
  checkCommands: Schema.Array(ShortText).check(Schema.isMaxLength(20)),
  baseRef: Schema.optional(ShortText),
  budget: Schema.optional(SynthosBudget),
});
export type SynthosCreateInput = typeof SynthosCreateInput.Type;
export const SynthosCommandInput = Schema.Struct({
  commandId: CommandId,
  expectedRevision: NonNegativeInt,
  action: Schema.Literals([
    "start",
    "reconcile",
    "retry",
    "approve",
    "revise",
    "reject",
    "cancel",
    "advisor",
  ]),
  reason: Schema.optional(Description),
});
export type SynthosCommandInput = typeof SynthosCommandInput.Type;
export const SynthosEvent = Schema.Struct({
  sequence: PositiveInt,
  workflowId: ShortText,
  revision: NonNegativeInt,
  type: ShortText,
  actorId: ShortText,
  at: NonNegativeInt,
  stage: SynthosStage,
  status: SynthosStatus,
});
export type SynthosEvent = typeof SynthosEvent.Type;

export class SynthosRequestError extends Schema.TaggedError<SynthosRequestError>()(
  "SynthosRequestError",
  { reason: Schema.String },
  { httpApiStatus: 409 },
) {
  override get message() {
    return `SynthOS request could not proceed: ${this.reason}.`;
  }
}

import { specialistBrief } from "./specialists.ts";
import * as SynthosContext from "../synthos-context/SynthosContext.ts";
import { verifyManifest } from "../synthos-context/manifest.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Evidence and dispatch identities need deterministic digests.
import * as NodeCrypto from "node:crypto";
import {
  CheckpointRef,
  CommandId,
  type SynthosAttempt,
  type SynthosWorkflow,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { GCH_POLICY } from "./gchPolicy.ts";
import * as ProjectService from "../project/ProjectService.ts";

export class SynthosRuntimeError extends Schema.TaggedError<SynthosRuntimeError>()(
  "SynthosRuntimeError",
  { operation: Schema.Literals(["launch", "observe", "interrupt"]), cause: Schema.Defect() },
) {
  override get message() {
    return `T3 workflow runtime failed during ${this.operation}.`;
  }
}

export interface SynthosObservation {
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly worktreePath: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly usageComplete: boolean;
  readonly result: string;
  readonly resultOmitted?: boolean;
  readonly evidenceHash: string;
  readonly candidateRef: string | null;
  readonly checkPassed: boolean | null;
}

export class SynthosRuntime extends Context.Service<
  SynthosRuntime,
  {
    readonly launch: (
      workflow: SynthosWorkflow,
      attempt: SynthosAttempt,
    ) => Effect.Effect<void, SynthosRuntimeError>;
    readonly observe: (
      workflow: SynthosWorkflow,
      attempt: SynthosAttempt,
    ) => Effect.Effect<SynthosObservation, SynthosRuntimeError>;
    readonly interrupt: (
      workflow: SynthosWorkflow,
      attempt: SynthosAttempt,
    ) => Effect.Effect<boolean, SynthosRuntimeError>;
    readonly verifyCandidate: (
      workflow: SynthosWorkflow,
    ) => Effect.Effect<boolean, SynthosRuntimeError>;
  }
>()("t3/synthos/SynthosRuntime") {}

const encodeEvidence = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const make = Effect.gen(function* () {
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const projects = yield* ProjectService.ProjectService;
  const contexts = yield* SynthosContext.SynthosContext;
  const candidateRefFor = (key: string) =>
    CheckpointRef.make(
      `refs/t3/synthos/${NodeCrypto.createHash("sha256").update(key).digest("hex")}`,
    );

  const capture = Effect.fn("SynthosRuntime.captureCandidate")(
    function* (cwd: string, key: string, immutable = true) {
      const checkpointRef = candidateRefFor(key);
      if (!immutable || !(yield* checkpoints.hasCheckpointRef({ cwd, checkpointRef }))) {
        yield* checkpoints.captureCheckpoint({ cwd, checkpointRef });
      }
      return checkpointRef;
    },
    Effect.mapError((cause) => new SynthosRuntimeError({ operation: "observe", cause })),
  );
  const sameCandidate = Effect.fn("SynthosRuntime.sameCandidate")(
    function* (cwd: string, before: string, after: string) {
      const diff = yield* checkpoints.diffCheckpoints({
        cwd,
        fromCheckpointRef: CheckpointRef.make(before),
        toCheckpointRef: CheckpointRef.make(after),
        ignoreWhitespace: false,
        format: "numstat",
        maxOutputBytes: 1048576,
      });
      return diff.length === 0;
    },
    Effect.mapError((cause) => new SynthosRuntimeError({ operation: "observe", cause })),
  );

  const launch = Effect.fn("SynthosRuntime.launch")(function* (
    workflow: SynthosWorkflow,
    attempt: SynthosAttempt,
  ) {
    const project = yield* projects
      .getById(workflow.projectId)
      .pipe(Effect.mapError((cause) => new SynthosRuntimeError({ operation: "launch", cause })));
    if (
      Option.isNone(project) ||
      !(yield* checkpoints
        .isGitRepository(project.value.workspaceRoot)
        .pipe(Effect.mapError((cause) => new SynthosRuntimeError({ operation: "launch", cause }))))
    ) {
      return yield* new SynthosRuntimeError({
        operation: "launch",
        cause: new Error("git_project_required"),
      });
    }
    const binding = workflow.bindings.find((entry) => entry.role === attempt.role)!;
    if (attempt.stage === "check" && workflow.worktreePath !== null)
      yield* capture(workflow.worktreePath, `${attempt.id}:before`);
    if (
      workflow.policyHash !== GCH_POLICY.sha256 ||
      NodeCrypto.createHash("sha256").update(attempt.packetHtml).digest("hex") !==
        attempt.packetHash
    ) {
      return yield* new SynthosRuntimeError({
        operation: "launch",
        cause: new Error("frozen_packet_integrity_failed"),
      });
    }
    if (attempt.contextManifest) {
      if (
        !verifyManifest(attempt.contextManifest) ||
        !attempt.packetHtml.includes(attempt.contextManifest.hash)
      )
        return yield* new SynthosRuntimeError({
          operation: "launch",
          cause: new Error("context_integrity_failed"),
        });
      yield* contexts
        .validate(
          attempt.contextManifest,
          workflow.worktreePath ?? project.value.workspaceRoot,
          workflow.worktreePath ? undefined : workflow.baseRef,
        )
        .pipe(Effect.mapError((cause) => new SynthosRuntimeError({ operation: "launch", cause })));
    }
    const prompt = `${GCH_POLICY.canonicalRules}\n\n${attempt.packetHtml}`;
    // Reserve against the full packet before dispatch. An oversized accumulated context is never silently truncated.
    if (Math.ceil(Buffer.byteLength(prompt, "utf8") / 3) > binding.inputTokenLimit) {
      return yield* new SynthosRuntimeError({
        operation: "launch",
        cause: new Error("packet_budget_exceeded"),
      });
    }
    yield* launches
      .launch({
        commandId: attempt.commandId,
        threadId: attempt.threadId,
        projectId: workflow.projectId,
        title: `${workflow.title} · ${attempt.role}`.slice(0, 240),
        modelSelection: attempt.modelSelection ?? binding.modelSelection,
        runtimeMode: "approval-required",
        interactionMode:
          attempt.stage === "planning" || attempt.stage === "review" || attempt.role === "advisor"
            ? "plan"
            : "default",
        workspaceStrategy:
          workflow.worktreePath === null
            ? { type: "worktree", baseRef: workflow.baseRef }
            : { type: "existing_worktree", worktreePath: workflow.worktreePath },
        initialMessage: { text: prompt, attachments: [] },
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(Effect.mapError((cause) => new SynthosRuntimeError({ operation: "launch", cause })));
  });

  const observe = Effect.fn("SynthosRuntime.observe")(function* (
    workflow: SynthosWorkflow,
    attempt: SynthosAttempt,
  ): Effect.fn.Return<SynthosObservation, SynthosRuntimeError> {
    const { projection } = yield* threads
      .getThreadSnapshot(attempt.threadId)
      .pipe(Effect.mapError((cause) => new SynthosRuntimeError({ operation: "observe", cause })));
    const latest = projection.runs.reduce<(typeof projection.runs)[number] | undefined>(
      (current, run) => (current === undefined || run.ordinal > current.ordinal ? run : current),
      undefined,
    );
    const completeStatuses = new Set([
      "completed",
      "failed",
      "cancelled",
      "interrupted",
      "rolled_back",
    ]);
    const status =
      projection.runs.length > 1
        ? "failed"
        : latest === undefined || !completeStatuses.has(latest.status)
          ? "running"
          : latest.status === "completed"
            ? "completed"
            : latest.status === "interrupted" || latest.status === "cancelled"
              ? "cancelled"
              : "failed";
    const turns = projection.providerTurns;
    const inputTokens = turns.reduce(
      (sum, turn) => sum + (turn.turnTokenUsage?.inputTokens ?? 0),
      0,
    );
    const outputTokens = turns.reduce(
      (sum, turn) => sum + (turn.turnTokenUsage?.outputTokens ?? 0),
      0,
    );
    // T3's receipt covers the main agent; delegated native spend is not included in that total.
    const usageComplete =
      turns.length > 0 &&
      turns.every(
        (turn) =>
          turn.turnTokenUsage?.usageStatus === "complete" && !turn.turnTokenUsage.hasSubagents,
      );
    const completeResult = projection.messages
      .filter(
        (message) =>
          message.role === "assistant" && message.runId === latest?.id && !message.streaming,
      )
      .map((message) => message.text)
      .join("\n\n");
    const resultHash = NodeCrypto.createHash("sha256").update(completeResult).digest("hex");
    const resultOmitted = completeResult.length > 32000;
    const result = resultOmitted
      ? `[Earlier output omitted; full evidence: T3 thread ${attempt.threadId}; sha256 ${resultHash}]\n${completeResult.slice(-31700)}`
      : completeResult;
    const commands = projection.turnItems
      .filter((item) => item.type === "command_execution")
      .filter((item) => item.runId === latest?.id)
      .sort((a, b) => a.ordinal - b.ordinal);
    const candidateRef =
      status === "completed" && projection.thread.worktreePath !== null
        ? yield* capture(projection.thread.worktreePath, `${attempt.id}:after`)
        : null;
    let checkPassed =
      attempt.stage !== "check" ? null : verificationPassed(workflow.checkCommands, commands);
    if (
      candidateRef !== null &&
      projection.thread.worktreePath !== null &&
      attempt.stage === "check"
    ) {
      const before = candidateRefFor(`${attempt.id}:before`);
      const hasBefore = yield* checkpoints
        .hasCheckpointRef({ cwd: projection.thread.worktreePath, checkpointRef: before })
        .pipe(Effect.mapError((cause) => new SynthosRuntimeError({ operation: "observe", cause })));
      checkPassed =
        checkPassed &&
        hasBefore &&
        (yield* sameCandidate(projection.thread.worktreePath, before, candidateRef));
    }
    if (
      candidateRef !== null &&
      projection.thread.worktreePath !== null &&
      attempt.stage === "review"
    ) {
      const checked = workflow.attempts.findLast(
        (entry) => entry.stage === "check" && entry.checkPassed === true,
      );
      checkPassed =
        checked?.candidateRef !== null &&
        checked?.candidateRef !== undefined &&
        (yield* sameCandidate(projection.thread.worktreePath, checked.candidateRef, candidateRef));
    }
    const evidenceJson = yield* encodeEvidence({
      threadId: attempt.threadId,
      packetHash: attempt.packetHash,
      policyHash: workflow.policyHash,
      status,
      result,
      resultHash,
      candidateRef,
      commands: commands.map((item) => ({
        id: item.id,
        input: item.input,
        exitCode: item.exitCode,
        outputIndicatesFailure: item.outputIndicatesFailure,
        outputHash: NodeCrypto.createHash("sha256")
          .update(item.output ?? "")
          .digest("hex"),
      })),
    }).pipe(Effect.mapError((cause) => new SynthosRuntimeError({ operation: "observe", cause })));
    const evidenceHash = NodeCrypto.createHash("sha256").update(evidenceJson).digest("hex");
    return {
      status,
      worktreePath: projection.thread.worktreePath,
      inputTokens,
      outputTokens,
      usageComplete,
      result,
      resultOmitted,
      evidenceHash,
      candidateRef,
      checkPassed,
    };
  });

  const interrupt = Effect.fn("SynthosRuntime.interrupt")(
    function* (workflow: SynthosWorkflow, attempt: SynthosAttempt) {
      const shell = yield* threads.getThreadShell(attempt.threadId);
      if (shell === null) return true;
      const result = yield* threads.interruptThread({
        projectId: workflow.projectId,
        threadId: attempt.threadId,
        commandId: CommandId.make(`${attempt.commandId}:stop`),
        reason: "SynthOS workflow stopped or exhausted its cumulative budget.",
      });
      return result.type !== "interrupt_requested";
    },
    Effect.mapError((cause) => new SynthosRuntimeError({ operation: "interrupt", cause })),
  );
  const verifyCandidate = Effect.fn("SynthosRuntime.verifyCandidate")(function* (
    workflow: SynthosWorkflow,
  ) {
    const checked = workflow.attempts.findLast(
      (entry) => entry.stage === "check" && entry.checkPassed === true,
    );
    if (workflow.worktreePath === null || checked?.candidateRef == null) return false;
    const current = yield* capture(
      workflow.worktreePath,
      `${workflow.id}:approval:${workflow.revision}`,
      false,
    );
    return yield* sameCandidate(workflow.worktreePath, checked.candidateRef, current);
  });
  return SynthosRuntime.of({ launch, observe, interrupt, verifyCandidate });
});
export const layer = Layer.effect(SynthosRuntime, make);

function verificationPassed(
  expected: ReadonlyArray<string>,
  observed: ReadonlyArray<{
    readonly input: string;
    readonly exitCode?: number | undefined;
    readonly outputIndicatesFailure?: boolean | undefined;
  }>,
): boolean {
  return (
    expected.length > 0 &&
    expected.every((command) => {
      const latest = observed.findLast((entry) => entry.input.trim() === command.trim());
      return latest?.exitCode === 0 && latest.outputIndicatesFailure !== true;
    })
  );
}

export function roleGoal(role: SynthosAttempt["role"], stage: SynthosAttempt["stage"]): string {
  const goals: Partial<Record<SynthosAttempt["role"], string>> = {
    router:
      "Locate relevant repository paths and route the task using observed evidence. Do not edit files or publish.",
    search:
      "Research external facts needed for this task. Cite sources and distinguish evidence from assumptions. Do not edit files or publish.",
    grep: "Inspect definitions and call sites relevant to the task. Report exact paths and findings. Do not edit files or publish.",
    docs: "Read applicable project and upstream documentation. Report constraints and source references. Do not edit files or publish.",
    pm: "Turn the plan into a scoped acceptance checklist and deliverables. Resolve scope gaps. Do not edit files or publish.",
    advisor: "Advise on risky seams and minimum verification. Do not edit files or publish.",
  };
  return (
    specialistBrief(role, stage) +
    " " +
    (goals[role] ??
      (stage === "check"
        ? "Execute each exact required verification command through T3 tools and report observed outcomes. Preserve the candidate files and test oracle."
        : stage === "review"
          ? "Adversarially review the candidate and its verification evidence. Report defects, risks and uncertainty. Preserve all candidate files. Do not publish or merge."
          : stage === "build"
            ? "Implement the scoped plan in this isolated workspace. Preserve existing test expectations; do not weaken checks to claim success. Do not publish or merge."
            : "Inspect the task and workspace, then produce a plan with acceptance criteria. Do not edit files or publish."))
  );
}

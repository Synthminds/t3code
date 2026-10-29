import * as SynthosContext from "../synthos-context/SynthosContext.ts";
import { sealManifest, renderManifest } from "../synthos-context/manifest.ts";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  SYNTHOS_DEFAULT_BUDGET,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type SynthosAttempt,
  type SynthosWorkflow,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SynthosRuntime from "./SynthosRuntime.ts";
import { createGchPacket, GCH_POLICY } from "./gchPolicy.ts";

const threadId = ThreadId.make("thread:runtime-review");
const projectId = ProjectId.make("project:runtime-review");
const runId = RunId.make("run:runtime-review");
const providerThreadId = ProviderThreadId.make("provider-thread:runtime-review");
const providerTurnId = ProviderTurnId.make("provider-turn:runtime-review");
const modelSelection = {
  instanceId: ProviderInstanceId.make("fixture"),
  model: "fixture",
};

function makeAttempt(stage: "check" | "review"): SynthosAttempt {
  const role = stage === "check" ? "lead" : "reviewer";
  const packet = createGchPacket({
    workflowId: "workflow:runtime-review",
    task: "Change the implementation and verify it",
    role,
    goal: SynthosRuntime.roleGoal(role, stage),
    context: "",
    checkCommands: ["npm test"],
  });
  return {
    id: `attempt:${stage}`,
    commandId: CommandId.make(`command:${stage}`),
    threadId,
    stage,
    role,
    status: "running",
    loop: 1,
    packetHtml: packet.html,
    packetHash: packet.sha256,
    inputReserved: 10_000,
    outputReserved: 1_000,
    inputTokens: 0,
    outputTokens: 0,
    usageComplete: false,
    result: "",
    evidenceHash: null,
    candidateRef: null,
    checkPassed: null,
  };
}

function makeWorkflow(attempt: SynthosAttempt): SynthosWorkflow {
  return {
    id: "workflow:runtime-review",
    projectId,
    title: "Runtime review",
    task: "Change the implementation and verify it",
    policyHash: GCH_POLICY.sha256,
    policyVersion: GCH_POLICY.version,
    stage: attempt.stage,
    status: "running",
    revision: 1,
    bindings: (["lead", "reviewer"] as const).map((role) => ({
      role,
      modelSelection,
      inputTokenLimit: 10_000,
      outputTokenLimit: 1_000,
    })),
    checkCommands: ["npm test"],
    baseRef: "HEAD",
    budget: SYNTHOS_DEFAULT_BUDGET,
    usage: {
      loops: 1,
      builds: 1,
      calls: 1,
      advisorCalls: 0,
      advisorTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reservedTokens: 11_000,
      incompleteUsage: false,
    },
    attempts: [attempt],
    activeAttemptId: attempt.id,
    worktreePath: "/fixture/isolated-worktree",
    createdAt: 0,
    startedAt: 0,
    updatedAt: 0,
    deadlineAt: 1_800_000,
    blockReason: null,
    decision: null,
    publication: { status: "not_requested", evidenceHash: null, candidateRef: null },
  };
}

function command(now: DateTime.Utc, ordinal: number, exitCode?: number): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(`command-item:${ordinal}`),
    threadId,
    runId,
    nodeId: null,
    providerThreadId,
    providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: exitCode === undefined ? "running" : "completed",
    title: null,
    startedAt: now,
    completedAt: exitCode === undefined ? null : now,
    updatedAt: now,
    type: "command_execution",
    input: "npm test",
    ...(exitCode === undefined ? {} : { exitCode }),
  };
}

const completeUsage: TurnTokenUsage = {
  usageScope: "main_agent",
  usageStatus: "complete",
  hasSubagents: false,
  inputTokens: 100,
  outputTokens: 25,
};

const fixture = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const projection = yield* Ref.make<OrchestrationV2ThreadProjection>({
    thread: {
      id: threadId,
      projectId,
      title: "Runtime review",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: "/fixture/isolated-worktree",
      activeProviderThreadId: providerThreadId,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdBy: "system",
      creationSource: "server",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [
      {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        providerThreadId,
        userMessageId: MessageId.make("message:runtime-review"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    providerTurns: [
      {
        id: providerTurnId,
        providerThreadId,
        nodeId: NodeId.make("node:runtime-review"),
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "completed",
        startedAt: now,
        completedAt: now,
        turnTokenUsage: completeUsage,
      },
    ],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [command(now, 1, 0)],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: now,
  });
  const candidate = yield* Ref.make("checked implementation");
  const snapshots = yield* Ref.make(new Map<string, string>());
  const gitRepository = yield* Ref.make(true);
  const launches = yield* Ref.make(0);
  const layer = SynthosRuntime.layer.pipe(
    Layer.provide(Layer.mock(SynthosContext.SynthosContext)({ validate: () => Effect.void })),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: () =>
          Effect.succeedSome({
            id: projectId,
            title: "Runtime review",
            workspaceRoot: "/fixture/repository",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-10-28T00:00:00.000Z",
            updatedAt: "2026-10-28T00:00:00.000Z",
            deletedAt: null,
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadSnapshot: () =>
          Ref.get(projection).pipe(
            Effect.map((value) => ({
              schemaVersion: 2,
              snapshotSequence: 1,
              projection: value,
            })),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: () =>
          Ref.get(projection).pipe(
            Effect.tap(() => Ref.update(launches, (count) => count + 1)),
            Effect.map((value) => ({
              threadId,
              projection: value,
              resumed: false,
            })),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(CheckpointStore.CheckpointStore)({
        isGitRepository: () => Ref.get(gitRepository),
        hasCheckpointRef: ({ checkpointRef }) =>
          Ref.get(snapshots).pipe(Effect.map((values) => values.has(checkpointRef))),
        captureCheckpoint: ({ checkpointRef }) =>
          Ref.get(candidate).pipe(
            Effect.flatMap((content) =>
              Ref.update(snapshots, (values) => new Map(values).set(checkpointRef, content)),
            ),
          ),
        diffCheckpoints: ({ fromCheckpointRef, toCheckpointRef }) =>
          Ref.get(snapshots).pipe(
            Effect.map((values) =>
              values.get(fromCheckpointRef) === values.get(toCheckpointRef)
                ? ""
                : "1\t1\tsrc/implementation.ts\n",
            ),
          ),
      }),
    ),
  );
  return { now, projection, candidate, snapshots, gitRepository, launches, layer };
});

describe("SynthosRuntime evidence", () => {
  it.effect(
    "rejects a changed manifest or a manifest not bound to its packet before launching",
    () =>
      Effect.gen(function* () {
        const test = yield* fixture;
        yield* Effect.gen(function* () {
          const runtime = yield* SynthosRuntime.SynthosRuntime;
          const original = makeAttempt("check");
          const manifest = sealManifest({
            version: 1,
            projectId,
            role: "lead",
            query: "synthetic",
            settingsVersion: 0,
            repositoryRevision: null,
            routes: [],
            sources: [],
            omissions: [],
            status: "ready",
            neighborhoodUsed: false,
          });
          for (const contextManifest of [manifest, { ...manifest, query: "changed" }]) {
            const attempt = { ...original, contextManifest };
            const result = yield* runtime.launch(makeWorkflow(attempt), attempt).pipe(Effect.flip);
            assert.equal(result.operation, "launch");
          }
          assert.equal(yield* Ref.get(test.launches), 0);
          const packet = createGchPacket({
            workflowId: "workflow:runtime-review",
            task: "Synthetic context",
            role: "lead",
            goal: "Check",
            context: renderManifest(manifest),
            checkCommands: ["npm test"],
          });
          const bound = {
            ...original,
            contextManifest: manifest,
            packetHtml: packet.html,
            packetHash: packet.sha256,
          };
          yield* runtime.launch(makeWorkflow(bound), bound);
          assert.equal(yield* Ref.get(test.launches), 1);
        }).pipe(Effect.provide(test.layer));
      }),
  );

  it.effect("marks bounded result excerpts and points to the complete T3 evidence", () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      const text = "Full evidence ".repeat(3000);
      yield* Ref.update(test.projection, (projection) => ({
        ...projection,
        messages: [
          {
            id: MessageId.make("message:long-evidence"),
            threadId,
            runId,
            nodeId: null,
            createdBy: "agent" as const,
            creationSource: "provider" as const,
            role: "assistant" as const,
            text,
            attachments: [],
            streaming: false,
            createdAt: test.now,
            updatedAt: test.now,
          },
        ],
      }));
      yield* Effect.gen(function* () {
        const runtime = yield* SynthosRuntime.SynthosRuntime;
        const attempt = makeAttempt("check");
        const observed = yield* runtime.observe(makeWorkflow(attempt), attempt);
        assert.equal(observed.resultOmitted, true);
        assert.isAtMost(observed.result.length, 32000);
        assert.include(observed.result, `full evidence: T3 thread ${threadId}; sha256`);
        assert.equal((yield* Ref.get(test.projection)).messages[0]?.text, text);
      }).pipe(Effect.provide(test.layer));
    }),
  );

  it.effect("refuses non-Git projects before dispatching a provider turn", () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      yield* Ref.set(test.gitRepository, false);
      yield* Effect.gen(function* () {
        const runtime = yield* SynthosRuntime.SynthosRuntime;
        const attempt = makeAttempt("check");
        const error = yield* Effect.flip(runtime.launch(makeWorkflow(attempt), attempt));
        assert.equal(error.operation, "launch");
        assert.equal(yield* Ref.get(test.launches), 0);
      }).pipe(Effect.provide(test.layer));
    }),
  );
  it.effect(
    "uses the latest matching command outcome and refuses incomplete or failed verification",
    () =>
      Effect.gen(function* () {
        const test = yield* fixture;
        yield* Effect.gen(function* () {
          const runtime = yield* SynthosRuntime.SynthosRuntime;
          const attempt = makeAttempt("check");
          const workflow = makeWorkflow(attempt);
          yield* runtime.launch(workflow, attempt);
          for (const lastExit of [1, undefined, 0]) {
            yield* Ref.update(test.projection, (value) => ({
              ...value,
              turnItems: [command(test.now, 2, lastExit), command(test.now, 1, 0)],
            }));
            assert.equal((yield* runtime.observe(workflow, attempt)).checkPassed, lastExit === 0);
          }
          yield* Ref.update(test.projection, (value) => ({
            ...value,
            turnItems: [{ ...command(test.now, 1, 0), outputIndicatesFailure: true }],
          }));
          assert.equal((yield* runtime.observe(workflow, attempt)).checkPassed, false);
        }).pipe(Effect.provide(test.layer));
      }),
  );

  it.effect("refuses a follow-up run that inherits successful commands from the launched run", () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      yield* Effect.gen(function* () {
        const runtime = yield* SynthosRuntime.SynthosRuntime;
        const attempt = makeAttempt("check");
        const workflow = makeWorkflow(attempt);
        yield* runtime.launch(workflow, attempt);
        yield* Ref.update(test.projection, (value) => ({
          ...value,
          runs: value.runs.flatMap((run) => [
            run,
            { ...run, id: RunId.make("run:follow-up"), ordinal: 2 },
          ]),
        }));
        const observed = yield* runtime.observe(workflow, attempt);
        assert.equal(observed.status, "failed");
        assert.equal(observed.checkPassed, false);
        assert.isNull(observed.candidateRef);
      }).pipe(Effect.provide(test.layer));
    }),
  );

  it.effect("rejects candidate mutations during checking, review, and final approval", () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      yield* Effect.gen(function* () {
        const runtime = yield* SynthosRuntime.SynthosRuntime;
        const check = makeAttempt("check");
        const workflow = makeWorkflow(check);
        yield* runtime.launch(workflow, check);
        yield* Ref.set(test.candidate, "changed while checking");
        assert.equal((yield* runtime.observe(workflow, check)).checkPassed, false);

        const nextCheck = { ...check, id: "attempt:second-check" };
        yield* Ref.set(test.candidate, "checked implementation");
        yield* runtime.launch(workflow, nextCheck);
        const passed = yield* runtime.observe(workflow, nextCheck);
        assert.equal(passed.checkPassed, true);
        assert.isNotNull(passed.candidateRef);
        const review = makeAttempt("review");
        const reviewedWorkflow = {
          ...workflow,
          attempts: [{ ...nextCheck, ...passed }, review],
        };
        yield* runtime.launch(reviewedWorkflow, review);
        yield* Ref.set(test.candidate, "changed after verification");
        assert.equal((yield* runtime.observe(reviewedWorkflow, review)).checkPassed, false);
        assert.equal(yield* runtime.verifyCandidate(reviewedWorkflow), false);
        yield* Ref.set(test.candidate, "checked implementation");
        assert.equal(yield* runtime.verifyCandidate(reviewedWorkflow), true);
      }).pipe(Effect.provide(test.layer));
    }),
  );

  it.effect("refuses verification when the before-check snapshot is missing", () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      yield* Effect.gen(function* () {
        const runtime = yield* SynthosRuntime.SynthosRuntime;
        const attempt = makeAttempt("check");
        const workflow = makeWorkflow(attempt);
        yield* runtime.launch(workflow, attempt);
        yield* Ref.set(test.snapshots, new Map());
        assert.equal((yield* runtime.observe(workflow, attempt)).checkPassed, false);
      }).pipe(Effect.provide(test.layer));
    }),
  );

  it.effect("marks missing, partial, or delegated token usage incomplete", () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      yield* Effect.gen(function* () {
        const runtime = yield* SynthosRuntime.SynthosRuntime;
        const attempt = makeAttempt("check");
        const workflow = makeWorkflow(attempt);
        const receipts: ReadonlyArray<TurnTokenUsage | undefined> = [
          undefined,
          { usageScope: "main_agent", usageStatus: "unavailable", hasSubagents: false },
          { ...completeUsage, usageStatus: "partial" },
          { ...completeUsage, hasSubagents: true },
          completeUsage,
        ];
        for (const receipt of receipts) {
          yield* Ref.update(test.projection, (value) => ({
            ...value,
            providerTurns: value.providerTurns.map(({ turnTokenUsage: _usage, ...turn }) => ({
              ...turn,
              ...(receipt === undefined ? {} : { turnTokenUsage: receipt }),
            })),
          }));
          assert.equal(
            (yield* runtime.observe(workflow, attempt)).usageComplete,
            receipt === completeUsage,
          );
        }
      }).pipe(Effect.provide(test.layer));
    }),
  );
});

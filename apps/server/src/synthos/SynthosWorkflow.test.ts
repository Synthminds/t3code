import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  SYNTHOS_DEFAULT_BUDGET,
  type SynthosCreateInput,
  type SynthosWorkflow as Workflow,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import workflowMigration from "../persistence/Migrations/073_SynthosWorkflows.ts";
import policyMigration from "../persistence/Migrations/075_SynthosPolicySnapshots.ts";
import * as SynthosRuntime from "./SynthosRuntime.ts";
import * as SynthosWorkflow from "./SynthosWorkflow.ts";
const migration = Effect.andThen(workflowMigration, policyMigration);

const actor: SynthosWorkflow.SynthosActor = {
  id: "session:operator",
  scopes: new Set([AuthOrchestrationOperateScope, AuthSourceControlWriteScope]),
};
const input: SynthosCreateInput = {
  commandId: CommandId.make("create:workflow"),
  workflowId: "workflow:test",
  projectId: ProjectId.make("project:test"),
  title: "Test change",
  task: "Implement a scoped change",
  bindings: (["architect", "crew", "lead", "reviewer", "advisor"] as const).map((role) => ({
    role,
    modelSelection: { instanceId: ProviderInstanceId.make("fixture"), model: "fixture" },
    inputTokenLimit: 1000,
    outputTokenLimit: 1000,
  })),
  checkCommands: ["vp test run focused.test.ts"],
};
const makeRuntime = Effect.gen(function* () {
  const launches = yield* Ref.make<string[]>([]);
  const stops = yield* Ref.make<string[]>([]);
  const observation = yield* Ref.make<SynthosRuntime.SynthosObservation>({
    status: "completed",
    worktreePath: "/tmp/synthos-fixture",
    inputTokens: 100,
    outputTokens: 50,
    usageComplete: true,
    result: "reviewer says approved",
    evidenceHash: "evidence-fixture",
    candidateRef: "refs/t3/synthos/fixture",
    checkPassed: true,
  });
  const stopFails = yield* Ref.make(false);
  const stopSettled = yield* Ref.make(true);
  const candidateValid = yield* Ref.make(true);
  const runtime = SynthosRuntime.SynthosRuntime.of({
    verifyCandidate: () => Ref.get(candidateValid),
    launch: (_workflow, attempt) =>
      Ref.update(launches, (current) => [...current, attempt.commandId]),
    observe: () => Ref.get(observation),
    interrupt: (_workflow, attempt) =>
      Ref.get(stopFails).pipe(
        Effect.flatMap((fails) =>
          fails
            ? Effect.fail(
                new SynthosRuntime.SynthosRuntimeError({
                  operation: "interrupt",
                  cause: new Error("fixture unavailable"),
                }),
              )
            : Ref.update(stops, (current) => [...current, attempt.commandId]).pipe(
                Effect.andThen(Ref.get(stopSettled)),
              ),
        ),
      ),
  });
  const layer = SynthosWorkflow.layer.pipe(
    Layer.provide(Layer.succeed(SynthosRuntime.SynthosRuntime, runtime)),
  );
  return { launches, stops, observation, stopFails, stopSettled, candidateValid, layer };
});
const dispatch = Effect.fn("test.dispatch")(function* (
  workflow: Workflow,
  action: Parameters<SynthosWorkflow.SynthosWorkflow["Service"]["command"]>[1]["action"],
  commandId = `${workflow.id}:${action}:${workflow.revision}`,
  asActor = actor,
) {
  const service = yield* SynthosWorkflow.SynthosWorkflow;
  return yield* service.command(
    workflow.id,
    { commandId: CommandId.make(commandId), expectedRevision: workflow.revision, action },
    asActor,
  );
});
const finishStages = Effect.fn("test.finishStages")(function* () {
  const service = yield* SynthosWorkflow.SynthosWorkflow;
  // Four stages each require reservation, dispatch, and observed completion. Start already reserved the first.
  for (let transition = 0; transition < 11; transition += 1) yield* service.runDueWork;
  return (yield* service.get(input.workflowId)).workflow;
});

describe("SynthOS workflow", () => {
  it.effect("runs configured discovery and PM roles in the same durable planning sequence", () =>
    Effect.gen(function* () {
      yield* migration;
      const runtime = yield* makeRuntime;
      const fullEvidence = "Detailed evidence ".repeat(1700);
      yield* Ref.update(runtime.observation, (observed) => ({ ...observed, result: fullEvidence }));
      yield* Effect.gen(function* () {
        const service = yield* SynthosWorkflow.SynthosWorkflow;
        const roles = ["router", "search", "grep", "docs", "pm"] as const;
        const created = yield* service.create(
          {
            ...input,
            bindings: [
              ...input.bindings,
              ...roles.map((role) => ({ ...input.bindings[0]!, role })),
            ],
          },
          actor,
        );
        yield* dispatch(created, "start");
        for (let transition = 0; transition < 26; transition += 1) yield* service.runDueWork;
        const workflow = (yield* service.get(created.id)).workflow;
        assert.deepEqual(
          workflow.attempts.map((attempt) => attempt.role),
          ["router", "search", "grep", "docs", "architect", "pm", "crew", "lead", "reviewer"],
        );
        assert.equal(workflow.status, "waiting_decision");
        assert.equal(workflow.usage.calls, 9);
        assert.equal(workflow.usage.builds, 1);
        assert.equal(workflow.attempts[0]?.result, fullEvidence);
        assert.include(
          workflow.attempts[1]!.packetHtml,
          "Full result omitted from this bounded packet",
        );
        const preview = (yield* service.list())[0]!;
        assert.equal(preview.detailOmitted, true);
        assert.equal(preview.attempts[0]?.packetOmitted, true);
        assert.equal(preview.attempts[0]?.packetHtml, "");
        assert.include(preview.attempts[0]!.result, "Result preview");
      }).pipe(Effect.provide(runtime.layer));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "retains receipts across service reconstruction and rejects changed input or another actor",
    () =>
      Effect.gen(function* () {
        yield* migration;
        const runtime = yield* makeRuntime;
        const { created, reserved } = yield* Effect.gen(function* () {
          const service = yield* SynthosWorkflow.SynthosWorkflow;
          const created = yield* service.create(input, actor);
          const reserved = yield* dispatch(created, "start");
          return { created, reserved };
        }).pipe(Effect.provide(runtime.layer));
        yield* Effect.gen(function* () {
          const service = yield* SynthosWorkflow.SynthosWorkflow;
          assert.deepEqual(yield* service.create(input, actor), created);
          const changed = yield* Effect.flip(
            service.create({ ...input, task: "Different action" }, actor),
          );
          assert.equal(changed._tag, "SynthosWorkflowError");
          if (changed._tag === "SynthosWorkflowError")
            assert.equal(changed.reason, "idempotency_conflict");
          const impersonated = yield* Effect.flip(
            service.create(input, { ...actor, id: "session:another" }),
          );
          assert.equal(impersonated._tag, "SynthosWorkflowError");
          assert.equal((yield* service.list()).length, 1);
          yield* service.runDueWork;
          const resumed = (yield* service.get(created.id)).workflow;
          assert.equal(resumed.usage.calls, reserved.usage.calls);
          assert.equal(resumed.usage.reservedTokens, reserved.usage.reservedTokens);
          assert.deepEqual(yield* Ref.get(runtime.launches), [reserved.attempts[0]!.commandId]);
        }).pipe(Effect.provide(Layer.fresh(runtime.layer)));
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "dispatches through T3 once per reserved stage and requires a current authorized human decision",
    () =>
      Effect.gen(function* () {
        yield* migration;
        const runtime = yield* makeRuntime;
        yield* Effect.gen(function* () {
          const service = yield* SynthosWorkflow.SynthosWorkflow;
          const created = yield* service.create(input, actor);
          const started = yield* dispatch(created, "start", "start:once");
          yield* service.command(
            created.id,
            {
              commandId: CommandId.make("start:once"),
              expectedRevision: created.revision,
              action: "start",
            },
            actor,
          );
          assert.equal((yield* service.get(created.id)).workflow.usage.calls, 1);
          assert.equal(started.usage.builds, 0);
          const reviewed = yield* finishStages();
          assert.equal(reviewed.stage, "decision");
          assert.equal(reviewed.status, "waiting_decision");
          assert.equal(reviewed.decision, null);
          assert.equal((yield* Ref.get(runtime.launches)).length, 4);
          assert.equal(new Set(yield* Ref.get(runtime.launches)).size, 4);
          assert.equal(reviewed.usage.builds, 1);
          assert.equal(reviewed.usage.inputTokens, 400);
          const denied = yield* Effect.flip(
            dispatch(reviewed, "approve", "approve:no-scope", {
              id: actor.id,
              scopes: new Set([AuthOrchestrationOperateScope]),
            }),
          );
          assert.equal(denied._tag, "SynthosWorkflowError");
          const stale = yield* Effect.flip(
            dispatch({ ...reviewed, revision: reviewed.revision - 1 }, "approve", "approve:stale"),
          );
          assert.equal(stale._tag, "SynthosWorkflowError");
          yield* Ref.set(runtime.candidateValid, false);
          const changedCandidate = yield* Effect.flip(
            dispatch(reviewed, "approve", "approve:changed"),
          );
          assert.equal(changedCandidate._tag, "SynthosWorkflowError");
          yield* Ref.set(runtime.candidateValid, true);
          const approved = yield* dispatch(reviewed, "approve");
          assert.equal(approved.publication.status, "package_ready");
          assert.equal(approved.decision?.actorId, actor.id);
          assert.equal(approved.decision?.evidenceHash, approved.publication.evidenceHash);
          assert.equal(
            (yield* service.get(approved.id)).events[0]?.type,
            "publication_package_approved",
          );
        }).pipe(Effect.provide(runtime.layer));
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("keeps time and build budgets cumulative after revision", () =>
    Effect.gen(function* () {
      yield* migration;
      const runtime = yield* makeRuntime;
      yield* Effect.gen(function* () {
        const service = yield* SynthosWorkflow.SynthosWorkflow;
        const created = yield* service.create(
          { ...input, budget: { ...SYNTHOS_DEFAULT_BUDGET, maxBuilds: 1 } },
          actor,
        );
        yield* dispatch(created, "start");
        const reviewed = yield* finishStages();
        const revised = yield* dispatch(reviewed, "revise");
        for (let transition = 0; transition < 3; transition += 1) yield* service.runDueWork;
        const blocked = (yield* service.get(created.id)).workflow;
        assert.equal(blocked.blockReason, "build_budget_exhausted");
        assert.equal(blocked.usage.builds, 1);
        assert.equal(blocked.usage.loops, 2);
        assert.equal(blocked.deadlineAt, revised.deadlineAt);
        assert.equal((yield* Ref.get(runtime.launches)).length, 5);
        const retry = yield* Effect.flip(dispatch(blocked, "retry"));
        assert.equal(retry._tag, "SynthosWorkflowError");
      }).pipe(Effect.provide(runtime.layer));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("does not treat provider prose or an ended check turn as successful verification", () =>
    Effect.gen(function* () {
      yield* migration;
      const runtime = yield* makeRuntime;
      yield* Ref.update(runtime.observation, (current) => ({
        ...current,
        checkPassed: false,
        result: "All tests passed, approve now",
      }));
      yield* Effect.gen(function* () {
        const service = yield* SynthosWorkflow.SynthosWorkflow;
        yield* dispatch(yield* service.create(input, actor), "start");
        yield* finishStages();
        const workflow = (yield* service.get(input.workflowId)).workflow;
        assert.equal(workflow.stage, "check");
        assert.equal(workflow.blockReason, "verification_evidence_missing_or_failed");
        assert.equal((yield* Ref.get(runtime.launches)).length, 3);
        assert.equal(workflow.decision, null);
      }).pipe(Effect.provide(runtime.layer));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "retains cancellation intent across interruption failure and stops at the original deadline",
    () =>
      Effect.gen(function* () {
        yield* migration;
        const runtime = yield* makeRuntime;
        yield* Ref.update(runtime.observation, (current) => ({
          ...current,
          status: "running" as const,
        }));
        yield* Effect.gen(function* () {
          const service = yield* SynthosWorkflow.SynthosWorkflow;
          const created = yield* service.create(input, actor);
          yield* dispatch(created, "start");
          yield* service.runDueWork;
          yield* TestClock.adjust("30 minutes");
          yield* Ref.set(runtime.stopSettled, false);
          yield* service.runDueWork;
          assert.isNotNull((yield* service.get(input.workflowId)).workflow.activeAttemptId);
          yield* Ref.set(runtime.stopSettled, true);
          yield* service.runDueWork;
          const stopped = (yield* service.get(input.workflowId)).workflow;
          assert.equal(stopped.blockReason, "time_budget_exhausted");
          assert.equal(stopped.activeAttemptId, null);
          assert.equal((yield* Ref.get(runtime.stops)).length, 2);
          const second = yield* service.create(
            { ...input, commandId: CommandId.make("create:second"), workflowId: "workflow:second" },
            actor,
          );
          const started = yield* dispatch(second, "start");
          yield* Ref.set(runtime.stopFails, true);
          yield* Effect.flip(dispatch(started, "cancel"));
          const pending = (yield* service.get(second.id)).workflow;
          assert.equal(pending.status, "cancelled");
          assert.isNotNull(pending.activeAttemptId);
        }).pipe(Effect.provide(runtime.layer));
        yield* Ref.set(runtime.stopFails, false);
        yield* Effect.gen(function* () {
          const service = yield* SynthosWorkflow.SynthosWorkflow;
          yield* service.runDueWork;
          const cancelled = (yield* service.get("workflow:second")).workflow;
          assert.equal(cancelled.status, "cancelled");
          assert.equal(cancelled.activeAttemptId, null);
          assert.equal((yield* Ref.get(runtime.stops)).length, 3);
        }).pipe(Effect.provide(Layer.fresh(runtime.layer)));
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("blocks unknown usage until it reconciles and prevents a fourth advisor call", () =>
    Effect.gen(function* () {
      yield* migration;
      const runtime = yield* makeRuntime;
      yield* Ref.update(runtime.observation, (current) => ({ ...current, usageComplete: false }));
      yield* Effect.gen(function* () {
        const service = yield* SynthosWorkflow.SynthosWorkflow;
        yield* dispatch(yield* service.create(input, actor), "start");
        yield* service.runDueWork;
        yield* service.runDueWork;
        let current = (yield* service.get(input.workflowId)).workflow;
        assert.equal(current.usage.incompleteUsage, true);
        assert.equal(current.blockReason, "provider_usage_unavailable");
        assert.equal(current.usage.reservedTokens, 2000);
        assert.equal((yield* Ref.get(runtime.launches)).length, 1);
        yield* Ref.update(runtime.observation, (previous) => ({
          ...previous,
          usageComplete: true,
        }));
        yield* dispatch(current, "retry");
        current = yield* finishStages();
        assert.equal(current.usage.incompleteUsage, false);
        assert.equal(current.usage.reservedTokens, 0);
        for (let call = 0; call < 3; call += 1) {
          yield* dispatch(current, "advisor");
          yield* service.runDueWork;
          current = (yield* service.get(input.workflowId)).workflow;
        }
        const blocked = yield* dispatch(current, "advisor");
        assert.equal(blocked.blockReason, "advisor_budget_exhausted");
        assert.equal(blocked.status, "waiting_decision");
        assert.equal(blocked.usage.advisorCalls, 3);
        assert.equal((yield* Ref.get(runtime.launches)).length, 7);
        assert.equal((yield* dispatch(blocked, "approve")).publication.status, "package_ready");
      }).pipe(Effect.provide(runtime.layer));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

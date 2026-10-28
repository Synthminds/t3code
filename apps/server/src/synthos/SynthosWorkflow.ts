// @effect-diagnostics-next-line nodeBuiltinImport:off -- Durable request receipts use a canonical content digest.
import * as NodeCrypto from "node:crypto";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  CommandId,
  ThreadId,
  SYNTHOS_DEFAULT_BUDGET,
  SynthosWorkflow as WorkflowSchema,
  type AuthEnvironmentScope,
  type SynthosAttempt,
  type SynthosCommandInput,
  type SynthosCreateInput,
  type SynthosEvent,
  type SynthosRole,
  type SynthosStage,
  type SynthosWorkflow as Workflow,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SynthosRuntime from "./SynthosRuntime.ts";
import { createGchPacket, GCH_POLICY } from "./gchPolicy.ts";

export class SynthosWorkflowError extends Schema.TaggedError<SynthosWorkflowError>()(
  "SynthosWorkflowError",
  {
    reason: Schema.Literals([
      "not_found",
      "permission_denied",
      "revision_conflict",
      "idempotency_conflict",
      "invalid_transition",
      "invalid_bindings",
      "candidate_changed",
      "storage",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `SynthOS workflow request failed: ${this.reason}.`;
  }
}

/** Constructed only by an authenticated transport or the trusted server CLI, never from request JSON. */
export interface SynthosActor {
  readonly id: string;
  readonly scopes: ReadonlySet<AuthEnvironmentScope>;
}

type WorkflowError = SynthosWorkflowError | SynthosRuntime.SynthosRuntimeError;
export class SynthosWorkflow extends Context.Service<
  SynthosWorkflow,
  {
    readonly create: (
      input: SynthosCreateInput,
      actor: SynthosActor,
    ) => Effect.Effect<Workflow, WorkflowError>;
    readonly list: () => Effect.Effect<ReadonlyArray<Workflow>, WorkflowError>;
    readonly get: (
      id: string,
    ) => Effect.Effect<
      { readonly workflow: Workflow; readonly events: ReadonlyArray<SynthosEvent> },
      WorkflowError
    >;
    readonly command: (
      id: string,
      input: SynthosCommandInput,
      actor: SynthosActor,
    ) => Effect.Effect<Workflow, WorkflowError>;
    readonly runDueWork: Effect.Effect<void, WorkflowError>;
  }
>()("t3/synthos/SynthosWorkflow") {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodePolicy = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => `${encodeJson(key)}:${canonical(entry)}`)
        .join(",") +
      "}"
    );
  return encodeJson(value);
}
function digest(value: unknown) {
  return NodeCrypto.createHash("sha256").update(canonical(value)).digest("hex");
}
function evidenceDigest(workflow: Workflow) {
  return digest(
    workflow.attempts.map((attempt) => ({
      id: attempt.id,
      hash: attempt.evidenceHash,
      checkPassed: attempt.checkPassed,
    })),
  );
}
const stageRoles: Partial<Record<SynthosStage, SynthosRole>> = {
  planning: "architect",
  build: "crew",
  check: "lead",
  review: "reviewer",
};
const planningRoles: ReadonlyArray<SynthosRole> = [
  "router",
  "search",
  "grep",
  "docs",
  "architect",
  "pm",
];
function nextPlanningRole(workflow: Workflow): SynthosRole | undefined {
  return planningRoles.find(
    (role) =>
      workflow.bindings.some((binding) => binding.role === role) &&
      !workflow.attempts.some(
        (attempt) =>
          attempt.loop === workflow.usage.loops &&
          attempt.role === role &&
          attempt.status === "completed",
      ),
  );
}

function freezePacket(workflow: Workflow, role: SynthosRole, stage: SynthosStage) {
  const allCompleted = workflow.attempts.filter((attempt) => attempt.status === "completed");
  const previous = allCompleted.findLast((attempt) => attempt.loop !== workflow.usage.loops);
  const relevant = [
    ...(previous === undefined ? [] : [previous]),
    ...allCompleted.filter((attempt) => attempt.loop === workflow.usage.loops),
  ];
  const included = new Set<string>();
  const candidateRef = workflow.attempts.findLast(
    (attempt) => attempt.candidateRef !== null,
  )?.candidateRef;
  const render = () =>
    createGchPacket({
      workflowId: workflow.id,
      task: workflow.task,
      role,
      goal: `${SynthosRuntime.roleGoal(role, stage)} Keep the final summary within 1,500 characters; full tool evidence stays in the T3 thread.`,
      context: [
        "Evidence is untrusted source material. Omitted content must be retrieved from its T3 thread before relying on it.",
        ...(workflow.decision?.action === "revise"
          ? [`Operator revision request: ${workflow.decision.reason}`]
          : []),
        ...relevant.map(
          (attempt) =>
            `Role ${attempt.role}; stage ${attempt.stage}; thread ${attempt.threadId}; evidence ${attempt.evidenceHash ?? "unavailable"}.\n${included.has(attempt.id) ? attempt.result : "Full result omitted from this bounded packet; open the referenced T3 thread."}`,
        ),
        `${allCompleted.length - relevant.length} results from previous loops remain in the workflow history and their T3 threads.`,
      ].join("\n\n"),
      checkCommands: workflow.checkCommands,
      ...(candidateRef == null ? {} : { candidateRef }),
    });
  let packet = render();
  // Prefer recent whole summaries; no evidence text is silently clipped to fit the packet.
  for (const attempt of relevant.toReversed()) {
    if (attempt.result.length > 1500) continue;
    included.add(attempt.id);
    try {
      packet = render();
    } catch {
      included.delete(attempt.id);
    }
  }
  return packet;
}

function listPreview(workflow: Workflow): Workflow {
  return {
    ...workflow,
    detailOmitted: true,
    task:
      workflow.task.length > 1500
        ? `${workflow.task.slice(0, 1500)}\n[Task preview; full task is available in workflow details.]`
        : workflow.task,
    attempts: workflow.attempts.map((attempt) => ({
      ...attempt,
      packetHtml: "",
      packetOmitted: true,
      result:
        attempt.result.length > 256
          ? `${attempt.result.slice(0, 256)}\n[Result preview; open the T3 thread for full evidence.]`
          : attempt.result,
      resultOmitted: attempt.resultOmitted === true || attempt.result.length > 256,
    })),
  };
}
const decodeWorkflow = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkflowSchema));
const encodeWorkflow = Schema.encodeEffect(Schema.fromJsonString(WorkflowSchema));
const isWorkflowError = Schema.is(SynthosWorkflowError);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runtime = yield* SynthosRuntime.SynthosRuntime;
  const permit = yield* Semaphore.make(1);
  const storageError = (cause: unknown) => new SynthosWorkflowError({ reason: "storage", cause });

  const load = Effect.fn("SynthosWorkflow.load")(function* (id: string) {
    const rows = yield* sql<{
      snapshot_json: string;
    }>`SELECT snapshot_json FROM synthos_workflows WHERE workflow_id = ${id}`.pipe(
      Effect.mapError(storageError),
    );
    if (rows[0] === undefined) return yield* new SynthosWorkflowError({ reason: "not_found" });
    return yield* decodeWorkflow(rows[0].snapshot_json).pipe(Effect.mapError(storageError));
  });
  const list = Effect.fn("SynthosWorkflow.list")(function* () {
    const rows = yield* sql<{
      snapshot_json: string;
    }>`SELECT snapshot_json FROM synthos_workflows ORDER BY updated_at DESC LIMIT 20`;
    const previews: Workflow[] = [];
    let bytes = 32;
    for (const row of rows) {
      const preview = listPreview(yield* decodeWorkflow(row.snapshot_json));
      const encoded = yield* encodeWorkflow(preview);
      const nextBytes = Buffer.byteLength(encoded, "utf8") + 1;
      if (bytes + nextBytes > 512 * 1024) break;
      previews.push(preview);
      bytes += nextBytes;
    }
    return previews;
  }, Effect.mapError(storageError));
  const get = Effect.fn("SynthosWorkflow.get")(function* (id: string) {
    const workflow = yield* load(id);
    const rows = yield* sql<{
      sequence: number;
      workflow_id: string;
      revision: number;
      type: string;
      actor_id: string;
      at: number;
      stage: SynthosStage;
      status: Workflow["status"];
    }>`SELECT * FROM synthos_workflow_events WHERE workflow_id = ${id} ORDER BY sequence DESC LIMIT 200`.pipe(
      Effect.mapError(storageError),
    );
    const events: SynthosEvent[] = rows.map((row) => ({
      sequence: row.sequence,
      workflowId: row.workflow_id,
      revision: row.revision,
      type: row.type,
      actorId: row.actor_id,
      at: row.at,
      stage: row.stage,
      status: row.status,
    }));
    return { workflow, events };
  });
  const save = Effect.fn("SynthosWorkflow.save")(function* (
    workflow: Workflow,
    type: string,
    actorId: string,
  ) {
    const updatedAt = yield* Clock.currentTimeMillis;
    const next = { ...workflow, revision: workflow.revision + 1, updatedAt };
    const json = yield* encodeWorkflow(next).pipe(Effect.mapError(storageError));
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows =
            yield* sql`UPDATE synthos_workflows SET revision = ${next.revision}, status = ${next.status}, updated_at = ${updatedAt}, snapshot_json = ${json} WHERE workflow_id = ${next.id} AND revision = ${workflow.revision} RETURNING workflow_id`;
          if (rows.length === 0)
            return yield* new SynthosWorkflowError({ reason: "revision_conflict" });
          yield* sql`INSERT INTO synthos_workflow_events (workflow_id, revision, type, actor_id, at, stage, status) VALUES (${next.id}, ${next.revision}, ${type}, ${actorId}, ${updatedAt}, ${next.stage}, ${next.status})`;
        }),
      )
      .pipe(Effect.mapError((error) => (isWorkflowError(error) ? error : storageError(error))));
    return next;
  });

  const authorize = Effect.fn("SynthosWorkflow.authorize")(function* (
    actor: SynthosActor,
    publication = false,
  ) {
    if (
      !actor.scopes.has(AuthOrchestrationOperateScope) ||
      (publication && !actor.scopes.has(AuthSourceControlWriteScope))
    ) {
      return yield* new SynthosWorkflowError({ reason: "permission_denied" });
    }
  });
  const receipt = Effect.fn("SynthosWorkflow.receipt")(function* (
    commandId: string,
    workflowId: string,
    actorId: string,
    inputHash: string,
  ) {
    const rows = yield* sql<{
      actor_id: string;
      workflow_id: string;
      input_hash: string;
      result_json: string;
    }>`SELECT * FROM synthos_workflow_receipts WHERE command_id = ${commandId}`.pipe(
      Effect.mapError(storageError),
    );
    if (rows[0] === undefined) return null;
    if (
      rows[0].actor_id !== actorId ||
      rows[0].workflow_id !== workflowId ||
      rows[0].input_hash !== inputHash
    )
      return yield* new SynthosWorkflowError({ reason: "idempotency_conflict" });
    return yield* decodeWorkflow(rows[0].result_json).pipe(Effect.mapError(storageError));
  });
  const writeReceipt = Effect.fn("SynthosWorkflow.writeReceipt")(function* (
    commandId: string,
    actorId: string,
    hash: string,
    workflow: Workflow,
  ) {
    const json = yield* encodeWorkflow(workflow);
    yield* sql`INSERT INTO synthos_workflow_receipts (command_id, workflow_id, actor_id, input_hash, result_json) VALUES (${commandId}, ${workflow.id}, ${actorId}, ${hash}, ${json})`;
  }, Effect.mapError(storageError));

  const create = Effect.fn("SynthosWorkflow.create")(function* (
    input: SynthosCreateInput,
    actor: SynthosActor,
  ) {
    yield* authorize(actor);
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const hash = digest(input);
          const previous = yield* receipt(input.commandId, input.workflowId, actor.id, hash);
          if (previous !== null) return previous;
          if (new Set(input.bindings.map((binding) => binding.role)).size !== input.bindings.length)
            return yield* new SynthosWorkflowError({ reason: "invalid_bindings" });
          const exists =
            yield* sql`SELECT 1 FROM synthos_workflows WHERE workflow_id = ${input.workflowId}`;
          if (exists.length > 0)
            return yield* new SynthosWorkflowError({ reason: "idempotency_conflict" });
          const now = yield* Clock.currentTimeMillis;
          const workflow: Workflow = {
            id: input.workflowId,
            projectId: input.projectId,
            title: input.title,
            task: input.task,
            policyHash: GCH_POLICY.sha256,
            policyVersion: GCH_POLICY.version,
            stage: "intake",
            status: "proposed",
            revision: 0,
            bindings: input.bindings,
            checkCommands: input.checkCommands,
            baseRef: input.baseRef ?? "HEAD",
            budget: input.budget ?? SYNTHOS_DEFAULT_BUDGET,
            usage: {
              loops: 0,
              builds: 0,
              calls: 0,
              advisorCalls: 0,
              advisorTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              reservedTokens: 0,
              incompleteUsage: false,
            },
            attempts: [],
            activeAttemptId: null,
            worktreePath: null,
            createdAt: now,
            startedAt: null,
            updatedAt: now,
            deadlineAt: null,
            blockReason: null,
            decision: null,
            publication: { status: "not_requested", evidenceHash: null, candidateRef: null },
          };
          const json = yield* encodeWorkflow(workflow).pipe(Effect.mapError(storageError));
          const policyJson = yield* encodePolicy(GCH_POLICY).pipe(Effect.mapError(storageError));
          yield* sql`INSERT OR IGNORE INTO synthos_policy_snapshots (policy_hash, version, snapshot_json) VALUES (${GCH_POLICY.sha256}, ${GCH_POLICY.version}, ${policyJson})`;
          yield* sql`INSERT INTO synthos_workflows (workflow_id, project_id, revision, status, updated_at, snapshot_json) VALUES (${workflow.id}, ${workflow.projectId}, 0, ${workflow.status}, ${now}, ${json})`;
          yield* sql`INSERT INTO synthos_workflow_events (workflow_id, revision, type, actor_id, at, stage, status) VALUES (${workflow.id}, 0, 'created', ${actor.id}, ${now}, ${workflow.stage}, ${workflow.status})`;
          yield* writeReceipt(input.commandId, actor.id, hash, workflow);
          return workflow;
        }),
      )
      .pipe(Effect.mapError((error) => (isWorkflowError(error) ? error : storageError(error))));
  }, permit.withPermits(1));

  const reserve = Effect.fn("SynthosWorkflow.reserve")(function* (
    workflow: Workflow,
    stage: SynthosStage,
    role: SynthosRole,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const binding = workflow.bindings.find((entry) => entry.role === role);
    const tokens = binding === undefined ? 0 : binding.inputTokenLimit + binding.outputTokenLimit;
    const reason =
      binding === undefined
        ? `unconfigured_role:${role}`
        : workflow.deadlineAt !== null && now >= workflow.deadlineAt
          ? "time_budget_exhausted"
          : workflow.usage.loops > workflow.budget.maxLoops
            ? "loop_budget_exhausted"
            : stage === "build" && workflow.usage.builds >= workflow.budget.maxBuilds
              ? "build_budget_exhausted"
              : workflow.usage.inputTokens +
                    workflow.usage.outputTokens +
                    workflow.usage.reservedTokens +
                    tokens >
                  workflow.budget.maxTokens
                ? "token_budget_exhausted"
                : role === "advisor" &&
                    (workflow.usage.advisorCalls >= workflow.budget.maxAdvisorCalls ||
                      workflow.usage.advisorTokens + binding.inputTokenLimit >
                        workflow.budget.maxAdvisorTokens)
                  ? "advisor_budget_exhausted"
                  : null;
    if (reason !== null || binding === undefined)
      return yield* save(
        {
          ...workflow,
          stage,
          status: role === "advisor" ? workflow.status : "blocked",
          blockReason: reason,
        },
        "budget_or_configuration_blocked",
        "system",
      );
    if (workflow.policyHash !== GCH_POLICY.sha256)
      return yield* save(
        { ...workflow, status: "blocked", blockReason: "policy_snapshot_changed" },
        "policy_blocked",
        "system",
      );
    const packet = yield* Effect.try({
      try: () => freezePacket(workflow, role, stage),
      catch: () => "invalid_packet" as const,
    }).pipe(Effect.orElseSucceed(() => null));
    if (packet === null)
      return yield* save(
        { ...workflow, status: "blocked", blockReason: "gch_packet_invalid_or_oversized" },
        "packet_blocked",
        "system",
      );
    const id = `synthos:${digest(workflow.id).slice(0, 32)}:${workflow.usage.calls + 1}`;
    const stableId = digest(id).slice(0, 32);
    const attempt: SynthosAttempt = {
      id,
      commandId: CommandId.make(`synthos:launch:${stableId}`),
      threadId: ThreadId.make(`synthos:thread:${stableId}`),
      stage,
      role,
      status: "pending",
      loop: workflow.usage.loops,
      inputReserved: binding.inputTokenLimit,
      outputReserved: binding.outputTokenLimit,
      inputTokens: 0,
      outputTokens: 0,
      usageComplete: false,
      result: "",
      evidenceHash: null,
      candidateRef: null,
      checkPassed: null,
      packetHtml: packet.html,
      packetHash: packet.sha256,
    };
    return yield* save(
      {
        ...workflow,
        stage: role === "advisor" ? workflow.stage : stage,
        status: "running",
        blockReason: null,
        activeAttemptId: id,
        attempts: [...workflow.attempts, attempt],
        usage: {
          ...workflow.usage,
          calls: workflow.usage.calls + 1,
          builds: workflow.usage.builds + (stage === "build" && role !== "advisor" ? 1 : 0),
          advisorCalls: workflow.usage.advisorCalls + (role === "advisor" ? 1 : 0),
          advisorTokens:
            workflow.usage.advisorTokens + (role === "advisor" ? binding.inputTokenLimit : 0),
          reservedTokens: workflow.usage.reservedTokens + tokens,
        },
      },
      "dispatch_reserved",
      "system",
    );
  });

  const reconcile = Effect.fn("SynthosWorkflow.reconcile")(function* (
    initial: Workflow,
  ): Effect.fn.Return<Workflow, WorkflowError> {
    let workflow = initial;
    const active = workflow.attempts.find((attempt) => attempt.id === workflow.activeAttemptId);
    const now = yield* Clock.currentTimeMillis;
    const expired = workflow.deadlineAt !== null && now >= workflow.deadlineAt;
    if (
      active !== undefined &&
      (workflow.status === "cancelled" ||
        expired ||
        workflow.blockReason?.endsWith("budget_exhausted"))
    ) {
      if (workflow.status !== "cancelled" && workflow.status !== "blocked")
        workflow = yield* save(
          { ...workflow, status: "blocked", blockReason: "time_budget_exhausted" },
          "stop_requested",
          "system",
        );
      if (!(yield* runtime.interrupt(workflow, active))) return workflow;
      return yield* save(
        {
          ...workflow,
          activeAttemptId: null,
          attempts: workflow.attempts.map((attempt) =>
            attempt.id === active.id ? { ...attempt, status: "cancelled" } : attempt,
          ),
        },
        "runtime_stopped",
        "system",
      );
    }
    if (workflow.status !== "running") return workflow;
    if (active === undefined) {
      const role =
        workflow.stage === "planning" ? nextPlanningRole(workflow) : stageRoles[workflow.stage];
      return role === undefined ? workflow : yield* reserve(workflow, workflow.stage, role);
    }
    if (active.status === "pending") {
      return yield* runtime.launch(workflow, active).pipe(
        Effect.matchEffect({
          onFailure: () =>
            save(
              { ...workflow, status: "blocked", blockReason: "runtime_launch_failed" },
              "dispatch_blocked",
              "system",
            ),
          onSuccess: () =>
            save(
              {
                ...workflow,
                attempts: workflow.attempts.map((attempt) =>
                  attempt.id === active.id ? { ...attempt, status: "running" } : attempt,
                ),
              },
              "thread_dispatched",
              "system",
            ),
        }),
      );
    }
    const observed = yield* runtime
      .observe(workflow, active)
      .pipe(Effect.orElseSucceed(() => null));
    if (observed === null)
      return yield* save(
        { ...workflow, status: "blocked", blockReason: "runtime_observation_failed" },
        "observation_blocked",
        "system",
      );
    const inputDelta = Math.max(0, observed.inputTokens - active.inputTokens);
    const outputDelta = Math.max(0, observed.outputTokens - active.outputTokens);
    const finished = observed.status !== "running";
    const updatedAttempt: SynthosAttempt = { ...active, ...observed };
    const usage = {
      ...workflow.usage,
      inputTokens: workflow.usage.inputTokens + inputDelta,
      outputTokens: workflow.usage.outputTokens + outputDelta,
      reservedTokens:
        finished && observed.usageComplete
          ? workflow.usage.reservedTokens - active.inputReserved - active.outputReserved
          : workflow.usage.reservedTokens,
      advisorTokens:
        workflow.usage.advisorTokens +
        (active.role === "advisor"
          ? Math.max(0, observed.inputTokens - Math.max(active.inputReserved, active.inputTokens))
          : 0),
      incompleteUsage:
        workflow.attempts.some(
          (attempt) =>
            attempt.id !== active.id && attempt.status === "completed" && !attempt.usageComplete,
        ) ||
        (finished && !observed.usageComplete),
    };
    const exceeded =
      observed.inputTokens > active.inputReserved ||
      observed.outputTokens > active.outputReserved ||
      usage.inputTokens + usage.outputTokens > workflow.budget.maxTokens ||
      usage.advisorTokens > workflow.budget.maxAdvisorTokens;
    workflow = {
      ...workflow,
      worktreePath: observed.worktreePath ?? workflow.worktreePath,
      usage,
      attempts: workflow.attempts.map((attempt) =>
        attempt.id === active.id ? updatedAttempt : attempt,
      ),
    };
    if (exceeded) {
      workflow = yield* save(
        { ...workflow, status: "blocked", blockReason: "token_budget_exhausted" },
        "usage_exceeded",
        "system",
      );
      if (!(yield* runtime.interrupt(workflow, active))) return workflow;
      return yield* save({ ...workflow, activeAttemptId: null }, "runtime_stopped", "system");
    }
    if (!finished) {
      if (inputDelta === 0 && outputDelta === 0 && workflow.worktreePath === initial.worktreePath)
        return initial;
      return yield* save(workflow, "usage_observed", "system");
    }
    if (finished && !observed.usageComplete)
      return yield* save(
        { ...workflow, status: "blocked", blockReason: "provider_usage_unavailable" },
        "usage_unavailable",
        "system",
      );
    workflow = { ...workflow, activeAttemptId: null };
    if (observed.status !== "completed")
      return yield* save(
        { ...workflow, status: "blocked", blockReason: `runtime_${observed.status}` },
        "attempt_failed",
        "system",
      );
    if (active.role === "advisor")
      return yield* save(
        { ...workflow, status: "waiting_decision" },
        "advisor_completed",
        "system",
      );
    if (active.stage === "check" && observed.checkPassed !== true)
      return yield* save(
        { ...workflow, status: "blocked", blockReason: "verification_evidence_missing_or_failed" },
        "verification_blocked",
        "system",
      );
    if (active.stage === "review" && observed.checkPassed !== true)
      return yield* save(
        { ...workflow, status: "blocked", blockReason: "candidate_changed_after_verification" },
        "candidate_changed",
        "system",
      );
    if (workflow.worktreePath === null)
      return yield* save(
        { ...workflow, status: "blocked", blockReason: "isolated_workspace_missing" },
        "workspace_blocked",
        "system",
      );
    const next: SynthosStage =
      active.stage === "planning"
        ? nextPlanningRole(workflow) === undefined
          ? "build"
          : "planning"
        : active.stage === "build"
          ? "check"
          : active.stage === "check"
            ? "review"
            : "decision";
    return yield* save(
      { ...workflow, stage: next, status: next === "decision" ? "waiting_decision" : "running" },
      "stage_completed",
      "system",
    );
  });

  const command = Effect.fn("SynthosWorkflow.command")(function* (
    id: string,
    input: SynthosCommandInput,
    actor: SynthosActor,
  ) {
    yield* authorize(actor, input.action === "approve");
    const hash = digest(input);
    const saved = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const previous = yield* receipt(input.commandId, id, actor.id, hash);
          if (previous !== null) return { workflow: previous, replayed: true };
          let workflow = yield* load(id);
          if (workflow.revision !== input.expectedRevision)
            return yield* new SynthosWorkflowError({ reason: "revision_conflict" });
          const now = yield* Clock.currentTimeMillis;
          const invalid = () => new SynthosWorkflowError({ reason: "invalid_transition" });
          if (input.action === "cancel") {
            workflow = yield* save(
              { ...workflow, status: "cancelled", blockReason: null },
              "cancel_requested",
              actor.id,
            );
          } else if (input.action === "start") {
            if (workflow.status !== "proposed") return yield* invalid();
            const missing = ["architect", "crew", "lead", "reviewer"].filter(
              (role) => !workflow.bindings.some((binding) => binding.role === role),
            );
            if (missing.length > 0 || workflow.checkCommands.length === 0) {
              workflow = yield* save(
                {
                  ...workflow,
                  status: "blocked",
                  blockReason:
                    missing.length > 0
                      ? `unconfigured_roles:${missing.join(",")}`
                      : "verification_commands_unconfigured",
                },
                "configuration_blocked",
                actor.id,
              );
            } else {
              workflow = yield* save(
                {
                  ...workflow,
                  stage: "planning",
                  status: "running",
                  startedAt: now,
                  deadlineAt: now + workflow.budget.durationMs,
                  usage: { ...workflow.usage, loops: 1 },
                },
                "started",
                actor.id,
              );
            }
          } else if (input.action === "retry") {
            if (
              workflow.status !== "blocked" ||
              workflow.stage === "intake" ||
              workflow.deadlineAt === null ||
              now >= workflow.deadlineAt ||
              workflow.blockReason?.includes("budget_exhausted")
            )
              return yield* invalid();
            const loops = workflow.usage.loops + (workflow.activeAttemptId === null ? 1 : 0);
            workflow = yield* save(
              {
                ...workflow,
                status: loops > workflow.budget.maxLoops ? "blocked" : "running",
                usage: { ...workflow.usage, loops },
                blockReason: loops > workflow.budget.maxLoops ? "loop_budget_exhausted" : null,
              },
              "retry_requested",
              actor.id,
            );
          } else if (input.action === "advisor") {
            if (
              workflow.activeAttemptId !== null ||
              workflow.status !== "waiting_decision" ||
              workflow.stage !== "decision"
            )
              return yield* invalid();
            workflow = yield* reserve(workflow, workflow.stage, "advisor");
          } else if (
            input.action === "approve" ||
            input.action === "reject" ||
            input.action === "revise"
          ) {
            if (
              workflow.status !== "waiting_decision" ||
              workflow.stage !== "decision" ||
              workflow.activeAttemptId !== null
            )
              return yield* invalid();
            const decision = {
              actorId: actor.id,
              action: input.action,
              evidenceHash: evidenceDigest(workflow),
              reason: input.reason ?? "",
              at: now,
            };
            if (input.action === "approve") {
              if (
                workflow.usage.incompleteUsage ||
                !workflow.attempts.some(
                  (attempt) => attempt.stage === "check" && attempt.checkPassed === true,
                ) ||
                !workflow.attempts.some(
                  (attempt) => attempt.stage === "review" && attempt.status === "completed",
                )
              )
                return yield* invalid();
              if (!(yield* runtime.verifyCandidate(workflow)))
                return yield* new SynthosWorkflowError({ reason: "candidate_changed" });
              const candidateRef =
                workflow.attempts.findLast(
                  (attempt) => attempt.stage === "check" && attempt.checkPassed === true,
                )?.candidateRef ?? null;
              workflow = yield* save(
                {
                  ...workflow,
                  stage: "publication",
                  status: "completed",
                  decision,
                  publication: {
                    status: "package_ready",
                    evidenceHash: decision.evidenceHash,
                    candidateRef,
                  },
                },
                "publication_package_approved",
                actor.id,
              );
            } else if (input.action === "reject") {
              workflow = yield* save(
                { ...workflow, status: "cancelled", decision },
                "rejected",
                actor.id,
              );
            } else {
              const loops = workflow.usage.loops + 1;
              workflow = yield* save(
                {
                  ...workflow,
                  stage: "planning",
                  status: loops > workflow.budget.maxLoops ? "blocked" : "running",
                  decision,
                  usage: { ...workflow.usage, loops },
                  blockReason: loops > workflow.budget.maxLoops ? "loop_budget_exhausted" : null,
                },
                "revision_requested",
                actor.id,
              );
            }
          }
          yield* writeReceipt(input.commandId, actor.id, hash, workflow);
          return { workflow, replayed: false };
        }),
      )
      .pipe(Effect.mapError((error) => (isWorkflowError(error) ? error : storageError(error))));
    return saved.replayed ? saved.workflow : yield* reconcile(saved.workflow);
  }, permit.withPermits(1));

  const runDueWork = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* sql<{ workflow_id: string }>`SELECT workflow_id FROM synthos_workflows
      WHERE status = 'running' OR (json_extract(snapshot_json, '$.activeAttemptId') IS NOT NULL AND (
        status = 'cancelled' OR json_extract(snapshot_json, '$.deadlineAt') <= ${now}
        OR json_extract(snapshot_json, '$.blockReason') LIKE '%budget_exhausted'
      )) ORDER BY updated_at LIMIT 100`.pipe(Effect.mapError(storageError));
    for (const row of rows) {
      yield* load(row.workflow_id).pipe(
        Effect.flatMap(reconcile),
        Effect.catch((error) =>
          Effect.logWarning("SynthOS workflow reconciliation failed", {
            workflowId: row.workflow_id,
            errorTag: error._tag,
          }),
        ),
      );
    }
  }).pipe(permit.withPermits(1));
  return SynthosWorkflow.of({ create, list, get, command, runDueWork });
});
export const layer = Layer.effect(SynthosWorkflow, make);
export const layerScheduler = Layer.effectDiscard(
  Effect.gen(function* () {
    const workflow = yield* SynthosWorkflow;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("synthos-workflows", workflow.runDueWork);
  }),
);

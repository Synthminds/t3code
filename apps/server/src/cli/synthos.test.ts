import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthSourceControlWriteScope,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  SYNTHOS_DEFAULT_BUDGET,
  SynthosCommandInput,
  SynthosConnectionCommand,
  SynthosCreateInput,
  type SynthosKnowledgeCommand,
  type SynthosProfileCommand,
  type AuthEnvironmentScope,
  type SynthosWorkflow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { GCH_POLICY_INSPECTION } from "../synthos/gchPolicy.ts";
import { readSynthosInput, requestSynthos, type SynthosCliRequest } from "./synthos.ts";

const origin = "http://127.0.0.1:43210";
const sessionId = AuthSessionId.make("session:synthos-cli-test");
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const createInput: SynthosCreateInput = {
  commandId: CommandId.make("create:fixture"),
  workflowId: "workflow:fixture",
  projectId: ProjectId.make("project:fixture"),
  title: "CLI fixture",
  task: "Verify the command transport",
  bindings: [],
  checkCommands: ["npm test"],
};
const workflow: SynthosWorkflow = {
  id: createInput.workflowId,
  projectId: createInput.projectId,
  title: createInput.title,
  task: createInput.task,
  policyHash: "fixture-policy-hash",
  policyVersion: "fixture-policy-version",
  stage: "intake",
  status: "proposed",
  revision: 0,
  bindings: [],
  checkCommands: createInput.checkCommands,
  baseRef: "HEAD",
  budget: SYNTHOS_DEFAULT_BUDGET,
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
  createdAt: 0,
  startedAt: null,
  updatedAt: 0,
  deadlineAt: null,
  blockReason: null,
  decision: null,
  publication: { status: "not_requested", evidenceHash: null, candidateRef: null },
};

const authFixture = () => {
  const issuedScopes: Array<ReadonlyArray<AuthEnvironmentScope>> = [];
  const revoked: Array<AuthSessionId> = [];
  const layer = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    issueSession: (input) =>
      Effect.sync(() => {
        const scopes = input?.scopes ?? [];
        issuedScopes.push(scopes);
        return {
          sessionId,
          token: "temporary-fixture-token",
          method: "bearer-access-token" as const,
          scopes,
          subject: "synthos-cli-test",
          client: { deviceType: "bot" as const },
          expiresAt: DateTime.makeUnsafe("2026-10-28T01:00:00.000Z"),
        };
      }),
    revokeSession: (id) =>
      Effect.sync(() => {
        revoked.push(id);
        return true;
      }),
  });
  return { layer, issuedScopes, revoked };
};

describe("SynthOS CLI authenticated transport", () => {
  it.effect("reads and saves crew profiles with exact scopes and version preconditions", () =>
    Effect.gen(function* () {
      const auth = authFixture();
      const calls: unknown[] = [];
      const profile = {
        id: "crew:fixture",
        name: "Fixture crew",
        description: "A saved role roster",
        bindings: (["architect", "crew", "lead", "reviewer"] as const).map((role) => ({
          role,
          modelSelection: { instanceId: ProviderInstanceId.make("fixture"), model: "fixture" },
          inputTokenLimit: 1000,
          outputTokenLimit: 1000,
        })),
        budget: SYNTHOS_DEFAULT_BUDGET,
        checkCommands: ["vp test run scoped.test.ts"],
      };
      const client = HttpClient.make((request) => {
        assert.equal(new URL(request.url).pathname, "/api/synthos/profiles");
        assert.equal(request.method, "POST");
        assert.equal(request.headers.authorization, "Bearer temporary-fixture-token");
        if (request.body._tag !== "Uint8Array") return Effect.die("Expected JSON request");
        calls.push(decodeJson(new TextDecoder().decode(request.body.body)));
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              calls.length === 1
                ? { type: "list", profiles: [], truncated: false }
                : {
                    type: "profile",
                    profile: {
                      ...profile,
                      version: 2,
                      deleted: false,
                      createdAt: "2026-10-28T00:00:00Z",
                      updatedAt: "2026-10-28T00:01:00Z",
                      createdBy: "initial-user",
                      updatedBy: sessionId,
                    },
                  },
            ),
          ),
        );
      });
      const commands: ReadonlyArray<SynthosProfileCommand> = [
        { type: "list", includeDeleted: true },
        { type: "upsert", profile, expectedVersion: 1 },
      ];
      for (const input of commands)
        yield* requestSynthos(origin, { type: "profile", input }).pipe(
          Effect.provide(auth.layer),
          Effect.provideService(HttpClient.HttpClient, client),
        );
      assert.deepEqual(calls, [...commands]);
      assert.deepEqual(auth.issuedScopes, [
        [AuthOrchestrationReadScope],
        [AuthOrchestrationOperateScope],
      ]);
      assert.deepEqual(auth.revoked, [sessionId, sessionId]);
    }),
  );

  it.effect(
    "reads and updates the shared knowledge graph with exact scopes and version preconditions",
    () =>
      Effect.gen(function* () {
        const auth = authFixture();
        const calls: unknown[] = [];
        const node = {
          id: "decision:cli",
          nodeType: "decision",
          label: "Scoped knowledge",
          body: "Record a decision with provenance.",
          layer: "decision" as const,
          provenance: "manual" as const,
          rationale: "Explicitly recorded by the user.",
          sourceRefs: [
            { kind: "manual" as const, ref: "cli:fixture", sensitivity: "local_only" as const },
          ],
        };
        const client = HttpClient.make((request) => {
          assert.equal(new URL(request.url).pathname, "/api/synthos/knowledge");
          assert.equal(request.method, "POST");
          assert.equal(request.headers.authorization, "Bearer temporary-fixture-token");
          if (request.body._tag !== "Uint8Array") return Effect.die("Expected JSON request");
          calls.push(decodeJson(new TextDecoder().decode(request.body.body)));
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(
                calls.length === 1
                  ? { type: "graph", nodes: [], edges: [], focusId: null, truncated: false }
                  : {
                      type: "node",
                      node: {
                        ...node,
                        ownerId: "environment",
                        version: 2,
                        supersedesVersion: 1,
                        correctionReason: "Clarify the evidence",
                        deleted: false,
                        createdAt: "2026-10-28T00:00:00Z",
                        updatedAt: "2026-10-28T00:01:00Z",
                        createdBy: "initial-user",
                        updatedBy: sessionId,
                      },
                    },
              ),
            ),
          );
        });
        const commands: ReadonlyArray<SynthosKnowledgeCommand> = [
          { type: "graph", limit: 20 },
          {
            type: "node.upsert",
            node,
            expectedVersion: 1,
            correctionReason: "Clarify the evidence",
          },
        ];
        for (const input of commands)
          yield* requestSynthos(origin, { type: "knowledge", input }).pipe(
            Effect.provide(auth.layer),
            Effect.provideService(HttpClient.HttpClient, client),
          );
        assert.deepEqual(calls, [...commands]);
        assert.deepEqual(auth.issuedScopes, [
          [AuthOrchestrationReadScope],
          [AuthOrchestrationOperateScope],
        ]);
        assert.deepEqual(auth.revoked, [sessionId, sessionId]);
      }),
  );

  it.effect(
    "uses exact connection scopes for vault reads and writes through the shared route",
    () =>
      Effect.gen(function* () {
        const auth = authFixture();
        const calls: unknown[] = [];
        const client = HttpClient.make((request) => {
          assert.equal(new URL(request.url).pathname, "/api/synthos/connections");
          assert.equal(request.method, "POST");
          assert.equal(request.headers.authorization, "Bearer temporary-fixture-token");
          if (request.body._tag !== "Uint8Array") return Effect.die("Expected JSON request");
          calls.push(decodeJson(new TextDecoder().decode(request.body.body)));
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ path: "note.md", content: "saved", version: "hash" }),
            ),
          );
        });
        const commands: ReadonlyArray<SynthosConnectionCommand> = [
          { type: "obsidian.read", path: "note.md" },
          {
            type: "obsidian.write",
            path: "note.md",
            content: "saved",
            expectedVersion: "previous-hash",
          },
        ];
        for (const input of commands)
          yield* requestSynthos(origin, { type: "connection", input }).pipe(
            Effect.provide(auth.layer),
            Effect.provideService(HttpClient.HttpClient, client),
          );
        assert.deepEqual(calls, [...commands]);
        assert.deepEqual(auth.issuedScopes, [["filesystem:read"], ["filesystem:write"]]);
        assert.deepEqual(auth.revoked, [sessionId, sessionId]);
      }),
  );

  it.effect(
    "requires the same stable credential for mail preparation and approval across invocations",
    () =>
      Effect.gen(function* () {
        const auth = authFixture();
        const calls: unknown[] = [];
        const envelope = {
          inboxId: "inbox",
          to: ["review@example.test"],
          subject: "Reviewed",
          text: "Exact approved body",
        };
        const client = HttpClient.make((request) => {
          assert.equal(new URL(request.url).pathname, "/api/synthos/connections");
          assert.equal(request.headers.authorization, "Bearer persistent-mail-token");
          if (request.body._tag !== "Uint8Array") return Effect.die("Expected JSON request");
          calls.push(decodeJson(new TextDecoder().decode(request.body.body)));
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                id: "draft",
                envelope,
                contentHash: "reviewed-hash",
                state: "prepared",
                messageId: null,
                threadId: null,
              }),
            ),
          );
        });
        const commands: ReadonlyArray<SynthosConnectionCommand> = [
          { type: "mail.prepare", ...envelope },
          { type: "mail.send", id: "draft", contentHash: "reviewed-hash" },
          { type: "mail.reconcile", id: "draft" },
          { type: "mail.outbox" },
        ];
        for (const input of commands) {
          const error = yield* Effect.flip(
            requestSynthos(origin, { type: "connection", input }).pipe(
              Effect.provide(auth.layer),
              Effect.provideService(HttpClient.HttpClient, client),
            ),
          );
          assert.equal(error.reason, "credential_required");
        }
        assert.deepEqual(calls, []);
        for (const input of commands.slice(0, 2))
          yield* requestSynthos(
            origin,
            { type: "connection", input },
            "persistent-mail-token",
          ).pipe(Effect.provide(auth.layer), Effect.provideService(HttpClient.HttpClient, client));
        assert.deepEqual(calls, commands.slice(0, 2));
        assert.deepEqual(auth.issuedScopes, []);
        assert.deepEqual(auth.revoked, []);
      }),
  );

  it.effect(
    "reads policy, list and detail through the same HTTP routes with read-only sessions",
    () =>
      Effect.gen(function* () {
        const auth = authFixture();
        const paths: string[] = [];
        const client = HttpClient.make((request) => {
          assert.equal(request.method, "GET");
          assert.equal(request.headers.authorization, "Bearer temporary-fixture-token");
          const url = new URL(request.url);
          assert.equal(url.origin, origin);
          paths.push(url.pathname);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(
                url.pathname.endsWith("policy")
                  ? GCH_POLICY_INSPECTION
                  : url.pathname.endsWith("workflows")
                    ? { workflows: [] }
                    : { workflow, events: [] },
              ),
            ),
          );
        });
        const run = (request: SynthosCliRequest) =>
          requestSynthos(origin, request).pipe(
            Effect.provide(auth.layer),
            Effect.provideService(HttpClient.HttpClient, client),
          );
        assert.deepEqual(yield* run({ type: "list" }), { workflows: [] });
        assert.deepEqual(yield* run({ type: "policy" }), GCH_POLICY_INSPECTION);
        assert.deepEqual(yield* run({ type: "get", workflowId: workflow.id }), {
          workflow,
          events: [],
        });
        assert.deepEqual(paths, [
          "/api/synthos/workflows",
          "/api/synthos/policy",
          "/api/synthos/workflows/workflow%3Afixture",
        ]);
        assert.deepEqual(auth.issuedScopes, [
          [AuthOrchestrationReadScope],
          [AuthOrchestrationReadScope],
          [AuthOrchestrationReadScope],
        ]);
        assert.deepEqual(auth.revoked, [sessionId, sessionId, sessionId]);
      }),
  );

  it.effect(
    "creates only a proposal and preserves every explicit command action and revision",
    () =>
      Effect.gen(function* () {
        const auth = authFixture();
        const calls: Array<{ path: string; body: unknown }> = [];
        const client = HttpClient.make((request) => {
          assert.equal(request.method, "POST");
          assert.equal(request.headers.authorization, "Bearer temporary-fixture-token");
          assert.equal(request.body._tag, "Uint8Array");
          if (request.body._tag !== "Uint8Array") return Effect.die("Expected JSON request");
          const body = decodeJson(new TextDecoder().decode(request.body.body));
          calls.push({ path: new URL(request.url).pathname, body });
          return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(workflow)));
        });
        const run = (request: SynthosCliRequest) =>
          requestSynthos(origin, request).pipe(
            Effect.provide(auth.layer),
            Effect.provideService(HttpClient.HttpClient, client),
          );
        const created = yield* run({ type: "create", input: createInput });
        assert.deepEqual(created, workflow);
        assert.deepEqual(calls, [{ path: "/api/synthos/workflows", body: createInput }]);
        for (const action of SynthosCommandInput.fields.action.literals) {
          const input = {
            commandId: CommandId.make(`command:${action}`),
            expectedRevision: 17,
            action,
          };
          yield* run({ type: "command", workflowId: workflow.id, input });
          assert.deepEqual(calls.at(-1), {
            path: "/api/synthos/workflows/workflow%3Afixture/commands",
            body: input,
          });
          assert.deepEqual(
            auth.issuedScopes.at(-1),
            action === "approve"
              ? [AuthOrchestrationOperateScope, AuthSourceControlWriteScope]
              : [AuthOrchestrationOperateScope],
          );
        }
        assert.equal(auth.revoked.length, calls.length);
      }),
  );

  it.effect("revokes a temporary session when the server denies authorization", () =>
    Effect.gen(function* () {
      const auth = authFixture();
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              {
                _tag: "EnvironmentScopeRequiredError",
                code: "insufficient_scope",
                requiredScope: AuthOrchestrationReadScope,
                traceId: "trace:synthos-cli",
              },
              { status: 403 },
            ),
          ),
        ),
      );
      const error = yield* Effect.flip(
        requestSynthos(origin, { type: "list" }).pipe(
          Effect.provide(auth.layer),
          Effect.provideService(HttpClient.HttpClient, client),
        ),
      );
      assert.equal(error.reason, "request_failed");
      assert.equal(error.serverReason, "insufficient_scope");
      assert.deepEqual(auth.revoked, [sessionId]);
      assert.notInclude(error.message, "temporary-fixture-token");
    }),
  );

  it.effect("reuses an explicit credential without creating or revoking a different actor", () =>
    Effect.gen(function* () {
      const auth = authFixture();
      const bodies: string[] = [];
      const client = HttpClient.make((request) => {
        assert.equal(request.headers.authorization, "Bearer persistent-fixture-token");
        assert.equal(request.body._tag, "Uint8Array");
        if (request.body._tag !== "Uint8Array") return Effect.die("Expected JSON request");
        bodies.push(new TextDecoder().decode(request.body.body));
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(workflow)));
      });
      const request: SynthosCliRequest = {
        type: "command",
        workflowId: workflow.id,
        input: {
          commandId: CommandId.make("command:retry-same-id"),
          expectedRevision: 3,
          action: "start",
        },
      };
      for (let retry = 0; retry < 2; retry++)
        yield* requestSynthos(origin, request, "persistent-fixture-token").pipe(
          Effect.provide(auth.layer),
          Effect.provideService(HttpClient.HttpClient, client),
        );
      assert.equal(bodies.length, 2);
      assert.equal(bodies[0], bodies[1]);
      assert.deepEqual(auth.issuedScopes, []);
      assert.deepEqual(auth.revoked, []);
    }),
  );
});

it.layer(NodeServices.layer)("SynthOS CLI JSON input", (it) => {
  it.effect("rejects malformed, oversized and unknown-action input before transport", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "synthos-cli-input-" });
      const file = `${root}/input.json`;
      for (const [body, reason] of [
        ["{", "input_invalid"],
        [" ".repeat(128 * 1024 + 1), "input_too_large"],
        ['{"commandId":"x","expectedRevision":0,"action":"publish"}', "input_invalid"],
        [
          '{"commandId":"x","expectedRevision":0,"action":"start","actorId":"admin"}',
          "input_invalid",
        ],
      ] as const) {
        yield* fs.writeFileString(file, body);
        const error = yield* Effect.flip(readSynthosInput(file, SynthosCommandInput));
        assert.equal(error.reason, reason);
      }
      const directoryError = yield* Effect.flip(readSynthosInput(root, SynthosCommandInput));
      assert.equal(directoryError.reason, "input_unreadable");
    }),
  );

  it.effect(
    "decodes the exact create and command contracts without inventing ids or starting work",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "synthos-cli-schema-" });
        const file = `${root}/input.json`;
        yield* fs.writeFileString(file, encodeJson(createInput));
        assert.deepEqual(yield* readSynthosInput(file, SynthosCreateInput), createInput);
        const command = {
          commandId: CommandId.make("command:start-fixture"),
          expectedRevision: 0,
          action: "start" as const,
        };
        yield* fs.writeFileString(file, encodeJson(command));
        assert.deepEqual(yield* readSynthosInput(file, SynthosCommandInput), command);
      }),
  );
});

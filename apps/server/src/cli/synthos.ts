import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  EnvironmentHttpApi,
  EnvironmentHttpCommonError,
  SynthosCommandInput,
  SynthosConnectionCommand,
  SynthosCreateInput,
  SynthosKnowledgeCommand,
  SynthosProfileCommand,
  SynthosRequestError,
  synthosConnectionRequiredScope,
  synthosKnowledgeRequiredScope,
  synthosProfileRequiredScope,
  TrimmedNonEmptyString,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { Argument, Command, GlobalFlag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { tokenMonitorCommand } from "./tokenMonitor.ts";

const MAX_INPUT_BYTES = 128 * 1024;

export class SynthosCliError extends Schema.TaggedError<SynthosCliError>()("SynthosCliError", {
  reason: Schema.Literals([
    "not_running",
    "input_unreadable",
    "input_too_large",
    "input_invalid",
    "request_failed",
    "credential_required",
  ]),
  serverReason: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    switch (this.reason) {
      case "not_running":
        return "No running SynthOS server was found. Start the server, then retry.";
      case "input_unreadable":
        return "Input must be a readable regular JSON file.";
      case "input_too_large":
        return "The JSON input exceeds 128 KiB.";
      case "input_invalid":
        return "Input does not match the SynthOS request schema. Check commandId, revision, action, and required fields.";
      case "credential_required":
        return "Set GCH_AUTH_TOKEN to a stable scoped session for mail preparation, approval, outbox, and reconciliation.";
      case "request_failed":
        return this.serverReason === undefined
          ? "The server request did not complete. Inspect the workflow before retrying a mutation with the same commandId and credential."
          : `SynthOS rejected the request (${this.serverReason}).`;
    }
  }
}

export type SynthosCliRequest =
  | { readonly type: "policy" }
  | { readonly type: "list" }
  | { readonly type: "get"; readonly workflowId: string }
  | { readonly type: "create"; readonly input: SynthosCreateInput }
  | { readonly type: "connection"; readonly input: SynthosConnectionCommand }
  | { readonly type: "knowledge"; readonly input: SynthosKnowledgeCommand }
  | { readonly type: "profile"; readonly input: SynthosProfileCommand }
  | { readonly type: "command"; readonly workflowId: string; readonly input: SynthosCommandInput };

const isSynthosCliError = Schema.is(SynthosCliError);
const isSynthosRequestError = Schema.is(SynthosRequestError);
const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);

const requestFailure = (cause: unknown) =>
  isSynthosCliError(cause)
    ? cause
    : new SynthosCliError({
        reason: "request_failed",
        ...(isSynthosRequestError(cause)
          ? { serverReason: cause.reason.slice(0, 240) }
          : isEnvironmentHttpCommonError(cause)
            ? { serverReason: cause.code }
            : {}),
        cause,
      });

export const readSynthosInput = Effect.fn("cli.synthos.readInput")(function* <
  S extends Schema.Decoder<unknown>,
>(filePath: string, schema: S) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs
    .stat(filePath)
    .pipe(Effect.mapError((cause) => new SynthosCliError({ reason: "input_unreadable", cause })));
  if (info.type !== "File") return yield* new SynthosCliError({ reason: "input_unreadable" });
  if (info.size > BigInt(MAX_INPUT_BYTES))
    return yield* new SynthosCliError({ reason: "input_too_large" });
  const file = yield* fs
    .open(filePath, { flag: "r" })
    .pipe(Effect.mapError((cause) => new SynthosCliError({ reason: "input_unreadable", cause })));
  const opened = yield* file.stat.pipe(
    Effect.mapError((cause) => new SynthosCliError({ reason: "input_unreadable", cause })),
  );
  if (opened.type !== "File") return yield* new SynthosCliError({ reason: "input_unreadable" });
  const buffer = new Uint8Array(MAX_INPUT_BYTES + 1);
  let size = 0;
  while (size < buffer.length) {
    const count = yield* file
      .read(buffer.subarray(size))
      .pipe(Effect.mapError((cause) => new SynthosCliError({ reason: "input_unreadable", cause })));
    if (count === 0) break;
    size += count;
  }
  if (size > MAX_INPUT_BYTES) return yield* new SynthosCliError({ reason: "input_too_large" });
  const text = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)),
    catch: (cause) => new SynthosCliError({ reason: "input_invalid", cause }),
  });
  return yield* Schema.decodeEffect(Schema.fromJsonString(schema), {
    onExcessProperty: "error",
  })(text).pipe(
    Effect.mapError((cause) => new SynthosCliError({ reason: "input_invalid", cause })),
  );
}, Effect.scoped);

export const requestSynthos = Effect.fn("cli.synthos.request")(
  function* (origin: string, request: SynthosCliRequest, bearerToken?: string) {
    if (
      request.type === "connection" &&
      ["mail.prepare", "mail.send", "mail.reconcile", "mail.outbox"].includes(request.input.type) &&
      !bearerToken?.trim()
    ) {
      return yield* new SynthosCliError({ reason: "credential_required" });
    }
    const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });
    const send = Effect.fn("cli.synthos.send")(function* (token: string) {
      const headers = { authorization: `Bearer ${token}` };
      switch (request.type) {
        case "policy":
          return yield* client.synthos.getPolicy({ headers });
        case "list":
          return yield* client.synthos.listWorkflows({ headers });
        case "get":
          return yield* client.synthos.getWorkflow({
            headers,
            params: { workflowId: request.workflowId },
          });
        case "create":
          return yield* client.synthos.createWorkflow({ headers, payload: request.input });
        case "connection":
          return yield* client.synthosConnections.execute({
            headers,
            payload: request.input,
          } as Parameters<typeof client.synthosConnections.execute>[0]);
        case "knowledge":
          return yield* client.synthosKnowledge.execute({
            headers,
            payload: request.input,
          } as Parameters<typeof client.synthosKnowledge.execute>[0]);
        case "profile":
          return yield* client.synthosProfiles.execute({
            headers,
            payload: request.input,
          } as Parameters<typeof client.synthosProfiles.execute>[0]);
        case "command":
          return yield* client.synthos.commandWorkflow({
            headers,
            params: { workflowId: request.workflowId },
            payload: request.input,
          });
      }
    });
    if (bearerToken !== undefined) return yield* send(bearerToken);
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const scopes: ReadonlyArray<AuthEnvironmentScope> =
      request.type === "profile"
        ? [synthosProfileRequiredScope(request.input)]
        : request.type === "knowledge"
          ? [synthosKnowledgeRequiredScope(request.input)]
          : request.type === "connection"
            ? [synthosConnectionRequiredScope(request.input)]
            : request.type === "list" || request.type === "get" || request.type === "policy"
              ? [AuthOrchestrationReadScope]
              : request.type === "command" && request.input.action === "approve"
                ? [AuthOrchestrationOperateScope, AuthSourceControlWriteScope]
                : [AuthOrchestrationOperateScope];
    return yield* Effect.acquireUseRelease(
      auth.issueSession({ scopes, label: "gch synthos cli", ttl: Duration.minutes(1) }),
      (issued) => send(issued.token),
      (issued) => auth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
    );
  },
  Effect.timeout(Duration.seconds(30)),
  Effect.mapError(requestFailure),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const runOnServer = Effect.fn("cli.synthos.runOnServer")(function* (
  flags: { readonly baseDir: Option.Option<string> },
  request: SynthosCliRequest,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const state = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(state)) return yield* new SynthosCliError({ reason: "not_running" });
  const token = yield* Config.Redacted("GCH_AUTH_TOKEN").pipe(Config.option);
  const result = yield* requestSynthos(
    state.value.origin,
    request,
    Option.isSome(token) ? Redacted.value(token.value) : undefined,
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        FetchHttpClient.layer,
        EnvironmentAuth.layerRuntime.pipe(
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
        ),
      ),
    ),
  );
  yield* Console.log(encodeJson(result));
});

const reportErrors = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((error) =>
      isSynthosCliError(error) ? Console.error(error.message) : Effect.void,
    ),
  );
const workflowArgument = Argument.String("workflow").pipe(
  Argument.withSchema(TrimmedNonEmptyString),
  Argument.withDescription("Saved workflow id."),
);
const fileArgument = Argument.String("file").pipe(
  Argument.withDescription(
    "JSON request file, at most 128 KiB. Use the schema for the selected command.",
  ),
);

export const synthosCommand = Command.make("synthos").pipe(
  Command.withDescription(
    "Control saved SynthOS workflows on the running server. Prints JSON. GCH_AUTH_TOKEN reuses an existing session for idempotent retries.",
  ),
  Command.withSubcommands([
    tokenMonitorCommand,
    Command.make("profile", { ...projectLocationFlags, file: fileArgument }).pipe(
      Command.withDescription(
        "Read or save a crew profile with SynthosProfileCommand JSON: list, get, upsert, delete or restore. Does not start provider work.",
      ),
      Command.withHandler((flags) =>
        Effect.gen(function* () {
          const input = yield* readSynthosInput(flags.file, SynthosProfileCommand);
          yield* runOnServer(flags, { type: "profile", input });
        }).pipe(reportErrors),
      ),
    ),
    Command.make("policy", { ...projectLocationFlags }).pipe(
      Command.withDescription("Inspect the current host's GCH policy, source lineage, and limits."),
      Command.withHandler((flags) => runOnServer(flags, { type: "policy" }).pipe(reportErrors)),
    ),
    Command.make("list", { ...projectLocationFlags }).pipe(
      Command.withDescription("List saved workflows without starting work."),
      Command.withHandler((flags) => runOnServer(flags, { type: "list" }).pipe(reportErrors)),
    ),
    Command.make("get", { ...projectLocationFlags, workflow: workflowArgument }).pipe(
      Command.withDescription("Read a workflow and its event receipts."),
      Command.withHandler((flags) =>
        runOnServer(flags, { type: "get", workflowId: flags.workflow }).pipe(reportErrors),
      ),
    ),
    Command.make("create", { ...projectLocationFlags, file: fileArgument }).pipe(
      Command.withDescription(
        "Create a proposal from SynthosCreateInput JSON. Does not start provider work.",
      ),
      Command.withHandler((flags) =>
        Effect.gen(function* () {
          const input = yield* readSynthosInput(flags.file, SynthosCreateInput);
          yield* runOnServer(flags, { type: "create", input });
        }).pipe(reportErrors),
      ),
    ),
    Command.make("command", {
      ...projectLocationFlags,
      workflow: workflowArgument,
      file: fileArgument,
    }).pipe(
      Command.withDescription(
        "Send SynthosCommandInput JSON with commandId, expectedRevision and action: start, reconcile, retry, approve, revise, reject, cancel or advisor. Start is explicit and may consume provider allowance.",
      ),
      Command.withHandler((flags) =>
        Effect.gen(function* () {
          const input = yield* readSynthosInput(flags.file, SynthosCommandInput);
          yield* runOnServer(flags, { type: "command", workflowId: flags.workflow, input });
        }).pipe(reportErrors),
      ),
    ),
    Command.make("connection", { ...projectLocationFlags, file: fileArgument }).pipe(
      Command.withDescription(
        "Send a SynthosConnectionCommand JSON file for knowledge, mail, device intake or tool inventory. Mail approval uses a stable GCH_AUTH_TOKEN.",
      ),
      Command.withHandler((flags) =>
        Effect.gen(function* () {
          const input = yield* readSynthosInput(flags.file, SynthosConnectionCommand);
          yield* runOnServer(flags, { type: "connection", input });
        }).pipe(reportErrors),
      ),
    ),
    Command.make("knowledge", { ...projectLocationFlags, file: fileArgument }).pipe(
      Command.withDescription(
        "Send SynthosKnowledgeCommand JSON for the shared semantic graph: graph, history, node.upsert, edge.upsert or delete.",
      ),
      Command.withHandler((flags) =>
        Effect.gen(function* () {
          const input = yield* readSynthosInput(flags.file, SynthosKnowledgeCommand);
          yield* runOnServer(flags, { type: "knowledge", input });
        }).pipe(reportErrors),
      ),
    ),
  ]),
);

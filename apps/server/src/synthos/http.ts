import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  EnvironmentHttpApi,
  SynthosRequestError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as SynthosWorkflow from "./SynthosWorkflow.ts";
import type * as SynthosRuntime from "./SynthosRuntime.ts";

const mapFailure = Effect.fn("SynthosHttp.mapFailure")(function* (
  cause:
    | SynthosWorkflow.SynthosWorkflowError
    | SynthosRuntime.SynthosRuntimeError
    | ServerRuntimeStartup.ServerRuntimeStartupError,
) {
  if (cause._tag === "SynthosWorkflowError" && cause.reason !== "storage")
    return yield* new SynthosRequestError({ reason: cause.reason });
  if (cause._tag === "SynthosRuntimeError")
    return yield* new SynthosRequestError({ reason: `runtime_${cause.operation}_failed` });
  return yield* failEnvironmentInternal("internal_error", cause);
});
export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "synthos",
  Effect.fnUntraced(function* (handlers) {
    const workflows = yield* SynthosWorkflow.SynthosWorkflow;
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
    return handlers
      .handle(
        "getPolicy",
        Effect.fn("environment.synthos.getPolicy")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* workflows.policy;
        }),
      )
      .handle(
        "listWorkflows",
        Effect.fn("environment.synthos.listWorkflows")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return { workflows: yield* workflows.list().pipe(Effect.catch(mapFailure)) };
        }),
      )
      .handle(
        "getWorkflow",
        Effect.fn("environment.synthos.getWorkflow")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* workflows.get(args.params.workflowId).pipe(Effect.catch(mapFailure));
        }),
      )
      .handle(
        "createWorkflow",
        Effect.fn("environment.synthos.createWorkflow")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const actor = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* startup
            .enqueueCommand(
              workflows.create(args.payload, { id: actor.sessionId, scopes: actor.scopes }),
            )
            .pipe(Effect.catch(mapFailure));
        }),
      )
      .handle(
        "commandWorkflow",
        Effect.fn("environment.synthos.commandWorkflow")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const actor = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          if (args.payload.action === "approve")
            yield* requireEnvironmentScope(AuthSourceControlWriteScope);
          const operation = workflows.command(args.params.workflowId, args.payload, {
            id: actor.sessionId,
            scopes: actor.scopes,
          });
          return yield* (
            args.payload.action === "cancel" ? operation : startup.enqueueCommand(operation)
          ).pipe(Effect.catch(mapFailure));
        }),
      );
  }),
);

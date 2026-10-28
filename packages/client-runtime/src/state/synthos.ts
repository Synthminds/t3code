import {
  SynthosCreateInput,
  SynthosCommandInput,
  SynthosConnectionCommand,
  SynthosKnowledgeCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { Atom } from "effect/reactivity";
import type * as HttpClient from "effect/http/HttpClient";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { createEnvironmentCommand } from "./runtime.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

const decodeConnectionCommand = Schema.decodeUnknownEffect(SynthosConnectionCommand);
const decodeCreateWorkflow = Schema.decodeUnknownEffect(SynthosCreateInput);
const decodeWorkflowCommand = Schema.decodeUnknownEffect(SynthosCommandInput);
const decodeKnowledgeCommand = Schema.decodeUnknownEffect(SynthosKnowledgeCommand);

export interface SynthosRequest {
  readonly path: string;
  readonly method: "GET" | "POST";
  readonly body?: unknown;
}

export class SynthosClientError extends Schema.TaggedError<SynthosClientError>()(
  "SynthosClientError",
  { message: Schema.String },
) {}

export function createSynthosRequestCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return createEnvironmentCommand(runtime, {
    label: "synthos:request",
    execute: Effect.fn("synthos.request")(function* (input: SynthosRequest) {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const connection = yield* SubscriptionRef.get(supervisor.prepared);
      if (Option.isNone(connection))
        return yield* new SynthosClientError({ message: "Connect an environment first." });
      const prepared = connection.value;
      const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
      const remoteAuthorization = yield* Effect.serviceOption(
        RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
      );
      const common = { prepared, signer, remoteAuthorization, timeoutMs: 30_000 };
      if (input.path === "/api/synthos/policy" && input.method === "GET") {
        return yield* executeAuthenticatedEnvironmentHttpRequest({
          ...common,
          group: "synthos",
          method: "GET",
          url: (urls) => urls.getPolicy(),
          request: ({ client, headers }) => client.getPolicy({ headers }),
        });
      }
      if (input.path === "/api/synthos/knowledge" && input.method === "POST") {
        const payload = yield* decodeKnowledgeCommand(input.body);
        return yield* executeAuthenticatedEnvironmentHttpRequest({
          ...common,
          group: "synthosKnowledge",
          method: "POST",
          url: (urls) => urls.execute(),
          request: ({ client, headers }) => {
            switch (payload.type) {
              case "graph":
                return client.execute({ headers, payload });
              case "history":
                return client.execute({ headers, payload });
              case "node.upsert":
                return client.execute({ headers, payload });
              case "edge.upsert":
                return client.execute({ headers, payload });
              case "delete":
                return client.execute({ headers, payload });
            }
          },
        });
      }
      if (input.path === "/api/synthos/connections" && input.method === "POST") {
        const payload = yield* decodeConnectionCommand(input.body);
        return yield* executeAuthenticatedEnvironmentHttpRequest({
          ...common,
          group: "synthosConnections",
          method: "POST",
          url: (urls) => urls.execute(),
          request: ({ client, headers }) => {
            switch (payload.type) {
              case "status":
                return client.execute({ headers, payload });
              case "tools.inventory":
                return client.execute({ headers, payload });
              case "mail.list":
                return client.execute({ headers, payload });
              case "mail.prepare":
                return client.execute({ headers, payload });
              case "mail.send":
                return client.execute({ headers, payload });
              case "mail.reconcile":
                return client.execute({ headers, payload });
              case "mail.outbox":
                return client.execute({ headers, payload });
              case "mem.read":
                return client.execute({ headers, payload });
              case "mem.search":
                return client.execute({ headers, payload });
              case "mem.write":
                return client.execute({ headers, payload });
              case "obsidian.list":
                return client.execute({ headers, payload });
              case "obsidian.read":
                return client.execute({ headers, payload });
              case "obsidian.write":
                return client.execute({ headers, payload });
              case "device.intake":
                return client.execute({ headers, payload });
              case "device.list":
                return client.execute({ headers, payload });
            }
          },
        });
      }
      if (input.path === "/api/synthos/workflows") {
        if (input.method === "GET")
          return yield* executeAuthenticatedEnvironmentHttpRequest({
            ...common,
            group: "synthos",
            method: "GET",
            url: (urls) => urls.listWorkflows(),
            request: ({ client, headers }) => client.listWorkflows({ headers }),
          });
        const payload = yield* decodeCreateWorkflow(input.body);
        return yield* executeAuthenticatedEnvironmentHttpRequest({
          ...common,
          group: "synthos",
          method: "POST",
          url: (urls) => urls.createWorkflow(),
          request: ({ client, headers }) => client.createWorkflow({ headers, payload }),
        });
      }
      const match = /^\/api\/synthos\/workflows\/([^/]+)(\/commands)?$/.exec(input.path);
      if (!match) return yield* new SynthosClientError({ message: "Unknown SynthOS operation." });
      const workflowId = yield* Effect.try(() => decodeURIComponent(match[1]!));
      if (
        workflowId === "." ||
        workflowId === ".." ||
        workflowId.length > 240 ||
        /[/\\\x00-\x1f\x7f]/.test(workflowId)
      ) {
        return yield* new SynthosClientError({ message: "Invalid SynthOS workflow identity." });
      }
      if (input.method === "GET" && !match[2])
        return yield* executeAuthenticatedEnvironmentHttpRequest({
          ...common,
          group: "synthos",
          method: "GET",
          url: (urls) => urls.getWorkflow({ params: { workflowId } }),
          request: ({ client, headers }) => client.getWorkflow({ headers, params: { workflowId } }),
        });
      if (input.method === "POST" && match[2]) {
        const payload = yield* decodeWorkflowCommand(input.body);
        return yield* executeAuthenticatedEnvironmentHttpRequest({
          ...common,
          group: "synthos",
          method: "POST",
          url: (urls) => urls.commandWorkflow({ params: { workflowId } }),
          request: ({ client, headers }) =>
            client.commandWorkflow({ headers, params: { workflowId }, payload }),
        });
      }
      return yield* new SynthosClientError({ message: "Unsupported SynthOS operation." });
    }),
  });
}

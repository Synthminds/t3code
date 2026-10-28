import { SynthosConnectionError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

export class ConnectionFetch extends Context.Service<
  ConnectionFetch,
  { readonly fetch: (url: string, init: RequestInit) => Promise<Response> }
>()("t3/synthos-connections/ConnectionHttp/ConnectionFetch") {}

export class ConnectionHttp extends Context.Service<
  ConnectionHttp,
  {
    readonly request: (input: {
      readonly connection: "agentmail" | "mem";
      readonly key: Redacted.Redacted<string> | undefined;
      readonly path: string;
      readonly method?: "GET" | "POST" | "PATCH";
      readonly body?: unknown;
    }) => Effect.Effect<unknown, SynthosConnectionError>;
  }
>()("t3/synthos-connections/ConnectionHttp") {}

const MAX_RESPONSE_BYTES = 1_048_576;
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const isConnectionError = Schema.is(SynthosConnectionError);
const make = Effect.gen(function* () {
  const client = yield* ConnectionFetch;
  const request: ConnectionHttp["Service"]["request"] = Effect.fn("ConnectionHttp.request")(
    function* (input) {
      if (!input.key || Redacted.value(input.key).trim() === "") {
        return yield* new SynthosConnectionError({
          connection: input.connection,
          reason: "unavailable",
        });
      }
      const origin =
        input.connection === "agentmail" ? "https://api.agentmail.to" : "https://api.mem.ai";
      if (!input.path.startsWith("/") || input.path.startsWith("//")) {
        return yield* new SynthosConnectionError({
          connection: input.connection,
          reason: "invalid_input",
        });
      }
      const key = input.key;
      const body =
        input.body === undefined
          ? undefined
          : yield* encodeJson(input.body).pipe(
              Effect.mapError(
                (cause) =>
                  new SynthosConnectionError({
                    connection: input.connection,
                    reason: "invalid_input",
                    cause,
                  }),
              ),
            );
      const text = yield* Effect.tryPromise({
        try: async (signal) => {
          const timeout = AbortSignal.timeout(15_000);
          const response = await client.fetch(`${origin}${input.path}`, {
            method: input.method ?? "GET",
            redirect: "error",
            signal: AbortSignal.any([signal, timeout]),
            headers: {
              Authorization: `Bearer ${Redacted.value(key)}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            ...(body === undefined ? {} : { body }),
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new SynthosConnectionError({
              connection: input.connection,
              reason:
                response.status === 409 || response.status === 412
                  ? "conflict"
                  : response.status === 404
                    ? "not_found"
                    : "remote_rejected",
              status: response.status,
            });
          }
          if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
            await response.body?.cancel();
            throw new SynthosConnectionError({
              connection: input.connection,
              reason: "response_too_large",
            });
          }
          const reader = response.body?.getReader();
          if (!reader)
            throw new SynthosConnectionError({
              connection: input.connection,
              reason: "response_invalid",
            });
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              size += chunk.value.byteLength;
              if (size > MAX_RESPONSE_BYTES) {
                await reader.cancel();
                throw new SynthosConnectionError({
                  connection: input.connection,
                  reason: "response_too_large",
                });
              }
              chunks.push(chunk.value);
            }
          } finally {
            reader.releaseLock();
          }
          return Buffer.concat(chunks).toString("utf8");
        },
        catch: (cause) =>
          isConnectionError(cause)
            ? cause
            : new SynthosConnectionError({
                connection: input.connection,
                reason: "transport",
                cause,
              }),
      });
      return yield* decodeJson(text).pipe(
        Effect.mapError(
          (cause) =>
            new SynthosConnectionError({
              connection: input.connection,
              reason: "response_invalid",
              cause,
            }),
        ),
      );
    },
  );
  return ConnectionHttp.of({ request });
});

export const layer = Layer.effect(ConnectionHttp, make);
export const layerFetch = Layer.effect(
  ConnectionFetch,
  Effect.gen(function* () {
    const fetch = yield* FetchHttpClient.Fetch;
    return { fetch: (url: string, init: RequestInit) => fetch(url, init) };
  }),
);

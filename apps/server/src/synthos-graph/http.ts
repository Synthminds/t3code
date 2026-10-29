import {
  EnvironmentHttpApi,
  SynthosRequestError,
  synthosGraphRequiredScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as SynthosGraph from "./SynthosGraph.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "synthosGraph",
  Effect.fnUntraced(function* (handlers) {
    const context = yield* SynthosGraph.SynthosGraph;
    return handlers.handle(
      "execute",
      Effect.fn("environment.synthos.graph")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        const actor = yield* requireEnvironmentScope(synthosGraphRequiredScope(args.payload));
        return yield* context
          .execute({ sessionId: actor.sessionId, scopes: [...actor.scopes] }, args.payload)
          .pipe(
            Effect.catch(
              Effect.fnUntraced(function* (error) {
                if (error.reason === "storage")
                  return yield* failEnvironmentInternal("internal_error", error);
                return yield* new SynthosRequestError({ reason: `graph_${error.reason}` });
              }),
            ),
          );
      }),
    );
  }),
);

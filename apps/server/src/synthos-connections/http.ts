import {
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  SynthosRequestError,
  synthosConnectionRequiredScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import * as SynthosConnections from "./SynthosConnections.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "synthosConnections",
  Effect.fnUntraced(function* (handlers) {
    const connections = yield* SynthosConnections.SynthosConnections;
    return handlers.handle(
      "execute",
      Effect.fn("environment.synthos.connections")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(synthosConnectionRequiredScope(args.payload));
        const actor = yield* EnvironmentAuthenticatedPrincipal;
        return yield* connections
          .execute({ sessionId: actor.sessionId, scopes: [...actor.scopes] }, args.payload)
          .pipe(Effect.mapError((error) => new SynthosRequestError({ reason: error.reason })));
      }),
    );
  }),
);

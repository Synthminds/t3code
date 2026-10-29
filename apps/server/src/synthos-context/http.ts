import {
  EnvironmentHttpApi,
  SynthosRequestError,
  synthosContextRequiredScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as SynthosContext from "./SynthosContext.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "synthosContext",
  Effect.fnUntraced(function* (handlers) {
    const context = yield* SynthosContext.SynthosContext;
    return handlers.handle(
      "execute",
      Effect.fn("environment.synthos.context")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        const actor = yield* requireEnvironmentScope(synthosContextRequiredScope(args.payload));
        return yield* context.execute({ scopes: [...actor.scopes] }, args.payload).pipe(
          Effect.catch(
            Effect.fnUntraced(function* (error) {
              if (error.reason === "storage")
                return yield* failEnvironmentInternal("internal_error", error);
              return yield* new SynthosRequestError({ reason: `context_${error.reason}` });
            }),
          ),
        );
      }),
    );
  }),
);

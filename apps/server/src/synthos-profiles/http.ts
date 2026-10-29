import {
  EnvironmentHttpApi,
  SynthosRequestError,
  synthosProfileRequiredScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as SynthosProfiles from "./SynthosProfiles.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "synthosProfiles",
  Effect.fnUntraced(function* (handlers) {
    const profiles = yield* SynthosProfiles.SynthosProfiles;
    return handlers.handle(
      "execute",
      Effect.fn("environment.synthos.profiles")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        const actor = yield* requireEnvironmentScope(synthosProfileRequiredScope(args.payload));
        return yield* profiles
          .execute({ sessionId: actor.sessionId, scopes: [...actor.scopes] }, args.payload)
          .pipe(
            Effect.catch(
              Effect.fnUntraced(function* (error) {
                if (error.reason === "storage")
                  return yield* failEnvironmentInternal("internal_error", error);
                return yield* new SynthosRequestError({ reason: `profile_${error.reason}` });
              }),
            ),
          );
      }),
    );
  }),
);

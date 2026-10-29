import {
  EnvironmentHttpApi,
  SynthosRequestError,
  synthosKnowledgeRequiredScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as SynthosKnowledge from "./SynthosKnowledge.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "synthosKnowledge",
  Effect.fnUntraced(function* (handlers) {
    const knowledge = yield* SynthosKnowledge.SynthosKnowledge;
    return handlers.handle(
      "execute",
      Effect.fn("environment.synthos.knowledge")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        const actor = yield* requireEnvironmentScope(synthosKnowledgeRequiredScope(args.payload));
        return yield* knowledge
          .execute({ sessionId: actor.sessionId, scopes: [...actor.scopes] }, args.payload)
          .pipe(
            Effect.catch(
              Effect.fnUntraced(function* (error) {
                if (error.reason === "storage")
                  return yield* failEnvironmentInternal("internal_error", error);
                return yield* new SynthosRequestError({ reason: `knowledge_${error.reason}` });
              }),
            ),
          );
      }),
    );
  }),
);

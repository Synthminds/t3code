import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  SynthosPolicy,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as SynthosWorkflow from "./SynthosWorkflow.ts";
import { GCH_POLICY_INSPECTION } from "./gchPolicy.ts";
import * as SynthosHttp from "./http.ts";

class PolicyTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.synthos) {}
const decodePolicy = Schema.decodeUnknownEffect(SynthosPolicy);

it.effect("requires the exact read scope before exposing the host policy", () =>
  Effect.gen(function* () {
    let scopes = new Set<AuthEnvironmentScope>();
    let policyReads = 0;
    const routes = HttpApiBuilder.layer(PolicyTestApi).pipe(
      Layer.provide(SynthosHttp.layer),
      Layer.provide(
        Layer.mock(SynthosWorkflow.SynthosWorkflow)({
          policy: Effect.sync(() => {
            policyReads += 1;
            return GCH_POLICY_INSPECTION;
          }),
        }),
      ),
      Layer.provide(Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({})),
      Layer.provide(
        Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
          Effect.suspend(() =>
            effect.pipe(
              Effect.provideService(EnvironmentAuthenticatedPrincipal, {
                sessionId: AuthSessionId.make("policy-test"),
                subject: "policy-test",
                method: "bearer-access-token",
                scopes,
              }),
            ),
          ),
        ),
      ),
      Layer.provide(HttpPlatform.layer),
      Layer.provide(Etag.layerWeak),
      Layer.provide(NodeServices.layer),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
    yield* Effect.addFinalizer(() => Effect.promise(dispose));
    const read = () =>
      Effect.promise(() => handler(new Request("http://localhost/api/synthos/policy")));

    for (const value of [[], ["filesystem:read"], ["orchestration:operate"]] as const) {
      scopes = new Set<AuthEnvironmentScope>(value);
      const response = yield* read();
      expect(response.status).toBe(403);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        code: "insufficient_scope",
        requiredScope: "orchestration:read",
      });
    }
    expect(policyReads).toBe(0);
    scopes = new Set(["orchestration:read"]);
    const response = yield* read();
    expect(response.status).toBe(200);
    const policy = yield* decodePolicy(yield* Effect.promise(() => response.json()));
    expect(policy).toEqual(GCH_POLICY_INSPECTION);
    expect(policyReads).toBe(1);
  }).pipe(Effect.scoped),
);

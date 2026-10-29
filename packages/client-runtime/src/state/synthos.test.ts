import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcHttp from "../rpc/http.ts";
import { createSynthosRequestCommand, type SynthosRequest } from "./synthos.ts";

const REMOTE_ID = EnvironmentId.make("remote-environment");
const COOKIE_ID = EnvironmentId.make("cookie-environment");
const probe = {
  toolId: "ripgrep",
  state: "working",
  scope: "cli_version",
  checkedAt: "2026-10-29T00:00:00Z",
  executableFingerprint: "a".repeat(64),
  reason: "completed",
  exitCode: 0,
  outputBytes: 64,
};
const policy = {
  version: "test-policy",
  sha256: "a".repeat(64),
  applicationScope: "synthos_workflows",
  sourceRepository: "https://github.com/example/policy",
  sourceCommit: "b".repeat(40),
  capturedAt: "2026-10-28",
  canonicalRulesSha256: "c".repeat(64),
  canonicalRules: "Fixture rules",
  sources: [],
  enforced: [],
  limitations: [],
};

const makeHarness = Effect.fn("TestSynthosRequest.makeHarness")(function* () {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const selected: EnvironmentId[] = [];
  const prepare = (
    environmentId: EnvironmentId,
    origin: string,
    token: string | null,
  ): PreparedConnection => ({
    environmentId,
    label: environmentId,
    httpBaseUrl: origin,
    socketUrl: origin.replace("https:", "wss:") + "/ws",
    httpAuthorization: token === null ? null : { _tag: "Bearer", token },
    target: new PrimaryConnectionTarget({
      environmentId,
      label: environmentId,
      httpBaseUrl: origin,
      wsBaseUrl: origin.replace("https:", "wss:"),
    }),
  });
  const remote = yield* SubscriptionRef.make(
    Option.some(prepare(REMOTE_ID, "https://selected.example.test", "selected-token")),
  );
  const cookie = yield* SubscriptionRef.make(
    Option.some(prepare(COOKIE_ID, "https://cookie.example.test", null)),
  );
  const supervisors = new Map([
    [REMOTE_ID, { prepared: remote } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]],
    [COOKIE_ID, { prepared: cookie } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]],
  ]);
  const environmentRegistry = {
    run: (environmentId, effect) => {
      selected.push(environmentId);
      const supervisor = supervisors.get(environmentId);
      return supervisor
        ? Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor)
        : Effect.fail(new EnvironmentRegistry.EnvironmentNotRegisteredError({ environmentId }));
    },
  } as EnvironmentRegistry.EnvironmentRegistry["Service"];
  const fetcher: typeof globalThis.fetch = async (request, init) => {
    const url = String(request);
    const body = init?.body == null ? null : await new Response(init.body).text();
    calls.push({ url, init: { ...init, ...(body === null ? {} : { body }) } });
    if (body?.includes('"type":"tools.probe"')) return Response.json({ probe });
    return Response.json(
      url.endsWith("/policy")
        ? policy
        : url.endsWith("/profiles")
          ? { type: "list", profiles: [], truncated: false }
          : url.endsWith("/context")
            ? {
                type: "settings",
                settings: {
                  projectId: "project-1",
                  version: 0,
                  autoRecall: false,
                  approvedNotes: [],
                  projectFolders: [],
                  neighborhoodFolders: [],
                  pinnedNotes: [],
                  excludedPaths: [],
                },
              }
            : url.endsWith("/connections")
              ? { connections: [] }
              : { workflows: [] },
    );
  };
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
      RpcHttp.layerRemoteHttpClient(fetcher),
    ),
  );
  const command = createSynthosRequestCommand(runtime);
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const run = (environmentId: EnvironmentId, input: SynthosRequest) =>
    Effect.promise(() => command.run(registry, { environmentId, input }));
  return { calls, selected, remote, run };
});

describe("SynthOS environment requests", () => {
  it.effect("uses each selected environment's origin and bearer or cookie authorization", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const remote = yield* harness.run(REMOTE_ID, {
        path: "/api/synthos/workflows",
        method: "GET",
      });
      expect(remote._tag).toBe("Success");
      if (remote._tag === "Success") expect(remote.value).toEqual({ workflows: [] });
      const cookie = yield* harness.run(COOKIE_ID, {
        path: "/api/synthos/connections",
        method: "POST",
        body: { type: "status" },
      });
      expect(cookie._tag).toBe("Success");
      if (cookie._tag === "Success") expect(cookie.value).toEqual({ connections: [] });
      const inspection = yield* harness.run(REMOTE_ID, {
        path: "/api/synthos/policy",
        method: "GET",
      });
      expect(inspection._tag).toBe("Success");
      if (inspection._tag === "Success") expect(inspection.value).toEqual(policy);
      const profiles = yield* harness.run(COOKIE_ID, {
        path: "/api/synthos/profiles",
        method: "POST",
        body: { type: "list" },
      });
      expect(profiles._tag).toBe("Success");
      if (profiles._tag === "Success")
        expect(profiles.value).toEqual({ type: "list", profiles: [], truncated: false });
      const context = yield* harness.run(REMOTE_ID, {
        path: "/api/synthos/context",
        method: "POST",
        body: { type: "get_settings", projectId: "project-1" },
      });
      expect(context._tag).toBe("Success");
      const measured = yield* harness.run(REMOTE_ID, {
        path: "/api/synthos/connections",
        method: "POST",
        body: { type: "tools.probe", toolId: "ripgrep" },
      });
      expect(measured._tag).toBe("Success");
      if (measured._tag === "Success") expect(measured.value).toEqual({ probe });
      expect(new Headers(harness.calls[5]?.init.headers).get("authorization")).toBe(
        "Bearer selected-token",
      );
      expect(harness.calls[5]?.init.body).toBe('{"type":"tools.probe","toolId":"ripgrep"}');
      expect(new Headers(harness.calls[4]?.init.headers).get("authorization")).toBe(
        "Bearer selected-token",
      );
      expect(harness.selected).toEqual([
        REMOTE_ID,
        COOKIE_ID,
        REMOTE_ID,
        COOKIE_ID,
        REMOTE_ID,
        REMOTE_ID,
      ]);
      expect(harness.calls.map((call) => call.url)).toEqual([
        "https://selected.example.test/api/synthos/workflows",
        "https://cookie.example.test/api/synthos/connections",
        "https://selected.example.test/api/synthos/policy",
        "https://cookie.example.test/api/synthos/profiles",
        "https://selected.example.test/api/synthos/context",
        "https://selected.example.test/api/synthos/connections",
      ]);
      expect(new Headers(harness.calls[0]?.init.headers).get("authorization")).toBe(
        "Bearer selected-token",
      );
      expect(new Headers(harness.calls[1]?.init.headers).has("authorization")).toBe(false);
      expect(harness.calls[1]?.init.credentials).toBe("include");
      expect(harness.calls[1]?.init.method).toBe("POST");
      expect(new Headers(harness.calls[2]?.init.headers).get("authorization")).toBe(
        "Bearer selected-token",
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "rejects unknown routes, invalid command schemas, and disconnected requests before HTTP",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const invalid: ReadonlyArray<SynthosRequest> = [
          { path: "https://outside.example.test/api/synthos/workflows", method: "GET" },
          { path: "/api/filesystem/read", method: "POST", body: { path: "/secret" } },
          { path: "/api/synthos/connections", method: "GET" },
          { path: "/api/synthos/connections", method: "POST", body: { type: "tools.probe" } },
          { path: "/api/synthos/policy", method: "POST", body: {} },
          { path: "/api/synthos/context", method: "GET" },
          {
            path: "/api/synthos/context",
            method: "POST",
            body: { type: "save_settings", projectId: "project-1" },
          },
          { path: "/api/synthos/profiles", method: "GET" },
          { path: "/api/synthos/profiles", method: "POST", body: { type: "upsert" } },
          { path: "/api/synthos/workflows/..", method: "GET" },
          { path: "/api/synthos/workflows/%2e%2e", method: "GET" },
          {
            path: "/api/synthos/connections",
            method: "POST",
            body: { type: "mail.send", id: "draft" },
          },
          {
            path: "/api/synthos/workflows",
            method: "POST",
            body: { title: "Incomplete workflow" },
          },
          {
            path: "/api/synthos/workflows/workflow-1/commands",
            method: "POST",
            body: { action: "execute-arbitrary-code" },
          },
        ];
        for (const input of invalid)
          expect((yield* harness.run(REMOTE_ID, input))._tag).toBe("Failure");
        yield* SubscriptionRef.set(harness.remote, Option.none());
        expect(
          (yield* harness.run(REMOTE_ID, { path: "/api/synthos/workflows", method: "GET" }))._tag,
        ).toBe("Failure");
        expect(harness.calls).toHaveLength(0);
      }).pipe(Effect.scoped),
  );
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import migration from "../persistence/Migrations/080_SynthosToolProbes.ts";
import * as Probes from "./NativeToolProbes.ts";

it.effect(
  "keeps inspection passive, persists observations and invalidates changed executable identity",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "probe-fixture-" });
      const command = path.join(root, "rg");
      yield* fs.writeFileString(command, "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(command, 0o700);
      const canonical = yield* fs.realPath(command);
      let calls = 0;
      const runner = Layer.succeed(Probes.NativeProbeRunner, {
        run: (executable, args) =>
          Effect.sync(() => {
            calls++;
            expect(executable).toBe(canonical);
            expect(args).toEqual(["--version"]);
            return { reason: "completed" as const, exitCode: 0, outputBytes: 12 };
          }),
      });
      const database = NodeSqliteClient.layer({ filename: path.join(root, "probes.sqlite") });
      const service = Probes.layer.pipe(
        Layer.provide(runner),
        Layer.provideMerge(database),
        Layer.provide(Layer.succeed(HostProcess.Environment, { PATH: root })),
      );
      yield* Effect.gen(function* () {
        yield* migration;
        const probes = yield* Probes.NativeToolProbes;
        expect((yield* probes.describe("ripgrep")).state).toBe("unmeasured");
        expect(calls).toBe(0);
        const observed = yield* probes.probe("ripgrep");
        expect(observed.state).toBe("working");
        expect(calls).toBe(1);
        expect((yield* probes.describe("ripgrep")).observation).toEqual(observed);
        expect(calls).toBe(1);
      }).pipe(Effect.provide(service));
      yield* Effect.gen(function* () {
        const probes = yield* Probes.NativeToolProbes;
        expect((yield* probes.describe("ripgrep")).state).toBe("working");
        yield* fs.writeFileString(command, "#!/bin/sh\nexit 42\n");
        expect((yield* probes.describe("ripgrep")).state).toBe("stale");
        expect(calls).toBe(1);
        yield* fs.remove(command);
        expect((yield* probes.probe("ripgrep")).reason).toBe("missing");
        expect(calls).toBe(1);
        expect((yield* probes.probe("21st")).reason).toBe("unsupported");
        expect(calls).toBe(1);
        expect((yield* probes.describe("21st")).observation?.reason).toBe("unsupported");
        expect((yield* probes.probe("constructor").pipe(Effect.flip)).reason).toBe("invalid_input");
      }).pipe(Effect.provide(service));
    }).pipe(
      Effect.provideService(HostProcess.Environment, { PATH: "/not-real" }),
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
);

it.live(
  "bounds subprocess duration/output, classifies exits and does not expose inherited credentials",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "probe-runner-" });
      const node = yield* HostProcess.ExecutablePath;
      const script = path.join(root, "check.mjs");
      const run = (body: string) =>
        Effect.gen(function* () {
          yield* fs.writeFileString(script, body);
          const runner = yield* Probes.NativeProbeRunner;
          return yield* runner.run(node, [script]);
        });
      const layer = Probes.layerRunner({ timeoutMs: 500, maxOutputBytes: 128 });
      yield* Effect.gen(function* () {
        expect(
          yield* run(
            'if(process.env.PRIVATE_FIXTURE_TOKEN)process.exit(42);process.stdout.write("ok");',
          ),
        ).toMatchObject({ reason: "completed", exitCode: 0, outputBytes: 2 });
        expect(yield* run("process.exit(7);")).toMatchObject({
          reason: "nonzero_exit",
          exitCode: 7,
        });
        expect(yield* run('process.stdout.write("x".repeat(10000));')).toMatchObject({
          reason: "output_limit",
        });
        expect(yield* run("setInterval(()=>{},1000);")).toMatchObject({ reason: "timeout" });
        const runner = yield* Probes.NativeProbeRunner;
        expect(yield* runner.run(path.join(root, "missing"), [])).toMatchObject({
          reason: "spawn_failed",
        });
      }).pipe(Effect.provide(layer));
    }).pipe(
      Effect.provideService(HostProcess.Environment, { PRIVATE_FIXTURE_TOKEN: "never-emit-this" }),
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
);

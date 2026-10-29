#!/usr/bin/env node
import { CompanionError, readCaptures, readConfig, Spool } from "./companion.mjs";
import { importHarness, pullFieldy } from "./sources.mjs";

const usage =
  "Usage: node scripts/synthos-companion/cli.mjs --config /absolute/config.json <ingest|flush|status|stop|resume|harness-import|harness-serial|g2-serve|fieldy-pull --start ISO --end ISO [--restart]>";

async function main() {
  const [option, file, command, ...extra] = process.argv.slice(2);
  if (
    option !== "--config" ||
    !file ||
    ![
      "ingest",
      "flush",
      "status",
      "stop",
      "resume",
      "harness-import",
      "harness-serial",
      "g2-serve",
      "fieldy-pull",
    ].includes(command) ||
    (command !== "fieldy-pull" && extra.length)
  ) {
    process.stderr.write(`${usage}\n`);
    process.exitCode = 2;
    return;
  }
  const config = readConfig(file);
  const spool = new Spool(config);
  if (command === "harness-serial") {
    const { openHarnessSerial } = await import("./harness-serial.mjs");
    const session = await openHarnessSerial(spool);
    process.stdout.write(`${JSON.stringify(session.status())}\n`);
    const close = () => {
      void session.close();
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    const result = await session.closed;
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!["closed", "session_limit", "capture_limit"].includes(result.reason)) process.exitCode = 1;
    return;
  }
  if (command === "g2-serve") {
    const { createG2Server } = await import("./g2-server.mjs");
    const server = await createG2Server(spool);
    server.on("error", () => {
      process.stderr.write('{"error":"g2_listener_failed"}\n');
      process.exitCode = 1;
    });
    server.listen(config.g2.port, "127.0.0.1", () => {
      process.stdout.write(
        `${JSON.stringify({ listening: true, port: config.g2.port, deviceConnection: "unverified" })}\n`,
      );
    });
    const close = () => {
      server.closeAllConnections();
      server.close();
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    return;
  }
  if (command === "stop") {
    spool.stop();
    process.stdout.write(`${JSON.stringify({ stopped: true })}\n`);
    return;
  }
  const result = await spool.exclusive(async () => {
    if (command === "harness-import") return importHarness(spool);
    if (command === "fieldy-pull") {
      if (
        extra[0] !== "--start" ||
        extra[2] !== "--end" ||
        !extra[1] ||
        !extra[3] ||
        (extra.length !== 4 && !(extra.length === 5 && extra[4] === "--restart"))
      )
        throw new CompanionError("fieldy_window_arguments_required");
      return pullFieldy(spool, {
        start: extra[1],
        end: extra[3],
        restart: extra[4] === "--restart",
      });
    }
    if (command === "ingest") {
      let accepted = 0;
      let duplicate = 0;
      for await (const capture of readCaptures(process.stdin)) {
        if (spool.enqueue(capture).duplicate) duplicate++;
        else accepted++;
      }
      return { ...spool.status(), accepted, duplicate };
    }
    if (command === "resume") spool.resume();
    if (command === "flush") return spool.flush(process.env[config.tokenEnv]);
    return spool.status();
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.failure) process.exitCode = 1;
}

main().catch((error) => {
  // Neither upstream errors nor input records are safe to echo alongside host credentials.
  process.stderr.write(
    `${JSON.stringify({ error: error instanceof CompanionError ? error.code : "companion_failed" })}\n`,
  );
  process.exitCode = 1;
});

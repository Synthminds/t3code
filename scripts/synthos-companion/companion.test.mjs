import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeChildProcess from "node:child_process";
import * as NodeTest from "node:test";
import {
  captureId,
  LIMITS,
  normalizeCapture,
  readCaptures,
  Spool,
  validateConfig,
} from "./companion.mjs";

const capture = (sourceId = "recording-1") => ({
  source: "fieldy",
  sourceId,
  title: "A thought",
  content: "Untrusted source material",
  capturedAt: "2026-10-28T12:00:00Z",
});
const rawConfig = (spoolDir, endpoint = "http://127.0.0.1:4317/api/synthos/connections") => ({
  endpoint,
  transport: "ssh",
  tokenEnv: "SYNTHOS_DEVICE_TOKEN",
  spoolDir,
});
const receipt = (input, duplicate = false) => ({
  proposal: {
    id: `device-${captureId(input)}`,
    source: input.source,
    sourceId: input.sourceId,
    title: input.title,
    body: input.content,
    capturedAt: input.capturedAt,
    status: "proposed",
    trust: "untrusted-input",
    executionAllowed: false,
  },
  duplicate,
});

async function fixture(t, handle, overrides = {}) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "synthos-companion-"));
  const calls = [];
  const server = NodeHttp.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      input,
    });
    handle(input, response, calls.length);
  });
  server.listen(0, "127.0.0.1");
  await NodeEvents.once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });
  const config = validateConfig({
    ...rawConfig(directory, `http://127.0.0.1:${server.address().port}/api/synthos/connections`),
    ...overrides,
  });
  const spool = new Spool(config);
  return { config, spool, calls };
}

NodeTest.test(
  "restricts credentials and endpoints and rejects oversized streaming input",
  async () => {
    for (const endpoint of [
      "https://example.com/api/synthos/connections",
      "http://localhost/api/synthos/connections",
      "http://user:secret@127.0.0.1/api/synthos/connections",
      "http://127.0.0.1/api/synthos/connections?token=secret",
      "http://127.0.0.1/other",
    ]) {
      NodeAssert.throws(() => validateConfig(rawConfig("/tmp/companion", endpoint)));
    }
    NodeAssert.throws(() =>
      validateConfig({ ...rawConfig("/tmp/companion"), transport: "loopback-https" }),
    );
    NodeAssert.throws(() =>
      validateConfig({ ...rawConfig("/tmp/companion"), token: "inline-secret" }),
    );
    NodeAssert.throws(() =>
      validateConfig({ ...rawConfig("/tmp/companion"), requestTimeoutMs: 10_001 }),
    );
    NodeAssert.equal(
      validateConfig({
        ...rawConfig("/tmp/companion", "https://[::1]:4317/api/synthos/connections"),
        transport: "loopback-https",
      }).transport,
      "loopback-https",
    );
    NodeAssert.throws(() => normalizeCapture({ ...capture(), content: "x".repeat(12_001) }));
    NodeAssert.throws(() => normalizeCapture({ ...capture(), type: "workflow.start" }));
    await NodeAssert.rejects(
      async () => {
        for await (const value of readCaptures(
          NodeStream.Readable.from(["x".repeat(LIMITS.lineBytes), "x"]),
        ))
          void value;
      },
      { code: "capture_too_large" },
    );
    const line = Buffer.from(`${JSON.stringify({ ...capture(), content: "thought ☕" })}\n`);
    const parsed = [];
    for await (const value of readCaptures(
      NodeStream.Readable.from([...line].map((byte) => Buffer.from([byte]))),
    ))
      parsed.push(value);
    NodeAssert.equal(parsed[0].content, "thought ☕");
  },
);

NodeTest.test(
  "persists captures across restart and requires explicit resume before any dispatch",
  async (t) => {
    const { config, spool, calls } = await fixture(t, (input, response) =>
      response.end(JSON.stringify(receipt(input))),
    );
    await spool.exclusive(async () => {
      NodeAssert.equal(spool.enqueue(capture()).duplicate, false);
      NodeAssert.equal(spool.enqueue(capture()).duplicate, true);
      NodeAssert.throws(() => spool.enqueue({ ...capture(), content: "different" }), {
        code: "source_id_conflict",
      });
      NodeAssert.equal((await spool.flush("test-token")).attempted, 0);
    });
    const restarted = new Spool(config);
    await restarted.exclusive(async () => {
      NodeAssert.deepEqual(restarted.status(), {
        stopped: true,
        queued: 1,
        unknown: 0,
        rejected: 0,
      });
      restarted.resume();
      NodeAssert.equal(calls.length, 0);
      NodeAssert.equal((await restarted.flush("test-token")).sent, 1);
      NodeAssert.equal(restarted.status().queued, 0);
    });
    NodeAssert.equal(calls.length, 1);
    NodeAssert.equal(calls[0].authorization, "Bearer test-token");
    NodeAssert.equal(calls[0].method, "POST");
    NodeAssert.equal(calls[0].path, "/api/synthos/connections");
    NodeAssert.equal(calls[0].input.type, "device.intake");
    NodeAssert.equal(NodeFS.statSync(config.spoolDir).mode & 0o777, 0o700);
  },
);

NodeTest.test(
  "STOP during a request blocks the next queued capture and persists across restart",
  async (t) => {
    const { config, spool, calls } = await fixture(t, (input, response, count) => {
      if (count === 1) spool.stop();
      response.end(JSON.stringify(receipt(input)));
    });
    await spool.exclusive(async () => {
      spool.enqueue(capture("a"));
      spool.enqueue(capture("b"));
      spool.resume();
      NodeAssert.equal((await spool.flush("test-token")).sent, 1);
      NodeAssert.equal(spool.status().queued, 1);
    });
    const restarted = new Spool(config);
    await restarted.exclusive(async () => {
      NodeAssert.equal((await restarted.flush("test-token")).attempted, 0);
      NodeAssert.equal(calls.length, 1);
      restarted.resume();
      NodeAssert.equal((await restarted.flush("test-token")).sent, 1);
    });
    NodeAssert.equal(calls.length, 2);
  },
);

NodeTest.test(
  "retains unknown outcomes and replays stable source IDs for server deduplication",
  async (t) => {
    const accepted = new Set();
    const { config, spool, calls } = await fixture(t, (input, response, count) => {
      const id = captureId(input);
      const duplicate = accepted.has(id);
      accepted.add(id);
      if (count === 1) response.destroy();
      else response.end(JSON.stringify(receipt(input, duplicate)));
    });
    await spool.exclusive(async () => {
      spool.enqueue(capture());
      spool.resume();
      const result = await spool.flush("test-token");
      NodeAssert.equal(result.sent, 0);
      NodeAssert.equal(result.unknown, 1);
    });
    const restarted = new Spool(config);
    await restarted.exclusive(async () => {
      const result = await restarted.flush("test-token");
      NodeAssert.equal(result.sent, 1);
      NodeAssert.equal(result.duplicate, 1);
      NodeAssert.equal(result.queued, 0);
    });
    NodeAssert.equal(calls.length, 2);
    NodeAssert.equal(accepted.size, 1);
    NodeAssert.deepEqual(calls[0].input, calls[1].input);
  },
);

NodeTest.test("bounds queue and attempts, and rejects concurrent spool writers", async (t) => {
  const { spool, calls } = await fixture(
    t,
    (input, response) => response.end(JSON.stringify(receipt(input))),
    { maxQueueEntries: 2, maxRequestsPerFlush: 1 },
  );
  await spool.exclusive(async () => {
    spool.enqueue(capture("a"));
    spool.enqueue(capture("b"));
    NodeAssert.throws(() => spool.enqueue(capture("c")), { code: "queue_limit_reached" });
    await NodeAssert.rejects(
      spool.exclusive(async () => {}),
      { code: "spool_locked" },
    );
    spool.resume();
    const result = await spool.flush("test-token");
    NodeAssert.equal(result.sent, 1);
    NodeAssert.equal(result.queued, 1);
  });
  NodeAssert.equal(calls.length, 1);
});

NodeTest.test("enforces the byte budget without evicting earlier captures", async (t) => {
  const { spool, calls } = await fixture(t, () => NodeAssert.fail("No request expected"), {
    maxQueueBytes: 500,
  });
  await spool.exclusive(async () => {
    spool.enqueue(capture("a"));
    NodeAssert.throws(() => spool.enqueue(capture("b")), { code: "queue_limit_reached" });
    NodeAssert.equal(spool.status().queued, 1);
  });
  NodeAssert.equal(calls.length, 0);
});

NodeTest.test(
  "rejects an acknowledgement for another capture and bounds response size",
  async (t) => {
    for (const kind of ["invalid", "changed", "oversized", "unauthorized", "redirect"]) {
      await t.test(kind, async (child) => {
        const { spool, calls } = await fixture(child, (input, response) => {
          if (kind === "unauthorized") {
            response.statusCode = 401;
            response.end("upstream secret");
          } else if (kind === "redirect") {
            response.statusCode = 302;
            response.setHeader("Location", "https://example.com/");
            response.end();
          } else if (kind === "changed")
            response.end(JSON.stringify(receipt({ ...input, content: "different" }, true)));
          else
            response.end(
              kind === "oversized"
                ? "x".repeat(LIMITS.responseBytes + 1)
                : JSON.stringify(receipt(normalizeCapture(capture("another")))),
            );
        });
        await spool.exclusive(async () => {
          spool.enqueue(capture());
          spool.resume();
          const result = await spool.flush("test-token");
          NodeAssert.equal(result.sent, 0);
          NodeAssert.equal(result.queued, 1);
          NodeAssert.equal(
            result.failure,
            {
              invalid: "invalid_receipt",
              changed: "invalid_receipt",
              oversized: "response_too_large",
              unauthorized: "http_401",
              redirect: "http_302",
            }[kind],
          );
        });
        NodeAssert.equal(calls.length, 1);
      });
    }
  },
);

NodeTest.test(
  "request deadline interrupts a nonresponding server and retains the durable record",
  async (t) => {
    let expire;
    const cancelled = Promise.withResolvers();
    const { spool, calls } = await fixture(t, () => expire());
    await spool.exclusive(async () => {
      spool.enqueue(capture());
      spool.resume();
      const result = await spool.flush("test-token", {
        scheduleDeadline: (callback, ms) => {
          NodeAssert.equal(ms, 5_000);
          expire = callback;
          return () => cancelled.resolve();
        },
      });
      NodeAssert.equal(result.failure, "request_deadline");
      NodeAssert.equal(result.unknown, 1);
      NodeAssert.equal(result.sent, 0);
    });
    NodeAssert.equal(calls.length, 1);
    await cancelled.promise;
  },
);

NodeTest.test(
  "CLI redacts upstream content and credentials from errors and spool files",
  async (t) => {
    const { config, spool, calls } = await fixture(t, (_input, response) => {
      response.statusCode = 403;
      response.end("private upstream text");
    });
    await spool.exclusive(async () => {
      spool.enqueue(capture());
      spool.resume();
    });
    const configFile = NodePath.join(config.spoolDir, "config.json");
    NodeFS.writeFileSync(configFile, JSON.stringify(config));
    const child = NodeChildProcess.spawn(
      process.execPath,
      [new URL("cli.mjs", import.meta.url).pathname, "--config", configFile, "flush"],
      {
        env: { ...process.env, SYNTHOS_DEVICE_TOKEN: "private-test-token" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const [code] = await NodeEvents.once(child, "close");
    NodeAssert.equal(code, 1);
    NodeAssert.equal(JSON.parse(output).failure, "http_403");
    NodeAssert.equal(calls.length, 1);
    NodeAssert.doesNotMatch(
      output,
      /private-test-token|private upstream text|Untrusted source material/,
    );
    for (const name of NodeFS.readdirSync(NodePath.join(config.spoolDir, "queue"))) {
      NodeAssert.doesNotMatch(
        NodeFS.readFileSync(NodePath.join(config.spoolDir, "queue", name), "utf8"),
        /private-test-token|private upstream text/,
      );
    }
  },
);

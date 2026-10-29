import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeStream from "node:stream";
import { Spool, validateConfig } from "./companion.mjs";
import { fieldyGet, importHarness, pullFieldy } from "./sources.mjs";
import { createG2Server } from "./g2-server.mjs";

function fixture(t, extra = {}) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "synthos-sources-"));
  t.after(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
  const config = validateConfig({
    endpoint: "http://127.0.0.1:43773/api/synthos/connections",
    transport: "ssh",
    tokenEnv: "T3_TOKEN",
    spoolDir: directory,
    fieldy: { tokenEnv: "FIELDY_TOKEN", maxItems: 2 },
    ...extra,
  });
  return new Spool(config);
}
const window = { start: "2026-10-01T00:00:00Z", end: "2026-10-02T00:00:00Z" };
const conversation = (id) => ({
  id,
  title: "Conversation",
  content: "A processed thought",
  startTime: "2026-10-01T12:00:00Z",
});
const env = { FIELDY_TOKEN: "fake-fieldy-token" };

NodeTest.test(
  "Fieldy persists cursor only after imports and never forwards its API credential",
  async (t) => {
    const spool = fixture(t);
    const calls = [];
    let page = 0;
    const get = async (url, token) => {
      NodeAssert.equal(token, "fake-fieldy-token");
      const parsed = new URL(url);
      NodeAssert.equal(parsed.origin, "https://api.fieldy.ai");
      calls.push(parsed);
      if (parsed.pathname.endsWith("/conversations")) {
        NodeAssert.equal(parsed.searchParams.get("recordingSource"), "wearable");
        NodeAssert.equal(parsed.searchParams.get("pageSize"), "2");
        if (page++ === 0) {
          NodeAssert.equal(parsed.searchParams.get("cursor"), null);
          return { items: [conversation("a")], nextCursor: "opaque/next" };
        }
        NodeAssert.equal(parsed.searchParams.get("cursor"), "opaque/next");
        return { items: [conversation("a"), conversation("b")], nextCursor: null };
      }
      return conversation(parsed.pathname.split("/").at(-1));
    };
    await spool.exclusive(async () => {
      NodeAssert.equal((await pullFieldy(spool, window, { env, get })).accepted, 1);
    });
    const restarted = new Spool(spool.config);
    await restarted.exclusive(async () => {
      const result = await pullFieldy(restarted, window, { env, get });
      NodeAssert.equal(result.accepted, 1);
      NodeAssert.equal(result.duplicate, 1);
      NodeAssert.equal(result.stopped, true);
      NodeAssert.equal(result.hasMore, false);
      NodeAssert.equal((await pullFieldy(restarted, window, { env, get })).requests, 0);
      for (const item of restarted.entries())
        NodeAssert.doesNotMatch(NodeFS.readFileSync(item.file, "utf8"), /fake-fieldy-token/);
    });
    NodeAssert.equal(calls.length, 5);
  },
);

NodeTest.test(
  "Fieldy failures leave the page replayable, rate limits do not retry, and oversized lists reject",
  async (t) => {
    const spool = fixture(t);
    const calls = [];
    let fail = true;
    const get = async (url) => {
      calls.push(url);
      if (url.includes("?"))
        return { items: [conversation("a"), conversation("b")], nextCursor: null };
      if (url.endsWith("/b") && fail) throw new Error("private upstream detail");
      return conversation(url.split("/").at(-1));
    };
    await spool.exclusive(async () => {
      await NodeAssert.rejects(pullFieldy(spool, window, { env, get }));
      NodeAssert.equal(calls.length, 3);
      NodeAssert.equal(spool.status().queued, 1);
      NodeAssert.equal(
        NodeFS.existsSync(NodePath.join(spool.directory, "fieldy-cursor.json")),
        false,
      );
      fail = false;
      const replay = await pullFieldy(spool, window, { env, get });
      NodeAssert.equal(replay.duplicate, 1);
      NodeAssert.equal(replay.accepted, 1);
      await NodeAssert.rejects(
        pullFieldy(
          spool,
          { ...window, restart: true },
          {
            env,
            get: async () => ({ items: [conversation("a"), conversation("b"), conversation("c")] }),
          },
        ),
        { code: "fieldy_invalid_response" },
      );
    });
  },
);

NodeTest.test(
  "Fieldy labels truncation, skips unavailable recordings, and bounds request windows",
  async (t) => {
    const spool = fixture(t);
    await spool.exclusive(async () => {
      const result = await pullFieldy(spool, window, {
        env,
        get: async (url) =>
          url.includes("?")
            ? { items: [{ ...conversation("locked"), locked: true }, conversation("long")] }
            : { ...conversation("long"), content: "x".repeat(20_000) },
      });
      NodeAssert.equal(result.skipped, 1);
      NodeAssert.equal(result.requests, 2);
      NodeAssert.match(spool.entries()[0].entry.capture.content, /Truncated for import/);
      await NodeAssert.rejects(
        pullFieldy(spool, { start: window.start, end: "2026-12-02T00:00:00Z" }, { env }),
        { code: "invalid_fieldy_window" },
      );
    });
  },
);

NodeTest.test(
  "Fieldy HTTP bounds credentials, redirects, responses, and complete-request deadlines",
  async (t) => {
    let mode = "ok";
    let expire;
    const calls = [];
    const server = NodeHttp.createServer((request, response) => {
      calls.push(request.headers.authorization);
      if (mode === "deadline") {
        expire();
        return;
      }
      if (mode === "redirect") {
        response.writeHead(302, { Location: "https://example.com" });
        response.end();
        return;
      }
      if (mode === "rate") {
        response.writeHead(429);
        response.end();
        return;
      }
      response.end(mode === "large" ? "x".repeat(1_048_577) : '{"items":[]}');
    });
    server.listen(0, "127.0.0.1");
    await NodeEvents.once(server, "listening");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const request = (_url, options) =>
      NodeHttp.request(`http://127.0.0.1:${server.address().port}/`, options);
    NodeAssert.deepEqual(
      await fieldyGet("https://api.fieldy.ai/api/public/v2/conversations", "fake-token", {
        request,
      }),
      { items: [] },
    );
    for (const [next, code] of [
      ["redirect", "fieldy_http_302"],
      ["rate", "fieldy_http_429"],
      ["large", "fieldy_response_too_large"],
      ["deadline", "fieldy_deadline"],
    ]) {
      mode = next;
      await NodeAssert.rejects(
        fieldyGet("https://api.fieldy.ai/api/public/v2/conversations", "fake-token", {
          request,
          ...(mode === "deadline"
            ? {
                scheduleDeadline: (callback) => {
                  expire = callback;
                  return () => {};
                },
              }
            : {}),
        }),
        { code },
      );
    }
    NodeAssert.equal(calls.length, 5);
    NodeAssert.equal(
      calls.every((value) => value === "Bearer fake-token"),
      true,
    );
  },
);

NodeTest.test(
  "Harness imports only explicit JSONL exports, preserves IDs, and bounds batches",
  async (t) => {
    const spool = fixture(t);
    const file = NodePath.join(spool.directory, "harness.jsonl");
    const input = (sourceId) => ({
      source: "harness",
      sourceId,
      title: "Harness thought",
      content: "Pending text",
      capturedAt: "2026-10-28T12:00:00Z",
    });
    NodeFS.writeFileSync(
      file,
      [input("a"), input("b")].map((value) => JSON.stringify(value)).join("\n"),
    );
    const bounded = new Spool(
      validateConfig({ ...spool.config, harness: { inputPath: file, maxRecords: 1 } }),
    );
    await bounded.exclusive(async () => {
      const result = await importHarness(bounded);
      NodeAssert.equal(result.accepted, 1);
      NodeAssert.equal(result.reachedLimit, true);
      NodeAssert.equal(result.stopped, true);
      NodeAssert.equal((await importHarness(bounded)).accepted, 1);
      NodeAssert.equal((await importHarness(bounded)).complete, true);
      NodeAssert.equal((await importHarness(bounded)).accepted, 0);
      NodeFS.writeFileSync(file, JSON.stringify({ ...input("c"), source: "g2" }));
      await NodeAssert.rejects(importHarness(bounded), { code: "harness_source_required" });
    });
  },
);

NodeTest.test("Harness cancels only its owned reader on the input deadline", async (t) => {
  const spool = fixture(t);
  const file = NodePath.join(spool.directory, "harness.jsonl");
  NodeFS.writeFileSync(file, "");
  const configured = new Spool(validateConfig({ ...spool.config, harness: { inputPath: file } }));
  const reader = new NodeEvents.EventEmitter();
  reader.stdout = new NodeStream.PassThrough();
  reader.stderr = new NodeStream.PassThrough();
  const signals = [];
  reader.kill = (signal) => {
    signals.push(signal);
    reader.emit("close", null);
  };
  let cancelled = 0;
  await configured.exclusive(async () => {
    await NodeAssert.rejects(
      importHarness(configured, {
        spawn: () => reader,
        scheduleDeadline: (expire, ms) => {
          NodeAssert.equal(ms, 5_000);
          queueMicrotask(expire);
          return () => {
            cancelled++;
          };
        },
      }),
      { code: "harness_read_deadline" },
    );
    NodeAssert.equal(configured.status().queued, 0);
  });
  NodeAssert.deepEqual(signals, ["SIGKILL"]);
  NodeAssert.equal(cancelled, 1);
});

async function g2Fixture(t) {
  const spool = fixture(t, { g2: { port: 43800, pairingTokenEnv: "PHONE_TOKEN" } });
  let time = 1_000;
  const token = "phone-pairing-credential-for-tests-only";
  const server = await createG2Server(spool, {
    env: { PHONE_TOKEN: token, T3_TOKEN: "host-bearer-secret" },
    now: () => time,
  });
  server.listen(0, "127.0.0.1");
  await NodeEvents.once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function request(route, value, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = NodeHttp.request(
        `${origin}${route}`,
        {
          method: value === undefined ? "GET" : "POST",
          agent: false,
          headers: {
            Origin: origin,
            ...(value === undefined ? {} : { "Content-Type": "application/json" }),
            ...headers,
          },
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode,
              headers: response.headers,
              text: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(value === undefined ? undefined : JSON.stringify(value));
    });
  }
  return {
    spool,
    token,
    request,
    advance: () => {
      time += 3_600_001;
    },
  };
}

NodeTest.test(
  "G2 phone gets scoped capture and STOP, never host bearer or resume access",
  async (t) => {
    const { spool, token, request, advance } = await g2Fixture(t);
    const page = await request("/");
    NodeAssert.equal(page.status, 200);
    NodeAssert.match(page.text, /Glasses connection is unverified/);
    NodeAssert.doesNotMatch(page.text, /host-bearer-secret|phone-pairing-credential/);
    NodeAssert.match(page.headers["content-security-policy"], /default-src 'none'/);
    NodeAssert.equal((await request("/api/g2/status")).status, 401);
    NodeAssert.equal(
      (await request("/api/g2/pair", { token }, { Origin: "https://untrusted.example" })).status,
      403,
    );
    const paired = await request("/api/g2/pair", { token });
    const cookie = paired.headers["set-cookie"][0].split(";", 1)[0];
    NodeAssert.match(paired.headers["set-cookie"][0], /HttpOnly; SameSite=Strict/);
    const headers = { Cookie: cookie };
    const capture = {
      source: "g2",
      sourceId: "phone-1",
      title: "Thought",
      content: "Save for review",
      capturedAt: "2026-10-28T12:00:00Z",
    };
    NodeAssert.equal((await request("/api/g2/capture", capture, headers)).status, 200);
    NodeAssert.equal(
      JSON.parse((await request("/api/g2/capture", capture, headers)).text).duplicate,
      true,
    );
    NodeAssert.equal(spool.status().queued, 1);
    NodeAssert.equal(
      (await request("/api/g2/capture", { ...capture, source: "fieldy" }, headers)).status,
      400,
    );
    NodeAssert.equal((await request("/api/g2/resume", {}, headers)).status, 404);
    NodeAssert.equal((await request("/api/synthos/connections", {}, headers)).status, 404);
    await spool.exclusive(async () => {
      spool.resume();
    });
    NodeAssert.equal((await request("/api/g2/stop", {}, headers)).status, 200);
    NodeAssert.equal(spool.stopped(), true);
    advance();
    NodeAssert.equal((await request("/api/g2/status", undefined, headers)).status, 401);
  },
);

NodeTest.test(
  "G2 bounds pairing attempts, denies rebinding, and rejects shared host credentials",
  async (t) => {
    const { spool, token, request } = await g2Fixture(t);
    NodeAssert.equal((await request("/", undefined, { Host: "untrusted.example" })).status, 403);
    for (let index = 0; index < 5; index++)
      NodeAssert.equal((await request("/api/g2/pair", { token: "wrong" })).status, 403);
    NodeAssert.equal((await request("/api/g2/pair", { token })).status, 429);
    await NodeAssert.rejects(
      createG2Server(spool, { env: { PHONE_TOKEN: token, T3_TOKEN: token } }),
      { code: "separate_pairing_token_required" },
    );
  },
);

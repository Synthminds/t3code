import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import { CompanionError, LIMITS, normalizeCapture } from "./companion.mjs";
import { credential } from "./sources.mjs";

const assets = new Map([
  [
    "/even.js",
    [
      "text/javascript; charset=utf-8",
      NodeFS.readFileSync(new URL("./g2/even.js", import.meta.url)),
    ],
  ],
  [
    "/",
    ["text/html; charset=utf-8", NodeFS.readFileSync(new URL("./g2/index.html", import.meta.url))],
  ],
  [
    "/capture.js",
    [
      "text/javascript; charset=utf-8",
      NodeFS.readFileSync(new URL("./g2/capture.js", import.meta.url)),
    ],
  ],
  [
    "/capture.css",
    ["text/css; charset=utf-8", NodeFS.readFileSync(new URL("./g2/capture.css", import.meta.url))],
  ],
]);
const digest = (text) => NodeCrypto.createHash("sha256").update(text).digest();

async function body(request) {
  const chunks = [];
  let size = 0;
  const timer = setTimeout(() => request.destroy(new CompanionError("request_deadline")), 5_000);
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > LIMITS.lineBytes) throw new CompanionError("capture_too_large");
      chunks.push(chunk);
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)),
      );
    } catch {
      throw new CompanionError("invalid_capture");
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function createG2Server(spool, { env = process.env, now = Date.now } = {}) {
  const config = spool.config.g2;
  if (!config) throw new CompanionError("g2_not_configured");
  const pairingToken = credential(env, config.pairingTokenEnv);
  if (pairingToken.length < 32 || pairingToken === env[spool.config.tokenEnv])
    throw new CompanionError("separate_pairing_token_required");
  await spool.exclusive(async () => {});
  const expectedToken = digest(pairingToken);
  const servedAssets = new Map(assets);
  const bundle = new URL("./dist/even-sdk.js", import.meta.url);
  if (NodeFS.existsSync(bundle))
    servedAssets.set("/even-sdk.js", [
      "text/javascript; charset=utf-8",
      NodeFS.readFileSync(bundle),
    ]);
  const sessions = new Map();
  let attempts = [];
  const server = NodeHttp.createServer(
    {
      maxHeaderSize: 8_192,
      requestTimeout: 5_000,
      headersTimeout: 5_000,
      connectionsCheckingInterval: 1_000,
    },
    (request, response) => {
      void handle(request, response).catch((error) => {
        if (response.destroyed || response.headersSent) {
          response.destroy();
          return;
        }
        const code = error instanceof CompanionError ? error.code : "companion_failed";
        reply(response, code === "spool_locked" ? 503 : 400, { error: code });
      });
    },
  );
  server.maxConnections = 8;
  server.setTimeout(5_000, (socket) => socket.destroy());

  function reply(response, status, value, extra = {}) {
    response.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    });
    response.end(JSON.stringify(value));
  }

  async function handle(request, response) {
    const address = server.address();
    const host = `127.0.0.1:${typeof address === "object" && address ? address.port : config.port}`;
    if (request.headers.host !== host || !["GET", "POST"].includes(request.method)) {
      reply(response, 403, { error: "forbidden" });
      return;
    }
    const route = request.url;
    if (request.method === "GET" && servedAssets.has(route)) {
      const [type, data] = servedAssets.get(route);
      response.writeHead(200, {
        "Content-Type": type,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer",
      });
      response.end(data);
      return;
    }
    if (
      request.method === "POST" &&
      (request.headers.origin !== `http://${host}` ||
        request.headers["content-type"]?.split(";", 1)[0] !== "application/json")
    ) {
      reply(response, 403, { error: "forbidden" });
      return;
    }
    if (route === "/api/g2/pair" && request.method === "POST") {
      attempts = attempts.filter((at) => at > now() - 60_000);
      if (attempts.length >= 5) {
        reply(response, 429, { error: "pairing_rate_limited" });
        return;
      }
      attempts.push(now());
      const input = await body(request);
      if (
        !input ||
        typeof input.token !== "string" ||
        input.token.length > 8_192 ||
        !NodeCrypto.timingSafeEqual(digest(input.token), expectedToken)
      ) {
        reply(response, 403, { error: "pairing_refused" });
        return;
      }
      for (const [token, expires] of sessions) if (expires <= now()) sessions.delete(token);
      if (sessions.size >= 4) {
        reply(response, 429, { error: "session_limit_reached" });
        return;
      }
      const token = NodeCrypto.randomBytes(32).toString("hex");
      sessions.set(token, now() + 3_600_000);
      reply(
        response,
        200,
        { paired: true },
        {
          "Set-Cookie": `synthos_g2=${token}; HttpOnly; SameSite=Strict; Path=/api/g2/; Max-Age=3600`,
        },
      );
      return;
    }
    if (
      !new Set(["/api/g2/status", "/api/g2/capture", "/api/g2/stop", "/api/g2/signout"]).has(route)
    ) {
      reply(response, 404, { error: "not_found" });
      return;
    }
    const session = request.headers.cookie
      ?.split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith("synthos_g2="))
      ?.slice(11);
    if (!session || (sessions.get(session) ?? 0) <= now()) {
      reply(response, 401, { error: "pairing_required" });
      return;
    }
    if (route === "/api/g2/status" && request.method === "GET") {
      reply(
        response,
        200,
        await spool.exclusive(async () => ({ ...spool.status(), deviceConnection: "unverified" })),
      );
    } else if (route === "/api/g2/capture" && request.method === "POST") {
      const input = await body(request);
      const capture = normalizeCapture(input);
      if (capture.source !== "g2") throw new CompanionError("g2_source_required");
      const result = await spool.exclusive(async () => ({
        ...spool.enqueue(capture),
        ...spool.status(),
      }));
      reply(response, 200, { sourceId: capture.sourceId, ...result, executionAllowed: false });
    } else if (route === "/api/g2/stop" && request.method === "POST") {
      await body(request);
      spool.stop();
      reply(response, 200, { stopped: true });
    } else if (route === "/api/g2/signout" && request.method === "POST") {
      await body(request);
      sessions.delete(session);
      reply(
        response,
        200,
        { paired: false },
        { "Set-Cookie": "synthos_g2=; HttpOnly; SameSite=Strict; Path=/api/g2/; Max-Age=0" },
      );
    } else reply(response, 405, { error: "method_not_allowed" });
  }
  return server;
}

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";

export const LIMITS = Object.freeze({
  lineBytes: 32_768,
  responseBytes: 65_536,
  entries: 1_000,
  queueBytes: 8_388_608,
});

export class CompanionError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function requireValue(condition, code) {
  if (!condition) throw new CompanionError(code);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedInteger(value, fallback, max) {
  const result = value ?? fallback;
  requireValue(Number.isSafeInteger(result) && result > 0 && result <= max, "invalid_config");
  return result;
}

export function validateConfig(raw) {
  requireValue(object(raw), "invalid_config");
  const keys = [
    "endpoint",
    "transport",
    "tokenEnv",
    "spoolDir",
    "requestTimeoutMs",
    "maxQueueEntries",
    "maxQueueBytes",
    "maxRequestsPerFlush",
    "fieldy",
    "harness",
    "g2",
    "harnessSerial",
  ];
  requireValue(
    Object.keys(raw).every((key) => keys.includes(key)),
    "invalid_config",
  );
  let endpoint;
  try {
    endpoint = new URL(raw.endpoint);
  } catch {
    throw new CompanionError("invalid_endpoint");
  }
  requireValue(["127.0.0.1", "[::1]"].includes(endpoint.hostname), "endpoint_must_be_loopback");
  requireValue(
    !endpoint.username &&
      !endpoint.password &&
      !endpoint.search &&
      !endpoint.hash &&
      endpoint.pathname === "/api/synthos/connections",
    "invalid_endpoint",
  );
  requireValue(
    (raw.transport === "loopback-https" && endpoint.protocol === "https:") ||
      (raw.transport === "ssh" && ["http:", "https:"].includes(endpoint.protocol)),
    "explicit_secure_transport_required",
  );
  requireValue(
    typeof raw.tokenEnv === "string" && /^[A-Z_][A-Z0-9_]{0,127}$/.test(raw.tokenEnv),
    "token_env_reference_required",
  );
  requireValue(
    typeof raw.spoolDir === "string" &&
      NodePath.isAbsolute(raw.spoolDir) &&
      NodePath.resolve(raw.spoolDir) !== NodePath.parse(raw.spoolDir).root,
    "absolute_spool_directory_required",
  );
  const optionalSources = {};
  if (raw.fieldy !== undefined) {
    requireValue(
      object(raw.fieldy) &&
        Object.keys(raw.fieldy).every((key) => ["tokenEnv", "maxItems"].includes(key)),
      "invalid_config",
    );
    requireValue(
      typeof raw.fieldy.tokenEnv === "string" &&
        /^[A-Z_][A-Z0-9_]{0,127}$/.test(raw.fieldy.tokenEnv),
      "token_env_reference_required",
    );
    optionalSources.fieldy = Object.freeze({
      tokenEnv: raw.fieldy.tokenEnv,
      maxItems: boundedInteger(raw.fieldy.maxItems, 10, 20),
    });
  }
  if (raw.harness !== undefined) {
    requireValue(
      object(raw.harness) &&
        Object.keys(raw.harness).every((key) =>
          ["inputPath", "allowTty", "maxRecords", "readTimeoutMs"].includes(key),
        ),
      "invalid_config",
    );
    requireValue(
      typeof raw.harness.inputPath === "string" && NodePath.isAbsolute(raw.harness.inputPath),
      "absolute_input_path_required",
    );
    requireValue(
      raw.harness.allowTty === undefined || typeof raw.harness.allowTty === "boolean",
      "invalid_config",
    );
    optionalSources.harness = Object.freeze({
      inputPath: raw.harness.inputPath,
      allowTty: raw.harness.allowTty === true,
      maxRecords: boundedInteger(raw.harness.maxRecords, 20, 100),
      readTimeoutMs: boundedInteger(raw.harness.readTimeoutMs, 5_000, 30_000),
    });
  }
  if (raw.g2 !== undefined) {
    requireValue(
      object(raw.g2) &&
        Object.keys(raw.g2).every((key) => ["port", "pairingTokenEnv"].includes(key)),
      "invalid_config",
    );
    requireValue(
      typeof raw.g2.pairingTokenEnv === "string" &&
        /^[A-Z_][A-Z0-9_]{0,127}$/.test(raw.g2.pairingTokenEnv) &&
        raw.g2.pairingTokenEnv !== raw.tokenEnv,
      "separate_pairing_token_required",
    );
    optionalSources.g2 = Object.freeze({
      port: boundedInteger(raw.g2.port, 43800, 65_535),
      pairingTokenEnv: raw.g2.pairingTokenEnv,
    });
  }
  if (raw.harnessSerial !== undefined) {
    requireValue(
      object(raw.harnessSerial) &&
        Object.keys(raw.harnessSerial).every((key) =>
          ["path", "sessionTimeoutMs", "maxCaptures"].includes(key),
        ),
      "invalid_config",
    );
    requireValue(
      typeof raw.harnessSerial.path === "string" &&
        raw.harnessSerial.path.startsWith("/dev/") &&
        NodePath.isAbsolute(raw.harnessSerial.path),
      "explicit_serial_path_required",
    );
    optionalSources.harnessSerial = Object.freeze({
      path: raw.harnessSerial.path,
      sessionTimeoutMs: boundedInteger(raw.harnessSerial.sessionTimeoutMs, 60_000, 300_000),
      maxCaptures: boundedInteger(raw.harnessSerial.maxCaptures, 20, 100),
    });
  }
  return Object.freeze({
    endpoint: endpoint.href,
    transport: raw.transport,
    tokenEnv: raw.tokenEnv,
    spoolDir: NodePath.resolve(raw.spoolDir),
    requestTimeoutMs: boundedInteger(raw.requestTimeoutMs, 5_000, 10_000),
    maxQueueEntries: boundedInteger(raw.maxQueueEntries, 100, LIMITS.entries),
    maxQueueBytes: boundedInteger(raw.maxQueueBytes, 2_097_152, LIMITS.queueBytes),
    maxRequestsPerFlush: boundedInteger(raw.maxRequestsPerFlush, 20, 100),
    ...optionalSources,
  });
}

export function readBounded(file, maxBytes) {
  const descriptor = NodeFS.openSync(file, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
  try {
    const stat = NodeFS.fstatSync(descriptor);
    requireValue(stat.isFile() && stat.size <= maxBytes, "stored_file_invalid");
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size <= maxBytes) {
      const count = NodeFS.readSync(descriptor, buffer, size, maxBytes + 1 - size, null);
      if (!count) break;
      size += count;
    }
    requireValue(size <= maxBytes, "stored_file_invalid");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
  } finally {
    NodeFS.closeSync(descriptor);
  }
}

export function readConfig(file) {
  try {
    return validateConfig(JSON.parse(readBounded(file, 8_192)));
  } catch (error) {
    throw error instanceof CompanionError ? error : new CompanionError("config_unreadable");
  }
}

export function normalizeCapture(raw) {
  requireValue(object(raw), "invalid_capture");
  requireValue(
    Object.keys(raw).every((key) =>
      ["type", "source", "sourceId", "title", "content", "capturedAt"].includes(key),
    ),
    "invalid_capture",
  );
  requireValue(raw.type === undefined || raw.type === "device.intake", "invalid_capture");
  requireValue(["harness", "fieldy", "g2"].includes(raw.source), "invalid_capture");
  for (const key of ["sourceId", "title", "capturedAt"]) {
    requireValue(
      typeof raw[key] === "string" &&
        raw[key].trim().length > 0 &&
        raw[key].length <= 256 &&
        !/[\u0000-\u001f]/.test(raw[key]),
      "invalid_capture",
    );
  }
  requireValue(
    typeof raw.content === "string" &&
      raw.content.trim().length > 0 &&
      raw.content.length <= 12_000,
    "invalid_capture",
  );
  requireValue(
    /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(raw.capturedAt) &&
      Number.isFinite(Date.parse(raw.capturedAt)),
    "invalid_capture",
  );
  const capture = {
    type: "device.intake",
    source: raw.source,
    sourceId: raw.sourceId.trim(),
    title: raw.title.trim(),
    content: raw.content.replaceAll("\r\n", "\n").trim(),
    capturedAt: new Date(raw.capturedAt).toISOString(),
  };
  requireValue(Buffer.byteLength(JSON.stringify(capture)) <= LIMITS.lineBytes, "capture_too_large");
  return capture;
}

export function captureId(capture) {
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify([capture.source, capture.sourceId]))
    .digest("hex");
}

export async function* readCaptures(input) {
  let parts = [];
  let bytes = 0;
  let records = 0;
  const parse = () => {
    const line = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts, bytes));
    parts = [];
    bytes = 0;
    requireValue(++records <= LIMITS.entries, "batch_limit_reached");
    if (!line.trim()) return null;
    try {
      return normalizeCapture(JSON.parse(line));
    } catch (error) {
      throw error instanceof CompanionError ? error : new CompanionError("invalid_capture");
    }
  };
  for await (const rawChunk of input) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      bytes += end - offset;
      requireValue(bytes <= LIMITS.lineBytes, "capture_too_large");
      parts.push(chunk.subarray(offset, end));
      if (newline !== -1) {
        const capture = parse();
        if (capture) yield capture;
      }
      offset = end + 1;
    }
  }
  if (bytes > 0) {
    const capture = parse();
    if (capture) yield capture;
  }
}

function syncDirectory(directory) {
  const descriptor = NodeFS.openSync(directory, "r");
  try {
    NodeFS.fsyncSync(descriptor);
  } finally {
    NodeFS.closeSync(descriptor);
  }
}

export function durableWrite(file, value) {
  const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = NodeFS.openSync(temporary, "wx", 0o600);
    NodeFS.writeFileSync(descriptor, value);
    NodeFS.fsyncSync(descriptor);
    NodeFS.closeSync(descriptor);
    descriptor = undefined;
    NodeFS.renameSync(temporary, file);
    syncDirectory(NodePath.dirname(file));
  } finally {
    if (descriptor !== undefined) NodeFS.closeSync(descriptor);
    NodeFS.rmSync(temporary, { force: true });
  }
}

export class Spool {
  constructor(config) {
    this.config = config;
    this.directory = config.spoolDir;
    NodeFS.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    requireValue(
      NodeFS.lstatSync(this.directory).isDirectory() &&
        !NodeFS.lstatSync(this.directory).isSymbolicLink(),
      "invalid_spool_directory",
    );
    NodeFS.chmodSync(this.directory, 0o700);
    this.stopFile = NodePath.join(this.directory, "STOP");
    this.lockFile = NodePath.join(this.directory, "lock.json");
    this.queueDirectory = NodePath.join(this.directory, "queue");
  }

  async exclusive(action) {
    let descriptor;
    try {
      descriptor = NodeFS.openSync(this.lockFile, "wx", 0o600);
    } catch {
      throw new CompanionError("spool_locked");
    }
    try {
      NodeFS.writeFileSync(descriptor, JSON.stringify({ pid: process.pid }));
      NodeFS.fsyncSync(descriptor);
      this.initialize();
      return await action();
    } finally {
      NodeFS.closeSync(descriptor);
      NodeFS.unlinkSync(this.lockFile);
      syncDirectory(this.directory);
    }
  }

  initialize() {
    const marker = NodePath.join(this.directory, "initialized");
    if (!NodeFS.existsSync(marker)) {
      this.stop();
      durableWrite(marker, "1\n");
    }
    NodeFS.mkdirSync(this.queueDirectory, { recursive: true, mode: 0o700 });
    requireValue(
      NodeFS.lstatSync(this.queueDirectory).isDirectory() &&
        !NodeFS.lstatSync(this.queueDirectory).isSymbolicLink(),
      "invalid_spool_directory",
    );
  }

  stop() {
    durableWrite(this.stopFile, "Explicit resume is required.\n");
  }
  stopped() {
    return NodeFS.existsSync(this.stopFile);
  }
  resume() {
    NodeFS.rmSync(this.stopFile, { force: true });
    syncDirectory(this.directory);
  }

  entries() {
    const names = NodeFS.readdirSync(this.queueDirectory);
    requireValue(names.length <= this.config.maxQueueEntries, "queue_limit_reached");
    let bytes = 0;
    return names.sort().map((name) => {
      requireValue(/^[a-f0-9]{64}\.json$/.test(name), "stored_file_invalid");
      const file = NodePath.join(this.queueDirectory, name);
      const text = readBounded(file, LIMITS.lineBytes + 1_024);
      bytes += Buffer.byteLength(text);
      requireValue(bytes <= this.config.maxQueueBytes, "queue_limit_reached");
      let entry;
      try {
        entry = JSON.parse(text);
      } catch {
        throw new CompanionError("stored_file_invalid");
      }
      requireValue(
        object(entry) &&
          entry.version === 1 &&
          ["queued", "unknown", "rejected"].includes(entry.state) &&
          Number.isSafeInteger(entry.attempts) &&
          entry.attempts >= 0,
        "stored_file_invalid",
      );
      const capture = normalizeCapture(entry.capture);
      requireValue(`${captureId(capture)}.json` === name, "stored_file_invalid");
      return {
        file,
        bytes: Buffer.byteLength(text),
        entry: { version: 1, capture, state: entry.state, attempts: entry.attempts },
      };
    });
  }

  enqueue(rawCapture) {
    const capture = normalizeCapture(rawCapture);
    const entries = this.entries();
    const file = NodePath.join(this.queueDirectory, `${captureId(capture)}.json`);
    const existing = entries.find((entry) => entry.file === file);
    if (existing) {
      requireValue(
        JSON.stringify(existing.entry.capture) === JSON.stringify(capture),
        "source_id_conflict",
      );
      return { duplicate: true };
    }
    const entry = { version: 1, capture, state: "queued", attempts: 0 };
    const text = JSON.stringify(entry);
    requireValue(
      entries.length < this.config.maxQueueEntries &&
        entries.reduce((sum, item) => sum + item.bytes + 64, 0) + Buffer.byteLength(text) + 64 <=
          this.config.maxQueueBytes,
      "queue_limit_reached",
    );
    durableWrite(file, text);
    return { duplicate: false };
  }

  status() {
    const entries = this.entries();
    return {
      stopped: this.stopped(),
      queued: entries.length,
      unknown: entries.filter((item) => item.entry.state === "unknown").length,
      rejected: entries.filter((item) => item.entry.state === "rejected").length,
    };
  }

  async flush(token, options = {}) {
    requireValue(
      typeof token === "string" &&
        token.trim().length > 0 &&
        token.length <= 8_192 &&
        !/[\s\u0000-\u001f]/.test(token),
      "token_unavailable",
    );
    let sent = 0;
    let duplicate = 0;
    let attempted = 0;
    let failure;
    for (const item of this.entries()) {
      if (this.stopped() || attempted >= this.config.maxRequestsPerFlush) break;
      const entry = { ...item.entry, state: "unknown", attempts: item.entry.attempts + 1 };
      durableWrite(item.file, JSON.stringify(entry));
      if (this.stopped()) break;
      attempted++;
      try {
        const result = await postCapture(this.config, entry.capture, token, {
          ...options,
          isStopped: () => this.stopped(),
        });
        NodeFS.unlinkSync(item.file);
        syncDirectory(this.queueDirectory);
        sent++;
        if (result.duplicate) duplicate++;
      } catch (error) {
        failure = error instanceof CompanionError ? error.code : "transport_failed";
        if (failure.startsWith("http_4"))
          durableWrite(item.file, JSON.stringify({ ...entry, state: "rejected" }));
        break;
      }
    }
    return { ...this.status(), attempted, sent, duplicate, ...(failure ? { failure } : {}) };
  }
}

export function postCapture(
  config,
  capture,
  token,
  {
    scheduleDeadline = (expire, ms) => {
      const timer = setTimeout(expire, ms);
      return () => clearTimeout(timer);
    },
    isStopped = () => false,
  } = {},
) {
  const body = JSON.stringify(capture);
  requireValue(Buffer.byteLength(body) <= LIMITS.lineBytes, "capture_too_large");
  return new Promise((resolve, reject) => {
    if (isStopped()) {
      reject(new CompanionError("stopped"));
      return;
    }
    const request = (config.endpoint.startsWith("https:") ? NodeHttps : NodeHttp).request(
      config.endpoint,
      {
        method: "POST",
        agent: false,
        rejectUnauthorized: true,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Accept: "application/json",
        },
      },
    );
    const cancelDeadline = scheduleDeadline(
      () => request.destroy(new CompanionError("request_deadline")),
      config.requestTimeoutMs,
    );
    const fail = (error) =>
      reject(error instanceof CompanionError ? error : new CompanionError("transport_failed"));
    request.on("error", fail);
    request.on("close", cancelDeadline);
    request.on("response", (response) => {
      if (response.statusCode !== 200) {
        request.destroy(new CompanionError(`http_${response.statusCode ?? "invalid"}`));
        return;
      }
      let bytes = 0;
      const chunks = [];
      response.on("error", fail);
      response.on("aborted", () => fail(new CompanionError("response_interrupted")));
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > LIMITS.responseBytes) request.destroy(new CompanionError("response_too_large"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          requireValue(bytes <= LIMITS.responseBytes, "response_too_large");
          const result = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
          const proposal = result?.proposal;
          requireValue(
            typeof result?.duplicate === "boolean" &&
              proposal?.id === `device-${captureId(capture)}` &&
              proposal.source === capture.source &&
              proposal.sourceId === capture.sourceId &&
              proposal.title === capture.title &&
              proposal.body === capture.content &&
              proposal.capturedAt === capture.capturedAt &&
              proposal.status === "proposed" &&
              proposal.trust === "untrusted-input" &&
              proposal.executionAllowed === false,
            "invalid_receipt",
          );
          resolve({ duplicate: result.duplicate });
        } catch (error) {
          fail(error instanceof CompanionError ? error : new CompanionError("invalid_receipt"));
        }
      });
    });
    request.end(body);
  });
}

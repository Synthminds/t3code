import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeHttps from "node:https";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import {
  CompanionError,
  durableWrite,
  normalizeCapture,
  readBounded,
  readCaptures,
} from "./companion.mjs";

const FIELDY_ORIGIN = "https://api.fieldy.ai/api/public/v2";
const fail = (code) => {
  throw new CompanionError(code);
};
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function credential(env, name) {
  const value = env[name];
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 8_192 ||
    /[\s\u0000-\u001f]/.test(value)
  )
    fail("token_unavailable");
  return value;
}

export function fieldyGet(
  url,
  token,
  {
    request = NodeHttps.request,
    scheduleDeadline = (expire) => {
      const timer = setTimeout(expire, 5_000);
      return () => clearTimeout(timer);
    },
  } = {},
) {
  if (!url.startsWith(`${FIELDY_ORIGIN}/`)) fail("invalid_fieldy_endpoint");
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: "GET",
      agent: false,
      rejectUnauthorized: true,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const cancel = scheduleDeadline(() => req.destroy(new CompanionError("fieldy_deadline")));
    const rejectSafely = (error) =>
      reject(
        error instanceof CompanionError ? error : new CompanionError("fieldy_transport_failed"),
      );
    req.on("error", rejectSafely);
    req.on("close", cancel);
    req.on("response", (response) => {
      if (response.statusCode !== 200) {
        req.destroy(new CompanionError(`fieldy_http_${response.statusCode ?? "invalid"}`));
        return;
      }
      let bytes = 0;
      const chunks = [];
      response.on("error", rejectSafely);
      response.on("aborted", () => rejectSafely(new CompanionError("fieldy_response_interrupted")));
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 1_048_576) req.destroy(new CompanionError("fieldy_response_too_large"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          if (bytes > 1_048_576) fail("fieldy_response_too_large");
          resolve(
            JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)),
            ),
          );
        } catch (error) {
          rejectSafely(
            error instanceof CompanionError ? error : new CompanionError("fieldy_invalid_response"),
          );
        }
      });
    });
    req.end();
  });
}

function iso(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function fieldyCapture(detail, item) {
  if (!record(detail) || (detail.id !== undefined && detail.id !== item.id))
    fail("fieldy_invalid_response");
  if (detail.locked === true) return null;
  const content = typeof detail.content === "string" ? detail.content.trim() : "";
  const summary = typeof detail.summary === "string" ? detail.summary.trim() : "";
  if (!content && !summary) return null;
  const text = [summary ? `Summary:\n${summary}` : "", content ? `Transcript:\n${content}` : ""]
    .filter(Boolean)
    .join("\n\n");
  const capturedAt = detail.startTime ?? item.startTime;
  if (!iso(capturedAt)) fail("fieldy_invalid_response");
  return normalizeCapture({
    source: "fieldy",
    sourceId: item.id,
    title:
      typeof detail.title === "string" && detail.title.trim()
        ? detail.title.trim().slice(0, 256)
        : "Fieldy conversation",
    content:
      text.length <= 11_600
        ? text
        : `${text.slice(0, 11_600)}\n[Truncated for import. Review the full conversation in Fieldy.]`,
    capturedAt,
  });
}

export async function pullFieldy(
  spool,
  { start, end, restart = false },
  { env = process.env, get = fieldyGet } = {},
) {
  const config = spool.config.fieldy;
  if (!config) fail("fieldy_not_configured");
  if (
    !iso(start) ||
    !iso(end) ||
    Date.parse(start) >= Date.parse(end) ||
    Date.parse(end) - Date.parse(start) > 31 * 86_400_000
  )
    fail("invalid_fieldy_window");
  const token = credential(env, config.tokenEnv);
  const statePath = NodePath.join(spool.directory, "fieldy-cursor.json");
  let state = { version: 1, start, end, cursor: null, complete: false };
  if (!restart && NodeFS.existsSync(statePath)) {
    try {
      state = JSON.parse(readBounded(statePath, 8_192));
    } catch {
      fail("fieldy_cursor_invalid");
    }
    if (
      !record(state) ||
      state.version !== 1 ||
      typeof state.complete !== "boolean" ||
      !(state.cursor === null || (typeof state.cursor === "string" && state.cursor.length <= 2_048))
    )
      fail("fieldy_cursor_invalid");
    if (state.start !== start || state.end !== end) fail("fieldy_window_changed_use_restart");
  }
  if (state.complete)
    return {
      ...spool.status(),
      accepted: 0,
      duplicate: 0,
      skipped: 0,
      requests: 0,
      hasMore: false,
    };
  const query = new URLSearchParams({
    startTime: start,
    endTime: end,
    pageSize: String(config.maxItems),
    recordingSource: "wearable",
  });
  if (state.cursor) query.set("cursor", state.cursor);
  const page = await get(`${FIELDY_ORIGIN}/conversations?${query}`, token);
  if (
    !record(page) ||
    !Array.isArray(page.items) ||
    page.items.length > config.maxItems ||
    !(
      page.nextCursor == null ||
      (typeof page.nextCursor === "string" &&
        page.nextCursor.length > 0 &&
        page.nextCursor.length <= 2_048)
    )
  )
    fail("fieldy_invalid_response");
  if (page.nextCursor && page.nextCursor === state.cursor) fail("fieldy_cursor_did_not_advance");
  let accepted = 0;
  let duplicate = 0;
  let skipped = 0;
  let requests = 1;
  for (const item of page.items) {
    if (
      !record(item) ||
      typeof item.id !== "string" ||
      !item.id.trim() ||
      item.id.length > 256 ||
      /[\u0000-\u001f/\\]/.test(item.id) ||
      [".", ".."].includes(item.id)
    )
      fail("fieldy_invalid_response");
    if (item.locked === true) {
      skipped++;
      continue;
    }
    const detail = await get(
      `${FIELDY_ORIGIN}/conversations/${encodeURIComponent(item.id)}`,
      token,
    );
    requests++;
    const capture = fieldyCapture(detail, item);
    if (!capture) {
      skipped++;
      continue;
    }
    if (spool.enqueue(capture).duplicate) duplicate++;
    else accepted++;
  }
  durableWrite(
    statePath,
    JSON.stringify({
      version: 1,
      start,
      end,
      cursor: page.nextCursor ?? null,
      complete: !page.nextCursor,
    }),
  );
  return {
    ...spool.status(),
    accepted,
    duplicate,
    skipped,
    requests,
    hasMore: Boolean(page.nextCursor),
  };
}

export async function importHarness(
  spool,
  {
    spawn = NodeChildProcess.spawn,
    scheduleDeadline = (expire, ms) => {
      const timer = setTimeout(expire, ms);
      return () => clearTimeout(timer);
    },
  } = {},
) {
  const config = spool.config.harness;
  if (!config) fail("harness_not_configured");
  const stat = NodeFS.lstatSync(config.inputPath);
  if (
    stat.isSymbolicLink() ||
    (!stat.isFile() &&
      !(
        config.allowTty &&
        stat.isCharacterDevice() &&
        /^\/dev\/(?:tty[^/]*|cu\.[^/]+|pts\/\d+)$/.test(config.inputPath)
      ))
  )
    fail("harness_input_must_be_jsonl_file_or_explicit_tty");
  if (stat.isFile() && stat.size > 3_276_800) fail("harness_export_too_large");
  const cursorPath = NodePath.join(spool.directory, "harness-cursor.json");
  let cursor;
  if (stat.isFile()) {
    const identity = NodeCrypto.createHash("sha256")
      .update(readBounded(config.inputPath, 3_276_800))
      .digest("hex");
    cursor = { version: 1, inputPath: config.inputPath, identity, records: 0, complete: false };
    if (NodeFS.existsSync(cursorPath)) {
      let stored;
      try {
        stored = JSON.parse(readBounded(cursorPath, 8_192));
      } catch {
        fail("harness_cursor_invalid");
      }
      if (
        !record(stored) ||
        stored.version !== 1 ||
        typeof stored.complete !== "boolean" ||
        !Number.isSafeInteger(stored.records) ||
        stored.records < 0 ||
        stored.records > 1_000
      )
        fail("harness_cursor_invalid");
      if (stored.inputPath === config.inputPath && stored.identity === identity) cursor = stored;
    }
    if (cursor.complete)
      return { ...spool.status(), accepted: 0, duplicate: 0, reachedLimit: false, complete: true };
  }
  // A child owns a potentially blocking TTY read so the deadline can always close it.
  const child = spawn("/bin/cat", ["--", config.inputPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let exited;
  let launchFailed = false;
  let timedOut = false;
  const closed = new Promise((resolve) => {
    child.once("close", (code) => {
      exited = code;
      resolve();
    });
  });
  child.on("error", () => {
    launchFailed = true;
    child.stdout.destroy(new CompanionError("harness_reader_failed"));
  });
  child.stderr.resume();
  const cancelDeadline = scheduleDeadline(() => {
    timedOut = true;
    child.kill("SIGKILL");
    child.stdout.destroy(new CompanionError("harness_read_deadline"));
  }, config.readTimeoutMs);
  let accepted = 0;
  let duplicate = 0;
  let reachedLimit = false;
  let records = 0;
  try {
    for await (const capture of readCaptures(child.stdout)) {
      if (capture.source !== "harness") fail("harness_source_required");
      if (++records <= (cursor?.records ?? 0)) continue;
      if (spool.enqueue(capture).duplicate) duplicate++;
      else accepted++;
      if (cursor) {
        cursor = { ...cursor, records };
        durableWrite(cursorPath, JSON.stringify(cursor));
      }
      if (accepted + duplicate >= config.maxRecords) {
        reachedLimit = true;
        break;
      }
    }
    if (!reachedLimit) await closed;
    if (timedOut) fail("harness_read_deadline");
  } finally {
    cancelDeadline();
    if (exited === undefined) child.kill("SIGKILL");
    await closed;
  }
  if (launchFailed || (!reachedLimit && exited !== 0)) fail("harness_reader_failed");
  if (cursor && !reachedLimit) {
    cursor = { ...cursor, complete: true };
    durableWrite(cursorPath, JSON.stringify(cursor));
  }
  return {
    ...spool.status(),
    accepted,
    duplicate,
    reachedLimit,
    ...(cursor ? { complete: cursor.complete } : {}),
  };
}

import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { CompanionError, normalizeCapture } from "./companion.mjs";

// OpenHarness ce68e2fa cableFrame.ts / cable_client.c: v1 frames carry protocol-3 JSON.
export const MAX_PAYLOAD = 8_192;
const CARD_ID = "synthos-captures";
const STOP_ID = "synthos-stop";
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

export function crc16(bytes) {
  let crc = 0xffff;
  for (const value of bytes) {
    crc ^= value << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return crc;
}

export function encodeFrame(type, payload) {
  if (!Number.isInteger(type) || type < 0 || type > 255 || payload.length > MAX_PAYLOAD)
    throw new CompanionError("harness_invalid_frame");
  const frame = Buffer.alloc(payload.length + 8);
  frame.set([0xa5, 0x48, 1, type]);
  frame.writeUInt16LE(payload.length, 4);
  frame.set(payload, 6);
  frame.writeUInt16LE(crc16(frame.subarray(2, -2)), frame.length - 2);
  return frame;
}

export class FrameDecoder {
  buffer = Buffer.alloc(MAX_PAYLOAD + 8);
  length = 0;
  discarded = 0;
  corrupt = 0;
  remove(count, discarded = false) {
    if (discarded) this.discarded += count;
    this.buffer.copyWithin(0, count, this.length);
    this.length -= count;
  }
  feed(bytes, receive) {
    for (const byte of bytes) {
      if (this.length === this.buffer.length) this.remove(1, true);
      this.buffer[this.length++] = byte;
      while (this.length >= 6) {
        if (this.buffer[0] !== 0xa5 || this.buffer[1] !== 0x48) {
          this.remove(1, true);
          continue;
        }
        const size = this.buffer.readUInt16LE(4);
        if (size > MAX_PAYLOAD) {
          this.remove(1, true);
          continue;
        }
        if (this.length < size + 8) break;
        if (crc16(this.buffer.subarray(2, size + 6)) !== this.buffer.readUInt16LE(size + 6)) {
          this.corrupt++;
          this.remove(1, true);
          continue;
        }
        const frame = {
          version: this.buffer[2],
          type: this.buffer[3],
          payload: Buffer.from(this.buffer.subarray(6, size + 6)),
        };
        this.remove(size + 8);
        receive(frame);
      }
    }
  }
}

export function attachHarness(
  port,
  operations,
  {
    sessionTimeoutMs = 60_000,
    maxCaptures = 20,
    now = Date.now,
    uuid = NodeCrypto.randomUUID,
    timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  } = {},
) {
  const decoder = new FrameDecoder();
  const ready = Promise.withResolvers();
  const finished = Promise.withResolvers();
  let ended = false;
  let admitted = false;
  let identified = false;
  let deviceId;
  let pending = 0;
  let work = Promise.resolve();
  let lastReceived = now();
  let receivedBytes = 0;
  let captures = 0;
  let syncPending = false;
  let previousStatus;
  const seen = new Map();
  const handshake = timers.setTimeout(() => fail("harness_handshake_deadline"), 10_000);
  const lifetime = timers.setTimeout(() => {
    void close("session_limit");
  }, sessionTimeoutMs);
  const heartbeat = timers.setInterval(() => {
    if (!identified || ended) return;
    if (now() - lastReceived > 20_000) {
      fail("harness_silence_deadline");
      return;
    }
    schedule(() => send({ t: "ping" }));
  }, 5_000);
  const refresh = timers.setInterval(() => {
    if (!admitted || ended || syncPending) return;
    syncPending = true;
    schedule(async () => {
      try {
        await sync(false);
      } finally {
        syncPending = false;
      }
    });
  }, 1_000);

  async function close(reason = "closed") {
    if (ended) return finished.promise;
    ended = true;
    timers.clearTimeout(handshake);
    timers.clearTimeout(lifetime);
    timers.clearInterval(heartbeat);
    timers.clearInterval(refresh);
    port.off("data", receive);
    port.off("close", disconnected);
    if (!admitted) ready.reject(new CompanionError(reason));
    if (port.isOpen)
      await new Promise((resolve) => {
        const timer = timers.setTimeout(resolve, 2_000);
        try {
          port.close(() => {
            timers.clearTimeout(timer);
            resolve();
          });
        } catch {
          timers.clearTimeout(timer);
          resolve();
        }
      });
    finished.resolve({ connected: false, identified, captures, reason });
    return finished.promise;
  }
  function fail(code) {
    void close(code);
  }
  function schedule(action) {
    if (ended) return;
    if (pending >= 32) {
      fail("harness_work_limit");
      return;
    }
    pending++;
    work = work
      .then(async () => {
        if (!ended) await action();
      })
      .catch((error) =>
        fail(error instanceof CompanionError ? error.code : "harness_operation_failed"),
      )
      .finally(() => {
        pending--;
      });
  }
  function send(message) {
    if (ended) return Promise.resolve();
    const frame = encodeFrame(1, Buffer.from(JSON.stringify(message)));
    return new Promise((resolve, reject) => {
      const timer = timers.setTimeout(
        () => reject(new CompanionError("harness_write_deadline")),
        4_000,
      );
      try {
        port.write(frame, (error) => {
          timers.clearTimeout(timer);
          if (error) reject(new CompanionError("harness_write_failed"));
          else resolve();
        });
      } catch {
        timers.clearTimeout(timer);
        reject(new CompanionError("harness_write_failed"));
      }
    });
  }
  async function machines() {
    await send({ t: "machines.begin" });
    await send({ t: "machine", id: "synthos-local", name: "SynthOS", state: "ready", local: true });
    await send({ t: "machines.end", selected: "synthos-local", source: "local" });
  }
  function notice(text, agentId = CARD_ID) {
    return send({
      t: "summary",
      agentId,
      name: "SynthOS",
      machine: "SynthOS",
      recap: text.slice(0, 100),
      text: text.slice(0, 1_200),
    });
  }
  async function sync(force) {
    let status;
    try {
      status = await operations.status();
    } catch (error) {
      if (!(error instanceof CompanionError) || error.code !== "spool_locked") throw error;
      if (previousStatus !== "busy")
        await notice("Companion busy. Queue status unavailable. Stop still pauses forwarding.");
      previousStatus = "busy";
      return;
    }
    if (
      !status ||
      typeof status.stopped !== "boolean" ||
      !Number.isSafeInteger(status.queued) ||
      status.queued < 0 ||
      status.queued > 1_000
    )
      throw new CompanionError("harness_invalid_status");
    const next = JSON.stringify([status.stopped, status.queued]);
    if (!force && next === previousStatus) return;
    if (force) {
      await send({ t: "agents.begin" });
      for (const [id, name] of [
        [CARD_ID, "SynthOS captures"],
        [STOP_ID, "Stop forwarding"],
      ])
        await send({
          t: "agent",
          id,
          name,
          engine: "synthos",
          model: "",
          effort: "",
          machineId: "synthos-local",
          machine: "SynthOS",
        });
      await send({ t: "agents.end", total: 2, tab: "synthos" });
    }
    await notice(
      `Forwarding ${status.stopped ? "STOPPED" : "enabled"}. ${status.queued} captures saved for review. Voice is unavailable.`,
      CARD_ID,
    );
    await notice(
      "Confirm Stop to pause capture forwarding. Resume explicitly from the companion host.",
      STOP_ID,
    );
    previousStatus = next;
  }
  async function handle(message) {
    if (message.t === "hello") {
      if (
        message.product !== "harness" ||
        message.proto !== 3 ||
        typeof message.mac !== "string" ||
        !message.mac ||
        message.mac.length > 64 ||
        /[\u0000-\u001f]/.test(message.mac)
      )
        throw new CompanionError("harness_identity_refused");
      if (deviceId && deviceId !== message.mac)
        throw new CompanionError("harness_identity_changed");
      deviceId = message.mac;
      await send({
        t: "welcome",
        proto: 3,
        app: "SynthOS",
        machine: { id: "synthos-local", name: "SynthOS" },
        selected: "synthos-local",
        voiceLang: "en",
        features: [],
      });
      identified = true;
      timers.clearTimeout(handshake);
      await machines();
      await sync(true);
      if (!ended && !admitted) {
        admitted = true;
        ready.resolve({
          close,
          closed: finished.promise,
          drain: () => work,
          status: () => ({ connected: !ended, identified, captures }),
        });
      }
      return;
    }
    if (!admitted) return;
    if (message.t === "machines.list") {
      await machines();
      return;
    }
    if (message.t === "agents.list" || message.t === "agents.refresh") {
      await sync(true);
      return;
    }
    if (message.t === "voice.begin") {
      await send({
        t: "voice.error",
        ...(typeof message.uploadId === "string" && message.uploadId.length <= 64
          ? { uploadId: message.uploadId }
          : {}),
        message: "Voice transcription is unavailable. No audio is saved or uploaded.",
      });
      return;
    }
    if (message.t === "turn.stop") {
      await sync(false);
      return;
    }
    if (message.t !== "turn.send" || ![CARD_ID, STOP_ID].includes(message.agentId)) return;
    if (
      typeof message.text !== "string" ||
      !message.text.trim() ||
      message.text.length > 12_000 ||
      message.text.includes("\0")
    ) {
      await notice("Capture rejected. Supply nonempty text within the capture limit.");
      return;
    }
    const key = NodeCrypto.createHash("sha256")
      .update(JSON.stringify([deviceId, message.agentId, message.text]))
      .digest("hex");
    const capture =
      seen.get(key) ??
      normalizeCapture({
        source: "harness",
        sourceId: `harness-${uuid()}`,
        title: "Harness capture",
        content: message.text,
        capturedAt: new Date(now()).toISOString(),
      });
    let result;
    try {
      result = await operations.enqueue(capture);
    } catch (error) {
      if (!(error instanceof CompanionError) || error.code !== "spool_locked") throw error;
      await notice(
        "Companion busy. This capture was not saved. Retry after the host operation finishes.",
      );
      return;
    }
    if (!seen.has(key)) {
      if (seen.size >= 16) seen.delete(seen.keys().next().value);
      seen.set(key, capture);
      if (!result.duplicate) captures++;
    }
    await notice("Capture saved for review. Forward explicitly from the companion host.");
    await sync(false);
    if (captures >= maxCaptures) await close("capture_limit");
  }
  function receive(bytes) {
    if (ended) return;
    receivedBytes += bytes.length;
    if (receivedBytes > 1_048_576) {
      fail("harness_input_limit");
      return;
    }
    try {
      decoder.feed(bytes, (frame) => {
        if (ended) return;
        if (frame.version !== 1) {
          fail("harness_frame_version");
          return;
        }
        lastReceived = now();
        if (frame.type !== 1) return;
        let message;
        try {
          message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.payload));
        } catch {
          fail("harness_invalid_message");
          return;
        }
        if (
          !message ||
          typeof message !== "object" ||
          Array.isArray(message) ||
          typeof message.t !== "string"
        ) {
          fail("harness_invalid_message");
          return;
        }
        if (admitted && message.t === "turn.stop" && [CARD_ID, STOP_ID].includes(message.agentId))
          operations.stop();
        schedule(() => handle(message));
      });
      if (decoder.discarded > 65_536 || decoder.corrupt > 32) fail("harness_corrupt_input");
    } catch {
      fail("harness_invalid_frame");
    }
  }
  function disconnected() {
    fail("harness_disconnected");
  }
  port.on("data", receive);
  port.on("close", disconnected);
  port.on("error", () => fail("harness_transport_failed"));
  return ready.promise;
}

export async function openHarnessSerial(
  spool,
  {
    SerialPort,
    realpath = NodeFSP.realpath,
    stat = NodeFSP.stat,
    execute = execFile,
    attach = attachHarness,
  } = {},
) {
  const config = spool.config.harnessSerial;
  if (!config) throw new CompanionError("harness_serial_not_configured");
  const selected = await realpath(config.path);
  if (!selected.startsWith("/dev/") || !(await stat(selected)).isCharacterDevice())
    throw new CompanionError("harness_serial_path_refused");
  const Port = SerialPort ?? (await import("serialport")).SerialPort;
  const devices = await Port.list();
  const device = devices.find((item) => item.path === selected || item.path === config.path);
  if (
    !device ||
    Number.parseInt(device.vendorId ?? "", 16) !== 0x303a ||
    Number.parseInt(device.productId ?? "", 16) !== 0x1001
  )
    throw new CompanionError("harness_usb_identity_refused");
  try {
    const result = await execute("lsof", ["-t", "--", selected], {
      timeout: 3_000,
      maxBuffer: 8_192,
    });
    if (result.stdout.trim() || result.stderr.trim())
      throw new CompanionError("harness_port_owned");
  } catch (error) {
    if (error instanceof CompanionError) throw error;
    if (error.code !== 1 || error.stdout?.trim() || error.stderr?.trim())
      throw new CompanionError("harness_ownership_unverified");
  }
  await spool.exclusive(async () => {});
  const port = new Port({
    path: selected,
    baudRate: 115200,
    autoOpen: false,
    lock: true,
    highWaterMark: MAX_PAYLOAD + 8,
  });
  await new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      reject(new CompanionError("harness_open_deadline"));
    }, 5_000);
    try {
      port.open((error) => {
        clearTimeout(timer);
        if (expired) {
          if (port.isOpen) port.close(() => {});
          return;
        }
        if (error) reject(new CompanionError("harness_open_failed"));
        else resolve();
      });
    } catch {
      clearTimeout(timer);
      reject(new CompanionError("harness_open_failed"));
    }
  });
  return attach(
    port,
    {
      status: () => spool.exclusive(async () => spool.status()),
      enqueue: (capture) => spool.exclusive(async () => spool.enqueue(capture)),
      stop: () => spool.stop(),
    },
    config,
  );
}

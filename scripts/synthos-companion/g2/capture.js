import { connectEven, hasNativeTransport } from "./even.js";

const element = (id) => document.getElementById(id);
let pending;
let busy = false;
let even;

function message(text) {
  element("status").textContent = text;
}
function paired(value) {
  element("pair-form").hidden = value;
  element("capture-form").hidden = !value;
  element("controls").hidden = !value;
}

async function request(route, value) {
  const response = await fetch(`/api/g2/${route}`, {
    method: value === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: value === undefined ? {} : { "Content-Type": "application/json" },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    signal: AbortSignal.timeout(6_000),
  });
  if (!response.ok) {
    if (response.status === 401) paired(false);
    throw new Error(
      response.status === 503
        ? "Companion busy. Your thought is still here; retry when the host operation finishes."
        : response.status === 429
          ? "Connection limit reached. Wait before trying again."
          : "Request refused. Check the connection and companion setup.",
    );
  }
  return response.json();
}

async function refresh() {
  const status = await request("status");
  paired(true);
  message(`${status.queued} saved · Forwarding ${status.stopped ? "stopped" : "enabled"}.`);
  await even?.update(status);
}

async function safely(action) {
  if (busy) return;
  busy = true;
  for (const button of document.querySelectorAll("button")) button.disabled = true;
  try {
    await action();
  } catch (error) {
    message(error instanceof Error ? error.message : "Request failed. Your thought remains here.");
  } finally {
    busy = false;
    for (const button of document.querySelectorAll("button")) button.disabled = false;
  }
}

element("pair-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void safely(async () => {
    const token = element("pairing-token").value;
    element("pairing-token").value = "";
    await request("pair", { token });
    await refresh();
  });
});
element("capture-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void safely(async () => {
    const title = element("title").value.trim();
    const content = element("content").value.trim();
    if (!title || !content) throw new Error("Add a title and a thought first.");
    if (!pending || pending.title !== title || pending.content !== content)
      pending = {
        source: "g2",
        sourceId: crypto.randomUUID(),
        title,
        content,
        capturedAt: new Date().toISOString(),
      };
    const result = await request("capture", pending);
    if (result.sourceId !== pending.sourceId || result.executionAllowed !== false)
      throw new Error("The companion did not confirm this thought. Keep it here and retry.");
    pending = undefined;
    element("content").value = "";
    message("Saved for review. No task started.");
    try {
      await even?.update(result);
    } catch {
      message("Saved for review. The glasses display could not refresh.");
    }
  });
});
element("refresh").addEventListener("click", () => {
  void safely(refresh);
});
element("stop").addEventListener("click", () => {
  void safely(async () => {
    await request("stop", {});
    await refresh();
  });
});
element("signout").addEventListener("click", () => {
  void safely(async () => {
    await request("signout", {});
    paired(false);
    message("Phone disconnected.");
  });
});
void safely(refresh);

async function attachGlasses() {
  even?.dispose();
  even = undefined;
  if (!hasNativeTransport(window.flutter_inappwebview)) {
    element("bridge-status").textContent =
      "Browser preview · open in Even Hub for glasses controls.";
    return;
  }
  let sdk;
  try {
    sdk = await import("/even-sdk.js");
  } catch {
    element("bridge-status").textContent =
      "Glasses adapter unavailable. Build the local Even SDK bundle on the host.";
    return;
  }
  even = await connectEven({
    sdk,
    nativeHost: window.flutter_inappwebview,
    readStatus: () => request("status"),
    stop: () => request("stop", {}),
    onState: (state) => {
      element("bridge-status").textContent = state.closed
        ? "Even bridge closed. Reconnect to use glasses controls."
        : state.connected
          ? "Even SDK reports connected G2 glasses."
          : "Even phone bridge available · G2 glasses not connected.";
    },
    onError: (error) => message(error instanceof Error ? error.message : "Glasses control failed."),
  });
  await even.refresh();
}
element("connect-glasses").addEventListener("click", () => {
  void safely(attachGlasses);
});
window.addEventListener(
  "flutterInAppWebViewPlatformReady",
  () => {
    void safely(attachGlasses);
  },
  { once: true },
);
window.addEventListener("pagehide", () => even?.dispose(), { once: true });

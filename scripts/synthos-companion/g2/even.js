export function hasNativeTransport(host) {
  return host !== null && typeof host === "object" && typeof host.callHandler === "function";
}

export function eventAction(event) {
  // Protobuf omits CLICK=0 inside present envelopes; absent envelopes are not taps.
  const type = (envelope) => (envelope ? (envelope.eventType ?? 0) : null);
  const sys = type(event?.sysEvent);
  const text = type(event?.textEvent);
  if (sys === 3 || text === 3) return "exit";
  if (sys === 7 || sys === 6) return "closed";
  if (text === 1 || text === 2) return "scroll";
  if (sys === 0 || text === 0) return "tap";
  return null;
}

export async function connectEven({
  sdk,
  nativeHost,
  readStatus,
  stop,
  onState = () => {},
  onError = () => {},
  deadline = (reject) => {
    const timer = setTimeout(reject, 3_000);
    return () => clearTimeout(timer);
  },
}) {
  if (!hasNativeTransport(nativeHost))
    throw new Error("Browser preview. Open inside Even Hub to connect glasses.");
  async function bounded(operation) {
    let cancel;
    try {
      return await Promise.race([
        operation,
        new Promise((_, reject) => {
          cancel = deadline(() =>
            reject(new Error("Even phone did not answer. Reconnect from the phone.")),
          );
        }),
      ]);
    } finally {
      cancel?.();
    }
  }
  const bridge = await bounded(sdk.waitForEvenAppBridge());
  const info = await bounded(bridge.getDeviceInfo());
  let connected =
    info?.model === sdk.DeviceModel.G2 &&
    info?.status?.connectType === sdk.DeviceConnectType.Connected;
  let closed = false;
  let ready = false;
  let screen = "status";
  let status = null;
  let lastText = "";
  let pending = 0;
  let actions = Promise.resolve();
  let offEvents;
  let offStatus;
  const publish = () =>
    onState({
      bridgeAvailable: !closed,
      connected: !closed && connected,
      displayReady: !closed && ready,
      closed,
    });
  const text = () =>
    screen === "stop"
      ? "SYNTHOS / STOP FORWARDING\n\nTap to stop the local capture queue.\nResume only from the host.\n\nScroll: status / Double tap: exit"
      : `SYNTHOS / CAPTURES\n\n${status ? `Forwarding: ${status.stopped ? "STOPPED" : "ENABLED"}\nSaved for review: ${status.queued}` : "Status unavailable. Connect this phone."}\n\nTap: refresh / Scroll: STOP\nDouble tap: exit`;
  const setStatus = (value) => {
    if (
      !value ||
      typeof value.stopped !== "boolean" ||
      !Number.isSafeInteger(value.queued) ||
      value.queued < 0 ||
      value.queued > 1_000
    )
      throw new Error("Companion status was not recognized.");
    status = { stopped: value.stopped, queued: value.queued };
  };
  async function draw() {
    if (closed || !ready) return;
    const content = text();
    if (content === lastText) return;
    const accepted = await bounded(
      bridge.textContainerUpgrade(
        new sdk.TextContainerUpgrade({ containerID: 1, containerName: "synthos", content }),
      ),
    );
    if (!accepted) throw new Error("Glasses display update was refused.");
    lastText = content;
  }
  function dispose() {
    if (closed) return;
    closed = true;
    offEvents?.();
    offStatus?.();
    publish();
  }
  function queue(action) {
    if (closed) return Promise.resolve();
    if (pending >= 8) return Promise.reject(new Error("Glasses controls are busy. Try again."));
    pending++;
    const operation = actions.then(async () => {
      if (!closed) await action();
    });
    actions = operation
      .catch(() => {})
      .finally(() => {
        pending--;
      });
    return operation;
  }
  async function refresh() {
    try {
      setStatus(await readStatus());
    } catch (error) {
      status = null;
      await draw();
      throw error;
    }
    await draw();
  }
  function handleEvent(event) {
    const action = eventAction(event);
    if (!action) return Promise.resolve();
    if (action === "closed") {
      dispose();
      return Promise.resolve();
    }
    if (!ready || !connected) return Promise.resolve();
    return queue(async () => {
      if (action === "exit") {
        try {
          await bounded(bridge.shutDownPageContainer(1));
        } finally {
          dispose();
        }
      } else if (action === "scroll") {
        screen = screen === "status" ? "stop" : "status";
        await draw();
      } else if (screen === "stop") {
        await stop();
        screen = "status";
        await refresh();
      } else await refresh();
    });
  }
  try {
    offStatus = bridge.onDeviceStatusChanged((value) => {
      connected =
        info?.model === sdk.DeviceModel.G2 &&
        value?.connectType === sdk.DeviceConnectType.Connected;
      publish();
    });
    offEvents = bridge.onEvenHubEvent((event) => {
      void handleEvent(event).catch(onError);
    });
    publish();
    if (info?.model === sdk.DeviceModel.G2) {
      const created = await bounded(
        bridge.createStartUpPageContainer(
          new sdk.CreateStartUpPageContainer({
            containerTotalNum: 1,
            textObject: [
              new sdk.TextContainerProperty({
                xPosition: 0,
                yPosition: 0,
                width: 576,
                height: 288,
                paddingLength: 8,
                borderWidth: 0,
                containerID: 1,
                containerName: "synthos",
                content: text(),
                isEventCapture: 1,
              }),
            ],
          }),
        ),
      );
      if (created !== 0)
        throw new Error("Even phone refused the glance display. Phone capture remains available.");
      ready = true;
      lastText = text();
      publish();
    }
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    refresh: () => queue(refresh),
    update: (value) =>
      queue(async () => {
        setStatus(value);
        await draw();
      }),
    handleEvent,
    dispose,
  };
}

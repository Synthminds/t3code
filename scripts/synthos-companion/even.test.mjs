import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { connectEven, eventAction, hasNativeTransport } from "./g2/even.js";

function fixture(overrides = {}) {
  const calls = {
    ready: 0,
    info: 0,
    create: [],
    updates: [],
    shutdown: [],
    unsubscribed: 0,
    reads: 0,
    stops: 0,
  };
  const states = [];
  const listeners = {};
  function Payload(value) {
    Object.assign(this, value);
  }
  const bridge = {
    getDeviceInfo: async () => {
      calls.info++;
      return { model: "G2", status: { connectType: "connected" } };
    },
    createStartUpPageContainer: async (value) => {
      calls.create.push(value);
      return 0;
    },
    textContainerUpgrade: async (value) => {
      calls.updates.push(value);
      return true;
    },
    shutDownPageContainer: async (value) => {
      calls.shutdown.push(value);
      return true;
    },
    onDeviceStatusChanged: (handler) => {
      listeners.status = handler;
      return () => {
        calls.unsubscribed++;
        delete listeners.status;
      };
    },
    onEvenHubEvent: (handler) => {
      listeners.event = handler;
      return () => {
        calls.unsubscribed++;
        delete listeners.event;
      };
    },
    ...overrides,
  };
  const sdk = {
    waitForEvenAppBridge: async () => {
      calls.ready++;
      return bridge;
    },
    DeviceModel: { G2: "G2" },
    DeviceConnectType: { Connected: "connected" },
    TextContainerProperty: Payload,
    CreateStartUpPageContainer: Payload,
    TextContainerUpgrade: Payload,
  };
  const options = {
    sdk,
    nativeHost: { callHandler() {} },
    readStatus: async () => {
      calls.reads++;
      return { queued: 4, stopped: calls.stops > 0 };
    },
    stop: async () => {
      calls.stops++;
    },
    onState: (value) => states.push(value),
  };
  return { options, bridge, calls, states, listeners };
}

NodeTest.test(
  "Even requires a native host and an answered device query before reporting attachment",
  async () => {
    const f = fixture();
    NodeAssert.equal(hasNativeTransport({ ready: true }), false);
    await NodeAssert.rejects(
      connectEven({ ...f.options, nativeHost: undefined }),
      /Browser preview/,
    );
    NodeAssert.equal(f.calls.ready, 0);
    const answered = Promise.withResolvers();
    const queried = Promise.withResolvers();
    f.bridge.getDeviceInfo = () => {
      queried.resolve();
      return answered.promise;
    };
    const pending = connectEven(f.options);
    await queried.promise;
    NodeAssert.equal(f.states.length, 0);
    answered.resolve({ model: "G2", status: { connectType: "connected" } });
    const controller = await pending;
    NodeAssert.equal(f.states.at(-1).connected, true);
    NodeAssert.equal(f.states.at(-1).displayReady, true);
    NodeAssert.equal(f.calls.create[0].textObject[0].width, 576);
    NodeAssert.equal(f.calls.create[0].textObject[0].height, 288);
    controller.dispose();
  },
);

NodeTest.test(
  "Even displays actual queue status and maps scroll, tap STOP, disconnect, and exit",
  async () => {
    const f = fixture();
    const controller = await connectEven(f.options);
    await controller.refresh();
    NodeAssert.match(f.calls.updates.at(-1).content, /Saved for review: 4/);
    NodeAssert.match(f.calls.updates.at(-1).content, /ENABLED/);
    await controller.handleEvent({ textEvent: { eventType: 1 } });
    NodeAssert.match(f.calls.updates.at(-1).content, /STOP FORWARDING/);
    await controller.handleEvent({ textEvent: {} });
    NodeAssert.equal(f.calls.stops, 1);
    NodeAssert.match(f.calls.updates.at(-1).content, /STOPPED/);
    f.listeners.status({ connectType: "disconnected" });
    NodeAssert.equal(f.states.at(-1).connected, false);
    const reads = f.calls.reads;
    await controller.handleEvent({ sysEvent: {} });
    NodeAssert.equal(f.calls.reads, reads);
    f.listeners.status({ connectType: "connected" });
    await controller.handleEvent({ sysEvent: { eventType: 3 } });
    NodeAssert.deepEqual(f.calls.shutdown, [1]);
    NodeAssert.equal(f.calls.unsubscribed, 2);
    NodeAssert.equal(f.states.at(-1).closed, true);
    await controller.handleEvent({ sysEvent: {} });
    NodeAssert.equal(f.calls.stops, 1);
  },
);

NodeTest.test(
  "Even rejects other devices and failed displays without advertising connected glasses",
  async () => {
    const other = fixture({
      getDeviceInfo: async () => ({ model: "G1", status: { connectType: "connected" } }),
    });
    const controller = await connectEven(other.options);
    NodeAssert.equal(other.states.at(-1).connected, false);
    NodeAssert.equal(other.calls.create.length, 0);
    await controller.handleEvent({ textEvent: {} });
    NodeAssert.equal(other.calls.reads, 0);
    controller.dispose();
    const failed = fixture({ createStartUpPageContainer: async () => 1 });
    await NodeAssert.rejects(connectEven(failed.options), /refused the glance display/);
    NodeAssert.equal(failed.states.at(-1).connected, false);
    NodeAssert.equal(failed.calls.unsubscribed, 2);
  },
);

NodeTest.test(
  "Even handshake has an explicit deadline and no false attachment on timeout",
  async () => {
    const f = fixture();
    f.options.sdk.waitForEvenAppBridge = () => new Promise(() => {});
    let cancelled = 0;
    await NodeAssert.rejects(
      connectEven({
        ...f.options,
        deadline: (expire) => {
          queueMicrotask(expire);
          return () => {
            cancelled++;
          };
        },
      }),
      /did not answer/,
    );
    NodeAssert.equal(cancelled, 1);
    NodeAssert.equal(f.states.length, 0);
  },
);

NodeTest.test("Even bounds queued gestures and closing drops queued actions", async () => {
  const updating = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = fixture({
    textContainerUpgrade: () => {
      updating.resolve();
      return release.promise;
    },
  });
  const controller = await connectEven(f.options);
  const pending = Array.from({ length: 8 }, (_, queued) =>
    controller.update({ queued, stopped: false }),
  );
  await updating.promise;
  await NodeAssert.rejects(controller.update({ queued: 9, stopped: false }), /controls are busy/);
  await controller.handleEvent({ sysEvent: { eventType: 7 } });
  release.resolve(true);
  await Promise.all(pending);
  NodeAssert.equal(f.calls.unsubscribed, 2);
  NodeAssert.equal(f.states.at(-1).closed, true);
});

NodeTest.test("Even event envelopes preserve zero-valued clicks and give exit priority", () => {
  NodeAssert.equal(eventAction({}), null);
  NodeAssert.equal(eventAction({ textEvent: {} }), "tap");
  NodeAssert.equal(eventAction({ textEvent: { eventType: 2 } }), "scroll");
  NodeAssert.equal(eventAction({ sysEvent: {}, textEvent: { eventType: 3 } }), "exit");
  NodeAssert.equal(eventAction({ sysEvent: { eventType: 6 } }), "closed");
});

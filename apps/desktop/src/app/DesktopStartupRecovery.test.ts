import type { DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createInitialDesktopUpdateState } from "../updates/updateMachine.ts";
import { resolveStartupRecoveryOffer } from "./DesktopStartupRecovery.ts";

const updateState = (patch: Partial<DesktopUpdateState>): DesktopUpdateState => ({
  ...createInitialDesktopUpdateState(
    "0.1.3",
    { hostArch: "arm64", appArch: "arm64", runningUnderArm64Translation: false },
    "latest",
  ),
  enabled: true,
  ...patch,
});

describe("resolveStartupRecoveryOffer", () => {
  it("offers a newer version before going back", () => {
    expect(
      resolveStartupRecoveryOffer(
        updateState({ status: "available", availableVersion: "0.1.4" }),
        "0.1.2",
      ),
    ).toEqual({ _tag: "Update", version: "0.1.4" });
  });

  it("offers a retained download after a later check fails", () => {
    expect(
      resolveStartupRecoveryOffer(
        updateState({ status: "error", errorContext: "check", downloadedVersion: "0.1.4" }),
        null,
      ),
    ).toEqual({ _tag: "Update", version: "0.1.4" });
  });

  it("waits for the update check before offering to go back", () => {
    expect(resolveStartupRecoveryOffer(updateState({ status: "checking" }), "0.1.2")).toEqual({
      _tag: "Checking",
    });
  });

  it("offers the last version that started when no update exists", () => {
    expect(resolveStartupRecoveryOffer(updateState({ status: "up-to-date" }), "0.1.2")).toEqual({
      _tag: "Reinstall",
      version: "0.1.2",
    });
  });

  it("does not offer an update that already failed to apply here", () => {
    expect(
      resolveStartupRecoveryOffer(
        updateState({
          status: "downloaded",
          downloadedVersion: "0.1.4",
          notAppliedVersion: "0.1.4",
        }),
        "0.1.2",
      ),
    ).toEqual({ _tag: "Reinstall", version: "0.1.2" });
  });

  it("offers manual source recovery without an available local update", () => {
    expect(resolveStartupRecoveryOffer(updateState({ status: "disabled" }), "0.1.3")).toEqual({
      _tag: "Manual",
    });
    expect(resolveStartupRecoveryOffer(updateState({ status: "up-to-date" }), null)).toEqual({
      _tag: "Manual",
    });
  });

  it("ignores retained downloads and previous versions when updates are disabled", () => {
    expect(
      resolveStartupRecoveryOffer(
        updateState({ enabled: false, status: "downloaded", downloadedVersion: "0.1.4" }),
        "0.1.2",
      ),
    ).toEqual({ _tag: "Manual" });
  });
});

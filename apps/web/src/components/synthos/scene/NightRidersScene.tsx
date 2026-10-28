import { useEffect, useRef, useState } from "react";

export type NightRiderId = "lead" | "search" | "grep" | "docs";

export interface NightRiderVehicle {
  readonly id: NightRiderId;
  readonly active: boolean;
  readonly selected: boolean;
}

export interface NightRidersSceneProps {
  readonly vehicles: readonly NightRiderVehicle[];
  readonly moving: boolean;
  readonly paused: boolean;
  readonly camera: 0 | 1 | 2;
  readonly onSelect: (id: NightRiderId) => void;
}

type SceneState = Omit<NightRidersSceneProps, "onSelect">;
type SceneController = {
  update: (state: SceneState) => void;
  dispose: () => void;
};
type SceneModule = {
  mountNightRiders: (
    host: HTMLElement,
    state: SceneState,
    onSelect: (id: NightRiderId) => void,
    onAvailability: (available: boolean) => void,
  ) => SceneController;
};

export function NightRidersScene(props: NightRidersSceneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<SceneController | null>(null);
  const latestProps = useRef(props);
  const [unavailable, setUnavailable] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Synchronize observed work and controls with the imperative WebGL scene.
  useEffect(() => {
    latestProps.current = props;
    controllerRef.current?.update(props);
  }, [props]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Mount the local WebGL renderer and release its GPU resources on navigation.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    const moduleUrl = `${import.meta.env.BASE_URL}synthos/night-riders-engine.js`;
    void (import(/* @vite-ignore */ moduleUrl) as Promise<SceneModule>)
      .then(({ mountNightRiders }) => {
        if (disposed) return;
        controllerRef.current = mountNightRiders(
          host,
          latestProps.current,
          (id) => latestProps.current.onSelect(id),
          (available) => {
            if (!disposed) setUnavailable(!available);
          },
        );
      })
      .catch(() => {
        if (!disposed) setUnavailable(true);
      });
    return () => {
      disposed = true;
      controllerRef.current?.dispose();
      controllerRef.current = null;
    };
  }, []);

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <div ref={hostRef} style={{ position: "absolute", inset: 0 }} aria-hidden="true" />
      {unavailable && (
        <p
          role="status"
          style={{
            position: "absolute",
            left: "1rem",
            right: "1rem",
            top: "45%",
            padding: "1rem",
            background: "#080f24",
            color: "#e7f7f7",
            textAlign: "center",
          }}
        >
          The 3D highway is unavailable. Use the crew controls below to inspect every agent.
        </p>
      )}
    </div>
  );
}

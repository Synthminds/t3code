import { randomUUID } from "../../lib/utils";
import { useEffect, useState } from "react";
import {
  type EnvironmentId,
  type SynthosWorkflow,
  type SynthosCommandInput,
} from "@t3tools/contracts";
import { synthosRequest } from "./synthosRequest";

export function useSynthosWorkflows(environmentId: EnvironmentId | null) {
  const [data, setData] = useState<readonly SynthosWorkflow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const reload = () => {
    setLoading(true);
    setRefresh((value) => value + 1);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- synchronize the selected environment's durable workflow projections over HTTP
  useEffect(() => {
    if (!environmentId) return;
    const controller = new AbortController();
    let current = true;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      if (refresh > 0) setError(null);
      try {
        const result = await synthosRequest<{ workflows: readonly SynthosWorkflow[] }>(
          environmentId,
          "/api/synthos/workflows",
          { signal: controller.signal },
        );
        if (current) {
          setData(result.workflows);
          setError(null);
        }
      } catch (cause) {
        if (current)
          setError(
            cause instanceof Error
              ? cause.message
              : "Workflow service could not be reached. Retry after reconnecting.",
          );
      } finally {
        inFlight = false;
        if (current) setLoading(false);
      }
    };
    void load();
    const interval = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 10_000);
    return () => {
      current = false;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [environmentId, refresh]);

  const command = async (
    workflow: SynthosWorkflow,
    action: SynthosCommandInput["action"],
    reason?: string,
  ) => {
    if (!environmentId) throw new Error("Connect an environment first.");
    await synthosRequest(
      environmentId,
      `/api/synthos/workflows/${encodeURIComponent(workflow.id)}/commands`,
      {
        method: "POST",
        body: {
          commandId: randomUUID(),
          expectedRevision: workflow.revision,
          action,
          ...(reason ? { reason } : {}),
        },
      },
    );
    reload();
  };
  return {
    data: environmentId ? data : [],
    loading: environmentId !== null && loading,
    error,
    reload,
    command,
  };
}

export function useSynthosWorkflowDetail(
  environmentId: EnvironmentId | null,
  summary: SynthosWorkflow | undefined,
) {
  const [detail, setDetail] = useState<{ key: string; workflow: SynthosWorkflow } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const workflowId = summary?.id ?? null;
  const revision = summary?.revision ?? null;
  const key =
    environmentId && workflowId !== null && revision !== null
      ? `${environmentId}:${workflowId}:${revision}:${retry}`
      : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetch complete evidence for the selected durable workflow revision before enabling decisions
  useEffect(() => {
    if (!environmentId || !workflowId || key === null) return;
    const controller = new AbortController();
    void synthosRequest<{ workflow: SynthosWorkflow }>(
      environmentId,
      `/api/synthos/workflows/${encodeURIComponent(workflowId)}`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.workflow.revision !== revision || result.workflow.detailOmitted) {
          setFailure({
            key,
            message:
              "The workflow changed while evidence was loading. Refresh workflows to review its current revision.",
          });
          return;
        }
        setDetail({ key, workflow: result.workflow });
        setFailure(null);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setFailure({
            key,
            message:
              cause instanceof Error
                ? cause.message
                : "The complete evidence packet could not be loaded. Retry before making a decision.",
          });
      });
    return () => controller.abort();
  }, [environmentId, workflowId, revision, key]);

  const data = detail?.key === key && key !== null ? detail.workflow : undefined;
  const error = failure?.key === key ? failure?.message : null;
  return {
    data,
    ready: data !== undefined && !data.detailOmitted,
    loading: key !== null && data === undefined && !error,
    error,
    reload: () => setRetry((value) => value + 1),
  };
}

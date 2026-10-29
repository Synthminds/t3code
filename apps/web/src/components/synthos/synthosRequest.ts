import type { EnvironmentId } from "@t3tools/contracts";
import { createSynthosRequestCommand } from "@t3tools/client-runtime/state/synthos";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";

const request = createSynthosRequestCommand(connectionAtomRuntime);

export async function synthosRequest<T>(
  environmentId: EnvironmentId,
  path: string,
  init?: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal },
): Promise<T> {
  init?.signal?.throwIfAborted();
  const result = await request.run(appAtomRegistry, {
    environmentId,
    input: {
      path,
      method: init?.method ?? "GET",
      ...(init?.body === undefined ? {} : { body: init.body }),
    },
  });
  init?.signal?.throwIfAborted();
  if (result._tag !== "Success") throw squashAtomCommandFailure(result);
  return result.value as T;
}

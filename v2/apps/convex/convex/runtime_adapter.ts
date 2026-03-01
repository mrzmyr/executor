import {
  type RuntimeAdapter,
  type RuntimeExecuteError,
  type RuntimeExecuteInput,
} from "@executor-v2/engine";
import { makeLocalInProcessRuntimeAdapter } from "@executor-v2/runtime-local-inproc";

export type { RuntimeAdapter, RuntimeExecuteError, RuntimeExecuteInput };

export { makeLocalInProcessRuntimeAdapter };

import * as Effect from "effect/Effect";
import * as Either from "effect/Either";

import type {
  RuntimeAdapter,
  RuntimeExecuteError,
  RuntimeToolCallService,
} from "./runtime-adapters";
import { RuntimeAdapterError } from "./runtime-adapters";

export type RuntimeRunClientExecuteInput = {
  code: string;
  timeoutMs?: number;
};

export type RuntimeRunClientExecuteResult = {
  runId: string;
  status: "completed" | "failed" | "timed_out" | "denied";
  result?: unknown;
  error?: string;
  exitCode?: number;
  durationMs?: number;
};

export type RuntimeRunClient = {
  execute: (
    input: RuntimeRunClientExecuteInput,
  ) => Promise<RuntimeRunClientExecuteResult>;
};

export type InMemorySandboxTool = {
  description?: string | null;
  execute?: (...args: Array<any>) => Promise<any> | any;
};

export type InMemorySandboxToolMap = Record<string, InMemorySandboxTool>;

export type CreateRuntimeRunClientOptions = {
  runtimeAdapter: RuntimeAdapter;
  toolCallService?: RuntimeToolCallService;
  defaults?: {
    timeoutMs?: number;
  };
  makeRunId?: () => string;
};

export type CreateInMemoryRuntimeRunClientOptions = {
  runtimeAdapter: RuntimeAdapter;
  tools: InMemorySandboxToolMap;
  defaults?: {
    timeoutMs?: number;
  };
  makeRunId?: () => string;
};

const formatRuntimeExecuteError = (error: RuntimeExecuteError): string =>
  error.details ? `${error.message}: ${error.details}` : error.message;

const inMemoryToolCallService = (
  runtimeKind: string,
  tools: InMemorySandboxToolMap,
): RuntimeToolCallService => ({
  callTool: (input) => {
    const implementation = tools[input.toolPath];
    if (!implementation) {
      return new RuntimeAdapterError({
        operation: "call_tool",
        runtimeKind,
        message: `Unknown in-memory tool: ${input.toolPath}`,
        details: null,
      });
    }

    if (!implementation.execute) {
      return new RuntimeAdapterError({
        operation: "call_tool",
        runtimeKind,
        message: `In-memory tool '${input.toolPath}' has no execute function`,
        details: null,
      });
    }

    return Effect.tryPromise({
      try: () => implementation.execute!(input.input ?? {}, undefined),
      catch: (cause) =>
        new RuntimeAdapterError({
          operation: "call_tool",
          runtimeKind,
          message: `In-memory tool invocation failed: ${input.toolPath}`,
          details: String(cause),
        }),
    });
  },
});

export const createRuntimeRunClient = (
  options: CreateRuntimeRunClientOptions,
): RuntimeRunClient => {
  const runIdFactory = options.makeRunId ?? (() => `run_${crypto.randomUUID()}`);

  return {
    execute: async (
      input: RuntimeRunClientExecuteInput,
    ): Promise<RuntimeRunClientExecuteResult> => {
      const runId = runIdFactory();

      const availabilityResult = await Effect.runPromise(
        Effect.either(options.runtimeAdapter.isAvailable()),
      );

      if (Either.isLeft(availabilityResult)) {
        return {
          runId,
          status: "failed",
          error: "Runtime availability check failed",
        };
      }

      if (!availabilityResult.right) {
        return {
          runId,
          status: "failed",
          error: `Runtime '${options.runtimeAdapter.kind}' is not available`,
        };
      }

      const executionResult = await Effect.runPromise(
        Effect.either(
          options.runtimeAdapter.execute({
            runId,
            code: input.code,
            timeoutMs: input.timeoutMs ?? options.defaults?.timeoutMs,
            toolCallService: options.toolCallService,
          }),
        ),
      );

      if (Either.isLeft(executionResult)) {
        return {
          runId,
          status: "failed",
          error: formatRuntimeExecuteError(executionResult.left),
        };
      }

      return {
        runId,
        status: "completed",
        result: executionResult.right,
      };
    },
  };
};

export const createInMemoryRuntimeRunClient = (
  options: CreateInMemoryRuntimeRunClientOptions,
): RuntimeRunClient => {
  return createRuntimeRunClient({
    runtimeAdapter: options.runtimeAdapter,
    toolCallService: inMemoryToolCallService(options.runtimeAdapter.kind, options.tools),
    defaults: options.defaults,
    makeRunId: options.makeRunId,
  });
};

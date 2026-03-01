import {
  RuntimeAdapterError,
  RuntimeExecutionPortError,
  type ExecuteRuntimeRun,
  type ExecuteRuntimeRunInput,
  type RuntimeAdapterRegistry,
  type RuntimeExecuteError,
  type RuntimeToolCallService,
} from "@executor-v2/engine";
import {
  type RuntimeToolCallRequest,
  type RuntimeToolCallResult,
} from "@executor-v2/sdk";
import * as Effect from "effect/Effect";

export type PmRuntimeExecutionPortOptions = {
  defaultRuntimeKind: string;
  runtimeAdapters: RuntimeAdapterRegistry;
  handleToolCall: (
    input: RuntimeToolCallRequest,
  ) => Effect.Effect<RuntimeToolCallResult, never>;
};

const runtimeToolCallService = (
  options: PmRuntimeExecutionPortOptions,
): RuntimeToolCallService => ({
  callTool: (input) =>
    options.handleToolCall(input).pipe(
      Effect.flatMap((result) => {
        if (result.ok) {
          return Effect.succeed(result.value);
        }

        if (result.kind === "pending") {
          return Effect.fail(
            new RuntimeAdapterError({
              operation: "call_tool",
              runtimeKind: options.defaultRuntimeKind,
              message: `Tool call pending approval: ${input.toolPath}`,
              details: result.error ?? `approvalId=${result.approvalId}`,
            }),
          );
        }

        return Effect.fail(
          new RuntimeAdapterError({
            operation: "call_tool",
            runtimeKind: options.defaultRuntimeKind,
            message: `Tool call ${result.kind}: ${input.toolPath}`,
            details: result.error,
          }),
        );
      }),
    ),
});

export const createPmExecuteRuntimeRun = (
  options: PmRuntimeExecutionPortOptions,
): ExecuteRuntimeRun => {
  return (input: ExecuteRuntimeRunInput) =>
    Effect.gen(function* () {
      const runtimeAdapter = yield* options.runtimeAdapters
        .get(options.defaultRuntimeKind)
        .pipe(
          Effect.mapError(
            (error) =>
              new RuntimeExecutionPortError({
                operation: "resolve_runtime_adapter",
                message: error.message,
                details: null,
              }),
          ),
        );

      const isAvailable = yield* runtimeAdapter.isAvailable();
      if (!isAvailable) {
        return yield* new RuntimeExecutionPortError({
          operation: "runtime_available",
          message: `Runtime '${options.defaultRuntimeKind}' is not available in this pm process.`,
          details: null,
        });
      }

      return yield* runtimeAdapter
        .execute({
          runId: input.runId,
          code: input.code,
          timeoutMs: input.timeoutMs,
          toolCallService: runtimeToolCallService(options),
        })
        .pipe(
          Effect.mapError(
            (error: RuntimeExecuteError) =>
              new RuntimeExecutionPortError({
                operation: "runtime_execute",
                message: error.message,
                details: error.details,
              }),
          ),
        );
    });
};

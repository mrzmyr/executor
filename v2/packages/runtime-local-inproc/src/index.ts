import * as Effect from "effect/Effect";
import * as Runtime from "effect/Runtime";

import {
  RuntimeAdapterError,
  type RuntimeAdapter,
  type RuntimeToolCallService,
} from "@executor-v2/engine";

const runtimeKind = "local-inproc";

export type ExecuteJavaScriptInput = {
  runId: string;
  code: string;
  toolCallService?: RuntimeToolCallService;
};

const runtimeError = (
  operation: string,
  message: string,
  details: string | null,
): RuntimeAdapterError =>
  new RuntimeAdapterError({
    operation,
    runtimeKind,
    message,
    details,
  });

const missingToolCallServiceError = (toolPath: string): RuntimeAdapterError =>
  runtimeError(
    "call_tool",
    `No tool call service configured for tool path: ${toolPath}`,
    null,
  );

const toExecutionError = (cause: unknown): RuntimeAdapterError =>
  cause instanceof RuntimeAdapterError
    ? cause
    : runtimeError(
        "execute",
        "JavaScript execution failed",
        cause instanceof Error ? cause.stack ?? cause.message : String(cause),
      );

const normalizeToolInput = (args: unknown): Record<string, unknown> | undefined => {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }

  return args as Record<string, unknown>;
};

const invokeTool = (
  runId: string,
  toolPath: string,
  args: unknown,
  toolCallService: RuntimeToolCallService | undefined,
): Effect.Effect<unknown, RuntimeAdapterError> =>
  Effect.gen(function* () {
    if (!toolCallService) {
      return yield* missingToolCallServiceError(toolPath);
    }

    return yield* toolCallService.callTool({
      runId,
      callId: `call_${crypto.randomUUID()}`,
      toolPath,
      input: normalizeToolInput(args),
    });
  });

const createToolsProxy = (
  runId: string,
  runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
  toolCallService: RuntimeToolCallService | undefined,
  path: ReadonlyArray<string> = [],
): unknown => {
  const callable = () => undefined;

  return new Proxy(callable, {
    get(_target, prop) {
      if (prop === "then") {
        return undefined;
      }

      if (typeof prop !== "string") {
        return undefined;
      }

      return createToolsProxy(runId, runPromise, toolCallService, [...path, prop]);
    },
    apply(_target, _thisArg, args) {
      const toolPath = path.join(".");
      if (!toolPath) {
        throw new Error("Tool path missing in invocation");
      }

      const toolArgs = args.length > 0 ? args[0] : undefined;
      return runPromise(invokeTool(runId, toolPath, toolArgs, toolCallService));
    },
  });
};

const runJavaScript = (
  code: string,
  tools: unknown,
): Effect.Effect<unknown, RuntimeAdapterError> =>
  Effect.tryPromise({
    try: async () => {
      const execute = new Function(
        "tools",
        `"use strict"; return (async () => {\n${code}\n})();`,
      ) as (tools: unknown) => Promise<unknown>;

      return await execute(tools);
    },
    catch: toExecutionError,
  });

export const executeJavaScriptWithTools = (
  input: ExecuteJavaScriptInput,
): Effect.Effect<unknown, RuntimeAdapterError> =>
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>();
    const runPromise = Runtime.runPromise(runtime);
    const toolsProxy = createToolsProxy(
      input.runId,
      runPromise,
      input.toolCallService,
    );

    return yield* runJavaScript(input.code, toolsProxy);
  });

export const makeLocalInProcessRuntimeAdapter = (): RuntimeAdapter => ({
  kind: runtimeKind,
  isAvailable: () => Effect.succeed(true),
  execute: (input) =>
    executeJavaScriptWithTools({
      runId: input.runId,
      code: input.code,
      toolCallService: input.toolCallService,
    }),
});

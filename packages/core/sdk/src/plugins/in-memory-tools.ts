import { Effect, JSONSchema, Schema } from "effect";

import type { SecretId } from "../ids";
import { ToolId } from "../ids";
import { ToolInvocationError } from "../errors";
import type { Secret } from "../secrets";
import {
  ToolInvocationResult,
  type ToolRegistration,
  type InvokeOptions,
} from "../tools";
import {
  ElicitationDeclinedError,
  type ElicitationRequest,
} from "../elicitation";
import { definePlugin, type PluginContext } from "../plugin";
import { hoistDefinitions } from "../schema-refs";

// ---------------------------------------------------------------------------
// In-memory tool definition — typed via Schema
// ---------------------------------------------------------------------------

export interface MemoryToolDefinition<
  TInput = unknown,
  TOutput = unknown,
> {
  readonly name: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly inputSchema: Schema.Schema<TInput>;
  readonly outputSchema?: Schema.Schema<TOutput>;
  readonly handler: MemoryToolHandler<TInput>;
}

export type MemoryToolHandler<TInput> =
  | ((args: TInput) => unknown)
  | ((
      args: TInput,
      ctx: MemoryToolContext,
    ) => Effect.Effect<unknown, unknown>);

export interface MemoryToolContext {
  /** Request input from the user. Returns user data or fails if declined. */
  readonly elicit: (
    request: ElicitationRequest,
  ) => Effect.Effect<Record<string, unknown>, ElicitationDeclinedError>;

  /** Access to the SDK services */
  readonly sdk: MemoryToolSdkAccess;
}

/** SDK services available to in-memory tool handlers */
export interface MemoryToolSdkAccess {
  readonly secrets: {
    readonly list: () => Effect.Effect<readonly Secret[]>;
    readonly resolve: (secretId: SecretId) => Effect.Effect<string, unknown>;
    readonly store: (input: {
      readonly name: string;
      readonly value: string;
      readonly purpose?: string;
    }) => Effect.Effect<Secret>;
    readonly remove: (secretId: SecretId) => Effect.Effect<boolean, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Plugin extension
// ---------------------------------------------------------------------------

export interface InMemoryToolsPluginExtension {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly addTools: (
    tools: readonly MemoryToolDefinition<any, any>[],
  ) => Effect.Effect<void>;
}

// ---------------------------------------------------------------------------
// Registration builder
// ---------------------------------------------------------------------------

const toRegistrationWithDefs = (
  namespace: string,
  def: MemoryToolDefinition,
  pluginCtx: PluginContext,
): { registration: ToolRegistration; definitions: Record<string, unknown> } => {
  const id = ToolId.make(`${namespace}.${def.name}`);
  const decode = Schema.decodeUnknownSync(def.inputSchema);
  const isEffectHandler = def.handler.length >= 2;

  // Convert to JSON Schema and hoist definitions
  const inputJson = JSONSchema.make(def.inputSchema);
  const outputJson = def.outputSchema ? JSONSchema.make(def.outputSchema) : undefined;

  const inputHoist = hoistDefinitions(inputJson);
  const outputHoist = hoistDefinitions(outputJson);

  // Merge all definitions
  const allDefs: Record<string, unknown> = {
    ...inputHoist.defs,
    ...outputHoist.defs,
  };

  const registration: ToolRegistration = {
    id,
    name: def.name,
    description: def.description,
    tags: def.tags ? [...def.tags] : undefined,
    inputSchema: inputHoist.stripped,
    outputSchema: outputHoist.stripped,
    mayElicit: isEffectHandler,
    invoke: (args, options?: InvokeOptions) => {
      const parsed = Effect.try({
        try: () => decode(args),
        catch: (err) =>
          new ToolInvocationError({
            toolId: id,
            message: `Invalid input: ${err instanceof Error ? err.message : String(err)}`,
            cause: err,
          }),
      });

      if (!isEffectHandler) {
        return parsed.pipe(
          Effect.flatMap((input) =>
            Effect.try({
              try: () =>
                new ToolInvocationResult({
                  data: (def.handler as (args: unknown) => unknown)(input),
                  error: null,
                }),
              catch: (err) =>
                new ToolInvocationError({
                  toolId: id,
                  message:
                    err instanceof Error ? err.message : String(err),
                  cause: err,
                }),
            }),
          ),
        );
      }

      // Effect handler — build context with elicit + sdk access
      const ctx: MemoryToolContext = {
        sdk: {
          secrets: {
            list: () => pluginCtx.secrets.list(pluginCtx.scope.id),
            resolve: (secretId) => pluginCtx.secrets.resolve(secretId),
            store: (input) =>
              pluginCtx.secrets.store({
                ...input,
                scopeId: pluginCtx.scope.id,
              }),
            remove: (secretId) => pluginCtx.secrets.remove(secretId),
          },
        },
        elicit: (request) =>
          Effect.gen(function* () {
            const handler = options?.onElicitation;
            if (!handler) {
              return yield* new ElicitationDeclinedError({
                toolId: id,
                action: "decline",
              });
            }
            const response = yield* handler({
              toolId: id,
              args,
              request,
            });
            if (response.action !== "accept") {
              return yield* new ElicitationDeclinedError({
                toolId: id,
                action: response.action as "decline" | "cancel",
              });
            }
            return response.content ?? {};
          }),
      };

      const effectHandler = def.handler as (
        args: unknown,
        ctx: MemoryToolContext,
      ) => Effect.Effect<unknown, unknown>;

      return parsed.pipe(
        Effect.flatMap((input) => effectHandler(input, ctx)),
        Effect.map(
          (data) => new ToolInvocationResult({ data, error: null }),
        ),
        Effect.catchAll(
          (err): Effect.Effect<
            ToolInvocationResult,
            ToolInvocationError | ElicitationDeclinedError
          > => {
            if (
              err != null &&
              typeof err === "object" &&
              "_tag" in err &&
              (err as { _tag: string })._tag === "ElicitationDeclinedError"
            ) {
              return Effect.fail(err as ElicitationDeclinedError);
            }
            return Effect.fail(
              new ToolInvocationError({
                toolId: id,
                message:
                  err instanceof Error ? err.message : String(err),
                cause: err,
              }),
            );
          },
        ),
      );
    },
  };

  return { registration, definitions: allDefs };
};

// ---------------------------------------------------------------------------
// Tool definition helper — infers TInput from the schema
// ---------------------------------------------------------------------------

export function tool<TInput, TOutput>(
  def: MemoryToolDefinition<TInput, TOutput>,
): MemoryToolDefinition<TInput, TOutput> {
  return def;
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const inMemoryToolsPlugin = (config: {
  readonly namespace?: string;
  readonly tools: readonly MemoryToolDefinition<any, any>[];
}) => {
  const ns = config.namespace ?? "memory";
  return definePlugin<"inMemoryTools", InMemoryToolsPluginExtension>({
    key: "inMemoryTools",
    init: (ctx: PluginContext) =>
      Effect.gen(function* () {
        const results = config.tools.map((t) => toRegistrationWithDefs(ns, t, ctx));
        
        // Register all definitions first
        const allDefs: Record<string, unknown> = {};
        for (const { definitions } of results) {
          Object.assign(allDefs, definitions);
        }
        yield* ctx.tools.registerDefinitions(allDefs);

        // Then register tools with stripped schemas
        const registrations = results.map(({ registration }) => registration);
        yield* ctx.tools.register(registrations);

        return {
          extension: {
            addTools: (newTools: readonly MemoryToolDefinition<any, any>[]) =>
              Effect.gen(function* () {
                const newResults = newTools.map((t) => toRegistrationWithDefs(ns, t, ctx));
                
                const newDefs: Record<string, unknown> = {};
                for (const { definitions } of newResults) {
                  Object.assign(newDefs, definitions);
                }
                yield* ctx.tools.registerDefinitions(newDefs);

                const newRegistrations = newResults.map(({ registration }) => registration);
                yield* ctx.tools.register(newRegistrations);
              }),
          },
          close: () =>
            ctx.tools.unregister(registrations.map((r) => r.id)),
        };
      }),
  });
};

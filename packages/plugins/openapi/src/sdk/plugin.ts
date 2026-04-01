import { Effect, Option } from "effect";
import { FetchHttpClient, HttpClient } from "@effect/platform";
import type { Layer } from "effect";

import {
  Source,
  definePlugin,
  type ExecutorPlugin,
  type PluginContext,
  ToolId,
  type ToolRegistration,
} from "@executor/sdk";

import { parse } from "./parse";
import { extract } from "./extract";
import { makeOpenApiInvoker } from "./invoke";
import { resolveBaseUrl } from "./openapi-utils";
import {
  makeInMemoryOperationStore,
  type OpenApiOperationStore,
} from "./operation-store";
import { previewSpec, type SpecPreview } from "./preview";
import {
  type ExtractedOperation,
  InvocationConfig,
  OperationBinding,
} from "./types";

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

/** A header value — either a static string or a reference to a secret */
export type HeaderValue = string | { readonly secretId: string; readonly prefix?: string };

export interface OpenApiSpecConfig {
  readonly spec: string;
  readonly baseUrl?: string;
  readonly namespace?: string;
  /** Headers applied to every request. Values can reference secrets. */
  readonly headers?: Record<string, HeaderValue>;
}

// ---------------------------------------------------------------------------
// Plugin extension
// ---------------------------------------------------------------------------

export interface OpenApiPluginExtension {
  /** Preview a spec without registering — returns metadata, auth strategies, header presets */
  readonly previewSpec: (
    specText: string,
  ) => Effect.Effect<SpecPreview, Error>;

  /** Add an OpenAPI spec and register its operations as tools */
  readonly addSpec: (
    config: OpenApiSpecConfig,
  ) => Effect.Effect<{ readonly toolCount: number }, Error>;

  /** Remove all tools from a previously added spec by namespace */
  readonly removeSpec: (namespace: string) => Effect.Effect<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const operationDescription = (op: ExtractedOperation): string =>
  Option.getOrElse(op.description, () =>
    Option.getOrElse(op.summary, () =>
      `${op.method.toUpperCase()} ${op.pathTemplate}`,
    ),
  );

const toRegistration = (
  op: ExtractedOperation,
  namespace: string,
): ToolRegistration => ({
  id: ToolId.make(`${namespace}.${op.operationId}`),
  pluginKey: "openapi",
  sourceId: namespace,
  name: op.operationId as string,
  description: operationDescription(op),
  inputSchema: Option.getOrUndefined(op.inputSchema),
  outputSchema: Option.getOrUndefined(op.outputSchema),
});

const toBinding = (op: ExtractedOperation): OperationBinding =>
  new OperationBinding({
    method: op.method,
    pathTemplate: op.pathTemplate,
    parameters: [...op.parameters],
    requestBody: op.requestBody,
  });

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export const openApiPlugin = (options?: {
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly operationStore?: OpenApiOperationStore;
}): ExecutorPlugin<"openapi", OpenApiPluginExtension> => {
  const httpClientLayer = options?.httpClientLayer ?? FetchHttpClient.layer;
  const operationStore = options?.operationStore ?? makeInMemoryOperationStore();

  // Track added sources so we can list them
  const addedSources = new Map<string, Source>();

  return definePlugin({
    key: "openapi",
    init: (ctx: PluginContext) =>
      Effect.gen(function* () {
        yield* ctx.tools.registerInvoker(
          "openapi",
          makeOpenApiInvoker({
            operationStore,
            httpClientLayer,
            secrets: ctx.secrets,
            scopeId: ctx.scope.id,
          }),
        );

        // Register source manager so the core can list/remove/refresh our sources
        yield* ctx.sources.addManager({
          kind: "openapi",

          list: () =>
            Effect.sync(() => [...addedSources.values()]),

          remove: (sourceId: string) =>
            Effect.gen(function* () {
              // Clean up operation store
              yield* operationStore.removeByNamespace(sourceId);
              // Remove tools from registry
              yield* ctx.tools.unregisterBySource(sourceId);
              // Remove from our tracking
              addedSources.delete(sourceId);
            }),

          // TODO: refresh requires storing original config per namespace
        });

        return {
          extension: {
            previewSpec: (specText: string) => previewSpec(specText),

            addSpec: (config: OpenApiSpecConfig) =>
              Effect.gen(function* () {
                const doc = yield* parse(config.spec);
                const result = yield* extract(doc);

                const namespace =
                  config.namespace ??
                  Option.getOrElse(result.title, () => "api")
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "_");

                if (doc.components?.schemas) {
                  yield* ctx.tools.registerDefinitions(doc.components.schemas);
                }

                const baseUrl = config.baseUrl ?? resolveBaseUrl(result.servers);
                const invocationConfig = new InvocationConfig({
                  baseUrl,
                  headers: config.headers ?? {},
                });

                const registrations = result.operations.map((op) =>
                  toRegistration(op, namespace),
                );

                yield* Effect.forEach(
                  result.operations,
                  (op) =>
                    operationStore.put(
                      ToolId.make(`${namespace}.${op.operationId}`),
                      namespace,
                      toBinding(op),
                      invocationConfig,
                    ),
                  { discard: true },
                );

                yield* ctx.tools.register(registrations);

                // Track the source
                const sourceName = Option.getOrElse(result.title, () => namespace);
                addedSources.set(namespace, new Source({
                  id: namespace,
                  name: sourceName,
                  kind: "openapi",
                }));

                return { toolCount: registrations.length };
              }),

            removeSpec: (namespace: string) =>
              Effect.gen(function* () {
                const toolIds = yield* operationStore.removeByNamespace(namespace);
                if (toolIds.length > 0) {
                  yield* ctx.tools.unregister(toolIds);
                }
                addedSources.delete(namespace);
              }),
          },

          close: () =>
            Effect.gen(function* () {
              for (const sourceId of addedSources.keys()) {
                yield* ctx.tools.unregisterBySource(sourceId);
              }
              addedSources.clear();
            }),
        };
      }),
  });
};

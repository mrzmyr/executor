import * as Effect from "effect/Effect";

import type { SourceCatalogSyncResult } from "@executor/source-core";
import type {
  SourceCatalogKind,
} from "@executor/source-core";
import type { ExecutorEffect } from "./executor-effect";
import type { ExecutorScopeContext } from "./scope";
import {
  type LocalConfigSource,
  type LocalExecutorConfig,
  type Source as ExecutorSource,
} from "./schema";
import type {
  SourceInvokeInput,
  SourceInvokeResult,
} from "@executor/source-core";
import type * as Schema from "effect/Schema";
import { runtimeEffectError } from "./runtime/effect-errors";
import { ScopeConfigStore } from "./runtime/scope/storage";

export type PluginCleanup = {
  close: () => void | Promise<void>;
};

export type ExecutorSdkPluginHost = ExecutorSourcePluginInternalHost;

export type ExecutorSdkPluginContext = {
  executor: ExecutorEffect & Record<string, unknown>;
  scope: ExecutorScopeContext;
  host: ExecutorSdkPluginHost;
};

export type ExecutorSdkPluginStartContext<
  TExtension extends object = {},
> = ExecutorSdkPluginContext & {
  extension: TExtension;
};

type ExecutorSdkPluginInternals = {
  sources?: readonly ExecutorSourceContribution<any>[];
  managementTools?: readonly ExecutorManagementToolContribution<any, any>[];
};

const executorSdkPluginInternalsSymbol = Symbol.for(
  "@executor/platform-sdk/plugins/internals",
);

type ExecutorSdkPluginInternalCarrier = {
  [executorSdkPluginInternalsSymbol]?: ExecutorSdkPluginInternals;
};

export type ExecutorSdkPlugin<
  TKey extends string = string,
  TExtension extends object = {},
> = {
  key: TKey;
  extendExecutor?: (input: ExecutorSdkPluginContext) => TExtension;
  start?: (
    input: ExecutorSdkPluginStartContext<TExtension>,
  ) => Effect.Effect<PluginCleanup | void, Error, any>;
} & ExecutorSdkPluginInternalCarrier;

export const defineExecutorSdkPlugin = <
  const TPlugin extends ExecutorSdkPlugin<any, any>,
>(
  plugin: TPlugin,
): TPlugin => plugin;

type ExecutorSourcePluginInternalHost = {
  sources: {
    create: (input: {
      source: Omit<
        ExecutorSource,
        "id" | "scopeId" | "createdAt" | "updatedAt"
      >;
    }) => Effect.Effect<ExecutorSource, Error, any>;
    get: (sourceId: ExecutorSource["id"]) => Effect.Effect<ExecutorSource, Error, any>;
    save: (source: ExecutorSource) => Effect.Effect<ExecutorSource, Error, any>;
    refreshCatalog: (
      sourceId: ExecutorSource["id"],
    ) => Effect.Effect<ExecutorSource, Error, any>;
    remove: (sourceId: ExecutorSource["id"]) => Effect.Effect<boolean, Error, any>;
  };
};

export type ExecutorSourcePluginStorage<TStored> = {
  get: (input: {
    scopeId: ExecutorSource["scopeId"];
    sourceId: ExecutorSource["id"];
  }) => Effect.Effect<TStored | null, Error, any>;
  put: (input: {
    scopeId: ExecutorSource["scopeId"];
    sourceId: ExecutorSource["id"];
    value: TStored;
  }) => Effect.Effect<void, Error, any>;
  remove?: (input: {
    scopeId: ExecutorSource["scopeId"];
    sourceId: ExecutorSource["id"];
  }) => Effect.Effect<void, Error, any>;
};

export type ExecutorSourcePluginApi<
  TConnectInput,
  TSourceConfig,
  TUpdateInput extends {
    sourceId: string;
    config: TSourceConfig;
  },
> = {
  getSource: (
    sourceId: ExecutorSource["id"],
  ) => Effect.Effect<ExecutorSource, Error, any>;
  getSourceConfig: (
    sourceId: ExecutorSource["id"],
  ) => Effect.Effect<TSourceConfig, Error, any>;
  createSource: (
    input: TConnectInput,
  ) => Effect.Effect<ExecutorSource, Error, any>;
  updateSource: (
    input: TUpdateInput,
  ) => Effect.Effect<ExecutorSource, Error, any>;
  refreshSource: (
    sourceId: ExecutorSource["id"],
  ) => Effect.Effect<ExecutorSource, Error, any>;
  removeSource: (
    sourceId: ExecutorSource["id"],
  ) => Effect.Effect<boolean, Error, any>;
};

export type ExecutorManagementToolContribution<
  TInput = unknown,
  TOutput = unknown,
> = {
  path: `executor.${string}`;
  description: string;
  inputSchema: Schema.Schema<TInput, any, never>;
  outputSchema: Schema.Schema<TOutput, any, never>;
  execute: (input: {
    args: TInput;
    host: ExecutorSdkPluginHost;
  }) => Effect.Effect<TOutput, Error, any>;
};

export type ExecutorSourcePluginManagementToolDefinition<
  TName extends string = string,
  TInput = unknown,
  TOutput = unknown,
  TConnectInput = unknown,
  TSourceConfig = unknown,
  TUpdateInput extends {
    sourceId: string;
    config: TSourceConfig;
  } = {
    sourceId: string;
    config: TSourceConfig;
  },
> = {
  name: TName;
  description: string;
  inputSchema: Schema.Schema<TInput, any, never>;
  outputSchema: Schema.Schema<TOutput, any, never>;
  execute: (input: {
    args: TInput;
    source: ExecutorSourcePluginApi<TConnectInput, TSourceConfig, TUpdateInput>;
    host: ExecutorSourcePluginInternalHost;
  }) => Effect.Effect<TOutput, Error, any>;
};

export type ExecutorSourcePluginDefinition<
  TAddInput,
  TConnectInput,
  TSourceConfig,
  TStored,
  _TUpdateInput extends {
    sourceId: string;
    config: TSourceConfig;
  },
> = {
  kind: string;
  displayName: string;
  add: {
    inputSchema: Schema.Schema<TAddInput, any, never>;
    inputSignatureWidth?: number;
    helpText?: readonly string[];
    toConnectInput: (input: TAddInput) => TConnectInput;
  };
  storage: ExecutorSourcePluginStorage<TStored>;
  source: {
    create: (input: TConnectInput) => {
      source: Omit<
        ExecutorSource,
        "id" | "scopeId" | "createdAt" | "updatedAt"
      >;
      stored: TStored;
    };
    update: (input: {
      source: ExecutorSource;
      config: TSourceConfig;
    }) => {
      source: ExecutorSource;
      stored: TStored;
    };
    toConfig: (input: {
      source: ExecutorSource;
      stored: TStored;
    }) => TSourceConfig;
    remove?: (input: {
      source: ExecutorSource;
      stored: TStored | null;
    }) => Effect.Effect<void, Error, any>;
  };
  localConfig?: {
    toConfigSource: (input: {
      source: ExecutorSource;
      stored: TStored;
    }) => LocalConfigSource;
    recoverStored: (input: {
      source: ExecutorSource;
      config: LocalConfigSource;
      loadedConfig: LocalExecutorConfig | null;
    }) => Effect.Effect<TStored, Error, any> | TStored;
  };
  catalog: {
    kind: SourceCatalogKind;
    identity?: (input: {
      source: ExecutorSource;
    }) => Record<string, unknown>;
    sync: (input: {
      source: ExecutorSource;
      stored: TStored | null;
    }) => Effect.Effect<SourceCatalogSyncResult, Error, any>;
    invoke: (
      input: SourceInvokeInput & {
        source: ExecutorSource;
        stored: TStored | null;
      },
    ) => Effect.Effect<SourceInvokeResult, Error, any>;
  };
};

export type ExecutorSourcePluginInput<
  TKey extends string = string,
  TAddInput = unknown,
  TConnectInput = unknown,
  TSourceConfig = unknown,
  TStored = unknown,
  TUpdateInput extends {
    sourceId: string;
    config: TSourceConfig;
  } = {
    sourceId: string;
    config: TSourceConfig;
  },
  TExtension extends object = {},
> = {
  key: TKey;
  source: ExecutorSourcePluginDefinition<
    TAddInput,
    TConnectInput,
    TSourceConfig,
    TStored,
    TUpdateInput
  >;
  tools?: readonly ExecutorSourcePluginManagementToolDefinition<
    string,
    any,
    any,
    TConnectInput,
    TSourceConfig,
    TUpdateInput
  >[];
  extendExecutor?: (input: ExecutorSdkPluginContext & {
    source: ExecutorSourcePluginApi<TConnectInput, TSourceConfig, TUpdateInput>;
  }) => TExtension;
  start?: (
    input: ExecutorSdkPluginStartContext<TExtension> & {
      source: ExecutorSourcePluginApi<
        TConnectInput,
        TSourceConfig,
        TUpdateInput
      >;
    },
  ) => Effect.Effect<PluginCleanup | void, Error, any>;
};

const loadSourceOfKind = (
  sourceId: ExecutorSource["id"],
  input: {
    definition: ExecutorSourcePluginDefinition<any, any, any, any, any>;
    host: ExecutorSourcePluginInternalHost;
  },
): Effect.Effect<ExecutorSource, Error, any> =>
  Effect.gen(function* () {
    const source = yield* input.host.sources.get(sourceId);
    if (source.kind !== input.definition.kind) {
      return yield* runtimeEffectError(
        "plugins",
        `Source ${sourceId} is not a ${input.definition.displayName} source.`,
      );
    }

    return source;
  });

const cloneJson = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;

const fromMaybeEffect = <A>(
  value: Effect.Effect<A, Error, any> | A,
): Effect.Effect<A, Error, any> =>
  Effect.isEffect(value)
    ? value
    : Effect.succeed(value);

const persistSourceLocalConfig = <
  TAddInput,
  TConnectInput,
  TSourceConfig,
  TStored,
  TUpdateInput extends {
    sourceId: string;
    config: TSourceConfig;
  },
>(
  definition: ExecutorSourcePluginDefinition<
    TAddInput,
    TConnectInput,
    TSourceConfig,
    TStored,
    TUpdateInput
  >,
  input: {
    source: ExecutorSource;
    stored: TStored;
  },
): Effect.Effect<void, Error, ScopeConfigStore> =>
  definition.localConfig
    ? Effect.gen(function* () {
        const localConfig = definition.localConfig!;
        const scopeConfigStore = yield* ScopeConfigStore;
        const loadedConfig = yield* scopeConfigStore.load();
        const projectConfig = cloneJson(loadedConfig.projectConfig ?? {});
        const sources = {
          ...projectConfig.sources,
          [input.source.id]: localConfig.toConfigSource({
            source: input.source,
            stored: input.stored,
          }),
        };

        yield* scopeConfigStore.writeProject({
          config: {
            ...projectConfig,
            sources,
          },
        });
      })
    : Effect.void;

const loadStoredOrRecover = <
  TAddInput,
  TConnectInput,
  TSourceConfig,
  TStored,
  TUpdateInput extends {
    sourceId: string;
    config: TSourceConfig;
  },
>(
  definition: ExecutorSourcePluginDefinition<
    TAddInput,
    TConnectInput,
    TSourceConfig,
    TStored,
    TUpdateInput
  >,
  source: ExecutorSource,
): Effect.Effect<TStored | null, Error, ScopeConfigStore> =>
  Effect.gen(function* () {
    const localConfig = definition.localConfig;
    const stored = yield* definition.storage.get({
      scopeId: source.scopeId,
      sourceId: source.id,
    });
    if (stored !== null || localConfig === undefined) {
      return stored;
    }

    const scopeConfigStore = yield* ScopeConfigStore;
    const loadedConfig = yield* scopeConfigStore.load();
    const config = loadedConfig.config?.sources?.[source.id] ?? null;
    if (config === null) {
      return null;
    }

    if (config.kind !== definition.kind) {
      return yield* runtimeEffectError(
        "plugins",
        `Source ${source.id} config kind ${config.kind} does not match ${definition.kind}.`,
      );
    }

    const recovered = yield* fromMaybeEffect(
      localConfig.recoverStored({
        source,
        config,
        loadedConfig: loadedConfig.config,
      }),
    );

    yield* definition.storage.put({
      scopeId: source.scopeId,
      sourceId: source.id,
      value: recovered,
    });

    return recovered;
  });

const createExecutorSourcePluginApi = <
  TAddInput,
  TConnectInput,
  TSourceConfig,
  TStored,
  _TUpdateInput extends {
    sourceId: string;
    config: TSourceConfig;
  },
>(
  definition: ExecutorSourcePluginDefinition<
    TAddInput,
    TConnectInput,
    TSourceConfig,
    TStored,
    _TUpdateInput
  >,
  host: ExecutorSourcePluginInternalHost,
): ExecutorSourcePluginApi<TConnectInput, TSourceConfig, _TUpdateInput> => ({
  getSource: (sourceId) =>
    loadSourceOfKind(sourceId, {
      definition,
      host,
    }),
  getSourceConfig: (sourceId) =>
    Effect.gen(function* () {
      const source = yield* loadSourceOfKind(sourceId, {
        definition,
        host,
      });
      const stored = yield* loadStoredOrRecover(definition, source);
      if (stored === null) {
        return yield* runtimeEffectError(
          "plugins",
          `${definition.displayName} source storage missing for ${source.id}`,
        );
      }

      return definition.source.toConfig({
        source,
        stored,
      });
    }),
  createSource: (input) =>
    Effect.gen(function* () {
      const created = definition.source.create(input);
      const source = yield* host.sources.create({
        source: created.source,
      });

      yield* definition.storage.put({
        scopeId: source.scopeId,
        sourceId: source.id,
        value: created.stored,
      });
      yield* persistSourceLocalConfig(definition, {
        source,
        stored: created.stored,
      });

      return yield* host.sources.refreshCatalog(source.id);
    }),
  updateSource: (input) =>
    Effect.gen(function* () {
      const source = yield* loadSourceOfKind(input.sourceId as ExecutorSource["id"], {
        definition,
        host,
      });
      const updated = definition.source.update({
        source,
        config: input.config,
      });
      const saved = yield* host.sources.save(updated.source);

      yield* definition.storage.put({
        scopeId: saved.scopeId,
        sourceId: saved.id,
        value: updated.stored,
      });
      yield* persistSourceLocalConfig(definition, {
        source: saved,
        stored: updated.stored,
      });

      return yield* host.sources.refreshCatalog(saved.id);
    }),
  refreshSource: (sourceId) =>
    Effect.gen(function* () {
      const source = yield* loadSourceOfKind(sourceId, {
        definition,
        host,
      });

      return yield* host.sources.refreshCatalog(source.id);
    }),
  removeSource: (sourceId) =>
    Effect.gen(function* () {
      const source = yield* loadSourceOfKind(sourceId, {
        definition,
        host,
      });
      const stored = yield* definition.storage.get({
        scopeId: source.scopeId,
        sourceId: source.id,
      });

      if (definition.source.remove) {
        yield* definition.source.remove({
          source,
          stored,
        });
      }

      if (definition.storage.remove) {
        yield* definition.storage.remove({
          scopeId: source.scopeId,
          sourceId: source.id,
        });
      }

      return yield* host.sources.remove(source.id);
    }),
});

type ExecutorSourceContribution<TInput = unknown> = {
  pluginKey: string;
  kind: string;
  displayName: string;
  inputSchema: Schema.Schema<TInput, any, never>;
  inputSignatureWidth?: number;
  helpText?: readonly string[];
  catalogKind: SourceCatalogKind;
  catalogIdentity?: (input: {
    source: ExecutorSource;
  }) => Record<string, unknown>;
  createSource: (input: {
    args: TInput;
    host: ExecutorSourcePluginInternalHost;
  }) => Effect.Effect<ExecutorSource, Error, any>;
  syncCatalog: (input: {
    source: ExecutorSource;
  }) => Effect.Effect<SourceCatalogSyncResult, Error, any>;
  invoke: (
    input: SourceInvokeInput & {
      source: ExecutorSource;
    },
  ) => Effect.Effect<SourceInvokeResult, Error, any>;
};

export type ExecutorSdkPluginRegistry = {
  plugins: readonly ExecutorSdkPlugin<any, any>[];
  sources: readonly ExecutorSourceContribution<any>[];
  managementTools: readonly ExecutorManagementToolContribution<any, any>[];
  getSourceContribution: (kind: string) => ExecutorSourceContribution<any>;
  getSourceContributionForSource: (
    source: Pick<ExecutorSource, "kind">,
  ) => ExecutorSourceContribution<any>;
  getManagementTool: (
    path: string,
  ) => ExecutorManagementToolContribution<any, any>;
};

const createExecutorSourceContribution = <
  TKey extends string,
  TAddInput,
  TConnectInput,
  TSourceConfig,
  TStored,
  TUpdateInput extends {
    sourceId: string;
    config: TSourceConfig;
  },
>(
  input: {
    key: TKey;
    source: ExecutorSourcePluginDefinition<
      TAddInput,
      TConnectInput,
      TSourceConfig,
      TStored,
      TUpdateInput
    >;
  },
): ExecutorSourceContribution<TAddInput> => ({
  pluginKey: input.key,
  kind: input.source.kind,
  displayName: input.source.displayName,
  inputSchema: input.source.add.inputSchema,
  inputSignatureWidth: input.source.add.inputSignatureWidth,
  helpText: input.source.add.helpText,
  catalogKind: input.source.catalog.kind,
  catalogIdentity: input.source.catalog.identity,
  createSource: ({ args, host }) =>
    createExecutorSourcePluginApi(input.source, host).createSource(
      input.source.add.toConnectInput(args),
    ),
  syncCatalog: ({ source }) =>
    Effect.flatMap(
      loadStoredOrRecover(input.source, source),
      (stored) =>
        input.source.catalog.sync({
          source,
          stored,
        }),
    ),
  invoke: (invokeInput) =>
    Effect.flatMap(
      loadStoredOrRecover(input.source, invokeInput.source),
      (stored) =>
        input.source.catalog.invoke({
          ...invokeInput,
          stored,
        }),
    ),
});

const createExecutorSourceManagementToolContribution = <
  TKey extends string,
  TName extends string,
  TInput,
  TOutput,
  TConnectInput,
  TSourceConfig,
  TStored,
  TUpdateInput extends {
    sourceId: string;
    config: TSourceConfig;
  },
>(
  input: {
    key: TKey;
    source: ExecutorSourcePluginDefinition<
      any,
      TConnectInput,
      TSourceConfig,
      TStored,
      TUpdateInput
    >;
    tool: ExecutorSourcePluginManagementToolDefinition<
      TName,
      TInput,
      TOutput,
      TConnectInput,
      TSourceConfig,
      TUpdateInput
    >;
  },
): ExecutorManagementToolContribution<TInput, TOutput> => ({
  path: `executor.${input.key}.${input.tool.name}`,
  description: input.tool.description,
  inputSchema: input.tool.inputSchema,
  outputSchema: input.tool.outputSchema,
  execute: ({ args, host }) =>
    input.tool.execute({
      args,
      host: host as ExecutorSourcePluginInternalHost,
      source: createExecutorSourcePluginApi(
        input.source,
        host as ExecutorSourcePluginInternalHost,
      ),
    }),
});

export const defineExecutorSourcePlugin = <
  const TKey extends string,
  TAddInput,
  TConnectInput,
  TSourceConfig,
  TStored,
  TUpdateInput extends {
    sourceId: string;
    config: TSourceConfig;
  },
  TExtension extends object = {},
>(
  input: ExecutorSourcePluginInput<
    TKey,
    TAddInput,
    TConnectInput,
    TSourceConfig,
    TStored,
    TUpdateInput,
    TExtension
  >,
): ExecutorSdkPlugin<TKey, TExtension> =>
  ((extendExecutor, start) =>
    defineExecutorSdkPlugin({
      key: input.key,
      extendExecutor: extendExecutor
        ? (pluginInput) =>
            extendExecutor({
              ...pluginInput,
              source: createExecutorSourcePluginApi(
                input.source,
                pluginInput.host as ExecutorSourcePluginInternalHost,
              ),
            })
        : undefined,
      start: start
        ? (pluginInput) =>
            start({
              ...pluginInput,
              source: createExecutorSourcePluginApi(
                input.source,
                pluginInput.host as ExecutorSourcePluginInternalHost,
              ),
            })
        : undefined,
      [executorSdkPluginInternalsSymbol]: {
        sources: [createExecutorSourceContribution({
          key: input.key,
          source: input.source,
        })],
        managementTools: (input.tools ?? []).map((tool) =>
          createExecutorSourceManagementToolContribution({
            key: input.key,
            source: input.source,
            tool,
          })
        ),
      },
    }))(input.extendExecutor, input.start);

export type ExecutorSdkPluginExtensions<
  TPlugins extends readonly ExecutorSdkPlugin<any, any>[],
> = {
  [TPlugin in TPlugins[number] as TPlugin["key"]]:
    TPlugin extends ExecutorSdkPlugin<any, infer TExtension>
      ? TExtension
      : never;
};

export const registerExecutorSdkPlugins = (
  plugins: readonly ExecutorSdkPlugin<any, any>[],
) => {
  const pluginKeys = new Set<string>();
  const sources = new Map<string, ExecutorSourceContribution<any>>();
  const managementTools = new Map<
    string,
    ExecutorManagementToolContribution<any, any>
  >();

  for (const plugin of plugins) {
    if (pluginKeys.has(plugin.key)) {
      throw new Error(`Duplicate executor SDK plugin registration: ${plugin.key}`);
    }

    pluginKeys.add(plugin.key);

    const internals = plugin[executorSdkPluginInternalsSymbol];

    for (const source of internals?.sources ?? []) {
      if (sources.has(source.kind)) {
        throw new Error(
          `Duplicate source registration: ${source.kind}`,
        );
      }

      sources.set(source.kind, source);
    }

    for (const tool of internals?.managementTools ?? []) {
      if (managementTools.has(tool.path)) {
        throw new Error(`Duplicate executor management tool: ${tool.path}`);
      }

      managementTools.set(tool.path, tool);
    }
  }

  const getSourceContribution = (kind: string) => {
    const definition = sources.get(kind);
    if (!definition) {
      throw new Error(`Unsupported source kind: ${kind}`);
    }

    return definition;
  };

  const getSourceContributionForSource = (source: Pick<ExecutorSource, "kind">) =>
    getSourceContribution(source.kind);

  const getManagementTool = (path: string) => {
    const tool = managementTools.get(path);
    if (!tool) {
      throw new Error(`Unsupported executor management tool: ${path}`);
    }

    return tool;
  };

  return {
    plugins,
    sources: [...sources.values()],
    managementTools: [...managementTools.values()],
    getSourceContribution,
    getSourceContributionForSource,
    getManagementTool,
  } satisfies ExecutorSdkPluginRegistry;
};

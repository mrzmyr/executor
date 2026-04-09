import { Context, Effect } from "effect";

import {
  createExecutor as createEffectExecutor,
  ElicitationResponse as ElicitationResponseClass,
  makeInMemoryToolRegistry,
  makeInMemorySecretStore,
  makeInMemoryPolicyEngine,
  makeInMemorySourceRegistry,
  ScopeId,
  type ToolRegistry as CoreToolRegistry,
  type SourceRegistry as CoreSourceRegistry,
  type SecretStore as CoreSecretStore,
  type PolicyEngine as CorePolicyEngine,
  type ExecutorConfig as EffectExecutorConfig,
  type ExecutorPlugin,
  type PluginContext as EffectPluginContext,
  type ElicitationContext,
  type InvokeOptions as EffectInvokeOptions,
  type ToolInvocationResult,
  type ToolMetadata,
  type ToolAnnotations,
  type ToolSchema,
  type ToolInvoker as EffectToolInvoker,
  type RuntimeToolHandler as EffectRuntimeToolHandler,
  type Source,
  type SourceDetectionResult,
  type SourceManager as EffectSourceManager,
  type Policy,
  type SecretRef,
  type SecretProvider as EffectSecretProvider,
  type SetSecretInput,
  type Scope,
  type ToolId,
  type SecretId,
  type ScopeId as ScopeIdType,
  type PolicyId,
  type ToolNotFoundError,
  type ToolInvocationError,
  type SecretNotFoundError,
  type SecretResolutionError,
  type PolicyDeniedError,
  type ElicitationDeclinedError,
} from "./index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect as Effect.Effect<A, never>);

const fromPromise = <A>(fn: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({ try: fn, catch: (e) => (e instanceof Error ? e : new Error(String(e))) });

/**
 * Wrap a promise-returning function as an Effect whose error channel is
 * `never`. Unexpected rejections become unhandled defects. Used by the store
 * adapters where the Effect-layer service interface forbids a typed error
 * channel.
 */
const fromPromiseDying = <A>(fn: () => Promise<A>): Effect.Effect<A, never> =>
  Effect.orDie(fromPromise(fn));

// ---------------------------------------------------------------------------
// Type derivation — derive Promise-based SDK types from core Effect types
// ---------------------------------------------------------------------------

/** Replace branded IDs with plain strings in parameter types */
type UnbrandParam<T> =
  T extends ToolId ? string :
  T extends SecretId ? string :
  T extends ScopeIdType ? string :
  T extends PolicyId ? string :
  T extends readonly (infer U)[] ? readonly UnbrandParam<U>[] :
  T;

/** Convert an Effect service interface to Promise-based, unbranding ID params */
type PromisifyService<T> = {
  readonly [K in keyof T]: NonNullable<T[K]> extends (...args: infer A) => Effect.Effect<infer R, infer _E>
    ? (...args: { [I in keyof A]: UnbrandParam<A[I]> }) => Promise<R>
    : T[K];
};

type CoreToolRegistryService = Context.Tag.Service<typeof CoreToolRegistry>;
type CoreSourceRegistryService = Context.Tag.Service<typeof CoreSourceRegistry>;
type CoreSecretStoreService = Context.Tag.Service<typeof CoreSecretStore>;
type CorePolicyEngineService = Context.Tag.Service<typeof CorePolicyEngine>;

// ---------------------------------------------------------------------------
// Elicitation
// ---------------------------------------------------------------------------

export interface ElicitationResponse {
  readonly action: "accept" | "decline" | "cancel";
  readonly content?: Record<string, unknown>;
}

export type ElicitationHandler = (
  ctx: ElicitationContext,
) => Promise<ElicitationResponse>;

export interface InvokeOptions {
  readonly onElicitation: ElicitationHandler | "accept-all";
}

const toEffectElicitationHandler = (handler: ElicitationHandler) =>
  (ctx: ElicitationContext) =>
    Effect.tryPromise({
      try: () => handler(ctx),
      catch: (e) => e as Error,
    }).pipe(
      Effect.map(
        (r) =>
          new ElicitationResponseClass({
            action: r.action,
            content: r.content,
          }),
      ),
      Effect.catchAll((e) => Effect.die(e)),
    );

const toEffectInvokeOptions = (options: InvokeOptions): EffectInvokeOptions => ({
  onElicitation:
    options.onElicitation === "accept-all"
      ? ("accept-all" as const)
      : toEffectElicitationHandler(options.onElicitation),
});

// ---------------------------------------------------------------------------
// Plugin callback types
// ---------------------------------------------------------------------------

export interface ToolInvoker {
  readonly invoke: (toolId: string, args: unknown, options: InvokeOptions) => Promise<ToolInvocationResult>;
  readonly resolveAnnotations?: (toolId: string) => Promise<ToolAnnotations | undefined>;
}

export interface RuntimeToolHandler {
  readonly invoke: (args: unknown, options: InvokeOptions) => Promise<ToolInvocationResult>;
  readonly resolveAnnotations?: () => Promise<ToolAnnotations | undefined>;
}

export type SourceManager = PromisifyService<EffectSourceManager>;

export type SecretProvider = PromisifyService<EffectSecretProvider>;

// --- Adapters ---

const effectToPromiseInvokeOptions = (options?: EffectInvokeOptions): InvokeOptions => {
  if (!options || options.onElicitation === "accept-all") return { onElicitation: "accept-all" };
  const handler = options.onElicitation;
  return {
    onElicitation: async (ctx) => {
      const r = await run(handler(ctx));
      return { action: r.action, content: r.content ?? undefined };
    },
  };
};

const toEffectInvoker = (invoker: ToolInvoker): EffectToolInvoker => ({
  invoke: (toolId, args, options) =>
    fromPromise(() => invoker.invoke(toolId, args, effectToPromiseInvokeOptions(options))) as Effect.Effect<ToolInvocationResult, any>,
  resolveAnnotations: invoker.resolveAnnotations
    ? (toolId) => fromPromise(() => invoker.resolveAnnotations!(toolId)) as Effect.Effect<ToolAnnotations | undefined>
    : undefined,
});

const toEffectRuntimeHandler = (handler: RuntimeToolHandler): EffectRuntimeToolHandler => ({
  invoke: (args, options) =>
    fromPromise(() => handler.invoke(args, effectToPromiseInvokeOptions(options))) as Effect.Effect<ToolInvocationResult, any>,
  resolveAnnotations: handler.resolveAnnotations
    ? () => fromPromise(() => handler.resolveAnnotations!()) as Effect.Effect<ToolAnnotations | undefined>
    : undefined,
});

const toEffectSourceManager = (manager: SourceManager): EffectSourceManager => ({
  kind: manager.kind,
  list: () => fromPromise(() => manager.list()) as Effect.Effect<readonly Source[]>,
  remove: (sourceId) => fromPromise(() => manager.remove(sourceId)) as Effect.Effect<void>,
  refresh: manager.refresh ? (sourceId) => fromPromise(() => manager.refresh!(sourceId)) as Effect.Effect<void> : undefined,
  detect: manager.detect ? (url) => fromPromise(() => manager.detect!(url)) as Effect.Effect<SourceDetectionResult | null> : undefined,
});

const toEffectSecretProvider = (provider: SecretProvider): EffectSecretProvider => ({
  key: provider.key,
  writable: provider.writable,
  get: (key) => fromPromise(() => provider.get(key)) as Effect.Effect<string | null>,
  set: provider.set ? (key, value) => fromPromise(() => provider.set!(key, value)) as Effect.Effect<void> : undefined,
  delete: provider.delete ? (key) => fromPromise(() => provider.delete!(key)) as Effect.Effect<boolean> : undefined,
  list: provider.list ? () => fromPromise(() => provider.list!()) as Effect.Effect<readonly { id: string; name: string }[]> : undefined,
});

// --- Reverse adapters (Effect -> Promise) for callbacks handed to user stores ---
//
// When the Effect core hands us an Effect-shaped ToolInvoker / ToolHandler /
// SourceManager / SecretProvider (e.g. from a plugin), we need to convert it
// into the promise-shaped equivalent before passing it to a user-supplied
// promise-based store implementation.

const toPromiseInvoker = (invoker: EffectToolInvoker): ToolInvoker => ({
  invoke: (toolId, args, options) =>
    run(invoker.invoke(toolId as ToolId, args, toEffectInvokeOptions(options))) as Promise<ToolInvocationResult>,
  resolveAnnotations: invoker.resolveAnnotations
    ? (toolId) => run(invoker.resolveAnnotations!(toolId as ToolId))
    : undefined,
});

const toPromiseRuntimeHandler = (handler: EffectRuntimeToolHandler): RuntimeToolHandler => ({
  invoke: (args, options) =>
    run(handler.invoke(args, toEffectInvokeOptions(options))) as Promise<ToolInvocationResult>,
  resolveAnnotations: handler.resolveAnnotations
    ? () => run(handler.resolveAnnotations!())
    : undefined,
});

const toPromiseSourceManager = (manager: EffectSourceManager): SourceManager => ({
  kind: manager.kind,
  list: () => run(manager.list()),
  remove: (sourceId) => run(manager.remove(sourceId)),
  refresh: manager.refresh ? (sourceId) => run(manager.refresh!(sourceId)) : undefined,
  detect: manager.detect ? (url) => run(manager.detect!(url)) : undefined,
});

const toPromiseSecretProvider = (provider: EffectSecretProvider): SecretProvider => ({
  key: provider.key,
  writable: provider.writable,
  get: (key) => run(provider.get(key)),
  set: provider.set ? (key, value) => run(provider.set!(key, value)) : undefined,
  delete: provider.delete ? (key) => run(provider.delete!(key)) : undefined,
  list: provider.list ? () => run(provider.list!()) : undefined,
});

// --- Main store adapters (Promise -> Effect) ---
//
// Users implementing a pluggable store (e.g. a Postgres-backed tool registry)
// write against the promise-shaped ToolRegistry / SourceRegistry / SecretStore
// / PolicyEngine interfaces declared below. These adapters wrap the user impl
// so the Effect core layer sees a native Effect service.

const toEffectToolRegistry = (r: ToolRegistry): CoreToolRegistryService => ({
  list: (filter) => fromPromiseDying(() => r.list(filter)),
  schema: (toolId) =>
    fromPromise(() => r.schema(toolId)) as Effect.Effect<ToolSchema, ToolNotFoundError>,
  definitions: () => fromPromiseDying(() => r.definitions()),
  registerDefinitions: (defs) => fromPromiseDying(() => r.registerDefinitions(defs)),
  registerRuntimeDefinitions: (defs) =>
    fromPromiseDying(() => r.registerRuntimeDefinitions(defs)),
  unregisterRuntimeDefinitions: (names) =>
    fromPromiseDying(() => r.unregisterRuntimeDefinitions(names)),
  registerInvoker: (pluginKey, effectInvoker) =>
    fromPromiseDying(() => r.registerInvoker(pluginKey, toPromiseInvoker(effectInvoker))),
  resolveAnnotations: (toolId) =>
    fromPromiseDying(() => r.resolveAnnotations(toolId)),
  invoke: (toolId, args, options) =>
    fromPromise(() =>
      r.invoke(toolId, args, effectToPromiseInvokeOptions(options)),
    ) as Effect.Effect<
      ToolInvocationResult,
      ToolNotFoundError | ToolInvocationError | ElicitationDeclinedError
    >,
  register: (tools) => fromPromiseDying(() => r.register(tools)),
  registerRuntime: (tools) => fromPromiseDying(() => r.registerRuntime(tools)),
  registerRuntimeHandler: (toolId, effectHandler) =>
    fromPromiseDying(() =>
      r.registerRuntimeHandler(toolId, toPromiseRuntimeHandler(effectHandler)),
    ),
  unregisterRuntime: (toolIds) => fromPromiseDying(() => r.unregisterRuntime(toolIds)),
  unregister: (toolIds) => fromPromiseDying(() => r.unregister(toolIds)),
  unregisterBySource: (sourceId) => fromPromiseDying(() => r.unregisterBySource(sourceId)),
});

const toEffectSourceRegistry = (r: SourceRegistry): CoreSourceRegistryService => ({
  addManager: (manager) =>
    fromPromiseDying(() => r.addManager(toPromiseSourceManager(manager))),
  registerRuntime: (source) => fromPromiseDying(() => r.registerRuntime(source)),
  unregisterRuntime: (sourceId) => fromPromiseDying(() => r.unregisterRuntime(sourceId)),
  list: () => fromPromiseDying(() => r.list()),
  remove: (sourceId) => fromPromiseDying(() => r.remove(sourceId)),
  refresh: (sourceId) => fromPromiseDying(() => r.refresh(sourceId)),
  detect: (url) => fromPromiseDying(() => r.detect(url)),
});

const toEffectSecretStore = (s: SecretStore): CoreSecretStoreService => ({
  list: (scopeId) => fromPromiseDying(() => s.list(scopeId)),
  get: (secretId) =>
    fromPromise(() => s.get(secretId)) as Effect.Effect<SecretRef, SecretNotFoundError>,
  resolve: (secretId, scopeId) =>
    fromPromise(() => s.resolve(secretId, scopeId)) as Effect.Effect<
      string,
      SecretNotFoundError | SecretResolutionError
    >,
  status: (secretId, scopeId) =>
    fromPromiseDying(() => s.status(secretId, scopeId)),
  set: (input) =>
    fromPromise(() => s.set(input)) as Effect.Effect<SecretRef, SecretResolutionError>,
  remove: (secretId) =>
    fromPromise(() => s.remove(secretId)) as Effect.Effect<boolean, SecretNotFoundError>,
  addProvider: (provider) =>
    fromPromiseDying(() => s.addProvider(toPromiseSecretProvider(provider))),
  providers: () => fromPromiseDying(() => s.providers()),
});

const toEffectPolicyEngine = (p: PolicyEngine): CorePolicyEngineService => ({
  list: (scopeId) => fromPromiseDying(() => p.list(scopeId)),
  check: (input) =>
    fromPromise(() =>
      p.check({ scopeId: input.scopeId, toolId: input.toolId }),
    ) as Effect.Effect<void, PolicyDeniedError>,
  add: (policy) => fromPromiseDying(() => p.add(policy)),
  remove: (policyId) => fromPromiseDying(() => p.remove(policyId)),
});

// ---------------------------------------------------------------------------
// Plugin context
// ---------------------------------------------------------------------------

export interface PluginContext {
  readonly scope: Scope;
  readonly tools: ToolRegistry;
  readonly sources: SourceRegistry;
  readonly secrets: SecretStore;
  readonly policies: PolicyEngine;
}

export interface ToolRegistry extends Omit<
  PromisifyService<CoreToolRegistryService>,
  'list' | 'invoke' | 'registerInvoker' | 'registerRuntimeHandler'
> {
  readonly list: (filter?: { sourceId?: string; query?: string }) => Promise<readonly ToolMetadata[]>;
  readonly invoke: (toolId: string, args: unknown, options: InvokeOptions) => Promise<ToolInvocationResult>;
  readonly registerInvoker: (pluginKey: string, invoker: ToolInvoker) => Promise<void>;
  readonly registerRuntimeHandler: (toolId: string, handler: RuntimeToolHandler) => Promise<void>;
}

export interface SourceRegistry extends Omit<PromisifyService<CoreSourceRegistryService>, 'addManager'> {
  readonly addManager: (manager: SourceManager) => Promise<void>;
}

export interface SecretStore extends Omit<PromisifyService<CoreSecretStoreService>, 'set' | 'addProvider'> {
  readonly set: (input: { readonly id: string; readonly scopeId: string; readonly name: string; readonly value: string; readonly provider?: string; readonly purpose?: string }) => Promise<SecretRef>;
  readonly addProvider: (provider: SecretProvider) => Promise<void>;
}

export interface PolicyEngine extends Omit<PromisifyService<CorePolicyEngineService>, 'check'> {
  readonly check: (input: { scopeId: string; toolId: string }) => Promise<void>;
}

const wrapPluginContext = (ctx: EffectPluginContext): PluginContext => ({
  scope: ctx.scope,
  tools: {
    list: (filter?) => run(ctx.tools.list(filter as any)),
    schema: (toolId) => run(ctx.tools.schema(toolId as ToolId)),
    invoke: (toolId, args, options) => run(ctx.tools.invoke(toolId as ToolId, args, toEffectInvokeOptions(options))),
    definitions: () => run(ctx.tools.definitions()),
    registerDefinitions: (defs) => run(ctx.tools.registerDefinitions(defs)),
    registerRuntimeDefinitions: (defs) => run(ctx.tools.registerRuntimeDefinitions(defs)),
    unregisterRuntimeDefinitions: (names) => run(ctx.tools.unregisterRuntimeDefinitions(names)),
    registerInvoker: (pluginKey, invoker) => run(ctx.tools.registerInvoker(pluginKey, toEffectInvoker(invoker))),
    resolveAnnotations: (toolId) => run(ctx.tools.resolveAnnotations(toolId as ToolId)),
    register: (tools) => run(ctx.tools.register(tools)),
    registerRuntime: (tools) => run(ctx.tools.registerRuntime(tools)),
    registerRuntimeHandler: (toolId, handler) => run(ctx.tools.registerRuntimeHandler(toolId as ToolId, toEffectRuntimeHandler(handler))),
    unregisterRuntime: (toolIds) => run(ctx.tools.unregisterRuntime(toolIds as readonly ToolId[])),
    unregister: (toolIds) => run(ctx.tools.unregister(toolIds as readonly ToolId[])),
    unregisterBySource: (sourceId) => run(ctx.tools.unregisterBySource(sourceId)),
  },
  sources: {
    addManager: (manager) => run(ctx.sources.addManager(toEffectSourceManager(manager))),
    registerRuntime: (source) => run(ctx.sources.registerRuntime(source)),
    unregisterRuntime: (sourceId) => run(ctx.sources.unregisterRuntime(sourceId)),
    list: () => run(ctx.sources.list()),
    remove: (sourceId) => run(ctx.sources.remove(sourceId)),
    refresh: (sourceId) => run(ctx.sources.refresh(sourceId)),
    detect: (url) => run(ctx.sources.detect(url)),
  },
  secrets: {
    list: (scopeId) => run(ctx.secrets.list(scopeId as ScopeIdType)),
    get: (secretId) => run(ctx.secrets.get(secretId as SecretId)),
    resolve: (secretId, scopeId) => run(ctx.secrets.resolve(secretId as SecretId, scopeId as ScopeIdType)),
    status: (secretId, scopeId) => run(ctx.secrets.status(secretId as SecretId, scopeId as ScopeIdType)),
    set: (input) => run(ctx.secrets.set(input as SetSecretInput)),
    remove: (secretId) => run(ctx.secrets.remove(secretId as SecretId)),
    addProvider: (provider) => run(ctx.secrets.addProvider(toEffectSecretProvider(provider))),
    providers: () => run(ctx.secrets.providers()),
  },
  policies: {
    list: (scopeId) => run(ctx.policies.list(scopeId as ScopeIdType)),
    check: (input) => run(ctx.policies.check(input as any)),
    add: (policy) => run(ctx.policies.add(policy)),
    remove: (policyId) => run(ctx.policies.remove(policyId as PolicyId)),
  },
});

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export interface Plugin<TKey extends string = string, TExtension extends object = object> {
  readonly key: TKey;
  /** @internal */
  readonly _promise?: true;
  readonly init: (ctx: PluginContext) => Promise<PluginHandle<TExtension>>;
}

export interface PluginHandle<TExtension extends object = object> {
  readonly extension: TExtension;
  readonly close?: () => Promise<void>;
}

export const definePlugin = <const TKey extends string, TExtension extends object>(
  plugin: Plugin<TKey, TExtension>,
): Plugin<TKey, TExtension> => ({ ...plugin, _promise: true as const });

const isPromisePlugin = (plugin: { _promise?: boolean }): boolean => plugin._promise === true;

const toEffectPlugin = <TKey extends string, TExtension extends object>(
  plugin: Plugin<TKey, TExtension>,
): ExecutorPlugin<TKey, TExtension> => ({
  key: plugin.key,
  init: (ctx) =>
    fromPromise(async () => {
      const handle = await plugin.init(wrapPluginContext(ctx));
      return {
        extension: handle.extension,
        close: handle.close ? () => fromPromise(() => handle.close!()) as Effect.Effect<void> : undefined,
      };
    }) as Effect.Effect<any, Error>,
});

// ---------------------------------------------------------------------------
// Executor type
// ---------------------------------------------------------------------------

type Promisified<T> = T extends (...args: infer A) => Effect.Effect<infer R, infer _E>
  ? (...args: A) => Promise<R>
  : T extends object ? { readonly [K in keyof T]: Promisified<T[K]> } : T;

export type AnyPlugin = Plugin<string, object> | ExecutorPlugin<string, object>;

export type Executor<TPlugins extends readonly AnyPlugin[] = []> = {
  readonly scope: Scope;
  readonly tools: Pick<ToolRegistry, 'list' | 'schema' | 'definitions' | 'invoke'>;
  readonly sources: Pick<SourceRegistry, 'list' | 'remove' | 'refresh' | 'detect'>;
  readonly policies: {
    readonly list: () => Promise<readonly Policy[]>;
    readonly add: (policy: Omit<Policy, "id" | "createdAt">) => Promise<Policy>;
    readonly remove: (policyId: string) => Promise<boolean>;
  };
  readonly secrets: {
    readonly list: () => Promise<readonly SecretRef[]>;
    readonly resolve: (secretId: string) => Promise<string>;
    readonly status: (secretId: string) => Promise<"resolved" | "missing">;
    readonly set: (input: { readonly id: string; readonly name: string; readonly value: string; readonly provider?: string; readonly purpose?: string }) => Promise<SecretRef>;
    readonly remove: (secretId: string) => Promise<boolean>;
    readonly addProvider: (provider: SecretProvider) => Promise<void>;
    readonly providers: () => Promise<readonly string[]>;
  };
  readonly close: () => Promise<void>;
} & PluginExtensions<TPlugins>;

type PluginExtensions<TPlugins extends readonly AnyPlugin[]> = {
  readonly [P in TPlugins[number] as P["key"]]: P extends Plugin<string, infer TExt>
    ? TExt
    : P extends ExecutorPlugin<string, infer TExt> ? Promisified<TExt> : never;
};

function promisifyObject<T extends object>(obj: T): Promisified<T> {
  return new Proxy(obj, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          const result = value.apply(target, args);
          if (Effect.isEffect(result)) return run(result as Effect.Effect<unknown, unknown>);
          return result;
        };
      }
      if (value !== null && typeof value === "object" && !Array.isArray(value)) return promisifyObject(value as object);
      return value;
    },
  }) as Promisified<T>;
}

// ---------------------------------------------------------------------------
// Config & createExecutor
// ---------------------------------------------------------------------------

export interface ExecutorConfig<TPlugins extends readonly AnyPlugin[] = []> {
  readonly scope?: { readonly id?: string; readonly name?: string };
  readonly plugins?: TPlugins;
  /**
   * Custom tool registry implementation. Defaults to an in-memory store.
   * Implement the promise-shaped `ToolRegistry` interface to persist tool
   * metadata to a database, remote service, etc.
   */
  readonly tools?: ToolRegistry;
  /** Custom source registry implementation. Defaults to an in-memory store. */
  readonly sources?: SourceRegistry;
  /**
   * Custom secret store implementation. Defaults to an in-memory store.
   * For most use cases, prefer passing a custom `SecretProvider` via
   * `executor.secrets.addProvider(...)` — only replace the whole store if you
   * need to persist the `SecretRef` metadata itself.
   */
  readonly secrets?: SecretStore;
  /** Custom policy engine implementation. Defaults to an in-memory store. */
  readonly policies?: PolicyEngine;
}

const KNOWN_KEYS = new Set(["scope", "tools", "sources", "policies", "secrets", "close"]);

export const createExecutor = async <const TPlugins extends readonly AnyPlugin[] = []>(
  config: ExecutorConfig<TPlugins> = {},
): Promise<Executor<TPlugins>> => {
  const effectPlugins = (config.plugins ?? []).map((p) =>
    isPromisePlugin(p as any)
      ? toEffectPlugin(p as Plugin<string, object>)
      : (p as unknown as ExecutorPlugin<string, object>),
  );

  const effectConfig: EffectExecutorConfig<ExecutorPlugin<string, object>[]> = {
    scope: {
      id: ScopeId.make(config.scope?.id ?? "default"),
      name: config.scope?.name ?? "default",
      createdAt: new Date(),
    },
    tools: config.tools ? toEffectToolRegistry(config.tools) : makeInMemoryToolRegistry(),
    sources: config.sources
      ? toEffectSourceRegistry(config.sources)
      : makeInMemorySourceRegistry(),
    secrets: config.secrets ? toEffectSecretStore(config.secrets) : makeInMemorySecretStore(),
    policies: config.policies
      ? toEffectPolicyEngine(config.policies)
      : makeInMemoryPolicyEngine(),
    plugins: effectPlugins,
  };

  const executor = await run(createEffectExecutor(effectConfig));

  const base: Record<string, unknown> = {
    scope: executor.scope,
    tools: {
      list: (filter?: { sourceId?: string; query?: string }) => run(executor.tools.list(filter as any)),
      schema: (toolId: string) => run(executor.tools.schema(toolId)),
      definitions: () => run(executor.tools.definitions()),
      invoke: (toolId: string, args: unknown, options: InvokeOptions) =>
        run(executor.tools.invoke(toolId, args, toEffectInvokeOptions(options))),
    },
    sources: {
      list: () => run(executor.sources.list()),
      remove: (sourceId: string) => run(executor.sources.remove(sourceId)),
      refresh: (sourceId: string) => run(executor.sources.refresh(sourceId)),
      detect: (url: string) => run(executor.sources.detect(url)),
    },
    policies: {
      list: () => run(executor.policies.list()),
      add: (policy: Omit<Policy, "id" | "createdAt">) => run(executor.policies.add(policy)),
      remove: (policyId: string) => run(executor.policies.remove(policyId)),
    },
    secrets: {
      list: () => run(executor.secrets.list()),
      resolve: (secretId: string) => run(executor.secrets.resolve(secretId as SecretId)),
      status: (secretId: string) => run(executor.secrets.status(secretId as SecretId)),
      set: (input: { readonly id: string; readonly name: string; readonly value: string; readonly provider?: string; readonly purpose?: string }) =>
        run(executor.secrets.set(input as any)),
      remove: (secretId: string) => run(executor.secrets.remove(secretId as SecretId)),
      addProvider: (provider: SecretProvider) => run(executor.secrets.addProvider(toEffectSecretProvider(provider))),
      providers: () => run(executor.secrets.providers()),
    },
    close: () => run(executor.close()),
  };

  for (const key of Object.keys(executor)) {
    if (!KNOWN_KEYS.has(key)) {
      const ext = (executor as Record<string, unknown>)[key];
      if (ext !== null && typeof ext === "object") base[key] = promisifyObject(ext as object);
      else base[key] = ext;
    }
  }

  return base as Executor<TPlugins>;
};

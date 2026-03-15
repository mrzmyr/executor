import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import { type ControlPlaneApiRuntimeContext } from "#api";
import type { LocalInstallation } from "#schema";

import { type ResolveExecutionEnvironment } from "./execution-state";
import {
  createLiveExecutionManager,
  LiveExecutionManagerLive,
  LiveExecutionManagerService,
} from "./live-execution";
import {
  createLocalControlPlanePersistence,
  type LocalControlPlanePersistence,
} from "./local-control-plane-store";
import {
  resolveLocalWorkspaceContext,
} from "./local-config";
import {
  InstallationStore,
  LocalInstallationStore,
  LocalInstallationStoreLive,
  LocalSourceArtifactStore,
  LocalSourceArtifactStoreLive,
  SourceArtifactStore,
  LocalWorkspaceConfigStore,
  LocalWorkspaceConfigStoreLive,
  LocalWorkspaceStateStore,
  LocalWorkspaceStateStoreLive,
  WorkspaceConfigStore,
  WorkspaceStateStore,
} from "./local-storage";
import {
  type RuntimeLocalWorkspaceState,
  RuntimeLocalWorkspaceService,
} from "./local-runtime-context";
import { synchronizeLocalWorkspaceState } from "./local-workspace-sync";
import { ControlPlaneStore, type ControlPlaneStoreShape } from "./store";
import {
  createRuntimeSourceAuthService,
  RuntimeSourceAuthServiceLive,
  RuntimeSourceAuthServiceTag,
} from "./source-auth-service";
import type { ResolveSecretMaterial } from "./secret-material-providers";
import { createDefaultSecretMaterialResolver } from "./secret-material-providers";
import {
  createWorkspaceExecutionEnvironmentResolver,
  RuntimeExecutionResolverLive,
  RuntimeExecutionResolverService,
} from "./workspace-execution-environment";

export * from "./execution-state";
export * from "./executor-tools";
export * from "./live-execution";
export * from "./local-config";
export * from "./local-installation";
export * from "./local-storage";
export * from "./local-source-artifacts";
export * from "./local-tools";
export * from "./schema-type-signature";
export * from "./source-auth-service";
export * from "./secret-material-providers";
export * from "./source-credential-interactions";
export * from "./source-adapters/mcp";
export * from "./store";
export * from "./workspace-execution-environment";
export * from "./source-inspection";
export * from "./source-discovery";
export * from "./execution-service";

export type RuntimeControlPlaneOptions = {
  executionResolver?: ResolveExecutionEnvironment;
  resolveSecretMaterial?: ResolveSecretMaterial;
  getLocalServerBaseUrl?: () => string | undefined;
  workspaceRoot?: string;
};

const detailsFromCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const toLocalRuntimeBootstrapError = (
  cause: unknown,
): Error => {
  const details = detailsFromCause(cause);
  return new Error(`Failed initializing local runtime: ${details}`);
};

const closeScope = (scope: Scope.CloseableScope) =>
  Scope.close(scope, Exit.void).pipe(Effect.orDie);

export type RuntimeControlPlaneLayer = Layer.Layer<
  ControlPlaneApiRuntimeContext,
  never,
  never
>;

export const createRuntimeControlPlaneLayer = (
  input: RuntimeControlPlaneOptions & {
    store: ControlPlaneStoreShape;
    localWorkspaceState: RuntimeLocalWorkspaceState;
  },
) => {
  const baseLayer = Layer.mergeAll(
    Layer.succeed(ControlPlaneStore, input.store),
    Layer.succeed(RuntimeLocalWorkspaceService, input.localWorkspaceState),
    LocalInstallationStoreLive,
    LocalWorkspaceConfigStoreLive,
    LocalWorkspaceStateStoreLive,
    LocalSourceArtifactStoreLive,
    LiveExecutionManagerLive,
  );

  const sourceAuthLayer = RuntimeSourceAuthServiceLive({
    getLocalServerBaseUrl: input.getLocalServerBaseUrl,
    localConfig: input.localWorkspaceState.loadedConfig.config,
    workspaceRoot: input.localWorkspaceState.context.workspaceRoot,
    localWorkspaceState: input.localWorkspaceState,
  }).pipe(Layer.provide(baseLayer));

  const executionResolverLayer = RuntimeExecutionResolverLive({
    executionResolver: input.executionResolver,
    resolveSecretMaterial: input.resolveSecretMaterial,
  }).pipe(
    Layer.provide(Layer.mergeAll(baseLayer, sourceAuthLayer)),
  );

  return Layer.mergeAll(
    baseLayer,
    sourceAuthLayer,
    executionResolverLayer,
  ) as RuntimeControlPlaneLayer;
};

export type ControlPlaneRuntime = {
  persistence: LocalControlPlanePersistence;
  localInstallation: LocalInstallation;
  runtimeLayer: RuntimeControlPlaneLayer;
  close: () => Promise<void>;
};

export type CreateControlPlaneRuntimeOptions = RuntimeControlPlaneOptions;

export const createControlPlaneRuntime = (
  options: CreateControlPlaneRuntimeOptions,
): Effect.Effect<ControlPlaneRuntime, Error> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();

    const localWorkspaceContext = yield* resolveLocalWorkspaceContext({
      workspaceRoot: options.workspaceRoot,
    }).pipe(
      Effect.mapError(toLocalRuntimeBootstrapError),
      Effect.catchAll((error) =>
        closeScope(scope).pipe(Effect.zipRight(Effect.fail(error))),
      ),
    );

    const installationStore = LocalInstallationStore;
    const workspaceConfigStore = LocalWorkspaceConfigStore;
    const workspaceStateStore = LocalWorkspaceStateStore;
    const sourceArtifactStore = LocalSourceArtifactStore;

    const localInstallation = yield* installationStore.getOrProvision({
      context: localWorkspaceContext,
    }).pipe(
      Effect.mapError(toLocalRuntimeBootstrapError),
      Effect.catchAll((error) =>
        closeScope(scope).pipe(Effect.zipRight(Effect.fail(error))),
      ),
    );

    const persistence = createLocalControlPlanePersistence(localWorkspaceContext);
    const rows = persistence.rows;

    const loadedLocalConfig = yield* workspaceConfigStore.load(
      localWorkspaceContext,
    ).pipe(
      Effect.mapError(toLocalRuntimeBootstrapError),
      Effect.catchAll((error) =>
        closeScope(scope).pipe(Effect.zipRight(Effect.fail(error))),
      ),
    );

    const effectiveLocalConfig = yield* synchronizeLocalWorkspaceState({
      context: localWorkspaceContext,
      loadedConfig: loadedLocalConfig,
    }).pipe(
      Effect.mapError(toLocalRuntimeBootstrapError),
      Effect.catchAll((error) =>
        closeScope(scope).pipe(Effect.zipRight(Effect.fail(error))),
      ),
    );

    const resolveSecretMaterial =
      options.resolveSecretMaterial ??
      createDefaultSecretMaterialResolver({
        rows,
        localConfig: effectiveLocalConfig,
        workspaceRoot: localWorkspaceContext.workspaceRoot,
      });

    const liveExecutionManager = createLiveExecutionManager();
    const sourceAuthService = createRuntimeSourceAuthService({
      rows,
      liveExecutionManager,
      getLocalServerBaseUrl: options.getLocalServerBaseUrl,
      localConfig: effectiveLocalConfig,
      workspaceRoot: localWorkspaceContext.workspaceRoot,
      localWorkspaceState: {
        context: localWorkspaceContext,
        installation: {
          workspaceId: localInstallation.workspaceId,
          accountId: localInstallation.accountId,
        },
        loadedConfig: {
          ...loadedLocalConfig,
          config: effectiveLocalConfig,
        },
      },
    });

    const runtimeLocalWorkspaceState: RuntimeLocalWorkspaceState = {
      context: localWorkspaceContext,
      installation: {
        workspaceId: localInstallation.workspaceId,
        accountId: localInstallation.accountId,
      },
      loadedConfig: {
        ...loadedLocalConfig,
        config: effectiveLocalConfig,
      },
    };

    const executionResolver =
      options.executionResolver ??
      createWorkspaceExecutionEnvironmentResolver({
        rows,
        sourceAuthService,
        resolveSecretMaterial,
        workspaceConfigStore,
        workspaceStateStore,
        sourceArtifactStore,
      });

    const concreteRuntimeLayer = createRuntimeControlPlaneLayer({
      ...options,
      store: rows,
      localWorkspaceState: runtimeLocalWorkspaceState,
      resolveSecretMaterial,
      executionResolver,
    });

    return {
      persistence,
      localInstallation,
      runtimeLayer: concreteRuntimeLayer,
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => {}),
    };
  });

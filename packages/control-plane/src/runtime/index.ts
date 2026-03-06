import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import {
  type ControlPlaneApiServiceContext,
  ControlPlaneActorResolver,
  type ControlPlaneActorResolverShape,
  ControlPlaneExecutionsService,
  type ControlPlaneExecutionsServiceShape,
  ControlPlaneLocalService,
  type ControlPlaneLocalServiceShape,
  ControlPlaneMembershipsService,
  type ControlPlaneMembershipsServiceShape,
  ControlPlaneOrganizationsService,
  type ControlPlaneOrganizationsServiceShape,
  ControlPlanePoliciesService,
  type ControlPlanePoliciesServiceShape,
  ControlPlaneSourcesService,
  type ControlPlaneSourcesServiceShape,
  ControlPlaneWorkspacesService,
  type ControlPlaneWorkspacesServiceShape,
} from "#api";
import {
  SqlControlPlanePersistenceLive,
  SqlControlPlanePersistenceService,
  SqlControlPlaneRowsLive,
  SqlPersistenceBootstrapError,
  type CreateSqlRuntimeOptions,
  type SqlControlPlanePersistence,
} from "#persistence";

import type { LocalInstallation } from "#schema";
import {
  ControlPlaneAuthHeaders,
  RuntimeActorResolverLive,
  createHeaderActorResolver,
} from "./actor-resolver";
import {
  type ResolveExecutionEnvironment,
} from "./execution-state";
import {
  LiveExecutionManagerLive,
} from "./live-execution";
import {
  getOrProvisionLocalInstallation,
} from "./local-installation";
import {
  RuntimeSourceAuthServiceLive,
  type ResolveSecretMaterial,
} from "./source-auth-service";
import {
  RuntimeControlPlaneApiServicesLive,
} from "./services";
import {
  RuntimeExecutionResolverLive,
} from "./workspace-execution-environment";

export {
  ControlPlaneAuthHeaders,
  createHeaderActorResolver,
};

export * from "./execution-state";
export * from "./live-execution";
export * from "./local-installation";
export * from "./source-auth-service";
export * from "./workspace-execution-environment";

export type RuntimeControlPlaneOptions = {
  actorResolver?: ControlPlaneActorResolverShape;
  executionResolver?: ResolveExecutionEnvironment;
  resolveSecretMaterial?: ResolveSecretMaterial;
  getLocalServerBaseUrl?: () => string | undefined;
};

export type RuntimeControlPlaneInput = RuntimeControlPlaneOptions & {
  persistence: SqlControlPlanePersistence;
};

const detailsFromCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const toLocalInstallationBootstrapError = (
  cause: unknown,
): SqlPersistenceBootstrapError => {
  const details = detailsFromCause(cause);
  return new SqlPersistenceBootstrapError({
    message: `Failed provisioning local installation: ${details}`,
    details,
  });
};

const closeScope = (scope: Scope.CloseableScope) =>
  Scope.close(scope, Exit.void).pipe(Effect.orDie);

const createRuntimeServicesLayer = (input: {
  organizationsService: ControlPlaneOrganizationsServiceShape;
  membershipsService: ControlPlaneMembershipsServiceShape;
  workspacesService: ControlPlaneWorkspacesServiceShape;
  sourcesService: ControlPlaneSourcesServiceShape;
  policiesService: ControlPlanePoliciesServiceShape;
  localService: ControlPlaneLocalServiceShape;
  executionsService: ControlPlaneExecutionsServiceShape;
}): Layer.Layer<ControlPlaneApiServiceContext, never, never> =>
  Layer.mergeAll(
    Layer.succeed(ControlPlaneOrganizationsService, input.organizationsService),
    Layer.succeed(ControlPlaneMembershipsService, input.membershipsService),
    Layer.succeed(ControlPlaneWorkspacesService, input.workspacesService),
    Layer.succeed(ControlPlaneSourcesService, input.sourcesService),
    Layer.succeed(ControlPlanePoliciesService, input.policiesService),
    Layer.succeed(ControlPlaneLocalService, input.localService),
    Layer.succeed(ControlPlaneExecutionsService, input.executionsService),
  );

export const createRuntimeControlPlaneLayer = (
  options: RuntimeControlPlaneOptions = {},
) => {
  const liveExecutionManagerLayer = LiveExecutionManagerLive;
  const sourceAuthLayer = RuntimeSourceAuthServiceLive({
    getLocalServerBaseUrl: options.getLocalServerBaseUrl,
  }).pipe(
    Layer.provide(liveExecutionManagerLayer),
  );
  const executionResolverLayer = RuntimeExecutionResolverLive({
    executionResolver: options.executionResolver,
    resolveSecretMaterial: options.resolveSecretMaterial,
  }).pipe(
    Layer.provide(sourceAuthLayer),
  );
  const runtimeDependenciesLayer = Layer.mergeAll(
    liveExecutionManagerLayer,
    sourceAuthLayer,
    executionResolverLayer,
  );
  const apiServicesLayer = RuntimeControlPlaneApiServicesLive.pipe(
    Layer.provide(runtimeDependenciesLayer),
  );

  return Layer.mergeAll(
    apiServicesLayer,
    RuntimeActorResolverLive(options.actorResolver),
    runtimeDependenciesLayer,
  );
};

export const createRuntimeControlPlane = (
  input: RuntimeControlPlaneInput,
): Effect.Effect<{
  serviceLayer: Layer.Layer<ControlPlaneApiServiceContext, never, never>;
  actorResolver: ControlPlaneActorResolverShape;
}> =>
  Effect.gen(function* () {
    const actorResolver = yield* ControlPlaneActorResolver;
    const organizationsService = yield* ControlPlaneOrganizationsService;
    const membershipsService = yield* ControlPlaneMembershipsService;
    const workspacesService = yield* ControlPlaneWorkspacesService;
    const sourcesService = yield* ControlPlaneSourcesService;
    const policiesService = yield* ControlPlanePoliciesService;
    const localService = yield* ControlPlaneLocalService;
    const executionsService = yield* ControlPlaneExecutionsService;
    const serviceLayer = createRuntimeServicesLayer({
      organizationsService,
      membershipsService,
      workspacesService,
      sourcesService,
      policiesService,
      localService,
      executionsService,
    });

    return {
      serviceLayer,
      actorResolver,
    };
  }).pipe(
    Effect.provide(
      createRuntimeControlPlaneLayer(input).pipe(
        Layer.provide(SqlControlPlaneRowsLive),
        Layer.provide(
          Layer.succeed(SqlControlPlanePersistenceService, input.persistence),
        ),
      ),
    ),
  );

export type SqlControlPlaneRuntime = {
  persistence: SqlControlPlanePersistence;
  localInstallation: LocalInstallation;
  serviceLayer: Layer.Layer<ControlPlaneApiServiceContext, never, never>;
  actorResolver: ControlPlaneActorResolverShape;
  close: () => Promise<void>;
};

export type CreateSqlControlPlaneRuntimeOptions = CreateSqlRuntimeOptions
  & RuntimeControlPlaneOptions;

export const createSqlControlPlaneRuntime = (
  options: CreateSqlControlPlaneRuntimeOptions,
): Effect.Effect<SqlControlPlaneRuntime, SqlPersistenceBootstrapError> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const persistenceAndRowsLayer = SqlControlPlaneRowsLive.pipe(
      Layer.provideMerge(SqlControlPlanePersistenceLive(options)),
    );
    const runtimeLayer = createRuntimeControlPlaneLayer(options).pipe(
      Layer.provideMerge(persistenceAndRowsLayer),
    );

    const context = yield* Layer.buildWithScope(runtimeLayer, scope).pipe(
      Effect.catchAll((error) =>
        closeScope(scope).pipe(
          Effect.zipRight(Effect.fail(error)),
        )),
    );

    const persistence = Context.get(context, SqlControlPlanePersistenceService);
    const actorResolver = Context.get(context, ControlPlaneActorResolver);
    const organizationsService = Context.get(context, ControlPlaneOrganizationsService);
    const membershipsService = Context.get(context, ControlPlaneMembershipsService);
    const workspacesService = Context.get(context, ControlPlaneWorkspacesService);
    const sourcesService = Context.get(context, ControlPlaneSourcesService);
    const policiesService = Context.get(context, ControlPlanePoliciesService);
    const localService = Context.get(context, ControlPlaneLocalService);
    const executionsService = Context.get(context, ControlPlaneExecutionsService);
    const serviceLayer = createRuntimeServicesLayer({
      organizationsService,
      membershipsService,
      workspacesService,
      sourcesService,
      policiesService,
      localService,
      executionsService,
    });

    const localInstallation = yield* getOrProvisionLocalInstallation(
      persistence.rows,
    ).pipe(
      Effect.mapError(toLocalInstallationBootstrapError),
      Effect.catchAll((error) =>
        closeScope(scope).pipe(
          Effect.zipRight(Effect.fail(error)),
        )),
    );

    return {
      persistence,
      localInstallation,
      serviceLayer,
      actorResolver,
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    };
  });

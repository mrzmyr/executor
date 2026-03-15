import type {
  AccountId,
  Source,
  SourceStatus,
} from "#schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  RuntimeLocalWorkspaceService,
  type RuntimeLocalWorkspaceState,
} from "./local-runtime-context";
import {
  SourceArtifactStore,
  type SourceArtifactStoreShape,
  WorkspaceStateStore,
  type WorkspaceStateStoreShape,
} from "./local-storage";
import {
  type LocalWorkspaceState,
} from "./local-workspace-state";
import {
  RuntimeSourceAuthMaterialService,
} from "./source-auth-material";
import {
  getSourceAdapterForSource,
} from "./source-adapters";
import {
  materializationFromMcpManifestEntries,
} from "./source-adapters/mcp";
import { SecretMaterialResolverService } from "./secret-material-providers";

const shouldIndexSource = (source: Source): boolean =>
  source.enabled
  && source.status === "connected"
  && getSourceAdapterForSource(source).family !== "internal";

type RuntimeSourceMaterializationDeps = {
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState;
  workspaceStateStore: WorkspaceStateStoreShape;
  sourceArtifactStore: SourceArtifactStoreShape;
  resolveSecretMaterial: Effect.Effect.Success<typeof SecretMaterialResolverService>;
  sourceAuthMaterialService: Effect.Effect.Success<typeof RuntimeSourceAuthMaterialService>;
};

type SourceMaterializationServices =
  | RuntimeLocalWorkspaceService
  | WorkspaceStateStore
  | SourceArtifactStore
  | RuntimeSourceAuthMaterialService
  | SecretMaterialResolverService;

export type RuntimeSourceMaterializationShape = {
  sync: (input: {
    source: Source;
    actorAccountId?: AccountId | null;
  }) => Effect.Effect<void, Error, never>;
  persistMcpRecipeMaterializationFromManifest: (input: {
    source: Source;
    manifestEntries: Parameters<typeof materializationFromMcpManifestEntries>[0]["manifestEntries"];
  }) => Effect.Effect<void, Error, never>;
};

export class RuntimeSourceMaterializationService extends Context.Tag(
  "#runtime/RuntimeSourceMaterializationService",
)<RuntimeSourceMaterializationService, RuntimeSourceMaterializationShape>() {}

const ensureRuntimeMaterializationWorkspace = (
  deps: RuntimeSourceMaterializationDeps,
  workspaceId: Source["workspaceId"],
) => {
  if (deps.runtimeLocalWorkspace.installation.workspaceId !== workspaceId) {
    return Effect.fail(
      new Error(
        `Runtime local workspace mismatch: expected ${workspaceId}, got ${deps.runtimeLocalWorkspace.installation.workspaceId}`,
      ),
    );
  }

  return Effect.succeed(deps.runtimeLocalWorkspace.context);
};

const syncSourceMaterializationWithDeps = (
  deps: RuntimeSourceMaterializationDeps,
  input: {
    source: Source;
    actorAccountId?: AccountId | null;
  },
): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    const workspaceContext = yield* ensureRuntimeMaterializationWorkspace(
      deps,
      input.source.workspaceId,
    );

    if (!shouldIndexSource(input.source)) {
      const state = yield* deps.workspaceStateStore.load(workspaceContext);
      const existingSourceState = state.sources[input.source.id];
      const nextState: LocalWorkspaceState = {
        ...state,
        sources: {
          ...state.sources,
          [input.source.id]: {
            status: (input.source.enabled ? input.source.status : "draft") as SourceStatus,
            lastError: null,
            sourceHash: input.source.sourceHash,
            createdAt: existingSourceState?.createdAt ?? input.source.createdAt,
            updatedAt: Date.now(),
          },
        },
      };
      yield* deps.workspaceStateStore.write({
        context: workspaceContext,
        state: nextState,
      });
      return;
    }

    const adapter = getSourceAdapterForSource(input.source);
    const materialization = yield* adapter.materializeSource({
      source: input.source,
      resolveSecretMaterial: deps.resolveSecretMaterial,
      resolveAuthMaterialForSlot: (slot) =>
        deps.sourceAuthMaterialService.resolve({
          source: input.source,
          slot,
          actorAccountId: input.actorAccountId,
        }),
    });
    yield* deps.sourceArtifactStore.write({
      context: workspaceContext,
      sourceId: input.source.id,
      artifact: deps.sourceArtifactStore.build({
        source: input.source,
        materialization,
      }),
    });

    const state = yield* deps.workspaceStateStore.load(workspaceContext);
    const existingSourceState = state.sources[input.source.id];
    const nextState: LocalWorkspaceState = {
      ...state,
      sources: {
        ...state.sources,
        [input.source.id]: {
          status: "connected",
          lastError: null,
          sourceHash: materialization.sourceHash,
          createdAt: existingSourceState?.createdAt ?? input.source.createdAt,
          updatedAt: Date.now(),
        },
      },
    };
    yield* deps.workspaceStateStore.write({
      context: workspaceContext,
      state: nextState,
    });
  });

const persistMcpRecipeMaterializationFromManifestWithDeps = (
  deps: RuntimeSourceMaterializationDeps,
  input: {
    source: Source;
    manifestEntries: Parameters<typeof materializationFromMcpManifestEntries>[0]["manifestEntries"];
  },
): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    const workspaceContext = yield* ensureRuntimeMaterializationWorkspace(
      deps,
      input.source.workspaceId,
    );
    const materialization = materializationFromMcpManifestEntries({
      recipeRevisionId: "src_recipe_rev_materialization" as never,
      endpoint: input.source.endpoint,
      manifestEntries: input.manifestEntries,
    });

    yield* deps.sourceArtifactStore.write({
      context: workspaceContext,
      sourceId: input.source.id,
      artifact: deps.sourceArtifactStore.build({
        source: input.source,
        materialization,
      }),
    });
  });

export const syncSourceMaterialization = (input: {
  source: Source;
  actorAccountId?: AccountId | null;
}): Effect.Effect<void, Error, SourceMaterializationServices> =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* RuntimeLocalWorkspaceService;
    const workspaceStateStore = yield* WorkspaceStateStore;
    const sourceArtifactStore = yield* SourceArtifactStore;
    const resolveSecretMaterial = yield* SecretMaterialResolverService;
    const sourceAuthMaterialService = yield* RuntimeSourceAuthMaterialService;

    return yield* syncSourceMaterializationWithDeps(
      {
        runtimeLocalWorkspace,
        workspaceStateStore,
        sourceArtifactStore,
        resolveSecretMaterial,
        sourceAuthMaterialService,
      },
      {
        source: input.source,
        actorAccountId: input.actorAccountId,
      },
    );
  });

export const persistMcpRecipeMaterializationFromManifest = (input: {
  source: Source;
  manifestEntries: Parameters<typeof materializationFromMcpManifestEntries>[0]["manifestEntries"];
}): Effect.Effect<void, Error, SourceMaterializationServices> =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* RuntimeLocalWorkspaceService;
    const workspaceStateStore = yield* WorkspaceStateStore;
    const sourceArtifactStore = yield* SourceArtifactStore;
    const resolveSecretMaterial = yield* SecretMaterialResolverService;
    const sourceAuthMaterialService = yield* RuntimeSourceAuthMaterialService;

    return yield* persistMcpRecipeMaterializationFromManifestWithDeps(
      {
        runtimeLocalWorkspace,
        workspaceStateStore,
        sourceArtifactStore,
        resolveSecretMaterial,
        sourceAuthMaterialService,
      },
      input,
    );
  });

export const RuntimeSourceMaterializationLive = Layer.effect(
  RuntimeSourceMaterializationService,
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* RuntimeLocalWorkspaceService;
    const workspaceStateStore = yield* WorkspaceStateStore;
    const sourceArtifactStore = yield* SourceArtifactStore;
    const resolveSecretMaterial = yield* SecretMaterialResolverService;
    const sourceAuthMaterialService = yield* RuntimeSourceAuthMaterialService;

    const deps: RuntimeSourceMaterializationDeps = {
      runtimeLocalWorkspace,
      workspaceStateStore,
      sourceArtifactStore,
      resolveSecretMaterial,
      sourceAuthMaterialService,
    };

    return RuntimeSourceMaterializationService.of({
      sync: (input) => syncSourceMaterializationWithDeps(deps, input),
      persistMcpRecipeMaterializationFromManifest: (input) =>
        persistMcpRecipeMaterializationFromManifestWithDeps(deps, input),
    });
  }),
);

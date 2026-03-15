import type {
  AccountId,
  Source,
  SourceStatus,
} from "#schema";
import * as Effect from "effect/Effect";

import type { ControlPlaneStoreShape } from "./store";
import {
  requireRuntimeLocalWorkspace,
} from "./local-runtime-context";
import {
  type WorkspaceStorageServices,
  SourceArtifactStore,
  WorkspaceStateStore,
} from "./local-storage";
import {
  type LocalWorkspaceState,
} from "./local-workspace-state";
import { resolveSourceAuthMaterial } from "./source-auth-material";
import {
  getSourceAdapterForSource,
} from "./source-adapters";
import {
  materializationFromMcpManifestEntries,
} from "./source-adapters/mcp";
import type {
  ResolveSecretMaterial as ResolveSourceSecretMaterial,
} from "./secret-material-providers";

const shouldIndexSource = (source: Source): boolean =>
  source.enabled
  && source.status === "connected"
  && getSourceAdapterForSource(source).family !== "internal";

export const syncSourceMaterialization = (input: {
  rows: ControlPlaneStoreShape;
  source: Source;
  actorAccountId?: AccountId | null;
  resolveSecretMaterial: ResolveSourceSecretMaterial;
}): Effect.Effect<void, Error, WorkspaceStorageServices> =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* requireRuntimeLocalWorkspace(input.source.workspaceId);
    const workspaceStateStore = yield* WorkspaceStateStore;
    const sourceArtifactStore = yield* SourceArtifactStore;

    if (!shouldIndexSource(input.source)) {
      const state = yield* workspaceStateStore.load(
        runtimeLocalWorkspace.context,
      );
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
      yield* workspaceStateStore.write({
        context: runtimeLocalWorkspace.context,
        state: nextState,
      });
      return;
    }

    const adapter = getSourceAdapterForSource(input.source);
    const materialization = yield* adapter.materializeSource({
      source: input.source,
      resolveSecretMaterial: input.resolveSecretMaterial,
      resolveAuthMaterialForSlot: (slot) =>
        resolveSourceAuthMaterial({
          rows: input.rows,
          source: input.source,
          slot,
          actorAccountId: input.actorAccountId,
          resolveSecretMaterial: input.resolveSecretMaterial,
        }),
    });
    yield* sourceArtifactStore.write({
      context: runtimeLocalWorkspace.context,
      sourceId: input.source.id,
      artifact: sourceArtifactStore.build({
        source: input.source,
        materialization,
      }),
    });

    const state = yield* workspaceStateStore.load(
      runtimeLocalWorkspace.context,
    );
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
    yield* workspaceStateStore.write({
      context: runtimeLocalWorkspace.context,
      state: nextState,
    });
  });

export const persistMcpRecipeMaterializationFromManifest = (input: {
  rows: ControlPlaneStoreShape;
  source: Source;
  manifestEntries: Parameters<typeof materializationFromMcpManifestEntries>[0]["manifestEntries"];
}): Effect.Effect<void, Error, WorkspaceStorageServices> =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* requireRuntimeLocalWorkspace(input.source.workspaceId);
    const sourceArtifactStore = yield* SourceArtifactStore;
    const materialization = materializationFromMcpManifestEntries({
      recipeRevisionId: "src_recipe_rev_materialization" as never,
      endpoint: input.source.endpoint,
      manifestEntries: input.manifestEntries,
    });

    yield* sourceArtifactStore.write({
      context: runtimeLocalWorkspace.context,
      sourceId: input.source.id,
      artifact: sourceArtifactStore.build({
        source: input.source,
        materialization,
      }),
    });
  });

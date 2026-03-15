import {
  type ToolCatalogEntry,
  type ToolDescriptor,
} from "@executor/codemode-core";
import type {
  AccountId,
  Source,
  StoredSourceRecord,
  StoredSourceRecipeDocumentRecord,
  StoredSourceRecipeOperationRecord,
  StoredSourceRecipeSchemaBundleRecord,
  StoredSourceRecipeRevisionRecord,
  WorkspaceId,
} from "#schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { LocalSourceArtifactMissingError } from "./local-errors";
import {
  RuntimeLocalWorkspaceService,
  type RuntimeLocalWorkspaceState,
} from "./local-runtime-context";
import {
  SourceArtifactStore,
  type SourceArtifactStoreShape,
} from "./local-storage";
import { namespaceFromSourceName } from "./source-names";
import {
  getSourceAdapterForOperation,
  getSourceAdapterForSource,
} from "./source-adapters";
import type { SourceAdapterPersistedOperationMetadata } from "./source-adapters/types";
import { firstSchemaBundle } from "./source-adapters/shared";
import {
  RuntimeSourceStoreService,
  type RuntimeSourceStore,
} from "./source-store";

type RecipeManifest = unknown | null;

export type LoadedSourceRecipe = {
  source: Source;
  sourceRecord: StoredSourceRecord;
  revision: StoredSourceRecipeRevisionRecord;
  documents: readonly StoredSourceRecipeDocumentRecord[];
  schemaBundles: readonly StoredSourceRecipeSchemaBundleRecord[];
  operations: readonly StoredSourceRecipeOperationRecord[];
  manifest: RecipeManifest;
};

export type LoadedSourceRecipeTool = {
  path: string;
  searchNamespace: string;
  searchText: string;
  source: Source;
  sourceRecord: StoredSourceRecord;
  revision: StoredSourceRecipeRevisionRecord;
  operation: StoredSourceRecipeOperationRecord;
  metadata: SourceAdapterPersistedOperationMetadata;
  schemaBundleId: string | null;
  manifest: RecipeManifest;
  descriptor: ToolDescriptor;
};

export type LoadedSourceRecipeToolIndexEntry = {
  path: string;
  searchNamespace: string;
  searchText: string;
  source: Source;
  sourceRecord: StoredSourceRecord;
  operation: StoredSourceRecipeOperationRecord;
  metadata: SourceAdapterPersistedOperationMetadata;
  schemaBundleId: string | null;
  descriptor: ToolDescriptor;
};

export const recipeToolCatalogEntry = (input: {
  tool: LoadedSourceRecipeToolIndexEntry;
  score: (queryTokens: readonly string[]) => number;
}): ToolCatalogEntry => ({
  descriptor: input.tool.descriptor,
  namespace: input.tool.searchNamespace,
  searchText: input.tool.searchText,
  score: input.score,
});

const parseManifestForRecipe = (input: {
  source: Source;
  revision: StoredSourceRecipeRevisionRecord;
}): Effect.Effect<RecipeManifest, Error, never> =>
  getSourceAdapterForSource(input.source).parseManifest({
    source: input.source,
    manifestJson: input.revision.manifestJson,
  });

const catalogNamespaceFromPath = (path: string): string => {
  const [first, second] = path.split(".");
  return second ? `${first}.${second}` : first;
};

export const recipeToolPath = (input: {
  source: Source;
  operation: StoredSourceRecipeOperationRecord;
}): string => {
  const namespace = input.source.namespace ?? namespaceFromSourceName(input.source.name);
  return namespace ? `${namespace}.${input.operation.toolId}` : input.operation.toolId;
};

export const recipeToolSearchNamespace = (input: {
  source: Source;
  path: string;
  operation: StoredSourceRecipeOperationRecord;
}): string =>
  getSourceAdapterForOperation(input.operation).searchNamespace?.({
    source: input.source,
    path: input.path,
    operation: input.operation,
  })
  ?? catalogNamespaceFromPath(input.path);

export const recipeToolDescriptor = (input: {
  source: Source;
  operation: StoredSourceRecipeOperationRecord;
  path: string;
  schemaBundleId?: string | null;
  includeSchemas: boolean;
}): ToolDescriptor =>
  getSourceAdapterForOperation(input.operation).createToolDescriptor(input);

export const recipeToolMetadata = (input: {
  source: Source;
  operation: StoredSourceRecipeOperationRecord;
  path: string;
}): Effect.Effect<SourceAdapterPersistedOperationMetadata, Error, never> =>
  getSourceAdapterForOperation(input.operation).describePersistedOperation(input);

const sourceRecipeDocumentForSource = (input: {
  source: Source;
  documents: readonly StoredSourceRecipeDocumentRecord[];
}): StoredSourceRecipeDocumentRecord | null => {
  const preferredKind = getSourceAdapterForSource(input.source).primaryDocumentKind;

  if (preferredKind === null) {
    return null;
  }

  return input.documents.find((document) => document.documentKind === preferredKind) ?? null;
};

export const recipePrimaryDocumentText = (input: {
  source: Source;
  documents: readonly StoredSourceRecipeDocumentRecord[];
}): string | null =>
  sourceRecipeDocumentForSource(input)?.contentText ?? null;

const primarySchemaBundleForRevision = (input: {
  source: Source;
  schemaBundles: readonly StoredSourceRecipeSchemaBundleRecord[];
}): StoredSourceRecipeSchemaBundleRecord | null => {
  const selected = firstSchemaBundle({
    schemaBundles: input.schemaBundles.map((schemaBundle) => ({
      id: schemaBundle.id,
      kind: schemaBundle.bundleKind,
      hash: schemaBundle.contentHash,
      refsJson: schemaBundle.refsJson,
    })),
    preferredKind: getSourceAdapterForSource(input.source).primarySchemaBundleKind,
  });

  return selected
    ? input.schemaBundles.find((schemaBundle) => schemaBundle.id === selected.id) ?? null
    : null;
};

const sourceRecordFromRecipeArtifact = (input: {
  source: Source;
  artifact: {
    recipeId: StoredSourceRecord["recipeId"];
    revision: StoredSourceRecipeRevisionRecord;
  };
}): StoredSourceRecord => ({
  id: input.source.id,
  workspaceId: input.source.workspaceId,
  recipeId: input.artifact.recipeId,
  recipeRevisionId: input.artifact.revision.id,
  name: input.source.name,
  kind: input.source.kind,
  endpoint: input.source.endpoint,
  status: input.source.status,
  enabled: input.source.enabled,
  namespace: input.source.namespace,
  importAuthPolicy: input.source.importAuthPolicy,
  bindingConfigJson: getSourceAdapterForSource(input.source).serializeBindingConfig(input.source),
  sourceHash: input.source.sourceHash,
  lastError: input.source.lastError,
  createdAt: input.source.createdAt,
  updatedAt: input.source.updatedAt,
});

type RuntimeSourceRecipeStoreShape = {
  loadWorkspaceSourceRecipes: (input: {
    workspaceId: WorkspaceId;
    actorAccountId?: AccountId | null;
  }) => Effect.Effect<readonly LoadedSourceRecipe[], Error, never>;
  loadSourceWithRecipe: (input: {
    workspaceId: WorkspaceId;
    sourceId: Source["id"];
    actorAccountId?: AccountId | null;
  }) => Effect.Effect<LoadedSourceRecipe, Error | LocalSourceArtifactMissingError, never>;
  loadWorkspaceSourceRecipeToolIndex: (input: {
    workspaceId: WorkspaceId;
    actorAccountId?: AccountId | null;
    includeSchemas: boolean;
  }) => Effect.Effect<readonly LoadedSourceRecipeToolIndexEntry[], Error, never>;
  loadWorkspaceSourceRecipeToolByPath: (input: {
    workspaceId: WorkspaceId;
    path: string;
    actorAccountId?: AccountId | null;
    includeSchemas: boolean;
  }) => Effect.Effect<LoadedSourceRecipeToolIndexEntry | null, Error, never>;
  loadWorkspaceSchemaBundle: (input: {
    workspaceId: WorkspaceId;
    id: string;
  }) => Effect.Effect<
    { id: string; kind: string; hash: string; refsJson: string } | null,
    Error,
    never
  >;
};

export type RuntimeSourceRecipeStore = RuntimeSourceRecipeStoreShape;

export class RuntimeSourceRecipeStoreService extends Context.Tag(
  "#runtime/RuntimeSourceRecipeStoreService",
)<RuntimeSourceRecipeStoreService, RuntimeSourceRecipeStoreShape>() {}

type RuntimeSourceRecipeStoreDeps = {
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState;
  sourceStore: RuntimeSourceStore;
  sourceArtifactStore: SourceArtifactStoreShape;
};

type SourceRecipeRuntimeServices =
  | RuntimeLocalWorkspaceService
  | RuntimeSourceStoreService
  | SourceArtifactStore;

const ensureRuntimeRecipeWorkspace = (
  deps: RuntimeSourceRecipeStoreDeps,
  workspaceId: WorkspaceId,
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

const loadWorkspaceSourceRecipesWithDeps = (deps: RuntimeSourceRecipeStoreDeps, input: {
  workspaceId: WorkspaceId;
  actorAccountId?: AccountId | null;
}): Effect.Effect<readonly LoadedSourceRecipe[], Error, never> =>
  Effect.gen(function* () {
    const workspaceContext = yield* ensureRuntimeRecipeWorkspace(
      deps,
      input.workspaceId,
    );
    const sources = yield* deps.sourceStore.loadSourcesInWorkspace(
      input.workspaceId,
      {
        actorAccountId: input.actorAccountId,
      },
    );
    const localRecipes = yield* Effect.forEach(sources, (source) =>
      Effect.gen(function* () {
        const artifact = yield* deps.sourceArtifactStore.read({
          context: workspaceContext,
          sourceId: source.id,
        });
        if (artifact === null) {
          return null;
        }

        const manifest = yield* parseManifestForRecipe({
          source,
          revision: artifact.revision,
        });

        return {
          source,
          sourceRecord: sourceRecordFromRecipeArtifact({ source, artifact }),
          revision: artifact.revision,
          documents: artifact.documents,
          schemaBundles: artifact.schemaBundles,
          operations: artifact.operations,
          manifest,
        } satisfies LoadedSourceRecipe;
      }),
    );
    return localRecipes.filter((recipe): recipe is LoadedSourceRecipe => recipe !== null);
  });

const loadSourceWithRecipeWithDeps = (deps: RuntimeSourceRecipeStoreDeps, input: {
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
  actorAccountId?: AccountId | null;
}): Effect.Effect<LoadedSourceRecipe, Error | LocalSourceArtifactMissingError, never> =>
  Effect.gen(function* () {
    const workspaceContext = yield* ensureRuntimeRecipeWorkspace(
      deps,
      input.workspaceId,
    );
    const source = yield* deps.sourceStore.loadSourceById({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      actorAccountId: input.actorAccountId,
    });
    const artifact = yield* deps.sourceArtifactStore.read({
      context: workspaceContext,
      sourceId: source.id,
    });
    if (artifact === null) {
      return yield* Effect.fail(
        new LocalSourceArtifactMissingError({
          message: `Recipe artifact missing for source ${input.sourceId}`,
          sourceId: input.sourceId,
        }),
      );
    }

    const manifest = yield* parseManifestForRecipe({
      source,
      revision: artifact.revision,
    });

    return {
      source,
      sourceRecord: sourceRecordFromRecipeArtifact({ source, artifact }),
      revision: artifact.revision,
      documents: artifact.documents,
      schemaBundles: artifact.schemaBundles,
      operations: artifact.operations,
      manifest,
    } satisfies LoadedSourceRecipe;
  });

export const loadWorkspaceSourceRecipes = (input: {
  workspaceId: WorkspaceId;
  actorAccountId?: AccountId | null;
}): Effect.Effect<readonly LoadedSourceRecipe[], Error, SourceRecipeRuntimeServices> =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* RuntimeLocalWorkspaceService;
    const sourceStore = yield* RuntimeSourceStoreService;
    const sourceArtifactStore = yield* SourceArtifactStore;

    return yield* loadWorkspaceSourceRecipesWithDeps(
      {
        runtimeLocalWorkspace,
        sourceStore,
        sourceArtifactStore,
      },
      input,
    );
  });

export const loadSourceWithRecipe = (input: {
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
  actorAccountId?: AccountId | null;
}): Effect.Effect<
  LoadedSourceRecipe,
  Error | LocalSourceArtifactMissingError,
  SourceRecipeRuntimeServices
> =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* RuntimeLocalWorkspaceService;
    const sourceStore = yield* RuntimeSourceStoreService;
    const sourceArtifactStore = yield* SourceArtifactStore;

    return yield* loadSourceWithRecipeWithDeps(
      {
        runtimeLocalWorkspace,
        sourceStore,
        sourceArtifactStore,
      },
      input,
    );
  });

export const expandRecipeTools = (input: {
  recipes: readonly LoadedSourceRecipe[];
  includeSchemas: boolean;
}): Effect.Effect<readonly LoadedSourceRecipeTool[], Error, never> =>
  Effect.map(
    Effect.forEach(input.recipes, (recipe) =>
      Effect.forEach(recipe.operations, (operation) =>
        Effect.gen(function* () {
          const path = recipeToolPath({
            source: recipe.source,
            operation,
          });
          const searchNamespace = recipeToolSearchNamespace({
            source: recipe.source,
            path,
            operation,
          });
          const schemaBundleId = primarySchemaBundleForRevision({
            source: recipe.source,
            schemaBundles: recipe.schemaBundles,
          })?.id ?? null;
          const metadata = yield* recipeToolMetadata({
            source: recipe.source,
            operation,
            path,
          });

          return {
            path,
            searchNamespace,
            searchText: [
              path,
              searchNamespace,
              recipe.source.name,
              metadata.searchText,
            ]
              .filter((part) => part.length > 0)
              .join(" ")
              .toLowerCase(),
            source: recipe.source,
            sourceRecord: recipe.sourceRecord,
            revision: recipe.revision,
            operation,
            metadata,
            schemaBundleId,
            manifest: recipe.manifest,
            descriptor: recipeToolDescriptor({
              source: recipe.source,
              operation,
              path,
              schemaBundleId,
              includeSchemas: input.includeSchemas,
            }),
          } satisfies LoadedSourceRecipeTool;
        })
      ),
    ),
    (recipes) => recipes.flat(),
  );

export const loadWorkspaceSourceRecipeToolIndex = (input: {
  workspaceId: WorkspaceId;
  actorAccountId?: AccountId | null;
  includeSchemas: boolean;
}): Effect.Effect<
  readonly LoadedSourceRecipeToolIndexEntry[],
  Error,
  SourceRecipeRuntimeServices
> =>
  Effect.gen(function* () {
    const recipes = yield* loadWorkspaceSourceRecipes({
      workspaceId: input.workspaceId,
      actorAccountId: input.actorAccountId,
    });
    const tools = yield* expandRecipeTools({
      recipes,
      includeSchemas: input.includeSchemas,
    });
    return tools.map((tool) => ({
      path: tool.path,
      searchNamespace: tool.searchNamespace,
      searchText: tool.searchText,
      source: tool.source,
      sourceRecord: tool.sourceRecord,
      operation: tool.operation,
      metadata: tool.metadata,
      schemaBundleId: tool.schemaBundleId,
      descriptor: tool.descriptor,
    }));
  });

export const loadWorkspaceSourceRecipeToolByPath = (input: {
  workspaceId: WorkspaceId;
  path: string;
  actorAccountId?: AccountId | null;
  includeSchemas: boolean;
}): Effect.Effect<
  LoadedSourceRecipeToolIndexEntry | null,
  Error,
  SourceRecipeRuntimeServices
> =>
  Effect.gen(function* () {
    const recipes = yield* loadWorkspaceSourceRecipes({
      workspaceId: input.workspaceId,
      actorAccountId: input.actorAccountId,
    });
    const tools = yield* expandRecipeTools({
      recipes,
      includeSchemas: input.includeSchemas,
    });
    const tool = tools.find((entry) => entry.path === input.path) ?? null;
    return tool
      ? {
          path: tool.path,
          searchNamespace: tool.searchNamespace,
          searchText: tool.searchText,
          source: tool.source,
          sourceRecord: tool.sourceRecord,
          operation: tool.operation,
          metadata: tool.metadata,
          schemaBundleId: tool.schemaBundleId,
          descriptor: tool.descriptor,
        }
      : null;
  });

export const RuntimeSourceRecipeStoreLive = Layer.effect(
  RuntimeSourceRecipeStoreService,
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* RuntimeLocalWorkspaceService;
    const sourceStore = yield* RuntimeSourceStoreService;
    const sourceArtifactStore = yield* SourceArtifactStore;

    const deps: RuntimeSourceRecipeStoreDeps = {
      runtimeLocalWorkspace,
      sourceStore,
      sourceArtifactStore,
    };

    return RuntimeSourceRecipeStoreService.of({
      loadWorkspaceSourceRecipes: (input) =>
        loadWorkspaceSourceRecipesWithDeps(deps, input),
      loadSourceWithRecipe: (input) =>
        loadSourceWithRecipeWithDeps(deps, input),
      loadWorkspaceSourceRecipeToolIndex: (input) =>
        Effect.gen(function* () {
          const recipes = yield* loadWorkspaceSourceRecipesWithDeps(deps, input);
          const tools = yield* expandRecipeTools({
            recipes,
            includeSchemas: input.includeSchemas,
          });
          return tools.map((tool) => ({
            path: tool.path,
            searchNamespace: tool.searchNamespace,
            searchText: tool.searchText,
            source: tool.source,
            sourceRecord: tool.sourceRecord,
            operation: tool.operation,
            metadata: tool.metadata,
            schemaBundleId: tool.schemaBundleId,
            descriptor: tool.descriptor,
          }));
        }),
      loadWorkspaceSourceRecipeToolByPath: (input) =>
        Effect.gen(function* () {
          const recipes = yield* loadWorkspaceSourceRecipesWithDeps(deps, input);
          const tools = yield* expandRecipeTools({
            recipes,
            includeSchemas: input.includeSchemas,
          });
          const tool = tools.find((entry) => entry.path === input.path) ?? null;
          return tool
            ? {
                path: tool.path,
                searchNamespace: tool.searchNamespace,
                searchText: tool.searchText,
                source: tool.source,
                sourceRecord: tool.sourceRecord,
                operation: tool.operation,
                metadata: tool.metadata,
                schemaBundleId: tool.schemaBundleId,
                descriptor: tool.descriptor,
              }
            : null;
        }),
      loadWorkspaceSchemaBundle: (input) =>
        Effect.gen(function* () {
          const recipes = yield* loadWorkspaceSourceRecipesWithDeps(deps, {
            workspaceId: input.workspaceId,
          });
          const localBundle = recipes
            .flatMap((recipe) => recipe.schemaBundles)
            .find((schemaBundle) => schemaBundle.id === input.id);
          return localBundle
            ? {
                id: localBundle.id,
                kind: localBundle.bundleKind,
                hash: localBundle.contentHash,
                refsJson: localBundle.refsJson,
              }
            : null;
        }),
    });
  }),
);

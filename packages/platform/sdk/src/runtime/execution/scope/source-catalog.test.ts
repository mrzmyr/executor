import {
  describe,
  expect,
  it,
} from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  createScopeSourceCatalog,
} from "./source-catalog";

const makeLoadedCatalog = (input: {
  sourceId: string;
  toolPaths: ReadonlyArray<string>;
  enabled?: boolean;
  status?: "connected" | "error";
}) => ({
  source: {
    id: input.sourceId,
    scopeId: "ws_test",
    name: input.sourceId,
    kind: "openapi",
    endpoint: `https://example.test/${input.sourceId}`,
    status: input.status ?? "connected",
    enabled: input.enabled ?? true,
    namespace: null,
    bindingVersion: 1,
    binding: {},
    importAuthPolicy: "reuse_runtime",
    importAuth: {
      kind: "none",
    },
    auth: {
      kind: "none",
    },
    sourceHash: null,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
  },
  projected: {
    toolDescriptors: Object.fromEntries(
      input.toolPaths.map((path, index) => [
        `cap_${index}`,
        {
          toolPath: path.split("."),
        },
      ]),
    ),
  },
}) as any;

const noopScopeConfigStore = {
  load: () => Effect.die("unexpected config load"),
  writeProject: () => Effect.void,
  resolveRelativePath: (path: string) => Effect.succeed(path),
} as any;

const noopScopeStateStore = {
  load: () => Effect.die("unexpected scope state load"),
  write: () => Effect.void,
} as any;

const noopSourceArtifactStore = {
  build: () => Effect.die("unexpected source artifact build"),
  read: () => Effect.die("unexpected source artifact read"),
  write: () => Effect.void,
  remove: () => Effect.void,
} as any;

describe("scope source catalog", () => {
  it.effect("lists namespaces from projected tool paths without loading the tool index", () =>
    Effect.gen(function* () {
      const catalog = createScopeSourceCatalog({
        scopeId: "ws_test" as any,
        actorScopeId: "acc_test" as any,
        sourceCatalogStore: {
          loadWorkspaceSourceCatalogs: () => Effect.succeed([
            makeLoadedCatalog({
              sourceId: "github",
              toolPaths: [
                "github.repos.get",
                "github.repos.list",
                "github.issues.get",
              ],
            }),
            makeLoadedCatalog({
              sourceId: "linear",
              toolPaths: [
                "linear.issue.create",
              ],
            }),
            makeLoadedCatalog({
              sourceId: "disabled",
              toolPaths: [
                "disabled.admin.delete",
              ],
              enabled: false,
            }),
          ]),
          loadWorkspaceSourceCatalogToolIndex: () => Effect.die("unexpected tool index load"),
          loadWorkspaceSourceCatalogToolByPath: () => Effect.die("unexpected tool lookup"),
        } as any,
        scopeConfigStore: noopScopeConfigStore,
        scopeStateStore: noopScopeStateStore,
        sourceArtifactStore: noopSourceArtifactStore,
        runtimeLocalScope: null,
      });

      const namespaces = yield* catalog.listNamespaces({ limit: 10 });

      expect(namespaces).toEqual([
        {
          namespace: "github.issues",
          toolCount: 1,
        },
        {
          namespace: "github.repos",
          toolCount: 2,
        },
        {
          namespace: "linear.issue",
          toolCount: 1,
        },
      ]);
    }));
});

import type { LocalInstallation, LocalExecutorConfig } from "#schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type {
  LoadedLocalExecutorConfig,
  ResolvedLocalWorkspaceContext,
} from "./local-config";
import {
  loadLocalExecutorConfig,
  resolveConfigRelativePath,
  writeProjectLocalExecutorConfig,
} from "./local-config";
import {
  getOrProvisionLocalInstallation,
  loadLocalInstallation,
} from "./local-installation";
import type {
  LocalSourceArtifact,
} from "./local-source-artifacts";
import {
  buildLocalSourceArtifact,
  readLocalSourceArtifact,
  removeLocalSourceArtifact,
  writeLocalSourceArtifact,
} from "./local-source-artifacts";
import type { LocalWorkspaceState } from "./local-workspace-state";
import {
  loadLocalWorkspaceState,
  writeLocalWorkspaceState,
} from "./local-workspace-state";
import type { SourceRecipeMaterialization } from "./source-recipe-support";
import type { Source } from "#schema";

export type InstallationStoreShape = {
  load: (
    context: ResolvedLocalWorkspaceContext,
  ) => Effect.Effect<LocalInstallation, never, never>;
  getOrProvision: (input: {
    context: ResolvedLocalWorkspaceContext;
  }) => Effect.Effect<LocalInstallation, never, never>;
};

export class InstallationStore extends Context.Tag(
  "#runtime/InstallationStore",
)<InstallationStore, InstallationStoreShape>() {}

export type WorkspaceConfigStoreShape = {
  load: (
    context: ResolvedLocalWorkspaceContext,
  ) => Effect.Effect<LoadedLocalExecutorConfig, Error, never>;
  writeProject: (input: {
    context: ResolvedLocalWorkspaceContext;
    config: LocalExecutorConfig;
  }) => Effect.Effect<void, Error, never>;
  resolveRelativePath: (input: { path: string; workspaceRoot: string }) => string;
};

export class WorkspaceConfigStore extends Context.Tag(
  "#runtime/WorkspaceConfigStore",
)<WorkspaceConfigStore, WorkspaceConfigStoreShape>() {}

export type WorkspaceStateStoreShape = {
  load: (
    context: ResolvedLocalWorkspaceContext,
  ) => Effect.Effect<LocalWorkspaceState, Error, never>;
  write: (input: {
    context: ResolvedLocalWorkspaceContext;
    state: LocalWorkspaceState;
  }) => Effect.Effect<void, Error, never>;
};

export class WorkspaceStateStore extends Context.Tag(
  "#runtime/WorkspaceStateStore",
)<WorkspaceStateStore, WorkspaceStateStoreShape>() {}

export type SourceArtifactStoreShape = {
  build: (input: {
    source: Source;
    materialization: SourceRecipeMaterialization;
  }) => LocalSourceArtifact;
  read: (input: {
    context: ResolvedLocalWorkspaceContext;
    sourceId: string;
  }) => Effect.Effect<LocalSourceArtifact | null, Error, never>;
  write: (input: {
    context: ResolvedLocalWorkspaceContext;
    sourceId: string;
    artifact: LocalSourceArtifact;
  }) => Effect.Effect<void, Error, never>;
  remove: (input: {
    context: ResolvedLocalWorkspaceContext;
    sourceId: string;
  }) => Effect.Effect<void, Error, never>;
};

export class SourceArtifactStore extends Context.Tag(
  "#runtime/SourceArtifactStore",
)<SourceArtifactStore, SourceArtifactStoreShape>() {}

export type LocalStorageServices =
  | InstallationStore
  | WorkspaceConfigStore
  | WorkspaceStateStore
  | SourceArtifactStore;

export type WorkspaceStorageServices =
  | WorkspaceConfigStore
  | WorkspaceStateStore
  | SourceArtifactStore;

export const LocalInstallationStore: InstallationStoreShape = {
  load: loadLocalInstallation,
  getOrProvision: getOrProvisionLocalInstallation,
};

export const LocalInstallationStoreLive = Layer.succeed(
  InstallationStore,
  LocalInstallationStore,
);

export const LocalWorkspaceConfigStore: WorkspaceConfigStoreShape = {
  load: loadLocalExecutorConfig,
  writeProject: writeProjectLocalExecutorConfig,
  resolveRelativePath: resolveConfigRelativePath,
};

export const LocalWorkspaceConfigStoreLive = Layer.succeed(
  WorkspaceConfigStore,
  LocalWorkspaceConfigStore,
);

export const LocalWorkspaceStateStore: WorkspaceStateStoreShape = {
  load: loadLocalWorkspaceState,
  write: writeLocalWorkspaceState,
};

export const LocalWorkspaceStateStoreLive = Layer.succeed(
  WorkspaceStateStore,
  LocalWorkspaceStateStore,
);

export const LocalSourceArtifactStore: SourceArtifactStoreShape = {
  build: buildLocalSourceArtifact,
  read: readLocalSourceArtifact,
  write: writeLocalSourceArtifact,
  remove: removeLocalSourceArtifact,
};

export const LocalSourceArtifactStoreLive = Layer.succeed(
  SourceArtifactStore,
  LocalSourceArtifactStore,
);

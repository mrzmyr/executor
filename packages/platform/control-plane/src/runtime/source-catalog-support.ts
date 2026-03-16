import { sha256Hex } from "@executor/codemode-core";
import { createCatalogSnapshotV1FromFragments } from "../ir/catalog";
import type {
  CatalogFragmentV1,
  CatalogSnapshotV1,
  ImportMetadata,
} from "../ir/model";

export const normalizeSearchText = (
  ...parts: ReadonlyArray<string | null | undefined>
): string =>
  parts
    .flatMap((part) => (part ? [part.trim()] : []))
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

export const contentHash = (value: string): string => sha256Hex(value);

export type SourceCatalogSyncResult = {
  fragment: CatalogFragmentV1;
  importMetadata: ImportMetadata;
  sourceHash: string | null;
};

export const createSourceCatalogSyncResult = (
  input: SourceCatalogSyncResult,
): SourceCatalogSyncResult => input;

export const snapshotFromSourceCatalogSyncResult = (
  syncResult: SourceCatalogSyncResult,
): CatalogSnapshotV1 =>
  createCatalogSnapshotV1FromFragments({
    import: syncResult.importMetadata,
    fragments: [syncResult.fragment],
  });

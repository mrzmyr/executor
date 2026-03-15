import { sha256Hex } from "@executor/codemode-core";

import type {
  StoredSourceRecipeDocumentRecord,
  StoredSourceRecipeOperationRecord,
  StoredSourceRecipeSchemaBundleRecord,
} from "#schema";

export const normalizeSearchText = (
  ...parts: ReadonlyArray<string | null | undefined>
): string =>
  parts
    .flatMap((part) => (part ? [part.trim()] : []))
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

export const contentHash = (value: string): string => sha256Hex(value);

export type SourceRecipeMaterialization = {
  manifestJson: string | null;
  manifestHash: string | null;
  sourceHash: string | null;
  documents: readonly StoredSourceRecipeDocumentRecord[];
  schemaBundles: readonly StoredSourceRecipeSchemaBundleRecord[];
  operations: readonly StoredSourceRecipeOperationRecord[];
};

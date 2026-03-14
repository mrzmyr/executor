import { describe, expect, it } from "@effect/vitest";
import * as Either from "effect/Either";
import * as Schema from "effect/Schema";

import {
  StoredSourceRecipeOperationRecordSchema,
} from "./index";

describe("control-plane-schema", () => {
  it("accepts canonical source recipe operation rows and rejects invalid transport kinds", () => {
    const decode = Schema.decodeUnknownEither(StoredSourceRecipeOperationRecordSchema);

    const operationRecord = decode({
      id: "src_recipe_op_1",
      recipeRevisionId: "src_recipe_rev_1",
      operationKey: "getRepo",
      transportKind: "http",
      toolId: "getRepo",
      title: "Get Repo",
      description: "Read a repository",
      operationKind: "read",
      searchText: "get repo",
      inputSchemaJson: null,
      outputSchemaJson: null,
      providerKind: "openapi",
      providerDataJson: JSON.stringify({
        kind: "openapi",
      }),
      createdAt: 1,
      updatedAt: 1,
    });

    expect(Either.isRight(operationRecord)).toBe(true);

    const invalidRecord = decode({
      id: "src_recipe_op_2",
      recipeRevisionId: "src_recipe_rev_1",
      operationKey: "viewer",
      transportKind: "ftp",
      toolId: "viewer",
      title: "Viewer",
      description: null,
      operationKind: "read",
      searchText: "viewer",
      inputSchemaJson: null,
      outputSchemaJson: null,
      providerKind: "graphql",
      providerDataJson: JSON.stringify({
        kind: "graphql",
      }),
      createdAt: 1,
      updatedAt: 1,
    });

    expect(Either.isLeft(invalidRecord)).toBe(true);
  });
});

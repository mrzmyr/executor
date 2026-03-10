import { describe, expect, it } from "@effect/vitest";
import * as Either from "effect/Either";
import * as Schema from "effect/Schema";

import {
  PermissionValues,
  RolePermissions,
  StoredSourceRecipeOperationRecordSchema,
} from "./index";

describe("control-plane-schema", () => {
  it("exposes stable permission and role mappings", () => {
    expect(PermissionValues).toContain("organizations:manage");
    expect(RolePermissions.viewer).toContain("workspace:read");
    expect(RolePermissions.editor).toContain("sources:write");
    expect(RolePermissions.owner).toContain("policies:manage");
  });

  it("enforces provider-specific source recipe operation shapes", () => {
    const decode = Schema.decodeUnknownEither(StoredSourceRecipeOperationRecordSchema);

    const openApiRecord = decode({
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
      providerDataJson: null,
      mcpToolName: null,
      openApiMethod: "get",
      openApiPathTemplate: "/repos/{owner}/{repo}",
      openApiOperationHash: "hash",
      openApiRawToolId: "repos_getRepo",
      openApiOperationId: "repos.getRepo",
      openApiTagsJson: "[]",
      openApiRequestBodyRequired: null,
      graphqlOperationType: null,
      graphqlOperationName: null,
      createdAt: 1,
      updatedAt: 1,
    });

    expect(Either.isRight(openApiRecord)).toBe(true);

    const invalidGraphqlRecord = decode({
      id: "src_recipe_op_2",
      recipeRevisionId: "src_recipe_rev_1",
      operationKey: "viewer",
      transportKind: "graphql",
      toolId: "viewer",
      title: "Viewer",
      description: null,
      operationKind: "read",
      searchText: "viewer",
      inputSchemaJson: null,
      outputSchemaJson: null,
      providerKind: "graphql",
      providerDataJson: null,
      mcpToolName: null,
      openApiMethod: "get",
      openApiPathTemplate: null,
      openApiOperationHash: null,
      openApiRawToolId: null,
      openApiOperationId: null,
      openApiTagsJson: null,
      openApiRequestBodyRequired: null,
      graphqlOperationType: "query",
      graphqlOperationName: "viewer",
      createdAt: 1,
      updatedAt: 1,
    });

    expect(Either.isLeft(invalidGraphqlRecord)).toBe(true);
  });
});

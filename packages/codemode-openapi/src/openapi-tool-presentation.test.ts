import { readFileSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { compileOpenApiToolDefinitions } from "./openapi-definitions";
import { extractOpenApiManifest } from "./openapi-extraction";
import { buildOpenApiToolPresentation } from "./openapi-tool-presentation";

const readFixture = (name: string): string =>
  readFileSync(
    new URL(`../../control-plane/src/runtime/fixtures/${name}`, import.meta.url),
    "utf8",
  );

describe("buildOpenApiToolPresentation", () => {
  it.effect(
    "resolves request and response schemas from ref hints for the real Neon OpenAPI spec",
    () =>
      Effect.gen(function* () {
        const specText = readFixture("neon-openapi.json");
        const manifest = yield* extractOpenApiManifest("neon", specText);
        const definition = compileOpenApiToolDefinitions(manifest).find(
          (candidate) => candidate.toolId === "apiKey.createApiKey",
        );

        expect(definition).toBeDefined();

        const presentation = buildOpenApiToolPresentation({
          definition: definition!,
          refHintTable: manifest.refHintTable,
        });

        expect(presentation.previewInputType).toContain("body");
        expect(presentation.previewInputType).toContain("key_name");
        expect(presentation.previewOutputType).toContain("key");
        expect(presentation.inputSchema).toMatchObject({
          type: "object",
          properties: {
            body: {
              type: "object",
              properties: {
                key_name: {
                  type: "string",
                },
              },
              required: ["key_name"],
            },
          },
          required: ["body"],
        });
        expect(presentation.outputSchema).toMatchObject({
          type: "object",
          properties: {
            id: {
              type: "integer",
            },
            key: {
              type: "string",
            },
            name: {
              type: "string",
            },
          },
        });
      }),
    120_000,
  );

  it.effect(
    "preserves response wrappers for response-only Neon operations",
    () =>
      Effect.gen(function* () {
        const specText = readFixture("neon-openapi.json");
        const manifest = yield* extractOpenApiManifest("neon", specText);
        const definition = compileOpenApiToolDefinitions(manifest).find(
          (candidate) => candidate.toolId === "apiKey.listApiKeys",
        );

        expect(definition).toBeDefined();

        const presentation = buildOpenApiToolPresentation({
          definition: definition!,
          refHintTable: manifest.refHintTable,
        });

        expect(presentation.previewInputType).toBe("unknown");
        expect(presentation.previewOutputType).toContain("id");
        expect(presentation.previewOutputType).toContain("name");
        expect(presentation.outputSchema).toMatchObject({
          type: "array",
          items: {
            type: "object",
            properties: {
              id: {
                type: "integer",
              },
              name: {
                type: "string",
              },
            },
          },
        });
      }),
    120_000,
  );
});

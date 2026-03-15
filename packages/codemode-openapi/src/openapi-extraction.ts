import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";

import { parseOpenApiDocument } from "./openapi-document";
import { extractOpenApiManifestJsonWithWasm } from "./openapi-extractor-wasm";
import {
  OpenApiToolManifestSchema,
  type OpenApiExtractedTool,
  type OpenApiJsonObject,
  type OpenApiSpecInput,
  type OpenApiToolManifest,
} from "./openapi-types";

type OpenApiExtractionStage = "validate" | "extract";

export class OpenApiExtractionError extends Data.TaggedError("OpenApiExtractionError")<{
  sourceName: string;
  stage: OpenApiExtractionStage;
  message: string;
  details: string | null;
}> {}

const manifestFromJsonSchema = Schema.parseJson(OpenApiToolManifestSchema);
const decodeManifestFromJson = Schema.decodeUnknown(manifestFromJsonSchema);

const toExtractionError = (
  sourceName: string,
  stage: OpenApiExtractionStage,
  cause: unknown,
): OpenApiExtractionError =>
  cause instanceof OpenApiExtractionError
    ? cause
    : new OpenApiExtractionError({
        sourceName,
        stage,
        message: "OpenAPI extraction failed",
        details: ParseResult.isParseError(cause)
          ? ParseResult.TreeFormatter.formatErrorSync(cause)
          : String(cause),
      });

const normalizeOpenApiDocumentText = (
  sourceName: string,
  openApiSpec: OpenApiSpecInput,
): Effect.Effect<string, OpenApiExtractionError> => {
  if (typeof openApiSpec === "string") {
    return Effect.succeed(openApiSpec);
  }

  return Effect.try({
    try: () => JSON.stringify(openApiSpec),
    catch: (cause) =>
      new OpenApiExtractionError({
        sourceName,
        stage: "validate",
        message: "Unable to serialize OpenAPI input",
        details: String(cause),
      }),
  });
};

const asObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const resolvePointerSegment = (segment: string): string =>
  segment.replaceAll("~1", "/").replaceAll("~0", "~");

const resolveLocalRef = (
  document: OpenApiJsonObject,
  value: unknown,
  activeRefs: ReadonlySet<string> = new Set<string>(),
): unknown => {
  const object = asObject(value);
  const ref = typeof object.$ref === "string" ? object.$ref : null;
  if (!ref || !ref.startsWith("#/") || activeRefs.has(ref)) {
    return value;
  }

  const resolved = ref
    .slice(2)
    .split("/")
    .reduce<unknown>((current, segment) => {
      if (current === undefined || current === null) {
        return undefined;
      }

      return asObject(current)[resolvePointerSegment(segment)];
    }, document);

  if (resolved === undefined) {
    return value;
  }

  const nextActiveRefs = new Set(activeRefs);
  nextActiveRefs.add(ref);

  const resolvedObject = asObject(resolveLocalRef(document, resolved, nextActiveRefs));
  const { $ref: _ignoredRef, ...rest } = object;

  return Object.keys(rest).length > 0
    ? { ...resolvedObject, ...rest }
    : resolvedObject;
};

const contentSchemaFromOperationContent = (
  content: unknown,
): unknown | undefined => {
  const entries = Object.entries(asObject(content));
  const preferredEntry = entries.find(([mediaType]) => mediaType === "application/json")
    ?? entries.find(([mediaType]) => mediaType.toLowerCase().includes("+json"))
    ?? entries.find(([mediaType]) => mediaType.toLowerCase().includes("json"));

  return preferredEntry ? asObject(preferredEntry[1]).schema : undefined;
};

const requestBodySchemaForTool = (
  document: OpenApiJsonObject,
  tool: OpenApiExtractedTool,
): unknown | undefined => {
  const operation = asObject(
    asObject(asObject(document.paths)[tool.path])[tool.method],
  );
  if (Object.keys(operation).length === 0) {
    return undefined;
  }

  const requestBody = resolveLocalRef(document, operation.requestBody);
  return contentSchemaFromOperationContent(asObject(requestBody).content);
};

const responseSchemaForTool = (
  document: OpenApiJsonObject,
  tool: OpenApiExtractedTool,
): unknown | undefined => {
  const operation = asObject(
    asObject(asObject(document.paths)[tool.path])[tool.method],
  );
  if (Object.keys(operation).length === 0) {
    return undefined;
  }

  const responseEntries = Object.entries(asObject(operation.responses));
  const preferredResponses = responseEntries
    .filter(([status]) => /^2\d\d$/.test(status))
    .sort(([left], [right]) => left.localeCompare(right));
  const fallbackResponses = responseEntries.filter(([status]) => status === "default");

  for (const [, responseValue] of [...preferredResponses, ...fallbackResponses]) {
    const response = resolveLocalRef(document, responseValue);
    const schema = contentSchemaFromOperationContent(asObject(response).content);
    if (schema !== undefined) {
      return schema;
    }
  }

  return undefined;
};

const enrichManifestFromDocument = (
  document: OpenApiJsonObject,
  manifest: OpenApiToolManifest,
): OpenApiToolManifest => ({
  ...manifest,
  tools: manifest.tools.map((tool) => {
    const inputSchema = tool.typing?.inputSchema ?? requestBodySchemaForTool(document, tool);
    const outputSchema = tool.typing?.outputSchema ?? responseSchemaForTool(document, tool);

    if (inputSchema === undefined && outputSchema === undefined) {
      return tool;
    }

    return {
      ...tool,
      typing: {
        ...(tool.typing ?? {}),
        ...(inputSchema !== undefined ? { inputSchema } : {}),
        ...(outputSchema !== undefined ? { outputSchema } : {}),
      },
    };
  }),
});

export const extractOpenApiManifest = (
  sourceName: string,
  openApiSpec: OpenApiSpecInput,
): Effect.Effect<OpenApiToolManifest, OpenApiExtractionError> =>
  Effect.gen(function* () {
    const openApiDocumentText = yield* normalizeOpenApiDocumentText(
      sourceName,
      openApiSpec,
    );

    const manifestJson = yield* Effect.tryPromise({
      try: () => extractOpenApiManifestJsonWithWasm(sourceName, openApiDocumentText),
      catch: (cause) => toExtractionError(sourceName, "extract", cause),
    });

    const manifest = yield* pipe(
      decodeManifestFromJson(manifestJson),
      Effect.mapError((cause) => toExtractionError(sourceName, "extract", cause)),
    );

    const parsedDocument = yield* Effect.try({
      try: () => parseOpenApiDocument(openApiDocumentText),
      catch: (cause) => toExtractionError(sourceName, "validate", cause),
    });

    return enrichManifestFromDocument(parsedDocument, manifest);
  });

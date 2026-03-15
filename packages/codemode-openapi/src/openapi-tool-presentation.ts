import * as Match from "effect/Match";
import { typeSignatureFromSchema } from "@executor/codemode-core";

import type {
  OpenApiExample,
  OpenApiInvocationPayload,
  OpenApiRefHintTable,
  OpenApiToolDocumentation,
  OpenApiToolProviderData,
} from "./openapi-types";
import {
  openApiProviderDataFromDefinition,
  type OpenApiToolDefinition,
} from "./openapi-definitions";
import {
  resolveSchemaWithRefHints,
  resolveTypingSchemasWithRefHints,
} from "./openapi-schema-refs";

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const isStrictEmptyObjectSchema = (value: unknown): boolean => {
  const schema = asRecord(value);
  if (schema.type !== "object" && schema.properties === undefined) {
    return false;
  }

  const properties = asRecord(schema.properties);
  return Object.keys(properties).length === 0 && schema.additionalProperties === false;
};

export const openApiOutputTypeSignatureFromSchema = (
  schema: unknown,
  maxLength: number = 320,
 ): string => {
  if (schema === undefined || schema === null) {
    return "void";
  }

  if (isStrictEmptyObjectSchema(schema)) {
    return "{}";
  }

  return typeSignatureFromSchema(schema, "unknown", maxLength);
};

const firstExample = (
  examples: ReadonlyArray<OpenApiExample> | undefined,
): OpenApiExample | undefined => examples?.[0];

const callInputSchemaFromInvocation = (input: {
  invocation: OpenApiInvocationPayload;
  requestBodySchema?: unknown;
}): Record<string, unknown> | undefined => {
  const invocation = input.invocation;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const parameter of invocation.parameters) {
    properties[parameter.name] = {
      type: "string",
    };
    if (parameter.required) {
      required.push(parameter.name);
    }
  }

  if (invocation.requestBody) {
    properties.body = input.requestBodySchema ?? {
      type: "object",
    };
    if (invocation.requestBody.required) {
      required.push("body");
    }
  }

  return Object.keys(properties).length > 0
    ? {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    }
    : undefined;
};

const schemaRefPlaceholder = (
  refHintKey: string | undefined,
): Record<string, string> | undefined =>
  typeof refHintKey === "string" && refHintKey.length > 0
    ? { $ref: refHintKey }
    : undefined;

const inferRefHintPlaceholders = (
  definition: OpenApiToolDefinition,
): {
  requestBodySchema?: Record<string, string>;
  outputSchema?: Record<string, string>;
} => {
  const refHintKeys = definition.typing?.refHintKeys ?? [];

  return Match.value(definition.invocation.requestBody).pipe(
    Match.when(null, () => ({
      outputSchema: schemaRefPlaceholder(refHintKeys[0]),
    })),
    Match.orElse(() => ({
      requestBodySchema: schemaRefPlaceholder(refHintKeys[0]),
      outputSchema: schemaRefPlaceholder(refHintKeys[1]),
    })),
  );
};

const resolvePresentationSchemas = (input: {
  definition: OpenApiToolDefinition;
  refHintTable?: Readonly<OpenApiRefHintTable>;
}): {
  inputSchema?: unknown;
  outputSchema?: unknown;
} => {
  const resolvedTyping = resolveTypingSchemasWithRefHints(
    input.definition.typing,
    input.refHintTable,
  );
  const inferredRefPlaceholders = inferRefHintPlaceholders(input.definition);
  const resolvedRequestBodySchema = resolveSchemaWithRefHints(
    inferredRefPlaceholders.requestBodySchema,
    input.refHintTable,
  );
  const requestBodySchema =
    resolvedTyping.inputSchema
    ?? (resolvedRequestBodySchema !== undefined && resolvedRequestBodySchema !== null
      ? resolvedRequestBodySchema
      : undefined);

  const inputSchema =
    input.definition.invocation.requestBody !== null
      ? callInputSchemaFromInvocation({
        invocation: input.definition.invocation,
        ...(requestBodySchema !== undefined
          ? { requestBodySchema }
          : {}),
      })
      : resolvedTyping.inputSchema
        ?? callInputSchemaFromInvocation({
          invocation: input.definition.invocation,
        });
  const outputSchema =
    resolvedTyping.outputSchema
    ?? resolveSchemaWithRefHints(
      inferredRefPlaceholders.outputSchema,
      input.refHintTable,
    );

  return {
    ...(inputSchema !== undefined && inputSchema !== null ? { inputSchema } : {}),
    ...(outputSchema !== undefined && outputSchema !== null ? { outputSchema } : {}),
  };
};

const buildExampleInput = (
  documentation: OpenApiToolDocumentation | undefined,
): Record<string, unknown> | undefined => {
  if (!documentation) {
    return undefined;
  }

  const input: Record<string, unknown> = {};

  for (const parameter of documentation.parameters) {
    const example = firstExample(parameter.examples);
    if (!example) {
      continue;
    }

    input[parameter.name] = JSON.parse(example.valueJson) as unknown;
  }

  const requestBodyExample = firstExample(documentation.requestBody?.examples);
  if (requestBodyExample) {
    input.body = JSON.parse(requestBodyExample.valueJson) as unknown;
  }

  return Object.keys(input).length > 0 ? input : undefined;
};

const buildExampleOutput = (
  documentation: OpenApiToolDocumentation | undefined,
): unknown | undefined => {
  const example = firstExample(documentation?.response?.examples)?.valueJson;
  return example ? JSON.parse(example) as unknown : undefined;
};

export type OpenApiToolPresentation = {
  previewInputType: string;
  previewOutputType: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  exampleInput?: unknown;
  exampleOutput?: unknown;
  providerData: OpenApiToolProviderData;
};

export const buildOpenApiToolPresentation = (input: {
  definition: OpenApiToolDefinition;
  refHintTable?: Readonly<OpenApiRefHintTable>;
}): OpenApiToolPresentation => {
  const { inputSchema, outputSchema } = resolvePresentationSchemas(input);
  const exampleInput = buildExampleInput(input.definition.documentation);
  const exampleOutput = buildExampleOutput(input.definition.documentation);

  return {
    previewInputType: typeSignatureFromSchema(inputSchema, "unknown", Infinity),
    previewOutputType: openApiOutputTypeSignatureFromSchema(outputSchema, Infinity),
    ...(inputSchema !== undefined ? { inputSchema } : {}),
    ...(outputSchema !== undefined ? { outputSchema } : {}),
    ...(exampleInput !== undefined ? { exampleInput } : {}),
    ...(exampleOutput !== undefined ? { exampleOutput } : {}),
    providerData: openApiProviderDataFromDefinition(input.definition),
  };
};

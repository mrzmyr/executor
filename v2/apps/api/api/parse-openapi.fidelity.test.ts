import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { parse as parseYaml } from "yaml";

import { extractOpenApiManifest } from "./parse-openapi";

const cloudflareSpecUrl = "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.yaml";
const vercelSpecUrl = "https://openapi.vercel.sh/";
const httpMethods = ["get", "put", "post", "delete", "patch", "head", "options", "trace"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseSpecDocument = (input: string): unknown => {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("Spec document is empty");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return parseYaml(trimmed);
  }
};

const loadSpec = async (url: string): Promise<unknown> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch spec ${url}: ${response.status} ${response.statusText}`);
  }

  return parseSpecDocument(await response.text());
};

const collectRefKeys = (value: unknown, refs: Set<string>): void => {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRefKeys(item, refs);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const refValue = value.$ref;
  if (typeof refValue === "string" && refValue.startsWith("#/")) {
    refs.add(refValue);
  }

  for (const nested of Object.values(value)) {
    collectRefKeys(nested, refs);
  }
};

const unescapeJsonPointer = (value: string): string =>
  value.replace(/~1/g, "/").replace(/~0/g, "~");

const getByJsonPointer = (root: unknown, pointer: string): unknown => {
  if (!pointer.startsWith("#/")) {
    return null;
  }

  const segments = pointer
    .slice(2)
    .split("/")
    .map((segment) => unescapeJsonPointer(segment));

  let current: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return null;
      }
      current = current[index];
      continue;
    }

    if (!isRecord(current) || !(segment in current)) {
      return null;
    }

    current = current[segment];
  }

  return current;
};

const resolveLocalRef = (root: unknown, value: unknown, depth = 0): unknown => {
  if (depth > 8 || !isRecord(value) || typeof value.$ref !== "string") {
    return value;
  }

  const resolved = getByJsonPointer(root, value.$ref);
  if (resolved === null) {
    return value;
  }

  return resolveLocalRef(root, resolved, depth + 1);
};

const extractSchemaFromContent = (content: unknown): unknown | null => {
  if (!isRecord(content)) {
    return null;
  }

  const jsonMedia =
    (content["application/json"] as Record<string, unknown> | undefined)
    ?? (content["application/*+json"] as Record<string, unknown> | undefined);

  if (jsonMedia && isRecord(jsonMedia.schema)) {
    return jsonMedia.schema;
  }

  for (const mediaType of Object.values(content)) {
    if (isRecord(mediaType) && isRecord(mediaType.schema)) {
      return mediaType.schema;
    }
  }

  return null;
};

const extractParameterSchema = (root: unknown, value: unknown): unknown => {
  const parameter = resolveLocalRef(root, value);
  if (!isRecord(parameter)) {
    return null;
  }

  if (isRecord(parameter.schema)) {
    return parameter.schema;
  }

  return extractSchemaFromContent(parameter.content);
};

const extractRequestBodySchema = (root: unknown, operation: Record<string, unknown>): unknown => {
  const requestBody = resolveLocalRef(root, operation.requestBody);
  if (!isRecord(requestBody)) {
    return null;
  }

  return extractSchemaFromContent(requestBody.content);
};

const extractResponseSchema = (root: unknown, operation: Record<string, unknown>): unknown => {
  const responses = resolveLocalRef(root, operation.responses);
  if (!isRecord(responses)) {
    return null;
  }

  const preferred = Object.keys(responses)
    .filter((key) => /^2\d\d$/.test(key))
    .sort();
  if ("default" in responses) {
    preferred.push("default");
  }

  for (const key of preferred) {
    const response = resolveLocalRef(root, responses[key]);
    if (!isRecord(response)) {
      continue;
    }

    const schema = extractSchemaFromContent(response.content);
    if (schema !== null) {
      return schema;
    }
  }

  return null;
};

const hasMeaningfulSchemaShape = (value: unknown): boolean => {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.$ref === "string") {
    return true;
  }

  if (typeof value.type === "string") {
    return true;
  }

  if (Array.isArray(value.enum) && value.enum.length > 0) {
    return true;
  }

  if (isRecord(value.properties) && Object.keys(value.properties).length > 0) {
    return true;
  }

  if (value.items !== undefined && value.items !== null) {
    return true;
  }

  if (Array.isArray(value.oneOf) || Array.isArray(value.anyOf) || Array.isArray(value.allOf)) {
    return true;
  }

  if (value.additionalProperties !== undefined) {
    return true;
  }

  return false;
};

const isUnknownLikeSchema = (value: unknown): boolean => !hasMeaningfulSchemaShape(value);

type OperationExpectation = {
  parameterSchemas: Record<string, unknown>;
  requestBodySchema: unknown;
  responseSchema: unknown;
};

const operationSignature = (method: string, path: string): string =>
  `${method.toLowerCase()} ${path}`;

const buildOperationExpectations = (spec: unknown): Map<string, OperationExpectation> => {
  if (!isRecord(spec) || !isRecord(spec.paths)) {
    throw new Error("Spec missing paths object");
  }

  const expectations = new Map<string, OperationExpectation>();

  for (const [path, pathItemValue] of Object.entries(spec.paths)) {
    if (!isRecord(pathItemValue)) {
      continue;
    }

    const pathLevelParameters = Array.isArray(pathItemValue.parameters)
      ? pathItemValue.parameters
      : [];

    for (const method of httpMethods) {
      const operationValue = pathItemValue[method];
      if (!isRecord(operationValue)) {
        continue;
      }

      const parameterSchemas: Record<string, unknown> = {};
      const operationLevelParameters = Array.isArray(operationValue.parameters)
        ? operationValue.parameters
        : [];

      const parameters = [...pathLevelParameters, ...operationLevelParameters];
      for (const parameter of parameters) {
        const resolved = resolveLocalRef(spec, parameter);
        if (!isRecord(resolved)) {
          continue;
        }

        const name = typeof resolved.name === "string" ? resolved.name.trim() : "";
        const location = typeof resolved.in === "string" ? resolved.in.trim().toLowerCase() : "";
        if (
          name.length === 0
          || (
            location !== "path"
            && location !== "query"
            && location !== "header"
            && location !== "cookie"
          )
        ) {
          continue;
        }

        const schema = extractParameterSchema(spec, resolved);
        if (schema !== null) {
          parameterSchemas[name] = schema;
        }
      }

      expectations.set(operationSignature(method, path), {
        parameterSchemas,
        requestBodySchema: extractRequestBodySchema(spec, operationValue),
        responseSchema: extractResponseSchema(spec, operationValue),
      });
    }
  }

  return expectations;
};

const assertManifestFidelityForSpec = (
  specName: string,
  spec: unknown,
): void => {
  const manifest = extractOpenApiManifest(specName, spec);
  const expectations = buildOperationExpectations(spec);

  for (const tool of manifest.tools) {
    const signature = operationSignature(tool.method, tool.path);
    const expectation = expectations.get(signature);
    expect(expectation, `Missing operation expectation for ${signature}`).toBeDefined();

    const inputSchema = tool.typing?.inputSchemaJson
      ? JSON.parse(tool.typing.inputSchemaJson)
      : null;
    const outputSchema = tool.typing?.outputSchemaJson
      ? JSON.parse(tool.typing.outputSchemaJson)
      : null;

    if (expectation) {
      const expectedParamSchemas = Object.entries(expectation.parameterSchemas);
      const hasStructuredParams = expectedParamSchemas.some(([, schema]) => hasMeaningfulSchemaShape(schema));
      const hasStructuredBody = hasMeaningfulSchemaShape(expectation.requestBodySchema);
      const hasStructuredOutput = hasMeaningfulSchemaShape(expectation.responseSchema);

      if (hasStructuredParams || hasStructuredBody) {
        expect(tool.typing?.inputSchemaJson, `Missing input schema for ${signature}`).toBeDefined();
        expect(isRecord(inputSchema)).toBe(true);
        expect(isRecord(inputSchema?.properties)).toBe(true);
      }

      if (hasStructuredParams && isRecord(inputSchema) && isRecord(inputSchema.properties)) {
        for (const [paramName, sourceSchema] of expectedParamSchemas) {
          if (!hasMeaningfulSchemaShape(sourceSchema)) {
            continue;
          }

          expect(
            inputSchema.properties[paramName],
            `Missing input property '${paramName}' for ${signature}`,
          ).toBeDefined();
          expect(
            isUnknownLikeSchema(inputSchema.properties[paramName]),
            `Unknown-like input schema for '${paramName}' in ${signature}`,
          ).toBe(false);
        }
      }

      if (hasStructuredBody && isRecord(inputSchema) && isRecord(inputSchema.properties)) {
        expect(inputSchema.properties.body, `Missing body schema for ${signature}`).toBeDefined();
        expect(
          isUnknownLikeSchema(inputSchema.properties.body),
          `Unknown-like body schema for ${signature}`,
        ).toBe(false);
      }

      if (hasStructuredOutput) {
        expect(tool.typing?.outputSchemaJson, `Missing output schema for ${signature}`).toBeDefined();
        expect(
          isUnknownLikeSchema(outputSchema),
          `Unknown-like output schema for ${signature}`,
        ).toBe(false);
      }
    }

    const refs = new Set<string>();
    if (inputSchema) {
      collectRefKeys(inputSchema, refs);
    }
    if (outputSchema) {
      collectRefKeys(outputSchema, refs);
    }

    for (const refKey of refs) {
      const resolvedRef = manifest.refHintTable[refKey];
      expect(resolvedRef, `Missing refHintTable entry ${refKey} for ${signature}`).toBeDefined();
      expect(() => JSON.parse(resolvedRef!)).not.toThrow();
    }
  }
};

describe("parse-openapi extractor fidelity against real specs", () => {
  it.effect("Cloudflare path params and output refs are preserved", () =>
    Effect.gen(function* () {
      const cloudflareSpec = yield* Effect.tryPromise(() => loadSpec(cloudflareSpecUrl));
      const manifest = extractOpenApiManifest("cloudflare", cloudflareSpec);

      expect(manifest.tools.length).toBeGreaterThan(2000);

      const accessDeleteTool = manifest.tools.find(
        (tool) =>
          tool.method === "delete"
          && tool.path === "/accounts/{account_id}/access/apps/{app_id}",
      );
      expect(accessDeleteTool).toBeDefined();
      expect(accessDeleteTool?.typing?.inputSchemaJson).toBeDefined();

      const inputSchema = JSON.parse(accessDeleteTool!.typing!.inputSchemaJson!);
      expect(inputSchema.type).toBe("object");
      expect(Array.isArray(inputSchema.required)).toBe(true);
      expect(inputSchema.required).toContain("account_id");
      expect(inputSchema.required).toContain("app_id");
      expect(isRecord(inputSchema.properties)).toBe(true);
      expect(isRecord(inputSchema.properties.account_id)).toBe(true);
      expect(isRecord(inputSchema.properties.app_id)).toBe(true);

      const ipDetailsTool = manifest.tools.find(
        (tool) =>
          tool.name.toLowerCase().includes("jd cloud ip details")
          || (tool.method === "get" && tool.path === "/ips"),
      );
      expect(ipDetailsTool).toBeDefined();
      expect(ipDetailsTool?.typing?.outputSchemaJson).toBeDefined();

      const outputSchema = JSON.parse(ipDetailsTool!.typing!.outputSchemaJson!);
      const outputRefs = new Set<string>();
      collectRefKeys(outputSchema, outputRefs);
      expect(outputRefs.size).toBeGreaterThan(0);

      for (const refKey of outputRefs) {
        const schemaJson = manifest.refHintTable[refKey];
        expect(schemaJson).toBeDefined();
        expect(() => JSON.parse(schemaJson)).not.toThrow();
      }
    }),
    30_000,
  );

  it.effect("Vercel extract keeps typed invocation + schema coverage", () =>
    Effect.gen(function* () {
      const vercelSpec = yield* Effect.tryPromise(() => loadSpec(vercelSpecUrl));
      const manifest = extractOpenApiManifest("vercel", vercelSpec);

      expect(manifest.tools.length).toBeGreaterThan(100);

      const toolWithPathParams = manifest.tools.find(
        (tool) => tool.invocation.parameters.some((parameter) => parameter.location === "path"),
      );
      expect(toolWithPathParams).toBeDefined();
      expect(toolWithPathParams?.typing?.inputSchemaJson).toBeDefined();

      const inputSchema = JSON.parse(toolWithPathParams!.typing!.inputSchemaJson!);
      expect(isRecord(inputSchema)).toBe(true);
      expect(inputSchema.type).toBe("object");
      expect(isRecord(inputSchema.properties)).toBe(true);

      for (const pathParameter of toolWithPathParams!.invocation.parameters.filter(
        (parameter) => parameter.location === "path",
      )) {
        expect(Array.isArray(inputSchema.required)).toBe(true);
        expect(inputSchema.required).toContain(pathParameter.name);
        expect(inputSchema.properties[pathParameter.name]).toBeDefined();
      }
    }),
    30_000,
  );

  it.effect("Cloudflare has no unknown-like schemas for structured operations", () =>
    Effect.gen(function* () {
      const cloudflareSpec = yield* Effect.tryPromise(() => loadSpec(cloudflareSpecUrl));
      assertManifestFidelityForSpec("cloudflare", cloudflareSpec);
    }),
    60_000,
  );

  it.effect("Vercel has no unknown-like schemas for structured operations", () =>
    Effect.gen(function* () {
      const vercelSpec = yield* Effect.tryPromise(() => loadSpec(vercelSpecUrl));
      assertManifestFidelityForSpec("vercel", vercelSpec);
    }),
    60_000,
  );
});

import { Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";

import type { StorageFailure } from "@executor/sdk";

import { OpenApiInvocationError } from "./errors";
import {
  type HeaderValue,
  type OperationBinding,
  InvocationResult,
  type OperationParameter,
} from "./types";

// ---------------------------------------------------------------------------
// Parameter reading
// ---------------------------------------------------------------------------

const CONTAINER_KEYS: Record<string, readonly string[]> = {
  path: ["path", "pathParams", "params"],
  query: ["query", "queryParams", "params"],
  header: ["headers", "header"],
  cookie: ["cookies", "cookie"],
};

const readParamValue = (args: Record<string, unknown>, param: OperationParameter): unknown => {
  const direct = args[param.name];
  if (direct !== undefined) return direct;

  for (const key of CONTAINER_KEYS[param.location] ?? []) {
    const container = args[key];
    if (typeof container === "object" && container !== null && !Array.isArray(container)) {
      const nested = (container as Record<string, unknown>)[param.name];
      if (nested !== undefined) return nested;
    }
  }

  return undefined;
};

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const resolvePath = Effect.fn("OpenApi.resolvePath")(function* (
  pathTemplate: string,
  args: Record<string, unknown>,
  parameters: readonly OperationParameter[],
) {
  let resolved = pathTemplate;

  for (const param of parameters) {
    if (param.location !== "path") continue;
    const value = readParamValue(args, param);
    if (value === undefined || value === null) {
      if (param.required) {
        return yield* new OpenApiInvocationError({
          message: `Missing required path parameter: ${param.name}`,
          statusCode: Option.none(),
        });
      }
      continue;
    }
    resolved = resolved.replaceAll(`{${param.name}}`, encodeURIComponent(String(value)));
  }

  const remaining = [...resolved.matchAll(/\{([^{}]+)\}/g)]
    .map((m) => m[1])
    .filter((v): v is string => typeof v === "string");

  for (const name of remaining) {
    const value = args[name];
    if (value !== undefined && value !== null) {
      resolved = resolved.replaceAll(`{${name}}`, encodeURIComponent(String(value)));
    }
  }

  const unresolved = [...resolved.matchAll(/\{([^{}]+)\}/g)]
    .map((m) => m[1])
    .filter((v): v is string => typeof v === "string");

  if (unresolved.length > 0) {
    return yield* new OpenApiInvocationError({
      message: `Unresolved path parameters: ${[...new Set(unresolved)].join(", ")}`,
      statusCode: Option.none(),
    });
  }

  return resolved;
});

// ---------------------------------------------------------------------------
// Header resolution — resolves secret refs at invocation time
// ---------------------------------------------------------------------------

export const resolveHeaders = (
  headers: Record<string, HeaderValue>,
  secrets: {
    readonly get: (id: string) => Effect.Effect<string | null, StorageFailure>;
  },
): Effect.Effect<Record<string, string>, OpenApiInvocationError | StorageFailure> => {
  const entries = Object.entries(headers);
  const secretCount = entries.reduce(
    (acc, [, value]) => (typeof value === "string" ? acc : acc + 1),
    0,
  );
  return Effect.gen(function* () {
    // Fan out secret lookups: on every invocation, one or two headers
    // typically each hit the secret store. Resolving them in parallel
    // is a free wall-clock win — preserved order is only needed for
    // the final assembly, not the fetches.
    const values = yield* Effect.all(
      entries.map(([name, value]) =>
        typeof value === "string"
          ? Effect.succeed({ name, value })
          : secrets.get(value.secretId).pipe(
              Effect.flatMap((secret) =>
                secret === null
                  ? Effect.fail(
                      new OpenApiInvocationError({
                        message: `Failed to resolve secret "${value.secretId}" for header "${name}"`,
                        statusCode: Option.none(),
                      }),
                    )
                  : Effect.succeed({
                      name,
                      value: value.prefix ? `${value.prefix}${secret}` : secret,
                    }),
              ),
            ),
      ),
      { concurrency: "unbounded" },
    );
    const resolved: Record<string, string> = {};
    for (const { name, value } of values) resolved[name] = value;
    return resolved;
  }).pipe(
    Effect.withSpan("plugin.openapi.secret.resolve", {
      attributes: {
        "plugin.openapi.headers.total": entries.length,
        "plugin.openapi.headers.secret_count": secretCount,
      },
    }),
  );
};

const applyHeaders = (
  request: HttpClientRequest.HttpClientRequest,
  headers: Record<string, string>,
): HttpClientRequest.HttpClientRequest => {
  let req = request;
  for (const [name, value] of Object.entries(headers)) {
    req = HttpClientRequest.setHeader(req, name, value);
  }
  return req;
};

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

const normalizeContentType = (ct: string | null | undefined): string =>
  ct?.split(";")[0]?.trim().toLowerCase() ?? "";

const isJsonContentType = (ct: string | null | undefined): boolean => {
  const normalized = normalizeContentType(ct);
  if (!normalized) return false;
  return (
    normalized === "application/json" || normalized.includes("+json") || normalized.includes("json")
  );
};

const isFormUrlEncoded = (ct: string | null | undefined): boolean =>
  normalizeContentType(ct) === "application/x-www-form-urlencoded";

const isMultipartFormData = (ct: string | null | undefined): boolean =>
  normalizeContentType(ct).startsWith("multipart/form-data");

const isXmlContentType = (ct: string | null | undefined): boolean => {
  const normalized = normalizeContentType(ct);
  if (!normalized) return false;
  return (
    normalized === "application/xml" ||
    normalized === "text/xml" ||
    normalized.endsWith("+xml")
  );
};

const isTextContentType = (ct: string | null | undefined): boolean =>
  normalizeContentType(ct).startsWith("text/");

const isOctetStream = (ct: string | null | undefined): boolean =>
  normalizeContentType(ct) === "application/octet-stream";

const toUint8Array = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (Array.isArray(value) && value.every((v) => typeof v === "number")) {
    return new Uint8Array(value as readonly number[]);
  }
  return null;
};

type FormDataRecord = Parameters<typeof HttpClientRequest.bodyFormDataRecord>[1];
type FormDataCoercible = FormDataRecord[string];

// Best-effort build of a FormData entry record: most primitives pass through,
// plain objects get JSON-stringified so a server receives `{...}` instead of
// `[object Object]`. File/Blob are handled natively by bodyFormDataRecord.
const coerceFormDataRecord = (value: Record<string, unknown>): FormDataRecord => {
  const out: Record<string, FormDataCoercible> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined || raw === null) continue;
    if (
      typeof raw === "string" ||
      typeof raw === "number" ||
      typeof raw === "boolean" ||
      raw instanceof Blob ||
      (typeof File !== "undefined" && raw instanceof File)
    ) {
      out[key] = raw as FormDataCoercible;
      continue;
    }
    if (Array.isArray(raw)) {
      out[key] = raw.map((v) =>
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean" ||
        v instanceof Blob ||
        (typeof File !== "undefined" && v instanceof File)
          ? (v as FormDataCoercible)
          : JSON.stringify(v),
      ) as FormDataCoercible;
      continue;
    }
    const bytes = toUint8Array(raw);
    if (bytes) {
      out[key] = new Blob([toArrayBuffer(bytes)]);
      continue;
    }
    out[key] = JSON.stringify(raw);
  }
  return out;
};

// Pull a plain ArrayBuffer out of a Uint8Array — `new Blob([u8])` rejects
// views whose `.buffer` is `SharedArrayBuffer | ArrayBuffer` under strict
// lib.dom typings.
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
};

// ---------------------------------------------------------------------------
// Request body dispatch
//
// Dispatch is driven by the spec-declared content type first, JS type of
// the provided body second. Servers that advertise a specific content type
// almost always reject anything else (e.g. a multipart endpoint will hang
// waiting for valid framing if it receives `application/json`), so the
// content type wins.
//
// Within each content type we accept both pre-serialized strings (user
// already produced the wire format) and structured JS values we can
// serialize ourselves. The last-resort fallback is `JSON.stringify(body)`
// — never `String(body)` (which produces the useless `[object Object]`).
// ---------------------------------------------------------------------------

const applyRequestBody = (
  request: HttpClientRequest.HttpClientRequest,
  contentType: string,
  bodyValue: unknown,
): HttpClientRequest.HttpClientRequest => {
  if (isJsonContentType(contentType)) {
    // Pre-serialized JSON strings pass through with the declared media
    // type preserved (important for `application/vnd.foo+json` etc.).
    if (typeof bodyValue === "string") {
      return HttpClientRequest.bodyText(request, bodyValue, contentType);
    }
    return HttpClientRequest.bodyUnsafeJson(request, bodyValue);
  }

  if (isFormUrlEncoded(contentType)) {
    if (typeof bodyValue === "string") {
      return HttpClientRequest.bodyText(request, bodyValue, contentType);
    }
    return HttpClientRequest.bodyUrlParams(
      request,
      bodyValue as Parameters<typeof HttpClientRequest.bodyUrlParams>[1],
    );
  }

  if (isMultipartFormData(contentType)) {
    if (bodyValue instanceof FormData) {
      return HttpClientRequest.bodyFormData(request, bodyValue);
    }
    if (typeof bodyValue === "object" && bodyValue !== null) {
      return HttpClientRequest.bodyFormDataRecord(
        request,
        coerceFormDataRecord(bodyValue as Record<string, unknown>),
      );
    }
    // String / primitive under multipart is almost certainly wrong on the
    // caller's end — send it as text with their declared content type and
    // let the server produce a useful error.
    return HttpClientRequest.bodyText(request, String(bodyValue), contentType);
  }

  if (isOctetStream(contentType)) {
    const bytes = toUint8Array(bodyValue);
    if (bytes) return HttpClientRequest.bodyUint8Array(request, bytes, contentType);
    if (typeof bodyValue === "string") {
      return HttpClientRequest.bodyText(request, bodyValue, contentType);
    }
    // Unknown shape — serialize as JSON so at least the payload is visible.
    return HttpClientRequest.bodyText(request, JSON.stringify(bodyValue), contentType);
  }

  if (isXmlContentType(contentType) || isTextContentType(contentType)) {
    if (typeof bodyValue === "string") {
      return HttpClientRequest.bodyText(request, bodyValue, contentType);
    }
    const bytes = toUint8Array(bodyValue);
    if (bytes) return HttpClientRequest.bodyUint8Array(request, bytes, contentType);
    // Object body under text/xml is unusual — stringify so the caller sees
    // their own payload instead of `[object Object]`.
    return HttpClientRequest.bodyText(request, JSON.stringify(bodyValue), contentType);
  }

  // Unknown content type: respect what the caller supplied.
  if (typeof bodyValue === "string") {
    return HttpClientRequest.bodyText(request, bodyValue, contentType);
  }
  const bytes = toUint8Array(bodyValue);
  if (bytes) return HttpClientRequest.bodyUint8Array(request, bytes, contentType);
  return HttpClientRequest.bodyText(request, JSON.stringify(bodyValue), contentType);
};

// ---------------------------------------------------------------------------
// Public API — invoke a single operation
// ---------------------------------------------------------------------------

export const invoke = Effect.fn("OpenApi.invoke")(function* (
  operation: OperationBinding,
  args: Record<string, unknown>,
  resolvedHeaders: Record<string, string>,
) {
  const client = yield* HttpClient.HttpClient;

  yield* Effect.annotateCurrentSpan({
    "http.method": operation.method.toUpperCase(),
    "http.route": operation.pathTemplate,
    "plugin.openapi.method": operation.method.toUpperCase(),
    "plugin.openapi.path_template": operation.pathTemplate,
    "plugin.openapi.headers.resolved_count": Object.keys(resolvedHeaders).length,
  });

  const resolvedPath = yield* resolvePath(operation.pathTemplate, args, operation.parameters);

  const path = resolvedPath.startsWith("/") ? resolvedPath : `/${resolvedPath}`;

  let request = HttpClientRequest.make(operation.method.toUpperCase() as "GET")(path);

  for (const param of operation.parameters) {
    if (param.location !== "query") continue;
    const value = readParamValue(args, param);
    if (value === undefined || value === null) continue;
    request = HttpClientRequest.setUrlParam(request, param.name, String(value));
  }

  for (const param of operation.parameters) {
    if (param.location !== "header") continue;
    const value = readParamValue(args, param);
    if (value === undefined || value === null) continue;
    request = HttpClientRequest.setHeader(request, param.name, String(value));
  }

  if (Option.isSome(operation.requestBody)) {
    const rb = operation.requestBody.value;
    const bodyValue = args.body ?? args.input;
    if (bodyValue !== undefined) {
      request = applyRequestBody(request, rb.contentType, bodyValue);
    }
  }

  request = applyHeaders(request, resolvedHeaders);

  const response = yield* client.execute(request).pipe(
    Effect.mapError(
      (err) =>
        new OpenApiInvocationError({
          message: `HTTP request failed: ${err.message}`,
          statusCode: Option.none(),
          cause: err,
        }),
    ),
  );

  const status = response.status;
  yield* Effect.annotateCurrentSpan({
    "http.status_code": status,
  });
  const responseHeaders: Record<string, string> = { ...response.headers };

  const contentType = response.headers["content-type"] ?? null;
  const mapBodyError = Effect.mapError(
    (err: { readonly message?: string }) =>
      new OpenApiInvocationError({
        message: `Failed to read response body: ${err.message ?? String(err)}`,
        statusCode: Option.some(status),
        cause: err,
      }),
  );
  const responseBody: unknown =
    status === 204
      ? null
      : isJsonContentType(contentType)
        ? yield* response.json.pipe(
            Effect.catchAll(() => response.text),
            mapBodyError,
          )
        : yield* response.text.pipe(mapBodyError);

  const ok = status >= 200 && status < 300;

  return new InvocationResult({
    status,
    headers: responseHeaders,
    data: ok ? responseBody : null,
    error: ok ? null : responseBody,
  });
});

// ---------------------------------------------------------------------------
// Invoke with a provided HttpClient layer + optional baseUrl prefix
// ---------------------------------------------------------------------------

export const invokeWithLayer = (
  operation: OperationBinding,
  args: Record<string, unknown>,
  baseUrl: string,
  resolvedHeaders: Record<string, string>,
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>,
) => {
  const clientWithBaseUrl = baseUrl
    ? Layer.effect(
        HttpClient.HttpClient,
        Effect.map(
          HttpClient.HttpClient,
          HttpClient.mapRequest(HttpClientRequest.prependUrl(baseUrl)),
        ),
      ).pipe(Layer.provide(httpClientLayer))
    : httpClientLayer;

  return invoke(operation, args, resolvedHeaders).pipe(
    Effect.provide(clientWithBaseUrl),
    Effect.withSpan("plugin.openapi.invoke", {
      attributes: {
        "plugin.openapi.method": operation.method.toUpperCase(),
        "plugin.openapi.path_template": operation.pathTemplate,
        "plugin.openapi.base_url": baseUrl,
      },
    }),
  );
};

// ---------------------------------------------------------------------------
// Derive annotations from HTTP method
// ---------------------------------------------------------------------------

const DEFAULT_REQUIRE_APPROVAL = new Set(["post", "put", "patch", "delete"]);

export const annotationsForOperation = (
  method: string,
  pathTemplate: string,
  policy?: { readonly requireApprovalFor?: readonly string[] },
): { requiresApproval?: boolean; approvalDescription?: string } => {
  const m = method.toLowerCase();
  const requireSet = policy?.requireApprovalFor
    ? new Set(policy.requireApprovalFor.map((v) => v.toLowerCase()))
    : DEFAULT_REQUIRE_APPROVAL;
  if (!requireSet.has(m)) return {};
  return {
    requiresApproval: true,
    approvalDescription: `${method.toUpperCase()} ${pathTemplate}`,
  };
};

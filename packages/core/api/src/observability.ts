// ---------------------------------------------------------------------------
// HTTP-edge observability — the one layer that translates storage-level
// failures into the opaque public 500 surface.
//
// @executor/sdk stays out of this: plugin code and executor surface
// methods return `StorageError` in their typed error channel. Non-HTTP
// consumers (CLI, Promise SDK, tests) see those raw and can decide what
// to do. Here, at the HTTP edge, we:
//
//   1. `InternalError` — public opaque 500 schema, narrow by design
//      (only `traceId`), so no internal cause/message/stack ever crosses
//      the wire.
//   2. `ErrorCapture` — pluggable service the host wires up (Sentry in
//      the cloud Worker, console in CLI, in-memory in tests) to record
//      causes and return correlation ids. Optional; absent → empty
//      trace ids, nothing breaks.
//   3. `captureStorage` / `withStorageCapture` — translate the
//      `StorageError` tag in an Effect's typed channel to
//      `InternalError({ traceId })`, capturing the full cause along the
//      way. Applied once at Layer composition boundaries (see
//      `protected-layers.ts`) so handlers never hand-wire it.
//   4. `observabilityMiddleware` — defect safety net for anything that
//      escaped the typed channel (sync throws, unmapped framework
//      failures). Same InternalError shape, same capture path.
//
// Distinct from `apps/cloud/src/services/telemetry.ts` — that's the
// OTEL bridge wiring spans to Axiom; this is exception capture in the
// Sentry sense.
// ---------------------------------------------------------------------------

import { Cause, Context, Effect, Layer, Option, Schema } from "effect";
import {
  HttpApiBuilder,
  HttpApiSchema,
  HttpServerResponse,
  type HttpApi,
  type HttpApiGroup,
} from "@effect/platform";
import type { StorageFailure } from "@executor/storage-core";

/** Public 500 surface. Opaque by schema. */
export class InternalError extends Schema.TaggedError<InternalError>()(
  "InternalError",
  {
    /** Opaque correlation id for backend lookup (Sentry event id, log line, etc.). */
    traceId: Schema.String,
  },
  HttpApiSchema.annotations({ status: 500 }),
) {}

export interface ErrorCaptureShape {
  /**
   * Record an unexpected cause and return a correlation id the operator
   * can later look up. Implementations (Sentry, console, etc.) decide
   * how to persist it.
   */
  readonly captureException: (
    cause: Cause.Cause<unknown>,
  ) => Effect.Effect<string>;
}

export class ErrorCapture extends Context.Tag("@executor/api/ErrorCapture")<
  ErrorCapture,
  ErrorCaptureShape
>() {
  /** No-op — used where capture isn't wired. Traces back as empty string. */
  static readonly NoOp: Layer.Layer<ErrorCapture> = Layer.succeed(
    ErrorCapture,
    ErrorCapture.of({ captureException: () => Effect.succeed("") }),
  );
}

// Resolve ErrorCapture with a no-op fallback. Keeps the caller's R channel
// unencumbered: no host has to provide ErrorCapture for the wrapper to
// typecheck; if it's there, we use it; if not, trace ids are empty.
const resolveCapture = Effect.serviceOption(ErrorCapture).pipe(
  Effect.map((opt) =>
    Option.isSome(opt)
      ? opt.value
      : ({ captureException: () => Effect.succeed("") } as const),
  ),
);

/**
 * HTTP-edge translator for `StorageFailure`. Two cases:
 *
 *   - `StorageError` — known backend failure. Capture the cause via
 *     `ErrorCapture`, fail with `InternalError({ traceId })`.
 *   - `UniqueViolationError` — invariant violation at the HTTP edge:
 *     if a plugin wanted to surface a unique-conflict as a typed
 *     domain error (e.g. "source already exists") it should
 *     `Effect.catchTag` inside its own method and translate. Anything
 *     that reaches here is unexpected, so we `Effect.die` and let the
 *     observability middleware capture it as a defect.
 *
 * Every other typed failure (plugin-domain errors, etc.) passes
 * through unchanged.
 */
export const captureStorage = <A, E, R>(
  eff: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, StorageFailure> | InternalError, R> =>
  (eff as Effect.Effect<A, E | StorageFailure, R>).pipe(
    Effect.catchTag("UniqueViolationError", (err) => Effect.die(err)),
    Effect.catchTag("StorageError", (err) =>
      resolveCapture.pipe(
        Effect.flatMap((capture) => capture.captureException(Cause.fail(err))),
        Effect.flatMap((traceId) =>
          Effect.fail(new InternalError({ traceId })),
        ),
      ),
    ),
  ) as Effect.Effect<A, Exclude<E, StorageFailure> | InternalError, R>;

// ---------------------------------------------------------------------------
// withStorageCapture — walk an object's methods and wrap each
// Effect-returning one with `captureStorage`. Lets us apply the
// translation once at Layer composition (`Layer.effect(McpExtensionService,
// Effect.map(executor.mcp, withStorageCapture))`) instead of per handler.
//
// Nested plain objects (e.g. `executor.tools.list`) are walked
// recursively so the full surface ends up wrapped. Non-plain values
// (Date, Array, class instances with a non-Object prototype) pass
// through untouched — we don't want to proxy an InvocationError, etc.
// ---------------------------------------------------------------------------

const isPlainObject = (v: unknown): v is Record<string | symbol, unknown> => {
  if (v === null || typeof v !== "object") return false;
  if (Array.isArray(v)) return false;
  if (v instanceof Date || v instanceof Promise) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/**
 * Type-level mirror of `withStorageCapture` — every Effect-returning
 * method has its `StorageError` variant replaced with `InternalError`.
 * Use to declare service tags that hold the already-captured shape:
 *
 *   class McpExtensionService extends Context.Tag("...")<
 *     McpExtensionService,
 *     StorageCaptured<McpPluginExtension>
 *   >() {}
 */
export type StorageCaptured<T> = T extends (
  ...args: infer A
) => Effect.Effect<infer X, infer E, infer R>
  ? (
      ...args: A
    ) => Effect.Effect<X, Exclude<E, StorageFailure> | InternalError, R>
  : T extends (...args: infer A) => infer U
    ? (...args: A) => U
    : T extends object
      ? { readonly [K in keyof T]: StorageCaptured<T[K]> }
      : T;

export const withStorageCapture = <T extends object>(
  value: T,
): StorageCaptured<T> => {
  return new Proxy(value, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v === "function") {
        return (...args: unknown[]) => {
          const result = (v as (...a: unknown[]) => unknown).apply(
            target,
            args,
          );
          if (Effect.isEffect(result)) {
            return captureStorage(
              result as Effect.Effect<unknown, unknown, unknown>,
            );
          }
          return result;
        };
      }
      if (isPlainObject(v)) return withStorageCapture(v);
      return v;
    },
  }) as StorageCaptured<T>;
};

/**
 * Edge defect catchall. Builds an `HttpApiBuilder.middleware` layer
 * that wraps the HttpApp once. Captures any cause (defects, interrupts,
 * unmapped failures the framework couldn't encode) via `ErrorCapture` and
 * returns a typed `InternalError({ traceId })` body.
 *
 * `ErrorCapture` is OPTIONAL — if the host hasn't wired one up the
 * middleware still fires but the trace id will be empty.
 *
 * Should rarely fire when the edge is well-wired — storage failures are
 * already translated by `withStorageCapture` at service construction;
 * plugin-domain errors flow through their schemas. This is the net for
 * anything that slipped through.
 */
export const observabilityMiddleware = <
  Id extends string,
  Groups extends HttpApiGroup.HttpApiGroup.Any,
  E,
  R,
>(
  api: HttpApi.HttpApi<Id, Groups, E, R>,
): Layer.Layer<never> =>
  HttpApiBuilder.middleware(
    api,
    Effect.gen(function* () {
      const capture = yield* resolveCapture;
      return (httpApp) =>
        Effect.catchAllCause(httpApp, (cause) =>
          Effect.gen(function* () {
            const traceId = yield* capture.captureException(cause);
            return HttpServerResponse.unsafeJson(
              new InternalError({ traceId }),
              { status: 500 },
            );
          }),
        );
    }),
    { withContext: true },
  );

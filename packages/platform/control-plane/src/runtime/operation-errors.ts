import {
  ControlPlaneBadRequestError,
  ControlPlaneNotFoundError,
  ControlPlaneStorageError,
} from "../api/errors";
import * as Effect from "effect/Effect";

export type OperationErrors<TOperation extends string = string> = {
  readonly operation: TOperation;
  readonly child: <TSuffix extends string>(
    suffix: TSuffix,
  ) => OperationErrors<`${TOperation}.${TSuffix}`>;
  readonly badRequest: (
    message: string,
    details: string,
  ) => ControlPlaneBadRequestError;
  readonly notFound: (
    message: string,
    details: string,
  ) => ControlPlaneNotFoundError;
  readonly storage: (
    error: Error,
  ) => ControlPlaneStorageError;
  readonly unknownStorage: (
    cause: unknown,
    details: string,
  ) => ControlPlaneStorageError;
  readonly mapStorage: <A, E extends Error>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, ControlPlaneStorageError>;
};

export type OperationErrorsLike = OperationErrors | string;

export const operationErrors = <TOperation extends string>(
  operation: TOperation,
): OperationErrors<TOperation> => {
  const self: OperationErrors<TOperation> = {
    operation,
    child: (suffix) =>
      operationErrors(`${operation}.${suffix}` as `${TOperation}.${typeof suffix}`),
    badRequest: (message, details) =>
      new ControlPlaneBadRequestError({
        operation,
        message,
        details,
      }),
    notFound: (message, details) =>
      new ControlPlaneNotFoundError({
        operation,
        message,
        details,
      }),
    storage: (error) =>
      new ControlPlaneStorageError({
        operation,
        message: error.message,
        details: error.message,
      }),
    unknownStorage: (cause, details) =>
      self.storage(
        cause instanceof Error
          ? new Error(`${cause.message}: ${details}`)
          : new Error(details),
      ),
    mapStorage: (effect) =>
      effect.pipe(
        Effect.mapError((error) => self.storage(error)),
      ),
  };

  return self;
};

export const asOperationErrors = (
  errors: OperationErrorsLike,
): OperationErrors =>
  typeof errors === "string"
    ? operationErrors(errors)
    : errors;

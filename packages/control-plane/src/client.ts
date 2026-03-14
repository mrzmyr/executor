import {
  FetchHttpClient,
  HttpApiClient,
} from "@effect/platform";
import * as Effect from "effect/Effect";

import { ControlPlaneApi } from "./api/api";

export const createControlPlaneClient = (input: {
  baseUrl: string;
  accountId?: string;
}) =>
  HttpApiClient.make(ControlPlaneApi, {
    baseUrl: input.baseUrl,
  }).pipe(Effect.provide(FetchHttpClient.layer));

export type ControlPlaneClient = Effect.Effect.Success<
  ReturnType<typeof createControlPlaneClient>
>;

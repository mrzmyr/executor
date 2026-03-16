import {
  HttpApiBuilder,
  HttpApiClient,
} from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  ControlPlaneApi,
  createControlPlaneApiLayer,
} from "#api";

import {
  type ControlPlaneRuntime,
} from "./index";

const createClientLayer = (runtime: ControlPlaneRuntime) => {
  const apiLayer = createControlPlaneApiLayer(runtime.runtimeLayer);

  return HttpApiBuilder.serve().pipe(
    Layer.provide(apiLayer),
    Layer.provideMerge(NodeHttpServer.layerTest),
  );
};

const createControlPlaneClient = (accountId?: string) =>
  (void accountId,
  HttpApiClient.make(ControlPlaneApi, {
  }));

type ControlPlaneClient = Effect.Effect.Success<
  ReturnType<typeof createControlPlaneClient>
>;

export const withControlPlaneClient = <A, E>(
  input: {
    runtime: ControlPlaneRuntime;
    accountId?: string;
  },
  f: (client: ControlPlaneClient) => Effect.Effect<A, E, never>,
): Effect.Effect<A, E, never> =>
  Effect.gen(function* () {
    const client = yield* createControlPlaneClient(input.accountId);
    return yield* f(client);
  }).pipe(Effect.provide(createClientLayer(input.runtime).pipe(Layer.orDie)));

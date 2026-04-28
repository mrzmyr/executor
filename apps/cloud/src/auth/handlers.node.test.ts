import {
  HttpApiBuilder,
  HttpApp,
  HttpServer,
} from "@effect/platform";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import {
  CloudAuthPublicHandlers,
  NonProtectedApi,
} from "./handlers";
import { UserStoreService } from "./context";
import { WorkOSAuth } from "./workos";

const makeAuthFetch = (workos: Partial<WorkOSAuth["Type"]>) => {
  const WorkOSTest = Layer.succeed(
    WorkOSAuth,
    new Proxy(workos as WorkOSAuth["Type"], {
      get: (target, prop) => {
        if (prop in target) return target[prop as keyof typeof target];
        return () => {
          throw new Error(`WorkOSAuth.${String(prop)} not stubbed`);
        };
      },
    }),
  );
  const UserStoreTest = Layer.succeed(UserStoreService, {
    use: () => Effect.succeed(undefined),
  });
  const app = HttpApiBuilder.httpApp.pipe(
    Effect.provide(
      HttpApiBuilder.api(NonProtectedApi).pipe(
        Layer.provide(CloudAuthPublicHandlers),
        Layer.provideMerge(WorkOSTest),
        Layer.provideMerge(UserStoreTest),
        Layer.provideMerge(HttpServer.layerContext),
        Layer.provideMerge(HttpApiBuilder.Router.Live),
        Layer.provideMerge(HttpApiBuilder.Middleware.layer),
      ),
    ),
  );
  return HttpApp.toWebHandler(app);
};

describe("Auth callback handlers", () => {
  it.effect("rejects callback state without the matching login state cookie", () =>
    Effect.gen(function* () {
      let authenticateCalls = 0;
      const fetch = makeAuthFetch({
        authenticateWithCode: () =>
          Effect.sync(() => {
            authenticateCalls++;
            return {
              user: { id: "user_1" },
              organizationId: null,
              sealedSession: "sealed_session",
            };
          }),
      });

      const response = yield* Effect.promise(() =>
        fetch(
          new Request("http://test.local/auth/callback?code=attacker-code&state=attacker-state"),
        ),
      );

      expect(response.status).toBe(400);
      expect(authenticateCalls).toBe(0);
    }),
  );
});

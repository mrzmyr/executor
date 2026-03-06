import { HttpApiBuilder } from "@effect/platform";
import * as Effect from "effect/Effect";

import { ControlPlaneApi } from "../api";
import { ControlPlaneService } from "../service";

export const ControlPlaneLocalLive = HttpApiBuilder.group(
  ControlPlaneApi,
  "local",
  (handlers) =>
    handlers.handle("installation", () =>
      Effect.gen(function* () {
        const service = yield* ControlPlaneService;
        return yield* service.getLocalInstallation();
      })
    ),
);

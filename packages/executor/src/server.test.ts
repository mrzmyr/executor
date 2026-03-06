import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeToolInvokerFromTools } from "@executor-v3/codemode-core";
import {
  makeControlPlaneClient,
  type ResolveExecutionEnvironment,
} from "@executor-v3/control-plane";
import { makeInProcessExecutor } from "@executor-v3/runtime-local-inproc";

import { makeLocalExecutorServer } from "./server";

const executionResolver: ResolveExecutionEnvironment = () =>
  Effect.succeed({
    executor: makeInProcessExecutor(),
    toolInvoker: makeToolInvokerFromTools({
      tools: {
        "math.add": {
          description: "Add two numbers",
          inputSchema: Schema.standardSchemaV1(
            Schema.Struct({
              a: Schema.optional(Schema.Number),
              b: Schema.optional(Schema.Number),
            }),
          ),
          execute: ({ a, b }) => ({ sum: (a ?? 0) + (b ?? 0) }),
        },
      },
    }),
  });

const makeServer = makeLocalExecutorServer({
  port: 0,
  localDataDir: ":memory:",
  executionResolver,
});

describe("local-executor-server", () => {
  it.scoped("serves the control-plane API and executes code", () =>
    Effect.gen(function* () {
      const server = yield* makeServer;
      const bootstrapClient = yield* makeControlPlaneClient({
        baseUrl: server.baseUrl,
      });
      const installation = yield* bootstrapClient.local.installation({});
      const client = yield* makeControlPlaneClient({
        baseUrl: server.baseUrl,
        accountId: installation.accountId,
      });

      const execution = yield* client.executions.create({
        path: {
          workspaceId: installation.workspaceId,
        },
        payload: {
          code: "return await tools.math.add({ a: 20, b: 22 });",
        },
      });

      expect(execution.execution.status).toBe("completed");
      expect(execution.execution.resultJson).toBe(JSON.stringify({ sum: 42 }));
    }),
  );
});

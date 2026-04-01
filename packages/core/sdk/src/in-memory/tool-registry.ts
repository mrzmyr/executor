import { Effect } from "effect";

import { ToolId } from "../ids";
import { ToolNotFoundError } from "../errors";
import type { ToolRegistration, InvokeOptions } from "../tools";
import { reattachDefs } from "../schema-refs";

export const makeInMemoryToolRegistry = () => {
  const tools = new Map<string, ToolRegistration>();
  const sharedDefs = new Map<string, unknown>();

  return {
    list: (filter?: {
      readonly tags?: readonly string[];
      readonly query?: string;
    }) =>
      Effect.sync(() => {
        let result = [...tools.values()];
        if (filter?.tags?.length) {
          const tagSet = new Set(filter.tags);
          result = result.filter((t) =>
            t.tags?.some((tag) => tagSet.has(tag)),
          );
        }
        if (filter?.query) {
          const q = filter.query.toLowerCase();
          result = result.filter(
            (t) =>
              t.name.toLowerCase().includes(q) ||
              t.description?.toLowerCase().includes(q),
          );
        }
        return result.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          tags: t.tags ? [...t.tags] : [],
        }));
      }),

    schema: (toolId: ToolId) =>
      Effect.fromNullable(tools.get(toolId)).pipe(
        Effect.mapError(() => new ToolNotFoundError({ toolId })),
        Effect.map((t) => ({
          id: t.id,
          inputSchema: reattachDefs(t.inputSchema, sharedDefs),
          outputSchema: reattachDefs(t.outputSchema, sharedDefs),
        })),
      ),

    definitions: () =>
      Effect.sync(() => {
        const result: Record<string, unknown> = {};
        for (const [k, v] of sharedDefs) {
          result[k] = v;
        }
        return result;
      }),

    registerDefinitions: (defs: Record<string, unknown>) =>
      Effect.sync(() => {
        for (const [k, v] of Object.entries(defs)) {
          sharedDefs.set(k, v);
        }
      }),

    invoke: (toolId: ToolId, args: unknown, options?: InvokeOptions) =>
      Effect.gen(function* () {
        const tool = yield* Effect.fromNullable(tools.get(toolId)).pipe(
          Effect.mapError(() => new ToolNotFoundError({ toolId })),
        );
        return yield* tool.invoke(args, options);
      }),

    register: (newTools: readonly ToolRegistration[]) =>
      Effect.sync(() => {
        for (const t of newTools) {
          tools.set(t.id, t);
        }
      }),

    unregister: (toolIds: readonly ToolId[]) =>
      Effect.sync(() => {
        for (const id of toolIds) {
          tools.delete(id);
        }
      }),
  };
};

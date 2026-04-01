import { Effect } from "effect";

import { ScopeId, ToolId, PolicyId } from "../ids";
import type { Policy } from "../policies";

export const makeInMemoryPolicyEngine = () => {
  const policies = new Map<string, Policy>();
  let counter = 0;

  return {
    list: (scopeId: ScopeId) =>
      Effect.succeed(
        [...policies.values()].filter((p) => p.scopeId === scopeId),
      ),
    check: (_input: { readonly scopeId: ScopeId; readonly toolId: ToolId }) =>
      Effect.void,
    add: (policy: Omit<Policy, "id" | "createdAt">) =>
      Effect.sync(() => {
        const id = PolicyId.make(`policy-${++counter}`);
        const full: Policy = { ...policy, id, createdAt: new Date() };
        policies.set(id, full);
        return full;
      }),
    remove: (policyId: PolicyId) =>
      Effect.succeed(policies.delete(policyId)),
  };
};

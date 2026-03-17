import { defineRule } from "@oxlint/plugins";

import {
  createModuleSourceVisitor,
  readStaticSpecifier,
} from "../workspace-utils.mjs";

const isEffectSource = (specifier) =>
  specifier === "effect"
  || specifier.startsWith("effect/")
  || specifier.startsWith("@effect/");

const isDirectTagRead = (node) =>
  node?.type === "MemberExpression"
  && node.computed === false
  && node.property?.type === "Identifier"
  && node.property.name === "_tag";

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow reading Effect `_tag` fields directly.",
      recommended: true,
    },
    messages: {
      noDirectEffectTagRead:
        "Do not read `._tag` directly in Effect code. `_tag` is an internal Effect representation detail. Use Effect's built-in match and predicate helpers instead, such as `Either.isLeft`, `Either.isRight`, `Option.isSome`, `Option.isNone`, `Exit.isSuccess`, or `Exit.isFailure`. If you need examples, see `.reference/effect` in this repo.",
    },
  },
  create(context) {
    let hasEffectImport = false;

    const visitSource = (sourceNode) => {
      const specifier = readStaticSpecifier(sourceNode);
      if (specifier && isEffectSource(specifier)) {
        hasEffectImport = true;
      }
    };

    return {
      ...createModuleSourceVisitor(visitSource),
      MemberExpression(node) {
        if (!hasEffectImport || !isDirectTagRead(node)) {
          return;
        }

        context.report({
          node: node.property,
          messageId: "noDirectEffectTagRead",
        });
      },
    };
  },
});

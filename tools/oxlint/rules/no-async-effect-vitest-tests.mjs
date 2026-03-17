import { defineRule } from "@oxlint/plugins";

import {
  createModuleSourceVisitor,
  readStaticSpecifier,
} from "../workspace-utils.mjs";

const isEffectVitestSource = (specifier) =>
  specifier === "@effect/vitest" || specifier === "@effect/vitest/utils";

const isEffectSource = (specifier) =>
  (specifier === "effect" ||
    specifier.startsWith("effect/") ||
    specifier.startsWith("@effect/")) &&
  !isEffectVitestSource(specifier);

const isIdentifierNamed = (node, name) =>
  node?.type === "Identifier" && node.name === name;

const isTestCallee = (node) => {
  if (isIdentifierNamed(node, "it") || isIdentifierNamed(node, "test")) {
    return true;
  }

  return (
    node?.type === "MemberExpression" &&
    node.computed === false &&
    (isIdentifierNamed(node.object, "it") ||
      isIdentifierNamed(node.object, "test"))
  );
};

const isEffectVitestTestCallback = (node) =>
  (node?.type === "ArrowFunctionExpression" ||
    node?.type === "FunctionExpression") &&
  node.parent?.type === "CallExpression" &&
  node.parent.arguments.includes(node) &&
  isTestCallee(node.parent.callee);

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow async test callbacks in Effect Vitest files that already use Effect.",
      recommended: true,
    },
    messages: {
      noAsyncEffectVitestTests:
        "Do not use an `async` test callback in Effect Vitest files. Return an Effect with `it.effect(...)` or `it.scoped(...)` instead of driving the test with plain async/await.",
    },
  },
  create(context) {
    let hasEffectImport = false;
    let hasEffectVitestImport = false;

    const visitSource = (sourceNode) => {
      const specifier = readStaticSpecifier(sourceNode);
      if (!specifier) {
        return;
      }

      if (isEffectSource(specifier)) {
        hasEffectImport = true;
      }

      if (isEffectVitestSource(specifier)) {
        hasEffectVitestImport = true;
      }
    };

    const checkFunction = (node) => {
      if (
        !hasEffectImport ||
        !hasEffectVitestImport ||
        !node.async ||
        !isEffectVitestTestCallback(node)
      ) {
        return;
      }

      context.report({
        node,
        messageId: "noAsyncEffectVitestTests",
      });
    };

    return {
      ...createModuleSourceVisitor(visitSource),
      ArrowFunctionExpression: checkFunction,
      FunctionExpression: checkFunction,
    };
  },
});

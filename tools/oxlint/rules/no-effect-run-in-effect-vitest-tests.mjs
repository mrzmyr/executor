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

const isEffectRunCall = (node) =>
  node?.type === "CallExpression" &&
  node.callee?.type === "MemberExpression" &&
  node.callee.computed === false &&
  isIdentifierNamed(node.callee.object, "Effect") &&
  (isIdentifierNamed(node.callee.property, "runPromise") ||
    isIdentifierNamed(node.callee.property, "runSync") ||
    isIdentifierNamed(node.callee.property, "runFork"));

const getNearestFunctionAncestor = (node) => {
  let current = node?.parent ?? null;

  while (current) {
    if (
      current.type === "ArrowFunctionExpression" ||
      current.type === "FunctionExpression" ||
      current.type === "FunctionDeclaration"
    ) {
      return current;
    }

    current = current.parent ?? null;
  }

  return null;
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Effect runtime execution helpers inside Effect Vitest test callbacks.",
      recommended: true,
    },
    messages: {
      noEffectRunInEffectVitestTests:
        "Do not call `Effect.runPromise`, `Effect.runSync`, or `Effect.runFork` directly inside an Effect Vitest test callback. Return the Effect with `it.effect(...)` or `it.scoped(...)` instead.",
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

    return {
      ...createModuleSourceVisitor(visitSource),
      CallExpression(node) {
        if (
          !hasEffectImport ||
          !hasEffectVitestImport ||
          !isEffectRunCall(node)
        ) {
          return;
        }

        const nearestFunction = getNearestFunctionAncestor(node);
        if (!isEffectVitestTestCallback(nearestFunction)) {
          return;
        }

        context.report({
          node: node.callee.property,
          messageId: "noEffectRunInEffectVitestTests",
        });
      },
    };
  },
});

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  buildToolPath,
  buildInvokeToolCode,
  buildListSourcesCode,
  buildSearchToolsCode,
  extractExecutionId,
  extractExecutionResult,
  isLikelyToolPathToken,
  parseJsonObjectInput,
} from "../apps/cli/src/tooling";

describe("CLI tooling helpers", () => {
  it.effect("parses empty input as an empty args object", () =>
    Effect.gen(function* () {
      const args = yield* parseJsonObjectInput(undefined);
      expect(args).toEqual({});
    }),
  );

  it.effect("parses JSON object input", () =>
    Effect.gen(function* () {
      const args = yield* parseJsonObjectInput('{"calendarId":"primary"}');
      expect(args).toEqual({ calendarId: "primary" });
    }),
  );

  it.effect("rejects non-object JSON input", () =>
    Effect.gen(function* () {
      const error = yield* parseJsonObjectInput('[1,2,3]').pipe(Effect.flip);
      expect(error.message).toContain("must decode to a JSON object");
    }),
  );

  it("builds bracket-safe invocation code for dynamic tool paths", () => {
    const code = buildInvokeToolCode("google-drive.files.list", { pageSize: 10 });
    expect(code).toContain('const __target = tools["google-drive"]["files"]["list"]');
    expect(code).toContain('const __args = {');
  });

  it("builds tool paths from dot or segmented forms", () => {
    expect(buildToolPath(["github", "issues", "create"])).toBe("github.issues.create");
    expect(buildToolPath(["github.issues", "create"])).toBe("github.issues.create");
  });

  it("detects likely tool path tokens", () => {
    expect(isLikelyToolPathToken("github.issues.create")).toBe(true);
    expect(isLikelyToolPathToken("return await tools.search({})")).toBe(false);
  });

  it("builds search and sources code snippets", () => {
    const searchCode = buildSearchToolsCode({
      query: "google calendar events",
      namespace: "google",
      limit: 5,
    });
    const sourcesCode = buildListSourcesCode({ query: "google", limit: 20 });

    expect(searchCode).toBe(
      'return await tools.search({"query":"google calendar events","limit":5,"namespace":"google"});',
    );
    expect(sourcesCode).toBe('return await tools.executor.sources.list({"limit":20,"query":"google"});');
  });

  it("extracts completed result payload and pause execution id", () => {
    expect(extractExecutionResult({ status: "completed", result: { ok: true }, logs: [] })).toEqual({
      ok: true,
    });
    expect(extractExecutionResult({ status: "completed" })).toBeNull();

    expect(extractExecutionId({ executionId: "exec_123" })).toBe("exec_123");
    expect(extractExecutionId({ executionId: 123 })).toBeUndefined();
  });
});

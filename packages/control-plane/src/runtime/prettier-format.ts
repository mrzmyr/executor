import * as prettier from "prettier";

export type PrettierParser = "json" | "typescript";

const formatCache = new Map<string, string>();

function formatCacheKey(code: string, parser: PrettierParser): string {
  return `${parser}::${code.length}::${code}`;
}

export async function formatWithPrettier(
  code: string,
  parser: PrettierParser,
): Promise<string> {
  const key = formatCacheKey(code, parser);
  const cached = formatCache.get(key);
  if (cached) return cached;

  try {
    let input = code;
    let unwrap = false;

    if (parser === "typescript") {
      input = `type __T = ${code}`;
      unwrap = true;
    }

    const result = await prettier.format(input, {
      parser,
      printWidth: 60,
      tabWidth: 2,
      semi: true,
      singleQuote: false,
      trailingComma: "all",
    });

    let trimmed = result.trimEnd();

    if (unwrap) {
      trimmed = trimmed
        .replace(/^type __T =\s*/, "")
        .replace(/;$/, "")
        .trimEnd();
    }

    formatCache.set(key, trimmed);
    return trimmed;
  } catch {
    return code;
  }
}

export async function formatJsonIfNeeded(code: string): Promise<string> {
  const trimmed = code.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return code;
  }

  return formatWithPrettier(code, "json");
}

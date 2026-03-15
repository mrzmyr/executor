type JsonRecord = Record<string, unknown>;

const asRecord = (value: unknown): JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};

const decodeRefSegment = (segment: string): string =>
  segment.replace(/~1/g, "/").replace(/~0/g, "~");

const resolveLocalRef = (
  root: JsonRecord,
  ref: string,
): JsonRecord | null => {
  if (!ref.startsWith("#/")) {
    return null;
  }

  const segments = ref.slice(2).split("/").map(decodeRefSegment);
  let current: unknown = root;
  for (const segment of segments) {
    const record = asRecord(current);
    if (!(segment in record)) {
      return null;
    }
    current = record[segment];
  }

  const resolved = asRecord(current);
  return Object.keys(resolved).length > 0 ? resolved : null;
};

const expandNodeForDisplay = (
  node: unknown,
  root: JsonRecord,
  depth: number,
  seenRefs: ReadonlySet<string>,
): unknown => {
  const record = asRecord(node);
  if (Object.keys(record).length === 0 || depth < 0) {
    return node;
  }

  if (typeof record.$ref === "string") {
    const ref = record.$ref;
    if (seenRefs.has(ref)) {
      return node;
    }

    const target = resolveLocalRef(root, ref);
    if (!target) {
      return node;
    }

    const { $ref: _ignored, ...overlay } = record;
    const expandedTarget = asRecord(
      expandNodeForDisplay(target, root, depth - 1, new Set([...seenRefs, ref])),
    );
    return {
      ...expandedTarget,
      ...overlay,
    };
  }

  const nextDepth = depth - 1;
  const expanded: JsonRecord = {};

  for (const [key, value] of Object.entries(record)) {
    if (key === "$defs") {
      expanded[key] = value;
      continue;
    }

    if (key === "properties" || key === "patternProperties") {
      const childRecord = asRecord(value);
      expanded[key] = Object.fromEntries(
        Object.entries(childRecord).map(([childKey, childValue]) => [
          childKey,
          expandNodeForDisplay(childValue, root, nextDepth, seenRefs),
        ]),
      );
      continue;
    }

    if (key === "items" || key === "additionalProperties") {
      expanded[key] =
        typeof value === "boolean"
          ? value
          : expandNodeForDisplay(value, root, nextDepth, seenRefs);
      continue;
    }

    if (key === "anyOf" || key === "oneOf" || key === "allOf") {
      expanded[key] = Array.isArray(value)
        ? value.map((entry) => expandNodeForDisplay(entry, root, nextDepth, seenRefs))
        : value;
      continue;
    }

    expanded[key] = value;
  }

  return expanded;
};

export const formatSchemaJsonForDisplay = (
  schemaJson: string | null | undefined,
): string | null => {
  if (!schemaJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(schemaJson) as unknown;
    const root = asRecord(parsed);
    const expanded = expandNodeForDisplay(root, root, 3, new Set<string>());
    return JSON.stringify(expanded, null, 2);
  } catch {
    return schemaJson;
  }
};

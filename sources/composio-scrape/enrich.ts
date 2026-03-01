#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

interface ApisGuruMatch {
  id: string;
  name: string;
  providerName: string;
  specUrl: string;
  originUrl: string;
  openapiVer: string;
}

interface ToolkitRecord {
  slug: string;
  docsUrl: string;
  toolkitUrl: string;
  name: string;
  category: string;
  auth: string;
  toolsCount: number;
  triggersCount: number;
  composioSlug: string;
  version: string;
  status: "ok" | "missing" | "error";
  protocolHints: string[];
  endpointUrls: string[];
  usableOpenApiUrls?: string[];
  usableGraphqlUrls?: string[];
  matchedApisGuru: ApisGuruMatch | null;
  error: string;
}

interface EnrichmentResult {
  openapiUrls: string[];
  graphqlUrls: string[];
  inspectedCandidates: number;
}

const INPUT_PATH = fileURLToPath(new URL("./data/composio-toolkits-endpoints.json", import.meta.url));
const OUTPUT_JSON_PATH = fileURLToPath(new URL("./data/composio-toolkits-endpoints.enriched.json", import.meta.url));
const OUTPUT_CSV_PATH = fileURLToPath(new URL("./data/composio-toolkits-endpoints.enriched.csv", import.meta.url));
const OUTPUT_SUMMARY_PATH = fileURLToPath(new URL("./data/composio-toolkits-summary.enriched.json", import.meta.url));
const OUTPUT_NEEDS_RESEARCH_PATH = fileURLToPath(new URL("./data/composio-toolkits-needs-research.enriched.csv", import.meta.url));
const OUTPUT_DISCOVERIES_PATH = fileURLToPath(new URL("./data/composio-toolkits-discoveries.enriched.csv", import.meta.url));

const concurrency = parseIntArg("--concurrency", 8, 1, 50);
const limit = parseIntArg("--limit", 0, 0, 20_000);
const timeoutMs = parseIntArg("--timeout-ms", 5000, 1000, 20_000);
const maxOpenApiCandidates = parseIntArg("--max-openapi-candidates", 8, 1, 50);
const maxGraphqlCandidates = parseIntArg("--max-graphql-candidates", 4, 1, 30);
const only = getStringArg("--only");

const IGNORE_HOSTS = new Set([
  "composio.dev",
  "docs.composio.dev",
  "backend.composio.dev",
  "platform.composio.dev",
  "logos.composio.dev",
  "og.composio.dev",
  "app.getdecimal.ai",
  "twitter.com",
  "x.com",
  "discord.gg",
  "github.com",
  "www.w3.org",
  "schema.org",
]);

function getStringArg(flag: string): string {
  const value = Bun.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (!value) return "";
  return value.slice(flag.length + 1).trim();
}

function parseIntArg(flag: string, fallback: number, min: number, max: number): number {
  const value = getStringArg(flag);
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;

  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function cleanUrl(raw: string): string {
  return raw
    .trim()
    .replace(/[),.;'"`]+$/g, "")
    .replace(/\\+$/g, "")
    .replace(/&amp;/g, "&");
}

function extractUrls(markdown: string): string[] {
  const urls = new Set<string>();

  for (const match of markdown.matchAll(/https?:\/\/[^\s)\]>\"]+/g)) {
    const candidate = cleanUrl(match[0]);
    if (!candidate) continue;

    try {
      new URL(candidate);
    } catch {
      continue;
    }

    urls.add(candidate);
  }

  return [...urls].sort();
}

function rootDomainFromHost(host: string): string {
  const normalized = host.toLowerCase().replace(/^www\./, "");
  const parts = normalized.split(".").filter(Boolean);
  if (parts.length <= 2) return normalized;

  const secondLevel = parts[parts.length - 2];
  const topLevel = parts[parts.length - 1];

  if (["co", "com", "org", "net", "gov", "edu"].includes(secondLevel) && topLevel.length <= 2 && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }

  return parts.slice(-2).join(".");
}

function collectCandidateHosts(urls: string[]): string[] {
  const hosts = new Set<string>();

  for (const rawUrl of urls) {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      continue;
    }

    const host = parsed.hostname.toLowerCase();
    if (IGNORE_HOSTS.has(host)) continue;
    if (host.endsWith("composio.dev")) continue;

    hosts.add(host);

    if (/^(www|api|docs|developer|developers|graphql)\./.test(host)) {
      const stripped = host.replace(/^(www|api|docs|developer|developers|graphql)\./, "");
      if (stripped && !IGNORE_HOSTS.has(stripped) && !stripped.endsWith("composio.dev")) {
        hosts.add(stripped);
      }
    }

    const root = rootDomainFromHost(host);
    if (root && !IGNORE_HOSTS.has(root) && !root.endsWith("composio.dev")) {
      hosts.add(root);
    }
  }

  return [...hosts].sort();
}

function buildOpenApiCandidates(hosts: string[], hintUrls: string[]): string[] {
  const candidates = new Set<string>();

  for (const hintUrl of hintUrls) {
    const lower = hintUrl.toLowerCase();
    if (/openapi|swagger|v3\/api-docs|api-docs/.test(lower)) {
      candidates.add(hintUrl);
    }
  }

  const specPaths = [
    "/openapi.json",
    "/swagger.json",
    "/v3/api-docs",
    "/api-docs",
  ];

  for (const host of hosts) {
    const hostVariants = new Set<string>([host]);

    if (!host.startsWith("api.")) {
      hostVariants.add(`api.${host}`);
    }

    for (const candidateHost of hostVariants) {
      for (const path of specPaths) {
        candidates.add(`https://${candidateHost}${path}`);
      }
    }
  }

  return [...candidates].sort();
}

function buildGraphqlCandidates(hosts: string[], hintUrls: string[]): string[] {
  const candidates = new Set<string>();

  for (const hintUrl of hintUrls) {
    const lower = hintUrl.toLowerCase();
    if (/\/graphql($|[/?#])/.test(lower) || /graphql\./.test(lower)) {
      candidates.add(hintUrl);
    }
  }

  const graphqlPaths = [
    "/graphql",
    "/api/graphql",
  ];

  for (const host of hosts) {
    const hostVariants = new Set<string>([host]);

    if (!host.startsWith("api.")) {
      hostVariants.add(`api.${host}`);
    }

    if (!host.startsWith("graphql.")) {
      hostVariants.add(`graphql.${host}`);
    }

    for (const candidateHost of hostVariants) {
      for (const path of graphqlPaths) {
        candidates.add(`https://${candidateHost}${path}`);
      }
    }
  }

  return [...candidates].sort();
}

const openApiProbeCache = new Map<string, Promise<boolean>>();
const graphqlProbeCache = new Map<string, Promise<boolean>>();

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "user-agent": "composio-toolkit-enricher/1.0",
        ...(init.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function probeOpenApi(url: string): Promise<boolean> {
  if (openApiProbeCache.has(url)) {
    return openApiProbeCache.get(url)!;
  }

  const promise = (async () => {
    try {
      const response = await fetchWithTimeout(url, {
        method: "GET",
        headers: {
          "accept": "application/json,application/yaml,text/yaml,text/plain,*/*",
        },
      });

      if (!response.ok) {
        return false;
      }

      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      const body = await response.text();
      const trimmed = body.trim();
      if (!trimmed) return false;

      const looksHtml = contentType.includes("text/html") || /^\s*<!doctype html/i.test(trimmed) || /^\s*<html/i.test(trimmed);
      if (looksHtml) return false;

      if (/^\s*\{/.test(trimmed)) {
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          if (typeof parsed === "object" && parsed !== null && ("openapi" in parsed || "swagger" in parsed)) {
            return true;
          }
        } catch {
          return false;
        }
      }

      if (/^\s*openapi\s*:\s*["']?\d/i.test(trimmed) || /^\s*swagger\s*:\s*["']?\d/i.test(trimmed)) {
        return true;
      }

      if (/"openapi"\s*:\s*"\d/i.test(trimmed) || /"swagger"\s*:\s*"\d/i.test(trimmed)) {
        return true;
      }

      return false;
    } catch {
      return false;
    }
  })();

  openApiProbeCache.set(url, promise);
  return promise;
}

async function probeGraphql(url: string): Promise<boolean> {
  if (graphqlProbeCache.has(url)) {
    return graphqlProbeCache.get(url)!;
  }

  const promise = (async () => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return false;
    }

    const path = parsedUrl.pathname.toLowerCase();
    if (!/\/graphql($|\/)/.test(path)) {
      return false;
    }

    if (/^\/(docs|documentation)\//.test(path)) {
      return false;
    }

    try {
      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "accept": "application/json,*/*",
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: "query { __typename }" }),
      });

      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      const text = await response.text();
      const lower = text.toLowerCase();

      if (contentType.includes("application/json")) {
        try {
          const parsed = JSON.parse(text) as {
            data?: unknown;
            errors?: unknown;
            message?: unknown;
            error?: unknown;
          };

          const hasGraphqlErrorEvidence = (errors: unknown): boolean => {
            if (!Array.isArray(errors)) return false;

            for (const item of errors) {
              if (typeof item === "string" && /graphql|cannot query field|must provide query|string contains invalid|syntax error|introspection/i.test(item)) {
                return true;
              }

              if (!item || typeof item !== "object") continue;

              const message = typeof (item as { message?: unknown }).message === "string"
                ? ((item as { message: string }).message)
                : "";

              const extensions = (item as { extensions?: unknown }).extensions;
              const code =
                extensions && typeof extensions === "object" && typeof (extensions as { code?: unknown }).code === "string"
                  ? ((extensions as { code: string }).code)
                  : "";

              if (/graphql|cannot query field|must provide query|string contains invalid|syntax error|introspection/i.test(message)) {
                return true;
              }

              if (/^graphql_/i.test(code)) {
                return true;
              }
            }

            return false;
          };

          if (parsed.data !== undefined) {
            return true;
          }

          if (hasGraphqlErrorEvidence(parsed.errors)) {
            return true;
          }

          if (typeof parsed.error === "string" && /graphql|cannot query field|must provide query|string contains invalid|syntax error|introspection/i.test(parsed.error)) {
            return true;
          }

          if (typeof parsed.message === "string" && /graphql|cannot query field|must provide query|string contains invalid|syntax error|introspection/i.test(parsed.message)) {
            return true;
          }
        } catch {
          return false;
        }
      }

      if ([400, 405].includes(response.status) && /graphql|cannot query field|must provide query|string contains invalid|syntax error|introspection/i.test(lower)) {
        return true;
      }

      return false;
    } catch {
      return false;
    }
  })();

  graphqlProbeCache.set(url, promise);
  return promise;
}

async function fetchMarkdown(url: string): Promise<string> {
  try {
    const response = await fetchWithTimeout(url, {
      method: "GET",
      headers: {
        "accept": "text/plain,text/markdown,text/html,*/*",
      },
    });

    if (!response.ok) return "";
    return await response.text();
  } catch {
    return "";
  }
}

async function enrichOne(record: ToolkitRecord): Promise<EnrichmentResult> {
  const markdown = await fetchMarkdown(record.docsUrl);
  if (!markdown) {
    return {
      openapiUrls: [],
      graphqlUrls: [],
      inspectedCandidates: 0,
    };
  }

  const hintUrls = extractUrls(markdown);
  const hosts = collectCandidateHosts(hintUrls);

  const openApiCandidates = buildOpenApiCandidates(hosts, hintUrls).slice(0, maxOpenApiCandidates);
  const graphqlCandidates = buildGraphqlCandidates(hosts, hintUrls).slice(0, maxGraphqlCandidates);

  const discoveredOpenApi: string[] = [];
  const discoveredGraphql: string[] = [];

  let inspectedCandidates = 0;

  for (const candidate of openApiCandidates) {
    inspectedCandidates += 1;
    if (await probeOpenApi(candidate)) {
      discoveredOpenApi.push(candidate);
      break;
    }
  }

  for (const candidate of graphqlCandidates) {
    inspectedCandidates += 1;
    if (await probeGraphql(candidate)) {
      discoveredGraphql.push(candidate);
      break;
    }
  }

  return {
    openapiUrls: [...new Set(discoveredOpenApi)].sort(),
    graphqlUrls: [...new Set(discoveredGraphql)].sort(),
    inspectedCandidates,
  };
}

async function mapLimit<T, R>(
  items: T[],
  maxConcurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      if (index >= items.length) return;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.max(1, maxConcurrency) }, () => worker());
  await Promise.all(workers);
  return results;
}

function toCsv(rows: ToolkitRecord[]): string {
  const headers = [
    "slug",
    "name",
    "category",
    "auth",
    "toolsCount",
    "triggersCount",
    "composioSlug",
    "version",
    "status",
    "protocolHints",
    "endpointUrls",
    "usableOpenApiUrls",
    "usableGraphqlUrls",
    "apisGuruId",
    "apisGuruProviderName",
    "apisGuruSpecUrl",
    "apisGuruOriginUrl",
    "apisGuruOpenApiVer",
    "docsUrl",
    "toolkitUrl",
    "error",
  ];

  const lines = [headers.join(",")];

  for (const row of rows) {
    const values = [
      row.slug,
      row.name,
      row.category,
      row.auth,
      String(row.toolsCount),
      String(row.triggersCount),
      row.composioSlug,
      row.version,
      row.status,
      row.protocolHints.join(";"),
      row.endpointUrls.join(";"),
      (row.usableOpenApiUrls ?? []).join(";"),
      (row.usableGraphqlUrls ?? []).join(";"),
      row.matchedApisGuru?.id ?? "",
      row.matchedApisGuru?.providerName ?? "",
      row.matchedApisGuru?.specUrl ?? "",
      row.matchedApisGuru?.originUrl ?? "",
      row.matchedApisGuru?.openapiVer ?? "",
      row.docsUrl,
      row.toolkitUrl,
      row.error,
    ];

    lines.push(values.map(csvEscape).join(","));
  }

  return `${lines.join("\n")}\n`;
}

function toNeedsResearchCsv(rows: ToolkitRecord[]): string {
  const headers = ["slug", "name", "category", "auth", "toolsCount", "docsUrl", "toolkitUrl"];
  const lines = [headers.join(",")];

  const filtered = rows
    .filter((row) => row.status === "ok" && (row.usableOpenApiUrls ?? []).length === 0 && (row.usableGraphqlUrls ?? []).length === 0)
    .sort((a, b) => b.toolsCount - a.toolsCount || a.slug.localeCompare(b.slug));

  for (const row of filtered) {
    lines.push([
      row.slug,
      row.name,
      row.category,
      row.auth,
      String(row.toolsCount),
      row.docsUrl,
      row.toolkitUrl,
    ].map(csvEscape).join(","));
  }

  return `${lines.join("\n")}\n`;
}

function toDiscoveriesCsv(
  rows: ToolkitRecord[],
  previous: Map<string, { openapi: number; graphql: number }>,
): string {
  const headers = ["slug", "name", "newOpenApiUrls", "newGraphqlUrls", "totalOpenApiUrls", "totalGraphqlUrls"];
  const lines = [headers.join(",")];

  const discovered = rows
    .map((row) => {
      const before = previous.get(row.slug) ?? { openapi: 0, graphql: 0 };
      const afterOpenApi = (row.usableOpenApiUrls ?? []).length;
      const afterGraphql = (row.usableGraphqlUrls ?? []).length;

      return {
        row,
        newOpenApi: Math.max(0, afterOpenApi - before.openapi),
        newGraphql: Math.max(0, afterGraphql - before.graphql),
        afterOpenApi,
        afterGraphql,
      };
    })
    .filter((item) => item.newOpenApi > 0 || item.newGraphql > 0)
    .sort((a, b) => (b.newOpenApi + b.newGraphql) - (a.newOpenApi + a.newGraphql) || a.row.slug.localeCompare(b.row.slug));

  for (const item of discovered) {
    lines.push([
      item.row.slug,
      item.row.name,
      String(item.newOpenApi),
      String(item.newGraphql),
      String(item.afterOpenApi),
      String(item.afterGraphql),
    ].map(csvEscape).join(","));
  }

  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const raw = await Bun.file(INPUT_PATH).json() as ToolkitRecord[];

  const baseline = new Map<string, { openapi: number; graphql: number }>();
  for (const row of raw) {
    row.usableOpenApiUrls = [...new Set(row.usableOpenApiUrls ?? [])].sort();
    row.usableGraphqlUrls = [...new Set(row.usableGraphqlUrls ?? [])].sort();

    baseline.set(row.slug, {
      openapi: row.usableOpenApiUrls.length,
      graphql: row.usableGraphqlUrls.length,
    });
  }

  const unresolved = raw.filter((row) =>
    row.status === "ok" && row.usableOpenApiUrls!.length === 0 && row.usableGraphqlUrls!.length === 0,
  );

  const filteredTargets =
    only.length > 0
      ? unresolved.filter((row) => row.slug === only)
      : (limit > 0 ? unresolved.slice(0, limit) : unresolved);

  if (filteredTargets.length === 0) {
    console.log("[enrich] no unresolved rows to process");
    return;
  }

  console.log(`[enrich] unresolved before run: ${unresolved.length}`);
  console.log(`[enrich] processing ${filteredTargets.length} toolkit rows`);

  let completed = 0;
  let inspected = 0;

  await mapLimit(filteredTargets, concurrency, async (row) => {
    const enrichment = await enrichOne(row);

    inspected += enrichment.inspectedCandidates;

    if (enrichment.openapiUrls.length > 0) {
      row.usableOpenApiUrls = [...new Set([...(row.usableOpenApiUrls ?? []), ...enrichment.openapiUrls])].sort();
    }

    if (enrichment.graphqlUrls.length > 0) {
      row.usableGraphqlUrls = [...new Set([...(row.usableGraphqlUrls ?? []), ...enrichment.graphqlUrls])].sort();
    }

    completed += 1;
    if (completed % 25 === 0 || completed === filteredTargets.length) {
      console.log(`[enrich] processed ${completed}/${filteredTargets.length} (inspected=${inspected})`);
    }
  });

  const outDir = fileURLToPath(new URL("./data/", import.meta.url));
  await mkdir(outDir, { recursive: true });

  const summary = {
    generatedAt: new Date().toISOString(),
    inputPath: INPUT_PATH,
    targetsProcessed: filteredTargets.length,
    unresolvedBefore: unresolved.length,
    unresolvedAfter: raw.filter((row) => row.status === "ok" && row.usableOpenApiUrls!.length === 0 && row.usableGraphqlUrls!.length === 0).length,
    withUsableOpenApi: raw.filter((row) => (row.usableOpenApiUrls ?? []).length > 0).length,
    withUsableGraphql: raw.filter((row) => (row.usableGraphqlUrls ?? []).length > 0).length,
    withAnyUsableSpec: raw.filter((row) => (row.usableOpenApiUrls ?? []).length > 0 || (row.usableGraphqlUrls ?? []).length > 0).length,
    inspectedCandidates: inspected,
    args: {
      concurrency,
      limit,
      only,
      timeoutMs,
      maxOpenApiCandidates,
      maxGraphqlCandidates,
    },
  };

  await writeFile(OUTPUT_JSON_PATH, `${JSON.stringify(raw, null, 2)}\n`);
  await writeFile(OUTPUT_CSV_PATH, toCsv(raw));
  await writeFile(OUTPUT_SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(OUTPUT_NEEDS_RESEARCH_PATH, toNeedsResearchCsv(raw));
  await writeFile(OUTPUT_DISCOVERIES_PATH, toDiscoveriesCsv(raw, baseline));

  console.log("[enrich] done");
  console.log(`[enrich] json: ${OUTPUT_JSON_PATH}`);
  console.log(`[enrich] csv: ${OUTPUT_CSV_PATH}`);
  console.log(`[enrich] summary: ${OUTPUT_SUMMARY_PATH}`);
  console.log(`[enrich] needs-research: ${OUTPUT_NEEDS_RESEARCH_PATH}`);
  console.log(`[enrich] discoveries: ${OUTPUT_DISCOVERIES_PATH}`);
  console.log(
    `[enrich] stats: withUsableOpenApi=${summary.withUsableOpenApi}, withUsableGraphql=${summary.withUsableGraphql}, withAnyUsableSpec=${summary.withAnyUsableSpec}, unresolvedAfter=${summary.unresolvedAfter}`,
  );
}

await main();

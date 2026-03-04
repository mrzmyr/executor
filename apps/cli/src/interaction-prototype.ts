import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";

type RunStatus =
  | "queued"
  | "running"
  | "waiting_for_interaction"
  | "completed"
  | "failed";

type InteractionKind = "source_oauth_signin" | "approval";
type InteractionStatus = "pending" | "resolved" | "denied";

type Interaction = {
  id: string;
  runId: string;
  kind: InteractionKind;
  status: InteractionStatus;
  blocking: boolean;
  title: string;
  request: Record<string, unknown>;
};

type RunRecord = {
  id: string;
  status: RunStatus;
  result: unknown;
  error: string | null;
};

type Step =
  | {
      type: "interaction";
      create: (runId: string) => Interaction;
    }
  | {
      type: "complete";
      result: unknown;
    };

const AXIOM_MCP_URL = "https://mcp.axiom.co/mcp";
const DEFAULT_WEB_ORIGIN = "http://127.0.0.1:3000";

type PrototypeWebServer = {
  stop: () => void;
  origin: string;
};

const normalizeOrigin = (raw: string): string =>
  raw.endsWith("/") ? raw.slice(0, -1) : raw;

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const buildOAuthStartUrl = (input: {
  sourceUrl: string;
  webOrigin: string;
}): string =>
  `${normalizeOrigin(input.webOrigin)}/mcp/oauth/start?sourceUrl=${encodeURIComponent(input.sourceUrl)}`;

const readFlagValue = (name: string): string | undefined => {
  const prefix = `${name}=`;
  for (let index = 0; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === name) {
      const next = process.argv[index + 1];
      if (next && !next.startsWith("--")) {
        const trimmed = next.trim();
        return trimmed.length > 0 ? trimmed : undefined;
      }
    }

    if (arg.startsWith(prefix)) {
      const value = arg.slice(prefix.length).trim();
      return value.length > 0 ? value : undefined;
    }
  }

  return undefined;
};

const startPrototypeWebServer = (webOrigin: string): PrototypeWebServer => {
  const origin = normalizeOrigin(webOrigin);
  const parsed = new URL(origin);

  if (parsed.protocol !== "http:") {
    throw new Error(`Mock OAuth server expects http origin, received: ${origin}`);
  }

  const bunRuntime = (globalThis as { Bun?: unknown }).Bun;
  if (!bunRuntime || typeof bunRuntime !== "object" || !("serve" in bunRuntime)) {
    throw new Error("Bun runtime is required for the mock OAuth server.");
  }

  const serve = (bunRuntime as {
    serve: (input: {
      hostname?: string;
      port?: number;
      fetch: (request: Request) => Response;
    }) => { stop: (closeActiveConnections?: boolean) => void };
  }).serve;

  const port = parsed.port.length > 0 ? Number(parsed.port) : 80;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid port in web origin: ${origin}`);
  }

  const server = serve({
    hostname: parsed.hostname,
    port,
    fetch: (request) => {
      const url = new URL(request.url);

      if (url.pathname === "/healthz") {
        return Response.json({
          ok: true,
          service: "executor-interaction-prototype-oauth",
        });
      }

      if (url.pathname === "/mcp/oauth/start") {
        const sourceUrl = url.searchParams.get("sourceUrl") ?? AXIOM_MCP_URL;
        const completeHref = `/mcp/oauth/complete?sourceUrl=${encodeURIComponent(sourceUrl)}`;

        return new Response(
          `<!doctype html><html><head><meta charset="utf-8"><title>Mock Axiom OAuth</title></head><body style="font-family: sans-serif; max-width: 760px; margin: 40px auto; line-height: 1.5;"><h1>Mock Axiom MCP Sign-In</h1><p>This is a local mock OAuth page served by the CLI prototype.</p><p><strong>Source URL:</strong> <code>${escapeHtml(sourceUrl)}</code></p><p><a href="${escapeHtml(completeHref)}" style="display:inline-block;padding:10px 14px;border:1px solid #222;text-decoration:none;border-radius:6px;">Approve and Continue</a></p></body></html>`,
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
            },
          },
        );
      }

      if (url.pathname === "/mcp/oauth/complete") {
        const sourceUrl = url.searchParams.get("sourceUrl") ?? AXIOM_MCP_URL;
        const payload = {
          type: "executor-v2:mcp-oauth-result",
          ok: true,
          sourceUrl,
          payload: {
            accessToken: "mock_access_token",
          },
        };

        return new Response(
          `<!doctype html><html><head><meta charset="utf-8"><title>OAuth Complete</title></head><body style="font-family: sans-serif; max-width: 760px; margin: 40px auto; line-height: 1.5;"><h1>Mock OAuth Complete</h1><p>You can return to the terminal now.</p><script>try { if (window.opener) { window.opener.postMessage(${JSON.stringify(payload)}, window.location.origin); } } catch {} setTimeout(() => window.close(), 300);</script></body></html>`,
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
            },
          },
        );
      }

      return new Response("Not found", { status: 404 });
    },
  });

  output.write(`[web] Mock OAuth server listening on ${origin}\n`);

  return {
    origin,
    stop: () => {
      server.stop(true);
    },
  };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

class MockInteractionBackend {
  #runs = new Map<string, RunRecord>();
  #interactions = new Map<string, Interaction>();
  #stepsByRun = new Map<string, Array<Step>>();

  readonly #webOrigin: string;

  constructor(webOrigin: string) {
    this.#webOrigin = normalizeOrigin(webOrigin);
  }

  createRun(): { runId: string } {
    const runId = `run_${crypto.randomUUID()}`;
    this.#runs.set(runId, {
      id: runId,
      status: "queued",
      result: null,
      error: null,
    });

    this.#stepsByRun.set(runId, [
      {
        type: "interaction",
        create: (id) => ({
          id: `int_${crypto.randomUUID()}`,
          runId: id,
          kind: "source_oauth_signin",
          status: "pending",
          blocking: true,
          title: "Sign in to Axiom MCP",
          request: {
            sourceName: "axiom-mcp",
            endpoint: AXIOM_MCP_URL,
            authorizationUrl: buildOAuthStartUrl({
              sourceUrl: AXIOM_MCP_URL,
              webOrigin: this.#webOrigin,
            }),
          },
        }),
      },
      {
        type: "interaction",
        create: (id) => ({
          id: `int_${crypto.randomUUID()}`,
          runId: id,
          kind: "approval",
          status: "pending",
          blocking: true,
          title: "Approve tool call",
          request: {
            toolPath: "source.axiom-mcp.datasets/query",
            reason: "Run wants to read issue telemetry for the selected repository.",
            inputPreview: {
              query: "['errors'] | where repo == 'vercel/next.js' | limit 5",
            },
          },
        }),
      },
      {
        type: "complete",
        result: {
          ok: true,
          rows: [
            { issue: 90837, count: 16 },
            { issue: 90829, count: 9 },
            { issue: 90798, count: 5 },
          ],
        },
      },
    ]);

    void this.#advance(runId);
    return { runId };
  }

  getRun(runId: string): RunRecord {
    const run = this.#runs.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    return run;
  }

  listPendingInteractions(runId: string): Array<Interaction> {
    const items: Array<Interaction> = [];

    for (const interaction of this.#interactions.values()) {
      if (interaction.runId === runId && interaction.status === "pending") {
        items.push(interaction);
      }
    }

    return items;
  }

  async respondToInteraction(input: {
    interactionId: string;
    decision: "approved" | "denied";
    payload?: Record<string, unknown>;
  }): Promise<void> {
    const interaction = this.#interactions.get(input.interactionId);
    if (!interaction) {
      throw new Error(`Interaction not found: ${input.interactionId}`);
    }

    if (interaction.status !== "pending") {
      return;
    }

    if (input.decision === "denied") {
      interaction.status = "denied";
      this.#interactions.set(interaction.id, interaction);

      const run = this.getRun(interaction.runId);
      run.status = "failed";
      run.error = `Interaction denied: ${interaction.kind}`;
      this.#runs.set(run.id, run);
      return;
    }

    interaction.status = "resolved";
    this.#interactions.set(interaction.id, {
      ...interaction,
      request: {
        ...interaction.request,
        response: input.payload ?? null,
      },
    });

    const run = this.getRun(interaction.runId);
    run.status = "running";
    this.#runs.set(run.id, run);
    await this.#advance(run.id);
  }

  async #advance(runId: string): Promise<void> {
    const run = this.getRun(runId);
    if (run.status === "failed" || run.status === "completed") {
      return;
    }

    run.status = "running";
    this.#runs.set(run.id, run);
    await sleep(350);

    const remaining = this.#stepsByRun.get(runId) ?? [];
    const next = remaining.shift();
    this.#stepsByRun.set(runId, remaining);

    if (!next) {
      run.status = "completed";
      run.result = { ok: true };
      this.#runs.set(run.id, run);
      return;
    }

    if (next.type === "complete") {
      run.status = "completed";
      run.result = next.result;
      this.#runs.set(run.id, run);
      return;
    }

    const interaction = next.create(runId);
    this.#interactions.set(interaction.id, interaction);
    run.status = "waiting_for_interaction";
    this.#runs.set(run.id, run);
  }
}

const tryOpen = (command: string, args: Array<string>): boolean => {
  const result = spawnSync(command, args, {
    stdio: "ignore",
    windowsHide: true,
  });

  if (result.error) {
    return false;
  }

  return typeof result.status === "number" ? result.status === 0 : true;
};

const openBrowser = (url: string): boolean => {
  output.write(`\n[cli] Opening browser: ${url}\n`);

  if (process.platform === "darwin") {
    return tryOpen("open", [url]);
  }

  if (process.platform === "win32") {
    return tryOpen("cmd", ["/c", "start", "", url]);
  }

  return tryOpen("xdg-open", [url]) || tryOpen("gio", ["open", url]);
};

const promptYesNo = async (
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  defaultYes = true,
): Promise<boolean> => {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = (await rl.question(`${prompt} ${suffix} `)).trim().toLowerCase();

  if (answer.length === 0) {
    return defaultYes;
  }

  return answer === "y" || answer === "yes";
};

const handleInteraction = async (input: {
  interaction: Interaction;
  backend: MockInteractionBackend;
  rl: ReturnType<typeof createInterface>;
  auto: boolean;
}): Promise<void> => {
  const { interaction, backend, rl, auto } = input;

  if (interaction.kind === "source_oauth_signin") {
    const authorizationUrl = String(interaction.request.authorizationUrl ?? "");
    const sourceName = String(interaction.request.sourceName ?? "source");
    output.write(`\n[interaction] ${interaction.title}\n`);
    output.write(`[interaction] Source: ${sourceName}\n`);
    output.write(`[interaction] Using OAuth bootstrap: ${authorizationUrl}\n`);

    if (auto) {
      output.write("[demo] Auto mode: skipping browser launch and simulating callback...\n");
      await sleep(700);
    } else {
      const opened = openBrowser(authorizationUrl);
      if (!opened) {
        output.write("[cli] Could not auto-open browser. Please open this URL manually.\n");
        output.write(`[cli] ${authorizationUrl}\n`);
      }

      await rl.question("Complete sign-in in the browser, then press Enter to continue... ");
    }

    await backend.respondToInteraction({
      interactionId: interaction.id,
      decision: "approved",
      payload: {
        completedAt: Date.now(),
      },
    });

    output.write("[interaction] OAuth sign-in completed.\n");
    return;
  }

  if (interaction.kind === "approval") {
    const toolPath = String(interaction.request.toolPath ?? "unknown.tool");
    output.write(`\n[interaction] ${interaction.title}\n`);
    output.write(`[interaction] Tool: ${toolPath}\n`);

    const approved = auto
      ? true
      : await promptYesNo(rl, "Approve this tool call?", true);

    await backend.respondToInteraction({
      interactionId: interaction.id,
      decision: approved ? "approved" : "denied",
      payload: {
        approved,
        decidedAt: Date.now(),
      },
    });

    output.write(approved
      ? "[interaction] Tool call approved.\n"
      : "[interaction] Tool call denied.\n");
  }
};

const main = async (): Promise<void> => {
  const auto = process.argv.includes("--auto");
  const webOrigin =
    readFlagValue("--web-origin")
    ?? process.env.EXECUTOR_WEB_ORIGIN?.trim()
    ?? DEFAULT_WEB_ORIGIN;
  const rl = createInterface({ input, output });
  const backend = new MockInteractionBackend(webOrigin);
  const webServer = startPrototypeWebServer(webOrigin);

  try {
    output.write("Executor Interaction Prototype\n");
    output.write("- single run\n");
    output.write("- pauses on interactions\n");
    output.write("- resumes when resolved\n");
    output.write(`- Axiom MCP URL: ${AXIOM_MCP_URL}\n`);
    output.write(`- OAuth start origin: ${webServer.origin}\n`);

    const { runId } = backend.createRun();
    output.write(`\n[run] started: ${runId}\n`);

    while (true) {
      const run = backend.getRun(runId);

      if (run.status === "completed") {
        output.write(`\n[run] completed\n`);
        output.write(`[run] result: ${JSON.stringify(run.result, null, 2)}\n`);
        break;
      }

      if (run.status === "failed") {
        output.write(`\n[run] failed: ${run.error ?? "unknown error"}\n`);
        break;
      }

      if (run.status === "waiting_for_interaction") {
        const pending = backend.listPendingInteractions(runId);
        if (pending.length === 0) {
          await sleep(250);
          continue;
        }

        for (const interaction of pending) {
          await handleInteraction({ interaction, backend, rl, auto });
        }

        continue;
      }

      output.write("[run] running...\n");
      await sleep(250);
    }
  } finally {
    webServer.stop();
    rl.close();
  }
};

void main();

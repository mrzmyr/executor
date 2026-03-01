"use client";

import type { ChangeEvent, FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { useAtomSet, useAtomValue } from "@effect-atom/atom-react";
import type { SourceCredentialBinding, SourceId } from "@executor-v2/schema";

import { useWorkspace } from "../../lib/hooks/use-workspace";
import {
  credentialBindingsByWorkspace,
  optimisticRemoveSources,
  optimisticSourcesByWorkspace,
  optimisticUpsertSources,
  removeSource,
  sourcesByWorkspace,
  sourcesPendingByWorkspace,
  toCredentialBindingUpsertPayload,
  upsertCredentialBinding,
  upsertSource,
} from "../../lib/control-plane/atoms";
import {
  formStateFromSource,
  sourceToLegacyRecord,
  upsertPayloadFromForm,
  type LegacySourceFormState,
  type LegacySourceType,
} from "../../lib/control-plane/legacy-source";
import {
  startMcpOAuthPopup,
  type McpOAuthPopupSuccess,
} from "../../lib/mcp/oauth-popup";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { cn, createLocalId } from "../../lib/utils";
import { matchState } from "../shared/match-state";
import { PageHeader } from "../shared/page-header";
import { StatusMessage } from "../shared/status-message";

const kindOptions: ReadonlyArray<LegacySourceType> = ["openapi", "mcp", "graphql"];

type CatalogTemplate = {
  id: string;
  name: string;
  summary: string;
  providerName: string;
  type: LegacySourceType;
  endpoint: string;
};

const catalogTemplates: ReadonlyArray<CatalogTemplate> = [
  {
    id: "deepwiki-mcp",
    name: "DeepWiki MCP",
    summary: "Read repository docs and ask questions through DeepWiki via MCP.",
    providerName: "DeepWiki",
    type: "mcp",
    endpoint: "https://mcp.deepwiki.com/mcp",
  },
  {
    id: "beeper-mcp",
    name: "Beeper MCP",
    summary: "Connect to your local Beeper Desktop MCP endpoint for chats, messages, and contacts.",
    providerName: "Beeper",
    type: "mcp",
    endpoint: "http://localhost:23373/v0/mcp",
  },
  {
    id: "neon-mcp",
    name: "Neon MCP",
    summary: "Create and manage Postgres branches, projects, and roles with Neon MCP tools.",
    providerName: "Neon",
    type: "mcp",
    endpoint: "https://mcp.neon.tech/mcp",
  },
  {
    id: "neon-openapi",
    name: "Neon API",
    summary: "Manage Neon projects, branches, and organization resources via REST API.",
    providerName: "Neon",
    type: "openapi",
    endpoint: "https://neon.com/api_spec/release/v2.json",
  },
  {
    id: "linear-graphql",
    name: "Linear GraphQL",
    summary: "Query issues, teams, and workflow data from Linear's GraphQL API.",
    providerName: "Linear",
    type: "graphql",
    endpoint: "https://api.linear.app/graphql",
  },
  {
    id: "github-rest",
    name: "GitHub REST API",
    summary: "Manage repositories, pull requests, issues, and org settings.",
    providerName: "GitHub",
    type: "openapi",
    endpoint:
      "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.yaml",
  },
  {
    id: "stripe-api",
    name: "Stripe API",
    summary: "Create payments, manage customers, and handle billing workflows.",
    providerName: "Stripe",
    type: "openapi",
    endpoint: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
  },
  {
    id: "openai-api",
    name: "OpenAI API",
    summary: "Generate text, run reasoning models, and process multimodal inputs.",
    providerName: "OpenAI",
    type: "openapi",
    endpoint: "https://app.stainless.com/api/spec/documented/openai/openapi.documented.yml",
  },
  {
    id: "cloudflare-api",
    name: "Cloudflare API",
    summary: "Control zones, DNS records, workers, and edge configuration.",
    providerName: "Cloudflare",
    type: "openapi",
    endpoint: "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.yaml",
  },
  {
    id: "vercel-api",
    name: "Vercel API",
    summary: "Manage deployments, projects, domains, and team resources.",
    providerName: "Vercel",
    type: "openapi",
    endpoint: "https://openapi.vercel.sh",
  },
  {
    id: "slack-api",
    name: "Slack API",
    summary: "Work with channels, messages, users, and workspace automation.",
    providerName: "Slack",
    type: "openapi",
    endpoint: "https://api.slack.com/specs/openapi/v2/slack_web.json",
  },
  {
    id: "sentry-api",
    name: "Sentry API",
    summary: "Query issues, releases, projects, and alerting configuration.",
    providerName: "Sentry",
    type: "openapi",
    endpoint:
      "https://raw.githubusercontent.com/getsentry/sentry-api-schema/refs/heads/main/openapi-derefed.json",
  },
  {
    id: "jira-cloud-api",
    name: "Jira Cloud Platform",
    summary: "Manage projects, issues, workflows, and Jira metadata.",
    providerName: "Atlassian",
    type: "openapi",
    endpoint: "https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json",
  },
  {
    id: "generic-mcp",
    name: "Generic MCP",
    summary: "Connect to any MCP server endpoint.",
    providerName: "Custom",
    type: "mcp",
    endpoint: "https://example.com/mcp",
  },
];
const defaultFormState = (): LegacySourceFormState => ({
  name: "",
  type: "openapi",
  endpoint: "",
  baseUrl: "",
  mcpTransport: "auto",
  authType: "none",
  authMode: "workspace",
  apiKeyHeader: "Authorization",
  enabled: true,
});

type McpOAuthDetectionState = {
  status: "idle" | "checking" | "oauth" | "none" | "error";
  detail: string;
  authorizationServers: ReadonlyArray<string>;
};

const defaultMcpOAuthDetectionState = (): McpOAuthDetectionState => ({
  status: "idle",
  detail: "",
  authorizationServers: [],
});

const normalizeEndpoint = (value: string): string => value.trim();

const statusBadgeVariant = (
  status: string,
): "outline" | "pending" | "approved" | "denied" => {
  if (status === "connected") {
    return "approved";
  }
  if (status === "error") {
    return "denied";
  }
  if (status === "pending") {
    return "pending";
  }
  return "outline";
};

export default function SourcesView() {
  const { workspaceId } = useWorkspace();

  const sources = useAtomValue(sourcesByWorkspace(workspaceId));
  const sourcesPending = useAtomValue(sourcesPendingByWorkspace(workspaceId));
  const credentialBindings = useAtomValue(credentialBindingsByWorkspace(workspaceId));
  const setOptimisticSources = useAtomSet(optimisticSourcesByWorkspace(workspaceId));
  const runUpsertSource = useAtomSet(upsertSource, { mode: "promise" });
  const runUpsertCredentialBinding = useAtomSet(upsertCredentialBinding, {
    mode: "promise",
  });
  const runRemoveSource = useAtomSet(removeSource, { mode: "promise" });

  const [formState, setFormState] = useState<LegacySourceFormState>(() => defaultFormState());
  const [searchQuery, setSearchQuery] = useState("");
  const [templateQuery, setTemplateQuery] = useState("");
  const [statusText, setStatusText] = useState<string | null>(null);
  const [mcpOAuthDetection, setMcpOAuthDetection] = useState<McpOAuthDetectionState>(
    () => defaultMcpOAuthDetectionState(),
  );
  const [mcpOAuthBusy, setMcpOAuthBusy] = useState(false);
  const [mcpOAuthSession, setMcpOAuthSession] = useState<McpOAuthPopupSuccess | null>(
    null,
  );

  const sourceItems = useMemo(
    () => sources.items.map(sourceToLegacyRecord),
    [sources.items],
  );

  const filteredSourceItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (query.length === 0) {
      return sourceItems;
    }

    return sourceItems.filter((source) => {
      return (
        source.name.toLowerCase().includes(query)
        || source.type.toLowerCase().includes(query)
        || source.endpoint.toLowerCase().includes(query)
        || source.status.toLowerCase().includes(query)
      );
    });
  }, [searchQuery, sourceItems]);

  const filteredCatalogTemplates = useMemo(() => {
    const query = templateQuery.trim().toLowerCase();
    if (query.length === 0) {
      return catalogTemplates;
    }

    return catalogTemplates.filter((template) => {
      return (
        template.name.toLowerCase().includes(query)
        || template.providerName.toLowerCase().includes(query)
        || template.type.toLowerCase().includes(query)
        || template.summary.toLowerCase().includes(query)
        || template.endpoint.toLowerCase().includes(query)
      );
    });
  }, [templateQuery]);

  const isEditing = Boolean(formState.id);

  const existingMcpOAuthCredential = useMemo(() => {
    if (!formState.id) {
      return null;
    }

    const sourceKey = `source:${formState.id}`;
    return (
      credentialBindings.items.find(
        (binding) =>
          binding.sourceKey === sourceKey && binding.provider === "oauth2",
      ) ?? null
    );
  }, [credentialBindings.items, formState.id]);

  const mcpOAuthSessionMatchesEndpoint = Boolean(
    mcpOAuthSession
      && normalizeEndpoint(mcpOAuthSession.sourceUrl)
        === normalizeEndpoint(formState.endpoint),
  );

  const mcpOAuthConnected =
    formState.type === "mcp"
    && (mcpOAuthSessionMatchesEndpoint || Boolean(existingMcpOAuthCredential));

  const mcpOAuthCanConnect =
    formState.type === "mcp" && mcpOAuthDetection.status === "oauth";

  const setFormField = <K extends keyof LegacySourceFormState>(
    key: K,
    value: LegacySourceFormState[K],
  ) => {
    setFormState((current) => ({
      ...current,
      [key]: value,
    }));
  };

  const resetForm = () => {
    setFormState(defaultFormState());
    setMcpOAuthDetection(defaultMcpOAuthDetectionState());
    setMcpOAuthSession(null);
    setMcpOAuthBusy(false);
  };

  useEffect(() => {
    const endpoint = normalizeEndpoint(formState.endpoint);

    if (formState.type !== "mcp" || endpoint.length === 0) {
      setMcpOAuthDetection(defaultMcpOAuthDetectionState());
      return;
    }

    const controller = new AbortController();
    setMcpOAuthDetection({
      status: "checking",
      detail: "Checking for OAuth support...",
      authorizationServers: [],
    });

    void fetch(`/mcp/oauth/detect?sourceUrl=${encodeURIComponent(endpoint)}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as
          | {
              oauth?: unknown;
              authorizationServers?: unknown;
              detail?: unknown;
            }
          | null;

        if (controller.signal.aborted) {
          return;
        }

        const oauth = payload?.oauth === true;
        const authorizationServers = Array.isArray(payload?.authorizationServers)
          ? payload.authorizationServers
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)
          : [];
        const detail = typeof payload?.detail === "string" ? payload.detail.trim() : "";

        if (!response.ok) {
          setMcpOAuthDetection({
            status: "error",
            detail: detail || `OAuth detection failed (${response.status})`,
            authorizationServers,
          });
          return;
        }

        setMcpOAuthDetection({
          status: oauth ? "oauth" : "none",
          detail,
          authorizationServers,
        });
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          return;
        }

        setMcpOAuthDetection({
          status: "error",
          detail: error instanceof Error ? error.message : "OAuth detection failed",
          authorizationServers: [],
        });
      });

    return () => {
      controller.abort();
    };
  }, [formState.endpoint, formState.type]);

  useEffect(() => {
    if (
      mcpOAuthSession
      && normalizeEndpoint(mcpOAuthSession.sourceUrl)
        !== normalizeEndpoint(formState.endpoint)
    ) {
      setMcpOAuthSession(null);
    }
  }, [formState.endpoint, mcpOAuthSession]);

  const handleMcpOAuthConnect = () => {
    const endpoint = normalizeEndpoint(formState.endpoint);
    if (endpoint.length === 0 || mcpOAuthBusy) {
      return;
    }

    setMcpOAuthBusy(true);

    void startMcpOAuthPopup(endpoint)
      .then((result) => {
        setMcpOAuthSession(result);
        setFormField("authType", "bearer");
        setFormField("authMode", "workspace");
        setStatusText("OAuth connected. Save source to persist credentials.");
      })
      .catch((error) => {
        setStatusText(
          error instanceof Error ? error.message : "OAuth connection failed.",
        );
      })
      .finally(() => {
        setMcpOAuthBusy(false);
      });
  };

  const handleTemplateUse = (template: CatalogTemplate) => {
    setMcpOAuthSession(null);
    setMcpOAuthBusy(false);
    setFormState((current) => ({
      ...current,
      id: undefined,
      name: template.name,
      type: template.type,
      endpoint: template.endpoint,
      baseUrl: "",
      mcpTransport: "auto",
    }));
    setStatusText(`Loaded template for ${template.name}.`);
  };

  const handleEdit = (sourceId: SourceId) => {
    const source = sourceItems.find((item) => item.id === sourceId);
    if (!source) {
      return;
    }

    setMcpOAuthSession(null);
    setMcpOAuthBusy(false);
    setFormState(formStateFromSource(source));
    setStatusText(`Editing ${source.name}.`);
  };

  const handleCancelEdit = () => {
    resetForm();
    setStatusText("Edit cancelled.");
  };

  const handleUpsertSource = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (sourcesPending) {
      return;
    }

    if (formState.name.trim().length === 0 || formState.endpoint.trim().length === 0) {
      setStatusText("Name and endpoint are required.");
      return;
    }

    const sourceId = formState.id ?? (createLocalId("src_") as SourceId);
    const payload = upsertPayloadFromForm({ workspaceId, form: formState, sourceId });
    const previousSources = sources.items;
    const optimistic = optimisticUpsertSources(previousSources, workspaceId, payload);

    const endpoint = normalizeEndpoint(formState.endpoint);
    const oauthSessionForEndpoint =
      formState.type === "mcp"
      && mcpOAuthSession
      && normalizeEndpoint(mcpOAuthSession.sourceUrl) === endpoint
        ? mcpOAuthSession
        : null;

    setOptimisticSources({
      items: optimistic.items,
      pendingAck: {
        kind: "upsert",
        sourceId: optimistic.sourceId,
      },
    });

    void runUpsertSource({ path: { workspaceId }, payload })
      .then(async () => {
        let oauthLinked = false;
        let oauthLinkNote: string | null = null;

        if (formState.type === "mcp" && oauthSessionForEndpoint) {
          const sourceKey = `source:${sourceId}`;
          const existingBindingForSource =
            credentialBindings.items.find(
              (binding) =>
                binding.sourceKey === sourceKey && binding.provider === "oauth2",
            ) ?? null;

          const scopeType =
            formState.authMode === "organization"
              ? "organization"
              : "workspace";

          if (formState.authMode === "account") {
            oauthLinkNote =
              "Account scope is not supported from this flow; OAuth credential was saved as workspace scope.";
          }

          try {
            await runUpsertCredentialBinding({
              path: { workspaceId },
              payload: toCredentialBindingUpsertPayload({
                ...(existingBindingForSource
                  ? { id: existingBindingForSource.id }
                  : {}),
                credentialId: (
                  existingBindingForSource?.credentialId
                  ?? createLocalId("cred_")
                ) as SourceCredentialBinding["credentialId"],
                scopeType,
                sourceKey,
                provider: "oauth2",
                secretRef: oauthSessionForEndpoint.accessToken,
                accountId: null,
                additionalHeadersJson: null,
                boundAuthFingerprint: null,
              }),
            });

            oauthLinked = true;
            setMcpOAuthSession(null);
          } catch {
            oauthLinkNote = "Source saved, but OAuth credential linking failed.";
          }
        }

        if (oauthLinked) {
          setStatusText(
            `${isEditing ? "Updated" : "Saved"} ${formState.name.trim()} and linked OAuth credentials.${oauthLinkNote ? ` ${oauthLinkNote}` : ""}`,
          );
        } else if (oauthLinkNote) {
          setStatusText(
            oauthLinkNote.startsWith("Source saved")
              ? oauthLinkNote
              : `${isEditing ? "Updated" : "Saved"} ${formState.name.trim()}. ${oauthLinkNote}`,
          );
        } else {
          setStatusText(
            isEditing
              ? `Updated ${formState.name.trim()}.`
              : `Saved ${formState.name.trim()}.`,
          );
        }

        resetForm();
      })
      .catch(() => {
        setStatusText("Source save failed.");
        setOptimisticSources(null);
      });
  };

  const handleRemoveSource = (sourceId: SourceId) => {
    if (sourcesPending) {
      return;
    }

    const previousSources = sources.items;
    const optimistic = optimisticRemoveSources(previousSources, sourceId);

    setOptimisticSources({
      items: optimistic.items,
      pendingAck: {
        kind: "remove",
        sourceId: optimistic.sourceId,
      },
    });

    void runRemoveSource({ path: { workspaceId, sourceId } })
      .then(() => {
        setStatusText("Source removed.");
        if (formState.id === sourceId) {
          resetForm();
        }
        setOptimisticSources(null);
      })
      .catch(() => {
        setStatusText("Source removal failed.");
        setOptimisticSources(null);
      });
  };

  const statusVariant: "info" | "error" = statusText?.toLowerCase().includes("failed")
    ? "error"
    : "info";

  return (
    <section className="space-y-4">
      <PageHeader
        title="Sources"
        description="Manage API sources, transports, and auth settings for your workspace."
      />

      <div className="grid gap-5 p-4 sm:p-6 lg:grid-cols-2 lg:p-6">
        <Card className="border-border/70">
          <CardHeader className="pb-3">
            <CardTitle>{isEditing ? "Edit Source" : "Add Source"}</CardTitle>
            <CardDescription>
              Configure endpoint metadata, MCP transport, and auth details in one flow.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="grid gap-1.5">
                <label className="text-xs text-muted-foreground" htmlFor="template-search">
                  Quick add from catalog ({catalogTemplates.length})
                </label>
                <Input
                  id="template-search"
                  value={templateQuery}
                  onChange={(event) => setTemplateQuery(event.target.value)}
                  placeholder="Search templates by name, provider, type"
                />
              </div>

              <div className="max-h-48 overflow-y-auto rounded-md border border-border/70 bg-muted/15 p-2">
                <div className="grid gap-2 sm:grid-cols-2">
                  {filteredCatalogTemplates.map((template) => (
                    <Button
                      key={template.id}
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-auto min-h-14 justify-start px-3 py-2 text-left"
                      onClick={() => handleTemplateUse(template)}
                    >
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium leading-tight">{template.name}</span>
                          <Badge variant="outline" className="text-[10px]">
                            {template.type}
                          </Badge>
                        </div>
                        <p className="line-clamp-2 text-[11px] font-normal text-muted-foreground">
                          {template.providerName} - {template.summary}
                        </p>
                      </div>
                    </Button>
                  ))}
                </div>

                {filteredCatalogTemplates.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-muted-foreground">
                    No templates match your search.
                  </p>
                ) : null}
              </div>
            </div>

            <form className="space-y-3" onSubmit={handleUpsertSource}>
              <div className="grid gap-1.5">
                <label className="text-xs text-muted-foreground" htmlFor="source-name">Name</label>
                <Input
                  id="source-name"
                  value={formState.name}
                  onChange={(event) => setFormField("name", event.target.value)}
                  required
                />
              </div>

              <div className="grid gap-1.5">
                <label className="text-xs text-muted-foreground" htmlFor="source-kind">Kind</label>
                <Select
                  id="source-kind"
                  value={formState.type}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                    setFormField("type", event.target.value as LegacySourceType)
                  }
                >
                  {kindOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
              </div>

              <div className="grid gap-1.5">
                <label className="text-xs text-muted-foreground" htmlFor="source-endpoint">
                  Endpoint
                </label>
                <Input
                  id="source-endpoint"
                  value={formState.endpoint}
                  onChange={(event) => setFormField("endpoint", event.target.value)}
                  placeholder="https://api.example.com/openapi.json"
                  required
                />
              </div>

              {formState.type === "openapi" ? (
                <div className="grid gap-1.5">
                  <label className="text-xs text-muted-foreground" htmlFor="source-base-url">
                    Base URL
                  </label>
                  <Input
                    id="source-base-url"
                    value={formState.baseUrl}
                    onChange={(event) => setFormField("baseUrl", event.target.value)}
                    placeholder="https://api.example.com"
                  />
                </div>
              ) : null}

              {formState.type === "mcp" ? (
                <div className="grid gap-1.5">
                  <label className="text-xs text-muted-foreground" htmlFor="source-transport">
                    MCP Transport
                  </label>
                  <Select
                    id="source-transport"
                    value={formState.mcpTransport}
                    onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                      setFormField(
                        "mcpTransport",
                        event.target.value as "auto" | "streamable-http" | "sse",
                      )
                    }
                  >
                    <option value="auto">auto</option>
                    <option value="streamable-http">streamable-http</option>
                    <option value="sse">sse</option>
                  </Select>
                </div>
              ) : null}

              {formState.type === "mcp" ? (
                <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <p className="text-xs font-medium text-foreground">MCP OAuth</p>
                        {mcpOAuthConnected ? (
                          <Badge variant="approved" className="text-[10px] uppercase tracking-wide">
                            connected
                          </Badge>
                        ) : null}
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        {mcpOAuthDetection.status === "checking"
                          ? "Checking endpoint for OAuth support..."
                          : mcpOAuthDetection.status === "oauth"
                            ? "OAuth is supported for this MCP endpoint."
                            : mcpOAuthDetection.status === "none"
                              ? "OAuth was not detected for this endpoint."
                              : mcpOAuthDetection.status === "error"
                                ? "OAuth detection failed."
                                : "Set an MCP endpoint to detect OAuth support."}
                      </p>
                      {mcpOAuthDetection.detail.length > 0 ? (
                        <p className="text-[11px] text-muted-foreground">
                          {mcpOAuthDetection.detail}
                        </p>
                      ) : null}
                      {mcpOAuthDetection.authorizationServers.length > 0 ? (
                        <p className="text-[11px] text-muted-foreground">
                          Auth servers: {mcpOAuthDetection.authorizationServers.join(", ")}
                        </p>
                      ) : null}
                    </div>

                    {mcpOAuthCanConnect ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        onClick={handleMcpOAuthConnect}
                        disabled={mcpOAuthBusy}
                      >
                        {mcpOAuthBusy
                          ? "Connecting..."
                          : mcpOAuthConnected
                            ? "Reconnect OAuth"
                            : "Connect OAuth"}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <label className="text-xs text-muted-foreground" htmlFor="source-auth-type">Auth Type</label>
                  <Select
                    id="source-auth-type"
                    value={formState.authType}
                    onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                      setFormField("authType", event.target.value as "none" | "bearer" | "apiKey" | "basic")
                    }
                  >
                    <option value="none">none</option>
                    <option value="bearer">bearer</option>
                    <option value="apiKey">apiKey</option>
                    <option value="basic">basic</option>
                  </Select>
                </div>

                <div className="grid gap-1.5">
                  <label className="text-xs text-muted-foreground" htmlFor="source-auth-mode">Auth Scope</label>
                  <Select
                    id="source-auth-mode"
                    value={formState.authMode}
                    onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                      setFormField("authMode", event.target.value as "workspace" | "organization" | "account")
                    }
                  >
                    <option value="workspace">workspace</option>
                    <option value="organization">organization</option>
                    <option value="account">account</option>
                  </Select>
                </div>
              </div>

              {formState.authType === "apiKey" ? (
                <div className="grid gap-1.5">
                  <label className="text-xs text-muted-foreground" htmlFor="source-auth-header">
                    API Key Header
                  </label>
                  <Input
                    id="source-auth-header"
                    value={formState.apiKeyHeader}
                    onChange={(event) => setFormField("apiKeyHeader", event.target.value)}
                    placeholder="Authorization"
                  />
                </div>
              ) : null}

              <label
                htmlFor="source-enabled"
                className={cn(
                  "flex items-center justify-between rounded-md border border-border bg-muted/35 px-3 py-2 text-xs",
                  formState.enabled ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <span className="font-medium">Enabled</span>
                <input
                  id="source-enabled"
                  checked={formState.enabled}
                  onChange={(event) => setFormField("enabled", event.target.checked)}
                  type="checkbox"
                  className="size-4 rounded border-input bg-background text-primary focus:ring-2 focus:ring-ring/60 focus:ring-offset-1"
                />
              </label>

              <div className="grid gap-2 sm:grid-cols-2">
                <Button type="submit" disabled={sourcesPending}>
                  {sourcesPending
                    ? "Saving..."
                    : isEditing
                    ? "Save Source"
                    : "Add Source"}
                </Button>

                {isEditing ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleCancelEdit}
                    disabled={sourcesPending}
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
            </form>

            <StatusMessage
              message={statusText}
              variant={statusVariant}
              className="text-[12px]"
            />
          </CardContent>
        </Card>

        <Card className="border-border/70">
          <CardHeader className="pb-3">
            <CardTitle>Sources</CardTitle>
            <CardDescription>Review existing sources and update quickly.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-1.5">
              <label className="text-xs text-muted-foreground" htmlFor="source-search">Search</label>
              <Input
                id="source-search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search by name, kind, endpoint"
              />
            </div>

            {matchState(sources, {
              loading: "Loading sources...",
              empty:
                sourceItems.length === 0
                  ? "No sources yet in this workspace."
                  : "No sources match your search.",
              filteredCount: filteredSourceItems.length,
              ready: () => (
                <div className="space-y-2">
                  {filteredSourceItems.map((source) => (
                    <div
                      key={source.id}
                      className={cn(
                        "rounded-lg border border-border bg-background/70 p-3 transition",
                        source.enabled ? "opacity-100" : "opacity-80",
                      )}
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 space-y-1">
                          <p className="truncate text-sm font-medium">{source.name}</p>
                          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                            <Badge variant="outline">{source.type}</Badge>
                            <Badge variant={statusBadgeVariant(source.status)}>{source.status}</Badge>
                            <Badge variant={source.enabled ? "secondary" : "outline"}>
                              {source.enabled ? "enabled" : "disabled"}
                            </Badge>
                          </div>
                          <p className="break-all text-xs text-muted-foreground">{source.endpoint}</p>
                        </div>

                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => handleEdit(source.id)}
                            disabled={sourcesPending}
                          >
                            Edit
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            onClick={() => handleRemoveSource(source.id)}
                            disabled={sourcesPending}
                          >
                            Remove
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ),
            })}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

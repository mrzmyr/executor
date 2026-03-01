"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useAtomSet, useAtomValue } from "@effect-atom/atom-react";
import type { Organization, Workspace } from "@executor-v2/schema";

import {
  organizationsState,
  toOrganizationUpsertPayload,
  toWorkspaceUpsertPayload,
  upsertOrganization,
  upsertWorkspace,
  workspacesState,
} from "../../lib/control-plane/atoms";
import { useWorkspace } from "../../lib/hooks/use-workspace";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";

type StatusState = {
  message: string | null;
  variant: "info" | "error";
};

type WorkspaceGroup = {
  key: string;
  label: string;
  workspaces: Array<Workspace>;
};

const defaultStatus = (): StatusState => ({ message: null, variant: "info" });

const slugify = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .replace(/-{2,}/g, "-");

export function WorkspaceSelector() {
  const { workspaceId, setWorkspaceId } = useWorkspace();
  const organizations = useAtomValue(organizationsState);
  const workspaces = useAtomValue(workspacesState);
  const runUpsertOrganization = useAtomSet(upsertOrganization, { mode: "promise" });
  const runUpsertWorkspace = useAtomSet(upsertWorkspace, { mode: "promise" });

  const [activeForm, setActiveForm] = useState<"workspace" | "organization" | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceOrganizationId, setWorkspaceOrganizationId] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [organizationSlug, setOrganizationSlug] = useState("");
  const [status, setStatus] = useState<StatusState>(defaultStatus);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [creatingOrganization, setCreatingOrganization] = useState(false);

  const organizationNameById = useMemo(
    () =>
      new Map<string, string>(
        organizations.items.map((organization) => [organization.id, organization.name]),
      ),
    [organizations.items],
  );

  const currentWorkspace = useMemo(
    () => workspaces.items.find((workspace) => workspace.id === workspaceId) ?? null,
    [workspaces.items, workspaceId],
  );

  const currentOrganizationLabel = useMemo(() => {
    if (!currentWorkspace?.organizationId) {
      return "No organization";
    }

    return organizationNameById.get(currentWorkspace.organizationId)
      ?? currentWorkspace.organizationId;
  }, [currentWorkspace, organizationNameById]);

  const workspaceGroups = useMemo((): Array<WorkspaceGroup> => {
    const byGroup = new Map<string, WorkspaceGroup>();

    for (const workspace of workspaces.items) {
      const key = workspace.organizationId ?? "__none__";
      const label =
        workspace.organizationId === null
          ? "No organization"
          : organizationNameById.get(workspace.organizationId) ?? workspace.organizationId;

      const existing = byGroup.get(key);
      if (existing) {
        existing.workspaces.push(workspace);
        continue;
      }

      byGroup.set(key, {
        key,
        label,
        workspaces: [workspace],
      });
    }

    return [...byGroup.values()].sort((left, right) => {
      if (left.key === "__none__") return -1;
      if (right.key === "__none__") return 1;
      return left.label.localeCompare(right.label);
    });
  }, [organizationNameById, workspaces.items]);

  useEffect(() => {
    if (workspaces.state !== "ready") {
      return;
    }

    if (workspaces.items.length === 0) {
      return;
    }

    const hasCurrentWorkspace = workspaces.items.some(
      (workspace) => workspace.id === workspaceId,
    );

    if (!hasCurrentWorkspace) {
      setWorkspaceId(workspaces.items[0].id);
    }
  }, [setWorkspaceId, workspaceId, workspaces.items, workspaces.state]);

  const openWorkspaceForm = () => {
    setStatus(defaultStatus());
    if (activeForm === "workspace") {
      setActiveForm(null);
      return;
    }

    setActiveForm("workspace");
    setWorkspaceName("");

    if (currentWorkspace?.organizationId) {
      setWorkspaceOrganizationId(currentWorkspace.organizationId);
      return;
    }

    setWorkspaceOrganizationId(organizations.items[0]?.id ?? "");
  };

  const openOrganizationForm = () => {
    setStatus(defaultStatus());
    if (activeForm === "organization") {
      setActiveForm(null);
      return;
    }

    setActiveForm("organization");
    setOrganizationName("");
    setOrganizationSlug("");
  };

  const handleCreateWorkspace = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const name = workspaceName.trim();
    const organizationId = workspaceOrganizationId.trim();

    if (name.length < 2) {
      setStatus({
        message: "Workspace name must be at least 2 characters.",
        variant: "error",
      });
      return;
    }

    setCreatingWorkspace(true);

    void runUpsertWorkspace({
      payload: toWorkspaceUpsertPayload({
        name,
        organizationId: organizationId.length > 0
          ? (organizationId as Workspace["organizationId"])
          : null,
      }),
    })
      .then((workspace) => {
        setWorkspaceId(workspace.id);
        setWorkspaceName("");
        setActiveForm(null);
        setStatus({
          message: `Created workspace ${workspace.name}.`,
          variant: "info",
        });
      })
      .catch(() => {
        setStatus({
          message: "Workspace creation failed.",
          variant: "error",
        });
      })
      .finally(() => {
        setCreatingWorkspace(false);
      });
  };

  const handleCreateOrganization = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const name = organizationName.trim();
    const generatedSlug = slugify(name);
    const slugInput = organizationSlug.trim();
    const slug = slugInput.length > 0 ? slugify(slugInput) : generatedSlug;

    if (name.length < 2) {
      setStatus({
        message: "Organization name must be at least 2 characters.",
        variant: "error",
      });
      return;
    }

    if (slug.length === 0) {
      setStatus({
        message: "Organization slug is required.",
        variant: "error",
      });
      return;
    }

    setCreatingOrganization(true);

    void runUpsertOrganization({
      payload: toOrganizationUpsertPayload({
        name,
        slug,
        status: "active",
      }),
    })
      .then(async (organization) => {
        const workspace = await runUpsertWorkspace({
          payload: toWorkspaceUpsertPayload({
            name,
            organizationId: organization.id as Workspace["organizationId"],
          }),
        });

        setWorkspaceId(workspace.id);
        setWorkspaceOrganizationId(organization.id);
        setOrganizationName("");
        setOrganizationSlug("");
        setActiveForm(null);
        setStatus({
          message: `Created organization ${organization.name} with workspace ${workspace.name}.`,
          variant: "info",
        });
      })
      .catch(() => {
        setStatus({
          message: "Organization creation failed.",
          variant: "error",
        });
      })
      .finally(() => {
        setCreatingOrganization(false);
      });
  };

  const selectorDisabled = workspaces.state === "loading" || workspaces.items.length === 0;

  return (
    <div className="space-y-2">
      <div>
        <label className="block text-[10px] uppercase tracking-widest text-sidebar-foreground/50">
          Workspace
        </label>
        <p className="mt-0.5 truncate text-[10px] text-sidebar-foreground/50">
          {currentWorkspace ? currentOrganizationLabel : "Create your first workspace"}
        </p>
      </div>

      <Select
        value={workspaceId}
        onChange={(event) => {
          setWorkspaceId(event.target.value);
          setStatus(defaultStatus());
        }}
        disabled={selectorDisabled}
        className="h-8 border-sidebar-border bg-sidebar-active/50 px-2 text-[12px] text-sidebar-foreground"
      >
        {workspaces.state === "loading" ? (
          <option value="">Loading workspaces...</option>
        ) : null}

        {workspaces.state !== "loading" && workspaces.items.length === 0 ? (
          <option value="">No workspaces available</option>
        ) : null}

        {workspaceGroups.map((group) => (
          <optgroup key={group.key} label={group.label}>
            {group.workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </optgroup>
        ))}
      </Select>

      <div className="flex gap-1">
        <Button
          type="button"
          size="sm"
          variant={activeForm === "workspace" ? "secondary" : "ghost"}
          className="h-7 flex-1 px-2 text-[11px]"
          onClick={openWorkspaceForm}
        >
          + Workspace
        </Button>
        <Button
          type="button"
          size="sm"
          variant={activeForm === "organization" ? "secondary" : "ghost"}
          className="h-7 flex-1 px-2 text-[11px]"
          onClick={openOrganizationForm}
        >
          + Org
        </Button>
      </div>

      {activeForm === "workspace" ? (
        <form className="space-y-1.5 rounded-md border border-sidebar-border p-2" onSubmit={handleCreateWorkspace}>
          <Input
            value={workspaceName}
            onChange={(event) => setWorkspaceName(event.target.value)}
            placeholder="Workspace name"
            className="h-8 border-sidebar-border bg-sidebar px-2 text-[12px]"
            maxLength={64}
          />
          <Select
            value={workspaceOrganizationId}
            onChange={(event) => setWorkspaceOrganizationId(event.target.value)}
            className="h-8 border-sidebar-border bg-sidebar px-2 text-[12px]"
          >
            <option value="">No organization</option>
            {organizations.items.map((organization) => (
              <option key={organization.id} value={organization.id}>
                {organization.name}
              </option>
            ))}
          </Select>
          <Button
            type="submit"
            size="sm"
            className="h-7 w-full text-[11px]"
            disabled={creatingWorkspace}
          >
            {creatingWorkspace ? "Creating..." : "Create workspace"}
          </Button>
        </form>
      ) : null}

      {activeForm === "organization" ? (
        <form className="space-y-1.5 rounded-md border border-sidebar-border p-2" onSubmit={handleCreateOrganization}>
          <Input
            value={organizationName}
            onChange={(event) => setOrganizationName(event.target.value)}
            placeholder="Organization name"
            className="h-8 border-sidebar-border bg-sidebar px-2 text-[12px]"
            maxLength={64}
          />
          <Input
            value={organizationSlug}
            onChange={(event) => setOrganizationSlug(event.target.value)}
            placeholder="Slug (optional)"
            className="h-8 border-sidebar-border bg-sidebar px-2 text-[12px]"
            maxLength={64}
          />
          <Button
            type="submit"
            size="sm"
            className="h-7 w-full text-[11px]"
            disabled={creatingOrganization}
          >
            {creatingOrganization ? "Creating..." : "Create organization"}
          </Button>
        </form>
      ) : null}

      {workspaces.state === "error" ? (
        <p className="text-[11px] text-destructive">{workspaces.message}</p>
      ) : null}
      {organizations.state === "error" ? (
        <p className="text-[11px] text-destructive">{organizations.message}</p>
      ) : null}
      {status.message ? (
        <p className={status.variant === "error" ? "text-[11px] text-destructive" : "text-[11px] text-sidebar-foreground/70"}>
          {status.message}
        </p>
      ) : null}
    </div>
  );
}

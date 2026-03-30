import type {
  LocalScopePolicy,
  LocalScopePolicyApprovalMode,
  LocalScopePolicyEffect,
} from "@executor/platform-sdk/schema";

import { cn } from "../lib/cn";

export type ToolPermissionLevel = "auto-run" | "requires-approval" | "denied" | "unknown";

const matchesGlob = (pattern: string, value: string): boolean => {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
};

const policySpecificity = (policy: LocalScopePolicy): number =>
  policy.priority + Math.max(1, policy.resourcePattern.replace(/\*/g, "").length);

export const resolveToolPermission = (
  toolPath: string,
  policies: ReadonlyArray<LocalScopePolicy>,
): {
  level: ToolPermissionLevel;
  matchedPolicy: LocalScopePolicy | null;
} => {
  const matching = policies
    .filter(
      (policy) =>
        policy.enabled && matchesGlob(policy.resourcePattern, toolPath),
    )
    .sort(
      (left, right) =>
        policySpecificity(right) - policySpecificity(left) ||
        left.updatedAt - right.updatedAt,
    );

  const matched = matching[0];
  if (!matched) {
    return { level: "unknown", matchedPolicy: null };
  }

  if (matched.effect === "deny") {
    return { level: "denied", matchedPolicy: matched };
  }

  if (matched.approvalMode === "required") {
    return { level: "requires-approval", matchedPolicy: matched };
  }

  return { level: "auto-run", matchedPolicy: matched };
};

const permissionStyles: Record<
  ToolPermissionLevel,
  { label: string; dotClass: string; textClass: string }
> = {
  "auto-run": {
    label: "Auto",
    dotClass: "bg-emerald-500",
    textClass: "text-emerald-600 dark:text-emerald-400",
  },
  "requires-approval": {
    label: "Approval",
    dotClass: "bg-amber-500",
    textClass: "text-amber-600 dark:text-amber-400",
  },
  denied: {
    label: "Denied",
    dotClass: "bg-red-500",
    textClass: "text-red-600 dark:text-red-400",
  },
  unknown: {
    label: "",
    dotClass: "bg-muted-foreground/30",
    textClass: "text-muted-foreground/50",
  },
};

export const ToolPermissionDot = (props: {
  toolPath: string;
  policies: ReadonlyArray<LocalScopePolicy>;
  className?: string;
}) => {
  const { level } = resolveToolPermission(props.toolPath, props.policies);
  if (level === "unknown") return null;

  const style = permissionStyles[level];

  return (
    <span
      className={cn("size-1.5 shrink-0 rounded-full", style.dotClass, props.className)}
      title={style.label}
    />
  );
};

export const ToolPermissionBadge = (props: {
  toolPath: string;
  policies: ReadonlyArray<LocalScopePolicy>;
  className?: string;
}) => {
  const { level, matchedPolicy } = resolveToolPermission(
    props.toolPath,
    props.policies,
  );
  if (level === "unknown") return null;

  const style = permissionStyles[level];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
        level === "auto-run" &&
          "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        level === "requires-approval" &&
          "border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400",
        level === "denied" &&
          "border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400",
        props.className,
      )}
      title={
        matchedPolicy
          ? `Matched policy: ${matchedPolicy.resourcePattern}`
          : undefined
      }
    >
      <span className={cn("size-1 rounded-full", style.dotClass)} />
      {style.label}
    </span>
  );
};

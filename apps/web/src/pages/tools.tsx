import { useAtomValue, Result, toolsAtom } from "@executor/react";

export function ToolsPage() {
  const tools = useAtomValue(toolsAtom());

  return (
    <div>
      <h1 className="text-xl font-semibold text-foreground">Tools</h1>

      {Result.match(tools, {
        onInitial: () => (
          <p className="mt-4 text-sm text-muted-foreground">Loading tools…</p>
        ),
        onFailure: () => (
          <p className="mt-4 text-sm text-destructive">Failed to load tools</p>
        ),
        onSuccess: ({ value }) =>
          value.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">
              No tools registered yet. Add a source to get started.
            </p>
          ) : (
            <div className="mt-4">
              <p className="text-sm text-muted-foreground mb-3">
                {value.length} tool{value.length !== 1 ? "s" : ""} available
              </p>
              <div className="grid gap-2">
                {value.map((t) => (
                  <div
                    key={t.id}
                    className="rounded-lg border border-border bg-card p-3 transition-colors hover:bg-accent/50"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-card-foreground truncate">
                          {t.name}
                        </p>
                        {t.description && (
                          <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                            {t.description}
                          </p>
                        )}
                      </div>
                      {t.tags.length > 0 && (
                        <div className="flex shrink-0 gap-1">
                          {t.tags.slice(0, 2).map((tag) => (
                            <span
                              key={tag}
                              className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ),
      })}
    </div>
  );
}

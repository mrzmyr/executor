import { useAtomValue, Result, secretsAtom } from "@executor/react";

export function SecretsPage() {
  const secrets = useAtomValue(secretsAtom());

  return (
    <div>
      <h1 className="text-xl font-semibold text-foreground">Secrets</h1>

      {Result.match(secrets, {
        onInitial: () => (
          <p className="mt-4 text-sm text-muted-foreground">Loading secrets…</p>
        ),
        onFailure: () => (
          <p className="mt-4 text-sm text-destructive">Failed to load secrets</p>
        ),
        onSuccess: ({ value }) =>
          value.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">
              No secrets stored yet. Secrets are created when you configure authentication for a source.
            </p>
          ) : (
            <div className="mt-4 grid gap-2">
              {value.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between rounded-lg border border-border bg-card p-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-card-foreground">{s.name}</p>
                    {s.purpose && (
                      <p className="mt-0.5 text-xs text-muted-foreground">{s.purpose}</p>
                    )}
                  </div>
                  {s.provider && (
                    <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
                      {s.provider}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ),
      })}
    </div>
  );
}

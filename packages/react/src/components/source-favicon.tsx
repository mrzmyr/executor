import { useState } from "react";

// ---------------------------------------------------------------------------
// SourceFavicon — renders a small favicon derived from a source URL.
// Falls back to a neutral dot if the URL is missing or the image fails to load.
// ---------------------------------------------------------------------------

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function SourceFavicon({ url, size = 16 }: { url?: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const hostname = url ? hostnameOf(url) : null;

  if (!hostname || failed) {
    return (
      <span
        aria-hidden
        className="shrink-0 rounded-full bg-muted-foreground/25"
        style={{ width: size * 0.375, height: size * 0.375 }}
      />
    );
  }

  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${hostname}&sz=${size * 2}`}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      className="shrink-0 rounded-sm"
      style={{ width: size, height: size }}
    />
  );
}

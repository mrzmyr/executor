const firstHeaderValue = (value: string | null): string => {
  if (!value) {
    return "";
  }

  return value.split(",")[0]?.trim() ?? "";
};

const configuredExternalOrigin = (): string | null => {
  const configured =
    process.env.EXECUTOR_PUBLIC_ORIGIN
    ?? process.env.NEXT_PUBLIC_APP_ORIGIN
    ?? process.env.VERCEL_PROJECT_PRODUCTION_URL
    ?? process.env.VERCEL_URL
    ?? "";

  if (!configured.trim()) {
    return null;
  }

  try {
    const normalized =
      configured.startsWith("http://") || configured.startsWith("https://")
        ? configured
        : `https://${configured}`;

    return new URL(normalized).origin;
  } catch {
    return null;
  }
};

export const getExternalOrigin = (request: Request): string => {
  const configured = configuredExternalOrigin();
  if (configured) {
    return configured;
  }

  const host = firstHeaderValue(
    request.headers.get("x-forwarded-host") ?? request.headers.get("host"),
  );
  const requestUrl = new URL(request.url);
  const proto =
    firstHeaderValue(request.headers.get("x-forwarded-proto"))
    || requestUrl.protocol.replace(":", "");

  if (host && proto) {
    try {
      return new URL(`${proto}://${host}`).origin;
    } catch {
      return requestUrl.origin;
    }
  }

  return requestUrl.origin;
};

export const isExternalHttps = (request: Request): boolean =>
  getExternalOrigin(request).startsWith("https://");

const isLocalHost = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";

const localHttpAllowed = (): boolean =>
  process.env.NODE_ENV !== "production"
  || process.env.EXECUTOR_ALLOW_LOCAL_MCP_OAUTH === "1";

export const parseMcpSourceUrl = (raw: string): URL => {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid MCP source URL");
  }

  if (url.username || url.password) {
    throw new Error("Credentials in MCP source URL are not allowed");
  }

  if (url.protocol === "https:") {
    return url;
  }

  if (url.protocol === "http:" && localHttpAllowed() && isLocalHost(url.hostname.toLowerCase())) {
    return url;
  }

  throw new Error("MCP source URL must use https:// (http://localhost allowed in local dev)");
};

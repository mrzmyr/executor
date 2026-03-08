import { describe, expect, it } from "vitest";

import { createTerminalSourceAuthSessionPatch } from "./source-auth-service";

describe("source-auth-service", () => {
  it("clears ephemeral OAuth session fields when failing a session", () => {
    const patch = createTerminalSourceAuthSessionPatch({
      status: "failed",
      now: 123,
      errorText: "OAuth authorization failed",
      resourceMetadataUrl: "https://example.com/resource",
      authorizationServerUrl: "https://example.com/as",
      resourceMetadataJson: '{"issuer":"https://example.com"}',
      authorizationServerMetadataJson: '{"token_endpoint":"https://example.com/token"}',
    });

    expect(patch).toMatchObject({
      status: "failed",
      errorText: "OAuth authorization failed",
      completedAt: 123,
      updatedAt: 123,
      codeVerifier: null,
      authorizationUrl: null,
      clientInformationJson: null,
      resourceMetadataUrl: "https://example.com/resource",
      authorizationServerUrl: "https://example.com/as",
      resourceMetadataJson: '{"issuer":"https://example.com"}',
      authorizationServerMetadataJson: '{"token_endpoint":"https://example.com/token"}',
    });
  });

  it("clears ephemeral OAuth session fields when completing a session", () => {
    const patch = createTerminalSourceAuthSessionPatch({
      status: "completed",
      now: 456,
      errorText: null,
      resourceMetadataUrl: "https://example.com/resource",
      authorizationServerUrl: "https://example.com/as",
      resourceMetadataJson: '{"issuer":"https://example.com"}',
      authorizationServerMetadataJson: '{"token_endpoint":"https://example.com/token"}',
    });

    expect(patch).toMatchObject({
      status: "completed",
      errorText: null,
      completedAt: 456,
      updatedAt: 456,
      codeVerifier: null,
      authorizationUrl: null,
      clientInformationJson: null,
      resourceMetadataUrl: "https://example.com/resource",
      authorizationServerUrl: "https://example.com/as",
      resourceMetadataJson: '{"issuer":"https://example.com"}',
      authorizationServerMetadataJson: '{"token_endpoint":"https://example.com/token"}',
    });
  });
});

import { describe, expect, it } from "@effect/vitest";
import { assertRight } from "@effect/vitest/utils";
import { Config, ConfigProvider, Effect } from "effect";

import { createEnv, Env, makeEnv } from "./index";

describe("makeEnv", () => {
  it("creates a tag with an Effect Config and default layer", () => {
    const AppEnv = makeEnv("AppEnv", {
      PORT: Env.number("PORT"),
      HOST: Env.stringOr("HOST", "localhost"),
    });

    const parsed = Effect.runSync(
      Effect.withConfigProvider(
        ConfigProvider.fromMap(
          new Map([
            ["PORT", "8080"],
            ["HOST", "0.0.0.0"],
          ]),
        ),
      )(Effect.either(AppEnv.config)),
    );

    assertRight(parsed, {
      PORT: 8080,
      HOST: "0.0.0.0",
    });

    expect(AppEnv.Default).toBeDefined();
  });
});

describe("createEnv", () => {
  it("validates server, client, and shared values", () => {
    const env = createEnv({
      server: {
        PORT: Env.number("PORT"),
      },
      shared: {
        NODE_ENV: Env.literal("NODE_ENV", "development", "production", "test"),
      },
      clientPrefix: "PUBLIC_",
      client: {
        PUBLIC_API_URL: Env.url("PUBLIC_API_URL"),
      },
      runtimeEnv: {
        PORT: "3000",
        NODE_ENV: "development",
        PUBLIC_API_URL: "https://api.example.com",
      },
    });

    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe("development");
    expect(env.PUBLIC_API_URL).toBe("https://api.example.com");
  });

  it("throws with the default validation handler", () => {
    expect(() =>
      createEnv({
        server: {
          PORT: Env.number("PORT"),
        },
        runtimeEnv: {
          PORT: "not-a-number",
        },
      }),
    ).toThrow("Invalid environment variables");
  });

  it("supports custom validation handlers", () => {
    expect(() =>
      createEnv({
        server: {
          PORT: Env.number("PORT"),
        },
        runtimeEnv: {
          PORT: "nope",
        },
        onValidationError: (issues) => {
          const portIssue = issues.find((issue) => issue.path.includes("PORT"));
          throw new Error(`PORT invalid: ${portIssue?.message ?? "unknown"}`);
        },
      }),
    ).toThrow("PORT invalid:");
  });

  it("prevents server variable access on the client", () => {
    const env = createEnv({
      server: {
        SECRET: Env.string("SECRET"),
      },
      shared: {
        NODE_ENV: Env.literal("NODE_ENV", "development", "production", "test"),
      },
      clientPrefix: "PUBLIC_",
      client: {
        PUBLIC_SITE_NAME: Env.string("PUBLIC_SITE_NAME"),
      },
      runtimeEnv: {
        SECRET: "top-secret",
        NODE_ENV: "development",
        PUBLIC_SITE_NAME: "executor",
      },
      isServer: false,
    });

    expect(() => env.SECRET).toThrow(
      "❌ Attempted to access a server-side environment variable on the client",
    );
    expect(env.PUBLIC_SITE_NAME).toBe("executor");
    expect(env.NODE_ENV).toBe("development");
  });

  it("supports custom invalid-access handlers", () => {
    const env = createEnv({
      server: {
        SECRET: Env.string("SECRET"),
      },
      clientPrefix: "PUBLIC_",
      client: {
        PUBLIC_SITE_NAME: Env.string("PUBLIC_SITE_NAME"),
      },
      runtimeEnv: {
        SECRET: "top-secret",
        PUBLIC_SITE_NAME: "executor",
      },
      isServer: false,
      onInvalidAccess: (variable) => {
        throw new Error(`Blocked ${variable}`);
      },
    });

    expect(() => env.SECRET).toThrow("Blocked SECRET");
  });

  it("treats empty strings as undefined when requested", () => {
    const withoutOption = createEnv({
      server: {
        HOST: Env.stringOr("HOST", "localhost"),
      },
      runtimeEnv: {
        HOST: "",
      },
    });

    const withOption = createEnv({
      server: {
        HOST: Env.stringOr("HOST", "localhost"),
      },
      runtimeEnv: {
        HOST: "",
      },
      emptyStringAsUndefined: true,
    });

    expect(withoutOption.HOST).toBe("");
    expect(withOption.HOST).toBe("localhost");
  });

  it("extends other env objects and allows local overrides", () => {
    const preset = createEnv({
      server: {
        PRESET_ENV: Env.literal("PRESET_ENV", "preset", "overridden"),
        PRESET_SECRET: Env.string("PRESET_SECRET"),
      },
      runtimeEnv: {
        PRESET_ENV: "preset",
        PRESET_SECRET: "preset-secret",
      },
    });

    const env = createEnv({
      server: {
        PRESET_ENV: Env.literal("PRESET_ENV", "overridden"),
        APP_ENV: Env.string("APP_ENV"),
      },
      extends: [preset],
      runtimeEnv: {
        PRESET_ENV: "overridden",
        APP_ENV: "local",
      },
    });

    expect(env.PRESET_ENV).toBe("overridden");
    expect(env.PRESET_SECRET).toBe("preset-secret");
    expect(env.APP_ENV).toBe("local");
  });

  it("supports skipping validation", () => {
    const env = createEnv({
      server: {
        PORT: Env.number("PORT"),
      },
      runtimeEnv: {
        PORT: "not-a-number",
      },
      skipValidation: true,
    });

    expect(env.PORT).toBe("not-a-number");
  });

  it("supports createFinalConfig transformations", () => {
    const env = createEnv({
      server: {
        HOST: Env.string("HOST"),
        PORT: Env.number("PORT"),
      },
      runtimeEnv: {
        HOST: "localhost",
        PORT: "4000",
      },
      createFinalConfig: (shape) =>
        Config.all(shape).pipe(
          Config.map((value) => ({
            ...value,
            BASE_URL: `http://${value.HOST}:${value.PORT}`,
          })),
        ),
    });

    expect(env.HOST).toBe("localhost");
    expect(env.PORT).toBe(4000);
    expect(env.BASE_URL).toBe("http://localhost:4000");
  });

  it("enforces prefix and runtimeEnvStrict at type level", () => {
    createEnv({
      clientPrefix: "PUBLIC_",
      server: {
        SECRET: Env.string("SECRET"),
      },
      client: {
        PUBLIC_SITE_NAME: Env.string("PUBLIC_SITE_NAME"),
      },
      runtimeEnvStrict: {
        SECRET: "top-secret",
        PUBLIC_SITE_NAME: "executor",
      },
    });

    if (false) {
      createEnv({
        clientPrefix: "PUBLIC_",
        server: {
          // @ts-expect-error Server keys should not use the client prefix
          PUBLIC_SECRET: Env.string("PUBLIC_SECRET"),
        },
        client: {},
        runtimeEnvStrict: {},
      });

      createEnv({
        clientPrefix: "PUBLIC_",
        server: {},
        client: {
          // @ts-expect-error Client keys must include the client prefix
          SITE_NAME: Env.string("SITE_NAME"),
        },
        runtimeEnvStrict: {},
      });
    }

    expect(true).toBe(true);
  });
});

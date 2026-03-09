import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { buildDistributionPackage } from "./artifact";
import { repoRoot } from "./metadata";
import { buildPortableDistribution, portableTargetIds } from "./portable";

const defaultReleaseDir = resolve(repoRoot, "apps/executor/dist/release");

type CommandInput = {
  command: string;
  args: ReadonlyArray<string>;
  cwd: string;
};

type CommandOutput = {
  stdout: string;
  stderr: string;
};

type PackResult = {
  filename?: string;
};

const runCommand = async (input: CommandInput): Promise<CommandOutput> => {
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number>((resolveExitCode, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      resolveExitCode(code ?? -1);
    });
  });

  if (exitCode !== 0) {
    throw new Error(
      [
        `${input.command} ${input.args.join(" ")} exited with code ${exitCode}`,
        stdout.trim().length > 0 ? `stdout:\n${stdout.trim()}` : null,
        stderr.trim().length > 0 ? `stderr:\n${stderr.trim()}` : null,
      ]
        .filter((part) => part !== null)
        .join("\n\n"),
    );
  }

  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
};

const computeSha256 = (contents: Uint8Array): string =>
  createHash("sha256").update(contents).digest("hex");

const createChecksumsFile = async (
  releaseDir: string,
  assetPaths: ReadonlyArray<string>,
): Promise<string> => {
  const entries = await Promise.all(
    [...assetPaths]
      .sort((left, right) => left.localeCompare(right))
      .map(async (assetPath) => {
        const contents = await readFile(assetPath);
        const relativePath = relative(releaseDir, assetPath).replaceAll("\\", "/");
        return `${computeSha256(contents)}  ${relativePath}`;
      }),
  );

  const checksumsPath = join(releaseDir, "checksums.txt");
  await writeFile(checksumsPath, `${entries.join("\n")}\n`);
  return checksumsPath;
};

const packDistributionPackage = async (releaseDir: string): Promise<string> => {
  const output = await runCommand({
    command: "npm",
    args: ["pack", "./apps/executor/dist/npm", "--pack-destination", releaseDir, "--json"],
    cwd: repoRoot,
  });
  const [result] = JSON.parse(output.stdout) as ReadonlyArray<PackResult>;
  const filename = result?.filename;

  if (!filename) {
    throw new Error(`npm pack did not report an output filename. stdout:\n${output.stdout}`);
  }

  return join(releaseDir, filename);
};

const main = async () => {
  const releaseDir = defaultReleaseDir;
  const portableDir = join(releaseDir, "portable");

  await rm(releaseDir, { recursive: true, force: true });
  await mkdir(releaseDir, { recursive: true });

  await buildDistributionPackage();
  const packageArchivePath = await packDistributionPackage(releaseDir);
  const portableArtifact = await buildPortableDistribution({
    outputDir: portableDir,
    buildWeb: false,
    targets: portableTargetIds,
  });
  const portableArchivePaths = portableArtifact.artifacts
    .map((artifact) => artifact.archivePath)
    .filter((archivePath): archivePath is string => archivePath !== null);
  const checksumsPath = await createChecksumsFile(releaseDir, [
    packageArchivePath,
    ...portableArchivePaths,
  ]);

  for (const assetPath of [packageArchivePath, ...portableArchivePaths, checksumsPath]) {
    process.stdout.write(`${assetPath}\n`);
  }
};

await main();

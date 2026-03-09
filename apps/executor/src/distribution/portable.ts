import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { buildDistributionPackage } from "./artifact";
import { readDistributionPackageMetadata, repoRoot } from "./metadata";

const defaultOutputDir = resolve(repoRoot, "apps/executor/dist/portable");
const defaultNodeCacheDir = resolve(repoRoot, "apps/executor/.cache/portable-node");
const DEFAULT_OFFICIAL_NODE_VERSION = "v24.14.0";

type PortableTarget = {
  id: string;
  archiveExtension: "tar.gz" | "zip";
  archiveFileName: (nodeVersion: string) => string;
  extractedExecutablePath: (nodeVersion: string) => string;
  bundledExecutableName: string;
};

const portableTargets: Record<string, PortableTarget> = {
  "linux-x64": {
    id: "linux-x64",
    archiveExtension: "tar.gz",
    archiveFileName: (nodeVersion: string) => `node-${nodeVersion}-linux-x64.tar.gz`,
    extractedExecutablePath: (nodeVersion: string) => join(`node-${nodeVersion}-linux-x64`, "bin", "node"),
    bundledExecutableName: "node",
  },
  "linux-arm64": {
    id: "linux-arm64",
    archiveExtension: "tar.gz",
    archiveFileName: (nodeVersion: string) => `node-${nodeVersion}-linux-arm64.tar.gz`,
    extractedExecutablePath: (nodeVersion: string) => join(`node-${nodeVersion}-linux-arm64`, "bin", "node"),
    bundledExecutableName: "node",
  },
  "darwin-x64": {
    id: "darwin-x64",
    archiveExtension: "tar.gz",
    archiveFileName: (nodeVersion: string) => `node-${nodeVersion}-darwin-x64.tar.gz`,
    extractedExecutablePath: (nodeVersion: string) => join(`node-${nodeVersion}-darwin-x64`, "bin", "node"),
    bundledExecutableName: "node",
  },
  "darwin-arm64": {
    id: "darwin-arm64",
    archiveExtension: "tar.gz",
    archiveFileName: (nodeVersion: string) => `node-${nodeVersion}-darwin-arm64.tar.gz`,
    extractedExecutablePath: (nodeVersion: string) => join(`node-${nodeVersion}-darwin-arm64`, "bin", "node"),
    bundledExecutableName: "node",
  },
  "win-x64": {
    id: "win-x64",
    archiveExtension: "zip",
    archiveFileName: (nodeVersion: string) => `node-${nodeVersion}-win-x64.zip`,
    extractedExecutablePath: (nodeVersion: string) => join(`node-${nodeVersion}-win-x64`, "node.exe"),
    bundledExecutableName: "node.exe",
  },
  "win-arm64": {
    id: "win-arm64",
    archiveExtension: "zip",
    archiveFileName: (nodeVersion: string) => `node-${nodeVersion}-win-arm64.zip`,
    extractedExecutablePath: (nodeVersion: string) => join(`node-${nodeVersion}-win-arm64`, "node.exe"),
    bundledExecutableName: "node.exe",
  },
};

export const portableTargetIds = Object.freeze(Object.keys(portableTargets));

export type BuildPortableDistributionOptions = {
  outputDir?: string;
  packageName?: string;
  packageVersion?: string;
  buildWeb?: boolean;
  targets?: ReadonlyArray<string>;
  nodeVersion?: string;
  createArchives?: boolean;
};

export type PortableBundleArtifact = {
  target: string;
  bundleDir: string;
  launcherPath: string;
  installScriptPath: string;
  archivePath: string | null;
  nodeVersion: string;
};

export type PortableDistributionArtifact = {
  outputDir: string;
  artifacts: ReadonlyArray<PortableBundleArtifact>;
};


type NodeShasums = Map<string, string>;

type CommandInput = {
  command: string;
  args: ReadonlyArray<string>;
  cwd: string;
};

type CommandOutput = {
  stdout: string;
  stderr: string;
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

const normalizeNodeVersion = (value: string): string =>
  value.startsWith("v") ? value : `v${value}`;

const computeSha256 = (contents: Uint8Array): string =>
  createHash("sha256").update(contents).digest("hex");

const parseNodeShasums = (contents: string): NodeShasums =>
  new Map(
    contents
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        const match = /^(?<sha>[a-f0-9]{64})\s+(?<filename>.+)$/iu.exec(line);
        if (!match?.groups) {
          return [];
        }

        return [[match.groups.filename, match.groups.sha.toLowerCase()] as const];
      }),
  );

const getHostTargetId = (): string => {
  if (process.platform === "linux" && process.arch === "x64") {
    return "linux-x64";
  }

  if (process.platform === "linux" && process.arch === "arm64") {
    return "linux-arm64";
  }

  if (process.platform === "darwin" && process.arch === "x64") {
    return "darwin-x64";
  }

  if (process.platform === "darwin" && process.arch === "arm64") {
    return "darwin-arm64";
  }

  if (process.platform === "win32" && process.arch === "x64") {
    return "win-x64";
  }

  if (process.platform === "win32" && process.arch === "arm64") {
    return "win-arm64";
  }

  throw new Error(`Unsupported host platform for portable bundle: ${process.platform}-${process.arch}`);
};

export const resolveDefaultPortableTarget = (): string => getHostTargetId();

const resolveTargets = (requested: ReadonlyArray<string> | undefined): ReadonlyArray<PortableTarget> => {
  const targetIds = requested && requested.length > 0 ? requested : [getHostTargetId()];

  return targetIds.map((targetId) => {
    const target = portableTargets[targetId];
    if (!target) {
      throw new Error(`Unsupported portable target: ${targetId}`);
    }
    return target;
  });
};


const resolveNodeVersion = async (requestedVersion: string | undefined): Promise<string> => {
  if (!requestedVersion) {
    return DEFAULT_OFFICIAL_NODE_VERSION;
  }

  return normalizeNodeVersion(requestedVersion);
};


const ensureOfficialNodeRuntime = async (input: {
  target: PortableTarget;
  nodeVersion: string;
  cacheDir: string;
  destinationPath: string;
}): Promise<void> => {
  const archiveName = input.target.archiveFileName(input.nodeVersion);
  const archivePath = join(input.cacheDir, archiveName);
  const shasumsPath = join(input.cacheDir, "SHASUMS256.txt");
  const url = `https://nodejs.org/dist/${input.nodeVersion}/${archiveName}`;
  const shasumsUrl = `https://nodejs.org/dist/${input.nodeVersion}/SHASUMS256.txt`;

  await mkdir(input.cacheDir, { recursive: true });

  let shasumsContents = existsSync(shasumsPath)
    ? await readFile(shasumsPath, "utf8")
    : null;

  if (shasumsContents === null) {
    const response = await fetch(shasumsUrl);
    if (!response.ok) {
      throw new Error(`Unable to download ${shasumsUrl}: ${response.status} ${response.statusText}`);
    }

    shasumsContents = await response.text();
    await writeFile(shasumsPath, shasumsContents);
  }

  const shasums = parseNodeShasums(shasumsContents);
  const expectedChecksum = shasums.get(archiveName);
  if (!expectedChecksum) {
    throw new Error(`Missing checksum for ${archiveName} in ${shasumsUrl}`);
  }

  const ensureArchiveMatchesChecksum = async (): Promise<void> => {
    if (!existsSync(archivePath)) {
      return;
    }

    const existingArchive = await readFile(archivePath);
    if (computeSha256(existingArchive) === expectedChecksum) {
      return;
    }

    await rm(archivePath, { force: true });
  };

  await ensureArchiveMatchesChecksum();

  if (!existsSync(archivePath)) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Unable to download ${url}: ${response.status} ${response.statusText}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    const actualChecksum = computeSha256(bytes);
    if (actualChecksum !== expectedChecksum) {
      throw new Error(
        `Checksum mismatch for ${archiveName}: expected ${expectedChecksum}, received ${actualChecksum}`,
      );
    }

    await writeFile(archivePath, bytes);
  }

  const extractDir = await mkdtemp(join(tmpdir(), "executor-portable-node-"));
  try {
    if (input.target.archiveExtension === "tar.gz") {
      await runCommand({
        command: "tar",
        args: ["-xzf", archivePath, "-C", extractDir],
        cwd: repoRoot,
      });
    } else {
      await runCommand({
        command: "unzip",
        args: ["-q", archivePath, "-d", extractDir],
        cwd: repoRoot,
      });
    }

    const extractedExecutable = join(
      extractDir,
      input.target.extractedExecutablePath(input.nodeVersion),
    );

    if (!existsSync(extractedExecutable)) {
      throw new Error(`Missing extracted Node.js executable at ${extractedExecutable}`);
    }

    await copyFile(extractedExecutable, input.destinationPath);
  } finally {
    await rm(extractDir, { recursive: true, force: true });
  }
};

const createUnixLauncher = (): string => [
  "#!/bin/sh",
  "set -eu",
  'SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
  'exec "$SCRIPT_DIR/runtime/node" "$SCRIPT_DIR/bin/executor.mjs" "$@"',
  "",
].join("\n");

const createWindowsLauncher = (): string => [
  "@echo off",
  'set "SCRIPT_DIR=%~dp0"',
  '"%SCRIPT_DIR%runtime\\node.exe" "%SCRIPT_DIR%bin\\executor.mjs" %*',
  "",
].join("\r\n");

const createInstallScript = (input: {
  packageName: string;
  packageVersion: string;
  target: string;
}) => [
  "#!/bin/sh",
  "set -eu",
  'SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
  'DEFAULT_INSTALL_HOME=${EXECUTOR_INSTALL_HOME:-}',
  'if [ -z "$DEFAULT_INSTALL_HOME" ]; then',
  '  if [ "$(uname -s)" = "Darwin" ]; then',
  '    DEFAULT_INSTALL_HOME="$HOME/Library/Application Support/Executor"',
  '  else',
  '    DEFAULT_INSTALL_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/executor"',
  '  fi',
  'fi',
  'DEFAULT_BIN_DIR=${EXECUTOR_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}',
  `PACKAGE_NAME=${JSON.stringify(input.packageName)}`,
  `PACKAGE_VERSION=${JSON.stringify(input.packageVersion)}`,
  `TARGET_ID=${JSON.stringify(input.target)}`,
  'INSTALL_DIR="$DEFAULT_INSTALL_HOME/portable/$PACKAGE_VERSION/$TARGET_ID"',
  'INSTALL_PARENT=$(dirname "$INSTALL_DIR")',
  'STAGING_DIR="$INSTALL_PARENT/.install-$PACKAGE_VERSION-$TARGET_ID-$$"',
  'PREVIOUS_DIR="$INSTALL_PARENT/.previous-$PACKAGE_VERSION-$TARGET_ID-$$"',
  'BIN_DIR="$DEFAULT_BIN_DIR"',
  "",
  'while [ "$#" -gt 0 ]; do',
  '  case "$1" in',
  '    --install-dir)',
  '      INSTALL_DIR="$2"',
  '      INSTALL_PARENT=$(dirname "$INSTALL_DIR")',
  '      STAGING_DIR="$INSTALL_PARENT/.install-$PACKAGE_VERSION-$TARGET_ID-$$"',
  '      PREVIOUS_DIR="$INSTALL_PARENT/.previous-$PACKAGE_VERSION-$TARGET_ID-$$"',
  '      shift 2',
  '      ;;',
  '    --bin-dir)',
  '      BIN_DIR="$2"',
  '      shift 2',
  '      ;;',
  '    *)',
  '      printf "Unknown argument: %s\\n" "$1" >&2',
  '      exit 1',
  '      ;;',
  '  esac',
  'done',
  "",
  'rm -rf "$STAGING_DIR" "$PREVIOUS_DIR"',
  'mkdir -p "$INSTALL_PARENT" "$STAGING_DIR" "$BIN_DIR"',
  'cp -R "$SCRIPT_DIR/bin" "$STAGING_DIR/bin"',
  'cp -R "$SCRIPT_DIR/runtime" "$STAGING_DIR/runtime"',
  'cp -R "$SCRIPT_DIR/resources" "$STAGING_DIR/resources"',
  'cp "$SCRIPT_DIR/package.json" "$STAGING_DIR/package.json"',
  'cp "$SCRIPT_DIR/executor" "$STAGING_DIR/executor"',
  'cp "$SCRIPT_DIR/executor.cmd" "$STAGING_DIR/executor.cmd"',
  'cp "$SCRIPT_DIR/install.sh" "$STAGING_DIR/install.sh"',
  'cp "$SCRIPT_DIR/install.ps1" "$STAGING_DIR/install.ps1"',
  'chmod 755 "$STAGING_DIR/executor" "$STAGING_DIR/runtime/node"',
  'if [ -e "$INSTALL_DIR" ]; then mv "$INSTALL_DIR" "$PREVIOUS_DIR"; fi',
  'mv "$STAGING_DIR" "$INSTALL_DIR"',
  'rm -rf "$PREVIOUS_DIR"',
  'WRAPPER_PATH="$BIN_DIR/executor"',
  'WRAPPER_TEMP="$WRAPPER_PATH.tmp.$$"',
  'cat > "$WRAPPER_TEMP" <<EOF',
  '#!/bin/sh',
  'exec "$INSTALL_DIR/executor" "\\$@"',
  'EOF',
  'chmod 755 "$WRAPPER_TEMP"',
  'mv "$WRAPPER_TEMP" "$WRAPPER_PATH"',
  'printf "Installed %s %s to %s\\n" "$PACKAGE_NAME" "$PACKAGE_VERSION" "$INSTALL_DIR"',
  'printf "Launcher: %s\\n" "$BIN_DIR/executor"',
  'case ":${PATH}:" in',
  '  *":${BIN_DIR}:"*) ;;',
  '  *) printf "Add %s to PATH to run `executor` directly.\\n" "$BIN_DIR" ;;',
  'esac',
  "",
].join("\n");

const createInstallPowerShellScript = (input: {
  packageName: string;
  packageVersion: string;
  target: string;
}) => [
  'param(',
  '  [string]$InstallHome = $(if ($env:EXECUTOR_INSTALL_HOME) { $env:EXECUTOR_INSTALL_HOME } elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "Executor" } else { Join-Path $env:USERPROFILE "AppData\\Local\\Executor" }),',
  '  [string]$BinDir = $(if ($env:EXECUTOR_BIN_DIR) { $env:EXECUTOR_BIN_DIR } else { Join-Path $env:USERPROFILE ".local\\bin" })',
  ')',
  '$ErrorActionPreference = "Stop"',
  '$InstallDir = Join-Path $InstallHome "portable\\' + input.packageVersion + '\\' + input.target + '"',
  '$InstallParent = Split-Path -Parent $InstallDir',
  '$StageDir = Join-Path $InstallParent (".install-' + input.packageVersion + '-' + input.target + '-" + [Guid]::NewGuid().ToString("N"))',
  '$PreviousDir = Join-Path $InstallParent (".previous-' + input.packageVersion + '-' + input.target + '-" + [Guid]::NewGuid().ToString("N"))',
  '$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path',
  'New-Item -ItemType Directory -Force -Path $InstallParent | Out-Null',
  'if (Test-Path $StageDir) { Remove-Item -Path $StageDir -Recurse -Force }',
  'if (Test-Path $PreviousDir) { Remove-Item -Path $PreviousDir -Recurse -Force }',
  'New-Item -ItemType Directory -Force -Path $StageDir | Out-Null',
  'New-Item -ItemType Directory -Force -Path $BinDir | Out-Null',
  'Copy-Item -Path (Join-Path $ScriptDir "bin") -Destination (Join-Path $StageDir "bin") -Recurse -Force',
  'Copy-Item -Path (Join-Path $ScriptDir "runtime") -Destination (Join-Path $StageDir "runtime") -Recurse -Force',
  'Copy-Item -Path (Join-Path $ScriptDir "resources") -Destination (Join-Path $StageDir "resources") -Recurse -Force',
  'Copy-Item -Path (Join-Path $ScriptDir "package.json") -Destination (Join-Path $StageDir "package.json") -Force',
  'Copy-Item -Path (Join-Path $ScriptDir "executor") -Destination (Join-Path $StageDir "executor") -Force',
  'Copy-Item -Path (Join-Path $ScriptDir "executor.cmd") -Destination (Join-Path $StageDir "executor.cmd") -Force',
  'Copy-Item -Path (Join-Path $ScriptDir "install.sh") -Destination (Join-Path $StageDir "install.sh") -Force',
  'Copy-Item -Path (Join-Path $ScriptDir "install.ps1") -Destination (Join-Path $StageDir "install.ps1") -Force',
  'if (Test-Path $InstallDir) { Move-Item -Path $InstallDir -Destination $PreviousDir -Force }',
  'Move-Item -Path $StageDir -Destination $InstallDir -Force',
  'if (Test-Path $PreviousDir) { Remove-Item -Path $PreviousDir -Recurse -Force }',
  '$WrapperPath = Join-Path $BinDir "executor.cmd"',
  '$WrapperTemp = "$WrapperPath.tmp"',
  'Set-Content -Path $WrapperTemp -Value ("@echo off`r`n\"" + (Join-Path $InstallDir "executor.cmd") + "\" %*`r`n") -NoNewline',
  'Move-Item -Path $WrapperTemp -Destination $WrapperPath -Force',
  'Write-Host "Installed ' + input.packageName + ' ' + input.packageVersion + ' to $InstallDir"',
  'Write-Host "Launcher: $WrapperPath"',
].join("\r\n");

const createArchive = async (input: {
  bundleDir: string;
  archivePath: string;
  target: PortableTarget;
  outputDir: string;
}): Promise<void> => {
  const bundleName = basename(input.bundleDir);

  if (input.target.archiveExtension === "tar.gz") {
    await runCommand({
      command: "tar",
      args: ["-czf", input.archivePath, "-C", input.outputDir, bundleName],
      cwd: repoRoot,
    });
    return;
  }

  await runCommand({
    command: "python3",
    args: [
      "-c",
      [
        "import os, sys, zipfile",
        "bundle_dir = os.path.abspath(sys.argv[1])",
        "archive_path = os.path.abspath(sys.argv[2])",
        "parent = os.path.dirname(bundle_dir)",
        "with zipfile.ZipFile(archive_path, 'w', zipfile.ZIP_DEFLATED) as archive:",
        "    for root, _, files in os.walk(bundle_dir):",
        "        for name in files:",
        "            path = os.path.join(root, name)",
        "            archive.write(path, os.path.relpath(path, parent))",
      ].join("\n"),
      input.bundleDir,
      input.archivePath,
    ],
    cwd: repoRoot,
  });
};

const ensureRuntimeExecutable = async (input: {
  target: PortableTarget;
  nodeVersion: string;
  cacheDir: string;
  destinationPath: string;
}): Promise<void> => {
  await ensureOfficialNodeRuntime(input);
};

export const buildPortableDistribution = async (
  options: BuildPortableDistributionOptions = {},
): Promise<PortableDistributionArtifact> => {
  const defaults = await readDistributionPackageMetadata();
  const packageName = options.packageName ?? defaults.name;
  const packageVersion = options.packageVersion ?? defaults.version;
  const outputDir = resolve(options.outputDir ?? defaultOutputDir);
  const targets = resolveTargets(options.targets);
  const nodeVersion = await resolveNodeVersion(options.nodeVersion);
  const createArchives = options.createArchives ?? true;
  const cacheDir = join(defaultNodeCacheDir, nodeVersion);
  const stageRoot = await mkdtemp(join(tmpdir(), "executor-portable-stage-"));

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  try {
    const stagedPackage = await buildDistributionPackage({
      outputDir: join(stageRoot, "package"),
      packageName,
      packageVersion,
      buildWeb: options.buildWeb,
    });

    const artifacts: PortableBundleArtifact[] = [];

    for (const target of targets) {
      const bundleName = `${packageName}-${packageVersion}-${target.id}`;
      const bundleDir = join(outputDir, bundleName);
      const runtimeDir = join(bundleDir, "runtime");
      const runtimeExecutablePath = join(runtimeDir, target.bundledExecutableName);
      const launcherPath = join(bundleDir, "executor");
      const installScriptPath = join(bundleDir, "install.sh");
      const archivePath = createArchives
        ? join(outputDir, `${bundleName}.${target.archiveExtension}`)
        : null;

      await cp(stagedPackage.packageDir, bundleDir, { recursive: true });
      await mkdir(runtimeDir, { recursive: true });
      await ensureRuntimeExecutable({
        target,
        nodeVersion,
        cacheDir,
        destinationPath: runtimeExecutablePath,
      });
      await writeFile(launcherPath, createUnixLauncher());
      await writeFile(join(bundleDir, "executor.cmd"), createWindowsLauncher());
      await writeFile(
        installScriptPath,
        createInstallScript({
          packageName,
          packageVersion,
          target: target.id,
        }),
      );
      await writeFile(
        join(bundleDir, "install.ps1"),
        createInstallPowerShellScript({
          packageName,
          packageVersion,
          target: target.id,
        }),
      );
      await chmod(launcherPath, 0o755);
      await chmod(installScriptPath, 0o755);
      if (target.bundledExecutableName === "node") {
        await chmod(runtimeExecutablePath, 0o755);
      }

      if (archivePath !== null) {
        await createArchive({
          bundleDir,
          archivePath,
          target,
          outputDir,
        });
      }

      artifacts.push({
        target: target.id,
        bundleDir,
        launcherPath,
        installScriptPath,
        archivePath,
        nodeVersion,
      });
    }

    return {
      outputDir,
      artifacts,
    };
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
};

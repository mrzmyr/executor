import { buildDistributionPackage } from "./artifact";

type BuildPackageCliOptions = {
  outputDir?: string;
  packageName?: string;
  packageVersion?: string;
  buildWeb: boolean;
};

const parseArgs = (argv: ReadonlyArray<string>): BuildPackageCliOptions => {
  const options: BuildPackageCliOptions = {
    buildWeb: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--skip-web-build") {
      options.buildWeb = false;
      continue;
    }

    const next = argv[index + 1];
    if (!next) {
      throw new Error(`Missing value for ${arg}`);
    }

    if (arg === "--output") {
      options.outputDir = next;
      index += 1;
      continue;
    }

    if (arg === "--package-name") {
      options.packageName = next;
      index += 1;
      continue;
    }

    if (arg === "--package-version") {
      options.packageVersion = next;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const artifact = await buildDistributionPackage(options);
  process.stdout.write(`${artifact.packageDir}\n`);
};

await main();

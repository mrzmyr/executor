import {
  buildPortableDistribution,
  type BuildPortableDistributionOptions,
} from "./portable";

type BuildPortableCliOptions = BuildPortableDistributionOptions;

const parseArgs = (argv: ReadonlyArray<string>): BuildPortableCliOptions => {
  const options: BuildPortableCliOptions = {
    buildWeb: true,
    createArchives: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--skip-web-build") {
      options.buildWeb = false;
      continue;
    }

    if (arg === "--no-archive") {
      options.createArchives = false;
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

    if (arg === "--target") {
      options.targets = [...(options.targets ?? []), next];
      index += 1;
      continue;
    }


    if (arg === "--node-version") {
      options.nodeVersion = next;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const artifact = await buildPortableDistribution(options);

  for (const bundle of artifact.artifacts) {
    process.stdout.write(`${bundle.archivePath ?? bundle.bundleDir}\n`);
  }
};

await main();

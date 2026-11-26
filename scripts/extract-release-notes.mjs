import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const INSTALLER_NOTE = "Download and run the `*-setup.exe` installer below.";
const SEMVER_RE = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/i;

/**
 * Normalize a version or tag string by trimming whitespace and stripping a leading "v".
 */
export function normalizeVersion(version) {
  return String(version ?? "").trim().replace(/^v/i, "");
}

/**
 * Extract the markdown body for a specific release version from a Keep-a-Changelog file.
 * Supports headers like:
 *   ## [v2.2.0] - 2026-11-25
 *   ## [2.2.0] - 2026-11-25
 *   ## v2.2.0
 *   ## 2.2.0
 */
export function extractChangelogSection(markdown, version) {
  const target = normalizeVersion(version);
  if (!target) return null;

  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const headerRe = /^##\s+(?:\[\s*v?([^\]\s]+)\s*\]|v?([^\s]+))(?:\s|$)/;

  let startIndex = -1;
  let endIndex = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(headerRe);
    if (!match) continue;

    if (startIndex === -1) {
      const headerVersion = normalizeVersion(match[1] ?? match[2] ?? "");
      if (headerVersion.toLowerCase() === target.toLowerCase()) {
        startIndex = i + 1;
      }
    } else {
      endIndex = i;
      break;
    }
  }

  if (startIndex === -1) return null;

  const body = lines.slice(startIndex, endIndex).join("\n").trim();
  return body.length > 0 ? body : null;
}

/**
 * Build the final GitHub Release / updater body from CHANGELOG.md with a clean fallback.
 */
export function buildReleaseBody({ changelog, version, includeInstallerNote = false }) {
  const normalized = normalizeVersion(version) || "0.0.0";
  const section = extractChangelogSection(changelog, normalized);

  if (section) {
    if (!includeInstallerNote) {
      return section;
    }
    if (section.includes(INSTALLER_NOTE)) {
      return section;
    }
    return `${section}\n\n${INSTALLER_NOTE}`;
  }

  return `Windows installer for **screen-share v${normalized}**.\n\n${INSTALLER_NOTE}`;
}

/**
 * Append a multiline key/value pair to a GitHub Actions GITHUB_OUTPUT file using
 * a random heredoc delimiter (UTF-8, cross-platform, injection-safe).
 */
export function appendGithubOutput(filePath, key, value) {
  if (!filePath) {
    throw new Error("GITHUB_OUTPUT file path is required");
  }
  const safeKey = String(key ?? "").trim();
  if (!safeKey || /[\r\n=]/.test(safeKey)) {
    throw new Error(`Invalid GitHub output key: ${key}`);
  }

  const normalizedValue = String(value ?? "").replace(/\r\n?/g, "\n");
  let delimiter = `EOF_${crypto.randomBytes(12).toString("hex")}`;
  while (normalizedValue.includes(delimiter)) {
    delimiter = `EOF_${crypto.randomBytes(12).toString("hex")}`;
  }

  const payload = `${safeKey}<<${delimiter}\n${normalizedValue}\n${delimiter}\n`;
  fs.appendFileSync(filePath, payload, "utf8");
  return delimiter;
}

function readPackageVersion(repoRoot) {
  const pkgPath = path.join(repoRoot, "app", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const version = normalizeVersion(pkg.version ?? "");
  if (!version) {
    throw new Error(`Could not determine version from ${pkgPath}`);
  }
  return version;
}

function parseCliArgs(argv) {
  let tagOrVersion = "";
  let changelogPath = "";
  let includeInstallerNote = false;
  let useGithubOutput = false;
  let githubOutputKey = "release_notes";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--changelog") {
      if (i + 1 >= argv.length) {
        throw new Error("--changelog requires a file path");
      }
      changelogPath = argv[++i];
    } else if (arg === "--include-installer-note") {
      includeInstallerNote = true;
    } else if (arg === "--github-output") {
      useGithubOutput = true;
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        githubOutputKey = argv[++i];
      }
    } else if (!arg.startsWith("--") && !tagOrVersion) {
      tagOrVersion = arg;
    }
  }

  return {
    tagOrVersion,
    changelogPath,
    includeInstallerNote,
    useGithubOutput,
    githubOutputKey,
  };
}

function runCli() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "..");
  const options = parseCliArgs(process.argv.slice(2));

  const semverMatch = options.tagOrVersion.trim().match(SEMVER_RE);
  const version = semverMatch ? semverMatch[1] : readPackageVersion(repoRoot);

  const changelogFile = options.changelogPath
    ? path.resolve(options.changelogPath)
    : path.join(repoRoot, "CHANGELOG.md");

  let changelog = "";
  if (fs.existsSync(changelogFile)) {
    changelog = fs.readFileSync(changelogFile, "utf8");
  }

  const body = buildReleaseBody({
    changelog,
    version,
    includeInstallerNote: options.includeInstallerNote,
  });

  if (options.useGithubOutput) {
    const outputFile = process.env.GITHUB_OUTPUT;
    if (!outputFile) {
      throw new Error("--github-output was specified, but GITHUB_OUTPUT is not set");
    }
    appendGithubOutput(outputFile, options.githubOutputKey, body);
  }

  process.stdout.write(`${body}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli();
}

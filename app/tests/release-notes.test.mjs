import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildReleaseTagUrl,
  compareSemver,
  extractChangelogSection,
  extractFirstSummaryLine,
  normalizeVersion,
  parseInlineRuns,
  parseMarkdownBlocks,
  stripReleaseBoilerplate,
} from "../src/release-notes.ts";
import {
  appendGithubOutput,
  buildReleaseBody,
  extractChangelogSection as extractCliChangelogSection,
} from "../../scripts/extract-release-notes.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const changelogPath = path.join(repoRoot, "CHANGELOG.md");
const extractScriptPath = path.join(repoRoot, "scripts", "extract-release-notes.mjs");

describe("normalizeVersion & compareSemver", () => {
  it("normalizes leading v and whitespace", () => {
    assert.equal(normalizeVersion("v2.2.0"), "2.2.0");
    assert.equal(normalizeVersion("  V1.0.3  "), "1.0.3");
    assert.equal(normalizeVersion("0.1.0"), "0.1.0");
    assert.equal(normalizeVersion(""), "");
  });

  it("compares semver strings accurately", () => {
    assert.equal(compareSemver("2.2.0", "2.1.0"), 1);
    assert.equal(compareSemver("v2.2.0", "2.2.0"), 0);
    assert.equal(compareSemver("2.0.1", "2.1.0"), -1);
    assert.equal(compareSemver("2.2.0-beta.1", "2.2.0"), 0);
    assert.equal(compareSemver("2.2", "2.2.0"), 0);
    assert.equal(compareSemver("invalid", "2.2.0"), null);
    assert.equal(compareSemver("2.2.0", ""), null);
    assert.equal(compareSemver("2..0", "2.0.0"), null);
  });
});

describe("buildReleaseTagUrl", () => {
  it("builds a tag URL for valid semver versions", () => {
    assert.equal(
      buildReleaseTagUrl("2.2.0"),
      "https://github.com/Jonsen22/screen-share/releases/tag/v2.2.0"
    );
    assert.equal(
      buildReleaseTagUrl("v2.2.0"),
      "https://github.com/Jonsen22/screen-share/releases/tag/v2.2.0"
    );
    assert.equal(
      buildReleaseTagUrl("v2.3.0-rc.1"),
      "https://github.com/Jonsen22/screen-share/releases/tag/v2.3.0-rc.1"
    );
  });

  it("falls back to /releases/latest for invalid or path-traversal inputs", () => {
    const latest = "https://github.com/Jonsen22/screen-share/releases/latest";
    assert.equal(buildReleaseTagUrl(""), latest);
    assert.equal(buildReleaseTagUrl("main"), latest);
    assert.equal(buildReleaseTagUrl("../evil"), latest);
    assert.equal(buildReleaseTagUrl("2.2.0/../../issues"), latest);
    assert.equal(buildReleaseTagUrl("2.2.0?foo=bar"), latest);
    assert.equal(buildReleaseTagUrl("2.2.0#frag"), latest);
    assert.equal(buildReleaseTagUrl("javascript:alert(1)"), latest);
    assert.equal(buildReleaseTagUrl("2.2.0-foo..bar"), latest);
    assert.equal(buildReleaseTagUrl("2.2.0-.."), latest);
    assert.equal(buildReleaseTagUrl(`2.2.0-${"a".repeat(60)}`), latest);
  });
});

describe("extractChangelogSection", () => {
  const sampleChangelog = [
    "# Changelog",
    "",
    "## [v2.2.01] - 2026-12-01",
    "- Should not match 2.2.0",
    "",
    "## [v2.2.0-beta.1] - 2026-11-26",
    "- Beta should not match 2.2.0",
    "",
    "## [v2.2.0] - 2026-11-25",
    "",
    "### Added",
    "- Mini Player support",
    "",
    "## [2.1.0] - 2026-11-25",
    "- In-app updater",
    "",
    "## v2.0.0",
    "- Multi-streamer rooms",
    "",
    "## 0.1.0",
    "- Initial release at EOF",
  ].join("\r\n");

  it("matches v2.2.0 and 2.2.0 without matching partial prefixes", () => {
    const withV = extractChangelogSection(sampleChangelog, "v2.2.0");
    const withoutV = extractChangelogSection(sampleChangelog, "2.2.0");
    assert.equal(withV, "### Added\n- Mini Player support");
    assert.equal(withoutV, withV);
  });

  it("handles bracketed, unbracketed, CRLF, and EOF sections", () => {
    assert.equal(extractChangelogSection(sampleChangelog, "2.1.0"), "- In-app updater");
    assert.equal(extractChangelogSection(sampleChangelog, "v2.0.0"), "- Multi-streamer rooms");
    assert.equal(extractChangelogSection(sampleChangelog, "0.1.0"), "- Initial release at EOF");
  });

  it("returns null for missing or empty versions", () => {
    assert.equal(extractChangelogSection(sampleChangelog, "9.9.9"), null);
    assert.equal(extractChangelogSection(sampleChangelog, ""), null);
  });
});

describe("stripReleaseBoilerplate & extractFirstSummaryLine", () => {
  it("strips installer boilerplate lines cleanly", () => {
    const raw = [
      "### Added",
      "- **Mini Player:** Pop out streams (`P`).",
      "",
      "Download and run the `*-setup.exe` installer below.",
    ].join("\n");

    assert.equal(
      stripReleaseBoilerplate(raw),
      "### Added\n- **Mini Player:** Pop out streams (`P`)."
    );

    const fallbackOnly =
      "Windows installer for **screen-share v2.2.0**.\n\nDownload and run the `*-setup.exe` installer below.";
    assert.equal(stripReleaseBoilerplate(fallbackOnly), "");
  });

  it("extracts the first meaningful plain-text line skipping headings", () => {
    const md = [
      "### Added",
      "- **Mini Player:** Pop out with `P`.",
      "- Second bullet",
    ].join("\n");

    assert.equal(extractFirstSummaryLine(md), "Mini Player: Pop out with P.");
    assert.equal(extractFirstSummaryLine("### Added\n\n### Fixed"), "");
  });
});

describe("parseInlineRuns & parseMarkdownBlocks", () => {
  it("parses bold, inline code, and preserves unmatched markers as literal text", () => {
    assert.deepEqual(parseInlineRuns("Press `P` for **Mini Player** mode"), [
      { kind: "text", text: "Press " },
      { kind: "code", text: "P" },
      { kind: "text", text: " for " },
      { kind: "bold", text: "Mini Player" },
      { kind: "text", text: " mode" },
    ]);

    assert.deepEqual(parseInlineRuns("Unclosed **bold and `code"), [
      { kind: "text", text: "Unclosed **bold and `code" },
    ]);
  });

  it("parses headings, lists, paragraphs, and keeps raw HTML as literal text", () => {
    const md = [
      "### Added",
      "- **Feature** with `<script>alert(1)</script>`",
      "- Plain <img src=x onerror=alert(1)> bullet",
      "",
      "Paragraph line one",
      "line two with **bold**.",
    ].join("\n");

    const blocks = parseMarkdownBlocks(md);
    assert.equal(blocks.length, 3);
    assert.deepEqual(blocks[0], { kind: "heading", level: 3, text: "Added" });
    assert.equal(blocks[1].kind, "list");
    assert.deepEqual(blocks[1].items[0], [
      { kind: "bold", text: "Feature" },
      { kind: "text", text: " with " },
      { kind: "code", text: "<script>alert(1)</script>" },
    ]);
    assert.deepEqual(blocks[1].items[1], [
      { kind: "text", text: "Plain <img src=x onerror=alert(1)> bullet" },
    ]);
    assert.equal(blocks[2].kind, "paragraph");
    assert.deepEqual(blocks[2].runs, [
      { kind: "text", text: "Paragraph line one line two with " },
      { kind: "bold", text: "bold" },
      { kind: "text", text: "." },
    ]);
  });
});

describe("root CHANGELOG.md & extract-release-notes.mjs CLI", () => {
  it("contains valid non-empty sections for all 7 tagged releases", () => {
    const changelog = fs.readFileSync(changelogPath, "utf8");
    const versions = ["v2.2.0", "v2.1.0", "v2.0.1", "v2.0.0", "v1.2.0", "v1.1.0", "v0.1.0"];
    for (const v of versions) {
      const appSection = extractChangelogSection(changelog, v);
      const cliSection = extractCliChangelogSection(changelog, v);
      assert.ok(appSection && appSection.length > 10, `Expected section for ${v}`);
      assert.equal(cliSection, appSection);
    }
  });

  it("buildReleaseBody appends installer note once and falls back cleanly for missing versions", () => {
    const changelog = fs.readFileSync(changelogPath, "utf8");
    const withNote = buildReleaseBody({
      changelog,
      version: "v2.2.0",
      includeInstallerNote: true,
    });
    assert.ok(withNote.includes("Always-on-Top Mini Player"));
    assert.equal(
      withNote.match(/Download and run the `\*?-setup\.exe` installer below\./g)?.length,
      1
    );

    const fallback = buildReleaseBody({
      changelog,
      version: "v9.9.9",
      includeInstallerNote: true,
    });
    assert.equal(
      fallback,
      "Windows installer for **screen-share v9.9.9**.\n\nDownload and run the `*-setup.exe` installer below."
    );
  });

  it("CLI extracts release notes to stdout, handles workflow_dispatch fallback, and writes GITHUB_OUTPUT", () => {
    const stdout = execFileSync(
      process.execPath,
      [extractScriptPath, "v2.2.0", "--include-installer-note"],
      { encoding: "utf8" }
    );
    assert.ok(stdout.includes("Always-on-Top Mini Player"));
    assert.ok(stdout.includes("Download and run the `*-setup.exe` installer below."));

    // workflow_dispatch passes branch name ("main") -> falls back to app/package.json version
    const dispatchOut = execFileSync(
      process.execPath,
      [extractScriptPath, "main"],
      { encoding: "utf8" }
    );
    assert.ok(dispatchOut.trim().length > 0);

    // Missing version fallback
    const missingOut = execFileSync(
      process.execPath,
      [extractScriptPath, "v9.9.9", "--include-installer-note"],
      { encoding: "utf8" }
    );
    assert.ok(missingOut.includes("Windows installer for **screen-share v9.9.9**."));

    // --github-output writes valid multiline heredoc delimiter format
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "screen-share-rn-"));
    const ghOutputFile = path.join(tmpDir, "github_output.txt");
    try {
      fs.writeFileSync(ghOutputFile, "", "utf8");
      execFileSync(
        process.execPath,
        [extractScriptPath, "v2.2.0", "--include-installer-note", "--github-output", "release_notes"],
        {
          encoding: "utf8",
          env: { ...process.env, GITHUB_OUTPUT: ghOutputFile },
        }
      );

      const content = fs.readFileSync(ghOutputFile, "utf8");
      const match = content.match(/^release_notes<<(EOF_[0-9a-f]{24})\n([\s\S]+)\n\1\n$/);
      assert.ok(match, `Unexpected GITHUB_OUTPUT format:\n${content}`);
      assert.ok(match[2].includes("Always-on-Top Mini Player"));

      // Direct helper sanity check
      const delim = appendGithubOutput(ghOutputFile, "extra_key", "line1\nline2");
      assert.match(delim, /^EOF_[0-9a-f]{24}$/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

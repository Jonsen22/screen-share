const RELEASES_BASE_URL = "https://github.com/Jonsen22/screen-share/releases";
const VALID_TAG_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CHANGELOG_HEADER_RE = /^##\s+(?:\[\s*v?([^\]\s]+)\s*\]|v?([^\s]+))(?:\s|$)/;

export interface InlineRun {
  kind: "text" | "bold" | "code";
  text: string;
}

export type MarkdownBlock =
  | { kind: "heading"; level: 2 | 3 | 4; text: string }
  | { kind: "list"; items: InlineRun[][] }
  | { kind: "paragraph"; runs: InlineRun[] };

/**
 * Strip leading/trailing whitespace and a leading "v"/"V" prefix.
 */
export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

function parseSemverTuple(version: string): [number, number, number] | null {
  const cleaned = normalizeVersion(version).split("+")[0].split("-")[0];
  if (!cleaned) return null;
  const parts = cleaned.split(".");
  if (parts.length < 2 || parts.length > 3) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isSafeInteger(n) || n < 0) return null;
    nums.push(n);
  }
  return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
}

/**
 * Compare two semver strings (ignoring leading "v" and prerelease suffixes).
 * Returns 1 if a > b, -1 if a < b, 0 if equal, or null if either is unparseable.
 */
export function compareSemver(a: string, b: string): number | null {
  const parsedA = parseSemverTuple(a);
  const parsedB = parseSemverTuple(b);
  if (!parsedA || !parsedB) return null;

  for (let i = 0; i < 3; i++) {
    if (parsedA[i] > parsedB[i]) return 1;
    if (parsedA[i] < parsedB[i]) return -1;
  }
  return 0;
}

/**
 * Build a safe GitHub release tag URL for a valid semver version,
 * falling back to /releases/latest for invalid or unsafe inputs.
 */
export function buildReleaseTagUrl(version: string): string {
  const normalized = normalizeVersion(version);
  if (normalized.length <= 64 && VALID_TAG_VERSION_RE.test(normalized)) {
    return `${RELEASES_BASE_URL}/tag/v${normalized}`;
  }
  return `${RELEASES_BASE_URL}/latest`;
}

/**
 * Extract the release notes section for a specific version from CHANGELOG.md.
 * Handles CRLF/LF, bracketed/unbracketed headers, EOF termination, and rejects
 * partial prefix matches (e.g. 2.2.0 will not match 2.2.01 or 2.2.0-beta.1).
 */
export function extractChangelogSection(markdown: string, version: string): string | null {
  const target = normalizeVersion(version);
  if (!target) return null;

  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let startIndex = -1;
  let endIndex = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(CHANGELOG_HEADER_RE);
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
 * Strip GitHub Release / installer boilerplate lines when rendering notes in-app.
 */
export function stripReleaseBoilerplate(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (/^Download and run the `?[^`\r\n]*-setup\.exe`? installer below\.?$/i.test(trimmed)) {
      return false;
    }
    if (/^Windows installer for (?:\*\*)?screen-share v[^\s*]+(?:\*\*)?\.?$/i.test(trimmed)) {
      return false;
    }
    return true;
  });

  return filtered
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract the first meaningful plain-text bullet or paragraph line for a
 * compact one-line preview in the update banner.
 */
export function extractFirstSummaryLine(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (/^#{1,6}\s+/.test(trimmed)) continue;

    const withoutBullet = trimmed.replace(/^[-*+]\s+/, "");
    const plain = withoutBullet
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .trim();

    if (plain.length > 0) {
      return plain;
    }
  }
  return "";
}

function pushTextRun(runs: InlineRun[], text: string): void {
  if (!text) return;
  const last = runs[runs.length - 1];
  if (last && last.kind === "text") {
    last.text += text;
  } else {
    runs.push({ kind: "text", text });
  }
}

/**
 * Linear inline parser supporting **bold** and `code`.
 * Unmatched markers remain literal text.
 */
export function parseInlineRuns(text: string): InlineRun[] {
  const runs: InlineRun[] = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] === "`") {
      const close = text.indexOf("`", i + 1);
      if (close > i + 1) {
        runs.push({ kind: "code", text: text.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
      pushTextRun(runs, "`");
      i += 1;
      continue;
    }

    if (text[i] === "*" && text[i + 1] === "*") {
      const close = text.indexOf("**", i + 2);
      if (close > i + 2) {
        runs.push({ kind: "bold", text: text.slice(i + 2, close) });
        i = close + 2;
        continue;
      }
      pushTextRun(runs, "**");
      i += 2;
      continue;
    }

    let next = i + 1;
    while (next < text.length && text[next] !== "`" && !(text[next] === "*" && text[next + 1] === "*")) {
      next += 1;
    }
    pushTextRun(runs, text.slice(i, next));
    i = next;
  }

  return runs;
}

/**
 * Parse simple release-notes markdown into typed heading, list, and paragraph blocks.
 * Raw HTML is never interpreted and remains literal text.
 */
export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];

  let listItems: InlineRun[][] | null = null;
  let paragraphLines: string[] = [];

  const flushList = (): void => {
    if (listItems && listItems.length > 0) {
      blocks.push({ kind: "list", items: listItems });
    }
    listItems = null;
  };

  const flushParagraph = (): void => {
    if (paragraphLines.length > 0) {
      const joined = paragraphLines.join(" ").trim();
      if (joined) {
        blocks.push({ kind: "paragraph", runs: parseInlineRuns(joined) });
      }
    }
    paragraphLines = [];
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      flushList();
      flushParagraph();
      continue;
    }

    const headingMatch = trimmed.match(/^(#{2,4})\s+(.+)$/);
    if (headingMatch) {
      flushList();
      flushParagraph();
      const level = headingMatch[1].length as 2 | 3 | 4;
      blocks.push({ kind: "heading", level, text: headingMatch[2].trim() });
      continue;
    }

    const listMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (listMatch) {
      flushParagraph();
      if (!listItems) listItems = [];
      listItems.push(parseInlineRuns(listMatch[1].trim()));
      continue;
    }

    flushList();
    paragraphLines.push(trimmed);
  }

  flushList();
  flushParagraph();
  return blocks;
}

function appendInlineRuns(doc: Document, parent: HTMLElement, runs: InlineRun[]): void {
  for (const run of runs) {
    if (run.kind === "bold") {
      const strong = doc.createElement("strong");
      strong.appendChild(doc.createTextNode(run.text));
      parent.appendChild(strong);
    } else if (run.kind === "code") {
      const code = doc.createElement("code");
      code.appendChild(doc.createTextNode(run.text));
      parent.appendChild(code);
    } else {
      parent.appendChild(doc.createTextNode(run.text));
    }
  }
}

/**
 * Safely render markdown release notes into a container using only DOM node APIs
 * (createElement / createTextNode / replaceChildren — zero innerHTML).
 */
export function renderReleaseNotes(container: HTMLElement, markdown: string): void {
  const doc = container.ownerDocument;
  const blocks = parseMarkdownBlocks(markdown);

  if (blocks.length === 0) {
    const fallback = doc.createElement("p");
    fallback.className = "muted small";
    fallback.appendChild(
      doc.createTextNode("No detailed release notes are available for this version yet.")
    );
    container.replaceChildren(fallback);
    return;
  }

  const fragment = doc.createDocumentFragment();

  for (const block of blocks) {
    if (block.kind === "heading") {
      const tag = block.level === 2 ? "h3" : "h4";
      const heading = doc.createElement(tag);
      heading.className = "whats-new-heading";
      heading.appendChild(doc.createTextNode(block.text));
      fragment.appendChild(heading);
    } else if (block.kind === "list") {
      const ul = doc.createElement("ul");
      ul.className = "whats-new-list";
      for (const itemRuns of block.items) {
        const li = doc.createElement("li");
        appendInlineRuns(doc, li, itemRuns);
        ul.appendChild(li);
      }
      fragment.appendChild(ul);
    } else {
      const p = doc.createElement("p");
      p.className = "whats-new-paragraph";
      appendInlineRuns(doc, p, block.runs);
      fragment.appendChild(p);
    }
  }

  container.replaceChildren(fragment);
}

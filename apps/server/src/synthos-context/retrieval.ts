// @effect-diagnostics-next-line nodeBuiltinImport:off -- Content identity deduplicates local source material without storing another copy.
import * as NodeCrypto from "node:crypto";

export interface ContextRoute {
  readonly id: string;
  readonly keywords: readonly string[];
  readonly roles: readonly string[];
  readonly paths: readonly string[];
  readonly load: readonly string[];
  readonly skip: readonly string[];
}

export interface MemoryNote {
  readonly path: string;
  readonly content: string;
  readonly version: string;
  readonly tier: 1 | 2;
}

interface SelectedMemory extends MemoryNote {
  readonly excerpt: string;
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly reason: string;
}

export interface MemorySelection {
  readonly selected: readonly SelectedMemory[];
  readonly omitted: readonly { readonly path: string; readonly reason: string }[];
  readonly neighborhoodUsed: boolean;
  readonly bytes: number;
}

const stopWords = new Set(
  "a an and are as at be been before by can could do does for from has have how i in into is it its may me my of on or our should that the their them these this to use using was we what when where which will with would you your add build change check create fix implement inspect need new please project relevant task update agent agents architect pm crew lead search grep docs router advisor reviewer planning review".split(
    " ",
  ),
);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
const meaningfulWords = (text: string) =>
  [...words(text)].filter((word) => word.length > 1 && !stopWords.has(word));
const identifiers = (text: string) =>
  new Set(
    (text.match(/[\p{L}_][\p{L}\p{N}_./-]*[\p{L}\p{N}]/gu) ?? [])
      .filter((word) => /[_./-]|\d|[a-z][A-Z]/.test(word))
      .map((word) => word.toLowerCase()),
  );
const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= 64 &&
  value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 1024);

export function parseRouting(markdown: string): ContextRoute[] {
  const block = /```json\s*\n([\s\S]*?)\n```/.exec(markdown)?.[1];
  if (!block) throw new Error("routing_block_missing");
  const parsed: unknown = JSON.parse(block);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("routes" in parsed) ||
    !Array.isArray(parsed.routes) ||
    parsed.routes.length > 64
  )
    throw new Error("routing_invalid");
  const seen = new Set<string>();
  return parsed.routes.map((entry: unknown) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("id" in entry) ||
      typeof entry.id !== "string" ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(entry.id) ||
      seen.has(entry.id) ||
      !("keywords" in entry) ||
      !stringArray(entry.keywords) ||
      !("roles" in entry) ||
      !stringArray(entry.roles) ||
      !("paths" in entry) ||
      !stringArray(entry.paths) ||
      !("load" in entry) ||
      !stringArray(entry.load) ||
      !("skip" in entry) ||
      !stringArray(entry.skip)
    )
      throw new Error("routing_invalid");
    seen.add(entry.id);
    return {
      id: entry.id,
      keywords: entry.keywords,
      roles: entry.roles,
      paths: entry.paths,
      load: entry.load,
      skip: entry.skip,
    };
  });
}

export function selectRoutes(
  routes: readonly ContextRoute[],
  task: string,
  role: string,
): ContextRoute[] {
  const taskWords = words(task);
  return routes
    .filter(
      (route) =>
        (route.roles.length === 0 || route.roles.includes(role)) &&
        route.keywords.some((keyword) => {
          const parts = [...words(keyword)];
          return parts.length > 0 && parts.every((part) => taskWords.has(part));
        }),
    )
    .toSorted((a, b) => compare(a.id, b.id));
}

const roleTerms: Readonly<Record<string, readonly string[]>> = {
  architect: ["architecture", "boundary", "tradeoff"],
  pm: ["acceptance", "scope", "requirement"],
  crew: ["implementation", "interface", "contract"],
  lead: ["verification", "tests", "evidence"],
  search: ["repository", "layout", "ownership"],
  grep: ["symbol", "callsite", "references"],
  docs: ["api", "documentation", "reference"],
  router: ["dependency", "ownership", "boundary"],
  advisor: ["architecture", "constraint", "risk"],
  reviewer: ["constraint", "regression", "verification"],
};

function indexContent(content: string) {
  const title = /^#\s+(.+)$/m.exec(content)?.[1] ?? null;
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1] ?? "";
  const tagLine = /^tags:\s*(.*(?:\r?\n[ \t]+-[^\n]*)*)/m.exec(frontmatter)?.[1] ?? "";
  const tags = [...(content.match(/(?:^|\s)#[\p{L}\p{N}_/-]+/gu) ?? []), tagLine].join(" ");
  return {
    titleWords: title === null ? null : words(title),
    tagWords: words(tags),
    bodyWords: words(content),
    sourceIds: identifiers(content),
    bytes: Buffer.byteLength(content, "utf8"),
  };
}

// Derived token sets are bounded and keyed by content, so changed notes cannot reuse stale matches.
const lexicalIndex = new Map<string, ReturnType<typeof indexContent>>();
let indexedBytes = 0;
function indexedContent(content: string) {
  const hash = NodeCrypto.createHash("sha256").update(content).digest("hex");
  let index = lexicalIndex.get(hash);
  if (!index) {
    index = indexContent(content);
    lexicalIndex.set(hash, index);
    indexedBytes += index.bytes;
    while (lexicalIndex.size > 1000 || indexedBytes > 4 * 1024 * 1024) {
      const oldest = lexicalIndex.entries().next().value;
      if (!oldest) break;
      lexicalIndex.delete(oldest[0]);
      indexedBytes -= oldest[1].bytes;
    }
  }
  return { hash, index };
}

function rank(
  note: MemoryNote,
  terms: readonly string[],
  queryIds: ReadonlySet<string>,
  role: string,
) {
  const { hash, index } = indexedContent(note.content);
  const titleWords = index.titleWords ?? words(note.path);
  const { tagWords, bodyWords } = index;
  const matchedTerms = terms.filter(
    (term) => titleWords.has(term) || tagWords.has(term) || bodyWords.has(term),
  );
  const pathIds = identifiers(note.path);
  const exactIdentifier = [...queryIds].some((id) => index.sourceIds.has(id) || pathIds.has(id));
  const roleMatches = (roleTerms[role] ?? []).filter((term) => bodyWords.has(term));
  const score = matchedTerms.reduce(
    (sum, term) =>
      sum +
      (titleWords.has(term) ? 4 : 0) +
      (tagWords.has(term) ? 3 : 0) +
      (bodyWords.has(term) ? 1 : 0),
    0,
  );
  return {
    ...note,
    hash,
    score: score + Math.min(roleMatches.length, 2),
    matchedTerms,
    qualifies: matchedTerms.length >= 2 || exactIdentifier,
    exactIdentifier,
  };
}

function excerptFor(content: string, terms: readonly string[], budget: number): string {
  const paragraphs = content
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
    .trim()
    .split(/\r?\n\s*\r?\n/)
    .filter(Boolean);
  const ranked = paragraphs
    .map((text, index) => ({
      text,
      index,
      score: terms.filter((term) => words(text).has(term)).length,
    }))
    .toSorted((a, b) => b.score - a.score || a.index - b.index);
  const chosen: typeof ranked = [];
  const hasRelevantParagraph = ranked.some((paragraph) => paragraph.score > 0);
  let size = 0;
  for (const paragraph of ranked) {
    if (paragraph.score === 0 && (hasRelevantParagraph || chosen.length > 0)) continue;
    const bytes = Buffer.byteLength(paragraph.text, "utf8") + (chosen.length > 0 ? 2 : 0);
    if (size + bytes > budget) continue;
    chosen.push(paragraph);
    size += bytes;
  }
  return chosen
    .toSorted((a, b) => a.index - b.index)
    .map((paragraph) => paragraph.text)
    .join("\n\n");
}

export function selectMemories(
  notes: readonly MemoryNote[],
  task: string,
  role: string,
): MemorySelection {
  const terms = meaningfulWords(task);
  const queryIds = identifiers(task);
  const ranked = notes
    .map((note) => rank(note, terms, queryIds, role))
    .toSorted((a, b) => a.tier - b.tier || b.score - a.score || compare(a.path, b.path));
  const hashes = new Set<string>();
  const unique: typeof ranked = [];
  const omitted: { path: string; reason: string }[] = [];
  for (const note of ranked) {
    if (!note.qualifies) {
      omitted.push({ path: note.path, reason: "insufficient_relevance" });
      continue;
    }
    if (hashes.has(note.hash)) {
      omitted.push({ path: note.path, reason: "duplicate_content" });
      continue;
    }
    hashes.add(note.hash);
    unique.push(note);
  }
  const neighborhoodUsed = unique.filter((note) => note.tier === 1).length < 3;
  const selected: SelectedMemory[] = [];
  let bytes = 0;
  for (const note of unique) {
    if (note.tier === 2 && !neighborhoodUsed) {
      omitted.push({ path: note.path, reason: "project_matches_sufficient" });
      continue;
    }
    if (selected.length === 5) {
      omitted.push({ path: note.path, reason: "note_limit" });
      continue;
    }
    const separatorBytes = selected.length > 0 ? 2 : 0;
    const excerpt = excerptFor(note.content, note.matchedTerms, 4096 - bytes - separatorBytes);
    if (!excerpt) {
      omitted.push({ path: note.path, reason: "excerpt_budget" });
      continue;
    }
    bytes += Buffer.byteLength(excerpt, "utf8") + separatorBytes;
    selected.push({
      path: note.path,
      content: note.content,
      version: note.version,
      tier: note.tier,
      excerpt,
      score: note.score,
      matchedTerms: note.matchedTerms,
      reason: `Tier ${note.tier}; ${role}; ${note.exactIdentifier ? "exact identifier; " : ""}matched ${note.matchedTerms.join(", ") || "source identifier"}`,
    });
  }
  return { selected, omitted, neighborhoodUsed, bytes };
}

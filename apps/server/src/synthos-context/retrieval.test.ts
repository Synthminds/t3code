import { describe, expect, it } from "@effect/vitest";
import { parseRouting, selectMemories, selectRoutes, type MemoryNote } from "./retrieval.ts";

const note = (path: string, content: string, tier: 1 | 2 = 1): MemoryNote => ({
  path,
  content,
  version: `version:${path}`,
  tier,
});

describe("context routing and lexical memory recall", () => {
  it("keeps cross-boundary routes and role restrictions without substring matches", () => {
    const markdown =
      "```json\n" +
      JSON.stringify({
        version: 1,
        routes: [
          {
            id: "memory",
            keywords: ["vault", "Obsidian"],
            roles: [],
            paths: ["memory/"],
            load: ["memory/CONTEXT.md"],
            skip: [],
          },
          {
            id: "contracts",
            keywords: ["contracts"],
            roles: ["crew", "reviewer"],
            paths: ["contracts/"],
            load: [],
            skip: [],
          },
        ],
      }) +
      "\n```";
    const routes = parseRouting(markdown);
    expect(
      selectRoutes(routes, "Change Obsidian contracts", "crew").map((route) => route.id),
    ).toEqual(["contracts", "memory"]);
    expect(
      selectRoutes(routes, "Change Obsidian contracts", "search").map((route) => route.id),
    ).toEqual(["memory"]);
    expect(selectRoutes(routes, "Implement vaulted ceilings", "crew")).toEqual([]);
    expect(() => parseRouting('```json\n{"version":2,"routes":[]}\n```')).toThrow(
      "routing_invalid",
    );
    expect(() => parseRouting('```json\n{"version":1,"routes":[{}]}\n```')).toThrow(
      "routing_invalid",
    );
    expect(() => parseRouting("no routing block")).toThrow("routing_block_missing");
  });

  it("prefers approved sources, uses neighborhoods for weak coverage, and rejects unrelated text", () => {
    const result = selectMemories(
      [
        note("approved.md", "# Capture design\n\nObsidian receipts require verification."),
        note("neighbors/strong.md", "# Obsidian receipts\n\nRelated capture considerations.", 2),
        note("neighbors/unrelated.md", "# Cycling\n\nPlanning scenic mountain routes.", 2),
        note("neighbors/weak.md", "# Obsidian\n\nA personal diary.", 2),
      ],
      "Fix Obsidian receipts",
      "crew",
    );
    expect(result.selected.map((entry) => entry.path)).toEqual([
      "approved.md",
      "neighbors/strong.md",
    ]);
    expect(result.neighborhoodUsed).toBe(true);
    expect(result.omitted).toContainEqual({
      path: "neighbors/weak.md",
      reason: "insufficient_relevance",
    });
    expect(result.omitted).toContainEqual({
      path: "neighbors/unrelated.md",
      reason: "insufficient_relevance",
    });
    expect(result.selected[0]?.version).toBe("version:approved.md");
    const changed = selectMemories(
      [note("approved.md", "# Changed topic\n\nCycling routes.")],
      "Fix Obsidian receipts",
      "crew",
    );
    expect(changed.selected).toEqual([]);
  });

  it("counts distinct project memories before suppressing neighborhood expansion", () => {
    const content = "# Obsidian receipts\n\nCapture verification.";
    const notes = [
      note("a.md", content),
      note("copy.md", content),
      note("b.md", content + " One."),
      note("c.md", content + " Two."),
      note("neighbor.md", content + " Three.", 2),
    ];
    const enough = selectMemories(notes, "Obsidian receipts", "lead");
    expect(enough.neighborhoodUsed).toBe(false);
    expect(enough.selected.map((entry) => entry.path)).toEqual(["a.md", "b.md", "c.md"]);
    expect(enough.omitted).toContainEqual({ path: "copy.md", reason: "duplicate_content" });
    expect(enough.omitted).toContainEqual({
      path: "neighbor.md",
      reason: "project_matches_sufficient",
    });
    const weak = selectMemories(
      notes.filter((entry) => entry.path !== "c.md"),
      "Obsidian receipts",
      "lead",
    );
    expect(weak.neighborhoodUsed).toBe(true);
    expect(weak.selected.map((entry) => entry.path)).toContain("neighbor.md");
  });

  it("weights titles and tags over repeated body terms with stable ordering", () => {
    const result = selectMemories(
      [
        note("body.md", "Obsidian receipts ".repeat(100)),
        note("tags.md", "---\ntags: [Obsidian, receipts]\n---\n\nEvidence collected."),
        note("z-title.md", "# Obsidian receipts\n\nA guide."),
        note("a-title.md", "# Obsidian receipts\n\nAnother guide."),
      ],
      "Obsidian receipts",
      "reviewer",
    );
    expect(result.selected.map((entry) => entry.path)).toEqual([
      "a-title.md",
      "z-title.md",
      "tags.md",
      "body.md",
    ]);
    expect(result.selected.map((entry) => entry.score)).toEqual([10, 10, 8, 2]);
  });

  it("admits exact identifiers without admitting single generic terms", () => {
    const result = selectMemories(
      [
        note("receipts.md", "# Receipt details\n\nUse captureReceipt to preserve provenance."),
        note("generic.md", "# Receipt details\n\nInspect provenance later."),
      ],
      "Fix captureReceipt",
      "crew",
    );
    expect(result.selected.map((entry) => entry.path)).toEqual(["receipts.md"]);
    expect(result.selected[0]?.reason).toContain("exact identifier");
    expect(
      selectMemories([note("only.md", "# Obsidian\n\nDaily journal.")], "Use Obsidian", "docs")
        .selected,
    ).toEqual([]);
    const roleNotes = [
      note("a-implementation.md", "Obsidian receipts implementation interface."),
      note("z-api.md", "Obsidian receipts api documentation."),
      note("unrelated-api.md", "API documentation reference."),
    ];
    expect(
      selectMemories(roleNotes, "Obsidian receipts", "docs").selected.map((entry) => entry.path),
    ).toEqual(["z-api.md", "a-implementation.md"]);
    expect(
      selectMemories(roleNotes, "Obsidian receipts", "crew").selected.map((entry) => entry.path),
    ).toEqual(["a-implementation.md", "z-api.md"]);
  });

  it("keeps complete paragraphs within the UTF-8 budget and caps selected sources", () => {
    const huge = `Obsidian receipts ${"🚙".repeat(1100)}.`;
    const small = "Obsidian receipts retain source references.";
    const result = selectMemories(
      [
        note("large.md", `${huge}\n\n${small}`),
        ...Array.from({ length: 6 }, (_, i) =>
          note(`note-${i}.md`, `Obsidian receipts ${i} retain complete evidence.`),
        ),
      ],
      "Obsidian receipts",
      "docs",
    );
    expect(result.selected).toHaveLength(5);
    expect(result.selected.find((entry) => entry.path === "large.md")?.excerpt).toBe(small);
    expect(result.bytes).toBe(
      Buffer.byteLength(result.selected.map((entry) => entry.excerpt).join("\n\n"), "utf8"),
    );
    expect(result.bytes).toBeLessThanOrEqual(4096);
    expect(result.omitted.filter((entry) => entry.reason === "note_limit")).toHaveLength(2);
    const oversized = selectMemories(
      [note("too-big.md", `${huge}\n\nUnrelated material.`)],
      "Obsidian receipts",
      "lead",
    );
    expect(oversized.selected).toEqual([]);
    expect(oversized.omitted).toEqual([{ path: "too-big.md", reason: "excerpt_budget" }]);
  });
});

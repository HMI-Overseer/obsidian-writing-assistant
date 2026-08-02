/**
 * Pure outline / section logic for `get_outline` and `read`'s section pathway
 * (tool-set-review D6). Kept free of Obsidian so it is unit-testable: the
 * handlers feed it `getFileCache().headings` plus the note's lines and render
 * the result.
 *
 * The seam the two must get right is a single shared `headingPath` vocabulary:
 * `get_outline` emits the full breadcrumb of every heading, and `read` accepts that
 * exact string back as its optional `headingPath`, so the model pipes one into the
 * other with no translation. {@link buildOutline} produces the breadcrumbs and section
 * spans; {@link matchSection} resolves a (possibly partial or duplicated) `headingPath`
 * against them.
 */

/** The fields of Obsidian's `HeadingCache` this module needs (structurally compatible). */
export interface RawHeading {
  /** Heading text with the leading `#` markers and surrounding whitespace stripped. */
  heading: string;
  /** Heading level, 1 (`#`) through 6 (`######`). */
  level: number;
  position: { start: { line: number } };
}

/** One heading plus the section it owns, addressed by a full breadcrumb path. */
export interface OutlineHeading {
  /** Heading level, 1-6 (the `depth` the model sees). */
  depth: number;
  /** Leaf heading text (the last segment of `headingPath`). */
  heading: string;
  /** Full breadcrumb, e.g. `"Act I > Chapter 3 > The Duel"`. */
  headingPath: string;
  /** 0-indexed line of the heading itself. */
  startLine: number;
  /** 0-indexed last line of the section (inclusive), before trailing-blank trim. */
  endLine: number;
}

/** Result of resolving a `headingPath` query against an outline. */
export type SectionMatch =
  | { kind: "found"; heading: OutlineHeading }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "not-found" };

/** The breadcrumb separator shared by emit ({@link buildOutline}) and match ({@link matchSection}). */
const SEP = " > ";

/**
 * Turn a flat heading list into an outline: each heading's full breadcrumb path
 * and the line span of its section. A section runs from the heading line down to
 * the line before the next heading of equal-or-higher level (so a parent heading
 * owns its subsections); the last such section runs to `totalLines - 1`.
 */
export function buildOutline(headings: RawHeading[], totalLines: number): OutlineHeading[] {
  const result: OutlineHeading[] = [];
  // Ancestor stack (strictly shallower than the current heading) for breadcrumbs.
  const stack: Array<{ level: number; title: string }> = [];

  for (let i = 0; i < headings.length; i++) {
    const { heading: title, level } = headings[i];
    // Drop entries at this level or deeper, leaving only strict ancestors.
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    const headingPath = [...stack.map((s) => s.title), title].join(SEP);
    stack.push({ level, title });

    // Section ends just before the next heading of equal-or-higher level, else EOF.
    let endLine = totalLines - 1;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= level) {
        endLine = headings[j].position.start.line - 1;
        break;
      }
    }

    result.push({
      depth: level,
      heading: title,
      headingPath,
      startLine: headings[i].position.start.line,
      endLine,
    });
  }

  return result;
}

/**
 * The section's lines (heading through `endLine`), with trailing blank lines
 * dropped so the blank padding before the next heading is not counted or
 * rendered. The heading line is always kept, even for an empty section.
 */
export function sectionLines(allLines: string[], heading: OutlineHeading): string[] {
  const slice = allLines.slice(heading.startLine, heading.endLine + 1);
  while (slice.length > 1 && slice[slice.length - 1].trim() === "") slice.pop();
  return slice;
}

/**
 * Approximate readable word count of a section: markdown heading markers
 * (`#`..`######` at line start) are stripped so the heading *syntax* is not
 * counted, then remaining whitespace-separated tokens are tallied.
 */
export function countWords(text: string): number {
  const stripped = text.replace(/^#{1,6}\s+/gm, "").trim();
  return stripped === "" ? 0 : stripped.split(/\s+/).length;
}

/** Split a `headingPath` query into trimmed, non-empty segments. */
function segmentsOf(path: string): string[] {
  return path
    .split(">")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Resolve a `headingPath` query against an outline. The query may be the full
 * breadcrumb, a deeper-narrowing partial (a trailing run of segments), or a bare
 * leaf; a match is any heading whose breadcrumb *ends with* the query's segments.
 * Exactly one match resolves; several (a duplicated leaf like `"Scene 1"`) is
 * `ambiguous` with the candidate full paths; none is `not-found`.
 */
export function matchSection(outline: OutlineHeading[], query: string): SectionMatch {
  const want = segmentsOf(query);
  if (want.length === 0) return { kind: "not-found" };

  const matches = outline.filter((o) => {
    const segs = o.headingPath.split(SEP);
    if (want.length > segs.length) return false;
    const tail = segs.slice(segs.length - want.length);
    return tail.every((seg, k) => seg === want[k]);
  });

  if (matches.length === 1) return { kind: "found", heading: matches[0] };
  if (matches.length > 1) return { kind: "ambiguous", candidates: matches.map((m) => m.headingPath) };
  return { kind: "not-found" };
}

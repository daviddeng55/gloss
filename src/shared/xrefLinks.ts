// Turns a topic's cross-references into Markdown links in its (already formatted) notes: the first time each
// term appears outside math, code and existing links, it becomes [term](#xref/<topic>/<section> "where it leads").

export type XrefLink = { text: string; topicId: string; sectionId?: string; label: string };

/** Spans that must not get links: display and inline math, code, and links already there. */
function protectedSpans(md: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const m of md.matchAll(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$|`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\)/g)) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

export function xrefHref(topicId: string, sectionId?: string): string {
  return `#xref/${topicId}${sectionId ? `/${sectionId}` : ""}`;
}

/** "#xref/<topic>/<section>" → its parts, or null for any other link. */
export function parseXrefHref(href: string | undefined): { topicId: string; sectionId?: string } | null {
  const m = /^#xref\/([\w-]+)(?:\/([\w-]+))?$/.exec(href ?? "");
  return m ? { topicId: m[1], sectionId: m[2] } : null;
}

export function applyXrefs(md: string, links: XrefLink[] | undefined): string {
  let out = md;
  for (const link of links ?? []) {
    const words = link.text.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (!words.length) continue;
    const re = new RegExp(`(?<![\\w-])${words.join("\\s+")}(?![\\w-])`, "gi");
    const spans = protectedSpans(out);
    for (const m of out.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (spans.some(([a, b]) => start < b && end > a)) continue;
      const title = link.label.replace(/"/g, "'");
      out = `${out.slice(0, start)}[${m[0]}](${xrefHref(link.topicId, link.sectionId)} "${title}")${out.slice(end)}`;
      break;
    }
  }
  return out;
}

// Cross-references between notes, worked out once and kept in the database until the notes change (any topic
// added, updated or deleted), so opening a topic doesn't redo the work. The rules are in core/xref.ts.
import type { StudyDb } from "../core/db.ts";
import { buildXrefs, type TopicXrefs } from "../core/xref.ts";
import type { Course, NoteTopic } from "../shared/types.ts";

export class XrefIndex {
  private db: StudyDb;
  private courses: () => Course[];
  private memo: { version: string; xrefs: Map<string, TopicXrefs> } | null = null;

  constructor(db: StudyDb, courses: () => Course[]) {
    this.db = db;
    this.courses = courses;
  }

  /** All cross-references, from memory, the database cache, or worked out afresh (and cached). */
  private all(): Map<string, TopicXrefs> {
    const version = this.db.notesVersion();
    if (this.memo?.version === version) return this.memo.xrefs;
    let xrefs = this.db.cachedXrefs(version);
    if (!xrefs) {
      xrefs = buildXrefs(this.db.allNotes());
      this.db.saveXrefs(version, xrefs);
    }
    this.memo = { version, xrefs };
    return xrefs;
  }

  /** A topic's links (with labels saying where each leads) and the topics that link to it. */
  forTopic(topicId: string): Pick<NoteTopic, "xrefs" | "related"> {
    const all = this.all();
    const topics = new Map(this.db.allNotes().map((t) => [t.id, t]));
    const courseName = (id: string) => this.courses().find((c) => c.id === id)?.name ?? id;
    const own = topics.get(topicId);
    const label = (to: string, sectionId?: string) => {
      const t = topics.get(to);
      if (!t) return "";
      const section = sectionId ? t.sections.find((s) => s.id === sectionId)?.title : undefined;
      return `${t.courseId !== own?.courseId ? `${courseName(t.courseId)} · ` : ""}${t.title}${section ? ` › ${section}` : ""}`;
    };
    const xrefs: NonNullable<NoteTopic["xrefs"]> = {};
    for (const [where, links] of Object.entries(all.get(topicId) ?? {})) {
      const ok = links.filter((l) => topics.has(l.topicId));
      if (ok.length) xrefs[where] = ok.map((l) => ({ ...l, label: label(l.topicId, l.sectionId) }));
    }
    // Pages that link here: every other topic with a link to this one, with the words they link with.
    const related: NonNullable<NoteTopic["related"]> = [];
    for (const [from, links] of all) {
      if (from === topicId || !topics.has(from)) continue;
      const terms = [...new Set(Object.values(links).flat().filter((l) => l.topicId === topicId).map((l) => l.text.toLowerCase()))];
      if (!terms.length) continue;
      const t = topics.get(from)!;
      related.push({ topicId: from, title: t.title, courseName: courseName(t.courseId), terms });
    }
    return { xrefs, related };
  }
}

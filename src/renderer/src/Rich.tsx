// Shows text with Markdown, math ($...$ via KaTeX) and code blocks.
import "katex/dist/katex.min.css";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import { parseXrefHref } from "../../shared/xrefLinks.ts";

/**
 * `keepLines`: captured notes rely on their line breaks, which Markdown would otherwise merge.
 * `onXref`: cross-reference links in notes ("#xref/…") call it instead of navigating.
 */
export default function Rich({
  text,
  keepLines = false,
  className = "",
  onXref,
}: {
  text: string;
  keepLines?: boolean;
  className?: string;
  onXref?: (topicId: string, sectionId?: string) => void;
}) {
  const source = keepLines ? text.replace(/([^\n])\n(?!\n)/g, "$1  \n") : text;
  return (
    <div className={`rich selectable ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
        components={{
          a: ({ href, title, children }) => {
            const x = parseXrefHref(href);
            if (!x) return <a href={href} title={title ?? undefined}>{children}</a>;
            return (
              <a
                href={href}
                title={title ? `See: ${title}` : undefined}
                className="xref"
                onClick={(e) => {
                  e.preventDefault();
                  onXref?.(x.topicId, x.sectionId);
                }}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

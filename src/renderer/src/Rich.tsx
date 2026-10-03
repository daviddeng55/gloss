// Shows text with Markdown, math ($...$ via KaTeX) and code blocks.
import "katex/dist/katex.min.css";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";

/** `keepLines`: captured notes rely on their line breaks, which Markdown would otherwise merge. */
export default function Rich({ text, keepLines = false, className = "" }: { text: string; keepLines?: boolean; className?: string }) {
  const source = keepLines ? text.replace(/([^\n])\n(?!\n)/g, "$1  \n") : text;
  return (
    <div className={`rich selectable ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

// The small "Sent to cloud" label on anything written by Gemini in fast mode (summaries, quizzes, notes,
// answers, Study Buddy). Everything without it was written on your Mac.
export default function CloudTag({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full bg-hover px-2 py-0.5 align-middle font-sans text-[11px] font-medium tracking-normal normal-case text-muted ${className}`}
      title="Fast mode: this was written by Gemini, so the text it's based on was sent to Google."
    >
      <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
        <path d="M4.5 12.5h7a3 3 0 0 0 .4-5.97A4 4 0 0 0 4.2 7.6 2.5 2.5 0 0 0 4.5 12.5Z" strokeLinejoin="round" />
      </svg>
      Sent to cloud
    </span>
  );
}

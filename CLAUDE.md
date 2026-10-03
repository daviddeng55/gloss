# CLAUDE.md — Study Buddy

The full spec is in `PRD.md`. Build stages in order; don't start a stage until the previous one works.

## How to work with me
I'm a beginner building this to learn.

- **Keep building through each stage without stopping after every small step.** Only stop and ask me when:
  1. You want to install a package, tool, model, or download anything
  2. I need to grant a macOS permission, sign in, or create an account
  3. I need to add a key or password (I'll enter keys myself, never in chat)
  4. You'd delete files or data, or change the stack or the plan
- **Stop at the end of each stage** and tell me what you built, what to run, and what I should see.
- **Verify your own work** before stopping: run the build and type checks and fix errors.
- **Explain new concepts in 1–2 sentences** when they first come up (text recognition, embeddings, chunks, Electron main vs. renderer, vision models).
- **Never read or print the contents of `.env` files.**
- **Commit to git** after each working feature.
- Keep the short "Where we left off" note at the bottom of this file up to date.

## Project notes
- Node 26 runs `.ts` files directly (no build step); `npm run typecheck` checks types. Avoid TS-only runtime syntax (enums, constructor parameter properties).
- `helper/vision-helper.swift` is compiled with the Command Line Tools (`npm run build:helper`) into `bin/` (gitignored). It captures in memory with ScreenCaptureKit and reads text with Vision; Node talks to it via JSON lines (`src/helper.ts`).
- `sessions/` holds terminal-session transcripts and is gitignored (personal data).
- App: electron-vite (vite 7; electron-vite 5 doesn't support vite 8). Database is Node's built-in `node:sqlite` (works in Electron 44, so no better-sqlite3). Preload is built as CommonJS (sandboxed).
- Dev checks: `STUDY_BUDDY_DB=<temp.db> STUDY_BUDDY_SMOKE=<dir> npx electron-vite preview` screenshots both windows; `STUDY_BUDDY_SMOKE_SESSION=<seconds>` records a real session with a pause. Always use a throwaway `STUDY_BUDDY_DB`.
- Launched from a terminal, the app inherits that terminal app's Screen Recording permission.
- Dev checks with `STUDY_BUDDY_DB` get their own data folder and skip the single-instance lock, so they can run beside the user's copy. `STUDY_BUDDY_SMOKE_REVIEW=<dir>` makes the newest session's summary + quiz with the real model.
- AI: Ollama + qwen3.5:4b, ~16 tokens/s. Quiz = makeQuiz (8 questions, no thinking) then verifyQuestions (drops unsupported ones; keep "problem" short or it rambles). Thinking mode was too slow. Forcing LaTeX in summaries made the 4B model write wrong math, so summaries use plain notation; quiz questions/answers do use $...$. Models write LaTeX with single backslashes inside JSON: `fixLatexEscapes`.

## Where we left off
- 2026-10-02: Stage 1 done (math symbol fix-ups for ∈ ℕ ∀ added). Old private transcript deleted.
- 2026-10-02: **Stage 2 done.** User ran real sessions in the app (CS 135 46 s, MATH 135 6.5 min): both ended cleanly, 2 and 8 chunks from Chrome, 0 errors, ~0.4 s per read. Pause/Resume only verified in my smoke test. User finds symbol recognition poor (Σ, Greek, √, exponents); fix is the vision-model math pass (option A) in Stage 3. History is mainly a capture check until Stage 3/5/6 add summaries, sources and delete controls.
- 2026-10-02: **Stage 3 built** (awaiting the user's real test): review window opens on End Session (summary ~1 min, then quiz ~2 min, KaTeX, sources), MC marked directly, short answers by AI, scores + spaced-review fields saved (quiz_items table, migration 2). History shows summary/score and opens the review. Math pass for math courses (`"math": true` in courses.json): crops new math from the in-memory screenshot, model transcribes, lines swapped in only where words match; 45 s cooldown. 28 tests pass. Real-model run on the MATH 135 session: ready in 130 s, 5 accurate summary points, 8 questions written / 4 dropped by checking (below the PRD's 5–8 because the passages' math was garbled; math pass should help). Math pass not yet tried live.
- 2026-10-03: User's first real Stage 3 test: symbols still wrong (math pass ran only 5× in 6.7 min due to the 45 s cooldown) and an accidental New Tab + a Google search got into the session. Fixed: math re-reads now queue in the background for every math capture (max 6 waiting; entries saved in order after their re-read; up to 3 min to finish after End Session, review shows "Finishing…"); 8 s dwell rule before a window/tab is read; blank pages (New Tab) skipped; summary/quiz prompts drop off-course passages; History has ✕ per passage and "Redo" for summary+quiz; short answers have a symbol bar. Line matching now counts digits. 31 tests pass.
- Next: user retests. Then Stage 4 (hover and ask).

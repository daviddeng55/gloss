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

## Where we left off
- 2026-10-02: Stage 1 done (math symbol fix-ups for ∈ ℕ ∀ added). Old private transcript deleted.
- 2026-10-02: **Stage 2 built**: menu bar app (tray icon, start popup, pause/resume/end, auto-pause on lock/sleep, History window), SQLite sessions + chunks. Type checks, build and 20 tests pass; smoke tests confirmed both windows render, and a real app session (start → pause → resume → end) saved correct study time. Not yet verified by the user, and no passages were saved in my test because VS Code (this project) was in front. Waiting on the user to try `npm run dev` with a real session. Next: Stage 3 (summary + quiz, needs Ollama; also add the vision-model math pass, option A).

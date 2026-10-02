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
- `sessions/` holds transcripts and is gitignored (personal data).

## Where we left off
- 2026-10-02: **Stage 1 done** (user accepted after a ~1-minute real session in the MATH 135 slides: correct labels, no VS Code/private text, reads cleanly; a full 10-minute run and laptop responsiveness weren't checked). Known limits: superscripts/subscripts are lost in math (5^(k-1) reads "5k-1"), Stage 4 sends images so it's unaffected; private windows only caught by title. Deleted the 14:12 transcript (private LinkedIn/Gmail text) at the user's request. Math fix options proposed (vision-model math pass vs. superscript-position trick); awaiting the user's choice. Next: Stage 2 (menu bar app) — ask before installing Electron/React/Tailwind/better-sqlite3.

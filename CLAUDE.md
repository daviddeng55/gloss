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
- 2026-10-02: Stage 1 built. First real session (display mode) was only ~18% MATH 135 notes: the app label was stuck on "Code" (NSWorkspace doesn't refresh in a CLI; now uses live CGWindowList order), and VS Code/terminal, LinkedIn, Gmail and the Claude app were captured. Fixed: front-window detection (incl. full-screen Chrome toolbar strips), skip this project's own editor/terminal windows, more never-record entries, discard captures if the window changed mid-capture, fuzzy duplicate matching, browser/PDF toolbar noise, 20 s helper timeout. 30 s live test in Chrome looks clean. **Stage 1 not yet "Done":** needs a real 10-minute window-mode session reviewed by the user. Math: superscripts/subscripts are lost (5^(k-1) reads "5k-1"); Stage 4 sends images so it's unaffected. Old transcript sessions/math135/2026-10-02_141205.* holds private LinkedIn/Gmail text — asked the user whether to delete it.

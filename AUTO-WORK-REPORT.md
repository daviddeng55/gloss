# Auto-work report — 2026-10-15 (13:38–14:10)

Everything is on the local branch **`auto-work-oct15`**. Nothing was pushed and `main` is untouched. I didn't call
Ollama, didn't start or quit your Gloss, and didn't open your real database. All tests ran on throwaway copies
with a pretend AI. No installs.

> **Heads-up 1: Gloss wasn't running.** When I started (13:38), there was no Gloss process; only Ollama was
> running. `gloss.db` was last written at 00:50, so the notes backfill has probably stopped partway. It
> continues by itself the next time Gloss starts.
>
> **Heads-up 2: this folder is now on the new branch.** If you start Gloss from this folder now, you get the
> new code. Your database is upgraded to version 7 (Gloss saves `gloss.backup-v6.db` first), and the
> "Meet your Study Buddy" picker opens. To run your previous version instead: `git checkout main`.

## Commits (on `auto-work-oct15`)

1. `7498ddf` Put every AI call behind one ModelProvider interface (Ollama now, swappable later)
2. `0b20242` Add Study Buddy
3. `0f60582` Research: Apple on-device model vs Gemini vs Ollama for Gloss
4. `2cc6d2d` Study Buddy smoke check: also run the real trigger path with fast timings
5. (this report + CLAUDE.md update)

Checks: `npm run typecheck` is clean, **88 tests pass** (up from 64), and `electron-vite build` succeeds.

## Task 1: Study Buddy — done (tested only with the pretend AI)

**What it is:** a small character in the bottom-right corner. After you finish something, it asks you to
explain it, like a curious classmate. No grades are ever shown. Your answer only changes its reaction and
quietly updates How You Learn.

- **Characters:** dog (Biscuit, eager), cat (Miso, calm), penguin (Pip, polite, with a bow tie), birdie (Wren,
  chirpy). They're original SVGs with CSS animations: idle bob, blinking, a curious head tilt when asking, a
  happy bounce with sparkles, a puzzled tilt with a "?" when the answer has a gap, and thinking dots. They use
  your design tokens and work in light and dark mode. Animations turn off when macOS "Reduce motion" is on.
- **Picker:** "Meet your Study Buddy" opens once, on the first normal start after this update. It has 4
  animated cards, a name field, "Choose", "Ask me later" and "No buddy, thanks". The same cards are in
  **Settings → Study Buddy**, along with an on/off switch and "Appear at most every N minutes" (default 15,
  range 10–120). The choice is saved in `settings.json` under `buddy`.
- **When it appears** (`src/core/buddy.ts`, `BuddyTrigger`). All of these rules are covered by tests:
  - Only after you've spent **≥ 4 minutes** on one thing and then **moved on**: another page, or another
    known concept on the same page.
  - Only **10–75 s after moving on**. A quick glance away and back doesn't count, and once you're reading the
    next thing, the moment has passed.
  - Never during circle-and-ask or for 2 minutes after it. Never while you're typing: it checks the Mac's
    keyboard/mouse idle time (≥ 3 s needed), which needs no Input Monitoring permission.
  - At most once per your setting (15 min), and never twice about the same thing in a session. It skips
    concepts you clearly know already.
  - **Not now** = away for 20 minutes. **Pause for this session**. The off switch is in Settings.
  - If the AI is slow (busy with math re-reads) and you've moved on, it lets that moment go.
- **The chat:** one short question → you answer by **typing** (Enter sends) or **voice** (the mic button uses
  the existing on-device Gloss Voice and works only during a session). A **solid** answer gets the happy
  reaction and a thank-you. A **gap** gets one gentle follow-up question, at most two, then it thanks you and
  leaves. If you ignore it, it leaves after 3 minutes. The window floats and never takes focus; click into the
  box to type.
- **Grading and the learner model:** the local model judges the answer as solid or gap. You never see the
  verdict. It's saved as new evidence ("explained to your Study Buddy"), which counts less than a quiz answer.
  How You Learn shows it in a concept's "why" lines.
- **Logged to the review:** every chat is saved with its session (new table `buddy_chats`, migration 7) and
  shown in the review window under "Chats with your Study Buddy". Deleting a session deletes its chats.
- **One interface for models:** every AI call (summaries, quizzes, marking, notes, asking, math reading,
  embeddings, Study Buddy) now goes through `ModelProvider` (`src/core/provider.ts`). Ollama is the only real
  provider today; Apple's model or a cloud model can be added as another class. A side benefit: tests now use a
  pretend provider automatically, so they can never reach Ollama.
- **Screenshots** are in `design/screenshots/` (light and dark): the picker (empty and with the cat chosen),
  each character asking, confused and happy, and the review section. 30 files, 2.1 MB, kept in git (I added a
  `.gitignore` exception).

### Verified (pretend AI, throwaway database and settings)

- Feeding the real service the observations "read a page for a while → switch pages" made the buddy
  **appear by itself** with its question. "Not now" closed it and logged the chat as skipped.
- For all 4 characters: question → shaky answer → follow-up (confused) → good answer → happy. Each chat was
  saved with 5 turns, and "explain" evidence was added to the existing "Strong induction" concept.

### Not tested yet (needs you / a free Ollama)

- Quality of **real** questions and verdicts from qwen3.5:4b. The prompts are written, but none were run on a
  real model.
- **Voice** answers (the code path is shared with circle-and-ask, but untested here).
- **Typing** into the floating panel window: it should take keyboard focus when clicked, but I couldn't click.
- The timing in a real session: the 4-minute "finished" rule, the 15-minute gap, and whether it feels right.

### Skipped / decisions you may want to change

- **Sections inside one long page** are told apart only by known concepts. A new course with no concepts yet
  only counts page or tab changes. Detecting headings would be next.
- I picked these numbers: 4 min to count as "finished", the 10–75 s window, 3 s idle, 2 min quiet after
  asking, and 3 min before it gives up. They're in `DEFAULT_TRIGGER` and easy to tune.
- The buddy uses your **ask model** (`ai.askModel`) and jumps the queue only when reacting to your answer.
- PRD.md and README don't mention Study Buddy yet.

## How to try Study Buddy live (once Ollama is free)

1. In this folder: `git checkout auto-work-oct15` (it's already checked out), then start Gloss the usual way.
   Your database upgrades to v7 with an automatic backup.
2. The picker opens after ~3 s. Choose a buddy and name it (or later: Settings → Study Buddy).
3. Start a session. Read one page or topic for **4+ minutes**, then switch to a different page or tab and
   keep your hands off the keyboard and mouse for a few seconds. Within ~10–75 s the buddy should slide in
   bottom-right.
4. Try a vague answer ("not sure") → it should look puzzled and ask a follow-up. Try a real explanation →
   happy bounce. Try the mic button for voice, and "Not now" (it stays away 20 min).
5. End the session: the review shows "Chats with your Study Buddy". Menu → How You Learn shows the concept's
   new "Explained to your Study Buddy" line.
6. If it never appears, the terminal log says why (`[buddy] not now: …`, for example "appeared recently" or
   "you're reading the next thing now").

To try it quickly without waiting, the dev check runs everything with a pretend AI (no Ollama):

```
node scripts/seed-demo-db.ts /tmp/buddy/demo.db && echo '{}' > /tmp/buddy/settings.json
GLOSS_AI=mock GLOSS_DB=/tmp/buddy/demo.db GLOSS_SETTINGS=/tmp/buddy/settings.json GLOSS_SMOKE_BUDDY=/tmp/buddy npx electron-vite preview
```

## Task 2: Research — done

`research/model-options.md` compares Apple's on-device model, Gemini (your own key vs. a hosted backend) and
Ollama, covering setup, quality, privacy and cost. Some facts I measured on this Mac:

- **Apple's on-device model is available here** (M5, macOS 26.6.2, Apple Intelligence on): 4,096-token
  context, ~0.5–1.7 s per short reply. Structured output works with `DynamicGenerationSchema`. The `@Generable`
  macro needs full Xcode, which isn't installed.
- In a tiny sample, its plain-prompt judge was too lenient ("because it's true" → solid). With a stricter
  schema it got 3/3 right.
- **Gemini's free tier uses your content to improve Google's products**, requires users to be 18+, and isn't
  allowed for users in the EEA or UK. A paid key would cost roughly $0.30–$2.50 per term for Gloss.

**Recommended default:** Apple's on-device model for short, interactive jobs (Study Buddy first), when it's
available. Keep Ollama as the optional full-quality local mode (math reading, images, long summaries and
notes). Offer Gemini with your own key only as an opt-in, with a clear privacy warning. Run a small real
bake-off before switching any default.

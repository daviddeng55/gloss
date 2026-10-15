# Gloss

> *gloss* (noun): a short note written beside a hard passage to explain it.

A study partner that lives in your Mac's menu bar. Start a session and it reads what's on your screen
while you study. Point at anything and ask about it. When you finish, it writes a summary and a short
quiz on what you covered. Everything runs **on your Mac**, using local AI models through
[Ollama](https://ollama.com). Nothing is sent online.

I built this to learn, as a beginner, for my own university courses. It works, but it's a personal
project, not a polished product. See [Known limitations](#known-limitations).

<!-- Screenshots: add images to docs/screenshots/ and link them here, e.g.
![Start a session](docs/screenshots/start.png)
![End-of-session review](docs/screenshots/review.png)
![Circle and ask](docs/screenshots/ask.png)
![How You Learn](docs/screenshots/learn.png)
-->
_Screenshots coming soon._

## What it does

- **Study sessions.** Click the menu bar icon, pick a course and start. Every few seconds Gloss
  checks the window you're working in. If the window has changed, it reads the text with macOS's
  built-in text recognition, then throws the screenshot away. Only text is kept. Nothing is
  captured outside a session.
- **Summary and quiz.** When you end a session, a review window shows a summary of what you covered,
  then a quiz of 5–8 questions (multiple choice and short answer) built only from your notes. Every
  point links back to the notes it came from.
- **Circle and ask.** During a session, press **Option+A**, circle something on screen, type or say
  your question, and press Option+A again. The answer uses your course material and starts with the
  smallest helpful hint. It never writes complete answers to graded work.
- **Math reading.** For courses marked as math, formulas are re-read by a small document-reading AI
  model, because Apple's text recognition garbles symbols.
- **Adaptive learning.** It keeps a model of what you know in each course: concepts, how well you know
  each one (this fades if you don't practise) and which kind of help works for you. It uses this to aim
  quizzes at weak spots, warm you up with questions due for review, and pitch answers at the right
  level. You can see, correct and delete all of it under **How You Learn…**.
- **Notes.** After each session, Gloss writes clean class notes in the background, organised by
  course and topic (e.g. MATH 135 → Strong Induction): a summary, key definitions, theorems and
  formulas, worked examples and common mistakes. New material on a topic you've studied before is
  merged into it. Every section links back to the raw capture it came from. See [Notes](#notes).
- **Find it.** Search your notes and everything Gloss has read on your screen. See [Find it](#find-it) below.
- **Privacy controls.** Apps and sites on a never-record list (password managers, banking, messaging,
  email, private windows) are never read. Card numbers, SINs and text near "password" are redacted
  before anything is saved. You can delete a session, or everything for a course, under Notes → All captures.

## Requirements

- A Mac with **Apple Silicon** (M1 or newer) and **16 GB of memory or more**. With 8 GB the AI models
  won't fit alongside your other apps.
- **macOS 26 (Tahoe)** or newer. It's developed and tested on macOS 26 only.
- About **6 GB of free disk space** for the AI models.
- **Node.js 26** or newer (it runs TypeScript directly): `brew install node` or [nodejs.org](https://nodejs.org).
- **Xcode Command Line Tools** (to build the small Swift helpers): `xcode-select --install`.
- **[Ollama](https://ollama.com)** with these models:

  | Model | Size | Used for | Needed? |
  |---|---|---|---|
  | `qwen3.5:4b` | 3.4 GB | summaries, quizzes, marking, answering questions | **required** |
  | `glm-ocr:q8_0` | 1.6 GB | reading math symbols correctly | recommended for math courses |
  | `embeddinggemma` | 621 MB | finding related notes from earlier sessions by meaning | optional (falls back to keyword search) |

## Setup

```sh
git clone https://github.com/daviddeng55/gloss.git
cd gloss
npm install
npm run build:helper      # builds the screen-reading and voice helpers into bin/

ollama pull qwen3.5:4b
ollama pull glm-ocr:q8_0      # optional, for math
ollama pull embeddinggemma    # optional
```

Make sure Ollama is running (its llama icon is in the menu bar), then start Gloss:

```sh
npm run dev               # keep this terminal open while you use the app
```

A forgetting-curve icon appears in the menu bar. Click it, then **Start session**.

**Your courses** are in `courses.json`. Edit it to add your own. Set `"math": true` on courses with
formulas to turn on math reading. You can also change courses and most other options in
**Settings…** (Command+,).

## macOS permissions

macOS asks for each permission the first time it's needed. If you miss a prompt, open
**System Settings → Privacy & Security** and turn it on there.

| Permission | Why | Where to turn it on |
|---|---|---|
| **Screen Recording** | to read the text on screen during a session | Privacy & Security → **Screen & System Audio Recording**. Turn on the app you launched Gloss from (e.g. **Terminal** or **Visual Studio Code**), because an app started from a terminal uses that terminal's permission. Quit and reopen the terminal afterwards. |
| **Microphone** | to hear your question when asking by voice | Privacy & Security → **Microphone** → **Gloss Voice** |
| **Speech Recognition** | to turn your spoken question into text, on your Mac | Privacy & Security → **Speech Recognition** → **Gloss Voice** |
| **Notifications** (optional) | quiet "want help?" offers when you seem stuck | System Settings → **Notifications** → your terminal app |

The microphone is on only between the two presses of the ask shortcut. Speech is recognised
on-device. If you don't want voice at all, turn it off in Settings and skip those two permissions.
Gloss doesn't need Accessibility or Input Monitoring.

## Using it

1. Click the menu bar icon to open the popover: **Start session** → pick a course → optionally type
   a goal → **Start**. The dot in the icon fills in and your study time shows next to it. The popover
   has **End session** with a timer and a pause button; sessions also pause while the Mac is locked.
   Right-click the icon for the plain text menu.
2. Study as usual. A window or tab is read only after it's been in front for 8 seconds, so quick
   switches are ignored.
3. **Option+A** → circle → ask. **Esc** cancels.
4. **End Session** → the review window opens with the summary (about 1 minute) and then the quiz
   (about 2 more minutes).
5. A few minutes later your **notes** are ready: **Open notes** in the popover. **All captures** (in
   the Notes sidebar) has every raw capture by session, where you can reopen reviews and delete
   passages, sessions or whole courses. **How You Learn** shows what the app thinks you know.
6. The popover lists your last 3 sessions with **Summary** and **Quiz** buttons.

Your data is stored in `~/Library/Application Support/Gloss/`. Delete that folder to erase
everything.

## Notes

The Notes window (**Open notes** in the popover) lists your courses with their topics. Each topic reads
like good class notes: a short summary, key definitions in highlighted boxes, theorems and formulas
(rendered as math), worked examples and common mistakes. Under every section, "from Oct 14, 2:14 PM"
opens the raw capture it was written from, so you can check it.

Notes are written by the local AI after a session's summary and quiz, one session at a time, while
you're not recording (about 2–4 minutes per session). The first time, Gloss also writes notes for all
your earlier sessions in the background; the sidebar shows "Writing notes…" until it's done. The small
model can get a formula wrong (especially where the screen reader garbled a symbol), so check anything
important against its source. Your raw captures are never changed.

## Find it

Click the menu bar icon and type in the search box what you remember, e.g. `strong induction`. Results
appear as you type, labelled **Note** (from your notes) or **Capture** (raw text from the screen): a
snippet with the matching words highlighted, the date and time, and the course and topic or window.
Click a capture (or use ↑ ↓ and Return) to read everything captured at that moment; click a note to
open it in the Notes window. **Esc** goes back, then closes.

It uses SQLite's built-in full-text search, so it's instant and works offline with no AI. Every word
must appear (any order, any case), and the last word can be unfinished. Deleted passages disappear
from the results.

## Known limitations

- **Slow on base laptops.** On a fanless MacBook Air with 16 GB, the main model writes about 16 words
  per second: a summary takes about a minute and a quiz about two more. The laptop gets warm during
  reviews. Answers to questions take 5–15 seconds.
- **Math symbols can be misread.** Apple's text recognition garbles Σ, Greek letters, √, exponents and
  fractions. The math-reading model fixes most of this, but not all of it, and notes from before it
  ran stay garbled (screenshots aren't kept, so they can't be re-read).
- **A small model makes mistakes.** Quiz questions are checked against your notes and unsupported ones
  are dropped, but a wrong answer key still slips through sometimes. Concept names in How You Learn
  can be odd or duplicated (use "Forget this concept" to clean them up).
- **The adaptive part needs data.** After one or two sessions it's mostly guessing; it gets useful
  after about a week of sessions with quizzes.
- **It only knows what it saw.** Lectures, paper homework and anything outside a session are
  invisible to it. Tell it with "I know this" in How You Learn.
- **Private windows** are only skipped when the window title says so (Safari's often doesn't).
- **No packaged app yet.** You run it from a terminal with `npm run dev`.
- Built and tested on one Mac (M5 MacBook Air, macOS 26). Other setups may need fixes.

## Rules for using it
- Never start a session during a test, quiz or exam.
- Check each course's rules about AI tools and follow them.

## For developers

```sh
npm run typecheck   # type checks
npm test            # unit tests
npm run build       # production build into out/
```

There's also a terminal-only capture command for testing text recognition:
`npm run session -- --course math135 --minutes 10` (transcripts go to `sessions/`, which is
gitignored), and `npm run ocr-test -- path/to/image.png`.

Project layout:
- `src/core`: capture loop, text cleaning, chunking, database, AI calls, learner model
- `src/main`: Electron main process (menu bar, sessions, windows, circle-and-ask)
- `src/preload`: the safe bridge between windows and the main process
- `src/renderer`: the windows (React + Tailwind)
- `src/cli`: terminal commands
- `helper/`: Swift helpers for screen capture + text recognition and for on-device speech

`PRD.md` is the original plan, and `CLAUDE.md` has the build notes. The app was built step by step with
[Claude Code](https://claude.com/claude-code).

## License

[MIT](LICENSE)

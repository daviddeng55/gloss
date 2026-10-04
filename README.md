# Study Buddy

A study partner on my Mac. See `PRD.md` for the plan.

## Rules for me
- Never start a session during a test, quiz or exam.
- Check each course's rules about AI tools and follow them.

## The menu bar app (Stage 2)

```sh
npm install              # once
npm run build:helper     # once, and after changing helper/vision-helper.swift
npm run dev              # starts Study Buddy in the menu bar (keep this terminal open)
```

Click the book icon in the menu bar → **Start Session…** → pick a course, optionally type a goal → **Start**.
While recording, the icon turns red and shows your study time. The menu has **Pause/Resume**, **End Session**
and **History…**. Sessions pause automatically while the screen is locked or the Mac sleeps.

When you **End Session**, a review window opens: first a summary of what you covered (about a minute),
then a quiz of about 5 questions (about 2 more minutes). Multiple choice is marked instantly; short answers
are marked by the AI against your notes. Every summary point and question links to the notes it came from.
Reopen any session's review from History.

For MATH courses (`"math": true` in `courses.json`), new formulas on screen are also re-read by the AI
model from a cropped screenshot (at most every 45 s), which fixes symbols Apple's text recognition misreads.

Sessions and their text are saved in `~/Library/Application Support/Study Buddy/study-buddy.db`.

### Circle and ask (during a session)
Press **Option+A**, circle what you're asking about (and say your question out loud), then press
**Option+A** again or click. A popup shows exactly what was sent and the answer, with buttons for a
Nudge, an explanation of the concept, or a worked example of a similar problem. **Esc** cancels.
The microphone is on only between the two presses; speech is turned into text on your Mac
("Study Buddy Voice" needs Microphone and Speech Recognition permission). Change the shortcut or turn
voice off in `settings.json`.

### AI (Ollama)
The AI runs on your Mac through [Ollama](https://ollama.com) — nothing is sent online.
Ollama must be running (it lives in the menu bar) with the model downloaded: `ollama pull qwen3.5:4b`.
Courses come from `courses.json` (edit it to add or rename courses).

Screen Recording: started from a terminal, the app uses that terminal app's permission (e.g. VS Code).
If it asks for permission, follow the steps in the popup.

## Stage 1 — session capture (terminal)

```sh
npm install              # once
npm run build:helper     # once, and after changing helper/vision-helper.swift
npm run session -- --course math135 --minutes 10 --goal "induction practice"
```

Press Ctrl+C to end early. Transcripts are saved to `sessions/<course>/` (`.md` to read, `.jsonl` as data).
Screenshots are captured in memory, read, and discarded; they are never written to disk.

Options: `--interval 5` (seconds), `--mode window|display`, `--engine document|lines`,
`--language-correction`, `--threshold 0.02` (how much of the screen must change before re-reading).

Use the default `window` mode: it captures only the window you're working in. `display` mode captures
the whole screen (minus blocked windows) and picks up much more unrelated text.

What is never captured:
- Apps and page titles in `never-record.json` (password managers, Messages, Mail/Gmail, LinkedIn,
  chat apps, the Claude and ChatGPT apps, banking). Edit it to add or remove entries.
- This project's own windows: VS Code or a terminal whose title mentions this folder. VS Code open on
  another folder (e.g. CS 135 work) is still recorded.
- Private/incognito windows are only caught when the title says so (Safari's usually doesn't).

Check how well text recognition reads a page (e.g. math notes):

```sh
npm run ocr-test -- ~/Desktop/notes.png
```

Other: `npm run typecheck`, `npm test`, `npm run build`.

## Project layout
- `src/core` — capture loop, text cleaning, chunking, database (shared by the app and the terminal command)
- `src/main` — the app's main process (menu bar, sessions, windows)
- `src/preload` — the safe bridge between windows and the main process
- `src/renderer` — the windows (React + Tailwind): start popup and History
- `src/cli` — terminal commands (`npm run session`, `npm run ocr-test`)
- `helper/vision-helper.swift` — screen capture + Apple text recognition

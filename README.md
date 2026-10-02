# Study Buddy

A study partner on my Mac. See `PRD.md` for the plan.

## Rules for me
- Never start a session during a test, quiz or exam.
- Check each course's rules about AI tools and follow them.

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

Other: `npm run typecheck`, `npm test`.

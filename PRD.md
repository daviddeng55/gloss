# PRD — Study Buddy (working name)

> A study partner on my Mac. I start a session, it studies alongside me, answers questions about what I'm pointing at, and quizzes me at the end.

## 1. What we're building

Study Buddy is a small Mac menu bar app, **for my own personal use**.

### The flow
1. **Start a session.** I click the menu bar icon, pick a course, and optionally type a goal ("finish induction practice problems").
2. **It studies with me.** While the session is on, it reads what's on my screen and remembers what I covered. It never records outside a session.
3. **Ask anytime.** I point at something, press a hotkey, and ask a question. It answers using what my course has covered so far.
4. **End the session.** It shows what I covered, then gives me a short quiz on today's material.
5. **Next session.** It warms me up with questions I got wrong last time.

### Core principles
1. **Only during sessions.** Capture starts when I start a session and stops when I end it. Nothing runs in between.
2. **Only what's been covered.** Explanations and quiz questions come from material I've actually studied. If a question needs something I haven't seen, say so.
3. **Teach, don't do.** Hints and explanations, never complete answers to graded work.
4. **Private by default.** Everything stays on my Mac unless I turn on a cloud model.
5. **Honest.** If it couldn't read something clearly or doesn't know, it says so. It never makes things up.

### My setup
- MacBook Air, M5, 16 GB memory, 512 GB storage, macOS. No fan, so keep AI work in short bursts and capture lightweight.
- Courses this term: MATH 135, MATH 137, CS 135 (Racket), COMM 101, COMMST 100.
- No third-party screen recorder. The app does its own capturing.

---

## 2. How it works (the pieces)

- **Capture (during a session only):** every few seconds, take a screenshot of the screen I'm working on. If it looks the same as the last one, skip it. Otherwise read the text from it using **macOS's built-in text recognition** (Apple's Vision framework), then delete the image and keep only the text.
- **Session memory:** the text is cleaned, split into chunks, and saved in a local SQLite database, tagged with the course, the session and the time.
- **Course memory:** all sessions for a course add up over time, so the app knows what I've covered so far.
- **AI:** local models through **Ollama** (`http://localhost:11434`) by default. A cloud provider is an optional setting.
- **App:** Electron menu bar app with an ask shortcut, an overlay and a popup.

---

## 3. Stages

Build in this order. **Do not start a stage until the previous one works.**

| Stage | Goal |
|---|---|
| 1 | Session capture: screenshots → readable text (run from the terminal) |
| 2 | Menu bar app: start/stop a session, pick a course, save sessions |
| 3 | End-of-session summary and quiz |
| 4 | Hover and ask |
| 5 | Memory and adaptive learning: course memory, learner model, adaptive teaching, noticing confusion |
| 6 | Privacy controls and polish |
| 7 | I use it for two weeks and keep notes |

---

## 4. Stage 1 — Session capture (terminal first)

`npm run session -- --course math135 --minutes 10` runs a capture session from the terminal.

1. Every 5 seconds (configurable), check the frontmost app. If it's on the never-record list, skip.
2. Capture the screen. Compare it with the previous capture (a quick image hash is fine). If nothing meaningful changed, skip.
3. **Read the text with macOS's built-in text recognition.** Evaluate the simplest reliable way to call Apple's Vision framework from this project (for example a tiny Swift command-line helper) and tell me your recommendation before installing anything.
4. Delete the screenshot after the text is extracted.
5. Clean the text: remove duplicates and near-duplicates across captures, drop menu bar and button noise, apply the redaction filter (section 10).
6. Save a readable transcript of the session: timestamps, app/window title, and the cleaned text.

macOS will require **Screen Recording permission**. Walk me through granting it.

**Done when:** after a 10-minute session reading real course notes and a web page, the saved transcript is clean and readable, with little repetition, and my laptop stays responsive.

**Known limit to check here:** text recognition struggles with math formulas. Show me how well it reads a page of MATH 135 notes, so we know early. Hover-and-ask (Stage 4) sends an image, so it isn't affected by this.

## 5. Stage 2 — Menu bar app
- Electron app with a **menu bar icon**, no Dock icon.
- **Start session:** pick a course from my list, optional goal text, then Start.
- While a session runs: the icon shows a clear "recording" state and the elapsed time. Menu has Pause/Resume and End session.
- Sessions and their text chunks are saved to SQLite.
- A simple **History** window: sessions by course, with date, length and goal.
- Courses live in an editable `courses.json`:
```json
[
  { "id": "math135", "name": "MATH 135" },
  { "id": "math137", "name": "MATH 137" },
  { "id": "cs135", "name": "CS 135" },
  { "id": "comm101", "name": "COMM 101" },
  { "id": "commst100", "name": "COMMST 100" }
]
```

## 6. Stage 3 — End-of-session summary and quiz
When I end a session:
1. **Summary:** a short list of what I covered, in order, based only on the session text. Show how long I studied.
2. **Quiz:** 5–8 questions on this session's material. Mix multiple choice and short answer. Each question links to the chunk it came from.
3. I answer in the popup. Multiple choice is checked directly. Short answers are checked by the AI against the source chunk, with a brief explanation when I'm wrong.
4. Save the score and each question's result.
5. If the session text is too thin or garbled to make good questions, say so instead of inventing questions.

**Math renders with KaTeX. Code shows in code blocks.**

**Done when:** after a real 30-minute session, the summary matches what I studied and the quiz questions are answerable from that material.

## 7. Stage 4 — Circle and ask
**Trigger.** During a session I press **Option+A** to start. A transparent overlay appears and draws the path my cursor makes, so I can circle what I'm asking about; the microphone listens (step 2), with a clear "listening" indicator. Pressing **Option+A again, or clicking**, finishes and sends. **Esc** cancels.
- Only works while a session is running, and respects the never-record list.
- The shortcut is configurable (`settings.json`). No keyboard monitoring: the app never needs Input Monitoring permission.

**What's sent.** Crop the screenshot to the bounding box of the path I circled, with a little padding. If I didn't circle anything, crop about 900×700 points around the cursor (configurable).

**Voice.** My speech becomes text with macOS's built-in **on-device** speech recognition, through the existing Swift helper. No new model downloads. The microphone is on only between the two presses.

**Popup** near the cursor with:
- the recognised question — editable, and I can type instead of speaking;
- a thumbnail of exactly what was sent;
- the answer streaming in, with math in KaTeX.

Send the cropped image, the question, the course and the most relevant text from this session to a **vision-capable model**.
- **Hint ladder buttons:** Nudge → Explain the concept → Worked example of a similar problem. Tutor rules (section 9) apply.
- Questions I ask are saved to the session, and their topics are more likely to appear in the quiz.

**Performance.** Load the model only when I ask something and unload it after a few minutes idle. Never have two models loaded at once.

**Permissions** (walk me through each when first needed): Microphone and Speech Recognition (voice).

**Build in two steps, and stop after each for testing:**
1. Option+A, circle, typed question, answer.
2. Add voice.

## 8. Stage 5 — Memory and adaptive learning
> Inspired by YC's "The Primer" request: a tutor that learns how *I* learn. The loop: know what I've
> covered → know what I've mastered and what helps me → teach to that → notice when I'm confused and
> try a different approach → track mastery over time.

### 5a. Memory across sessions
- Create an **embedding** for each chunk with a small local embedding model, so the app can search past sessions by meaning.
- When I ask a question, also search earlier sessions of the same course, and list **Sources** under the answer (session date and window title).
- Apply the "only what's been covered" rule using this course memory, not just today's session.

### 5b. Learner model (the core)
- The app tracks **concepts**, not just sessions (e.g. "strong induction", "limit of a recursive sequence"). At the end of each session the AI names the concepts the session covered and links them to their passages; near-duplicate names are merged (by embedding).
- For each concept it keeps:
  - **Mastery** (0–100%): goes up with correct quiz answers and questions I resolve at a low hint level; goes down with wrong answers and needing a worked example; **fades over time** if not practised (forgetting).
  - **Confidence**: how much evidence there is (one quiz answer ≠ five).
  - **What helps me**: which hint level and which kind of explanation (nudge / concept / worked example) led to me getting it right afterwards.
- The same "what helps me" is also kept **overall**, so a new concept starts from my usual style.
- Mastery is ordinary, explainable code (not the AI's opinion), so it's consistent and I can see why it changed.
- **"How you learn" page** (in History): concepts per course with mastery, confidence, what helps, and the evidence behind each. I can **correct it** ("I know this", "I don't") and **delete** any of it.

### 5c. Adaptive teaching
- **Answers:** when I ask about a concept I've struggled with, start at the help level that worked for me before. If I ask again about the same thing, **switch approach** (e.g. from explanation to worked example) instead of repeating it.
- **Quizzes:** aim questions at my weakest concepts in today's material; questions get harder as I get them right and easier when I don't. Still only from material I've covered.
- **Warm-up:** when I start a session, offer up to 3 questions on the concepts I'm most likely to have forgotten in that course (lowest faded mastery), including ones I got wrong before.
- **Spaced review:** a wrong answer comes back next session; a right answer after 3 days, then 7, then 14 — adjusted by the concept's mastery.
- **Connections:** when today's material builds on an earlier concept I'm weak on, say so ("this uses strong induction from Sept 28, which you missed twice") and link to it.

### 5d. Noticing confusion
- Signals during a session: coming back to the same passage several times, asking about the same concept repeatedly, or staying a long time on one part without progress.
- When it notices, it **offers** help quietly (a small notification: "Stuck on strong induction? Option+A to ask") — it never interrupts on its own, and I can turn this off.

### Privacy
- The learner model is personal data: it stays on my Mac, I can see all of it, correct it, and delete it (per concept, per course, or all).

### Build order (stop after each for testing)
5a → 5b → 5c → 5d.

**Done when:** after a week of real sessions, the "How you learn" page matches how I think I'm doing in each course, the quiz targets my weak spots, and when I ask about something I struggled with before, the first answer is pitched at the right level.

## 9. Tutor rules (use in every AI prompt)
- Use **only** the provided course material to explain. If the question needs something that isn't there, say "This may not have been covered in your course yet," and ask if I want a general explanation anyway.
- For CS 135: only use language features and patterns that appear in the material. Don't invent names or approaches the course hasn't taught.
- **Never write a complete answer to a graded assignment or quiz question.** Give a hint, explain the concept, or work through a *different, similar* example.
- Default to the smallest helpful hint. Go further only when I ask.
- For math: show algebra **one step per line**, and write division as **stacked fractions** (rendered with KaTeX), not inline like 5/4.
- If the material doesn't contain the answer, or the captured text is unclear, say so. Never make things up.

## 10. Stage 6 — Privacy controls and polish
- **Never-record list:** password managers, banking sites, private/incognito windows, Messages. Checked before every capture.
- **Redaction filter** before anything is stored or sent to any AI: card-like numbers, long digit strings, text near words like "password" or "SIN".
- **Screenshots are deleted right after text is read.** Only text is kept.
- **Delete controls:** delete a session, or everything for a course.
- **Cloud model off by default.** If turned on, each answer shows a "sent to cloud" label.
- Settings window: courses, hotkeys, capture interval, crop size, models, never-record list.
- Clear messages if Ollama isn't running or a permission is missing.

### Rules for me (show in the README and Settings)
- Never start a session during a test, quiz or exam.
- Check each course's rules about AI tools and follow them.

---

## 11. Tech stack
- **Electron + TypeScript.** Main process: tray, hotkeys, capture loop, database, AI calls. Renderer: popup and history UI.
- **UI:** React + Tailwind CSS, KaTeX for math. Clean and minimal, light and dark mode.
- **Text recognition:** macOS Vision framework (see Stage 1).
- **Speech recognition (Stage 4 only):** macOS's on-device speech recognition (Speech framework) in the Swift helper.
- **Database:** SQLite (e.g. `better-sqlite3`) in the app's user-data folder. Embeddings stored with chunks, with a simple in-app similarity search. Ask me before adding a separate vector database.
- **AI:** one module, `lib/ai.ts`, with `summarizeSession()`, `makeQuiz()`, `checkAnswer()`, `askAboutImage()` and `embed()`.
  - Default: **Ollama**. Prefer one small multimodal model for text and images plus one small embedding model, so it all fits comfortably in 16 GB alongside my other apps. Check Ollama's library for current options and tell me what you chose and why.
  - Optional: a cloud provider chosen in Settings, key in the macOS Keychain or `.env` (never committed).
- **Version control:** git from the first commit.

---

## 12. Data shapes (starting point — refine as needed)
```ts
type Course = { id: string; name: string };

type Session = {
  id: string;
  courseId: string;
  goal?: string;
  startedAt: string;
  endedAt?: string;
  summary?: string;
  quizScore?: { correct: number; total: number };
};

type Chunk = {
  id: string;
  sessionId: string;
  courseId: string;
  text: string;
  sourceApp: string;
  sourceTitle: string;
  capturedAt: string;
  embedding?: number[];
};

type Concept = {
  id: string;
  courseId: string;
  name: string;                // e.g. "strong induction"
  embedding?: number[];
  mastery: number;             // 0–1, before fading
  lastPracticedAt?: string;    // fading is computed from this
  evidence: { at: string; kind: "quiz" | "ask" | "review" | "manual"; correct?: boolean; hintLevel?: string; chunkId?: string }[];
  helps: { nudge: number; explain: number; example: number }; // what led to getting it right
  userOverride?: "known" | "unknown";
};

type QuizItem = {
  id: string;
  courseId: string;
  sessionId: string;
  chunkId: string;
  question: string;
  type: "multiple_choice" | "short_answer";
  options?: string[];
  answer: string;
  nextDueAt?: string;
  intervalDays?: number;      // 1, 3, 7, 14
  history: { at: string; correct: boolean }[];
};
```

---

## 13. Out of scope (for now)
- Recording outside of sessions
- Audio or lecture transcription
- Spoken answers, and voice input anywhere except asking a question (Stage 4)
- Anyone else using it, accounts, syncing
- Windows support

---

## 14. How to work with me (instructions for Claude Code)
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
- Put these rules in a `CLAUDE.md` file at the start, and keep a short "Where we left off" note at the bottom of it.
- Start with **Stage 1**.

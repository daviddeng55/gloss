# How fast is Gloss's AI? (2026-10-23)

Measured with `node scripts/bench-ai.ts <copy of gloss.db> [--cloud]` on this Mac (Apple M5, 16 GB), through the
same code the app uses. Raw numbers: `research/speed/*.json`.

- **Summary**: the MATH 135 session of Oct 4 (15 passages, 9,286 characters); "warm" is a second session
  (14 passages) right after, so Ollama can't reuse its cached prompt.
- **Ask**: a circled crop of a made-up squeeze-theorem example (`scripts/bench-crop.jpg`), as a new question:
  find the concept and related notes (embedding), then answer word by word.
- **Load**: time spent loading local models into memory. **First word**: from pressing Ask (or the summary
  starting) to the first piece of the answer. **Total**: until the answer is complete.
- "Cold" = no model in memory (first use, or more than 3 minutes since the last).

## Before: qwen3.5:4b on Ollama

| | Load | First word | Total |
|---|---|---|---|
| Summary, cold | 3.6 s | 25.4 s | 56.6 s |
| Summary, warm | 0 | 11.9 s | 37.7 s |
| Ask, cold | 3.6 s | 15.4 s | 20.1 s |
| Ask, warm | 3.1 s | 15.1 s | 20.3 s |
| Ask, warm (2nd question) | 3.3 s | 15.3 s | 26.6 s |

Asking always paid ~3–4 s of loading, even with qwen already in memory: finding related notes loads the
embedding model, which unloaded qwen ("one model at a time"), so qwen had to load again before answering.
(Summaries show nothing until they're done, so their "first word" was invisible to you.)

## After, local (no key): same model, embedding model kept loaded

| | Load | First word | Total |
|---|---|---|---|
| Summary, cold | 4.1 s | 22.7 s | 48.2 s |
| Summary, warm | 0 | 11.4 s | 33.4 s |
| Ask, cold | 3.6 s | 15.9 s | 20.3 s |
| Ask, warm | **0** | **7.5 s** | **13.6 s** |
| Ask, warm (2nd question) | **0** | **8.4 s** | 19.0 s |

- The small embedding model (0.6 GB) now stays loaded next to qwen, and a question is embedded once, not twice:
  a warm question's first word comes ~7 s sooner.
- In the app, pressing ⌥A also starts loading qwen while you circle, which hides most of the cold 3.6 s load.
- Summary points now appear one by one as they're written (the first after ~12–25 s instead of all at ~40–55 s).
- Summary differences (±5 s) are run-to-run noise: the model work is the same.

## After, fast mode (Gemini, `gemini-3.5-flash-lite`)

| | Load | First word | Total |
|---|---|---|---|
| Summary, cold | 0 | **1.0 s** | **1.8 s** |
| Summary, warm | 0 | 1.6 s | 2.5 s |
| Ask, cold | 0 ¹ | **1.6 s** | **1.7 s** |
| Ask, warm | 0 | 1.2 s | 1.5 s |
| Ask, warm (2nd question) | 0 | 1.0 s | 4.4 s |

¹ 0.8 s of the cold ask is the embedding model loading on the Mac (finding related notes stays local).
One run each over home Wi-Fi, so expect ±1 s. A spot check of the answer (the squeeze-theorem crop, "why does
dividing by n keep the inequality the same?") was a correct, short nudge that used the picture.

**Bug found by the first fast-mode run, fixed:** one summary request never finished: Gemini's stream stayed
open until Gloss's 2-minute limit, and only then fell back to the local model (183 s in all). It didn't happen
again in 3 retries. Gloss now stops reading as soon as Gemini marks the answer finished, gives up after 15 s of
silence mid-answer (20 s before the first word), caps replies at 8,192 tokens / 60,000 characters, and the
overall limit is 90 s, so a stuck cloud call falls back within seconds instead of minutes.

## Side by side (first word / total)

| | Before (local) | After, local | After, fast mode |
|---|---|---|---|
| Summary, cold | 25.4 s / 56.6 s | 22.7 s / 48.2 s | **1.0 s / 1.8 s** |
| Summary, warm | 11.9 s / 37.7 s | 11.4 s / 33.4 s | **1.6 s / 2.5 s** |
| Ask, cold | 15.4 s / 20.1 s | 15.9 s / 20.3 s | **1.6 s / 1.7 s** |
| Ask, warm | 15.1 s / 20.3 s | 7.5 s / 13.6 s | **1.2 s / 1.5 s** |
| Ask, warm (2nd) | 15.3 s / 26.6 s | 8.4 s / 19.0 s | **1.0 s / 4.4 s** |

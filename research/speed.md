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

## After, fast mode (Gemini)

To be measured once a key is saved in Settings → Fast mode.

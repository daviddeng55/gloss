# Where should Gloss's AI run? (research, 2026-10-15)

Gloss uses a model for summaries, quizzes, marking, notes, circle-and-ask (with an image), math reading (OCR),
embeddings and now Study Buddy. Today everything runs locally through **Ollama** (qwen3.5:4b, glm-ocr,
embeddinggemma). Since today's change, every call goes through one `ModelProvider` interface
(`src/core/provider.ts`), so another provider can be added without touching the features.

This note compares three options for a *normal student* (not a developer): setup friction, quality, privacy, cost.
No app code was changed for this research.

## What I checked on this Mac

| Check | Result |
|---|---|
| Mac | Apple M5, 16 GB, macOS 26.6.2 |
| `FoundationModels.framework` | Present (system + Command Line Tools SDK) |
| `SystemLanguageModel.default.availability` | **available** (Apple Intelligence is on) |
| `contextSize` | **4,096 tokens** (input and output share it) |
| Speed | 0.5–1.7 s per short reply (first call 2.7 s, model warm-up) |
| `@Generable` structs (Swift macros) | **Don't build with Command Line Tools only**: the macro plugin ships with full Xcode |
| Runtime schema (`DynamicGenerationSchema`) | **Works** without Xcode: JSON-shaped replies with an enum field |

Small quality samples (a handful of calls, so treat as anecdotes, not a benchmark), on a strong-induction passage:

- *Buddy question*, plain prompt: "Can you explain the main idea of strong induction in your own words?" (3/3
  times, nearly identical). Fine but bland. A first, looser prompt just repeated the passage instead of asking.
- *Judging an explanation*, plain prompt asking for JSON: rated **"because it's true" as solid** (too lenient).
- *Judging with a runtime schema* and a stricter field description: **3/3 right** — "because it's true" → gap
  (with a sensible follow-up), "dunno" → gap, a real explanation → solid.

I did **not** compare against qwen3.5:4b today (Ollama was busy with your notes backfill and was off-limits).

## Option A — Apple's on-device model (Foundation Models framework)

- **Setup for a student:** nothing to install *if* they have an Apple-silicon Mac (M1 or newer) on macOS 26
  with Apple Intelligence turned on (it downloads the model itself; ~7 GB of disk per third-party guides).
  Intel Macs, older macOS, or Apple Intelligence off → not available; the app must fall back.
- **How Gloss would call it:** a small Swift helper, like `bin/vision-helper` (built with the Command Line
  Tools, JSON lines over stdin/stdout). Use `DynamicGenerationSchema` for structured replies (no Xcode needed).
- **Quality:** ~3B-parameter model. Good enough for short, focused jobs (Study Buddy questions and judging,
  tagging a question with a concept, marking a short answer against one passage). Apple's own guidance and
  third-party write-ups say it's not meant for math reasoning or code, and the **4,096-token window** means
  a whole session can't go in one prompt: summaries/quizzes/notes would need to be done in pieces and merged.
  As far as I could verify, it's **text only** here: circle-and-ask (image in) and math OCR would still need
  Apple Vision + glm-ocr, or another model.
- **Privacy:** on the Mac; nothing leaves it (same as Ollama).
- **Cost:** free. Faster and cooler than Ollama on a fanless laptop (Apple's model is optimised for the
  Neural Engine; replies here came back in about a second).

## Option B — A cloud model such as Gemini

Two ways to do it:

1. **The student's own API key** (Google AI Studio; no credit card for the free tier).
   - **Setup:** sign in to Google, create a key, paste it into Settings. Doable for most students, but it's
     the kind of step people get stuck on, and the key must be stored safely (macOS Keychain, never in a file).
   - **Free tier caveats (from Google's pricing page and terms):** content sent on the free tier **is used to
     improve Google's products** (paid tier: not used). Users must be **18+**, and in the **EEA, Switzerland
     and the UK only paid use is allowed** for apps offered to users there. Free-tier rate limits are per
     project and can change.
   - **Cost on a paid key** (per 1M tokens, input / output, Google's page today): Gemini 2.5 Flash-Lite
     $0.10 / $0.40; 2.5 Flash $0.30 / $2.50; 3.6 / 3.8 Flash $0.75 / $3.75 until 31 Dec 2026, then
     $1.50 / $7.50. Rough estimate for Gloss: a session's summary + quiz + checking + notes ≈ 30k tokens in,
     5k out → **about $0.005 per session with Flash-Lite, ~$0.04 with 3.x Flash**; a Study Buddy chat is
     a fraction of a cent. A heavy term (60 sessions) ≈ $0.30–$2.50.
2. **A hosted backend** (Gloss's own server holds the key; students just sign in).
   - **Setup for the student:** easiest of all (an account, nothing else).
   - **For you:** you'd run and pay for a server, accounts, abuse limits and billing; you'd be responsible for
     everyone's screen text passing through your server (a much bigger privacy and legal job, including the
     18+ rule above). Not a good fit for a solo learning project or for "no money spent".
- **Quality:** clearly the best of the three, including images (circle-and-ask) and math, with long context
  (a whole session in one prompt).
- **Privacy:** screen text (and, for asking, a cropped screenshot) leaves the Mac. Gloss's redaction and
  never-record rules help, but the promise "nothing leaves your Mac" would no longer hold in this mode.

## Option C — Keep Ollama, as an optional mode

- **Setup:** install the Ollama app, then download ~5 GB of models (qwen3.5:4b, glm-ocr, embeddinggemma) from
  a terminal or a Gloss button. The hardest path for a normal student, and a 16 GB fanless laptop runs warm
  (~16 tokens/s; the backfill of notes takes ~1–1.5 h).
- **Quality:** known and tuned: every prompt in Gloss was written and tested against these models; glm-ocr is
  what finally fixed math reading; embeddinggemma powers search by meaning. Still a small model (some wrong
  quiz answers slip through, garbled captures confuse it).
- **Privacy:** fully local. **Cost:** free.

## Side by side

| | Apple on-device | Gemini, own key | Gemini, hosted | Ollama |
|---|---|---|---|---|
| Student setup | none (if Apple Intelligence is on) | key + paste | sign in | install app + 5 GB downloads |
| Works on | M1+ Macs, macOS 26 | any Mac, online | any Mac, online | any Mac with ~16 GB RAM |
| Quality | OK for short tasks; 4k context; text only | best (long context, images) | best | tuned, small model |
| Privacy | stays on Mac | leaves Mac (free tier: used for training) | leaves Mac, via your server | stays on Mac |
| Cost | free | free tier, or ~cents per term | you pay for everyone | free |
| Speed (this Mac) | ~1 s short replies | network + ~1–3 s | same | ~16 tokens/s, warm laptop |

## Recommendation

**Default: Apple's on-device model where it's available, with Ollama as an optional "full quality, fully
local" mode, and a bring-your-own-key cloud mode as an explicit opt-in.**

- Use Apple's model by default for the **short, interactive jobs** it handles well and fast: Study Buddy
  (question + judging, with a runtime schema), concept tagging, marking short answers against one passage,
  and text-only follow-ups. This removes the biggest setup hurdle for a new student and keeps "nothing leaves
  your Mac".
- Keep **Ollama** for what Apple's model can't do here: math OCR (glm-ocr), image questions, embeddings, and
  long-context work (summaries, quizzes, notes) — and as the "best local quality" choice in Settings.
- Offer **Gemini with the student's own key** only as an opt-in "cloud mode", with a plain warning that screen
  text leaves the Mac, and a recommendation to use a paid key (free-tier data is used for training; 18+; not
  allowed free in the EEA/UK). Store the key in the Keychain. Skip a hosted backend.
- **Before switching any default:** run a small bake-off on real sessions (Apple vs qwen3.5:4b) for buddy
  judging and short-answer marking — 20–30 real answers each, counting wrong verdicts. Today's samples were too
  few to decide, and the plain-prompt judge was too lenient.

Next code step (when you want it): an `AppleProvider` (Swift helper + `ModelProvider` in TypeScript) used for
Study Buddy first, falling back to Ollama when `availability` isn't `.available`.

## Sources

- [Gemini API pricing (Google)](https://ai.google.dev/gemini-api/docs/pricing) — prices; free-tier content "used to improve our products"
- [Gemini API Additional Terms of Service (Google)](https://ai.google.dev/gemini-api/terms) — 18+, paid-only in EEA/Switzerland/UK
- [TN3193: Managing the on-device foundation model's context window (Apple)](https://developer.apple.com/tutorials/data/documentation/technotes/tn3193-managing-the-on-device-foundation-model-s-context-window.md) — 4,096 tokens
- [Apple Foundation Models context (InfoQ)](https://infoq.com/news/2026/03/apple-foundation-models-context) — `contextSize`, `tokenCount(for:)`
- [Introduction to Apple's FoundationModels (Natasha the Robot)](https://www.natashatherobot.com/p/apple-foundation-models) — ~3B model; not for math/code
- [Foundation models in the simulator (Apple Developer Forums)](https://developer.apple.com/forums/thread/815397) — Apple Intelligence must be on; model downloads
- [Apple Intelligence compatibility guide (macos-tahoe.com)](https://macos-tahoe.com/blog/apple-intelligence-compatibility-guide/) — M1+, macOS 26, ~7 GB (third-party)
- [Gemini API free plan 2026 (CostBench)](https://www.costbench.com/software/llm-api-providers/google-gemini-api/free-plan/) — free tier without a card (third-party)
- Local measurements: Swift checks in this session's scratchpad (not kept in the repo).

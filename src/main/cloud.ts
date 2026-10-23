// Fast mode: Gemini answers instead of the local model when the student has saved an API key (Settings →
// Keychain) and left fast mode on. ai.ts does the routing and falls back to Ollama; this service owns the
// key and says which content may be sent (privacy rules in core/cloud.ts).
import { cloudStatus, setCloud } from "../core/ai.ts";
import { allFromStudyApps } from "../core/cloud.ts";
import { deleteApiKey, looksLikeApiKey, readApiKey, saveApiKey } from "../core/keychain.ts";
import { GeminiProvider } from "../core/provider.ts";
import type { Settings } from "../core/settings.ts";
import type { CloudView } from "../shared/types.ts";

export class CloudService {
  private settings: () => Settings;
  private key: string | null = null; // in memory only; the saved copy is in the Keychain

  constructor(settings: () => Settings) {
    this.settings = settings;
  }

  /** Reads the saved key (if any) and turns fast mode on or off to match Settings. */
  async start() {
    // The pretend AI used by development checks never talks to the cloud.
    this.key = process.env.GLOSS_AI === "mock" ? null : await readApiKey();
    this.apply();
  }

  /** After Settings change: same key, maybe another model or fast mode switched off. */
  apply() {
    const c = this.settings().cloud;
    setCloud(this.key && c.enabled ? { provider: new GeminiProvider(this.key), model: c.model } : null);
  }

  /** Fast mode is on and text read in all of these apps may go to the cloud. */
  allows(apps: string[]): boolean {
    return cloudStatus().on && allFromStudyApps(apps, this.settings().cloud.studyApps);
  }

  view(): CloudView {
    const st = cloudStatus();
    return { hasKey: !!this.key, active: st.on, problem: st.problem, pausedForSeconds: Math.ceil(st.pausedForMs / 1000) };
  }

  /** Checks the key with a tiny request, then saves it in the Keychain. */
  async saveKey(key: string): Promise<{ ok: boolean; message: string }> {
    const k = key.trim();
    if (!looksLikeApiKey(k)) return { ok: false, message: "That doesn't look like a Gemini API key (it's a long code of letters and digits)." };
    const test = await this.check(new GeminiProvider(k));
    if (!test.ok) return test;
    try {
      await saveApiKey(k);
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
    this.key = k;
    this.apply();
    return { ok: true, message: `Key saved in your Keychain. ${test.message}` };
  }

  async removeKey(): Promise<void> {
    await deleteApiKey();
    this.key = null;
    this.apply();
  }

  /** Tries the saved key now. */
  async test(): Promise<{ ok: boolean; message: string }> {
    if (!this.key) return { ok: false, message: "No API key saved." };
    const r = await this.check(new GeminiProvider(this.key));
    if (r.ok) this.apply(); // clears an earlier problem
    return r;
  }

  private async check(p: GeminiProvider): Promise<{ ok: boolean; message: string }> {
    const model = this.settings().cloud.model;
    const t = performance.now();
    try {
      await p.chat({ model, messages: [{ role: "user", content: 'Reply with the single word "ready".' }], maxTokens: 20, timeoutMs: 20_000 });
      return { ok: true, message: `${model} answered in ${((performance.now() - t) / 1000).toFixed(1)} s.` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }
}

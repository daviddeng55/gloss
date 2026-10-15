// "Meet your Study Buddy" (route #/buddy-pick): shown once, the first time Gloss starts with Study Buddy.
import { useEffect, useState } from "react";
import type { BuddyCharacterId } from "../../shared/types.ts";
import { BuddyChooser } from "./Buddy.tsx";

export default function BuddyPick() {
  const [choice, setChoice] = useState<{ character: BuddyCharacterId | ""; name: string }>({ character: "", name: "" });

  useEffect(() => {
    void window.api.getBuddySettings().then((b) => setChoice({ character: b.character, name: b.name }));
  }, []);

  return (
    <div className="flex h-screen flex-col text-[14px] text-ink">
      <div className="drag h-10 shrink-0" />
      <div className="appear flex-1 px-10">
        <p className="eyebrow">New in Gloss</p>
        <h1 className="mt-1 font-serif text-[30px] leading-tight font-semibold tracking-tight">Meet your Study Buddy</h1>
        <p className="mt-2 max-w-xl font-serif text-[16px] leading-relaxed text-muted">
          When you finish something, your buddy pops up in the corner and asks you to explain it, like a curious classmate. Saying it in your
          own words is one of the best ways to check you really get it. No grades, ever.
        </p>
        <div className="mt-6">
          <BuddyChooser character={choice.character} name={choice.name} onChange={setChoice} />
        </div>
        <p className="mt-4 text-[12px] leading-relaxed text-muted">
          At most once every 15 minutes, never while you're reading, typing or asking. Answer by typing or by voice. Change all this in Settings.
        </p>
      </div>
      <div className="flex items-center justify-between border-t border-line px-10 py-4">
        <span className="flex gap-1">
          <button onClick={() => void window.api.chooseBuddy("off")} className="btn-ghost">
            No buddy, thanks
          </button>
          <button onClick={() => void window.api.chooseBuddy("later")} className="btn-ghost">
            Ask me later
          </button>
        </span>
        <button
          onClick={() => choice.character && void window.api.chooseBuddy({ character: choice.character, name: choice.name })}
          disabled={!choice.character}
          className="btn-primary px-6"
        >
          Choose {choice.character ? choice.name.trim() || "this buddy" : "a buddy"}
        </button>
      </div>
    </div>
  );
}

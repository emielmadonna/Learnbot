import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pageSource = readFileSync(
  new URL("../src/app/dev/chat/page.tsx", import.meta.url),
  "utf8",
);
const styleSource = readFileSync(
  new URL("../src/app/dev/chat/page.module.css", import.meta.url),
  "utf8",
);

function presentationEffectSource() {
  const start = pageSource.indexOf(
    "useEffect(() => {\n    clearVoicePresentationSchedule();",
  );
  assert.notEqual(start, -1, "voice presentation effect must exist");
  const end = pageSource.indexOf("\n\n  useEffect(() => {", start + 1);
  assert.notEqual(end, -1, "voice presentation effect must have a boundary");
  return pageSource.slice(start, end);
}

test("presentation follows active voice, not connecting/listening phase churn", () => {
  const effect = presentationEffectSource();

  assert.match(effect, /\}, \[voiceActive\]\);/);
  assert.doesNotMatch(effect, /\}, \[voicePhase\]\);/);
  assert.match(effect, /scheduleVoiceFrame\(\(\) => \{\s+scheduleVoiceFrame/);
  assert.doesNotMatch(
    effect,
    /setTimeout\([\s\S]*setVoicePresentation\("voice"\)/,
  );
});

test("rapid reversals cancel stale frames and only finish a valid off-state exit", () => {
  assert.match(pageSource, /voiceTransitionFramesRef = useRef<Set<number>>/);
  assert.match(
    pageSource,
    /voiceTransitionFramesRef\.current\.forEach\(\(frame\) =>\s+window\.cancelAnimationFrame\(frame\)/,
  );
  assert.match(
    pageSource,
    /voicePresentationRef\.current !== "exiting" \|\|\s+voicePhaseRef\.current !== "off"/,
  );
  assert.match(
    pageSource,
    /event\.propertyName === "clip-path"[\s\S]*completeVoiceExit\(\)/,
  );
});

test("the composer remains mounted behind a shared-origin voice overlay", () => {
  assert.match(pageSource, /ref=\{companionRef\}/);
  assert.match(pageSource, /ref=\{voiceTriggerRef\}/);
  assert.match(pageSource, /function captureVoiceOrigin\(\)/);
  assert.match(pageSource, /className=\{styles\.textExperience\}/);
  assert.match(pageSource, /aria-hidden=\{voiceVisible \? true : undefined\}/);
  assert.match(pageSource, /inert=\{voiceVisible \? true : undefined\}/);

  assert.match(
    styleSource,
    /clip-path: circle\(150% at var\(--voice-origin-x\) var\(--voice-origin-y\)\)/,
  );
  assert.match(
    styleSource,
    /\.voiceActiveFrame \{\s+grid-template-rows: 0 minmax\(0, 1fr\);/,
  );
  assert.match(
    styleSource,
    /grid-template-rows 360ms cubic-bezier\(0\.22, 1, 0\.36, 1\)/,
  );
  assert.match(
    styleSource,
    /\.voiceExperience\[data-transition="exiting"\][\s\S]*clip-path: circle\(24px at var\(--voice-origin-x\) var\(--voice-origin-y\)\)/,
  );
});

test("reduced motion bypasses presentation delay and disables visual motion", () => {
  const effect = presentationEffectSource();

  assert.match(
    pageSource,
    /matchMedia\?\.\("\(prefers-reduced-motion: reduce\)"\)/,
  );
  assert.match(
    effect,
    /if \(userPrefersReducedMotion\(\)\) \{\s+voicePresentationRef\.current = "voice";/,
  );
  assert.match(
    effect,
    /if \(userPrefersReducedMotion\(\)\) \{\s+completeVoiceExit\(\);/,
  );
  assert.match(
    styleSource,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.voiceExperience[\s\S]*animation: none !important;[\s\S]*transition: none !important;/,
  );
});

test("interruption and text restoration have visible and assistive feedback", () => {
  assert.match(
    pageSource,
    /setVoiceCaption\("Go ahead — I stopped speaking and I’m listening\."\)/,
  );
  assert.match(pageSource, /data-interrupted=\{wasInterrupted \? "true"/);
  assert.match(
    styleSource,
    /\.voiceExperience\[data-interrupted="true"\] \.orbStage::after/,
  );
  assert.match(
    pageSource,
    /voicePresentation !== "text"[\s\S]*focusTextAfterVoiceRef\.current[\s\S]*messageInputRef\.current\?\.focus\(\{ preventScroll: true \}\)/,
  );
});

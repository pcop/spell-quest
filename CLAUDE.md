# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

拼字冒險王 — a pure front-end HTML5 spelling game for preschool/early-elementary kids learning English. No backend, no accounts, no build tools. `app.js` is a single IIFE using native DOM APIs; `three-fx.js` is the only external dependency (three.js ES module loaded from a jsdelivr CDN via the `importmap` in `index.html`).

## Running it

Must be served over HTTP — `data.json` is loaded via `fetch`, which fails under `file://`. Opening `index.html` directly will not work.

```bash
python3 -m http.server 8000
# or: npx serve
```

Then open `http://localhost:8000`.

There is no build/lint/test tooling. The only verification done so far is `node --check app.js` (syntax) and manual consistency checks that `syllables`/`phonics.chunks` arrays concatenate back to the original word for all entries. **There is no automated test suite** — changes to gameplay, audio, or 3D effects need to be manually verified in an actual browser (see "已知待驗證項目" in README.md for the current list of unverified behaviors).

## File structure

- `index.html` — view skeleton (`<section id="view-*">` containers for each screen: loading, load-error, splash, theme-select, level-select, game, result, progress, flashcards, blend), plus the three.js importmap.
- `styles.css` — color system, animations, responsive/touch styles.
- `data.json` — the entire word bank + theme list + difficulty tier rules (see "Content model" below).
- `app.js` — all game logic: data loading, view switching, question generation, scoring, speech, progress persistence, phonics breakdown, blend-practice mode. Single IIFE, organized into clearly commented sections (`// ---------- Section ----------`) — grep those to navigate rather than reading top to bottom.
- `three-fx.js` — 3D celebration layer (ES module). Exposes `window.ThreeFX` only if CDN load + WebGL init both succeed; otherwise the global is simply never set (no error thrown), and `app.js` gates on its presence.
- `phonics-audio/*.mp3` — pre-generated phoneme audio clips (filename = chunk text, e.g. `th.mp3`), produced by `tools/generate-phonics-audio.sh`.
- `tools/generate-phonics-audio.sh` — regenerates `phonics-audio/` via `espeak-ng` + `ffmpeg`. Re-run this whenever a new word introduces a phonics chunk not already in the script's `CHUNKS` table.

## Content model (editing words/themes)

All word content lives in `data.json`; no code changes needed to add words. Example entry:

```json
{ "id": "animal_cat", "word": "cat", "theme": "animals", "emoji": "🐱", "zh": "貓",
  "phonics": { "chunks": ["c", "a", "t"], "silent": [] } }
```

- `id`: unique, convention is `theme_word`.
- `word`: lowercase English word; **its length determines difficulty tier** (3 letters = tier 1 / 4 = tier 2 / 5+ = tier 3, per `difficultyTiers` in `data.json`) — unless the theme uses `customLevels` (see below), in which case tier assignment is explicit instead of length-derived.
- `theme`: must match a `themes[].id`.
- `emoji`: image hint. If no good emoji exists (e.g. colors), use `"emoji": null` with `"swatch": "#hexcolor"` instead.
- `zh` (required): Chinese gloss, shown under the image/swatch in the spelling-level prompt (image hint mode only, not audio-only mode) to disambiguate when the emoji alone is unclear — see `renderPrompt()` in `app.js`.
- `syllables` (optional): syllable split for multi-syllable words, e.g. `["ap", "ple"]` — concatenation must exactly equal `word`. Only needed for multi-syllable words; drives visual spacing/shading of answer slots (purely visual, doesn't affect scoring).
- `phonics` (required): natural-phonics letter-group breakdown, e.g. `{ "chunks": ["c","a","t"], "silent": [] }`. `chunks` concatenated must equal `word`; `silent` is a list of 0-indexed positions into `chunks` that are silent (e.g. silent e). Chunking rules: consonant digraphs (ch/sh/th/ck/wh/nk), vowel teams (ee/ea/oo/ow/ou/ay/ue/eigh/oa/aw), r-controlled vowels (ar/er/ir/or/ur/air/ear/our/oor), and doubled letters (ll/rr/pp) are each one chunk; consonant blends (br/pl/st, etc.) stay split into individual letters since they're two fast sounds, not one. A chunk's audio is looked up purely by its text, so identical spellings always get the same pronunciation even when the real pronunciation varies by word (documented known limitation — see `oo`, `ear`, and the new `y` case in README's 已知待驗證項目).
- **If a new word needs a phonics chunk that isn't among the current set**, add a row to the `CHUNKS` table in `tools/generate-phonics-audio.sh` and re-run it to generate the new `phonics-audio/<chunk>.mp3`. `phonics.chunks` being valid data does *not* mean the audio exists — that's a separate generation step.
- New themes go in the `themes` array as `{ id, name, icon, color }` — this auto-applies the shared length-based `difficultyTiers`.
- **`customLevels`** (optional, on a theme object): opts that theme out of length-based tiers entirely in favor of hand-picked, named levels — each `{ id, label, distractorCount, wordIds }`, where `wordIds` is an explicit list of `wordBank` ids (any length mix). See `getLevelDefsForTheme()` in `app.js`, the single place that resolves "what are this theme's levels" for both the standard and custom paths — everything else (`startLevel`, `renderLevelGrid`, `renderThemeGrid`, progress/collectibles tables, sticker popup) consumes its output rather than branching on tiers vs custom levels itself. A theme is one or the other, not both. The `id`/`tier` value is stored as an opaque string key in `progress.levels`/`progress.collectibles` (`themeId_tier`) — nothing treats it as a number.
- `app.js`'s `MIN_WORDS_PER_LEVEL` (currently 3) auto-disables any level (tiered or custom) with too few words — keep at least 3 words per level for it to be playable.

## Architecture notes

**Hint modes**: image (emoji/swatch) + pronunciation (browser `SpeechSynthesis`) + letter tiles, fillable via click, touch-drag (no HTML5 Drag-and-Drop API — chosen to keep touch devices working reliably), or keyboard. Players choose which hints are active on the level-select screen.

**Keyboard input** (`handleKeyboardLetter`/`handleKeyboardBackspace` in `app.js`) is a third parallel path into the same `placeLetterInSlot`/`removeLetterFromSlot` functions the click/drag paths use — not a separate state machine. A single `document`-level `keydown` listener (registered in `bindStaticEvents`) branches on which view is currently visible (`$('view-game').hidden` / `$('view-flashcards').hidden`) rather than on focus, so nothing needs to be focused for it to work. In the game view: a letter key fills the first empty slot with any unused tile of that letter (tiles are otherwise interchangeable); Backspace/Delete removes the last *filled* slot (highest index), a valid proxy for "last typed" only because slots always fill left-to-right; Space triggers `proceedFromCorrect()` when `gameState.awaitingNext` is true. In the flashcards view: ArrowLeft/ArrowRight call `.click()` on the existing prev/next buttons rather than duplicating their bounds-checking logic — disabled buttons don't dispatch click via `.click()`, so first/last-card boundaries are enforced for free.

**Answering correctly no longer auto-advances.** `handleCorrect()` sets `gameState.awaitingNext = true` and reveals `#btn-next-question` instead of scheduling a timeout; the question stays frozen (same `gameState.locked = true` that already blocked input during the old timeout window) until the player clicks that button or presses Space, both of which route through `proceedFromCorrect()` → `nextQuestionOrFinish()`. Wrong answers are unaffected — still auto-reset after 500ms via `resetSlotsKeepTiles`. `loadQuestion()` resets `awaitingNext` and re-hides the button for every new question.

**Two distinct phonetic datasets, don't conflate them**: `syllables` (syllable/beat grouping, drives visual slot spacing) vs `phonics.chunks` (letter-group-to-sound breakdown, drives the 🔤 phonics playback). A word can have one, both, or neither.

**Phonics & Words audio pipeline**: Uses pre-generated Microsoft Edge Neural Voice (`en-US-JennyNeural`) audio for all word pronunciations (`words-audio/*.mp3`) and 53 phonics chunks (`phonics-audio/*.mp3`). Both whole-word (`speakWord()`) and chunk breakdown (`speakPhonics()`) use `Audio` elements with dynamic preloading, `playbackRate` speed adjustment, and fallback to browser `SpeechSynthesis` if an audio asset fails to load.

**three.js is a hard requirement for the spelling levels only**, not a decorative enhancement — if the CDN is unreachable or WebGL is unsupported, the main menu's "Start Game" button is permanently disabled with an explanatory `title`. Flashcards, blend practice, and the progress page do not depend on it and remain fully usable regardless. Detection (`setupThreeFxDetection` in `app.js`) listens for `threefx-ready`/`threefx-error` events registered synchronously *before* `three-fx.js` (a `type="module"` script, which behaves like `defer`) can execute — registering the listener inside `DOMContentLoaded` was a previously-fixed race condition where the module script could fire its event before `DOMContentLoaded`, and listeners were never registering in time. Diagnostic: the progress page's "🔍 檢查 3D 特效狀態" only checks whether `window.ThreeFX` exists, not whether models actually render — treat visual confirmation, not the status text, as the source of truth.

Coordinate space in `three-fx.js` is an orthographic camera mapped directly to screen pixels — `PointsMaterial.sizeAttenuation` must stay `false` (it's designed for perspective cameras and would shrink particle sizes unexpectedly), and any size given to points/models must be multiplied by `renderer.getPixelRatio()` since sizes are in framebuffer pixels, not CSS pixels. Hand-built low-poly models (trophy/gift/chest) are sized in the 100–300 "pixel unit" range for this reason, not typical 1-unit 3D-tool scale.

Level completion shows a rotating trophy/gift-box 3D model by default; the *first* time a theme×tier combo reaches 3 stars, a one-time "open chest" animation plays instead and awards a sticker (tracked in `progress.collectibles`, keyed the same as `progress.levels` — `themeId_tier`). If the player navigates away before the chest-open animation finishes, `window.ThreeFX.cancelCelebration()` must be called to prevent the sticker popup callback from firing late on the next screen.

**Progress persistence**: `localStorage` key `spelling_game_progress_v1`, written after every answered question (survives reload). Stars only ever increase, never decrease. Shape:

```json
{
  "schemaVersion": 1,
  "settings": { "hintMode": "both", "soundEnabled": true, "speechRate": 0.8 },
  "levels": { "animals_1": { "themeId": "animals", "tier": 1, "attempts": 12, "correctCount": 10,
    "bestAccuracy": 0.92, "bestStars": 3, "completed": true, "wordProgress": { "animal_cat": { "correct": 3, "wrong": 0 } } } },
  "collectibles": { "animals_1": true }
}
```

Import/export (on the progress page) round-trips this whole object as JSON; import does basic shape validation and rejects malformed files rather than clobbering existing progress. Old progress files predating `collectibles` are backfilled with an empty object on load/import — no `schemaVersion` bump needed for that.

**Hint safety valve**: pressing 💡 auto-fills the next letter, usable once per question, and using it caps that question's star rating (to prevent it from being an "just show me the answer" button).

## Browser compatibility constraints

- High-quality neural speech audio works across all modern browsers and devices (served statically via `words-audio/` and `phonics-audio/`); if assets fail to load, falls back to native `SpeechSynthesis`.
- Mobile requires a first tap on "Start Game" to unlock audio/speech playback (browser autoplay policy) — this is `unlockAudio()` in `app.js`.
- 3D effects require `<script type="importmap">` support (Chrome/Edge 89+, Safari 16.4+, Firefox 108+) and WebGL.

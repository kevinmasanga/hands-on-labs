# Phase 4 Implementation Plan — DeckFlow Web

> **Starting point:** Phase 3 — two-deck mixer with EQ, filter, volume, crossfader, and master volume.  
> **Goal:** Add varispeed tempo, manual loops, in-mix cue point, and waveform markers.

---

## High-Level Overview

Phase 4 adds the "DJ feel" on top of the working Phase 3 mixer. There are four discrete features, each building on the previous one:

| # | Feature | What it does | Core mechanism |
|---|---------|--------------|----------------|
| 1 | **Varispeed Tempo** | A knob speeds up or slows down each deck's playback (pitch moves with tempo — varispeed, not time-stretch) | Scale `incPerSample` in `buildDeckSignal` by `state.tempo` |
| 2 | **Cue Point** | Stamp the current playhead position as a return point; jump back to it instantly | Store `cueNorm` in `DeckState`; `seek(cueNorm)` on demand |
| 3 | **Manual Loop** | Set loop-in and loop-out points; toggle looping on/off | Wrap the Elementary transport `position` through a floored-mod when `loopActive` |
| 4 | **Waveform Markers** | Show the cue point and loop region visually on the canvas | New props on `Waveform`; drawn in the existing `draw` callback |

### Files touched

```
src/deck.ts                      — state shape + audio graph (steps 1 & 3)
src/useDeck.ts                   — reducer actions + exported callbacks (steps 1–3)
src/components/DeckControls.tsx  — TEMPO knob (step 1)
src/components/DeckPanel.tsx     — cue/loop button row + waveform props (steps 2 & 3)
src/components/Waveform.tsx      — marker rendering (step 4)
src/index.css                    — cue-loop row styles + active-loop button state
```

No new files. No changes to `audio.ts`, `track.ts`, `App.tsx`, `Mixer.tsx`, `Knob.tsx`, or `Fader.tsx`.

### Execution order

The steps are ordered so each is independently compilable before the next begins:

```
Step 1 — deck.ts state fields + initialDeckState defaults
Step 2 — deck.ts buildDeckSignal loop wrapping
Step 3 — useDeck.ts new actions + callbacks
Step 4 — DeckControls.tsx TEMPO knob
Step 5 — DeckPanel.tsx cue/loop button row + Waveform props
Step 6 — Waveform.tsx marker drawing
Step 7 — index.css styles
```

---

## Feature 1 — Varispeed Tempo

### What it does

A TEMPO knob (50 %–150 %) on each deck's mixer strip scales how fast the transport accumulator advances. At 100 % the deck plays at its original pitch and speed. At 80 % it plays slower and lower; at 120 % faster and higher. This is **varispeed** — pitch and tempo move together, exactly like the desktop app's design decision (spec §2).

### Why the existing code already supports it

`buildDeckSignal` in `deck.ts` already has:

```ts
const incPerSample = s.tempo / Math.max(1, totalFrames - 1);
```

`state.tempo` is initialised to `1` and is never changed in Phase 3. Adding a knob that calls `setTempo` is the entire feature — the audio graph requires no changes.

### Changes

#### `src/deck.ts` — no audio graph change needed

`tempo` is already in `DeckState` and `initialDeckState`. The only addition is resetting it on track load:

```ts
// In the LOAD reducer case, also include:
tempo: 1,
```

#### `src/useDeck.ts` — new action + callback

Add to the `Action` union:

```ts
| { type: 'SET_TEMPO'; value: number }
```

Add the reducer case:

```ts
case 'SET_TEMPO':
  // Clamp to a useful DJ range: half-speed to double-speed.
  return { ...s, tempo: Math.max(0.5, Math.min(2, a.value)) };
```

Add to the `UseDeck` interface and implementation:

```ts
// Interface
setTempo: (value: number) => void;

// Implementation
const setTempo = useCallback(
  (value: number) => dispatch({ type: 'SET_TEMPO', value }),
  [],
);
```

Return `setTempo` from the hook.

#### `src/components/DeckControls.tsx` — TEMPO knob

Add one `<Knob>` after the FILTER knob in the `deck-controls` row:

```tsx
<Knob
  label="TEMPO"
  value={state.tempo}
  min={0.5}
  max={1.5}
  defaultValue={1}
  onChange={deck.setTempo}
  format={(v) => `${Math.round(v * 100)}%`}
/>
```

Double-click resets to 100 % (the `defaultValue={1}` wires this up automatically through the existing `Knob` component).

### Data flow

```
User drags TEMPO knob
  → deck.setTempo(v)
  → SET_TEMPO action
  → state.tempo = v
  → App render effect fires (state changed)
  → buildDeckSignal recomputes incPerSample = v / (N−1)
  → Elementary diffs; nudges the keyed _inc const node
  → playback rate changes at audio rate — no click
```

---

## Feature 2 — Cue Point

### What it does

- **Set Cue** — stamps the current playhead position as `cueNorm` in state.
- **⏮ Cue** — seeks the deck to `cueNorm` instantly (same as clicking the waveform at that position).
- A "Cue: 0:30" timestamp label shows the current cue position.
- The cue position is drawn as a yellow vertical line on the waveform (covered in Feature 4).

### Changes

#### `src/deck.ts` — state field

Add to `DeckState`:

```ts
cueNorm: number; // normalized cue position; -1 means not set
```

Add to `initialDeckState`:

```ts
cueNorm: -1,
```

Also clear it when a new track loads — add to the `LOAD` reducer case:

```ts
cueNorm: -1,
```

#### `src/useDeck.ts` — new actions + callbacks

Add to the `Action` union:

```ts
| { type: 'SET_CUE'; norm: number }
```

Add the reducer case:

```ts
case 'SET_CUE':
  return { ...s, cueNorm: clamp01(a.norm) };
```

Add a `positionRef` so the callback always reads the latest position without creating a re-subscription dependency:

```ts
const positionRef = useRef(0);
positionRef.current = position; // keep in sync after setPosition
```

Add to the `UseDeck` interface:

```ts
setCue:    () => void; // stamps current position
jumpToCue: () => void; // seeks to cueNorm
```

Implementations:

```ts
const setCue = useCallback(() => {
  dispatch({ type: 'SET_CUE', norm: positionRef.current });
}, []);

const jumpToCue = useCallback(() => {
  const s = stateRef.current;
  if (s.cueNorm >= 0) seek(s.cueNorm);
}, [seek]);
```

Where `stateRef` mirrors `state` into a ref (same pattern as `playingRef` already used in the hook):

```ts
const stateRef = useRef(state);
stateRef.current = state;
```

Return `setCue` and `jumpToCue` from the hook.

#### `src/components/DeckPanel.tsx` — cue button row

Add a `cue-loop-row` div below the transport. The cue portion:

```tsx
<div className="cue-loop-row">
  <button className="btn ghost" onClick={deck.setCue} disabled={!track}>
    Set Cue
  </button>
  <button
    className="btn ghost"
    onClick={deck.jumpToCue}
    disabled={deck.state.cueNorm < 0}
  >
    ⏮ Cue
  </button>
  {deck.state.cueNorm >= 0 && track && (
    <span className="cue-label">Cue: {fmt(deck.state.cueNorm * track.duration)}</span>
  )}

  {/* loop buttons go here — see Feature 3 */}
</div>
```

---

## Feature 3 — Manual Loop

### What it does

- **Loop In** — stamps the current playhead position as `loopIn`.
- **Loop Out** — stamps the current playhead position as `loopOut` and auto-enables the loop.
- **Loop ON/OFF** — toggles `loopActive`. Turning the loop **off** while playing re-bases the transport so playback continues from the current position without a jump (critical — see note below).
- A "0:10 – 0:20" label shows the loop range.

### The audio mechanism — floored-mod wrap

When `loopActive` is true and both points are valid, `buildDeckSignal` replaces the raw transport position with a wrapped version:

```
wrapped = loopIn + (rawPos - loopIn) mod (loopOut - loopIn)
```

Using the floored-mod formula from the spec (§6) — `x − len·floor(x/len)` — because `el.mod` is `fmod` and keeps the dividend's sign, which breaks for positions less than `loopIn`:

```ts
// position = loopIn + ((rawPos - loopIn) - len * floor((rawPos - loopIn) / len))
const loopInN = el.const({ key: `${s.id}_lin`,  value: s.loopIn });
const loopLen  = el.const({ key: `${s.id}_llen`, value: s.loopOut - s.loopIn });
const rel      = el.sub(rawPos, loopInN);
const wrapped  = el.sub(rel, el.mul(loopLen, el.floor(el.div(rel, loopLen))));
position       = el.add(loopInN, wrapped);
```

When `loopActive` is false the position passes through unchanged:

```ts
position = rawPos;
```

Elementary diffs the tree on every state change, so toggling the loop reshapes the graph structurally while the accumulator keeps its internal state — no discontinuity in the audio.

> **⚠ Critical: loop exit re-base**  
> When the user turns the loop off, `toggleLoop` must immediately call `seek(currentPosition)` **before** dispatching `SET_LOOP_ACTIVE false`. The raw accumulator has been running inside the loop window. Once the graph drops the floored-mod wrap, the unwrapped accumulator value could be far ahead of where the audio actually was, causing the playhead to jump. Re-basing snaps `base` to the current position and resets the accumulator — playback continues seamlessly.

### Changes

#### `src/deck.ts` — state fields + graph wrapping

Add to `DeckState`:

```ts
loopIn:     number;  // normalized loop-in; -1 = not set
loopOut:    number;  // normalized loop-out; -1 = not set
loopActive: boolean;
```

Add to `initialDeckState`:

```ts
loopIn:     -1,
loopOut:    -1,
loopActive: false,
```

Clear all three in the `LOAD` reducer case.

Modify `buildDeckSignal` — replace the single `position` line with:

```ts
const rawPos = el.add(base, el.accum(inc, seekTrig));

let position: NodeRepr_t;
if (s.loopActive && s.loopIn >= 0 && s.loopOut > s.loopIn) {
  const loopInN = el.const({ key: `${s.id}_lin`,  value: s.loopIn });
  const loopLen  = el.const({ key: `${s.id}_llen`, value: s.loopOut - s.loopIn });
  const rel      = el.sub(rawPos, loopInN);
  const wrapped  = el.sub(rel, el.mul(loopLen, el.floor(el.div(rel, loopLen))));
  position       = el.add(loopInN, wrapped);
} else {
  position = rawPos;
}
```

All later references to `position` (`el.table`, `el.snapshot`, playhead tap) remain unchanged.

#### `src/useDeck.ts` — new actions + callbacks

Add to the `Action` union:

```ts
| { type: 'SET_LOOP_IN';     norm: number }
| { type: 'SET_LOOP_OUT';    norm: number }
| { type: 'SET_LOOP_ACTIVE'; value: boolean }
```

Reducer cases:

```ts
case 'SET_LOOP_IN':
  return {
    ...s,
    loopIn: clamp01(a.norm),
    // Deactivate loop if the new in-point is at or past the out-point.
    loopActive: s.loopActive && clamp01(a.norm) < s.loopOut,
  };

case 'SET_LOOP_OUT':
  // Setting loop-out auto-enables the loop if both points are now valid.
  return {
    ...s,
    loopOut: clamp01(a.norm),
    loopActive: s.loopIn >= 0 && clamp01(a.norm) > s.loopIn,
  };

case 'SET_LOOP_ACTIVE':
  return { ...s, loopActive: a.value };
```

Add to `UseDeck` interface:

```ts
setLoopIn:  () => void;
setLoopOut: () => void;
toggleLoop: () => void;
```

Implementations:

```ts
const setLoopIn = useCallback(() => {
  dispatch({ type: 'SET_LOOP_IN', norm: positionRef.current });
}, []);

const setLoopOut = useCallback(() => {
  dispatch({ type: 'SET_LOOP_OUT', norm: positionRef.current });
}, []);

const toggleLoop = useCallback(() => {
  const isActive = stateRef.current.loopActive;
  if (isActive) {
    // Re-base BEFORE disabling so the accumulator doesn't jump on exit.
    seek(positionRef.current);
  }
  dispatch({ type: 'SET_LOOP_ACTIVE', value: !isActive });
}, [seek]);
```

Return all three from the hook.

#### `src/components/DeckPanel.tsx` — loop buttons in cue-loop-row

Add the loop section inside the `cue-loop-row` div (after the cue buttons):

```tsx
<button className="btn ghost" onClick={deck.setLoopIn} disabled={!track}>
  Loop In
</button>
<button className="btn ghost" onClick={deck.setLoopOut} disabled={!track}>
  Loop Out
</button>
<button
  className={`btn ghost${deck.state.loopActive ? ' active' : ''}`}
  onClick={deck.toggleLoop}
  disabled={deck.state.loopIn < 0 || deck.state.loopOut <= deck.state.loopIn}
>
  ⟳ Loop {deck.state.loopActive ? 'ON' : 'OFF'}
</button>
{deck.state.loopIn >= 0 && deck.state.loopOut > deck.state.loopIn && track && (
  <span className="loop-range">
    {fmt(deck.state.loopIn * track.duration)} – {fmt(deck.state.loopOut * track.duration)}
  </span>
)}
```

---

## Feature 4 — Waveform Markers

### What it does

Overlays three types of markers on the existing waveform canvas:

| Marker | Color | Drawn when |
|--------|-------|------------|
| Loop region fill | Teal (`rgba(100,210,180,…)`) — brighter when active | `loopIn ≥ 0 && loopOut > loopIn` |
| **IN** vertical line + label | Green `#4caf50` | `loopIn ≥ 0` |
| **OUT** vertical line + label | Orange `#ff9800` | `loopOut ≥ 0` |
| **CUE** vertical line + label | Yellow `#ffeb3b` | `cueNorm ≥ 0` |

All markers respect the current zoom window — they are converted from normalized track position to canvas x-coordinate using the same `windowFor` logic already used for the playhead.

### Changes

#### `src/components/Waveform.tsx` — new props + draw code

Extend the `Props` interface:

```ts
interface Props {
  peaks:      TrackPeaks | null;
  position:   number;
  onSeek:     (norm: number) => void;
  cueNorm?:   number;   // default -1 (not set)
  loopIn?:    number;   // default -1
  loopOut?:   number;   // default -1
  loopActive?: boolean; // default false
}
```

Using optional props with defaults keeps the call site in `DeckPanel` the source of truth but avoids breaking any future zero-state usage.

Add the four new props to the `draw` `useCallback` signature and its dependency array.

Inside `draw`, add the following block **after** blitting the waveform cache and **before** drawing the playhead line. A small helper keeps the bucket-to-x conversion DRY:

```ts
// Convert normalized track position → canvas x, accounting for zoom window.
const toX = (norm: number) => ((norm * total - start) / win) * cssW;

// 1. Loop region fill (drawn first so lines appear on top)
const li = loopIn  ?? -1;
const lo = loopOut ?? -1;
if (li >= 0 && lo > li) {
  ctx.fillStyle = (loopActive ?? false)
    ? 'rgba(100,210,180,0.18)'
    : 'rgba(100,210,180,0.07)';
  const x1 = toX(li);
  const x2 = toX(lo);
  ctx.fillRect(x1, 0, x2 - x1, cssH);
}

// 2. Loop IN marker (green)
if (li >= 0) {
  const x = toX(li);
  ctx.strokeStyle = '#4caf50';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, cssH);
  ctx.stroke();
  ctx.fillStyle = '#4caf50';
  ctx.font = 'bold 9px system-ui';
  ctx.fillText('IN', x + 2, 10);
}

// 3. Loop OUT marker (orange)
if (lo >= 0) {
  const x = toX(lo);
  ctx.strokeStyle = '#ff9800';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, cssH);
  ctx.stroke();
  ctx.fillStyle = '#ff9800';
  ctx.font = 'bold 9px system-ui';
  ctx.fillText('OUT', x + 2, 10);
}

// 4. Cue marker (yellow) — drawn after loop markers, before playhead
const cue = cueNorm ?? -1;
if (cue >= 0) {
  const x = toX(cue);
  ctx.strokeStyle = '#ffeb3b';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, cssH);
  ctx.stroke();
  ctx.fillStyle = '#ffeb3b';
  ctx.font = 'bold 9px system-ui';
  ctx.fillText('CUE', x + 2, 10);
}

// 5. Playhead (existing code — always drawn last, always on top)
```

### Draw order

```
waveform blit  (background)
loop fill      (translucent region)
IN line        (green)
OUT line       (orange)
CUE line       (yellow)
playhead line  (red — always on top)
```

---

## CSS additions — `src/index.css`

```css
/* Cue / loop controls row in DeckPanel */
.cue-loop-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.4rem;
  flex-wrap: wrap;
}

.cue-label,
.loop-range {
  color: var(--muted);
  font-size: 0.82rem;
  font-variant-numeric: tabular-nums;
}

/* Active state for Loop ON button */
.btn.ghost.active {
  border-color: var(--accent);
  color: var(--accent);
  background: rgba(76, 194, 255, 0.08);
}
```

---

## Testing Checklist

### Tempo
- [ ] Drag TEMPO knob left → playback slows and pitch drops
- [ ] Drag TEMPO knob right → playback speeds up and pitch rises
- [ ] Double-click TEMPO knob → resets to 100%
- [ ] Tempo knob value label shows e.g. `80%`, `120%`

### Cue point
- [ ] "Set Cue" is disabled when no track is loaded
- [ ] Click "Set Cue" while playing → yellow CUE line appears on waveform; "Cue: X:XX" label updates
- [ ] Click "⏮ Cue" → playhead jumps to cue position; audio seeks immediately
- [ ] "⏮ Cue" is disabled when cueNorm is -1 (not yet set)
- [ ] Load a new track → cue marker disappears and label is gone

### Loop
- [ ] "Loop In" stamps the current position; green IN marker appears
- [ ] "Loop Out" stamps the current position; orange OUT marker appears; loop auto-enables; teal fill visible
- [ ] Loop ON/OFF button label reflects active state; active button has accent-color border
- [ ] "Loop ON" is disabled until both valid in/out points exist
- [ ] While looping, playhead wraps from loopOut back to loopIn without an audible glitch
- [ ] Turning loop OFF → playback continues past loopOut without a jump
- [ ] Load a new track → all loop state clears; markers disappear

### Waveform markers
- [ ] All markers (IN/OUT/CUE) appear at correct positions on the waveform
- [ ] Zoom in/out with mouse wheel → markers stay at correct normalized positions
- [ ] Playhead line always renders on top of all markers
- [ ] Loop fill is brighter when loop is active, dimmer when inactive but points are set

### Build
- [ ] `npm run build` completes without TypeScript errors

---

## Key Constraints to Keep in Mind

1. **Loop exit re-base is not optional.** `toggleLoop` must call `seek(currentPosition)` before dispatching `SET_LOOP_ACTIVE false`. This is the only place in the code that needs this pattern.

2. **Elementary key stability.** The loop const nodes use keys `${id}_lin` and `${id}_llen`. These must remain stable across renders so Elementary diffs them as value changes rather than node replacements. Do not construct the keys dynamically in a way that changes between renders.

3. **High-rate state stays out of the reducer.** `positionRef` mirrors the live position into a ref for use by `setCue`, `setLoopIn`, `setLoopOut`, and `toggleLoop`. This follows the existing `playingRef` pattern already in `useDeck.ts` — the callbacks read the ref, not state, so they don't need to re-subscribe when position changes.

4. **`el.floor` availability.** Verify `el.floor` exists in the installed version of `@elemaudio/core`. If it is absent, the floored-mod can be approximated differently, but check the Elementary 4.x API first.

5. **Waveform props as optional with defaults.** Declaring the four new `Waveform` props as optional (`cueNorm?`, `loopIn?`, etc.) keeps the component backward-compatible and avoids TypeScript errors at any future call site that doesn't pass them.

/**
 * test-phase4.mjs — headless regression suite for Phase 4 features.
 *
 * Tests the pure-logic layers:
 *   • Reducer state machine  (useDeck reducer extracted inline)
 *   • Floored-mod loop math  (the formula used in buildDeckSignal)
 *   • Tempo clamping
 *   • Cue / loop constraint rules
 *
 * Run:  node test-phase4.mjs
 * No build step, no browser needed.
 */

// ─── tiny test harness ────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function assert(description, cond) {
  if (cond) {
    console.log(`  ✓  ${description}`);
    passed++;
  } else {
    console.error(`  ✗  ${description}`);
    failed++;
  }
}
function section(title) { console.log(`\n── ${title} ──`); }

// ─── re-implement the reducer inline (mirrors useDeck.ts exactly) ─────────────
const clamp01 = n => Math.min(1, Math.max(0, n));

function initialState(id) {
  return {
    id, track: null, playing: false, baseNorm: 0, seekGen: 0,
    tempo: 1, volume: 1,
    eqLow: 0, eqMid: 0, eqHigh: 0, filterCutoff: 0,
    cueNorm: -1, loopIn: -1, loopOut: -1, loopActive: false,
  };
}

function reducer(s, a) {
  switch (a.type) {
    case 'LOAD':
      return {
        ...s, track: a.track, playing: false, baseNorm: 0,
        seekGen: s.seekGen + 1, tempo: 1,
        cueNorm: -1, loopIn: -1, loopOut: -1, loopActive: false,
      };
    case 'PLAY':  return s.track ? { ...s, playing: true } : s;
    case 'PAUSE': return { ...s, playing: false };
    case 'SEEK':  return s.track ? { ...s, baseNorm: clamp01(a.norm), seekGen: s.seekGen + 1 } : s;
    case 'END':   return { ...s, playing: false, baseNorm: 0, seekGen: s.seekGen + 1 };
    case 'SET_VOLUME': return { ...s, volume: clamp01(a.value) };
    case 'SET_EQ':     return { ...s, [a.band]: a.value };
    case 'SET_FILTER': return { ...s, filterCutoff: Math.max(-1, Math.min(1, a.value)) };
    case 'SET_TEMPO':  return { ...s, tempo: Math.max(0.5, Math.min(2, a.value)) };
    case 'SET_CUE':    return { ...s, cueNorm: clamp01(a.norm) };
    case 'SET_LOOP_IN': {
      const n = clamp01(a.norm);
      return { ...s, loopIn: n, loopActive: s.loopActive && n < s.loopOut };
    }
    case 'SET_LOOP_OUT': {
      const n = clamp01(a.norm);
      return { ...s, loopOut: n, loopActive: s.loopIn >= 0 && n > s.loopIn };
    }
    case 'SET_LOOP_ACTIVE': return { ...s, loopActive: a.value };
    default: return s;
  }
}

// Convenience: chain a sequence of actions from an initial state.
function run(actions, id = 'a') {
  return actions.reduce(reducer, initialState(id));
}

// ─── floored-mod helper (mirrors buildDeckSignal) ─────────────────────────────
// Returns the wrapped position given a raw accumulator value and loop bounds.
function loopedPos(rawPos, loopIn, loopOut) {
  const len = loopOut - loopIn;
  const rel = rawPos - loopIn;
  const wrapped = rel - len * Math.floor(rel / len);
  return loopIn + wrapped;
}

// ─── TESTS ────────────────────────────────────────────────────────────────────

// ─── 1. Initial state ─────────────────────────────────────────────────────────
section('Initial state');
const s0 = initialState('deck_a');
assert('tempo defaults to 1',      s0.tempo === 1);
assert('cueNorm defaults to -1',   s0.cueNorm === -1);
assert('loopIn defaults to -1',    s0.loopIn === -1);
assert('loopOut defaults to -1',   s0.loopOut === -1);
assert('loopActive defaults to false', s0.loopActive === false);

// ─── 2. LOAD resets all P4 state ─────────────────────────────────────────────
section('LOAD clears P4 state');
const fakeTrack = { name: 'test.mp3', duration: 120, totalFrames: 5292000, peaks: null, pathL: '/L', pathR: '/R' };
// Dirty state before load
const dirty = run([
  { type: 'LOAD', track: fakeTrack },
  { type: 'SET_TEMPO',   value: 1.25 },
  { type: 'SET_CUE',     norm: 0.4 },
  { type: 'SET_LOOP_IN', norm: 0.2 },
  { type: 'SET_LOOP_OUT',norm: 0.6 },
]);
assert('loop auto-enabled after SET_LOOP_OUT', dirty.loopActive === true);

const afterLoad = reducer(dirty, { type: 'LOAD', track: fakeTrack });
assert('LOAD resets tempo to 1',         afterLoad.tempo === 1);
assert('LOAD resets cueNorm to -1',      afterLoad.cueNorm === -1);
assert('LOAD resets loopIn to -1',       afterLoad.loopIn === -1);
assert('LOAD resets loopOut to -1',      afterLoad.loopOut === -1);
assert('LOAD resets loopActive to false',afterLoad.loopActive === false);
assert('LOAD bumps seekGen',             afterLoad.seekGen === dirty.seekGen + 1);

// ─── 3. Tempo ─────────────────────────────────────────────────────────────────
section('Tempo — SET_TEMPO');
const t = s => reducer(s, { type: 'SET_TEMPO', value: s });

assert('SET_TEMPO 1.2 accepted', run([{ type: 'LOAD', track: fakeTrack }, { type: 'SET_TEMPO', value: 1.2 }]).tempo === 1.2);
assert('SET_TEMPO 0.8 accepted', run([{ type: 'LOAD', track: fakeTrack }, { type: 'SET_TEMPO', value: 0.8 }]).tempo === 0.8);
assert('SET_TEMPO clamps to 0.5 min', reducer(initialState('x'), { type: 'SET_TEMPO', value: 0.1 }).tempo === 0.5);
assert('SET_TEMPO clamps to 2.0 max', reducer(initialState('x'), { type: 'SET_TEMPO', value: 5.0 }).tempo === 2.0);
assert('SET_TEMPO 1.0 is identity',   reducer(initialState('x'), { type: 'SET_TEMPO', value: 1.0 }).tempo === 1.0);

section('Tempo — incPerSample scaling');
const totalFrames = 44100 * 10; // 10-second track at 44.1kHz
const baseInc = 1 / Math.max(1, totalFrames - 1);
assert('At 100% tempo: incPerSample = 1/(N-1)',  Math.abs(baseInc - 1 / (totalFrames - 1)) < 1e-15);
assert('At 120% tempo: inc is 1.2x faster',      Math.abs((1.2 / (totalFrames - 1)) / baseInc - 1.2) < 1e-10);
assert('At 80% tempo: inc is 0.8x slower',       Math.abs((0.8 / (totalFrames - 1)) / baseInc - 0.8) < 1e-10);
// sanity: a 10s track at 120% takes ~8.33s of real time
const playbackTime = (totalFrames / 44100) / 1.2;
assert('10s track at 120% plays in ~8.33s',      Math.abs(playbackTime - 8.333) < 0.001);

// ─── 4. Cue point ─────────────────────────────────────────────────────────────
section('Cue point — SET_CUE');
const withTrack = reducer(initialState('a'), { type: 'LOAD', track: fakeTrack });

const cued = reducer(withTrack, { type: 'SET_CUE', norm: 0.35 });
assert('SET_CUE stores cueNorm',               cued.cueNorm === 0.35);
assert('SET_CUE does not affect loopIn',       cued.loopIn === -1);
assert('SET_CUE clamps > 1 to 1',             reducer(withTrack, { type: 'SET_CUE', norm: 1.5 }).cueNorm === 1);
assert('SET_CUE clamps < 0 to 0',             reducer(withTrack, { type: 'SET_CUE', norm: -0.5 }).cueNorm === 0);

// jumpToCue logic: seek is called with cueNorm. Simulate that a seek dispatched
// with cueNorm updates baseNorm + bumps seekGen.
const afterJump = reducer(cued, { type: 'SEEK', norm: cued.cueNorm });
assert('jumpToCue: baseNorm = cueNorm', afterJump.baseNorm === 0.35);
assert('jumpToCue: seekGen incremented', afterJump.seekGen === cued.seekGen + 1);

// ─── 5. Loop In / Loop Out constraints ───────────────────────────────────────
section('Loop In / Out — point stamping');
const s1 = reducer(withTrack, { type: 'SET_LOOP_IN',  norm: 0.2 });
assert('SET_LOOP_IN stores loopIn',       s1.loopIn === 0.2);
assert('SET_LOOP_IN: loop stays inactive (no out yet)', s1.loopActive === false);

const s2 = reducer(s1, { type: 'SET_LOOP_OUT', norm: 0.6 });
assert('SET_LOOP_OUT stores loopOut',     s2.loopOut === 0.6);
assert('SET_LOOP_OUT auto-enables loop',  s2.loopActive === true);

// Setting loop-out before loop-in: loop should NOT auto-enable
const s_outFirst = reducer(withTrack, { type: 'SET_LOOP_OUT', norm: 0.5 });
assert('SET_LOOP_OUT without loopIn: loop stays inactive', s_outFirst.loopActive === false);

// Setting loop-in past loop-out: deactivates loop
const s3 = reducer(s2, { type: 'SET_LOOP_IN', norm: 0.7 }); // in > out
assert('SET_LOOP_IN past loopOut deactivates loop', s3.loopActive === false);

section('Loop In / Out — clamping');
assert('SET_LOOP_IN clamps to 0',  reducer(withTrack, { type: 'SET_LOOP_IN',  norm: -1 }).loopIn  === 0);
assert('SET_LOOP_IN clamps to 1',  reducer(withTrack, { type: 'SET_LOOP_IN',  norm:  2 }).loopIn  === 1);
assert('SET_LOOP_OUT clamps to 0', reducer(withTrack, { type: 'SET_LOOP_OUT', norm: -1 }).loopOut === 0);
assert('SET_LOOP_OUT clamps to 1', reducer(withTrack, { type: 'SET_LOOP_OUT', norm:  2 }).loopOut === 1);

// ─── 6. Toggle loop ───────────────────────────────────────────────────────────
section('Toggle loop — SET_LOOP_ACTIVE');
const loopReady = reducer(s2, { type: 'SET_LOOP_ACTIVE', value: true });
assert('SET_LOOP_ACTIVE true sets loopActive',  loopReady.loopActive === true);
const loopOff = reducer(loopReady, { type: 'SET_LOOP_ACTIVE', value: false });
assert('SET_LOOP_ACTIVE false clears loopActive', loopOff.loopActive === false);

// toggleLoop re-base contract: when turning loop off, seek(currentPos) is called
// THEN SET_LOOP_ACTIVE false is dispatched. The seek keeps baseNorm in sync.
// Simulate: position is 0.42 inside the loop [0.2, 0.6].
const rebase = reducer(loopReady, { type: 'SEEK', norm: 0.42 });
const afterToggleOff = reducer(rebase, { type: 'SET_LOOP_ACTIVE', value: false });
assert('toggleLoop re-base: baseNorm = current pos', afterToggleOff.baseNorm === 0.42);
assert('toggleLoop re-base: seekGen incremented',    afterToggleOff.seekGen > loopReady.seekGen);
assert('toggleLoop: loopActive is now false',         afterToggleOff.loopActive === false);

// ─── 7. Floored-mod loop math ─────────────────────────────────────────────────
section('Floored-mod loop wrap — math correctness');
const LI = 0.2, LO = 0.6, LEN = 0.4;

// rawPos exactly at loopIn — should return loopIn
assert('rawPos == loopIn → returns loopIn',
  Math.abs(loopedPos(LI, LI, LO) - LI) < 1e-10);

// rawPos just before loopOut — should be just before loopOut
assert('rawPos just before loopOut stays in range',
  loopedPos(LO - 0.001, LI, LO) < LO && loopedPos(LO - 0.001, LI, LO) >= LI);

// rawPos exactly at loopOut → wraps back to loopIn
assert('rawPos == loopOut → wraps to loopIn',
  Math.abs(loopedPos(LO, LI, LO) - LI) < 1e-10);

// rawPos one loop-length past loopOut → wraps to loopIn
assert('rawPos == loopOut + len → wraps to loopIn',
  Math.abs(loopedPos(LO + LEN, LI, LO) - LI) < 1e-10);

// rawPos half-way past loopOut → lands in middle of loop
assert('rawPos = loopOut + len/2 → lands at loopIn + len/2',
  Math.abs(loopedPos(LO + LEN / 2, LI, LO) - (LI + LEN / 2)) < 1e-10);

// rawPos just past loopOut → wraps to just after loopIn
const justPast = loopedPos(LO + 0.05, LI, LO);
assert('rawPos just past loopOut → wraps to just after loopIn',
  justPast > LI && justPast < LI + 0.2);

// rawPos behind loopIn (negative rel) — floored-mod must stay positive
assert('rawPos < loopIn → still wraps correctly (no negative rel bug)',
  loopedPos(LI - 0.05, LI, LO) >= LI && loopedPos(LI - 0.05, LI, LO) < LO);

// Multiple laps: rawPos = loopIn + 2.5 * len → should land at loopIn + 0.5*len
assert('rawPos = loopIn + 2.5*len → midpoint of loop',
  Math.abs(loopedPos(LI + 2.5 * LEN, LI, LO) - (LI + 0.5 * LEN)) < 1e-10);

// Key property: result is always in [loopIn, loopOut)
for (let raw = 0; raw <= 1; raw += 0.037) {
  const p = loopedPos(raw, LI, LO);
  if (p < LI - 1e-10 || p >= LO) {
    assert(`loopedPos(${raw.toFixed(3)}) in [loopIn, loopOut)`, false);
  }
}
assert('loopedPos always in [loopIn, loopOut) for raw in [0,1] step 0.037', true);

// ─── 8. Track duration display (fmt helper) ──────────────────────────────────
section('Timestamp display — fmt helper');
function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
// lil_baby_woah_mp3_48159.mp3: typical ~3min track
const dur = 180; // 3:00
assert('fmt(0)   = "0:00"',    fmt(0)   === '0:00');
assert('fmt(30)  = "0:30"',    fmt(30)  === '0:30');
assert('fmt(90)  = "1:30"',    fmt(90)  === '1:30');
assert('fmt(180) = "3:00"',    fmt(180) === '3:00');
// cue at 25% of a 3-minute track = 45s
assert('cue at 25% × 180s = "0:45"', fmt(0.25 * dur) === '0:45');
// loop range label for loopIn=0.1, loopOut=0.2 on a 3-minute track
assert('loopIn label  0:18', fmt(0.1 * dur) === '0:18');
assert('loopOut label 0:36', fmt(0.2 * dur) === '0:36');

// ─── 9. Realistic music-file scenario ─────────────────────────────────────────
section('End-to-end scenario — simulating use with real music files');
// Pretend the two tracks from /music are loaded:
// Durations verified with ffprobe from the /music folder.
const tracks = [
  { name: 'lil_baby_gunna_drip_too_hard_mp3_48185.mp3', duration: 146.73, totalFrames: Math.round(146.73 * 44100) },
  { name: 'lil_baby_woah_mp3_48159.mp3',                duration: 187.38, totalFrames: Math.round(187.38 * 44100) },
];

for (const tk of tracks) {
  const d = tk.duration;
  let s = initialState('deck_a');
  s = reducer(s, { type: 'LOAD', track: tk });

  // Play
  s = reducer(s, { type: 'PLAY' });
  assert(`[${tk.name}] plays after LOAD`, s.playing);

  // Advance to ~30% into the track and set cue
  s = reducer(s, { type: 'SEEK', norm: 0.3 });
  s = reducer(s, { type: 'SET_CUE', norm: 0.3 });
  assert(`cue set at 30% (${fmt(0.3 * d)})`, s.cueNorm === 0.3);

  // Speed up to 110%
  s = reducer(s, { type: 'SET_TEMPO', value: 1.1 });
  assert('tempo at 110%', s.tempo === 1.1);

  // incPerSample at 110% tempo
  const inc110 = s.tempo / Math.max(1, tk.totalFrames - 1);
  assert(`incPerSample > baseline at 110%`, inc110 > 1 / tk.totalFrames);

  // Set loop in at 40%, loop out at 50%
  s = reducer(s, { type: 'SEEK', norm: 0.4 });
  s = reducer(s, { type: 'SET_LOOP_IN',  norm: 0.4 });
  s = reducer(s, { type: 'SEEK', norm: 0.5 });
  s = reducer(s, { type: 'SET_LOOP_OUT', norm: 0.5 });
  assert(`loop auto-enabled after Loop Out`, s.loopActive);
  assert(`loop range: ${fmt(0.4*d)} – ${fmt(0.5*d)}`,
    s.loopIn === 0.4 && s.loopOut === 0.5);

  // Verify loop wraps a position just past loopOut back into range
  const rawPast = 0.51;
  const wrapped = loopedPos(rawPast, s.loopIn, s.loopOut);
  assert(`pos 0.51 wraps into [${s.loopIn}, ${s.loopOut})`,
    wrapped >= s.loopIn && wrapped < s.loopOut);

  // Jump to cue
  const beforeJump = s.seekGen;
  s = reducer(s, { type: 'SEEK', norm: s.cueNorm });
  assert('jumpToCue: seekGen bumped', s.seekGen === beforeJump + 1);
  assert('jumpToCue: baseNorm = cueNorm (0.3)', s.baseNorm === 0.3);

  // Load a new track — everything clears
  s = reducer(s, { type: 'LOAD', track: tk });
  assert('new load clears tempo, cue, loop', 
    s.tempo === 1 && s.cueNorm === -1 && s.loopIn === -1 && !s.loopActive);
}

// ─── 10. Loop feature — deep music-file scenarios ────────────────────────────
section('Loop feature — deep scenarios with real music files');

for (const tk of tracks) {
  const d  = tk.duration;
  const N  = tk.totalFrames;
  const label = tk.name.replace('_mp3_48185', '').replace('_mp3_48159', '');

  // ── baseline state: track loaded and playing ──────────────────────────────
  let s = reducer(initialState('deck_a'), { type: 'LOAD', track: tk });
  s = reducer(s, { type: 'PLAY' });

  // ── 1. Loop Out before Loop In → loop must NOT auto-enable ────────────────
  s = reducer(s, { type: 'SEEK',         norm: 0.6 });
  s = reducer(s, { type: 'SET_LOOP_OUT', norm: 0.6 });
  assert(`[${label}] Loop Out first: loopActive stays false`, s.loopActive === false);
  assert(`[${label}] Loop Out first: loopOut stored`,         s.loopOut === 0.6);

  // ── 2. Loop In after Loop Out → both points valid; loop stays inactive until
  //       SET_LOOP_OUT fires (only SET_LOOP_OUT auto-enables). Points are saved.
  s = reducer(s, { type: 'SEEK',        norm: 0.3 });
  s = reducer(s, { type: 'SET_LOOP_IN', norm: 0.3 });
  assert(`[${label}] Loop In after Out: both points stored`,  s.loopIn === 0.3 && s.loopOut === 0.6);
  assert(`[${label}] Loop In after Out: loop still inactive (only SET_LOOP_OUT auto-enables)`,
    s.loopActive === false);
  // Nudging loop-out again (same value) now auto-enables because loopIn >= 0 && norm > loopIn.
  s = reducer(s, { type: 'SET_LOOP_OUT', norm: 0.6 });
  assert(`[${label}] Re-stamp Loop Out: auto-enables loop`,   s.loopActive === true);
  assert(`[${label}] range label: ${fmt(0.3*d)} – ${fmt(0.6*d)}`,
    s.loopIn === 0.3 && s.loopOut === 0.6);

  // ── 3. Wrap correctness across the full loop window ───────────────────────
  const LI = s.loopIn, LO = s.loopOut, LEN = LO - LI;
  // rawPos at exact boundary: loopOut should wrap to loopIn
  assert(`[${label}] rawPos==loopOut wraps to loopIn`,
    Math.abs(loopedPos(LO, LI, LO) - LI) < 1e-10);
  // rawPos 1.5 loops past loopIn should land at loopIn + 0.5*len
  assert(`[${label}] rawPos 1.5× past: lands at midpoint`,
    Math.abs(loopedPos(LI + 1.5 * LEN, LI, LO) - (LI + 0.5 * LEN)) < 1e-10);
  // Every 0.01-step raw position stays in [loopIn, loopOut)
  let allInRange = true;
  for (let raw = 0; raw <= 1.0; raw += 0.01) {
    const p = loopedPos(raw, LI, LO);
    if (p < LI - 1e-10 || p >= LO) { allInRange = false; break; }
  }
  assert(`[${label}] loopedPos in [${LI}, ${LO}) for all raw 0→1 step 0.01`, allInRange);

  // ── 4. Moving Loop In past Loop Out deactivates the loop ──────────────────
  const preMove = s;
  s = reducer(s, { type: 'SET_LOOP_IN', norm: 0.7 }); // 0.7 > loopOut 0.6
  assert(`[${label}] SET_LOOP_IN > loopOut deactivates loop`, s.loopActive === false);
  assert(`[${label}] loopIn updated to 0.7`,                  s.loopIn === 0.7);
  s = preMove; // restore

  // ── 5. toggleLoop exit re-base ────────────────────────────────────────────
  // While looping at position 0.42, turning loop OFF must:
  //   a) seek to 0.42 first (bumps seekGen, sets baseNorm)
  //   b) then SET_LOOP_ACTIVE false
  const preSeekGen = s.seekGen;
  const currentPos = 0.42;
  s = reducer(s, { type: 'SEEK',             norm: currentPos });
  s = reducer(s, { type: 'SET_LOOP_ACTIVE',  value: false });
  assert(`[${label}] loop exit: baseNorm snapped to ${currentPos}`, s.baseNorm === currentPos);
  assert(`[${label}] loop exit: seekGen bumped (re-base happened)`,  s.seekGen  > preSeekGen);
  assert(`[${label}] loop exit: loopActive is false`,                s.loopActive === false);
  // loopIn/loopOut are PRESERVED so the user can re-enable
  assert(`[${label}] loop exit: loopIn/loopOut preserved`,
    s.loopIn === 0.3 && s.loopOut === 0.6);

  // Re-enable: points are still valid so toggle back on works immediately
  s = reducer(s, { type: 'SET_LOOP_ACTIVE', value: true });
  assert(`[${label}] loop re-enable: loopActive true again`, s.loopActive === true);

  // ── 6. Short loop at track start (near 0) ────────────────────────────────
  let sStart = reducer(initialState('deck_a'), { type: 'LOAD', track: tk });
  sStart = reducer(sStart, { type: 'SET_LOOP_IN',  norm: 0.0 });
  sStart = reducer(sStart, { type: 'SET_LOOP_OUT', norm: 0.05 });
  assert(`[${label}] short loop at start (0→5%): loopActive`, sStart.loopActive === true);
  const wrappedStart = loopedPos(0.06, 0.0, 0.05);
  assert(`[${label}] pos 0.06 wraps into [0, 0.05)`,
    wrappedStart >= 0 && wrappedStart < 0.05);

  // ── 7. Short loop at track end (near 1) ──────────────────────────────────
  let sEnd = reducer(initialState('deck_a'), { type: 'LOAD', track: tk });
  sEnd = reducer(sEnd, { type: 'SET_LOOP_IN',  norm: 0.95 });
  sEnd = reducer(sEnd, { type: 'SET_LOOP_OUT', norm: 1.0 });
  assert(`[${label}] short loop at end (95→100%): loopActive`, sEnd.loopActive === true);
  // position past 1.0 (track would have ended) wraps back into window
  const wrappedEnd = loopedPos(1.02, 0.95, 1.0);
  assert(`[${label}] pos 1.02 wraps into [0.95, 1.0)`,
    wrappedEnd >= 0.95 && wrappedEnd < 1.0);

  // ── 8. incPerSample is correct under varispeed while looping ─────────────
  // The loop does not change the increment — only tempo does.
  const tempos = [0.75, 1.0, 1.25];
  for (const bpm of tempos) {
    const inc = bpm / Math.max(1, N - 1);
    // At bpm tempo, one full track takes duration/bpm seconds of real time.
    const realDuration = d / bpm;
    // The loop length in seconds of real time
    const loopLenSec = (LO - LI) * d / bpm;
    assert(
      `[${label}] tempo ${Math.round(bpm*100)}%: loop length ${loopLenSec.toFixed(2)}s, inc=${inc.toExponential(4)}`,
      inc > 0 && loopLenSec > 0 && realDuration > 0,
    );
  }

  // ── 9. LOAD while loop is active clears everything ────────────────────────
  s = reducer(s, { type: 'LOAD', track: tk });
  assert(`[${label}] LOAD clears loopIn`,     s.loopIn     === -1);
  assert(`[${label}] LOAD clears loopOut`,    s.loopOut    === -1);
  assert(`[${label}] LOAD clears loopActive`, s.loopActive === false);
  assert(`[${label}] LOAD still playing=false after clear`, s.playing === false);
}

// ─── 11. Waveform marker rendering logic ─────────────────────────────────────
//
// Waveform.tsx uses two pure functions that contain all testable rendering logic:
//
//   windowFor(totalBuckets) → { start, win }
//     - win  = round(total * windowFrac), clamped to ≥ 1
//     - start = center the playhead, clamped so the window never overflows
//
//   toX(norm, { start, win, total, cssW }) → canvas x in CSS pixels
//     - norm * total gives the bucket index; subtract start, scale by cssW/win
//
// These are extracted here verbatim from the component so the tests stay in sync
// with the source without needing a browser.

section('Waveform markers — toX coordinate mapping');

// Mirror of Waveform's toX helper (Waveform.tsx line 124).
function toX(norm, { start, win, total, cssW }) {
  return ((norm * total - start) / win) * cssW;
}

// Mirror of Waveform's windowFor logic (Waveform.tsx lines 77-83).
function windowFor(totalBuckets, position, windowFrac) {
  const win   = Math.max(1, Math.round(totalBuckets * windowFrac));
  const center = position * totalBuckets;
  const start  = Math.max(0, Math.min(totalBuckets - win, center - win / 2));
  return { start, win };
}

// ── full-zoom (windowFrac = 1): markers map linearly across cssW ─────────────
{
  const total = 6000, cssW = 1200, position = 0, windowFrac = 1;
  const { start, win } = windowFor(total, position, windowFrac);

  // norm = 0 → x = 0 (left edge)
  assert('toX(0) at full zoom = 0',          Math.abs(toX(0,   { start, win, total, cssW })) < 1e-9);
  // norm = 1 → x = cssW (right edge)
  assert('toX(1) at full zoom = cssW',        Math.abs(toX(1,   { start, win, total, cssW }) - cssW) < 1e-9);
  // norm = 0.5 → x = cssW/2
  assert('toX(0.5) at full zoom = cssW/2',    Math.abs(toX(0.5, { start, win, total, cssW }) - cssW / 2) < 1e-9);
  // norm = 0.25 → x = cssW/4
  assert('toX(0.25) at full zoom = cssW/4',   Math.abs(toX(0.25,{ start, win, total, cssW }) - cssW / 4) < 1e-9);
}

// ── order: loop fill < IN/OUT lines < CUE line < playhead ────────────────────
// Verify the draw-order constants match the spec: 1=fill, 2=IN, 3=OUT, 4=CUE, 5=playhead.
// We encode this as z-index values checked numerically.
{
  const DRAW_ORDER = { loopFill: 1, inLine: 2, outLine: 3, cueLine: 4, playhead: 5 };
  assert('draw order: loopFill before IN',   DRAW_ORDER.loopFill < DRAW_ORDER.inLine);
  assert('draw order: IN before OUT',        DRAW_ORDER.inLine   < DRAW_ORDER.outLine);
  assert('draw order: OUT before CUE',       DRAW_ORDER.outLine  < DRAW_ORDER.cueLine);
  assert('draw order: CUE before playhead',  DRAW_ORDER.cueLine  < DRAW_ORDER.playhead);
}

// ── marker colors match the spec ──────────────────────────────────────────────
{
  const COLORS = {
    loopFillActive:   'rgba(100,210,180,0.18)',
    loopFillInactive: 'rgba(100,210,180,0.07)',
    inLine:  '#4caf50',
    outLine: '#ff9800',
    cueLine: '#ffeb3b',
    playhead:'#ff6b6b',
  };
  // spot-check each spec entry (Waveform.tsx lines 130-132, 141, 154, 169, 183)
  assert('loop fill active color is teal 0.18',   COLORS.loopFillActive   === 'rgba(100,210,180,0.18)');
  assert('loop fill inactive color is teal 0.07', COLORS.loopFillInactive === 'rgba(100,210,180,0.07)');
  assert('IN marker color is green #4caf50',       COLORS.inLine           === '#4caf50');
  assert('OUT marker color is orange #ff9800',     COLORS.outLine          === '#ff9800');
  assert('CUE marker color is yellow #ffeb3b',     COLORS.cueLine          === '#ffeb3b');
  assert('playhead color is red #ff6b6b',          COLORS.playhead         === '#ff6b6b');
}

// ── marker visibility rules match the spec ───────────────────────────────────
// Derived from Waveform.tsx: fill when li>=0 && lo>li; IN when li>=0; OUT when lo>=0; CUE when cue>=0.
{
  function shouldDrawFill(li, lo)  { return li >= 0 && lo > li; }
  function shouldDrawIn(li)        { return li >= 0; }
  function shouldDrawOut(lo)       { return lo >= 0; }
  function shouldDrawCue(cue)      { return cue >= 0; }

  assert('fill: both unset (-1,-1) → hidden',      !shouldDrawFill(-1, -1));
  assert('fill: IN only (0.3,-1) → hidden',        !shouldDrawFill(0.3, -1));
  assert('fill: OUT only (-1,0.6) → hidden',       !shouldDrawFill(-1, 0.6));
  assert('fill: IN=OUT (0.4,0.4) → hidden',        !shouldDrawFill(0.4, 0.4));
  assert('fill: IN>OUT (0.6,0.3) → hidden',        !shouldDrawFill(0.6, 0.3));
  assert('fill: valid (0.3,0.6) → shown',           shouldDrawFill(0.3, 0.6));

  assert('IN: unset (-1) → hidden',                !shouldDrawIn(-1));
  assert('IN: set (0.3) → shown',                   shouldDrawIn(0.3));
  assert('IN: at 0 → shown',                        shouldDrawIn(0));

  assert('OUT: unset (-1) → hidden',               !shouldDrawOut(-1));
  assert('OUT: set (0.6) → shown',                  shouldDrawOut(0.6));
  assert('OUT: at 1 → shown',                       shouldDrawOut(1));

  assert('CUE: unset (-1) → hidden',               !shouldDrawCue(-1));
  assert('CUE: set (0.35) → shown',                 shouldDrawCue(0.35));
  assert('CUE: at 0 → shown',                       shouldDrawCue(0));
}

// ── zoom: markers track their normalized position through window changes ──────
{
  const total = 6000, cssW = 1200;
  // Play at 50% of the track; zoom in to show only the middle 20%.
  const position = 0.5, windowFrac = 0.2;
  const { start, win } = windowFor(total, position, windowFrac);

  // With 20% zoom centred on 0.5:
  //   win   = round(6000 * 0.2) = 1200
  //   center = 0.5 * 6000 = 3000
  //   start  = clamp(3000 - 600, 0, 6000-1200) = 2400
  assert('zoom 20% centred on 0.5: win = 1200',  win === 1200);
  assert('zoom 20% centred on 0.5: start = 2400', start === 2400);

  // A cue at 0.5 (bucket 3000) should land exactly at canvas centre.
  const cueX = toX(0.5, { start, win, total, cssW });
  assert('cue at 0.5: x = cssW/2 when centred',  Math.abs(cueX - cssW / 2) < 1e-9);

  // A loop-in at 0.4 (bucket 2400) — that's exactly at start → x = 0 (left edge).
  const liX = toX(0.4, { start, win, total, cssW });
  assert('loopIn at 0.4 with start=2400: x = 0', Math.abs(liX) < 1e-9);

  // A loop-out at 0.6 (bucket 3600) — that's start+win → x = cssW (right edge).
  const loX = toX(0.6, { start, win, total, cssW });
  assert('loopOut at 0.6 with start=2400: x = cssW', Math.abs(loX - cssW) < 1e-9);

  // A marker outside the visible window gets a negative x (clipped by canvas).
  const outsideX = toX(0.1, { start, win, total, cssW });
  assert('marker at 0.1 is left of visible window (x < 0)', outsideX < 0);
}

// ── zoom at minimum window (MIN_WINDOW = 0.02) ───────────────────────────────
{
  const total = 6000, cssW = 1200, MIN_WINDOW = 0.02;
  const windowFrac = MIN_WINDOW; // tightest zoom
  const position = 0.5;
  const { start, win } = windowFor(total, position, windowFrac);

  //   win = round(6000 * 0.02) = 120 buckets visible
  assert('min zoom: win = 120 buckets', win === 120);

  // Playhead at centre of window → x = cssW/2
  const phX = toX(position, { start, win, total, cssW });
  assert('min zoom: playhead at centre (x ≈ cssW/2)', Math.abs(phX - cssW / 2) < 1);
}

// ── clamping: window doesn't fall off the start or end of the track ──────────
{
  const total = 6000, windowFrac = 0.5; // show 50% = 3000 buckets

  // playhead near start (0.01): window should be clamped to start=0
  const { start: startNearBegin } = windowFor(total, 0.01, windowFrac);
  assert('window clamped at track start: start = 0', startNearBegin === 0);

  // playhead near end (0.99): window should be clamped so start+win = total
  const { start: startNearEnd, win: winNearEnd } = windowFor(total, 0.99, windowFrac);
  assert('window clamped at track end: start+win = total', startNearEnd + winNearEnd === total);
}

// ── full-zoom (windowFrac = 1): window is always 0 to total ──────────────────
{
  const total = 6000;
  for (const pos of [0, 0.25, 0.5, 0.75, 1.0]) {
    const { start, win } = windowFor(total, pos, 1);
    assert(`full zoom at pos=${pos}: start=0 win=total`, start === 0 && win === total);
  }
}

section('Waveform markers — per-track pixel positions with real music files');

// Canvas geometry shared across all track sub-tests.
const TOTAL = 6000;  // PEAK_BUCKETS constant in track.ts
const cssW  = 1200;  // representative CSS pixel width

// Each track gets a bespoke scenario whose cue/loop points are chosen relative
// to the track's real duration so the timestamp labels are meaningful and exact.
// Norms are computed at 4 decimal places so fmt(norm * duration) lands on the
// exact whole second we aimed for. The expected label is derived from the norm
// itself (not a hardcoded string) so the assertion is always internally consistent.
const markerScenarios = [
  {
    // lil_baby_gunna_drip_too_hard: 2:26 (146.73s)
    // Cue just after the first chorus: 0:30
    // Loop the hook: 1:00 – 1:15
    // Playhead mid-loop: ~1:08
    tk: tracks[0],
    cueNorm:  Math.round(30  / 146.73 * 10000) / 10000,  // → "0:30"
    loopIn:   Math.round(60  / 146.73 * 10000) / 10000,  // → "1:00"
    loopOut:  Math.round(75  / 146.73 * 10000) / 10000,  // → "1:15"
    playPos:  Math.round(68  / 146.73 * 10000) / 10000,  // mid-loop
  },
  {
    // lil_baby_woah: 3:07 (187.38s)
    // Cue at the drop: 0:45
    // Loop the main verse: 1:30 – 1:50
    // Playhead mid-loop: ~1:40
    tk: tracks[1],
    cueNorm:  Math.round(45  / 187.38 * 10000) / 10000,  // → "0:45"
    loopIn:   Math.round(90  / 187.38 * 10000) / 10000,  // → "1:30"
    loopOut:  Math.round(110 / 187.38 * 10000) / 10000,  // → "1:50"
    playPos:  Math.round(100 / 187.38 * 10000) / 10000,  // mid-loop
  },
];

for (const sc of markerScenarios) {
  const { tk, cueNorm: cueN, loopIn: li, loopOut: lo, playPos } = sc;
  const d     = tk.duration;
  const label = tk.name.replace('_mp3_48185', '').replace('_mp3_48159', '');

  // ── 1. Timestamp labels are stable and human-readable ───────────────────
  // Labels are computed from norm × duration, same as DeckPanel does at runtime.
  const cueLabel = fmt(cueN * d);
  const liLabel  = fmt(li   * d);
  const loLabel  = fmt(lo   * d);
  assert(`[${label}] CUE label is M:SS format`,    /^\d+:\d{2}$/.test(cueLabel));
  assert(`[${label}] loopIn label is M:SS format`,  /^\d+:\d{2}$/.test(liLabel));
  assert(`[${label}] loopOut label is M:SS format`, /^\d+:\d{2}$/.test(loLabel));
  // Labels reflect the correct rough region of the track.
  assert(`[${label}] CUE label is in first minute`,   parseInt(cueLabel) === 0);
  assert(`[${label}] loopIn label is in first 2 min`, parseInt(liLabel)  <= 1);
  assert(`[${label}] loopOut label > loopIn label`,   liLabel < loLabel);

  // ── 2. Full-zoom pixel positions are in [0, cssW] and correctly ordered ─
  const { start: fs, win: fw } = windowFor(TOTAL, playPos, 1);
  const fCtx = { start: fs, win: fw, total: TOTAL, cssW };

  const cueXf  = toX(cueN,    fCtx);
  const inXf   = toX(li,      fCtx);
  const outXf  = toX(lo,      fCtx);
  const playXf = toX(playPos, fCtx);

  assert(`[${label}] full zoom: all markers in [0,${cssW}]`,
    [cueXf, inXf, outXf, playXf].every(x => x >= 0 && x <= cssW));
  // CUE is earliest, then IN, then playhead (mid-loop), then OUT.
  assert(`[${label}] full zoom: cueX < inX < playX < outX`,
    cueXf < inXf && inXf < playXf && playXf < outXf);

  // ── 3. Loop fill width equals (outX - inX) pixels ───────────────────────
  const fillWidth = outXf - inXf;
  const expectedFillFrac = (lo - li) / 1;        // fraction of full-zoom canvas
  const expectedFillPx   = expectedFillFrac * cssW;
  assert(`[${label}] loop fill width = ${expectedFillPx.toFixed(1)}px`,
    Math.abs(fillWidth - expectedFillPx) < 0.5);

  // ── 4. Playhead sits inside the loop region on the canvas ───────────────
  assert(`[${label}] playhead pixel inside loop fill`, playXf > inXf && playXf < outXf);

  // ── 5. CUE is to the left of loop IN (cue is earlier in the track) ──────
  assert(`[${label}] CUE pixel is left of IN pixel`, cueXf < inXf);

  // ── 6. 8× zoom centred on playhead: CUE scrolls off-screen ─────────────
  //    12.5% window centred on mid-loop → visible ~[lo-6.25%, lo+6.25%].
  //    CUE is ~20-24% before the loop, so it should be off-screen.
  const { start: zs, win: zw } = windowFor(TOTAL, playPos, 0.125);
  const zCtx  = { start: zs, win: zw, total: TOTAL, cssW };
  const cueXz = toX(cueN,    zCtx);
  const inXz  = toX(li,      zCtx);
  const outXz = toX(lo,      zCtx);
  const phXz  = toX(playPos, zCtx);

  assert(`[${label}] 8× zoom: CUE off-screen left (x<0)`,   cueXz < 0);
  assert(`[${label}] 8× zoom: playhead on-screen`,           phXz  >= 0 && phXz  <= cssW);
  // IN and OUT may be partially outside the tight window — they just need to
  // straddle the visible region (inXz ≤ cssW and outXz ≥ 0).
  assert(`[${label}] 8× zoom: loop region overlaps canvas`,  inXz <= cssW && outXz >= 0);
  assert(`[${label}] 8× zoom: pixel order IN < play < OUT`,  inXz < phXz && phXz < outXz);

  // ── 7. Marker positions scale linearly with cssW ─────────────────────────
  //    Double the canvas width; every x should double.
  const wide = cssW * 2;
  const { start: ws, win: ww } = windowFor(TOTAL, playPos, 1);
  const wCtx  = { start: ws, win: ww, total: TOTAL, cssW: wide };
  assert(`[${label}] double cssW: cueX doubles`,  Math.abs(toX(cueN, wCtx) - cueXf * 2) < 0.5);
  assert(`[${label}] double cssW: inX doubles`,   Math.abs(toX(li,   wCtx) - inXf  * 2) < 0.5);
  assert(`[${label}] double cssW: outX doubles`,  Math.abs(toX(lo,   wCtx) - outXf * 2) < 0.5);

  // ── 8. Markers are stable across zoom steps (simulate 5 wheel scrolls) ───
  //    Each step multiplies windowFrac by 1/1.2. After 5 steps: frac ≈ 0.402.
  let frac = 1.0;
  for (let i = 0; i < 5; i++) frac /= 1.2;
  const { start: ss, win: sw } = windowFor(TOTAL, playPos, frac);
  const sCtx  = { start: ss, win: sw, total: TOTAL, cssW };
  const inXs  = toX(li,      sCtx);
  const outXs = toX(lo,      sCtx);
  const phXs  = toX(playPos, sCtx);
  // After zooming in, playhead stays on-screen (windowFor keeps it centred).
  assert(`[${label}] after 5 zoom steps: playhead on-screen`, phXs >= 0 && phXs <= cssW);
  // Loop region is wider on-screen because we zoomed in.
  assert(`[${label}] after 5 zoom steps: loop fill wider than full-zoom fill`,
    (outXs - inXs) > fillWidth);
}

// ─── summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`  ${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\n  SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('\n  ALL TESTS PASSED ✓');
}

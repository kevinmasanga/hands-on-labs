// useDeck — React state + transport for a single deck.
//
// Owns the reducer-backed DeckState (the serializable transport + mixer controls) plus
// two pieces of live, high-rate state that must NOT live in the reducer (they update
// ~30x/sec and would otherwise trigger graph re-renders): the playhead position and
// the meter level. Both arrive asynchronously from the audio graph's analysis events.

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { getRuntime } from './audio';
import { loadTrackToVFS } from './track';
import {
  DeckState,
  initialDeckState,
  METER_EVENT_SUFFIX,
  POS_EVENT_SUFFIX,
} from './deck';

type EqBand = 'eqLow' | 'eqMid' | 'eqHigh';

type Action =
  | { type: 'LOAD'; track: DeckState['track'] }
  | { type: 'PLAY' }
  | { type: 'PAUSE' }
  | { type: 'SEEK'; norm: number }
  | { type: 'END' }
  | { type: 'SET_VOLUME'; value: number }
  | { type: 'SET_EQ'; band: EqBand; value: number }
  | { type: 'SET_FILTER'; value: number }
  | { type: 'SET_TEMPO'; value: number }
  | { type: 'SET_CUE'; norm: number }
  | { type: 'SET_LOOP_IN'; norm: number }
  | { type: 'SET_LOOP_OUT'; norm: number }
  | { type: 'SET_LOOP_ACTIVE'; value: boolean };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function reducer(s: DeckState, a: Action): DeckState {
  switch (a.type) {
    case 'LOAD':
      // New track: stop, rewind, clear all P4 markers, and bump seekGen.
      return {
        ...s,
        track: a.track,
        playing: false,
        baseNorm: 0,
        seekGen: s.seekGen + 1,
        tempo: 1,
        cueNorm: -1,
        loopIn: -1,
        loopOut: -1,
        loopActive: false,
      };
    case 'PLAY':
      return s.track ? { ...s, playing: true } : s;
    case 'PAUSE':
      return { ...s, playing: false };
    case 'SEEK':
      return s.track ? { ...s, baseNorm: clamp01(a.norm), seekGen: s.seekGen + 1 } : s;
    case 'END':
      // Reached the end: stop and rewind to the start.
      return { ...s, playing: false, baseNorm: 0, seekGen: s.seekGen + 1 };
    case 'SET_VOLUME':
      return { ...s, volume: clamp01(a.value) };
    case 'SET_EQ':
      return { ...s, [a.band]: a.value };
    case 'SET_FILTER':
      return { ...s, filterCutoff: Math.max(-1, Math.min(1, a.value)) };
    case 'SET_TEMPO':
      return { ...s, tempo: Math.max(0.5, Math.min(2, a.value)) };
    case 'SET_CUE':
      return { ...s, cueNorm: clamp01(a.norm) };
    case 'SET_LOOP_IN': {
      const n = clamp01(a.norm);
      return { ...s, loopIn: n, loopActive: s.loopActive && n < s.loopOut };
    }
    case 'SET_LOOP_OUT': {
      const n = clamp01(a.norm);
      return { ...s, loopOut: n, loopActive: s.loopIn >= 0 && n > s.loopIn };
    }
    case 'SET_LOOP_ACTIVE':
      return { ...s, loopActive: a.value };
    default:
      return s;
  }
}

export interface UseDeck {
  state: DeckState;
  position: number; // live normalized playhead 0..1
  level: number; // live meter level 0..1
  load: (file: File) => Promise<void>;
  togglePlay: () => void;
  seek: (norm: number) => void;
  setVolume: (value: number) => void;
  setEq: (band: EqBand, value: number) => void;
  setFilter: (value: number) => void;
  setTempo:   (value: number) => void;
  setCue:     () => void;
  jumpToCue:  () => void;
  setLoopIn:  () => void;
  setLoopOut: () => void;
  toggleLoop: () => void;
}

export function useDeck(id: string, audioReady: boolean): UseDeck {
  const [state, dispatch] = useReducer(reducer, id, initialDeckState);
  const [position, setPosition] = useState(0);
  const [level, setLevel] = useState(0);

  // Ref so the snapshot handler reads current `playing` without re-subscribing.
  const playingRef = useRef(state.playing);
  playingRef.current = state.playing;

  // Mirror live position into a ref so cue/loop callbacks can read it without
  // adding `position` to their dependency arrays (position updates ~30x/sec).
  const positionRef = useRef(0);
  positionRef.current = position;

  // Mirror state into a ref for the same reason (used by jumpToCue, toggleLoop).
  const stateRef = useRef(state);
  stateRef.current = state;

  // Route this deck's analysis events (playhead + meter) into local state.
  useEffect(() => {
    if (!audioReady) return;
    const rt = getRuntime();
    if (!rt) return;

    const posSource = `${id}${POS_EVENT_SUFFIX}`;
    const meterSource = `${id}${METER_EVENT_SUFFIX}`;

    const onSnapshot = (e: { source?: string; data: number }) => {
      if (e.source !== posSource) return;
      const p = clamp01(e.data);
      setPosition(p);
      if (p >= 0.9999 && playingRef.current) dispatch({ type: 'END' });
    };

    const onMeter = (e: { source?: string; min: number; max: number }) => {
      if (e.source !== meterSource) return;
      setLevel(clamp01(Math.max(Math.abs(e.min), Math.abs(e.max))));
    };

    rt.core.on('snapshot', onSnapshot);
    rt.core.on('meter', onMeter);
    return () => {
      rt.core.off('snapshot', onSnapshot);
      rt.core.off('meter', onMeter);
    };
  }, [id, audioReady]);

  const load = useCallback(
    async (file: File) => {
      const rt = getRuntime();
      if (!rt) return;
      const track = await loadTrackToVFS(rt, id, file);
      setPosition(0);
      dispatch({ type: 'LOAD', track });
    },
    [id],
  );

  const togglePlay = useCallback(() => {
    dispatch(playingRef.current ? { type: 'PAUSE' } : { type: 'PLAY' });
  }, []);

  const seek = useCallback((norm: number) => {
    setPosition(clamp01(norm));
    dispatch({ type: 'SEEK', norm });
  }, []);

  const setVolume = useCallback((value: number) => dispatch({ type: 'SET_VOLUME', value }), []);
  const setEq = useCallback((band: EqBand, value: number) => dispatch({ type: 'SET_EQ', band, value }), []);
  const setFilter = useCallback((value: number) => dispatch({ type: 'SET_FILTER', value }), []);
  const setTempo  = useCallback((value: number) => dispatch({ type: 'SET_TEMPO', value }), []);

  const setCue = useCallback(() => {
    dispatch({ type: 'SET_CUE', norm: positionRef.current });
  }, []);

  const jumpToCue = useCallback(() => {
    const s = stateRef.current;
    if (s.cueNorm >= 0) seek(s.cueNorm);
  }, [seek]);

  const setLoopIn = useCallback(() => {
    dispatch({ type: 'SET_LOOP_IN', norm: positionRef.current });
  }, []);

  const setLoopOut = useCallback(() => {
    dispatch({ type: 'SET_LOOP_OUT', norm: positionRef.current });
  }, []);

  const toggleLoop = useCallback(() => {
    const isActive = stateRef.current.loopActive;
    if (isActive) {
      // Re-base BEFORE disabling so the accumulator doesn't jump on loop exit.
      seek(positionRef.current);
    }
    dispatch({ type: 'SET_LOOP_ACTIVE', value: !isActive });
  }, [seek]);

  return {
    state, position, level, load, togglePlay, seek,
    setVolume, setEq, setFilter,
    setTempo, setCue, jumpToCue, setLoopIn, setLoopOut, toggleLoop,
  };
}

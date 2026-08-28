// Backtime — the arithmetic. Pure ES module: no DOM, no imports, no mutation of inputs.
//
// Conventions:
//   - every wall-clock value is seconds since midnight (int)
//   - every duration is seconds (int)
//   - durations may be NEGATIVE (a segment running past its planned length). Never clamp them:
//     the negative number is the whole point of a back-timed rundown.

const DAY = 86400;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** "17:00" -> 61200. Also accepts "9:15" and "17:00:30". */
export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(s).trim());
  if (!m) throw new Error(`parseHHMM: cannot parse ${JSON.stringify(s)}`);
  const [h, mi, se] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  if (h > 23 || mi > 59 || se > 59) throw new Error(`parseHHMM: out of range ${s}`);
  return h * 3600 + mi * 60 + se;
}

/** 61200 -> "17:00". 24h, zero-padded, wraps across midnight. */
export function fmtHHMM(sec) {
  const t = ((Math.floor(sec) % DAY) + DAY) % DAY;
  const h = Math.floor(t / 3600);
  const mi = Math.floor((t % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

/** 3620 -> "1:00:20"; 125 -> "2:05". Magnitude only, no sign. */
export function fmtDur(sec) {
  const t = Math.abs(Math.trunc(sec));
  const h = Math.floor(t / 3600);
  const mi = Math.floor((t % 3600) / 60);
  const se = t % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(mi)}:${pad(se)}` : `${mi}:${pad(se)}`;
}

/** 125 -> "+2:05"; -125 -> "-2:05"; 0 -> "0:00". */
export function fmtSigned(sec) {
  const t = Math.trunc(sec);
  if (t === 0) return '0:00';
  return (t > 0 ? '+' : '-') + fmtDur(t);
}

// ---------------------------------------------------------------------------
// Back-time
// ---------------------------------------------------------------------------

/**
 * backtime(i) = hardEndSec - sum(plannedSec[j] for j >= i)
 * -> number[] parallel to segments (seconds since midnight).
 */
export function backtimes(segments, hardEndSec) {
  const out = new Array(segments.length);
  let suffix = 0;
  for (let i = segments.length - 1; i >= 0; i--) {
    suffix += segments[i].plannedSec;
    out[i] = hardEndSec - suffix;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Heavy / light
// ---------------------------------------------------------------------------

const ONTIME_BAND_SEC = 30;

/**
 * state: { segments: [{...fixture fields, plannedSec, actualSec|null, done}],
 *          hardEndSec, currentIndex, status, segmentElapsedSec }
 *
 * remaining = (plannedSec[current] - segmentElapsedSec) + sum(plannedSec[j] for j > current)
 *
 * Completed segments (index < currentIndex) contribute their ACTUAL, never their planned — they
 * do it through `nowSec`, which has already advanced by however long they really took. That is
 * why the readout moves: a segment that ran 2 minutes long pushed `now` 2 minutes further along
 * while removing only its planned 2 minutes from `remaining`.
 *
 * -> { remainingSec, projectedEndSec, deltaSec, state:'HEAVY'|'LIGHT'|'ONTIME' }
 */
export function computeDelta(state, nowSec) {
  const { segments, currentIndex, hardEndSec, segmentElapsedSec } = state;
  let remainingSec = 0;
  if (currentIndex < segments.length) {
    remainingSec = segments[currentIndex].plannedSec - segmentElapsedSec;
    for (let j = currentIndex + 1; j < segments.length; j++) remainingSec += segments[j].plannedSec;
  }
  const projectedEndSec = nowSec + remainingSec;
  const deltaSec = projectedEndSec - hardEndSec;
  return {
    remainingSec,
    projectedEndSec,
    deltaSec,
    state: deltaSec > ONTIME_BAND_SEC ? 'HEAVY' : deltaSec < -ONTIME_BAND_SEC ? 'LIGHT' : 'ONTIME',
  };
}

// ---------------------------------------------------------------------------
// Float solver
// ---------------------------------------------------------------------------

const EXACT_MAX_N = 18;

/**
 * Pick the subset of remaining float segments that covers `deltaSec` with the LEAST OVERSHOOT;
 * among equally good options, the one that cuts the FEWEST SEGMENTS (a producer cuts one thing,
 * not three).
 *
 * -> { cuts:[segment], totalCutSec, landingSec, covers, shortfallSec, exact }
 *    landingSec = deltaSec - totalCutSec   (negative = lands early)
 *    If nothing covers the overage: covers:false, cuts = ALL remaining floats, shortfallSec > 0.
 *    Never reports a cut that does not close the gap.
 */
export function solveFloats(remainingFloatSegments, deltaSec) {
  const floats = remainingFloatSegments;
  const n = floats.length;
  const total = floats.reduce((a, s) => a + s.plannedSec, 0);
  const exact = n <= EXACT_MAX_N;

  // Nothing on the table can close the gap: name every float and the shortfall, honestly.
  if (total < deltaSec) return result(floats, total, deltaSec, exact);

  let best = null; // { mask|list, sum, count }
  if (exact) {
    for (let mask = 0; mask < 1 << n; mask++) {
      let sum = 0;
      let count = 0;
      for (let i = 0; i < n; i++) {
        if (mask & (1 << i)) {
          sum += floats[i].plannedSec;
          count++;
        }
      }
      if (sum < deltaSec) continue;
      const overshoot = sum - deltaSec;
      if (
        best === null ||
        overshoot < best.sum - deltaSec ||
        (overshoot === best.sum - deltaSec && count < best.count)
      ) {
        best = { mask, sum, count };
      }
    }
    const cuts = floats.filter((_, i) => best.mask & (1 << i));
    return result(cuts, best.sum, deltaSec, true);
  }

  // Too many floats to enumerate: greedy descending, and say it is not exact.
  const order = floats.map((s, i) => i).sort((a, b) => floats[b].plannedSec - floats[a].plannedSec);
  const picked = new Set();
  let sum = 0;
  for (const i of order) {
    if (sum >= deltaSec) break;
    picked.add(i);
    sum += floats[i].plannedSec;
  }
  return result(
    floats.filter((_, i) => picked.has(i)),
    sum,
    deltaSec,
    false
  );
}

function result(cuts, totalCutSec, deltaSec, exact) {
  const covers = totalCutSec >= deltaSec;
  return {
    cuts,
    totalCutSec,
    landingSec: deltaSec - totalCutSec,
    covers,
    shortfallSec: covers ? 0 : deltaSec - totalCutSec,
    exact,
  };
}

/**
 * Floats still available to cut: strictly AFTER the current segment (you cannot drop the segment
 * you are already in) and not already done.
 */
export function remainingFloats(state) {
  return state.segments.filter((s, i) => i > state.currentIndex && s.is_float && !s.done);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** data/rundown.json -> initial state. Never mutates the fixture. */
export function loadState(rundownJson) {
  return {
    segments: rundownJson.segments.map((seg, i) => ({
      ...seg,
      id: seg.page ?? String(i),
      plannedSec: Math.round((seg.planned_min ?? 0) * 60),
      actualSec: null,
      done: false,
    })),
    hardEndSec: parseHHMM(rundownJson.hard_end),
    currentIndex: 0,
    status: 'idle',
    segmentElapsedSec: 0,
  };
}

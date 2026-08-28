// Backtime — wiring layer. Owns state, transport, and the tick loop.
// Arithmetic lives in lib/timing.js. Rendering lives in index.html's render(vm).
// This file computes NOTHING about timing itself — it delegates to timing.js.

const KEY = 'backtime.state.v1';
const TICK_MS = 250;

let S = null;          // live state
let render = () => {}; // injected by index.html
let timer = null;

// ---------- wall clock ----------
// clockOffsetSec lets us rehearse at any hour without waiting for 9:15am.
const nowSec = () => {
  const d = new Date();
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + (S?.clockOffsetSec || 0);
};

// Segment starts are snapped to a whole second so that elapsed and wall-clock tick over
// at the same instant; otherwise their floors disagree by 1s half the time.
const alignedNow = () => Math.round(Date.now() / 1000) * 1000;

// ---------- persistence ----------
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} };
const restore = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };

// ---------- history, for BACK ----------
const snapshot = () => {
  const { history, ...rest } = S;
  S.history.push(JSON.stringify(rest));
  if (S.history.length > 50) S.history.shift();
};
const rewind = () => {
  const prev = S.history.pop();
  if (!prev) return false;
  const h = S.history;
  S = { ...JSON.parse(prev), history: h };
  return true;
};

// ---------- elapsed in current segment ----------
function segmentElapsedSec() {
  if (!S.segStartedMs) return 0;
  const pausedNow = S.status === 'paused' && S.pausedAtMs ? Date.now() - S.pausedAtMs : 0;
  // floor, not round — and segStartedMs is second-aligned (see T.start / T.next) so this
  // ticks over in lockstep with nowSec(). Mixed rounding here made the readout jitter +/-1s.
  return Math.max(0, Math.floor((Date.now() - S.segStartedMs - S.pausedAccumMs - pausedNow) / 1000));
}

// ---------- schedule editing ----------
// Starts are the source of truth; durations are DERIVED from consecutive starts (which is
// exactly how scrape_devfest.py built the fixture -- the site publishes start times only).
// So moving one start changes the two adjacent durations, and the back-time column follows.
function recomputeFromStarts() {
  const n = S.segments.length;
  for (let i = 0; i < n; i++) {
    const s = parseHHMM(S.segments[i].start);
    const e = i + 1 < n ? parseHHMM(S.segments[i + 1].start) : S.hardEndSec;
    S.segments[i].plannedSec = Math.max(60, e - s);   // never zero or negative
    S.segments[i].end = fmtHHMM(s + S.segments[i].plannedSec);
  }
}

// Returns null on success, or a reason string the caller can surface.
function setStart(page, hhmm) {
  const i = S.segments.findIndex(s => s.page === page);
  if (i < 0) return 'no such row';
  const norm = String(hhmm).trim()
    .replace(/^(\d{1,2})[.\s]?(\d{2})$/, '$1:$2')      // 1005 / 10.05 -> 10:05
    .replace(/^(\d):/, '0$1:');                         // 9:15 -> 09:15
  const t = parseHHMM(norm);
  if (!Number.isFinite(t)) return 'not a time';
  const prev = i > 0 ? parseHHMM(S.segments[i - 1].start) : -Infinity;
  const next = i + 1 < S.segments.length ? parseHHMM(S.segments[i + 1].start) : S.hardEndSec;
  // A start must stay inside its neighbours, with a minute of room either side.
  if (t <= prev) return `must be after ${fmtHHMM(prev)}`;
  if (t >= next) return `must be before ${fmtHHMM(next)}`;
  snapshot();                       // BACK undoes a schedule edit
  S.segments[i].start = fmtHHMM(t);
  recomputeFromStarts();
  save();
  return null;
}

// ---------- transport ----------
const T = {
  start() {
    if (S.status === 'running') return;
    snapshot();
    if (S.status === 'idle') {
      const bt = backtimes(S.segments, S.hardEndSec)[S.currentIndex];
      const real = nowSec() - S.clockOffsetSec;
      if (real < bt || real > S.hardEndSec) {       // rehearsing outside show hours
        S.clockOffsetSec = bt - real;
        console.warn(`[backtime] rehearsal clock: real time is outside the show window, ` +
          `so the clock is offset to start on time at ${fmtHHMM(bt)}. ` +
          `Backtime.setClock('HH:MM') to move it; Backtime.reset() to clear.`);
      }
    }
    S.status = 'running';
    S.segStartedMs = alignedNow();
    S.pausedAccumMs = 0; S.pausedAtMs = null;
    save();
  },
  next() {
    if (S.status !== 'running' && S.status !== 'paused') return;
    snapshot();
    const cur = S.segments[S.currentIndex];
    if (cur) { cur.actualSec = segmentElapsedSec(); cur.done = true; }
    if (S.currentIndex < S.segments.length - 1) {
      S.currentIndex += 1;
      S.segStartedMs = alignedNow();
      S.pausedAccumMs = 0; S.pausedAtMs = null;
      if (S.status === 'paused') S.status = 'running';
    } else {
      S.status = 'stopped';
    }
    save();
  },
  back() {                       // subsumes UNDO — restores prior state exactly
    if (rewind()) save();
  },
  stop() {
    snapshot();
    S.status = 'stopped';
    save();
  },
  pause() {
    if (S.status === 'running') {
      S.status = 'paused'; S.pausedAtMs = Date.now();
    } else if (S.status === 'paused') {
      S.pausedAccumMs += Date.now() - (S.pausedAtMs || Date.now());
      S.pausedAtMs = null; S.status = 'running';
    }
    save();
  },
  // Mark/unmark a segment as droppable, live. A producer decides what dies mid-show.
  toggleFloat(page) {
    const seg = S.segments.find(s => s.page === page);
    if (!seg) return;
    snapshot();                       // BACK undoes a float toggle too
    seg.is_float = !seg.is_float;
    save();
  },
  setStart(page, hhmm) { return setStart(page, hhmm); },
  // Reset the RUN: clear actuals and return to standby, but KEEP schedule edits,
  // float marks and edited descriptions. Those are prep work; a producer resetting
  // between rehearsals does not want them thrown away. Full wipe is T.resetAll().
  resetRun() {
    snapshot();                       // BACK undoes a reset, so no confirm dialog
    for (const s of S.segments) { s.actualSec = null; s.done = false; }
    S.currentIndex = 0;
    S.status = 'idle';
    S.segStartedMs = null;
    S.pausedAccumMs = 0;
    S.pausedAtMs = null;
    S.editorPage = null;
    save();
  },
  resetAll() {
    S = loadState(FIXTURE);
    S.fixture = FIXTURE; S.history = []; S.clockOffsetSec = 0; S.editorPage = null;
    save();
  },
  reset() { T.resetAll(); },          // console alias; DEMO.md still says Backtime.reset()
};

// ---------- editor ----------
function openEditor(page) {
  const seg = S.segments.find(s => s.page === page);
  if (!seg) return;
  S.editorPage = page;
  paint();
}
function closeEditor() { S.editorPage = null; paint(); }
function saveEditor(text) {
  const seg = S.segments.find(s => s.page === S.editorPage);
  if (seg) seg.description = text;
  S.editorPage = null;
  save(); paint();
}

// ---------- view model ----------
function buildVM() {
  const elapsed = segmentElapsedSec();
  const n = nowSec();
  const bts = backtimes(S.segments, S.hardEndSec);
  const idle = S.status === 'idle';
  const stopped = S.status === 'stopped';

  const d = computeDelta({ ...S, segmentElapsedSec: elapsed }, n);

  // Conference clock: wall-clock countdown to the hard end. Goes negative past 17:00.
  const confLeft = S.hardEndSec - n;
  // Segment clock: time left in the current segment. Goes negative when the segment runs long.
  const cur = S.segments[S.currentIndex];
  const segLeft = cur ? cur.plannedSec - elapsed : 0;

  // Float recommendation only when heavy.
  let recommendation = null;
  if (!idle && !stopped && d.state === 'HEAVY') {
    // strictly AFTER the current index: you cannot drop the segment that is on air
    const floats = S.segments.filter((s, i) => s.is_float && !s.done && i > S.currentIndex);
    const r = solveFloats(floats, d.deltaSec);
    // Page code + a short slug: readable across a room, and it is how a control
    // room actually names a segment ("drop B5") rather than reciting its title.
    const short = t => (t.length > 30 ? t.slice(0, 29).trimEnd() + '…' : t);
    const names = r.cuts.map(c => `${c.page} "${short(c.title)}"`);
    const list = names.length > 1
      ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1]
      : (names[0] || '');
    recommendation = r.covers
      ? { sentence: `Drop ${list} → you land at ${fmtSigned(r.landingSec)}`, covers: true }
      : { sentence: `Cutting every float still leaves you ${fmtSigned(r.shortfallSec)} heavy.`, covers: false };
  }

  const editor = S.editorPage
    ? (seg => seg && {
        page: seg.page, slug: seg.title,
        description: seg.description || '', speakerBio: seg.speaker_bio || '',
      })(S.segments.find(s => s.page === S.editorPage))
    : null;

  return {
    status: S.status,
    readout: idle
      ? { text: '0:00', label: 'STANDBY', state: 'ONTIME' }
      : stopped
        ? { text: '0:00', label: 'STOPPED', state: 'ONTIME' }
        : { text: fmtSigned(d.deltaSec), label: d.state, state: d.state },
    conferenceClock: { text: fmtDur(Math.abs(confLeft)), negative: confLeft < 0 },
    segmentClock: idle
      ? { text: fmtDur(cur ? cur.plannedSec : 0), negative: false }
      : stopped
        ? { text: '0:00', negative: false }
        : { text: fmtDur(Math.abs(segLeft)), negative: segLeft < 0 },
    recommendation,
    rows: S.segments.map((s, i) => ({
      page: s.page,
      slug: s.title,
      speaker: s.speakers || '',
      duration: fmtDur(s.plannedSec),
      start: s.start,
      end: s.end,
      backtime: fmtHHMM(bts[i]),
      isFloat: !!s.is_float,
      done: !!s.done,
      current: i === S.currentIndex && !idle,
      variance: s.done && s.actualSec != null ? fmtSigned(s.actualSec - s.plannedSec) : null,
      varianceState: s.done && s.actualSec != null
        ? (s.actualSec > s.plannedSec ? 'over' : 'under') : null,
    })),
    editor,
  };
}

const paint = () => render(buildVM());

// ---------- boot ----------
function init(renderFn) {
  render = renderFn;
  const fixture = FIXTURE;
  const saved = restore();
  S = saved && saved.segments?.length ? saved : loadState(fixture);
  S.fixture = fixture;
  S.history = S.history || [];
  S.clockOffsetSec = S.clockOffsetSec || 0;
  S.editorPage = null;

  clearInterval(timer);
  timer = setInterval(paint, TICK_MS);
  paint();
}

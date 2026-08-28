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
  return Math.max(0, Math.round((Date.now() - S.segStartedMs - S.pausedAccumMs - pausedNow) / 1000));
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
    S.segStartedMs = Date.now();
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
      S.segStartedMs = Date.now();
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
  reset() {
    S = loadState(FIXTURE);
    S.fixture = FIXTURE; S.history = []; S.clockOffsetSec = 0; S.editorPage = null;
    save();
  },
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

  const d = computeDelta({ ...S, segmentElapsedSec: elapsed }, n);

  // Conference clock: wall-clock countdown to the hard end. Goes negative past 17:00.
  const confLeft = S.hardEndSec - n;
  // Segment clock: time left in the current segment. Goes negative when the segment runs long.
  const cur = S.segments[S.currentIndex];
  const segLeft = cur ? cur.plannedSec - elapsed : 0;

  // Float recommendation only when heavy.
  let recommendation = null;
  if (!idle && d.state === 'HEAVY') {
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
      ? { text: '—', label: 'STANDBY', state: 'ONTIME' }
      : { text: fmtSigned(d.deltaSec), label: d.state, state: d.state },
    conferenceClock: { text: fmtDur(Math.abs(confLeft)), negative: confLeft < 0 },
    segmentClock: idle
      ? { text: fmtDur(cur ? cur.plannedSec : 0), negative: false }
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

// Backtime — arithmetic gate. Run: node scripts/verify-timing.mjs
// Prints a hand-checkable report, then asserts. Any failure exits 1.
//
// This runs BEFORE any UI exists and stays the thing you re-run after touching lib/timing.js.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseHHMM,
  fmtHHMM,
  fmtDur,
  fmtSigned,
  backtimes,
  computeDelta,
  solveFloats,
  remainingFloats,
  loadState,
} from '../lib/timing.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rundown = JSON.parse(readFileSync(join(ROOT, 'data/rundown.json'), 'utf8'));

const failures = [];
function check(label, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failures.push(label);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
}
function eq(label, actual, expected) {
  check(label, actual === expected, `(got ${actual}, want ${expected})`);
}
const slug = (s, n = 34) => (s.length > n ? s.slice(0, n - 1) + '…' : s).padEnd(n);
const head = (t) => console.log(`\n${t}\n${'-'.repeat(t.length)}`);

// ---------------------------------------------------------------------------
head('1. Back-time table — the real DevFest DC rundown');

const state = loadState(rundown);
const bts = backtimes(state.segments, state.hardEndSec);
const totalPlanned = state.segments.reduce((a, s) => a + s.plannedSec, 0);

console.log(`hard_end ${rundown.hard_end} (${state.hardEndSec}s)   ` +
  `${state.segments.length} segments   ${totalPlanned}s = ${totalPlanned / 60} min of content\n`);
console.log(`  PG   ${slug('SLUG')} ${'PLANNED'.padStart(8)}  ${'BACK-TIME'}  FLOAT`);
state.segments.forEach((s, i) => {
  console.log(
    `  ${s.page.padEnd(4)} ${slug(s.title)} ${fmtDur(s.plannedSec).padStart(8)}  ` +
      `  ${fmtHHMM(bts[i])}     ${s.is_float ? 'FLOAT' : ''}`
  );
});
console.log(`  ${' '.repeat(5)}${' '.repeat(34)} ${'hard end'.padStart(8)}    ${fmtHHMM(state.hardEndSec)}`);

console.log('\n  Hand calculation: 465 min of content ending 17:00 must start at 09:15.');
eq('first back-time is 09:15', fmtHHMM(bts[0]), '09:15');
eq('last back-time + its planned = hard end', bts.at(-1) + state.segments.at(-1).plannedSec, state.hardEndSec);
eq('planned total is 465 min', totalPlanned, 465 * 60);

// ---------------------------------------------------------------------------
head('2. Synthetic 3-segment rundown — 10m, 20m, 30m, hard end 12:00');

const syn = [
  { title: 'A', plannedSec: 600 },
  { title: 'B', plannedSec: 1200 },
  { title: 'C', plannedSec: 1800 },
];
const synHardEnd = parseHHMM('12:00');
const synBts = backtimes(syn, synHardEnd);
syn.forEach((s, i) => console.log(`  ${s.title}  ${fmtDur(s.plannedSec).padStart(6)}  -> ${fmtHHMM(synBts[i])}`));
eq('A back-times to 11:00', fmtHHMM(synBts[0]), '11:00');
eq('B back-times to 11:10', fmtHHMM(synBts[1]), '11:10');
eq('C back-times to 11:30', fmtHHMM(synBts[2]), '11:30');

// ---------------------------------------------------------------------------
head('3. A 2:00 segment that actually ran 4:00 moves the delta by exactly +2:00');

const now = parseHHMM('11:04');
const before = {
  segments: [
    { title: 'Demo', plannedSec: 120, actualSec: null, done: false },
    { title: 'Talk', plannedSec: 600, actualSec: null, done: false },
    { title: 'Q&A', plannedSec: 600, actualSec: null, done: false },
  ],
  // 22 min of content starting 11:00 -> the show was planned to make 11:22 exactly.
  hardEndSec: parseHHMM('11:22'),
  currentIndex: 0,
  status: 'running',
  segmentElapsedSec: 240, // 4:00 into a 2:00 segment — 2 minutes over, not yet tapped
};
// NEXT: the segment is completed with its ACTUAL 4:00 and we advance. Same wall-clock instant.
const after = {
  ...before,
  segments: [
    { ...before.segments[0], actualSec: 240, done: true },
    before.segments[1],
    before.segments[2],
  ],
  currentIndex: 1,
  segmentElapsedSec: 0,
};
const d0 = computeDelta(before, now);
const d1 = computeDelta(after, now);
const show = (tag, d) =>
  console.log(
    `  ${tag}  remaining ${fmtSigned(d.remainingSec).padStart(8)}   ` +
      `projected end ${fmtHHMM(d.projectedEndSec)}   delta ${fmtSigned(d.deltaSec).padStart(7)}  ${d.state}`
  );
console.log(`  now ${fmtHHMM(now)}   hard end ${fmtHHMM(before.hardEndSec)}   planned 2:00 / 10:00 / 10:00`);
show('before NEXT ', d0);
show('after  NEXT ', d1);
eq('delta moves by exactly +120s', d1.deltaSec - d0.deltaSec, 120);
eq('before NEXT the show reads ON TIME', d0.state, 'ONTIME');
eq('after NEXT the show is HEAVY', d1.state, 'HEAVY');
eq('after NEXT it is heavy by exactly +2:00', fmtSigned(d1.deltaSec), '+2:00');

// The delta is a segment-boundary number: it holds steady while a segment runs (elapsed and now
// advance together) and jumps when NEXT banks the actual. The per-segment clock is what counts
// past zero live. Do not "fix" this by clamping remaining at 0 — that kills the +2:00 jump above.
const midSegment = computeDelta({ ...before, segmentElapsedSec: 300 }, now + 60);
eq('delta holds steady mid-segment', midSegment.deltaSec, d0.deltaSec);

// ---------------------------------------------------------------------------
head('4. Float solver on the real rundown — deltaSec = 20:00 heavy');

const floats = remainingFloats(state);
console.log(`  remaining floats (${floats.length}):`);
floats.forEach((f) => console.log(`    ${f.page}  ${slug(f.title, 24)} ${fmtDur(f.plannedSec).padStart(8)}`));
const heavy20 = 20 * 60;
const sol = solveFloats(floats, heavy20);
console.log(`\n  delta ${fmtSigned(heavy20)} HEAVY`);
console.log(`  -> Drop ${sol.cuts.map((c) => `"${c.title}"`).join(' and ')} ` +
  `→ you land at ${fmtSigned(sol.landingSec)}.`);
console.log(`     totalCut ${fmtDur(sol.totalCutSec)}  covers ${sol.covers}  exact ${sol.exact}`);
check('cut covers the overage', sol.totalCutSec >= heavy20, `(${sol.totalCutSec} >= ${heavy20})`);
check('did not cut all four floats when fewer suffice', sol.cuts.length < floats.length,
  `(cut ${sol.cuts.length} of ${floats.length})`);
eq('landing = delta - totalCut', sol.landingSec, heavy20 - sol.totalCutSec);
check('covers:true', sol.covers === true);

// ---------------------------------------------------------------------------
head('5. Tiebreak — fewest segments cut');

const tie = [
  { title: 'Big', plannedSec: 600 },
  { title: 'Small A', plannedSec: 300 },
  { title: 'Small B', plannedSec: 300 },
];
const tieSol = solveFloats(tie, 600);
console.log(`  floats [10:00, 5:00, 5:00], delta +10:00`);
console.log(`  -> cuts ${tieSol.cuts.map((c) => c.title).join(', ')}  (${tieSol.cuts.length} segment(s))`);
eq('cuts exactly one segment', tieSol.cuts.length, 1);
eq('cuts the single 600s segment', tieSol.cuts[0].plannedSec, 600);
eq('zero overshoot', tieSol.landingSec, 0);

// ---------------------------------------------------------------------------
head('6. No-cover case — deltaSec = 3:00:00 heavy');

const heavy3h = 3 * 3600;
const noCover = solveFloats(floats, heavy3h);
const sentence = `Cutting every float still leaves you ${fmtSigned(noCover.shortfallSec)} heavy.`;
console.log(`  delta ${fmtSigned(heavy3h)}   all floats total ${fmtDur(noCover.totalCutSec)}`);
console.log(`  UI says: "${sentence}"`);
check('covers:false', noCover.covers === false);
eq('cuts = every remaining float', noCover.cuts.length, floats.length);
eq('shortfall is correct', noCover.shortfallSec, heavy3h - floats.reduce((a, f) => a + f.plannedSec, 0));
check('shortfall is positive', noCover.shortfallSec > 0, `(${noCover.shortfallSec}s)`);
eq('shortfall renders as +1:00:00', fmtSigned(noCover.shortfallSec), '+1:00:00');

// ---------------------------------------------------------------------------
head('7. Formatters');

eq('parseHHMM("17:00")', parseHHMM('17:00'), 61200);
eq('parseHHMM("09:15")', parseHHMM('09:15'), 33300);
eq('fmtHHMM(61200)', fmtHHMM(61200), '17:00');
eq('fmtDur(3620)', fmtDur(3620), '1:00:20');
eq('fmtDur(125)', fmtDur(125), '2:05');
eq('fmtSigned(125)', fmtSigned(125), '+2:05');
eq('fmtSigned(-125)', fmtSigned(-125), '-2:05');
eq('fmtSigned(0)', fmtSigned(0), '0:00');

// ---------------------------------------------------------------------------
console.log('');
if (failures.length) {
  console.log(`${failures.length} CHECK(S) FAILED:`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('ALL CHECKS PASSED');

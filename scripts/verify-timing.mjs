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
head('3. An overrun accumulates LIVE, and NEXT does not double-count it');

// The on-air segment's remaining time is clamped at zero. Consequence: while a segment
// runs long the readout gets heavier every second (rather than sitting still until the
// operator taps), and banking the actual on NEXT changes nothing — the overage was
// already counted. Continuity across NEXT is the property that matters: a number that
// jumps on a tap is a number an operator learns to distrust.
const now0 = parseHHMM('11:00');
const base = {
  segments: [
    { title: 'Demo', plannedSec: 120, actualSec: null, done: false },
    { title: 'Talk', plannedSec: 600, actualSec: null, done: false },
    { title: 'Q&A', plannedSec: 600, actualSec: null, done: false },
  ],
  // 22 min of content starting 11:00 -> the show was planned to make 11:22 exactly.
  hardEndSec: parseHHMM('11:22'),
  currentIndex: 0,
  status: 'running',
  segmentElapsedSec: 0,
};
const at = (elapsed) => computeDelta({ ...base, segmentElapsedSec: elapsed }, now0 + elapsed);
console.log(`  now 11:00   hard end ${fmtHHMM(base.hardEndSec)}   planned 2:00 / 10:00 / 10:00`);
for (const e of [0, 60, 120, 180, 240]) {
  const d = at(e);
  console.log(`  elapsed ${fmtDur(e).padStart(5)}  delta ${fmtSigned(d.deltaSec).padStart(7)}  ${d.state}`);
}
eq('on plan at 0:00 -> ON TIME', at(0).state, 'ONTIME');
eq('still on plan at 2:00 -> 0:00', fmtSigned(at(120).deltaSec), '0:00');
eq('1:00 over -> +1:00 live, without any tap', fmtSigned(at(180).deltaSec), '+1:00');
eq('2:00 over -> +2:00 live, without any tap', fmtSigned(at(240).deltaSec), '+2:00');
eq('2:00 over reads HEAVY', at(240).state, 'HEAVY');

// ... and tapping NEXT at that instant must not move it again.
const d0 = at(240);
const d1 = computeDelta({
  ...base,
  segments: [{ ...base.segments[0], actualSec: 240, done: true }, base.segments[1], base.segments[2]],
  currentIndex: 1,
  segmentElapsedSec: 0,
}, now0 + 240);
console.log(`  before NEXT ${fmtSigned(d0.deltaSec)}   after NEXT ${fmtSigned(d1.deltaSec)}`);
eq('NEXT does not double-count the overrun', d1.deltaSec - d0.deltaSec, 0);
eq('after NEXT still +2:00 HEAVY', fmtSigned(d1.deltaSec), '+2:00');

// Finishing EARLY still snaps lighter on the tap: unspent planned time is released.
const early = computeDelta({
  ...base,
  segments: [{ ...base.segments[0], actualSec: 60, done: true }, base.segments[1], base.segments[2]],
  currentIndex: 1,
  segmentElapsedSec: 0,
}, now0 + 60);
eq('finishing 1:00 early -> -1:00 LIGHT', fmtSigned(early.deltaSec), '-1:00');

// While a segment is running to plan, the delta must be perfectly STILL — elapsed and the wall
// clock advance together and cancel. A readout that twitches by a second is a readout nobody
// trusts. (The twitch that shipped came from mixed rounding in the caller, not from here:
// nowSec() truncated one Date while segmentElapsedSec() rounded another.) Once the segment
// goes OVER, the clamp above takes effect and the overage accumulates second by second.
const still = [0, 15, 30, 60, 90, 119].map((e) => at(e).deltaSec);
eq('delta is perfectly still while on plan', new Set(still).size, 1);
eq('  ... and that value is 0:00', fmtSigned(still[0]), '0:00');
const over = [121, 122, 123].map((e) => at(e).deltaSec);
eq('delta advances 1s per second once over', JSON.stringify(over), JSON.stringify([1, 2, 3]));

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

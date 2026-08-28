# Backtime — demo runbook

**Open:** double-click `index.html`. No server, no build, no network. If a browser blocks local
files, `python3 -m http.server 8731` and open `http://127.0.0.1:8731/index.html` — but you should
not need it.

## Before you present (30 seconds, do it every time)

Open the browser console and run:

```js
Backtime.reset()            // clears localStorage, back to a clean rundown
Backtime.setClock('09:15')  // put the clock at the top of the show
```

**Why this matters:** the arithmetic is honest. If it is 2pm and you start the rundown from A1, you
really are ~5 hours heavy, and the readout will say so. `setClock` puts you at the top of the show
so the numbers read the way the story needs. On the actual day, during the actual show, do not use
it — the real wall clock is the point.

## The 90 seconds

1. *"Anyone who has run a schedule against a hard stop has had this moment."*
   Screen is showing today's real DevFest DC rundown — keynote plus Track 1, scraped from
   devfestdc.org this morning. Back-timed from the 5pm happy hour, which does not move.
2. Hit **START**. Readout reads `0:00 ONTIME`.
3. *"Nathen's keynote is planned for 45 minutes. Watch what happens when it runs long."*
   The readout is still while you are on plan. The moment the segment passes 45:00 it
   **starts climbing, a second at a time** — `+0:01`, `+0:02`, `+0:30` — and the segment
   clock flips red to `OVER`. Let it run visibly.
4. At `+4:00 HEAVY` the cut appears beneath it:
   > **Drop B3 "Turnaround" → you land at −1:00**

   Hit **NEXT**. The number does **not** move — the overage was already counted. That
   continuity is the point: a readout that jumps when you tap is one an operator
   learns to distrust.
5. *"That's back-timing and floats. It's how a control room has run a live show for fifty years —
   it has just never been in the hands of anyone running a meeting."*

**Do not overrun by more than about 5 minutes in rehearsal.** The floats are 5 / 55 / 5 / 55 min.
Past ~5 min of overage the solver correctly reaches for the 55-minute Lunch and the landing figure
gets ugly (`−35:00`). Four minutes is the clean beat.

## Changing a start time

**Double-click any START cell**, type a new time, Enter. `1020`, `10:20` and `9:15` all parse.
Esc cancels.

Starts are the source of truth and **durations are derived from consecutive starts** — the same
rule `scrape_devfest.py` used to build the fixture, because the site publishes start times only.
So moving B1 from 10:00 to 10:10 stretches A1 from 45:00 to 55:00, shrinks B1 to 40:00, and the
END and BACKTIME columns follow. Total planned time is conserved.

A start that would cross its neighbours is refused, with the reason in the tooltip
(*"must be after 09:15"*) and the field left open so you can correct it. Nothing is silently
clamped. **BACK undoes a schedule edit.**

## Floating a row live

**Click the FLOAT cell on any row to mark it droppable.** Click again to unmark. A floated row
turns **red across the whole line** — it is the thing that dies when you go heavy, and that
should be readable from the back of the room. Unfloating removes the red. The chip itself stays
invisible until you hover, so the table stays clean.

This is the control that matters when the day goes badly. Out of the box only the breaks are
floats — two turnarounds, lunch, and the buffer, 120 minutes total. When the overage is bigger
than that, the tool says so honestly rather than inventing a cut:

> *Cutting every float still leaves you +1:00:00 heavy.*

That is your cue to float an actual session. Click FLOAT on a 50-minute breakout and the solver
picks it up immediately. **BACK undoes a float toggle**, including one made before START.

Cuts are named by page code and short slug — `Drop B3 "Turnaround"` — the way a control room
names a segment, not by reciting its full title.

The segment currently on air is never offered as a cut. You cannot drop what is already playing.

## If something goes wrong on stage

- Mis-tapped **NEXT** → hit **BACK**. It restores the prior state exactly. Verified.
- **STOP** zeroes the readout and the segment clock (`0:00 / STOPPED`). The conference
  clock keeps running — it is a wall clock to 17:00 and does not care whether you are
  in a segment.
- Numbers look wrong → `Backtime.reset()` then `Backtime.setClock('09:15')`.
- Want to jump elsewhere in the day → `Backtime.setClock('13:30')`.

## What to say if asked "is this live data?"

Yes, and deliberately frozen. `scripts/scrape_devfest.py` pulled the real schedule this morning;
`data/rundown.json` is the frozen result. The app never touches the network — that is a design
decision, not a limitation. A timing tool that needs wifi is a timing tool that fails in the room
where you need it.

## What is derived, not published (be honest if asked)

- devfestdc.org publishes **start times only**. Durations are derived from the gap to the next
  start, capped at 50 min, with the remainder emitted as an explicit float (turnaround / lunch /
  buffer). Every duration is editable.
- The 17:00 hard end comes from the homepage happy-hour slot, not the sessions page.

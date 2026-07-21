import { LADDER, MAX_GUESSES } from "@/lib/gameState";

// Six rows, one per guess. Past rows show what happened; the current row
// is outlined; future rows show how many seconds they'd unlock.
//
// The stages aren't evenly spaced — 1·2·4·7·11·16, growing by 1,2,3,4,5 —
// so each row carries a bar scaled to its own length. The widening steps
// are the shape of the game, and they should be visible, not just written.

const LONGEST = LADDER[LADDER.length - 1];

export default function GuessLadder({ guesses, status }) {
  const rows = [];
  for (let i = 0; i < MAX_GUESSES; i++) {
    const g = guesses[i];
    let cls = "ladder-row";
    let content;

    if (g) {
      cls += g.type === "skip" ? " row-skip" : " row-wrong";
      content = g.type === "skip" ? "Skipped" : g.label;
    } else if (i === guesses.length && status === "playing") {
      cls += " row-current";
      content = `Guess ${i + 1}`;
    } else {
      cls += " row-locked";
      content = `Guess ${i + 1}`;
    }

    rows.push(
      <li
        key={i}
        className={cls}
        style={{ "--w": `${(LADDER[i] / LONGEST) * 100}%` }}
      >
        <span className="row-num mono">{i + 1}</span>
        <span className="row-text">{content}</span>
        <span className="row-secs mono">{LADDER[i]}s</span>
      </li>
    );
  }

  return <ol className="ladder">{rows}</ol>;
}

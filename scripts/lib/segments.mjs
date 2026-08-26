// Where the demo video's five pieces begin and end.
//
// One table, imported by the recorder and by the assembler, because the two
// have to agree about it exactly: a recorder that thinks a segment is 34
// seconds and an assembler that thinks it is 33 produce a video whose narration
// slides a second later with every cut.
//
// The times are the ones in docs/demo-script.json. Nothing here is chosen; each
// boundary is where a run of related shots ends in the script.
export const SEGMENT_SLOTS = [
  { id: "a", from: "00:00.000", to: "00:16.000", what: "README, then the landing page" },
  {
    id: "b",
    from: "00:16.000",
    to: "01:16.000",
    what: "the arcade: pay, play, then the price and the honesty panel",
  },
  {
    id: "c",
    from: "01:16.000",
    to: "01:50.000",
    what: "the merchant dashboard, the printable counter code, and the QR encoder",
  },
  {
    id: "d",
    from: "01:50.000",
    to: "02:37.000",
    what: "the live mainnet payment",
    // Not automatable, and named as such rather than left out. A missing entry
    // would silently shorten the video by forty-seven seconds and the narration
    // would run over the end.
    owner: "the owner signs this one at the desk",
  },
  {
    id: "e",
    from: "02:37.000",
    to: "03:00.000",
    what: "the transaction manifest, what it does not prove, and the close",
  },
];

/** mm:ss.mmm to seconds. */
export const seconds = (stamp) => {
  const m = /^(\d{1,2}):(\d{2})\.(\d{3})$/.exec(stamp);
  if (!m) throw new Error(`not a mm:ss.mmm timestamp: ${stamp}`);
  return Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 1000;
};

/**
 * Fail if the slots do not tile the whole video without gaps or overlaps.
 *
 * Checked rather than trusted: a gap is a black frame in the finished cut and
 * an overlap is a segment that gets truncated, and both are the sort of thing
 * that is only noticed once the video is uploaded.
 */
export function checkSlots(totalSeconds) {
  const problems = [];
  let at = 0;
  for (const slot of SEGMENT_SLOTS) {
    const from = seconds(slot.from);
    const to = seconds(slot.to);
    if (Math.abs(from - at) > 0.001) {
      problems.push(`segment ${slot.id} starts at ${slot.from}, and ${at.toFixed(3)}s is where the last one ended`);
    }
    if (to <= from) problems.push(`segment ${slot.id} ends at or before it starts`);
    at = to;
  }
  if (totalSeconds !== undefined && Math.abs(at - totalSeconds) > 0.001) {
    problems.push(`the segments cover ${at.toFixed(1)}s and the script runs ${totalSeconds.toFixed(1)}s`);
  }
  return problems;
}

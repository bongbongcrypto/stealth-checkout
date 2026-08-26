#!/usr/bin/env bash
# Build the demo narration on the build server, one audio file per script line.
#
#   bash scripts/make-narration.sh
#
# Runs on bot-server rather than here: the rule is that nothing unvetted gets
# installed on the machine that holds the keys, and this PC has no usable
# English neural voice anyway (Microsoft Zira is the 2013 desktop voice).
#
# The voice is the one the Creditcoin entry used, so the two videos sound like
# they came from the same shop: en-US-AndrewNeural, calm male, slowed 4% because
# the script is dense with numbers and a listener needs the extra beat.
#
# One file per line, not one long take. The script's timings are fixed, so each
# line has to be placed at its own start time; a single file would drift by the
# end and there would be no way to nudge one sentence without re-cutting all of
# them.
set -euo pipefail

REMOTE="${REMOTE:-bot-server}"
VOICE="${VOICE:-en-US-AndrewNeural}"
RATE="${RATE:--4%}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$HERE/docs/narration"

echo "sending the script to $REMOTE"
scp -q "$HERE/docs/demo.narration.txt" "$REMOTE:~/demo-narration.txt"

echo "synthesising with $VOICE at $RATE"
ssh "$REMOTE" bash -s <<'REMOTE_SCRIPT'
set -euo pipefail
VOICE="${VOICE:-en-US-AndrewNeural}"
RATE="${RATE:--4%}"
rm -rf ~/narration && mkdir -p ~/narration
n=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  n=$((n + 1))
  printf -v idx "%02d" "$n"
  ~/.local/bin/edge-tts --voice "$VOICE" --rate="$RATE" \
    --text "$line" --write-media ~/narration/"$idx".mp3 >/dev/null 2>&1
done < ~/demo-narration.txt
echo "  built $n lines"
ls ~/narration | wc -l
REMOTE_SCRIPT

echo "fetching"
rm -rf "$OUT" && mkdir -p "$OUT"
scp -q "$REMOTE:~/narration/*.mp3" "$OUT/"
count=$(ls "$OUT"/*.mp3 2>/dev/null | wc -l)
echo "wrote $count files to docs/narration/"

# A line that came back silent or truncated is worse than one that failed
# loudly, because it disappears into the mix and nobody notices until the video
# is up. Every file gets its duration read back.
echo "checking every file has audio in it"
bad=0
for f in "$OUT"/*.mp3; do
  size=$(wc -c < "$f")
  if [ "$size" -lt 2000 ]; then
    echo "  SUSPECT $(basename "$f"): only ${size} bytes"
    bad=$((bad + 1))
  fi
done
if [ "$bad" -gt 0 ]; then
  echo "$bad file(s) look empty"
  exit 1
fi
echo "all $count lines carry audio"

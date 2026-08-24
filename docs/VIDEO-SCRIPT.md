# 3-minute demo video: shot list

Judges watch this before they read anything.

**No voice-over.** The video is screen capture with subtitles burned in, so the
words are written once, checked, and never mispronounced under time pressure.
The subtitles are generated from a single source:

| File | What it is |
| --- | --- |
| [`demo-subtitles.json`](demo-subtitles.json) | The source. Timing, the English line, the Korean line, and what should be on screen. Edit this one. |
| [`demo.en.srt`](demo.en.srt) | Goes in the video. Judges read English. |
| [`demo.ko.srt`](demo.ko.srt) | The same cues in Korean, for whoever is editing. Not published. |

```bash
node scripts/make-srt.mjs          # rewrite both .srt files
node scripts/make-srt.mjs --check  # validate without writing
```

The generator refuses to write a file whose lines run past 42 characters
(English) or 24 (Korean), or that ask a viewer to read faster than 17 and 12
characters per second. A subtitle nobody finishes reading takes the viewer's
attention and gives nothing back.

Total runtime is exactly 3:00 across 32 cues.

## Recording, on Windows 11 with nothing installed

**Snipping Tool** records the screen: `Win + Shift + S`, then the camcorder
icon, select the region, Start. It writes MP4 to `Videos/Screen Recordings`.
Xbox Game Bar (`Win + G`) does the same and can capture a single window.

Settings that matter:

- **1280x800 or 1920x1080, nothing wider.** A judge may watch on a laptop.
- Browser zoom **110%**, so text survives compression.
- **Hide bookmarks, close every other tab**, and empty the taskbar of anything
  personal. The repo is pseudonymous; the recording should be too.
- No microphone. There is no narration.

Then drop the MP4 and `demo.en.srt` into any editor that takes subtitles
(CapCut, Clipchamp, DaVinci Resolve, all free) and burn them in. Burned in, not
attached: YouTube will not show a sidecar file on an unlisted video reliably,
and a judge should not have to turn subtitles on.

## Before you hit record

1. **Shield ahead of time.** In Ready X, shield **20 STRK** in one go. The pool
   charges a flat 6 STRK per operation, so shielding five times costs 30 STRK in
   fees and shielding once costs 6. Wait for the wallet to show the new Shielded
   balance, about ten blocks. This is also what the widget tells payers to do,
   so the video stays consistent with the product.
2. Start the watcher in a terminal you can show:
   ```bash
   WATCHER_TOKEN=demo WATCHER_ORIGIN=http://127.0.0.1:4173 node server/watcher/watcher.mjs
   ```
3. Start the demo server in a second terminal: `npm run dev`.
4. Open the dashboard at `http://127.0.0.1:4173/apps/dashboard/index.html`,
   paste the watcher URL and the token, and register the invoice you are about
   to pay. Serving the payer page from the same origin as the watcher is what
   makes the server-verified path visible on camera.
5. Tabs, in this order, so the recording is one left-to-right sweep:
   1. `https://github.com/bongbongcrypto/stealth-checkout` (README)
   2. `https://bongbongcrypto.github.io/stealth-checkout/`
   3. `https://bongbongcrypto.github.io/stealth-checkout/apps/demo-arcade/index.html`
   4. `http://127.0.0.1:4173/apps/dashboard/index.html`
   5. the invoice link from step 4
   6. `https://voyager.online/`

**Cost of one take**: 5 STRK paid plus 6 STRK pool fee, out of the 20 shielded.
Two takes fit in one shielding.

## The shots, cue by cue

Each row is one subtitle. `demo-subtitles.json` carries the same `shot` text, so
the two never disagree.

| Time | On screen | Subtitle (English) |
| --- | --- | --- |
| 0:00 | README, "Why" | STRK20 gave Starknet private balances. |
| 0:03 | scroll the sending tools | The ecosystem filled with ways to SEND. |
| 0:08 | README, "Why" paragraph 2 | Run a shop and want to RECEIVE one? |
| 0:14 | same | No checkout, no invoices, no webhook. |
| 0:19 | landing page | Stealth Checkout is that missing half. |
| 0:23 | arcade, top | This arcade is a merchant. |
| 0:28 | circle the widget panel | The panel below is the entire widget. |
| 0:33 | widget steps | Connect, balance, pay, receipt. |
| 0:38 | click INSERT COIN | Insert a coin. |
| 0:44 | credit granted, game starts | The backend confirms and grants the credit. |
| 0:50 | confirmation block | The widget states the price before you sign. |
| 0:55 | highlight the fee row | A flat 6 STRK per operation. |
| 1:01 | highlight "You pay 7, or 13" | STRK20's own docs never say this. |
| 1:07 | the fee warning | So private payments have a floor. |
| 1:13 | honesty panel, PUBLIC rows | What the payment reveals. |
| 1:20 | the RPC and timing rows | Open by default. |
| 1:26 | dashboard | The merchant side. |
| 1:31 | click `qr` on a row | Every row has a QR. |
| 1:37 | creator, switch to counter code | Or print a counter code. |
| 1:43 | the advice text | It reuses one address forever. |
| 1:50 | print preview | The payer stays private either way. |
| 1:56 | `src/qr.ts`, then `npm test` | The QR encoder is written in this repo. |
| 2:02 | invoice page, mainnet | Now mainnet. |
| 2:07 | the unverified-link banner | The page warns the terms are unchecked. |
| 2:13 | same | A link cannot nominate its own auditor. |
| 2:19 | wallet popup, sign | The pool submits it. |
| 2:26 | watcher terminal | The watcher sees it over public RPC. |
| 2:32 | the delta log line | It confirms on the DELTA. |
| 2:39 | webhook log, dashboard goes PAID | A signed webhook goes out. |
| 2:45 | `strk20.json`, `npm test` | Seven mainnet transactions. 196 tests. |
| 2:51 | README, "do not show" | What those transactions do NOT prove. |
| 2:57 | landing page | The accepting side of STRK20. |

### Two shots that need care

**2:02, the unverified-link banner.** Do not hide it. A judge who sees a
checkout admit "nothing here has checked this amount" learns more about the
project than any feature would tell them. Leave it on screen for the full six
seconds.

**2:32, the delta.** The watcher's log prints the baseline and the delta on
separate lines. Zoom the terminal to 16pt or larger before recording; this is
the one shot where an unreadable line costs a scored point.

## After recording

1. Burn in `demo.en.srt`, export at 1080p.
2. Upload unlisted to YouTube.
3. Put the URL in `strk20.json` as `demo_video`.
4. Add the new payment's transaction hash to `transactions` in the same commit.
5. Verify the hash on Voyager, then confirm the hub row updates. It re-reads the
   repo every 30 minutes.

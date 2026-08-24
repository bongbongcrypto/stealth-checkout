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

Generated from `demo-subtitles.json` by `scripts/make-srt.mjs`. Do not edit the
table; edit the cues and run the script.

<!-- shots:start -->

| Time | On screen | Subtitle |
| --- | --- | --- |
| 0:00 | README, the 'Why' section | STRK20 made Starknet balances private. |
| 0:03 | scroll the ecosystem's sending tools | Plenty of ways to send. Claim links, red packets, payroll. |
| 0:08 | README, 'Why', paragraph 2 | Nothing for receiving one. |
| 0:12 | same | No checkout. No invoice. No way for a server to find out it was paid. |
| 0:18 | landing page | We built the receiving side. |
| 0:23 | arcade, top of page | This arcade is the shop. |
| 0:27 | cursor circles the widget | No wallet, no install. |
| 0:31 | widget panel | That panel is the widget. One call puts it on any page. |
| 0:36 | click INSERT COIN, phases run | Insert a coin. |
| 0:42 | credit granted, game starts | The shop's server saw the payment and gave the credit. |
| 0:50 | scroll to the confirmation block | Look at the price before signing. |
| 0:55 | highlight 'You pay 7 STRK' | A 1 STRK coin costs 7. |
| 1:01 | highlight the pool fee row | The pool takes 6 per operation. Flat. The same at 1 and at 1,000. |
| 1:07 | the amber fee warning | STRK20's docs never mention it. We read it off the contract. |
| 1:13 | same | Under 60 STRK the fee passes 10%. Private payment has a floor. |
| 1:20 | honesty panel, the PUBLIC rows | This panel lists what the payment leaks, including what we could not hide. |
| 1:26 | dashboard with live invoices | The shop's side. |
| 1:31 | click 'qr' on a row | Each invoice gets a link and a QR. |
| 1:37 | creator, switch to counter code | Or print one code for the counter. The customer types the amount. |
| 1:43 | the advice text under the selector | A printed code means one address, forever. Anyone can add up the takings. |
| 1:50 | print preview of the counter card | The customer stays anonymous either way. The page says this before you choose. |
| 1:56 | src/qr.ts, then npm test | The QR encoder has no dependency. Checked against ISO 18004. |
| 2:02 | hosted invoice page, real wallet | Mainnet. Real money. |
| 2:07 | the red unverified-link banner | Nothing here has checked this link's amount or destination. It says so. |
| 2:13 | same banner | A link cannot vouch for itself, so there is no field for that. |
| 2:19 | wallet popup, sign | Signing. The pool submits it. On chain, the sender is not me. |
| 2:26 | watcher terminal | The watcher polls public RPC. No wallet is open anywhere. |
| 2:32 | the delta log line, zoomed | It counts the increase. Money already sitting there proves nothing. |
| 2:39 | webhook log, dashboard goes PAID | Signed webhook out. Invoice turns PAID. The order ships on its own. |
| 2:45 | strk20.json, then npm test | Seven mainnet transactions. 198 tests. Nine rounds of adversarial audit. |
| 2:51 | README, 'What these do and do not show' | The README also lists what those transactions do not prove. |
| 2:57 | landing page | Stealth Checkout. The receiving side of STRK20. |

<!-- shots:end -->

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

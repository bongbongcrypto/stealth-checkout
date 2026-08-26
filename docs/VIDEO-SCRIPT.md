# 3-minute demo video

Judges watch this before they read anything.

**Narrated by a synthetic voice, with short-form captions.** Nothing is spoken
live, so the words can be written once, checked, and read at a steady pace.

Everything comes out of one file, [`demo-script.json`](demo-script.json). Edit
that, run the generator, and the narration, the captions and the shot table
below all move together.

```bash
node scripts/make-video-assets.mjs          # write everything
node scripts/make-video-assets.mjs --check  # validate, write nothing
```

| File | What it is |
| --- | --- |
| [`demo-script.json`](demo-script.json) | The source. Timing, the spoken line, a Korean gloss, and what belongs on screen. **Edit this one.** |
| [`demo.narration.txt`](demo.narration.txt) | Paste this into the voice. One sentence per line. |
| [`demo.short.ass`](demo.short.ass) | Short-form captions: three or four words at a time, large, heavy outline, each burst landing with a small bounce. |
| [`demo.en.srt`](demo.en.srt) | The same words as ordinary subtitles, for anyone who wants a plain track. |
| [`demo.ko.srt`](demo.ko.srt) | The Korean gloss, so whoever edits knows what each line means. Never spoken, never on screen. |

The generator refuses to write anything that would not work: a line the voice
cannot fit in its slot, more than three and a half seconds of silence after a
line ends, a caption on screen for under half a second, overlapping cues, or a
dash a voice reads as an unplanned pause.

Current state: 29 lines, 341 words, exactly 3:00, averaging 114 words a minute.
The slack is deliberate. The screen is doing work between sentences.

## The voice

This machine has no usable English neural voice. `Microsoft Zira` is the 2013
desktop voice and sounds like it, and the only natural voice installed is
Korean. Three ways out, best first:

1. **Add the Windows natural voices.** Settings, Time & language, Speech,
   Manage voices, Add voices, English (United States). That installs Aria, Guy
   and Jenny, which are neural and free. They are an operating system component
   rather than third-party code, so they are allowed on this machine under the
   untrusted-code rule. Once they are installed, the audio can be generated
   here into a WAV.
2. **CapCut**, web or desktop. Its text-to-speech and its auto-captions are
   where the short-form look comes from, and it will time the captions to the
   audio it has just generated, which removes the syncing work entirely. The
   web version installs nothing.
3. **ElevenLabs free tier**, if the voice matters more than the convenience.
   `demo.narration.txt` is already public repo content, so pasting it into a
   third-party service gives nothing away.

## The captions

`demo.short.ass` is an Advanced SubStation file, which CapCut, DaVinci Resolve,
Premiere, VLC and ffmpeg all read. The style is one line at the top of the file,
so the look changes there rather than caption by caption.

| Setting | Value | Why |
| --- | --- | --- |
| Font | Arial Black, 96px at 1080p | Reads on a phone held at arm's length |
| Fill and outline | White on a 7px black outline | Survives whatever the screen recording puts behind it |
| Position | Centred, 150px off the bottom | Clear of a player's scrub bar |
| Motion | Overshoot to 112% for two frames, then settle | Each burst lands rather than appearing |

To burn them in without an editor:

```bash
ffmpeg -i recording.mp4 -i narration.wav -vf "ass=docs/demo.short.ass" -c:a aac out.mp4
```

Burn them in rather than attaching them. A judge should not have to turn
subtitles on, and an unlisted YouTube video will not reliably show a sidecar
file.

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
   to pay. **Use a fresh receive address that has never been paid before** — one
   this wallet controls but has not received on. That makes this the first
   genuine end-to-end payment to a real merchant address, which is the one thing
   the seven earlier transactions do not show (they were withdrawals to our own
   address, and the README says so). Serving the payer page from the same origin
   as the watcher is what makes the server-verified path visible on camera.
5. Tabs, in this order, so the recording is one left-to-right sweep:
   1. `https://github.com/bongbongcrypto/stealth-checkout` (README)
   2. `https://bongbongcrypto.github.io/stealth-checkout/`
   3. `https://bongbongcrypto.github.io/stealth-checkout/apps/demo-arcade/index.html`
   4. `http://127.0.0.1:4173/apps/dashboard/index.html`
   5. the invoice link from step 4
   6. `https://voyager.online/`

**Cost of one take**: 5 STRK paid plus 6 STRK pool fee, out of the 20 shielded.
Two takes fit in one shielding.

## Recording, with what Windows 11 already has

**Snipping Tool**: `Win + Shift + S`, the camcorder icon, select the region,
Start. It writes MP4 to `Videos/Screen Recordings`. Xbox Game Bar (`Win + G`)
does the same and can capture a single window.

- **1920x1080, nothing wider.** A judge may watch on a laptop.
- Browser zoom **110%**, so text survives compression.
- **Hide bookmarks, close every other tab**, and clear the taskbar of anything
  personal. The repo is pseudonymous and the recording should be too.
- No microphone. The voice is added afterwards.

Record the screen first, generate the voice second, then lay the captions over
both. Screen action is easier to stretch than speech.

## The shots, line by line

Generated from `demo-script.json`. Do not edit the table; edit the source and
run the generator.

<!-- shots:start -->

| Time | On screen | Narration |
| --- | --- | --- |
| 0:00 | arcade checkout widget, zoomed, ring on the panel | This is Stealth Checkout, a payment box you drop into any website. |
| 0:04 | the honesty summary, ring on the HIDDEN row | Someone pays you privately. The chain never learns who. |
| 0:08 | landing page, top | Starknet could already send money privately. Receiving it? Nobody built that. |
| 0:13 | landing page, the three cards | So we did. |
| 0:16 | arcade, top of page | This arcade is the shop. No wallet, no install, it just runs. |
| 0:21 | cursor circles the widget panel | That panel is the whole widget. One call drops it into any page. |
| 0:27 | click INSERT COIN, the phases run | Drop a coin in. |
| 0:31 | credit granted, the game starts | The shop's server saw the payment and granted the credit. Payment in, product out. |
| 0:38 | scroll up to the confirmation block | Now look at the price before you sign. |
| 0:42 | highlight the total line | A one STRK coin costs seven. |
| 0:46 | highlight the pool fee row | The pool takes six every single time. Flat. Doesn't matter if you move one or a thousand. |
| 0:54 | the amber fee warning | That number is nowhere in STRK20's docs. We read it off the contract ourselves. |
| 1:01 | the same warning, then scroll down | So a private payment has a minimum practical size. Under sixty STRK, fees eat more than ten percent. |
| 1:09 | honesty panel, the public rows | This panel spells out what the payment leaks. Including the parts we couldn't hide. |
| 1:16 | dashboard with live invoices | Merchant side. Every invoice gets a link and a QR. |
| 1:22 | creator, switch to counter code, print preview | Or print one code and stick it on the counter. The customer picks the amount. |
| 1:29 | the advice text under the selector | One printed code means one address forever. Anyone can add up your sales. |
| 1:36 | same | Your customers stay anonymous either way. We tell you that before you choose. |
| 1:43 | src/qr.ts, then the test run | The QR encoder is ours. No dependencies, checked against the ISO spec. |
| 1:50 | hosted invoice page, mainnet, real wallet | Mainnet now. Real money. |
| 1:54 | the red unverified-link banner | See the warning? Nothing here has checked this link's amount or address. We print that in red instead of hiding it. |
| 2:02 | same banner | A link can't vouch for itself. So there's no box here for naming your own auditor. |
| 2:08 | wallet popup, sign | Signing. The pool submits it, so the chain never records me as the sender. |
| 2:15 | watcher terminal, the arrival | The merchant's watcher picks it up off public RPC. No wallet open anywhere. |
| 2:22 | the delta log line, zoomed | It counts what came in, not what's sitting there. Money already on the address proves nothing. |
| 2:30 | webhook log, then the dashboard flips to PAID | Signed webhook fires, the invoice flips to paid, and the order goes out. |
| 2:37 | strk20.json, then the test run | Real mainnet transactions, all verified. Over two hundred tests. Nine rounds of tearing it apart. |
| 2:44 | README, what these do and do not show | And the README also says what those transactions don't prove. |
| 2:50 | landing page | Stealth Checkout, the receiving side of STRK20. MIT licensed. Drop it into your app, and get paid. |

<!-- shots:end -->

### Two shots that need care

**1:54, the unverified-link banner.** Do not hide it. A judge who sees a
checkout admit "nothing here has checked this amount" learns more about the
project than any feature would tell them. Leave it up for the full eight
seconds.

**2:22, the delta.** The watcher's log prints the baseline and the delta on
separate lines. Zoom the terminal to 16pt or larger before recording; this is
the one shot where an unreadable line costs a scored point.

## After recording

1. Generate the voice from `demo.narration.txt`.
2. Lay the recording, the audio and `demo.short.ass` together, and export at
   1080p.
3. Upload to YouTube as **Public**, not unlisted. The sprint rules say
   "Public only. Your repository, your demo, and anything you link must resolve
   for someone who isn't logged in." Unlisted resolves without a login, but the
   rule is worded strictly and Public removes all doubt.
4. Put the URL in `strk20.json` as `demo_video`.
5. You recorded a live payment, so add its transaction hash to `transactions`
   in `strk20.json` (now eight). Because it went to a fresh merchant address,
   also update the README's "What these do and do not show" section: it is no
   longer true that none of them is an end-to-end payment to a merchant. Then
   run `npm run check:claims` — it re-counts everything and fails if any number
   in the docs no longer matches.
6. **Link-check.** Open the YouTube URL in a private window (logged out) and
   confirm it plays. The rules require every linked URL to resolve for someone
   not logged in, and a broken `demo_video` reads as no video at all.
7. Confirm the hub row updates. It re-reads the repo every 30 minutes; the row
   shows a green check against "demo video" once it has read the new URL.

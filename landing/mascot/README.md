# Mindy — the ServerMind mascot

A cute indigo **daemon** — a friendly glowing spirit with big eyes that watch your
server. The name is the metaphor: on Unix/Linux a *daemon* is the quiet background
process that keeps a server running, which is exactly what ServerMind is. Built to
match the app palette (`#08090A` ink, `#5E6AD2` indigo, Geist) and the product's
thesis: *manage your server by talking to it.* The glow from within is its "mind."

| File | What it is |
|------|------------|
| `index.html` | Interactive showcase — inline SVG Mindy that tracks the cursor, blinks, and runs a "talk to it" demo. Open it to preview. |
| `servermind-mascot.json` | Portable **Lottie** export — a clean idle loop (float · blink · mind-glow pulse · arm sway · status LED). 260×280, 30 fps, ~3.3 s. Drop into LottieFiles, Webflow, Framer, or any `lottie-web` player. |

## Preview
```bash
cd landing/mascot
python3 -m http.server 4321   # → http://localhost:4321
```

## Embed the Lottie anywhere
```html
<div id="mindy" style="width:160px;height:160px"></div>
<script src="https://cdn.jsdelivr.net/npm/lottie-web@5.12.2/build/player/lottie.min.js"></script>
<script>
  lottie.loadAnimation({
    container: document.getElementById('mindy'),
    renderer: 'svg', loop: true, autoplay: true,
    path: '/mascot/servermind-mascot.json'
  });
</script>
```

Or the no-JS web component:
```html
<script src="https://unpkg.com/@lottiefiles/lottie-player@latest/dist/lottie-player.js"></script>
<lottie-player src="/mascot/servermind-mascot.json" autoplay loop
  style="width:160px;height:160px"></lottie-player>
```

## Notes
- The **showcase** version (SVG) is the richer one — cursor tracking and the
  talk-to-it interaction can't live in a Lottie loop. Use it for a hero moment.
- The **Lottie** is the drop-in idle loop for places that expect a `.json`
  (LottieFiles library, design tools, lightweight embeds).
- Edit colors in either file by swapping the indigo `#5E6AD2` / `5E6AD2` token.

# Where the Sky Remembers

A hand-painted, storybook flight through procedurally generated floating islands. Fold a paper plane, follow the golden rings, chain combos, and watch the sky drift from golden hour through night and back again.

## Features

- Procedural floating islands, waterfalls, clouds, birds, and golden rings
- Three selectable paper planes: a classic dart, a broad-winged glider, and an origami crane
- Paper-fold morph transitions between planes
- Auto-flight that threads rings for you
- Optional cinematic pan-and-tilt follow camera after one minute of idle time
- Day-to-night cycle with stars, moonlight, shifting fog, and changing lighting
- Synthesized audio, mute persistence, scoring, combos, and endless ring spawning
- Responsive HUD for desktop and smaller screens

## Screenshots

Captured in-game across the full day-night cycle.

| **Golden hour** | **Daylight** |
| --- | --- |
| ![Golden hour above the islands](media/screenshots/01-golden-hour.jpg) | ![Sunlit floating islands](media/screenshots/02-daylight.jpg) |
| **Dusk** | **Deep night** |
| ![Dusk over the cloud sea](media/screenshots/03-dusk.jpg) | ![Night flight beneath the stars](media/screenshots/04-night.jpg) |

## Fly-by Videos

Two ten-second, HUD-free fly-bys captured from the game canvas. Use the players below.

### Day fly-by

<video controls muted loop playsinline preload="metadata" src="https://github.com/user-attachments/assets/503215dd-ae91-4074-8b12-dab7b8e241fa"></video>

[Download daytime MP4](media/videos/day-flyby.mp4) · [WebM](media/videos/day-flyby.webm)

### Night fly-by

<video controls muted loop playsinline preload="metadata" src="https://github.com/user-attachments/assets/161c290f-ff08-4b1a-a51a-883cc4273ed6"></video>

[Download nighttime MP4](media/videos/night-flyby.mp4) · [WebM](media/videos/night-flyby.webm)

All media lives in `media/`. The source clips are 10 seconds, 30 fps, in H.264 MP4 and VP9 WebM. The inline players use WebM so they work in Firefox as well as Chromium-based browsers.

## Controls

| Input | Action |
| --- | --- |
| `WASD` / arrow keys | Steer |
| `Shift` | Hold to soar / boost |
| `1` `2` `3` | Choose a paper plane |
| `F` | Toggle auto-flight |
| `[` / `]` | Adjust auto-flight idle delay |
| `M` | Mute / unmute |
| `Esc` / `P` | Pause |
| `H` | Show flight controls |

### Auto-flight camera

- `WASD` in auto-flight: high / left / low / right camera
- Press the same direction again: close-up / long shot
- One minute of idle time in auto-flight: cinematic pan-and-tilt follow

## Tech

- [Three.js](https://threejs.org/) for the 3D world
- [Vite](https://vite.dev/) for development and builds
- Web Audio API for synthesized sound
- Fontsource for the bundled display fonts
- All textures and audio are generated locally; there are no external asset requests

## Run Locally

Requires Node.js 20.19+ or 22.12+.

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. The dev server is configured to listen on `0.0.0.0`.

## Build

```bash
npm run build
npm run preview
```

The production build is written to `dist/`.

## Deploy to GitHub Pages

This repository includes `.github/workflows/deploy.yml`, which builds and deploys the site with GitHub Actions.

1. Push the repository to GitHub.
2. Open **Settings → Pages**.
3. Under **Build and deployment**, choose **Source: GitHub Actions**.
4. Push to `main` or run the workflow manually from the **Actions** tab.

`vite.config.js` uses a relative base so the same build works both at a custom domain and at a GitHub Pages project URL such as `https://username.github.io/repository/`.

## Project Structure

```text
.
├── index.html
├── package.json
├── package-lock.json
├── vite.config.js
├── media/
│   ├── screenshots/
│   │   ├── 01-golden-hour.jpg
│   │   ├── 02-daylight.jpg
│   │   ├── 03-dusk.jpg
│   │   └── 04-night.jpg
│   └── videos/
│       ├── day-flyby.mp4
│       ├── day-flyby.webm
│       ├── night-flyby.mp4
│       └── night-flyby.webm
├── src/
│   ├── audio.js
│   ├── main.js
│   ├── plane.js
│   ├── style.css
│   ├── utils.js
│   └── world.js
└── .github/workflows/deploy.yml
```

## Built with AI

This project was made by AI using:

- **Tool:** OpenCode
- **Model:** DeepSeek V4.1 Flash Free

## License

MIT — see [LICENSE](LICENSE).

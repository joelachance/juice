# Juice marketing site — build plan

*Static multi-page marketing site for Juice. Keep it **simple**: no framework,
no build step required. Verify claims against `README.md` and `docs/`.*

## Goal

Convince developers and agents that Juice is the simplest way to manage secrets
locally and in production.

Primary CTA: **Get Started** → install (`npm i @juice/sdk && npx juice init`).
Secondary: **GitHub** — https://github.com/satoricorp/juice

## Tech

- Static HTML: `index.html`, with `styles.css` + `site.js`
- Blob display font in `fonts/` (local copy)
- Echo logo (text-ui pattern) with psychedelic swirl fills on echo layers
- No analytics / trackers

## Pages

1. **Home** (`index.html`) — hero + 3 features + FAQ only

Install instructions live in the README rather than a second page, so there is
one place to keep current when the CLI changes.

## Brand

- Display: Blob (outlined in nav; echo + swirl on home hero)
- Accent: amber/juice
- Tagline pitch: "Simple Secrets Management."

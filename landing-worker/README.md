# ArtGod Landing Worker

Single-page landing site served directly by a Cloudflare Worker.

## Files

- `src/index.ts` Worker handler returning the landing HTML.
- `public/intro.jpg` 1024x1024 splash image shown at page top.
- `wrangler.toml` Worker + static assets config.

## Local dev

```sh
cd landing-worker
npx wrangler dev
```

## Deploy

```sh
cd landing-worker
npx wrangler deploy
```

# ApexDEX Enterprise Terminal

Institutional-style decentralized trading terminal demo with live Binance price feeds, candlestick charting, swap routing, flash-loan and pool views, and a security dashboard.

## Run locally
Open `index.html` in a browser, or serve the folder: `npx serve .`

## Deploy to GitHub Pages
1. Create a repository and push this folder to `main`.
2. In **Settings > Pages**, set **Source** to **GitHub Actions**.
3. The included workflow (`.github/workflows/pages.yml`) publishes the site on every push.

```bash
git init -b main
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

## Notes
- Market data comes from Binance public endpoints (WebSocket with REST polling fallback).
- Trading, swap and wallet flows are simulated; no real transactions are sent.
- Dependencies load from CDNs with pinned versions: Tailwind, Lucide, Lightweight Charts, JSZip, ethers.

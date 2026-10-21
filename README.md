# ApexDEX Market Monitor

A clean, dependency-free static market monitor for BTC, ETH, SOL, and ARB. It uses Binance public market data, live WebSocket candles with REST fallback, and an optional browser-wallet connection display.

The order form is explicitly simulation-only. No swap, LP, vault, MEV, or on-chain execution contract is included. Do not add transaction code without a reviewed contract configuration, chain validation, allowance handling, slippage policy, and security review.

## Run locally

```bash
npx serve@14.2.4 .
```

Open the local URL printed by `serve`. A local HTTP server is required for the clean ZIP export button.

## GitHub Pages deployment

1. Create a repository and copy these files into its root.
2. Push the `main` branch.
3. In GitHub, open **Settings → Pages** and select **GitHub Actions** as the source.
4. Wait for the workflow in `.github/workflows/static.yml` to finish.

The app has no Firebase, Gemini/Bard editor, private key, service token, or application secret. Never place a private key or bearer token in frontend source.

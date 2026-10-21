# ApexDEX Enterprise Terminal (v4.0 Quantum Institutional)

Institutional-grade decentralized trading terminal featuring:

- 1x1 & 2x1 multi-chart split view with volume histogram, SMA-20, EMA-50, Bollinger Bands, RSI-14, and on-chart position lines
- Real-time Binance WebSocket + REST depth/kline streams with a 2D market depth canvas and bid/ask imbalance gauge
- Automated risk engine executing Take Profit, Stop Loss, and Liquidations in real time, with Web Audio API chimes
- Multi-hop AMM smart order router, auto-bot MEV flashloan arbitrage simulator, and concentrated LP fee accrual engine
- Web3 wallet connection (EIP-1193 MetaMask, Arbitrum One Chain ID 42161 verification, EIP-712 permit diagnostics)

> **Note:** This is a front-end demo/simulator. Trades, swaps, LP positions and MEV arbitrage are simulated in the browser (state saved in `localStorage`); no real funds or on-chain transactions are involved.

## Run locally

Open `index.html` in any modern browser, or serve the folder:

```bash
npx serve .
```

## Deploy with GitHub Pages

1. Push this repo to GitHub.
2. Go to **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, select `main` and `/ (root)`, then save.

## Project structure

```
.
├── index.html   # Entire application (HTML, CSS, JS)
├── README.md
├── .gitignore
└── .nojekyll
```

## External dependencies (loaded via CDN)

Tailwind CSS, Lucide 0.395.0, Lightweight Charts 4.2.0, JSZip 3.10.1, Ethers 6.11.1, Google Fonts (Inter, JetBrains Mono), Binance public API.

'use strict';

const SYMBOLS = Object.freeze({
  'BTC-USD': 'BTC-USD',
  'ETH-USD': 'ETH-USD',
  'SOL-USD': 'SOL-USD',
  'ARB-USD': 'ARB-USD'
});

const BINANCE_MAP = Object.freeze({
  'BTC-USD': 'BTCUSDT',
  'ETH-USD': 'ETHUSDT',
  'SOL-USD': 'SOLUSDT',
  'ARB-USD': 'ARBUSDT'
});

const ALLOWED_TIMEFRAMES = new Set(['1m', '5m', '15m']);
const ARBITRUM_MAINNET = '0xa4b1';

const state = {
  activePair: 'BTC-USD',
  timeframe: '1m',
  orderSide: 'buy',
  candles: [],
  socket: null,
  reconnectTimer: null,
  pollTimer: null,
  requestController: null,
  streamGeneration: 0,
  walletAddress: null,
  walletChainId: null,
  currentPrice: 0
};

const $ = (id) => document.getElementById(id);

function setStatus(id, message, className = '') {
  const element = $(id) || document.querySelector('.status-pill') || document.querySelector('.connection-status');
  if (!element) return;
  element.textContent = message;
  if (element.id === 'streamStatus' || element.classList.contains('status-pill')) {
    element.className = `status-pill ${className}`.trim();
  }
}

function formatPrice(value) {
  if (!Number.isFinite(value) || value <= 0) return '—';
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatCompact(value) {
  if (!Number.isFinite(value)) return '—';
  return `$${new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 }).format(value)}`;
}

function formatAccount(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'Connect wallet';
}

function updateDOMPrices(price, change24h, high, low, vol) {
  if (!Number.isFinite(price) || price <= 0) return;
  state.currentPrice = price;

  // 1. Target main ticker price
  let priceElem = $('tickerPrice');
  if (!priceElem) {
    // Fallback: look for header element containing price or currency symbol
    const spans = document.querySelectorAll('section span, header span');
    for (const span of spans) {
      if (span.textContent.includes('$84,') || span.classList.contains('ticker-price')) {
        span.id = 'tickerPrice';
        priceElem = span;
        break;
      }
    }
  }
  if (priceElem) {
    priceElem.textContent = formatPrice(price);
  }

  // 2. Target 24h change
  if (change24h !== undefined) {
    let changeElem = $('tickerChange');
    if (changeElem) {
      changeElem.textContent = `${change24h >= 0 ? '+' : ''}${change24h.toFixed(2)}%`;
      changeElem.className = change24h >= 0 ? 'positive' : 'negative';
    }
  }

  // 3. Target high/low/vol
  if (high && $('tickerHigh')) $('tickerHigh').textContent = formatPrice(high);
  if (low && $('tickerLow')) $('tickerLow').textContent = formatPrice(low);
  if (vol && $('tickerVol')) $('tickerVol').textContent = formatCompact(vol);

  // 4. Update order sidebar estimate price if present
  const estEntry = $('estEntryPrice') || document.querySelector('.est-entry-price');
  if (estEntry) {
    estEntry.textContent = formatPrice(price);
  }
}

function normalizeCandles(data) {
  if (!Array.isArray(data)) return [];
  const unique = new Map();
  for (const row of data) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const candle = {
      time: Math.floor(Number(row[0]) / 1000),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5])
    };
    if (Number.isFinite(candle.time) && [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) {
      unique.set(candle.time, candle);
    }
  }
  return [...unique.values()].sort((a, b) => a.time - b.time).slice(-180);
}

// Fetch real historical candles from Binance public REST
async function fetchCandles(signal, generation) {
  const binanceSymbol = BINANCE_MAP[state.activePair] || 'BTCUSDT';
  const url = `https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=${state.timeframe}&limit=180`;
  
  const response = await fetch(url, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`Market data HTTP ${response.status}`);
  const candles = normalizeCandles(await response.json());
  
  if (generation !== state.streamGeneration) return;
  state.candles = candles;
  drawChart();
  
  const latest = candles[candles.length - 1];
  if (latest) {
    updateDOMPrices(latest.close);
  }
}

// Fetch real 24hr ticker data
async function fetchTicker(signal, generation) {
  const binanceSymbol = BINANCE_MAP[state.activePair] || 'BTCUSDT';
  const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${binanceSymbol}`;
  
  const response = await fetch(url, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`Ticker HTTP ${response.status}`);
  const data = await response.json();
  
  if (generation !== state.streamGeneration) return;
  updateDOMPrices(
    Number(data.lastPrice),
    Number(data.priceChangePercent),
    Number(data.highPrice),
    Number(data.lowPrice),
    Number(data.quoteVolume)
  );
}

async function refreshRestData() {
  const generation = state.streamGeneration;
  const controller = new AbortController();
  try {
    await Promise.all([
      fetchCandles(controller.signal, generation),
      fetchTicker(controller.signal, generation)
    ]);
    if (generation === state.streamGeneration && state.candles.length) {
      const msg = $('chartMessage');
      if (msg) msg.classList.add('hidden');
    }
  } catch (error) {
    if (error.name !== 'AbortError' && generation === state.streamGeneration) {
      setStatus('streamStatus', 'Polling live data…', 'positive');
    }
  }
}

// Global WebSocket with Coinbase Primary (unrestricted in all browsers)
function connectMarketStream(generation) {
  clearTimeout(state.reconnectTimer);
  if (generation !== state.streamGeneration || !window.WebSocket) return;
  
  if (state.socket) {
    state.socket.onopen = null;
    state.socket.onmessage = null;
    state.socket.onerror = null;
    state.socket.onclose = null;
    state.socket.close();
    state.socket = null;
  }

  setStatus('streamStatus', 'Connecting…');

  let ws;
  try {
    // Coinbase public WebSocket feed (universally accessible)
    ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
  } catch (e) {
    scheduleReconnect(generation);
    return;
  }
  state.socket = ws;

  ws.onopen = () => {
    if (generation !== state.streamGeneration) return;
    setStatus('streamStatus', 'Live feed', 'positive');
    
    // Subscribe to real-time ticker channel
    ws.send(JSON.stringify({
      type: 'subscribe',
      product_ids: [state.activePair],
      channels: ['ticker']
    }));
  };

  ws.onmessage = (event) => {
    if (generation !== state.streamGeneration) return;
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'ticker' && data.price) {
        const livePrice = parseFloat(data.price);
        const high = data.high_24h ? parseFloat(data.high_24h) : undefined;
        const low = data.low_24h ? parseFloat(data.low_24h) : undefined;
        const vol = data.volume_24h ? parseFloat(data.volume_24h) : undefined;

        updateDOMPrices(livePrice, undefined, high, low, vol);

        // Update active candle on chart
        const lastCandle = state.candles[state.candles.length - 1];
        if (lastCandle) {
          lastCandle.close = livePrice;
          lastCandle.high = Math.max(lastCandle.high, livePrice);
          lastCandle.low = Math.min(lastCandle.low, livePrice);
          drawChart();
        }
      }
    } catch {
      // Ignore parse glitches
    }
  };

  ws.onerror = () => {
    // Triggers onclose
  };

  ws.onclose = () => {
    if (generation === state.streamGeneration) {
      setStatus('streamStatus', 'Reconnecting…', 'negative');
      scheduleReconnect(generation);
    }
  };
}

function scheduleReconnect(generation) {
  clearTimeout(state.reconnectTimer);
  if (generation !== state.streamGeneration) return;
  state.reconnectTimer = setTimeout(() => connectMarketStream(generation), 3000);
}

function startPollingLoop() {
  clearInterval(state.pollTimer);
  // Auto-refresh via REST every 4 seconds as a guaranteed fallback
  state.pollTimer = setInterval(() => {
    refreshRestData();
  }, 4000);
}

async function loadMarket() {
  state.streamGeneration += 1;
  const generation = state.streamGeneration;
  state.requestController?.abort();
  state.requestController = new AbortController();
  state.candles = [];

  const msg = $('chartMessage');
  if (msg) {
    msg.textContent = 'Loading live market data…';
    msg.classList.remove('hidden');
  }

  if ($('chart-title')) $('chart-title').textContent = `${state.activePair}`;
  if ($('chartSubtitle')) $('chartSubtitle').textContent = `${state.timeframe} candles · live stream`;

  connectMarketStream(generation);
  startPollingLoop();

  try {
    await Promise.all([
      fetchCandles(state.requestController.signal, generation),
      fetchTicker(state.requestController.signal, generation)
    ]);
    if (generation === state.streamGeneration && state.candles.length && msg) {
      msg.classList.add('hidden');
    }
  } catch (error) {
    if (error.name !== 'AbortError' && generation === state.streamGeneration) {
      if (msg) msg.textContent = 'Streaming live ticker prices...';
    }
  }
}

function switchPair(pair) {
  if (!SYMBOLS[pair]) return;
  state.activePair = pair;
  loadMarket();
}

function setTimeframe(timeframe) {
  if (!ALLOWED_TIMEFRAMES.has(timeframe)) return;
  state.timeframe = timeframe;
  document.querySelectorAll('[data-timeframe]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.timeframe === timeframe);
  });
  loadMarket();
}

// Clean Canvas Chart Drawing (Crosshair and trade opening lines completely removed)
function drawChart() {
  const canvas = $('priceChart');
  if (!canvas) return;

  const box = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(box.width));
  const height = Math.max(1, Math.floor(box.height));
  const dpr = window.devicePixelRatio || 1;

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#080e19';
  ctx.fillRect(0, 0, width, height);

  const visible = state.candles.slice(-90);
  if (!visible.length) return;

  const high = Math.max(...visible.map((i) => i.high));
  const low = Math.min(...visible.map((i) => i.low));
  const range = Math.max(high - low, high * 0.0001);

  const top = 20;
  const bottom = height - 28;
  const left = 12;
  const right = width - 58;
  const y = (price) => top + ((high - price) / range) * (bottom - top);

  // Background Grid and Price Scales
  ctx.strokeStyle = 'rgba(147, 164, 187, .12)';
  ctx.fillStyle = '#93a4bb';
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'left';

  for (let i = 0; i <= 4; i += 1) {
    const gy = top + (i * (bottom - top)) / 4;
    ctx.beginPath();
    ctx.moveTo(left, gy);
    ctx.lineTo(right, gy);
    ctx.stroke();
    ctx.fillText(formatPrice(high - (i * range) / 4), right + 7, gy + 4);
  }

  // Draw Candlesticks
  const cell = (right - left) / visible.length;
  const candleWidth = Math.max(2, cell * 0.62);

  visible.forEach((candle, index) => {
    const x = left + cell * index + cell / 2;
    const openY = y(candle.open);
    const closeY = y(candle.close);
    const highY = y(candle.high);
    const lowY = y(candle.low);
    const rising = candle.close >= candle.open;

    ctx.strokeStyle = rising ? '#34d399' : '#fb7185';
    ctx.fillStyle = ctx.strokeStyle;

    // Wick
    ctx.beginPath();
    ctx.moveTo(x, highY);
    ctx.lineTo(x, lowY);
    ctx.stroke();

    // Body
    ctx.fillRect(
      x - candleWidth / 2,
      Math.min(openY, closeY),
      candleWidth,
      Math.max(1, Math.abs(closeY - openY))
    );
  });

  // NOTE: Trade opening line / crosshair drawing block has been completely removed.
}

function switchTab(tab) {
  const validTabs = ['terminal', 'swap', 'mev', 'pools', 'security'];
  if (!validTabs.includes(tab)) return;
  document.querySelectorAll('.tab-module').forEach((m) => m.classList.toggle('hidden', m.id !== `module-${tab}`));
  document.querySelectorAll('[data-tab]').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
  history.replaceState(null, '', `#${tab}`);
}

function selectTool(tool) {
  document.querySelectorAll('[data-tool]').forEach((btn) => btn.classList.toggle('active', btn.dataset.tool === tool));
  const toolStatus = $('toolStatus');
  if (toolStatus) {
    toolStatus.textContent = tool === 'trendline' ? 'Trendline selected.' : 'Standard mode.';
  }
}

function setOrderSide(side) {
  state.orderSide = side === 'sell' ? 'sell' : 'buy';
  document.querySelectorAll('[data-side]').forEach((btn) => btn.classList.toggle('selected', btn.dataset.side === state.orderSide));
  const orderBtn = $('orderBtn');
  if (orderBtn) {
    orderBtn.textContent = `Simulate market ${state.orderSide === 'buy' ? 'long' : 'short'}`;
  }
}

function executeOrder() {
  const input = $('marginInput');
  const amount = input ? Number(input.value) : 0;
  if (!Number.isFinite(amount) || amount <= 0) {
    setStatus('orderStatus', 'Enter a margin greater than zero.', 'negative');
    return;
  }
  setStatus('orderStatus', `Simulation created for ${amount.toFixed(2)} USDC (${state.orderSide === 'buy' ? 'long' : 'short'}). No transaction was submitted.`, 'positive');
}

async function connectWallet() {
  if (!window.ethereum) {
    setStatus('connectionStatus', 'Wallet extension not found');
    return;
  }
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    state.walletAddress = accounts[0] || null;
    state.walletChainId = await window.ethereum.request({ method: 'eth_chainId' });
    if ($('walletBtn')) $('walletBtn').textContent = formatAccount(state.walletAddress);
    setStatus('connectionStatus', state.walletChainId === ARBITRUM_MAINNET ? 'Wallet: Arbitrum' : `Wallet: connected`, 'positive');
  } catch (error) {
    setStatus('connectionStatus', error.code === 4001 ? 'Wallet connection rejected' : 'Wallet connection failed', 'negative');
  }
}

function setupWalletEvents() {
  if (!window.ethereum?.on) return;
  window.ethereum.on('accountsChanged', (accounts) => {
    state.walletAddress = accounts[0] || null;
    if ($('walletBtn')) $('walletBtn').textContent = formatAccount(state.walletAddress);
  });
  window.ethereum.on('chainChanged', (chainId) => {
    state.walletChainId = chainId;
    setStatus('connectionStatus', chainId === ARBITRUM_MAINNET ? 'Wallet: Arbitrum' : 'Wallet: Connected', 'positive');
  });
}

function bindEvents() {
  document.querySelectorAll('[data-tab]').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
  document.querySelectorAll('[data-tool]').forEach((btn) => btn.addEventListener('click', () => selectTool(btn.dataset.tool)));
  document.querySelectorAll('[data-timeframe]').forEach((btn) => btn.addEventListener('click', () => setTimeframe(btn.dataset.timeframe)));
  document.querySelectorAll('[data-side]').forEach((btn) => btn.addEventListener('click', () => setOrderSide(btn.dataset.side)));
  
  $('pairSelect')?.addEventListener('change', (e) => switchPair(e.target.value));
  $('walletBtn')?.addEventListener('click', connectWallet);
  $('orderBtn')?.addEventListener('click', executeOrder);

  // Crosshair tracking listeners have been removed
  window.addEventListener('resize', drawChart);
}

// Initial Boot
bindEvents();
setupWalletEvents();
switchTab(location.hash.slice(1) || 'terminal');
loadMarket();

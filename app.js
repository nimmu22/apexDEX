'use strict';

const SYMBOLS = Object.freeze({
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
  activeFeed: 'binance', // 'binance' | 'coinbase'
  binanceFailures: 0,
  walletAddress: null,
  walletChainId: null,
  crosshair: null
};

const $ = (id) => document.getElementById(id);
const apiBase = 'https://api.binance.com/api/v3';

function setStatus(id, message, className = '') {
  const element = $(id);
  if (!element) return;
  element.textContent = message;
  if (element.id === 'streamStatus') element.className = `status-pill ${className}`.trim();
  if (element.id === 'connectionStatus') element.className = `connection-status ${className}`.trim();
  if (element.classList.contains('status-message')) element.className = `status-message ${className}`.trim();
}

function formatPrice(value) {
  if (!Number.isFinite(value)) return '—';
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatCompact(value) {
  if (!Number.isFinite(value)) return '—';
  return `$${new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 }).format(value)}`;
}

function formatAccount(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'Connect wallet';
}

function symbol() {
  return SYMBOLS[state.activePair];
}

function switchTab(tab) {
  const validTabs = ['terminal', 'swap', 'mev', 'pools', 'security'];
  if (!validTabs.includes(tab)) return;
  document.querySelectorAll('.tab-module').forEach((module) => module.classList.toggle('hidden', module.id !== `module-${tab}`));
  document.querySelectorAll('[data-tab]').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
  history.replaceState(null, '', `#${tab}`);
}

function selectTool(tool) {
  document.querySelectorAll('[data-tool]').forEach((button) => button.classList.toggle('active', button.dataset.tool === tool));
  const label = tool === 'trendline' ? 'Trendline selected. Chart drawing is visual-only.' : 'Crosshair selected.';
  $('toolStatus').textContent = label;
}

function setOrderSide(side) {
  state.orderSide = side === 'sell' ? 'sell' : 'buy';
  document.querySelectorAll('[data-side]').forEach((button) => button.classList.toggle('selected', button.dataset.side === state.orderSide));
  $('orderBtn').textContent = `Simulate market ${state.orderSide === 'buy' ? 'long' : 'short'}`;
}

function executeOrder() {
  const amount = Number($('marginInput').value);
  if (!Number.isFinite(amount) || amount <= 0) {
    setStatus('orderStatus', 'Enter a margin greater than zero.', 'negative');
    return;
  }
  setStatus('orderStatus', `Simulation created for ${amount.toFixed(2)} USDC (${state.orderSide === 'buy' ? 'long' : 'short'}). No transaction was submitted.`, 'positive');
}

function normalizeCandles(data) {
  if (!Array.isArray(data)) throw new Error('The market-data response was not an array.');
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
    if (Number.isFinite(candle.time) && [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) unique.set(candle.time, candle);
  }
  return [...unique.values()].sort((a, b) => a.time - b.time).slice(-180);
}

async function fetchCandles(signal, generation) {
  const url = `${apiBase}/klines?symbol=${encodeURIComponent(symbol())}&interval=${encodeURIComponent(state.timeframe)}&limit=180`;
  const response = await fetch(url, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`Market data returned HTTP ${response.status}.`);
  const candles = normalizeCandles(await response.json());
  if (generation !== state.streamGeneration) return;
  state.candles = candles;
  drawChart();
  updateLivePrice(state.candles[state.candles.length - 1]?.close);
}

async function fetchTicker(signal, generation) {
  const url = `${apiBase}/ticker/24hr?symbol=${encodeURIComponent(symbol())}`;
  const response = await fetch(url, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`Ticker returned HTTP ${response.status}.`);
  const data = await response.json();
  if (generation !== state.streamGeneration) return;
  const price = Number(data.lastPrice);
  const change = Number(data.priceChangePercent);
  updateLivePrice(price);
  $('tickerChange').textContent = `${change >= 0 ? '+' : ''}${Number.isFinite(change) ? change.toFixed(2) : '—'}%`;
  $('tickerChange').className = change >= 0 ? 'positive' : 'negative';
  $('tickerHigh').textContent = formatPrice(Number(data.highPrice));
  $('tickerLow').textContent = formatPrice(Number(data.lowPrice));
  $('tickerVol').textContent = formatCompact(Number(data.quoteVolume));
}

function updateLivePrice(price) {
  if (!Number.isFinite(price) || price <= 0) return;
  const priceElem = $('tickerPrice');
  if (priceElem) priceElem.textContent = formatPrice(price);
}

async function refreshRestData() {
  const generation = state.streamGeneration;
  const controller = new AbortController();
  try {
    await Promise.all([fetchCandles(controller.signal, generation), fetchTicker(controller.signal, generation)]);
    if (generation === state.streamGeneration && state.candles.length) $('chartMessage')?.classList.add('hidden');
  } catch (error) {
    if (error.name !== 'AbortError' && generation === state.streamGeneration) {
      if ($('chartMessage')) {
        $('chartMessage').textContent = `Unable to load market data: ${error.message}`;
        $('chartMessage').classList.remove('hidden');
      }
      setStatus('streamStatus', 'Data unavailable', 'negative');
    }
  }
}

function scheduleReconnect(generation) {
  clearTimeout(state.reconnectTimer);
  if (generation !== state.streamGeneration) return;
  state.reconnectTimer = setTimeout(() => connectMarketStream(generation), 2500);
}

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

  const isBinance = state.activeFeed === 'binance';
  const url = isBinance
    ? `wss://stream.binance.com:9443/ws/${symbol().toLowerCase()}@kline_${state.timeframe}`
    : 'wss://ws-feed.exchange.coinbase.com';

  setStatus('streamStatus', `Connecting (${state.activeFeed})…`);

  let socket;
  try {
    socket = new WebSocket(url);
  } catch (error) {
    handleStreamFailure(generation, error.message);
    return;
  }
  state.socket = socket;

  socket.onopen = () => {
    if (generation !== state.streamGeneration) return;
    setStatus('streamStatus', `Live (${state.activeFeed})`, 'positive');

    // Coinbase requires explicit subscription
    if (!isBinance) {
      socket.send(JSON.stringify({
        type: 'subscribe',
        product_ids: [state.activePair],
        channels: ['ticker']
      }));
    }
  };

  socket.onmessage = (event) => {
    if (generation !== state.streamGeneration) return;
    try {
      const msg = JSON.parse(event.data);

      if (isBinance && msg.k) {
        const kline = msg.k;
        const currentPrice = Number(kline.c);
        const candle = {
          time: Math.floor(Number(kline.t) / 1000),
          open: Number(kline.o),
          high: Number(kline.h),
          low: Number(kline.l),
          close: currentPrice,
          volume: Number(kline.v)
        };
        const last = state.candles[state.candles.length - 1];
        if (last && last.time === candle.time) state.candles[state.candles.length - 1] = candle;
        else state.candles.push(candle);

        state.candles = state.candles.slice(-180);
        drawChart();
        updateLivePrice(currentPrice);
      } else if (!isBinance && msg.type === 'ticker' && msg.price) {
        // Coinbase live price feed
        const currentPrice = Number(msg.price);
        updateLivePrice(currentPrice);

        // Update latest candle close in real time
        const last = state.candles[state.candles.length - 1];
        if (last) {
          last.close = currentPrice;
          last.high = Math.max(last.high, currentPrice);
          last.low = Math.min(last.low, currentPrice);
          drawChart();
        }
      }
    } catch {
      setStatus('streamStatus', 'Malformed data', 'negative');
    }
  };

  socket.onerror = () => {
    // Socket errors precede onclose
  };

  socket.onclose = () => {
    if (generation === state.streamGeneration) {
      handleStreamFailure(generation, 'Connection closed');
    }
  };
}

function handleStreamFailure(generation, reason) {
  if (state.activeFeed === 'binance') {
    state.binanceFailures += 1;
    // After 2 failures, automatically switch over to Coinbase
    if (state.binanceFailures >= 2) {
      state.activeFeed = 'coinbase';
      setStatus('streamStatus', 'Switching to Coinbase…', 'negative');
      scheduleReconnect(generation);
      return;
    }
  }
  setStatus('streamStatus', 'Reconnecting…', 'negative');
  scheduleReconnect(generation);
}

function startFallbackPolling() {
  clearInterval(state.pollTimer);
  // Poll REST data every 5 seconds if socket drops, 20 seconds if healthy
  state.pollTimer = setInterval(() => {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      refreshRestData();
    }
  }, 5000);
}

async function loadMarket() {
  if (!SYMBOLS[state.activePair] || !ALLOWED_TIMEFRAMES.has(state.timeframe)) return;
  state.streamGeneration += 1;
  const generation = state.streamGeneration;
  state.binanceFailures = 0;
  state.activeFeed = 'binance';

  state.requestController?.abort();
  state.requestController = new AbortController();
  state.candles = [];

  $('chartMessage').textContent = 'Loading market data…';
  $('chartMessage').classList.remove('hidden');
  $('chart-title').textContent = `BINANCE:${symbol()}`;
  $('chartSubtitle').textContent = `${state.timeframe} candles · live stream`;

  connectMarketStream(generation);
  startFallbackPolling();

  try {
    await Promise.all([
      fetchCandles(state.requestController.signal, generation),
      fetchTicker(state.requestController.signal, generation)
    ]);
    if (generation === state.streamGeneration && state.candles.length) {
      $('chartMessage').classList.add('hidden');
    }
  } catch (error) {
    if (error.name !== 'AbortError' && generation === state.streamGeneration) {
      $('chartMessage').textContent = `Unable to load market data: ${error.message}`;
      setStatus('streamStatus', 'Data unavailable', 'negative');
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
  document.querySelectorAll('[data-timeframe]').forEach((button) => button.classList.toggle('active', button.dataset.timeframe === timeframe));
  loadMarket();
}

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
  const high = Math.max(...visible.map((item) => item.high));
  const low = Math.min(...visible.map((item) => item.low));
  const range = Math.max(high - low, high * 0.0001);
  const top = 20;
  const bottom = height - 28;
  const left = 12;
  const right = width - 58;
  const y = (price) => top + ((high - price) / range) * (bottom - top);

  ctx.strokeStyle = 'rgba(147, 164, 187, .14)';
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
    ctx.beginPath();
    ctx.moveTo(x, highY);
    ctx.lineTo(x, lowY);
    ctx.stroke();
    ctx.fillRect(x - candleWidth / 2, Math.min(openY, closeY), candleWidth, Math.max(1, Math.abs(closeY - openY)));
  });
  if (state.crosshair) {
    ctx.strokeStyle = 'rgba(34, 211, 238, .6)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(state.crosshair.x, top);
    ctx.lineTo(state.crosshair.x, bottom);
    ctx.moveTo(left, state.crosshair.y);
    ctx.lineTo(right, state.crosshair.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
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
    $('walletBtn').textContent = formatAccount(state.walletAddress);
    setStatus('connectionStatus', state.walletChainId === ARBITRUM_MAINNET ? 'Wallet: Arbitrum' : `Wallet: wrong network (${state.walletChainId})`, state.walletChainId === ARBITRUM_MAINNET ? 'positive' : 'negative');
  } catch (error) {
    setStatus('connectionStatus', error.code === 4001 ? 'Wallet connection rejected' : 'Wallet connection failed', 'negative');
  }
}

function setupWalletEvents() {
  if (!window.ethereum?.on) return;
  window.ethereum.on('accountsChanged', (accounts) => {
    state.walletAddress = accounts[0] || null;
    $('walletBtn').textContent = formatAccount(state.walletAddress);
    if (!state.walletAddress) setStatus('connectionStatus', 'Market: live');
  });
  window.ethereum.on('chainChanged', (chainId) => {
    state.walletChainId = chainId;
    setStatus('connectionStatus', chainId === ARBITRUM_MAINNET ? 'Wallet: Arbitrum' : `Wallet: wrong network (${chainId})`, chainId === ARBITRUM_MAINNET ? 'positive' : 'negative');
  });
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  let centralSize = 0;
  const u16 = (view, at, value) => view.setUint16(at, value, true);
  const u32 = (view, at, value) => view.setUint32(at, value, true);
  for (const [name, content] of files) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(content);
    const checksum = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    u32(lv, 0, 0x04034b50);
    u16(lv, 4, 20);
    u16(lv, 6, 0x800);
    u16(lv, 8, 0);
    u16(lv, 10, 0);
    u16(lv, 12, 0x21);
    u32(lv, 14, checksum);
    u32(lv, 18, data.length);
    u32(lv, 22, data.length);
    u16(lv, 26, nameBytes.length);
    u16(lv, 28, 0);
    local.set(nameBytes, 30);
    localParts.push(local, data);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    u32(cv, 0, 0x02014b50);
    u16(cv, 4, 20);
    u16(cv, 6, 20);
    u16(cv, 8, 0x800);
    u16(cv, 10, 0);
    u16(cv, 12, 0);
    u16(cv, 14, 0x21);
    u32(cv, 16, checksum);
    u32(cv, 20, data.length);
    u32(cv, 24, data.length);
    u16(cv, 28, nameBytes.length);
    u16(cv, 30, 0);
    u16(cv, 32, 0);
    u16(cv, 34, 0);
    u16(cv, 36, 0);
    u32(cv, 38, 0);
    u32(cv, 42, offset);
    central.set(nameBytes, 46);
    centralParts.push(central);
    offset += local.length + data.length;
    centralSize += central.length;
  }
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  u32(ev, 0, 0x06054b50);
  u16(ev, 8, files.length);
  u16(ev, 10, files.length);
  u32(ev, 12, centralSize);
  u32(ev, 16, offset);
  u16(ev, 20, 0);
  return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
}

async function downloadGitHubZip() {
  const paths = ['index.html', 'style.css', 'app.js', 'README.md', '.github/workflows/static.yml'];
  setStatus('exportStatus', 'Preparing clean ZIP…');
  try {
    const files = await Promise.all(
      paths.map(async (path) => {
        const response = await fetch(path, { cache: 'no-store' });
        if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
        return [path, await response.text()];
      })
    );
    const url = URL.createObjectURL(makeZip(files));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'ApexDEX-Market-Monitor.zip';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('exportStatus', 'Clean ZIP downloaded.', 'positive');
  } catch (error) {
    setStatus('exportStatus', `Export failed. Run the site through HTTP first (${error.message}).`, 'negative');
  }
}

function bindEvents() {
  document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)));
  document.querySelectorAll('[data-tool]').forEach((button) => button.addEventListener('click', () => selectTool(button.dataset.tool)));
  document.querySelectorAll('[data-timeframe]').forEach((button) => button.addEventListener('click', () => setTimeframe(button.dataset.timeframe)));
  document.querySelectorAll('[data-side]').forEach((button) => button.addEventListener('click', () => setOrderSide(button.dataset.side)));
  $('pairSelect')?.addEventListener('change', (event) => switchPair(event.target.value));
  $('walletBtn')?.addEventListener('click', connectWallet);
  $('orderBtn')?.addEventListener('click', executeOrder);
  $('exportBtn')?.addEventListener('click', downloadGitHubZip);
  const canvas = $('priceChart');
  if (canvas) {
    canvas.addEventListener('pointermove', (event) => {
      state.crosshair = { x: event.offsetX, y: event.offsetY };
      drawChart();
    });
    canvas.addEventListener('pointerleave', () => {
      state.crosshair = null;
      drawChart();
    });
  }
  window.addEventListener('resize', drawChart);
}

bindEvents();
setupWalletEvents();
switchTab(location.hash.slice(1) || 'terminal');
loadMarket();

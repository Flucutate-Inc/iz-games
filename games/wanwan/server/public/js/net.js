/** REST + WebSocket 通信層 */
const Net = (() => {
  let token = localStorage.getItem('wanwan_token') || null;
  let ws = null;
  let wsHandlers = {};
  let reconnectTimer = null;
  let seq = 0;

  async function api(path, options = {}) {
    const res = await fetch('/api' + path, {
      method: options.method || (options.body ? 'POST' : 'GET'),
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }

  function setToken(t) {
    token = t;
    if (t) localStorage.setItem('wanwan_token', t);
    else localStorage.removeItem('wanwan_token');
  }

  function connectWS() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
      emitLocal('ws_open');
    };
    ws.onmessage = e => {
      const msg = JSON.parse(e.data);
      emitLocal(msg.type, msg);
    };
    ws.onclose = () => {
      emitLocal('ws_close');
      // トークンがある限り自動再接続(NET-01: 対戦中はサーバー側が復帰処理)
      if (token && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connectWS();
        }, 1500);
      }
    };
  }

  function disconnectWS() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
  }

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function sendOp(msg) {
    send({ ...msg, seq: ++seq });
    return seq;
  }

  function syncSeq(serverLastSeq) {
    if (typeof serverLastSeq === 'number' && serverLastSeq > seq) seq = serverLastSeq;
  }

  function on(type, fn) {
    (wsHandlers[type] = wsHandlers[type] || []).push(fn);
  }

  function emitLocal(type, msg) {
    for (const fn of wsHandlers[type] || []) fn(msg);
  }

  return { api, setToken, get token() { return token; }, connectWS, disconnectWS, send, sendOp, syncSeq, on };
})();

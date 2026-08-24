/**
 * サーバーとの通信。HTTP API と WebSocket の薄いラッパー。
 * セッショントークンは localStorage に持つ(IZ 内では毎回自動ログインし直すので保険)。
 */
(function (global) {
  var TOKEN_KEY = 'kusa.token';
  var token = null;
  try {
    token = localStorage.getItem(TOKEN_KEY);
  } catch (e) {
    token = null;
  }

  var ws = null;
  var handlers = {};
  var closedByUs = false;
  var retry = 0;
  var retryTimer = null;

  function setToken(t) {
    token = t;
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) {
      /* プライベートブラウズなどで書けないことがある。メモリ上だけで続行する */
    }
  }

  function getToken() {
    return token;
  }

  async function api(path, opts) {
    opts = opts || {};
    var headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = 'Bearer ' + token;
    var res = await fetch('/api' + path, {
      method: opts.body ? 'POST' : opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    var data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    if (!res.ok) {
      var err = new Error((data && data.error) || 'HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function on(type, fn) {
    handlers[type] = fn;
  }

  function emit(type, msg) {
    if (handlers[type]) handlers[type](msg);
    if (handlers['*']) handlers['*'](msg);
  }

  function connect() {
    if (!token) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    closedByUs = false;
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws?t=' + encodeURIComponent(token));

    ws.onopen = function () {
      retry = 0;
      emit('_open', {});
    };
    ws.onmessage = function (ev) {
      var msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      emit(msg.t, msg);
    };
    ws.onclose = function () {
      ws = null;
      if (closedByUs) return;
      emit('_close', {});
      // 通信が切れたら間隔を空けて繋ぎ直す(電車でトンネルに入った、など)
      retry = Math.min(retry + 1, 6);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, 500 * Math.pow(2, retry - 1));
    };
    ws.onerror = function () {
      /* onclose が続けて呼ばれるので、ここでは何もしない */
    };
  }

  function disconnect() {
    closedByUs = true;
    clearTimeout(retryTimer);
    if (ws) {
      try {
        ws.close();
      } catch (e) {
        /* すでに閉じている */
      }
    }
    ws = null;
  }

  function send(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      return false;
    }
  }

  function isOpen() {
    return !!ws && ws.readyState === WebSocket.OPEN;
  }

  global.Net = {
    api: api,
    setToken: setToken,
    getToken: getToken,
    connect: connect,
    disconnect: disconnect,
    send: send,
    on: on,
    isOpen: isOpen,
  };
})(window);

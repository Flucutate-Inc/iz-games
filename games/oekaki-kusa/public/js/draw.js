/**
 * キャンバス。フリーハンドのみ。図形ツール・塗りつぶし・レイヤーは置かない。
 * (原作の「道具の貧しさが平等を生む」をそのまま守る。足すと画力差が出て卓が壊れる)
 *
 * 座標は **キャンバスの幅を 1 とした正規化座標**で持つ。x も y も幅で割るので、
 * 端末ごとに画面の縦横比が違っても絵が歪まない。縦横比(ar = 高さ/幅)は
 * 作品と一緒に保存し、ギャラリーではその比で余白を付けて再生する。
 *
 * 線は「作者IDつきのストローク列」。原作の「荒らしを追放するとその人の線だけ消える」
 * 仕様から取った形で、undo・再生・差分同期がこれ1つで解ける。
 */
(function (global) {
  var PALETTE = [
    '#14140f', // すみ
    '#d63a30', // あか
    '#e8991f', // だいだい
    '#3f9a4a', // みどり
    '#2f6fd0', // あお
    '#8a5ac8', // むらさき
    '#cf6a9b', // もも
    '#8a6244', // ちゃ
    '#ffffff', // けしゴム(紙と同じ色で上書きする)
  ];
  var ERASER_INDEX = PALETTE.length - 1;
  /** 線の太さ。キャンバス幅に対する比なので、画面サイズが違っても見た目が揃う */
  var WIDTHS = [0.006, 0.015, 0.034];

  function makeId() {
    return Math.random().toString(36).slice(2, 9);
  }

  /** ストローク列を 2D コンテキストに描く。w は「幅1」基準なので scale を掛ける */
  function paint(ctx, strokes, scale, offsetX, offsetY) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (var i = 0; i < strokes.length; i++) {
      var s = strokes[i];
      var p = s.p;
      if (!p || p.length < 2) continue;
      ctx.strokeStyle = PALETTE[s.c] || PALETTE[0];
      ctx.lineWidth = Math.max(1, (WIDTHS[s.w] || WIDTHS[1]) * scale);
      ctx.beginPath();
      ctx.moveTo(offsetX + p[0] * scale, offsetY + p[1] * scale);
      if (p.length === 2) {
        // 点を打っただけ。線にならないので小さく描く
        ctx.lineTo(offsetX + p[0] * scale + 0.01, offsetY + p[1] * scale);
      } else {
        for (var j = 2; j < p.length; j += 2) {
          ctx.lineTo(offsetX + p[j] * scale, offsetY + p[j + 1] * scale);
        }
      }
      ctx.stroke();
    }
  }

  /**
   * 保存済みの作品を任意の canvas に描く(ギャラリー・拡大表示用)。
   * drawing は { ar, strokes }。canvas の縦横比に合わせて中央に収める。
   */
  function render(canvas, drawing) {
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var cssW = canvas.clientWidth || 150;
    var cssH = canvas.clientHeight || 200;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cssW, cssH);

    var ar = (drawing && drawing.ar) || 4 / 3; // 元の 高さ/幅
    var strokes = (drawing && drawing.strokes) || [];
    // 元の絵(幅1・高さ ar)を、はみ出さないよう縮めて中央に置く
    var scale = Math.min(cssW / 1, cssH / ar);
    var offsetX = (cssW - scale) / 2;
    var offsetY = (cssH - ar * scale) / 2;
    paint(ctx, strokes, scale, offsetX, offsetY);
  }

  /** 描けるキャンバス本体 */
  function Board(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts || {};
    this.strokes = [];
    this.enabled = false;
    this.colorIndex = 0;
    this.widthIndex = 1;
    this.dpr = Math.min(global.devicePixelRatio || 1, 2);
    this.cssW = 1;
    this.cssH = 1;
    this.active = null; // 描いている途中のストローク
    this.pending = []; // まだ送っていない点
    this.flushTimer = null;
    this.myUserId = null;

    this._onDown = this._down.bind(this);
    this._onMove = this._move.bind(this);
    this._onUp = this._up.bind(this);
    canvas.addEventListener('pointerdown', this._onDown);
    canvas.addEventListener('pointermove', this._onMove);
    canvas.addEventListener('pointerup', this._onUp);
    canvas.addEventListener('pointercancel', this._onUp);
    canvas.addEventListener('pointerleave', this._onUp);
  }

  Board.prototype.resize = function () {
    var rect = this.canvas.getBoundingClientRect();
    // 隠れている画面のキャンバスは 0x0 になる。そのまま取り込むと内部バッファが
    // 1x1 に壊れて「線が出ない」状態になるので、見えていない間は触らない
    // (次に表示されたときの resize で正しい寸法になる)
    if (rect.width < 2 || rect.height < 2) return;
    this.cssW = rect.width;
    this.cssH = rect.height;
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    this.redraw();
  };

  /** 高さ/幅。作品と一緒に保存して、ギャラリーで同じ形に再生する */
  Board.prototype.aspect = function () {
    return this.cssH / this.cssW;
  };

  Board.prototype.redraw = function () {
    var ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    paint(ctx, this.strokes, this.cssW, 0, 0);
  };

  Board.prototype.setEnabled = function (on) {
    this.enabled = !!on;
    this.canvas.style.cursor = on ? 'crosshair' : 'default';
    if (!on) this._finishActive();
  };

  Board.prototype.reset = function () {
    this._finishActive();
    this.strokes = [];
    this.redraw();
  };

  Board.prototype.setColor = function (i) {
    this.colorIndex = i;
  };
  Board.prototype.setWidth = function (i) {
    this.widthIndex = i;
  };

  // ─── 入力 ───────────────────────────────────────────

  Board.prototype._pos = function (ev) {
    var rect = this.canvas.getBoundingClientRect();
    return [
      Math.round(((ev.clientX - rect.left) / this.cssW) * 1000) / 1000,
      Math.round(((ev.clientY - rect.top) / this.cssW) * 1000) / 1000,
    ];
  };

  Board.prototype._down = function (ev) {
    if (!this.enabled) return;
    ev.preventDefault();
    try {
      this.canvas.setPointerCapture(ev.pointerId);
    } catch (e) {
      /* 対応していない環境は無視 */
    }
    var pt = this._pos(ev);
    this.active = {
      id: makeId(),
      u: this.myUserId,
      c: this.colorIndex,
      w: this.widthIndex,
      p: [pt[0], pt[1]],
      pointerId: ev.pointerId,
    };
    this.strokes.push(this.active);
    this.redraw();
    if (this.opts.onStrokeStart) {
      this.opts.onStrokeStart({
        id: this.active.id,
        c: this.active.c,
        w: this.active.w,
        p: [pt[0], pt[1]],
        ar: this.aspect(),
      });
    }
  };

  Board.prototype._move = function (ev) {
    if (!this.enabled || !this.active || ev.pointerId !== this.active.pointerId) return;
    ev.preventDefault();

    // 高リフレッシュ端末で間引かれた点も拾う(線がなめらかになる)
    var events = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
    if (!events.length) events = [ev];

    var added = [];
    for (var i = 0; i < events.length; i++) {
      var pt = this._pos(events[i]);
      var p = this.active.p;
      var lastX = p[p.length - 2];
      var lastY = p[p.length - 1];
      // 手ブレ補正。直前の点に少し引き寄せてから記録する
      var x = Math.round((lastX * 0.35 + pt[0] * 0.65) * 1000) / 1000;
      var y = Math.round((lastY * 0.35 + pt[1] * 0.65) * 1000) / 1000;
      // 動いていない点は捨てる(通信量と描画負荷の節約)
      if (Math.abs(x - lastX) < 0.002 && Math.abs(y - lastY) < 0.002) continue;
      p.push(x, y);
      added.push(x, y);

      // 増えた分だけを描き足す(全部描き直さない)
      var ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = PALETTE[this.active.c];
      ctx.lineWidth = Math.max(1, WIDTHS[this.active.w] * this.cssW);
      ctx.beginPath();
      ctx.moveTo(lastX * this.cssW, lastY * this.cssW);
      ctx.lineTo(x * this.cssW, y * this.cssW);
      ctx.stroke();
    }

    if (added.length) {
      this.pending.push.apply(this.pending, added);
      this._scheduleFlush();
    }
  };

  Board.prototype._up = function (ev) {
    if (!this.active) return;
    if (ev && ev.pointerId !== undefined && ev.pointerId !== this.active.pointerId) return;
    this._finishActive();
  };

  Board.prototype._finishActive = function () {
    if (!this.active) return;
    this._flush();
    this.active = null;
  };

  /** 点はまとめて送る。1点ごとに送るとメッセージが多すぎる */
  Board.prototype._scheduleFlush = function () {
    if (this.flushTimer) return;
    var self = this;
    this.flushTimer = setTimeout(function () {
      self.flushTimer = null;
      self._flush();
    }, 60);
  };

  Board.prototype._flush = function () {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.active || !this.pending.length) return;
    var points = this.pending;
    this.pending = [];
    if (this.opts.onStrokeAppend) this.opts.onStrokeAppend({ id: this.active.id, p: points });
  };

  // ─── ほかの人の描画を受け取る ───────────────────────

  Board.prototype.remoteStart = function (msg) {
    this.strokes.push({ id: msg.id, u: msg.u || null, c: msg.c, w: msg.w, p: msg.p.slice() });
    this.redraw();
  };

  Board.prototype.remoteAppend = function (msg) {
    var s = null;
    for (var i = this.strokes.length - 1; i >= 0; i--) {
      if (this.strokes[i].id === msg.id) {
        s = this.strokes[i];
        break;
      }
    }
    if (!s) return;
    s.p.push.apply(s.p, msg.p);
    this.redraw();
  };

  /** その人が最後に描いた線だけを消す */
  Board.prototype.removeLastBy = function (userId) {
    for (var i = this.strokes.length - 1; i >= 0; i--) {
      if (this.strokes[i].u === userId) {
        this.strokes.splice(i, 1);
        break;
      }
    }
    this.redraw();
  };

  Board.prototype.undoMine = function () {
    this._finishActive();
    this.removeLastBy(this.myUserId);
  };

  Board.prototype.clearAll = function () {
    this.reset();
  };

  Board.prototype.destroy = function () {
    this.canvas.removeEventListener('pointerdown', this._onDown);
    this.canvas.removeEventListener('pointermove', this._onMove);
    this.canvas.removeEventListener('pointerup', this._onUp);
    this.canvas.removeEventListener('pointercancel', this._onUp);
    this.canvas.removeEventListener('pointerleave', this._onUp);
  };

  global.Draw = {
    Board: Board,
    render: render,
    PALETTE: PALETTE,
    WIDTHS: WIDTHS,
    ERASER_INDEX: ERASER_INDEX,
  };
})(window);

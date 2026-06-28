/**
 * IZ ゲーム SDK（protocol v1）
 *
 * 公開リポジトリ iz-games のゲームが IZ アプリ（ホスト）と通信するための薄いブリッジ。
 * ホスト側の実装は iz-app の src/lib/gameBridge.ts / src/components/GameHost*.tsx。
 * メッセージ形はこのバージョン（IZ.PROTOCOL）で同期する。drift したらホスト側も更新すること。
 *
 * セキュリティ: ゲームは Firebase 認証情報を持たない。プロフィール・賭け・ランキングは
 * すべてホストが仲介し、賭けの当落・残高変更はサーバー（placeWager Cloud Function）が決める。
 * このSDKから当落を偽装することはできない（ホストはサーバーの結果しか返さない）。
 *
 * 使い方:
 *   const ctx = await IZ.ready();          // { user:{uid,displayName}, balance, game:{id,minBet,maxBet} }
 *   const res = await IZ.placeBet('heads', 100);  // { won, choice, coinResult, payout, balance }
 *   const ranking = await IZ.getRanking();  // [{ rank, displayName, net }, ...]
 */
(function (global) {
  var PROTOCOL = 1;
  var pending = {}; // requestId -> { resolve, reject }
  var initData = null;
  var initResolvers = [];
  var counter = 0;

  function send(msg) {
    var json = JSON.stringify(msg);
    // ネイティブ WebView ではホストが ReactNativeWebView.postMessage を購読する
    if (global.ReactNativeWebView && global.ReactNativeWebView.postMessage) {
      global.ReactNativeWebView.postMessage(json);
    } else if (global.parent) {
      // Web の iframe では親（ホスト）へ postMessage する
      global.parent.postMessage(json, '*');
    }
  }

  function handle(raw) {
    var data = raw;
    if (typeof raw === 'string') {
      try {
        data = JSON.parse(raw);
      } catch (e) {
        return;
      }
    }
    if (!data || typeof data.type !== 'string') return;

    switch (data.type) {
      case 'iz:init':
        initData = data;
        initResolvers.forEach(function (resolve) {
          resolve(data);
        });
        initResolvers = [];
        break;
      case 'iz:betResult': {
        var pb = pending[data.requestId];
        if (pb) {
          delete pending[data.requestId];
          pb.resolve(data);
        }
        break;
      }
      case 'iz:ranking': {
        var pr = pending[data.requestId];
        if (pr) {
          delete pending[data.requestId];
          pr.resolve(data.entries || []);
        }
        break;
      }
      case 'iz:error': {
        var pe = pending[data.requestId];
        if (pe) {
          delete pending[data.requestId];
          pe.reject(new Error(data.message || 'error'));
        }
        break;
      }
    }
  }

  // Web は window、(一部の)ネイティブ WebView は document に message を dispatch するため両方購読
  global.addEventListener('message', function (e) {
    handle(e.data);
  });
  if (global.document) {
    global.document.addEventListener('message', function (e) {
      handle(e.data);
    });
  }

  function nextId() {
    counter += 1;
    return 'r' + counter + '_' + Date.now();
  }

  function request(msg) {
    var id = nextId();
    msg.requestId = id;
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      send(msg);
    });
  }

  var IZ = {
    PROTOCOL: PROTOCOL,
    /** ホストからの初期化（プロフィール・残高・ゲーム設定）を待つ。受信済みなら即解決。 */
    ready: function () {
      if (initData) return Promise.resolve(initData);
      return new Promise(function (resolve) {
        initResolvers.push(resolve);
      });
    },
    /** 賭ける。当落・新残高はサーバーが決めて返す。 */
    placeBet: function (choice, amount) {
      return request({ type: 'iz:bet', choice: choice, amount: amount });
    },
    /** 取得金額ランキング上位を取得する。 */
    getRanking: function () {
      return request({ type: 'iz:ranking' });
    },
  };

  global.IZ = IZ;
  // ホストへ準備完了を通知（ホストは iz:init を返す）
  send({ type: 'iz:ready', protocol: PROTOCOL });
})(window);

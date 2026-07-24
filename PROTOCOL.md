# IZ ゲームブリッジ プロトコル v1

ゲーム（このリポジトリ）と IZ アプリ（ホスト）は `postMessage` で通信する。
ホスト実装は iz-app の `src/lib/gameBridge.ts` / `src/components/GameHost.tsx`(ネイティブ) / `GameHost.web.tsx`(Web)。
ゲーム側は `sdk/iz-sdk.js` がこのプロトコルを実装している。**メッセージ形を変えるときは両リポジトリを同時に更新すること。**

## 基本

- すべてのメッセージは `{ "type": "iz:...", ... }` の JSON。
- 送信経路: Web は `window.parent.postMessage(json, '*')`、ネイティブは `window.ReactNativeWebView.postMessage(json)`。
- 受信経路: ゲームは `window`（および一部ネイティブは `document`）の `message` イベントを購読。
- リクエスト/レスポンスは `requestId`（ゲームが採番）で相関させる。

## メッセージ一覧

### ホスト → ゲーム

| type           | ペイロード                                                                   | 説明                               |
| -------------- | ---------------------------------------------------------------------------- | ---------------------------------- |
| `iz:init`        | `{ protocol, user:{uid,displayName}, balance, game:{id,minBet,maxBet} }`      | 初期化。`iz:ready` への応答         |
| `iz:betResult`   | `{ requestId, won, choice, coinResult, payout, balance }`                     | 賭けの結果（サーバーが決定）        |
| `iz:ranking`     | `{ requestId, entries:[{rank,displayName,net}] }`                            | 取得金額ランキング（賭けゲーム）    |
| `iz:scoreAck`    | `{ requestId, best, isBest }`                                                 | 距離スコア送信の結果（自己ベスト）  |
| `iz:leaderboard` | `{ requestId, entries:[{rank,displayName,score}] }`                          | 距離スコアの共通リーダーボード      |
| `iz:error`       | `{ requestId, code, message }`                                                | リクエスト失敗                      |

### ゲーム → ホスト

| type         | ペイロード                          | 説明                       |
| ------------ | ----------------------------------- | -------------------------- |
| `iz:ready`       | `{ protocol }`                      | 読み込み完了通知            |
| `iz:bet`         | `{ requestId, choice, amount }`     | 賭けの依頼（`amount` は正の整数） |
| `iz:ranking`     | `{ requestId }`                     | 取得金額ランキング取得依頼   |
| `iz:submitScore` | `{ requestId, score }`              | 距離スコア送信（`score` は0以上の整数。IZは動かさない） |
| `iz:leaderboard` | `{ requestId }`                     | 共通リーダーボード取得依頼   |

## セキュリティ（重要）

- **ゲームは IZ を増やせない。** 賭けの当落・残高変更・ランキング更新はすべてサーバーの
  `placeWager` Cloud Function が決める。ゲームは結果アニメを描画するだけ。
- **IZ を動かす新ゲームは iz-app 側のサーバーレジストリ（`functions/src/helpers/game-registry.ts`）への登録（PR レビュー）が必須。**
  このリポジトリにゲームを追加しただけでは IZ は動かせない（manifest は表示・読み込み用）。
- ゲームは Firebase 認証情報を持たない。プロフィール・賭け・ランキングはすべてホストが仲介する。
- ホストはゲームのオリジンを検証し、ゲームから来るメッセージを厳格に検証する。

## SDK の使い方

```html
<script src="../../sdk/iz-sdk.js"></script>
<script>
  IZ.ready().then(function (ctx) {
    // ctx = { user:{uid,displayName}, balance, game:{id,minBet,maxBet} }
  });
  // 賭ける（当落はサーバーが決める）
  IZ.placeBet('heads', 100).then(function (res) {
    // res = { won, choice, coinResult, payout, balance }
  });
  // 取得金額ランキング（賭けゲーム）
  IZ.getRanking().then(function (entries) {
    /* [{rank,displayName,net}] */
  });

  // 距離スコア（IZ を賭けないゲーム）: 送信と共通リーダーボード取得
  IZ.submitScore(1234).then(function (res) {
    /* res = { best, isBest } */
  });
  IZ.getLeaderboard().then(function (entries) {
    /* [{rank,displayName,score}] */
  });
</script>
```

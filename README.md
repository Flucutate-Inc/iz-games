# iz-games

[IZ アプリ](https://github.com/Flucutate-Inc/iz-app)で遊べるミニゲームの**公開リポジトリ**。
ゲームは静的な Web バンドル（HTML/CSS/JS）として GitHub Pages で配信され、IZ アプリが WebView/iframe で読み込む。
**誰でもゲームを追加できる**ように、フロントエンドのみで完結する設計になっている。

## 仕組み

```text
iz-games (GitHub Pages)              IZ アプリ（ホスト）            サーバー
─────────────────────              ──────────────────           ─────────
games.json（ゲーム一覧）  ──fetch──▶ ゲーム一覧画面
games/<id>/index.html    ──load───▶ WebView / iframe
  └ sdk/iz-sdk.js ◀───postMessage───▶ GameHost ───httpsCallable──▶ placeWager (当落・残高を決定)
```

- ゲーム一覧は [`games.json`](./games.json)（manifest）。アプリはこれを取得して一覧表示する。
- ゲームとアプリは `postMessage` ブリッジで通信する（[`PROTOCOL.md`](./PROTOCOL.md)）。
- ブリッジ SDK は [`sdk/iz-sdk.js`](./sdk/iz-sdk.js)。ゲームはこれを読み込んで `IZ.ready()` / `IZ.placeBet()` / `IZ.getRanking()` を使う。

## セキュリティ（必読）

> **ゲームのコードから IZ を増やすことはできない。**

- 賭けの**当落・残高変更・ランキング更新はすべてサーバー（`placeWager` Cloud Function）が決める**。
  ゲームはサーバーが返した結果のアニメーションを描画するだけ。コインの裏表もサーバー RNG。
- 経済は**コミュニティプール方式**。IZ はプレイヤーとプール間でのみ移動し、総量は保存される。
- **IZ を動かす新しいゲームは、IZ アプリ側のサーバーレジストリ（`functions/src/helpers/game-registry.ts`）への登録（PR レビュー）が必須。**
  このリポジトリにゲームを追加しただけでは IZ は動かない（manifest は表示・読み込み用であり、賭けルールの権威ではない）。
- ゲームは Firebase 認証情報を一切持たない。プロフィール・賭け・ランキングはすべてホストが仲介する。

## サンプルゲーム: コインフリップ

[`games/coinflip/`](./games/coinflip/) — 表か裏に IZ を賭け、当たれば 2 倍・外れればゼロ。
3D コインフリップのアニメーションと、取得金額ランキングのタブを持つ。

## ゲームを追加する

1. `games/<your-game>/` に `index.html` / `style.css` / `main.js` を置く（フロントのみ）。
2. `index.html` で SDK を読み込む: `<script src="../../sdk/iz-sdk.js"></script>`。
3. `IZ.ready()` で残高・設定を受け取り、`IZ.placeBet(choice, amount)` で賭け、`IZ.getRanking()` でランキング取得。
4. [`games.json`](./games.json) に自分のゲームのエントリ（`id` / `name` / `description` / `url` / `thumbnail`）を追加。
5. **IZ を賭けるゲームの場合**は、IZ アプリ側 `functions/src/helpers/game-registry.ts` に `id` と賭けルール（wagerKind / minBet / maxBet）を登録する PR を出す。
   - 現状サポートする賭け方式は `doubleOrNothing`（50/50 の倍プッシュ）。新しい方式が必要なら IZ アプリ側に `resolveWager` の分岐を追加する。

## GitHub Pages の公開手順

1. このリポジトリを **public** で GitHub に作成して push。
2. Settings → Pages → Source: `Deploy from a branch` → `main` / `/ (root)`。
3. 数分後 `https://<org>.github.io/iz-games/` で配信される。
   - manifest: `https://<org>.github.io/iz-games/games.json`
   - コインフリップ: `https://<org>.github.io/iz-games/games/coinflip/index.html`
4. IZ アプリ側の `EXPO_PUBLIC_IZ_GAMES_MANIFEST_URL` を manifest の URL に設定して再ビルド。

> `.nojekyll` を置いているため Jekyll 処理はスキップされる（`sdk/` 等のディレクトリもそのまま配信）。

## ローカルで試す

```bash
python3 -m http.server 5055
# Node.js を使う場合: npx serve . -l 5055
# → http://localhost:5055/games.json をアプリの EXPO_PUBLIC_IZ_GAMES_MANIFEST_URL に設定
```

ゲーム単体はブラウザで `http://localhost:5055/games/<id>/index.html` を開いて確認できる。
Docker やデータベースは不要。

## ライセンス

MIT（[LICENSE](./LICENSE)）。誰でも自由にゲームを開発・追加できる。

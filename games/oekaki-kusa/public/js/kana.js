/**
 * ひらがなの正規化(クライアント側)。
 *
 * 回答欄はひらがなしか受け付けない。ただし入力を弾くのではなく、
 * **打ったそばからひらがなに直す**。カタカナで打っても、英数字が混ざっても、
 * 勝手にひらがなだけが残る。原作は「ひらがな以外だと不正解」で公式FAQの筆頭が
 * 「ひらがな入力ができません」だったので、そこを入力側で吸収してしまう。
 *
 * サーバー側の同じ実装は worker/src/kana.js。**片方だけ変えないこと。**
 */
(function (global) {
  function kataToHira(s) {
    return s.replace(/[ァ-ヶ]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0x60);
    });
  }

  /** ひらがな・長音符だけを残す。カタカナはひらがなに直してから残す */
  function toHiraganaOnly(input) {
    var s = kataToHira(String(input == null ? '' : input).normalize('NFKC'));
    return (s.match(/[ぁ-ゖゝー]/g) || []).join('');
  }

  global.Kana = { toHiraganaOnly: toHiraganaOnly };
})(window);

/**
 * ひらがなの正規化と正誤判定。
 *
 * 原作は「ひらがな以外が混ざると、答えが合っていても不正解」という厳格な仕様で、
 * 公式FAQの筆頭が「ひらがな入力ができません」「回答しても正解になりません」だった。
 * スマホでそれをそのまま持ち込むと理不尽なので、**入力欄をひらがなに限定したうえで、
 * 判定は表記ゆれに寛容**にする(カタカナ・全角/半角・濁点・長音・小文字の揺れを吸収)。
 *
 * クライアント側の同じ実装は public/js/kana.js。**片方だけ変えないこと。**
 */

/** カタカナ → ひらがな(長音符はそのまま) */
function kataToHira(s) {
  return s.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** 全角英数記号 → 半角、半角カタカナ → 全角カタカナ相当の正規化 */
function widthNormalize(s) {
  // NFKC で半角カナ・全角英数をまとめて正規化する
  return s.normalize('NFKC');
}

/**
 * 入力欄に残してよい文字だけにする(ひらがな・長音符のみ)。
 * カタカナは自動でひらがなに直す。それ以外(漢字・英数・記号・空白)は落とす。
 */
export function toHiraganaOnly(input) {
  const s = kataToHira(widthNormalize(String(input || '')));
  return (s.match(/[ぁ-ゖゝー]/g) || []).join('');
}

/** 判定用のキー。小文字・濁点・長音の揺れを吸収して比較しやすくする */
export function answerKey(input) {
  let s = toHiraganaOnly(input);
  s = s.replace(/ー/g, ''); // 長音の有無を無視(「らーめん」=「らめん」)
  // 小書き文字を大書きに寄せる(「ぎゅうにゅう」と「ぎゆうにゆう」を同一視)
  const small = 'ぁぃぅぇぉっゃゅょゎゕゖ';
  const big = 'あいうえおつやゆよわかけ';
  s = s.replace(/[ぁぃぅぇぉっゃゅょゎゕゖ]/g, c => big[small.indexOf(c)]);
  // 濁点・半濁点を落とす(「ばなな」=「はなな」まで許す。誤爆より取りこぼしを嫌う)
  const dakuten = {
    が: 'か', ぎ: 'き', ぐ: 'く', げ: 'け', ご: 'こ',
    ざ: 'さ', じ: 'し', ず: 'す', ぜ: 'せ', ぞ: 'そ',
    だ: 'た', ぢ: 'ち', づ: 'つ', で: 'て', ど: 'と',
    ば: 'は', び: 'ひ', ぶ: 'ふ', べ: 'へ', ぼ: 'ほ',
    ぱ: 'は', ぴ: 'ひ', ぷ: 'ふ', ぺ: 'へ', ぽ: 'ほ',
  };
  s = s.replace(/[がぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽ]/g, c => dakuten[c]);
  return s;
}

/** 回答が正解か。topic は { answer, alt[] } */
export function isCorrect(guess, topic) {
  const key = answerKey(guess);
  if (!key) return false;
  const answers = [topic.answer, ...(topic.alt || [])];
  return answers.some(a => answerKey(a) === key);
}

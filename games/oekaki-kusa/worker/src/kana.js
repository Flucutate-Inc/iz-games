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

// ─── 絵しりとり用 ─────────────────────────────────────────

const SMALL_TO_BIG = {
  ぁ: 'あ', ぃ: 'い', ぅ: 'う', ぇ: 'え', ぉ: 'お',
  ゃ: 'や', ゅ: 'ゆ', ょ: 'よ', ゎ: 'わ', ゕ: 'か', ゖ: 'け', っ: 'つ',
};

const DAKUTEN_STRIP = {
  が: 'か', ぎ: 'き', ぐ: 'く', げ: 'け', ご: 'こ',
  ざ: 'さ', じ: 'し', ず: 'す', ぜ: 'せ', ぞ: 'そ',
  だ: 'た', ぢ: 'ち', づ: 'つ', で: 'て', ど: 'と',
  ば: 'は', び: 'ひ', ぶ: 'ふ', べ: 'へ', ぼ: 'ほ',
  ぱ: 'は', ぴ: 'ひ', ぷ: 'ふ', ぺ: 'へ', ぽ: 'ほ',
};

/**
 * ことばの「しりとり上の最後の文字」= 次の人の頭文字。
 * しりとりの慣例に合わせて、長音「ー」は飛ばし(「ぎたー」→「た」)、
 * 小書き文字は大書きにする(「かぼちゃ」→「や」)。
 */
export function shiritoriNextChar(word) {
  const s = toHiraganaOnly(word);
  let i = s.length - 1;
  while (i >= 0 && (s[i] === 'ー' || s[i] === 'ゝ')) i--;
  if (i < 0) return null;
  const ch = s[i];
  return SMALL_TO_BIG[ch] || ch;
}

/** 前のことばに次のことばが繋がるか。濁点・半濁点の揺れは許す(「ふ」に「ぷ〜」も可) */
export function shiritoriConnects(prevWord, nextWord) {
  const tail = shiritoriNextChar(prevWord);
  const s = toHiraganaOnly(nextWord);
  if (!tail || !s) return false;
  const head = SMALL_TO_BIG[s[0]] || s[0];
  return (DAKUTEN_STRIP[head] || head) === (DAKUTEN_STRIP[tail] || tail);
}

/** 「ん」で終わることば(しりとりでは出せない) */
export function shiritoriEndsWithN(word) {
  return shiritoriNextChar(word) === 'ん';
}

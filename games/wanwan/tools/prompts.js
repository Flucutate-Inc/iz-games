/**
 * わんわん大戦争 素材生成プロンプト定義
 *
 * スタイルは IZ アプリ本体のペットカタログ(iz/src/lib/pet-catalog.json)と同じ
 * 「16-bit ピクセルアート・ちびカワ・黒縁取り・白背景」で統一する。
 * 対戦ゲーム用に、キャラクターは正面ではなく「右向きの真横」で生成する
 * (敵側は実行時に左右反転して使う)。
 */

/** キャラクター基準ポーズ(idle)用プロンプト */
function petBasePrompt(subject, pose) {
  return (
    `Pixel art sprite of ${subject}. ` +
    '16-bit retro video game style with chunky, clearly visible square pixels and a limited but vibrant color palette. ' +
    'Bold solid black outline. Cute kawaii chibi proportions (big head, small rounded body, large friendly eyes). ' +
    `Exactly one character, full body, strict side view facing right, ${pose}. ` +
    'Plain pure white background (#FFFFFF) with no ground shadow. ' +
    'No text, no letters, no border, no frame, no UI elements. ' +
    'Square 1:1 composition with the character occupying roughly the central 70% of the image.'
  );
}

/** 基準画像を添付して別ポーズを生成するときのプロンプト(一貫性担保) */
function petPosePrompt(pose) {
  return (
    'Use the attached pixel art character as the exact reference. ' +
    'Redraw THE SAME character with identical design, colors, accessories, proportions and pixel-art style, ' +
    `changing only the pose to: ${pose}. ` +
    'Keep strict side view facing right, same character size, plain pure white background (#FFFFFF), ' +
    'no ground shadow, no text, no border, square 1:1 composition.'
  );
}

/** 基準ポーズ(idle)。アニメーションは Veo(image-to-video)で生成しフレームを切り出す */
const PET_POSES = {
  idle: 'calm standing idle pose',
};

/**
 * Veo image-to-video 用アニメーション定義。
 * 基準スプライト(白背景 raw)を初期フレームとして渡し、動画からフレームを抽出する。
 *   frames: [出力ファイル名, 動画内の位置(0..1)] の配列
 */
const PET_ANIMS = {
  walk: {
    prompt:
      'The pixel art dog character walks in place with a steady four-legged walking gait, ' +
      'strict side view facing right. Static locked-off camera, no camera motion, no zoom. ' +
      'The character stays perfectly centered at the same size for the whole video. ' +
      'Plain pure white background (#FFFFFF) at all times, nothing else appears. ' +
      'The 16-bit pixel art style, colors and design of the character are preserved exactly. Seamless loop.',
    frames: [
      ['walk_1', 0.1],
      ['walk_2', 0.35],
      ['walk_3', 0.6],
      ['walk_4', 0.85],
    ],
  },
  attack: {
    prompt:
      'The pixel art dog character performs one quick attack action toward the right ' +
      '(a lunge, bite or weapon swing matching its equipment) and then returns to standing, ' +
      'strict side view facing right. Static locked-off camera, no camera motion, no zoom. ' +
      'The character stays centered at the same size. Plain pure white background (#FFFFFF) at all times. ' +
      'The 16-bit pixel art style, colors and design of the character are preserved exactly.',
    frames: [
      ['attack_1', 0.2],
      ['attack_2', 0.4],
      ['attack_3', 0.6],
    ],
  },
  hitfall: {
    prompt:
      'The pixel art dog character flinches backward as if hit by an attack, ' +
      'then falls down and lies knocked out on its side with X-shaped closed eyes, ' +
      'strict side view facing right. Static locked-off camera, no camera motion, no zoom. ' +
      'The character stays centered at the same size. Plain pure white background (#FFFFFF) at all times. ' +
      'The 16-bit pixel art style, colors and design of the character are preserved exactly.',
    frames: [
      ['hurt', 0.25],
      ['death', 0.95],
    ],
  },
};

/** 施設(青チーム基準。赤チームはスクリプト側で色相変換) */
function facilityBasePrompt(subject, state) {
  return (
    `Pixel art sprite of ${subject}, decorated with BLUE team banners, a blue flag and blue roof accents. ` +
    '16-bit retro video game style with chunky square pixels, bold solid black outline, cute cozy toy-like look. ' +
    `${state} ` +
    'Front view, single building only. Plain pure white background (#FFFFFF) with no ground shadow. ' +
    'No text, no letters, no border, no frame. Square 1:1 composition, building occupying roughly the central 75% of the image.'
  );
}

function facilityStatePrompt(state) {
  return (
    'Use the attached pixel art building as the exact reference. ' +
    'Redraw THE SAME building with identical design, colors and pixel-art style, ' +
    `changing only its condition to: ${state} ` +
    'Keep the same viewpoint and size, plain pure white background (#FFFFFF), no text, no border, square 1:1 composition.'
  );
}

const FACILITY_STATES = {
  normal: 'The building is in perfect, cheerful condition.',
  damaged: 'The building is visibly damaged: cracks in the walls, a few broken planks, tilted flag, and two small smoke puffs.',
  destroyed: 'The building has collapsed into a pile of rubble and broken planks with rising smoke, only fragments of the walls remain.',
};

/** 背景(白抜きしない・ワイド) */
const BACKGROUND = {
  id: 'arena',
  aspectRatio: '16:9',
  prompt:
    'Pixel art background for a 2-lane dog battle game, wide landscape composition. ' +
    'Bright blue sky with fluffy clouds and a soft sun, distant park scenery with trees and colorful tents, ' +
    'a cheering crowd of tiny dogs waving small flags along the far edge. ' +
    'Two clearly separated horizontal dirt lanes (an upper lane and a lower lane) running left to right across the FULL width of the screen. ' +
    'IMPORTANT: both lanes are OPEN at the left end and the right end — the dirt paths visibly continue and curve into open grassy courtyard areas at the far left and far right edges (where each team\'s home base stands), so it is clear that units can walk from the lanes into the bases. ' +
    'Low wooden fences run ONLY along the middle strip between the two lanes and along the outer sides; the fences STOP well before the left and right ends, leaving wide open gaps — no fence blocks the ends of the lanes. ' +
    '16-bit retro video game style with chunky square pixels and a vibrant color palette. ' +
    'Completely empty lanes: no characters, no buildings, no dogs on the lanes. No text, no letters, no UI elements.',
};

/** エフェクト(白背景 → 透過) */
const EFFECTS = [
  { id: 'hit-small', subject: 'a small comic-style impact spark, a yellow and white four-pointed star burst' },
  { id: 'hit-big', subject: 'a large orange comic-style impact burst with jagged rays and small sparks' },
  { id: 'explosion', subject: 'a round cartoon explosion fireball with orange and yellow flames and a few flying debris bits' },
  { id: 'shot-impact', subject: 'a small dust puff with tiny sparks where a projectile just landed' },
  { id: 'heal', subject: 'sparkling green plus signs and soft glowing green particles floating upward' },
  { id: 'buff-atk', subject: 'a bold red upward arrow surrounded by small rising sparkles' },
  { id: 'debuff-atk', subject: 'a bold purple downward arrow with small dripping droplets' },
  { id: 'stun', subject: 'a ring of small yellow stars and one tiny yellow bird circling, seen slightly from above' },
  { id: 'shield', subject: 'a translucent light-blue round shield emblem with a white dog bone symbol in the center' },
  { id: 'smoke-spawn', subject: 'a puffy white smoke cloud with two small paw prints appearing in front of it' },
  { id: 'smoke-death', subject: 'a small grey round ghost-like puff cloud floating upward with tiny sparkles' },
];

function effectPrompt(subject) {
  return (
    `Pixel art game effect sprite of ${subject}. ` +
    '16-bit retro video game style with chunky square pixels and a vibrant palette, bold clean shapes. ' +
    'Effect only, no characters, no creatures. Centered on a plain pure white background (#FFFFFF). ' +
    'No text, no letters, no border, no frame. Square 1:1 composition, effect occupying roughly the central 60% of the image.'
  );
}

/** UIアイコン(白背景 → 透過) */
const UI_ICONS = [
  { id: 'icon-bone', subject: 'a single cartoon white dog bone, plump and glossy' },
  { id: 'icon-treat', subject: 'a golden-brown bone-shaped dog biscuit treat with sparkles, looking delicious' },
  { id: 'icon-crown', subject: 'a small shiny golden crown with red gems' },
];

function uiIconPrompt(subject) {
  return (
    `Pixel art game icon of ${subject}. ` +
    '16-bit retro video game style with chunky square pixels, bold solid black outline, vibrant colors. ' +
    'Single object only, centered on a plain pure white background (#FFFFFF). ' +
    'No text, no letters, no border, no frame. Square 1:1 composition, object occupying roughly the central 65% of the image.'
  );
}

/** タイトルロゴ(日本語テキストを含む特例。白背景 → 透過) */
const TITLE_LOGO = {
  id: 'title-logo',
  aspectRatio: '16:9',
  prompt:
    'Pixel art video game logo with the Japanese title text 「わんわん大戦争」 written in big, bold, playful pixel lettering ' +
    '(orange and cream letters with a dark outline). ' +
    'Decorated with dog paw prints, a bone, and two cute chibi pixel dog faces glaring at each other from the left and right ends. ' +
    '16-bit retro style, vibrant colors, centered composition on a plain pure white background (#FFFFFF). ' +
    'No other text besides 「わんわん大戦争」. No border, no frame.',
};

/** サムネイル(games.json 用カバー。白抜きしない) */
const THUMB = {
  id: 'thumb',
  aspectRatio: '1:1',
  prompt:
    'Pixel art cover illustration for a dog battle strategy game: two cute chibi pixel dogs (a shiba inu with a red bandana on the left ' +
    'and a great dane wearing a golden crown on the right) facing off in the middle of a grassy battlefield, ' +
    'with a blue dog house on the left side and a red dog house on the right side, bright sky with clouds above. ' +
    '16-bit retro video game style with chunky square pixels and a vibrant palette. No text, no letters, no border.',
};

module.exports = {
  petBasePrompt,
  petPosePrompt,
  PET_POSES,
  PET_ANIMS,
  facilityBasePrompt,
  facilityStatePrompt,
  FACILITY_STATES,
  BACKGROUND,
  EFFECTS,
  effectPrompt,
  UI_ICONS,
  uiIconPrompt,
  TITLE_LOGO,
  THUMB,
};

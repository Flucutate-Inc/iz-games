(function () {
  "use strict";

  var TOTAL_ROUNDS = 3;
  var BEATS_PER_ROUND = 12;
  var ROUND_BPM = [100, 112, 124];
  var PATTERNS = [
    [0, 2, 4, 6, 8, 9, 10],
    [0, 2, 3, 5, 7, 8, 10, 11],
    [0, 1, 3, 4, 6, 8, 9, 10, 11]
  ];
  var PERFECT_WINDOW = 105;
  var GOOD_WINDOW = 230;

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    startView: $("start-view"),
    resultView: $("result-view"),
    startBtn: $("start-btn"),
    retryBtn: $("retry-btn"),
    hitBtn: $("hit-btn"),
    letter: $("letter"),
    stamp: $("stamp"),
    bird: $("bird"),
    callout: $("callout"),
    score: $("score"),
    combo: $("combo"),
    round: $("round"),
    finalScore: $("final-score"),
    perfectCount: $("perfect-count"),
    goodCount: $("good-count"),
    missCount: $("miss-count"),
    resultTitle: $("result-title"),
    rankFace: $("rank-face")
  };

  var audio = null;
  var game = null;
  var frame = 0;
  var timers = [];

  function newGame() {
    return {
      active: false,
      round: 0,
      score: 0,
      combo: 0,
      maxCombo: 0,
      perfect: 0,
      good: 0,
      miss: 0,
      targets: [],
      roundStart: 0,
      beatMs: 600,
      nextBeat: 0
    };
  }

  function clearTimers() {
    timers.forEach(function (timer) { clearTimeout(timer); });
    timers = [];
    cancelAnimationFrame(frame);
  }

  function later(fn, ms) {
    var timer = setTimeout(fn, ms);
    timers.push(timer);
    return timer;
  }

  function ensureAudio() {
    var AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    if (!audio) audio = new AudioContext();
    if (audio.state === "suspended") audio.resume();
  }

  function tone(frequency, duration, type, volume, delay) {
    if (!audio) return;
    var start = audio.currentTime + (delay || 0);
    var oscillator = audio.createOscillator();
    var gain = audio.createGain();
    oscillator.type = type || "sine";
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume || 0.08, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }

  function playBeat(accent) {
    tone(accent ? 510 : 390, 0.07, "triangle", accent ? 0.11 : 0.06);
    if (accent) tone(760, 0.04, "sine", 0.05, 0.015);
  }

  function playHit(kind) {
    if (kind === "perfect") {
      tone(680, 0.09, "square", 0.08);
      tone(1020, 0.12, "sine", 0.08, 0.05);
    } else if (kind === "good") {
      tone(560, 0.1, "triangle", 0.07);
    } else {
      tone(145, 0.16, "sawtooth", 0.05);
    }
  }

  function updateHud() {
    els.score.textContent = game.score;
    els.combo.textContent = game.combo;
    els.round.textContent = Math.min(game.round + 1, TOTAL_ROUNDS);
  }

  function setCallout(text, kind) {
    els.callout.textContent = text;
    els.callout.className = "callout" + (kind ? " " + kind : "");
  }

  function startGame() {
    ensureAudio();
    clearTimers();
    game = newGame();
    els.startView.classList.add("hidden");
    els.resultView.classList.add("hidden");
    updateHud();
    setCallout("3・2・1…");
    later(function () { startRound(0); }, 700);
  }

  function startRound(roundIndex) {
    game.round = roundIndex;
    game.active = false;
    game.beatMs = 60000 / ROUND_BPM[roundIndex];
    game.targets = PATTERNS[roundIndex].map(function (beat) {
      return { beat: beat, time: 0, judged: false };
    });
    updateHud();
    setCallout(roundIndex === 0 ? "合図でポン！" : "テンポアップ！");

    later(function () {
      var leadBeats = 2;
      game.roundStart = performance.now() + leadBeats * game.beatMs;
      game.targets.forEach(function (target) {
        target.time = game.roundStart + target.beat * game.beatMs;
      });
      game.nextBeat = -leadBeats;
      game.active = true;
      animate();
    }, 650);
  }

  function animate(now) {
    if (!game || !game.active) return;
    now = now || performance.now();

    while (game.nextBeat <= BEATS_PER_ROUND &&
      now >= game.roundStart + game.nextBeat * game.beatMs) {
      playBeat(game.nextBeat % 4 === 0);
      els.bird.classList.add("bop");
      later(function () { els.bird.classList.remove("bop"); }, 85);
      game.nextBeat += 1;
    }

    var nextTarget = game.targets.find(function (target) { return !target.judged; });
    if (nextTarget) {
      var travelMs = game.beatMs * 1.65;
      var progress = 1 - (nextTarget.time - now) / travelMs;
      var targetX = window.innerWidth / 2 + 88;
      var x = progress * targetX;
      els.letter.style.transform = "translateX(" + x + "px) rotate(-2deg)";
      els.letter.classList.remove("stamped");

      if (now - nextTarget.time > GOOD_WINDOW) {
        judge(nextTarget, "miss");
      }
    }

    var endTime = game.roundStart + BEATS_PER_ROUND * game.beatMs;
    if (now > endTime + 500 && game.targets.every(function (target) { return target.judged; })) {
      game.active = false;
      if (game.round + 1 < TOTAL_ROUNDS) {
        setCallout("いい調子！");
        later(function () { startRound(game.round + 1); }, 900);
      } else {
        later(showResult, 700);
      }
      return;
    }

    frame = requestAnimationFrame(animate);
  }

  function press() {
    if (!game || !game.active) return;
    var now = performance.now();
    var target = null;
    var bestDelta = Infinity;

    game.targets.forEach(function (candidate) {
      if (candidate.judged) return;
      var delta = Math.abs(now - candidate.time);
      if (delta < bestDelta) {
        bestDelta = delta;
        target = candidate;
      }
    });

    animateStamp();
    if (!target || bestDelta > GOOD_WINDOW) {
      looseMiss();
      return;
    }
    judge(target, bestDelta <= PERFECT_WINDOW ? "perfect" : "good");
  }

  function animateStamp() {
    els.stamp.classList.remove("hit");
    els.hitBtn.classList.add("pressed");
    void els.stamp.offsetWidth;
    els.stamp.classList.add("hit");
    later(function () {
      els.stamp.classList.remove("hit");
      els.hitBtn.classList.remove("pressed");
    }, 190);
  }

  function looseMiss() {
    game.combo = 0;
    setCallout("まだだよ！", "miss");
    playHit("miss");
    updateHud();
  }

  function judge(target, kind) {
    if (target.judged) return;
    target.judged = true;

    if (kind === "perfect") {
      game.combo += 1;
      game.perfect += 1;
      game.score += 100 + Math.min(game.combo * 3, 60);
      setCallout("ジャスト！", "perfect");
      els.letter.classList.add("stamped");
    } else if (kind === "good") {
      game.combo += 1;
      game.good += 1;
      game.score += 60;
      setCallout("グッド！", "good");
      els.letter.classList.add("stamped");
    } else {
      game.combo = 0;
      game.miss += 1;
      setCallout("おしい！", "miss");
    }

    game.maxCombo = Math.max(game.maxCombo, game.combo);
    playHit(kind);
    updateHud();
  }

  function showResult() {
    var maxTargets = PATTERNS.reduce(function (sum, pattern) { return sum + pattern.length; }, 0);
    var accuracy = (game.perfect + game.good * 0.6) / maxTargets;
    var title;
    var face;

    if (accuracy >= 0.88) {
      title = "局長クラス！";
      face = "◎";
    } else if (accuracy >= 0.6) {
      title = "おみごと！";
      face = "○";
    } else {
      title = "もうひと押し！";
      face = "△";
    }

    els.finalScore.textContent = game.score;
    els.perfectCount.textContent = game.perfect;
    els.goodCount.textContent = game.good;
    els.missCount.textContent = game.miss;
    els.resultTitle.textContent = title;
    els.rankFace.textContent = face;
    els.resultView.classList.remove("hidden");
    tone(523, 0.18, "triangle", 0.08);
    tone(659, 0.18, "triangle", 0.08, 0.16);
    tone(784, 0.3, "triangle", 0.09, 0.32);
  }

  els.startBtn.addEventListener("click", startGame);
  els.retryBtn.addEventListener("click", startGame);
  els.hitBtn.addEventListener("pointerdown", function (event) {
    event.preventDefault();
    press();
  });
  window.addEventListener("keydown", function (event) {
    if ((event.code === "Space" || event.code === "Enter") && !event.repeat) {
      if (!els.startView.classList.contains("hidden")) return;
      event.preventDefault();
      press();
    }
  });
})();

/* 나만의 영어 사전 — 화면과 상관없는 계산만 모아 둔 파일
   · 간격 반복(잘 아는 단어는 퀴즈 간격을 늘리고, 모르는 단어는 줄여요)
   · 퀴즈 문제 만들기 (영어→뜻, 한글→영어, 빈칸 채우기)
   · 단어 알림 시간 계산 */
(function (root) {
  'use strict';

  const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const MAX_INTERVAL = 180 * DAY;
  const EASE_START = 2.5, EASE_MIN = 1.3, EASE_MAX = 3.0;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /* ---------- 간격 반복 ---------- */

  function newSrs(now) {
    return { due: now, interval: 0, ease: EASE_START, reps: 0, lapses: 0, last: 0, right: 0, wrong: 0 };
  }

  // grade: 0 = 틀림, 1 = 힌트를 보고 맞힘(애매함), 2 = 바로 맞힘
  // · 틀리면 10분 뒤에 다시 나오고, 그 단어의 '쉬움 정도(ease)'가 내려가서 앞으로 간격이 천천히 늘어나요.
  // · 맞히면 4시간 → 1일 → 그 뒤로는 (이전 간격 × 쉬움 정도)만큼 늘어나요.
  // · 복습할 때가 되기 전에 미리 맞히면, 지난 복습 뒤로 지난 시간만큼만 인정해요.
  function review(srs, grade, now) {
    const s = Object.assign(newSrs(now), srs);
    const early = s.last > 0 && now < s.due;
    if (grade <= 0) {
      s.wrong += 1;
      if (s.last > 0) s.lapses += 1;
      s.reps = 0;
      s.ease = clamp(s.ease - 0.2, EASE_MIN, EASE_MAX);
      s.interval = 10 * MIN;
    } else {
      const good = grade >= 2;
      s.right += 1;
      if (early) {
        const elapsed = Math.max(0, now - s.last);
        s.interval = Math.max(s.interval, Math.round(elapsed * (good ? s.ease : 1.2)));
      } else {
        if (s.reps === 0) s.interval = good ? 4 * HOUR : 1 * HOUR;
        else if (s.reps === 1) s.interval = good ? 1 * DAY : 12 * HOUR;
        else s.interval = Math.round(s.interval * (good ? s.ease : 1.2));
        s.reps += 1;
        s.ease = clamp(s.ease + (good ? 0.1 : -0.15), EASE_MIN, EASE_MAX);
      }
    }
    s.interval = Math.min(s.interval, MAX_INTERVAL);
    s.last = now;
    s.due = now + s.interval;
    return s;
  }

  const LEVELS = [
    { level: 0, key: 'new', label: '새 단어' },
    { level: 1, key: 'learning', label: '학습 중' },
    { level: 2, key: 'familiar', label: '익숙해지는 중' },
    { level: 3, key: 'almost', label: '거의 외움' },
    { level: 4, key: 'master', label: '외움' },
  ];

  function mastery(srs) {
    if (!srs || (srs.right + srs.wrong) === 0) return LEVELS[0];
    const iv = srs.interval;
    if (iv < DAY) return LEVELS[1];
    if (iv < 7 * DAY) return LEVELS[2];
    if (iv < 30 * DAY) return LEVELS[3];
    return LEVELS[4];
  }

  const isDue = (w, now) => w.srs.due <= now;

  function dueWords(words, now) {
    return words.filter(w => isDue(w, now))
      .sort((a, b) => (a.srs.due - b.srs.due) || (a.srs.ease - b.srs.ease));
  }

  // 복습할 단어가 모자랄 때 '미리 연습'용: 복습 시간이 가까운 단어부터
  function upcomingWords(words, now) {
    return words.filter(w => !isDue(w, now)).sort((a, b) => a.srs.due - b.srs.due);
  }

  function nextDue(words, now) {
    let t = Infinity;
    for (const w of words) if (w.srs.due > now && w.srs.due < t) t = w.srs.due;
    return t === Infinity ? null : t;
  }

  /* ---------- 문장 속에서 단어 찾기 ---------- */

  // run → runs, running, ran(X: 불규칙은 못 찾아요), happy → happier, happily 처럼 흔한 변화형을 찾아요.
  function wordPattern(word) {
    const parts = String(word).trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    const head = parts[0];
    const h = escapeRe(head);
    const forms = [h + '(?:s|es|ed|d|ing|er|ers|est|ly|ness|ment|ments|ful|al)?'];
    if (/e$/.test(head) && head.length > 2) forms.push(escapeRe(head.slice(0, -1)) + '(?:ing|ed|er|ers|est|ion|ions)');
    if (/[^aeiou]y$/.test(head)) forms.push(escapeRe(head.slice(0, -1)) + '(?:ies|ied|ier|iest|ily|iness)');
    if (/(^|[^aeiou])[aeiou][bdgklmnprtvz]$/.test(head) && head.length <= 6) forms.push(h + escapeRe(head.slice(-1)) + '(?:ed|ing|er|ers|est)');
    if (/ic$/.test(head)) forms.push(h + 'ally');
    if (/le$/.test(head)) forms.push(escapeRe(head.slice(0, -1)) + 'y');
    if (/fe?$/.test(head) && head.length > 2) forms.push(escapeRe(head.replace(/fe?$/, '')) + 'ves');
    const rest = parts.slice(1).map(escapeRe).join('\\s+');
    // 앞 글자는 캡처 그룹으로 확인해요 (예전 아이폰 Safari는 '뒤돌아보기' 정규식을 못 써요)
    const src = '(^|[^A-Za-z])((?:' + forms.join('|') + ')' + (rest ? '\\s+' + rest : '') + ')(?![A-Za-z])';
    return new RegExp(src, 'i');
  }

  function findWord(word, sentence) {
    const re = wordPattern(word);
    if (!re || !sentence) return null;
    const m = re.exec(sentence);
    return m ? { index: m.index + m[1].length, length: m[2].length, text: m[2] } : null;
  }

  /* ---------- 퀴즈 ---------- */

  const norm = s => String(s || '').toLowerCase().replace(/[’‘`]/g, "'").replace(/[.,!?;:"]+$/g, '').replace(/\s+/g, ' ').trim();

  function checkTyped(input, answer) {
    const a = norm(input);
    return a.length > 0 && a === norm(answer);
  }

  function meaningText(w, max) {
    const ko = (w.meanings || []).map(m => m.ko).filter(Boolean);
    if (ko.length) return ko.slice(0, max || 2).join(' / ');
    const d = (w.defs || [])[0];
    return d ? d.en : '';
  }

  function posOf(w) {
    const m = (w.meanings || []).find(x => x.pos);
    if (m) return m.pos;
    const d = (w.defs || [])[0];
    return d ? d.pos : '';
  }

  function shuffle(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // 같은 품사 단어를 먼저 오답 보기로 써요 (너무 쉽게 티 나지 않게)
  function pickDistractors(word, others, valueOf, n, rng) {
    const answer = norm(valueOf(word));
    const pos = posOf(word);
    const seen = new Set([answer]);
    const pool = shuffle(others, rng).sort((a, b) => (posOf(b) === pos) - (posOf(a) === pos));
    const out = [];
    for (const o of pool) {
      const v = valueOf(o);
      const k = norm(v);
      if (!v || seen.has(k)) continue;
      seen.add(k);
      out.push(v);
      if (out.length >= n) break;
    }
    return out;
  }

  const MAKERS = {
    en2ko(word, others, rng) {
      const answer = meaningText(word);
      if (!answer) return null;
      const wrong = pickDistractors(word, others, o => meaningText(o), 3, rng);
      if (!wrong.length) return null;
      return { type: 'en2ko', wordId: word.id, prompt: word.word, choices: shuffle([answer, ...wrong], rng), answer };
    },
    ko2en(word) {
      const prompt = meaningText(word, 3);
      if (!prompt) return null;
      return { type: 'ko2en', wordId: word.id, prompt, pos: posOf(word), answer: word.word };
    },
    cloze(word, others, rng) {
      let usable = (word.examples || []).map(ex => ({ ex, hit: findWord(word.word, ex.en) })).filter(x => x.hit);
      if (!usable.length) return null;
      // 'Tom is ___.' 처럼 짧은 문장은 보기가 여러 개 맞을 수 있어서, 6단어 이상 문장을 먼저 써요
      const long = usable.filter(x => x.ex.en.trim().split(/\s+/).length >= 6);
      if (long.length) usable = long;
      const { ex, hit } = usable[Math.floor(rng() * usable.length)];
      const wrong = pickDistractors(word, others, o => o.word, 3, rng);
      if (!wrong.length) return null;
      return {
        type: 'cloze', wordId: word.id,
        before: ex.en.slice(0, hit.index), blank: hit.text, after: ex.en.slice(hit.index + hit.length),
        sentence: ex.en, ko: ex.ko || '',
        choices: shuffle([word.word, ...wrong], rng), answer: word.word,
      };
    },
  };

  const ORDER = {
    en2ko: ['en2ko', 'cloze', 'ko2en'],
    ko2en: ['ko2en', 'en2ko', 'cloze'],
    cloze: ['cloze', 'en2ko', 'ko2en'],
  };

  // '섞어서'일 때: 새로 배우는 단어는 알아보기(영어→뜻) 위주, 익숙한 단어는 떠올리기(한글→영어)·빈칸 위주
  function pickType(word, rng) {
    const lv = mastery(word.srs).level;
    const r = rng();
    if (lv <= 1) return r < 0.5 ? 'en2ko' : r < 0.8 ? 'cloze' : 'ko2en';
    return r < 0.2 ? 'en2ko' : r < 0.6 ? 'cloze' : 'ko2en';
  }

  function buildQuestion(word, all, type, rng) {
    rng = rng || Math.random;
    const others = all.filter(o => o.id !== word.id && norm(o.word) !== norm(word.word));
    const t = type === 'mixed' || !ORDER[type] ? pickType(word, rng) : type;
    for (const k of ORDER[t]) {
      const q = MAKERS[k](word, others, rng);
      if (q) return q;
    }
    return null;
  }

  function hintFor(answer, level) {
    const a = String(answer);
    if (level <= 0) return '';
    const shown = a.split('').map((c, i) => (i === 0 || c === ' ' || c === '-' || c === "'") ? c : '_').join(' ');
    return shown + '  (' + a.replace(/[\s'-]/g, '').length + '글자)';
  }

  /* ---------- 단어 알림 시간 ---------- */

  // from~to시 사이에만 알림 (from === to 이면 하루 종일, from > to 이면 밤을 넘기는 시간대)
  function inWindow(t, from, to) {
    if (from === to) return true;
    const d = new Date(t);
    const h = d.getHours() + d.getMinutes() / 60;
    return from < to ? (h >= from && h < to) : (h >= from || h < to);
  }

  function alignToWindow(t, from, to) {
    if (inWindow(t, from, to)) return t;
    const s = new Date(t);
    s.setHours(from, 0, 0, 0);
    if (s.getTime() <= t) s.setDate(s.getDate() + 1);
    return s.getTime();
  }

  function nextPopupTime(now, everyMin, from, to) {
    return alignToWindow(now + Math.max(1, everyMin) * MIN, from, to);
  }

  // 알림에 띄울 단어: 랜덤으로 고르되, weak이면 덜 외운 단어가 더 자주 나와요. 최근에 나온 단어는 피해요.
  function pickPopupWord(words, opts) {
    const o = opts || {};
    const rng = o.rng || Math.random;
    if (!words.length) return null;
    const recent = o.recent || [];
    let pool = words.filter(w => !recent.includes(w.id));
    if (!pool.length) pool = words;
    const WEIGHT = [3, 3, 2, 1.5, 1];
    const weights = pool.map(w => (o.weak === false ? 1 : WEIGHT[mastery(w.srs).level]));
    let r = rng() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r < 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  /* ---------- 보기 좋은 시간 표시 ---------- */

  // 반올림한 뒤에 단위를 골라요 (59분 40초 → '60분'이 아니라 '1시간')
  function fmtDuration(ms) {
    if (ms < MIN) return '1분 이내';
    const m = Math.round(ms / MIN);
    if (m < 60) return m + '분';
    const h = Math.round(ms / HOUR);
    if (h < 24) return h + '시간';
    const d = Math.round(ms / DAY);
    if (d < 30) return d + '일';
    const mo = Math.round(ms / (30 * DAY));
    if (mo < 12) return mo + '개월';
    return Math.round(ms / (365 * DAY)) + '년';
  }

  function fmtUntil(t, now) {
    return t <= now ? '지금' : fmtDuration(t - now) + ' 후';
  }

  const Core = {
    MIN, HOUR, DAY, LEVELS,
    newSrs, review, mastery, isDue, dueWords, upcomingWords, nextDue,
    wordPattern, findWord, checkTyped, norm, meaningText, posOf, shuffle,
    buildQuestion, hintFor,
    inWindow, alignToWindow, nextPopupTime, pickPopupWord,
    fmtDuration, fmtUntil,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  else root.Core = Core;
})(typeof self !== 'undefined' ? self : this);

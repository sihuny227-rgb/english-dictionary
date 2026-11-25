/* 나만의 영어 사전 — 화면 동작 (찾기 · 단어장 · 퀴즈 · 단어 알림 · 설정) */
(function () {
  'use strict';
  const Core = window.Core, Dict = window.Dict;
  const KEY = 'my-english-dictionary-v1';
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const now = () => Date.now();
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- 저장 ---------- */

  const DEFAULTS = {
    source: 'free', aiKey: '', aiModel: 'claude-opus-5-5',
    rate: 0.9, voice: '', autoSpeak: true,
    quizSize: 10, quizType: 'mixed',
    notify: { on: false, every: 60, from: 9, to: 22, weak: true },
  };

  function normalizeSettings(s) {
    s = s || {};
    const out = Object.assign({}, DEFAULTS, s);
    out.notify = Object.assign({}, DEFAULTS.notify, s.notify || {});
    return out;
  }

  function normalizeWord(w) {
    if (!w || !w.word || !String(w.word).trim()) return null;
    const added = Number(w.addedAt) || now();
    return {
      id: String(w.id || uid()),
      word: String(w.word).trim(),
      phonetic: String(w.phonetic || ''),
      audio: String(w.audio || ''),
      meanings: (Array.isArray(w.meanings) ? w.meanings : []).filter(m => m && m.ko).map(m => ({ pos: String(m.pos || ''), ko: String(m.ko) })),
      defs: (Array.isArray(w.defs) ? w.defs : []).filter(d => d && d.en).map(d => ({ pos: String(d.pos || ''), en: String(d.en) })),
      examples: (Array.isArray(w.examples) ? w.examples : []).filter(x => x && x.en).map(x => ({ en: String(x.en), ko: String(x.ko || '') })),
      source: w.source || 'manual',
      credit: w.credit && w.credit.name ? { name: String(w.credit.name), url: /^https:\/\//.test(w.credit.url || '') ? String(w.credit.url) : '' } : null,
      addedAt: added,
      srs: Object.assign(Core.newSrs(added), w.srs || {}),
    };
  }

  function load() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { d = null; }
    d = d || {};
    return {
      version: 1,
      words: (Array.isArray(d.words) ? d.words : []).map(normalizeWord).filter(Boolean),
      settings: normalizeSettings(d.settings),
      meta: Object.assign({ nextPopupAt: 0, recent: [], pending: null }, d.meta || {}),
    };
  }

  let db = load();
  let askedPersist = false;
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); }
    catch (e) { toast('저장 공간이 부족해서 저장하지 못했어요.'); }
    if (!askedPersist && navigator.storage && navigator.storage.persist) {
      askedPersist = true;
      navigator.storage.persist().catch(() => {});
    }
  }

  const byId = id => db.words.find(w => w.id === id);
  const findSaved = word => db.words.find(w => Core.norm(w.word) === Core.norm(word));

  function addWord(entry) {
    const t = now();
    const w = normalizeWord(Object.assign({}, entry, { id: uid(), addedAt: t, srs: Core.newSrs(t) }));
    db.words.unshift(w);
    save();
    return w;
  }

  let lastRemoved = null;
  function removeWord(id) {
    const i = db.words.findIndex(w => w.id === id);
    if (i < 0) return;
    lastRemoved = { word: db.words[i], index: i };
    db.words.splice(i, 1);
    save();
  }
  function undoRemove() {
    if (!lastRemoved) return;
    db.words.splice(Math.min(lastRemoved.index, db.words.length), 0, lastRemoved.word);
    lastRemoved = null;
    save();
    refreshAll();
  }

  const state = { tab: 'dict', sort: 'recent', filter: '', quiz: null, resultId: null };

  /* ---------- 작은 도구 ---------- */

  let toastTimer = null;
  function toast(msg, action) {
    const el = $('#toast');
    el.innerHTML = '<span>' + esc(msg) + '</span>' + (action ? '<button type="button">' + esc(action.label) + '</button>' : '');
    if (action) el.querySelector('button').onclick = () => { el.classList.remove('show'); action.run(); };
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), action ? 6000 : 2600);
  }

  const ICON_SPEAK = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 9.5v5h3.6L12 18.5v-13L7.6 9.5H4z" fill="currentColor"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>';
  const sayBtn = (text, label, cls) => '<button type="button" class="say ' + (cls || '') + '" data-say="' + esc(text) + '" aria-label="' + esc(label) + '">' + ICON_SPEAK + '</button>';

  function hourLabel(h) {
    if (h === 0) return '자정 (0시)';
    if (h === 24) return '자정 (24시)';
    if (h < 12) return '오전 ' + h + '시';
    if (h === 12) return '낮 12시';
    return '오후 ' + (h - 12) + '시';
  }

  function fmtClock(t) {
    const d = new Date(t);
    const sameDay = d.toDateString() === new Date().toDateString();
    const opt = sameDay ? { hour: 'numeric', minute: '2-digit' } : { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' };
    return d.toLocaleString('ko-KR', opt);
  }

  /* ---------- 발음 (휴대폰에 들어 있는 음성 읽기 기능) ---------- */

  const Speech = {
    voices: [],
    ok: 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window,
    init() {
      if (!this.ok) return;
      const loadVoices = () => {
        this.voices = speechSynthesis.getVoices().filter(v => /^en([-_]|$)/i.test(v.lang));
        renderVoiceOptions();
      };
      loadVoices();
      speechSynthesis.onvoiceschanged = loadVoices;
    },
    pick() {
      const vs = this.voices;
      return vs.find(v => v.voiceURI === db.settings.voice) ||
        vs.find(v => /en[-_]US/i.test(v.lang) && /Samantha|Google US|Aria|Jenny|Ava|Allison|Zira/i.test(v.name)) ||
        vs.find(v => /en[-_]US/i.test(v.lang)) || vs[0] || null;
    },
    say(text, btn) {
      if (!this.ok) { toast('이 브라우저는 소리 내어 읽기를 지원하지 않아요.'); return; }
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = this.pick();
      if (v) u.voice = v;
      u.lang = v ? v.lang : 'en-US';
      u.rate = Number(db.settings.rate) || 0.9;
      $$('.say.playing').forEach(b => b.classList.remove('playing'));
      if (btn) {
        btn.classList.add('playing');
        u.onend = u.onerror = () => btn.classList.remove('playing');
      }
      speechSynthesis.speak(u);
    },
  };

  /* ---------- 단어 카드 ---------- */

  function highlight(word, sentence) {
    const hit = Core.findWord(word, sentence);
    if (!hit) return esc(sentence);
    return esc(sentence.slice(0, hit.index)) + '<mark>' + esc(hit.text) + '</mark>' + esc(sentence.slice(hit.index + hit.length));
  }

  function wordCard(w, opts) {
    opts = opts || {};
    const credit = w.credit && w.meanings.length
      ? '<div class="credit">뜻 출처: ' + (w.credit.url ? '<a href="' + esc(w.credit.url) + '" target="_blank" rel="noopener">' + esc(w.credit.name) + '</a>' : esc(w.credit.name)) + '</div>'
      : '';
    const means = w.meanings.length
      ? '<ul class="means">' + w.meanings.map(m => '<li>' + (m.pos ? '<span class="pos">' + esc(m.pos) + '</span>' : '') + esc(m.ko) + '</li>').join('') + '</ul>' + credit
      : '<p class="muted" style="margin:10px 0 0">한국어 뜻이 아직 없어요. ‘수정’에서 넣을 수 있어요.</p>';
    const exs = w.examples.length
      ? '<div class="sec">예문</div><ol class="ex">' + w.examples.map((x, i) =>
        '<li><span class="n">' + (i + 1) + '</span><div class="body"><div class="en" lang="en">' + highlight(w.word, x.en) + '</div>' +
        (x.ko ? '<div class="ko">' + esc(x.ko) + '</div>' : '') + '</div>' + sayBtn(x.en, (i + 1) + '번 예문 듣기') + '</li>').join('') + '</ol>'
      : '';
    const defs = opts.defs !== false && w.defs.length
      ? '<details><summary>영영 풀이 ' + w.defs.length + '개</summary><ul class="defs">' + w.defs.map(d =>
        '<li>' + (d.pos ? '<span class="pos">' + esc(d.pos) + '</span>' : '') + '<span lang="en">' + esc(d.en) + '</span></li>').join('') + '</ul></details>'
      : '';
    return '<div class="wc-head"><div><div class="hw" lang="en">' + esc(w.word) + '</div>' +
      (w.phonetic ? '<div class="ph" lang="en">' + esc(w.phonetic) + '</div>' : '') + '</div>' +
      sayBtn(w.word, '단어 발음 듣기', 'lg') + '</div>' + means + exs + defs;
  }

  function statsLine(w) {
    const m = Core.mastery(w.srs);
    return '<div class="stats"><span class="lv lv' + m.level + '">' + m.label + '</span>' +
      '<span>맞힘 <b>' + w.srs.right + '</b></span><span>틀림 <b>' + w.srs.wrong + '</b></span>' +
      '<span>다음 퀴즈 <b>' + Core.fmtUntil(w.srs.due, now()) + '</b></span></div>';
  }

  const wordActions = (w, where) =>
    '<div class="btns">' +
    '<button class="btn ghost sm" data-act="edit" data-id="' + esc(w.id) + '" data-where="' + where + '">수정</button>' +
    '<button class="btn ghost sm" data-act="relookup" data-id="' + esc(w.id) + '" data-where="' + where + '">뜻 다시 찾기</button>' +
    '<button class="btn ghost sm" data-act="delete" data-id="' + esc(w.id) + '" data-where="' + where + '">삭제</button></div>';

  function listItem(w, extra) {
    const m = Core.mastery(w.srs);
    return '<li data-open="' + esc(w.id) + '"><div class="body"><span class="w" lang="en">' + esc(w.word) + '</span>' +
      '<span class="lv lv' + m.level + '">' + m.label + '</span><div class="sub">' + esc(Core.meaningText(w, 3) || '뜻 없음') + '</div></div>' +
      (extra || '') + sayBtn(w.word, w.word + ' 발음 듣기') + '</li>';
  }

  /* ---------- 사전: 찾기 ---------- */

  function cleanInput(s) {
    return String(s || '').replace(/[’‘]/g, "'").replace(/[^\p{L}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
  }

  function showSaved(w, notes) {
    state.resultId = w.id;
    $('#result').innerHTML = (notes || []).filter(Boolean).map(n => '<p class="notice">' + esc(n) + '</p>').join('') +
      '<div class="card">' + wordCard(w) + statsLine(w) + wordActions(w, 'result') + '</div>';
  }

  function showManual(q, msg) {
    state.resultId = null;
    $('#result').innerHTML = '<p class="notice warn">' + esc(msg) + '</p>' + editorHTML(null, q);
  }

  let searchSeq = 0;
  async function doSearch(raw) {
    const q = cleanInput(raw);
    if (!q) { toast('찾을 단어를 입력하세요.'); return; }
    const saved = findSaved(q);
    if (saved) { showSaved(saved, ['이미 단어장에 있는 단어예요.']); return; }
    if (navigator.onLine === false) { showManual(q, '인터넷에 연결되어 있지 않아요. 직접 입력해서 저장할 수 있어요.'); return; }

    const seq = ++searchSeq;
    state.resultId = null;
    $('#result').innerHTML = '<div class="card"><div class="loading"><span class="spin"></span><span>‘' + esc(q) + '’의 뜻과 예문을 찾는 중… 몇 초 걸려요.</span></div></div>';
    try {
      const r = await Dict.lookup(q, db.settings);
      if (seq !== searchSeq) return;
      const dup = findSaved(r.entry.word);
      if (dup) { showSaved(dup, [r.note, '이미 단어장에 있는 단어예요.']); return; }
      const w = addWord(r.entry);
      showSaved(w, [r.note, r.warning]);
      refreshAll();
      toast('‘' + w.word + '’ 단어장에 저장했어요', { label: '되돌리기', run: () => { removeWord(w.id); lastRemoved = null; $('#result').innerHTML = ''; refreshAll(); } });
    } catch (e) {
      if (seq !== searchSeq) return;
      if (e.code === 'notfound') showManual(q, '‘' + q + '’의 뜻을 찾지 못했어요. 철자를 확인하거나, 아래에 직접 입력해서 저장하세요.');
      else showManual(q, '뜻을 불러오지 못했어요 (' + (e.message || '연결 오류') + '). 잠시 뒤 다시 찾거나, 아래에 직접 입력해서 저장하세요.');
    }
  }

  async function relookup(id, where) {
    const w = byId(id);
    if (!w) return;
    if (!confirm('‘' + w.word + '’의 뜻과 예문을 새로 찾아서 바꿀까요? 퀴즈 기록은 그대로 남아요.')) return;
    toast('새로 찾는 중…');
    try {
      const r = await Dict.lookup(w.word, db.settings);
      const e = r.entry;
      w.phonetic = e.phonetic || w.phonetic;
      w.audio = e.audio || w.audio;
      if (e.meanings.length) w.meanings = e.meanings;
      if (e.defs.length) w.defs = e.defs;
      if (e.examples.length) w.examples = e.examples;
      if (e.meanings.length) w.credit = e.credit || null;
      w.source = e.source;
      save();
      refreshAll();
      if (where === 'sheet') openDetail(id); else showSaved(w, [r.warning]);
      toast('새로 찾았어요');
    } catch (err) {
      toast('찾지 못했어요: ' + (err.message || '연결 오류'));
    }
  }

  /* ---------- 직접 입력 · 수정 ---------- */

  const meaningsToText = ms => ms.map(m => (m.pos ? m.pos + ': ' : '') + m.ko).join('\n');
  function parseMeanings(text) {
    return String(text || '').split(/\n+/).map(l => l.trim()).filter(Boolean).map(l => {
      const m = /^([^:：]{1,8}?)\s*[:：]\s*(.+)$/.exec(l);
      return m ? { pos: m[1].trim(), ko: m[2].trim() } : { pos: '', ko: l };
    });
  }

  const exRow = x => '<div class="exrow"><input name="en" lang="en" placeholder="영어 예문" value="' + esc(x ? x.en : '') + '">' +
    '<input name="ko" placeholder="한국어 해석 (없어도 돼요)" value="' + esc(x ? x.ko : '') + '">' +
    '<button type="button" class="x" data-act="del-ex" aria-label="이 예문 지우기">×</button></div>';

  function editorHTML(w, prefill) {
    const ex = w ? w.examples.slice() : [];
    while (ex.length < 3) ex.push(null);
    const id = w ? esc(w.id) : '';
    return '<form class="card editor" data-id="' + id + '" autocomplete="off">' +
      '<h2>' + (w ? '단어 고치기' : '직접 입력해서 저장') + '</h2>' +
      '<label class="lbl" for="edWord">영어 단어</label><input id="edWord" name="word" lang="en" autocapitalize="off" spellcheck="false" required value="' + esc(w ? w.word : prefill || '') + '">' +
      '<label class="lbl" for="edPh">발음 기호 (없어도 돼요)</label><input id="edPh" name="phonetic" lang="en" value="' + esc(w ? w.phonetic : '') + '">' +
      '<label class="lbl" for="edMean">뜻 — 한 줄에 하나씩 (예: 형용사: 꺼리는, 마지못해 하는)</label><textarea id="edMean" name="meanings" rows="3">' + esc(w ? meaningsToText(w.meanings) : '') + '</textarea>' +
      '<span class="lbl">예문</span><div class="exrows">' + ex.map(exRow).join('') + '</div>' +
      '<button type="button" class="btn ghost sm" data-act="add-ex">예문 칸 추가</button>' +
      '<div class="btns"><button class="btn">저장</button><button type="button" class="btn ghost" data-act="cancel-edit" data-id="' + id + '">취소</button></div></form>';
  }

  function saveEditor(f) {
    const word = String(f.elements.word.value || '').replace(/\s+/g, ' ').trim();
    if (!word) { toast('영어 단어를 입력하세요.'); return; }
    const data = {
      word,
      phonetic: f.elements.phonetic.value.trim(),
      meanings: parseMeanings(f.elements.meanings.value),
      examples: $$('.exrow', f).map(r => ({ en: $('[name=en]', r).value.trim(), ko: $('[name=ko]', r).value.trim() })).filter(x => x.en),
    };
    const inSheet = !!f.closest('dialog');
    const id = f.dataset.id;
    if (id) {
      const w = byId(id);
      if (!w) return;
      const dup = findSaved(word);
      if (dup && dup.id !== id) { toast('‘' + word + '’은(는) 이미 단어장에 있어요.'); return; }
      // 뜻을 직접 고쳤으면 출처를 '직접 입력'으로 바꿔요 (한꺼번에 다시 찾기에서도 건드리지 않아요)
      if (JSON.stringify(data.meanings) !== JSON.stringify(w.meanings)) w.credit = { name: '직접 입력', url: '' };
      Object.assign(w, data);
      save();
      refreshAll();
      if (inSheet) openDetail(id); else showSaved(w);
      toast('고쳤어요');
    } else {
      const dup = findSaved(word);
      if (dup) { showSaved(dup, ['이미 단어장에 있는 단어예요.']); return; }
      const w = addWord(Object.assign(data, { defs: [], source: 'manual' }));
      refreshAll();
      showSaved(w);
      toast('‘' + w.word + '’ 단어장에 저장했어요');
    }
  }

  /* ---------- 사전 탭 · 단어장 탭 ---------- */

  function renderDict() {
    const recent = db.words.slice().sort((a, b) => b.addedAt - a.addedAt).slice(0, 5);
    const card = $('#recentCard');
    if (!recent.length) {
      card.innerHTML = '<h2>이렇게 써요</h2><p class="empty" style="padding:0">영어 단어를 찾으면 뜻과 예문 3개를 찾아서 <b>단어장에 자동으로 저장</b>해요. 스피커 버튼을 누르면 단어와 문장을 읽어 줘요. 한글로 찾아도 돼요 (예: 사과 → apple).</p>';
      return;
    }
    card.innerHTML = '<h2>최근에 저장한 단어</h2><ul class="wl">' + recent.map(w => listItem(w)).join('') + '</ul>' +
      (db.words.length > 5 ? '<div class="btns"><button class="btn ghost sm" data-act="goto" data-tab="list">단어장 전체 보기 (' + db.words.length + '개)</button></div>' : '');
  }

  function renderList() {
    const raw = state.filter.trim();
    const f = Core.norm(raw);
    let ws = db.words.slice();
    if (f) ws = ws.filter(w => Core.norm(w.word).includes(f) || w.meanings.some(m => m.ko.includes(raw)));
    const t = now();
    const sorts = {
      recent: (a, b) => b.addedAt - a.addedAt,
      abc: (a, b) => a.word.localeCompare(b.word, 'en', { sensitivity: 'base' }),
      due: (a, b) => a.srs.due - b.srs.due,
      weak: (a, b) => (Core.mastery(a.srs).level - Core.mastery(b.srs).level) || (a.srs.ease - b.srs.ease) || (b.srs.wrong - a.srs.wrong),
    };
    ws.sort(sorts[state.sort] || sorts.recent);
    $$('#sortChips .chip').forEach(c => c.classList.toggle('on', c.dataset.sort === state.sort));
    $('#listCount').textContent = f ? ws.length + '개 찾음 · 전체 ' + db.words.length + '개' : '전체 ' + db.words.length + '개';
    $('#wordList').innerHTML = ws.length
      ? ws.map(w => listItem(w, state.sort === 'due' ? '<span class="muted" style="white-space:nowrap">' + Core.fmtUntil(w.srs.due, t) + '</span>' : '')).join('')
      : '<li class="empty" style="cursor:default">' + (db.words.length ? '찾는 단어가 없어요.' : '아직 저장한 단어가 없어요. 사전 탭에서 단어를 찾아 보세요.') + '</li>';
  }

  /* ---------- 아래에서 올라오는 창 ---------- */

  function openSheet(html) {
    const d = $('#sheet');
    $('#sheetBody').innerHTML = html;
    if (!d.open) {
      if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    }
    $('#sheetBody').scrollTop = 0;
  }
  function closeSheet() {
    const d = $('#sheet');
    if (d.open) { if (typeof d.close === 'function') d.close(); else d.removeAttribute('open'); }
  }

  function openDetail(id) {
    const w = byId(id);
    if (!w) { toast('단어장에 없는 단어예요.'); return; }
    openSheet('<div class="sheet-head"><span class="muted">단어장</span><button class="x" data-act="close" aria-label="닫기">×</button></div>' +
      wordCard(w) + statsLine(w) + wordActions(w, 'sheet'));
  }

  /* ---------- 퀴즈 ---------- */

  const QTYPES = [['mixed', '섞어서'], ['en2ko', '영어 → 뜻'], ['ko2en', '한글 → 영어'], ['cloze', '빈칸 채우기']];

  function quizHome() {
    const total = db.words.length;
    if (!total) {
      return '<div class="card"><h2>복습 퀴즈</h2><p class="empty">단어를 저장하면 퀴즈를 풀 수 있어요.</p>' +
        '<div class="btns"><button class="btn" data-act="goto" data-tab="dict">단어 찾으러 가기</button></div></div>';
    }
    const t = now();
    const due = Core.dueWords(db.words, t).length;
    const nd = Core.nextDue(db.words, t);
    const counts = [0, 0, 0, 0, 0];
    db.words.forEach(w => counts[Core.mastery(w.srs).level]++);
    const bar = counts.map((c, i) => c ? '<i class="b' + i + '" style="width:' + (c / total * 100) + '%"></i>' : '').join('');
    const legend = Core.LEVELS.map((l, i) => '<span class="k' + i + '">' + l.label + ' ' + counts[i] + '</span>').join('');
    const size = Math.min(due, db.settings.quizSize);
    return '<div class="card"><h2>복습 퀴즈</h2>' +
      '<div class="bignum">' + due + '<small>개 복습할 차례</small></div>' +
      '<p class="muted" style="margin:6px 0 0">' + (due ? '이번에 ' + size + '문제를 풀어요.' : nd ? '다음 복습은 ' + Core.fmtUntil(nd, t) + '예요. 미리 연습해도 돼요.' : '') + '</p>' +
      '<div class="mbar" role="img" aria-label="외운 정도: ' + Core.LEVELS.map((l, i) => l.label + ' ' + counts[i] + '개').join(', ') + '">' + bar + '</div>' +
      '<div class="legend">' + legend + '</div>' +
      '<span class="lbl">문제 유형</span><div class="chips">' +
      QTYPES.map(([k, l]) => '<button class="chip' + (db.settings.quizType === k ? ' on' : '') + '" data-act="qtype" data-type="' + k + '">' + l + '</button>').join('') + '</div>' +
      '<div class="btns">' + (due
        ? '<button class="btn" data-act="quiz-start">복습 시작</button>'
        : '<button class="btn" data-act="quiz-practice">미리 연습하기</button>') + '</div></div>' +
      '<div class="card"><h2>퀴즈 간격은 이렇게 바뀌어요</h2>' +
      '<p style="margin:0 0 8px">맞히면 그 단어의 다음 퀴즈까지 간격이 늘어나요: <b>4시간 → 1일 → 3일 → 1주 → 3주 → 2개월…</b></p>' +
      '<p style="margin:0 0 8px">틀리면 <b>10분 뒤</b>에 다시 나오고, 자주 틀린 단어일수록 간격이 천천히 늘어나서 더 자주 나와요.</p>' +
      '<p class="muted" style="margin:0">힌트를 보고 맞히면 조금만 늘어나요. 복습할 때가 되기 전에 미리 연습해서 맞힌 건 지난 복습 뒤로 지난 시간만큼만 인정해요.</p></div>';
  }

  function startQuiz(practice) {
    const t = now();
    const size = db.settings.quizSize;
    const pool = practice ? Core.upcomingWords(db.words, t) : Core.dueWords(db.words, t);
    const words = Core.shuffle(pool.slice(0, size), Math.random);
    if (!words.length) { toast(practice ? '연습할 단어가 없어요.' : '지금 복습할 단어가 없어요.'); state.quiz = null; renderQuiz(); return; }
    state.quiz = {
      practice, i: 0, results: [], q: null, answered: false, correct: false, hint: 0, chosen: -1, typed: '', done: false,
      queue: words.map(w => ({ wordId: w.id, type: db.settings.quizType, retry: false })),
    };
    showTab('quiz');
  }

  function clozeHint(w) {
    const o = w.examples.map(x => ({ x, hit: Core.findWord(w.word, x.en) })).find(o => o.hit);
    return o ? { before: o.x.en.slice(0, o.hit.index), after: o.x.en.slice(o.hit.index + o.hit.length), ko: o.x.ko } : null;
  }

  function choicesHTML(q, s) {
    return '<div class="choices">' + q.choices.map((c, i) => {
      let cls = 'choice';
      if (s.answered) { if (c === q.answer) cls += ' right'; else if (i === s.chosen) cls += ' wrong'; }
      return '<button class="' + cls + '" data-act="choose" data-i="' + i + '"' + (q.type === 'cloze' ? ' lang="en"' : '') + (s.answered ? ' disabled' : '') + '>' + esc(c) + '</button>';
    }).join('') + '</div>';
  }

  function feedbackHTML(s, w) {
    const q = s.q;
    const item = s.queue[s.i];
    const title = s.correct ? (s.hint ? '맞았어요! (힌트 사용)' : '정답이에요!') : '아쉬워요. 정답은 ‘' + w.word + '’';
    const mine = q.type === 'ko2en' && !s.correct && s.typed ? '<div class="muted">내 답: <span lang="en">' + esc(s.typed) + '</span></div>' : '';
    const sentence = q.type === 'cloze'
      ? '<div class="line"><div class="body"><div class="en" lang="en">' + highlight(w.word, q.sentence) + '</div>' + (q.ko ? '<div class="ko">' + esc(q.ko) + '</div>' : '') + '</div>' + sayBtn(q.sentence, '문장 듣기') + '</div>'
      : '';
    const next = item.retry ? '다시 풀어 보는 문제라 퀴즈 기록에는 넣지 않아요.'
      : '이 단어의 다음 퀴즈: ' + Core.fmtUntil(w.srs.due, now()) + (s.correct ? '' : ' · 이번 퀴즈 끝에 한 번 더 나와요');
    return '<div class="fb ' + (s.correct ? 'ok' : 'bad') + '"><div class="t">' + esc(title) + '</div>' + mine +
      '<div class="line"><div class="body"><b lang="en" style="font-size:18px">' + esc(w.word) + '</b> ' +
      (w.phonetic ? '<span class="muted" lang="en">' + esc(w.phonetic) + '</span>' : '') +
      '<div>' + esc(Core.meaningText(w, 3)) + '</div></div>' + sayBtn(w.word, '단어 듣기') + '</div>' + sentence +
      '<div class="muted" style="margin-top:8px">' + next + '</div></div>' +
      '<div class="btns"><button class="btn" data-act="quiz-next" id="nextBtn">' + (s.i + 1 >= s.queue.length ? '결과 보기' : '다음') + '</button></div>';
  }

  function quizQuestion() {
    const s = state.quiz;
    // 지운 단어나 문제를 못 만드는 단어는 건너뛰어요
    while (s.i < s.queue.length) {
      const w = byId(s.queue[s.i].wordId);
      if (w && (s.q || (s.q = Core.buildQuestion(w, db.words, s.queue[s.i].type, Math.random)))) break;
      s.i++; s.q = null;
    }
    if (s.i >= s.queue.length) { s.done = true; return quizSummary(); }
    const item = s.queue[s.i];
    const w = byId(item.wordId);
    const q = s.q;
    let body = '';
    if (q.type === 'en2ko') {
      body = '<div class="qlabel">이 단어의 뜻은?</div><div class="qword"><span lang="en">' + esc(q.prompt) + '</span>' + sayBtn(q.prompt, '발음 듣기') + '</div>' + choicesHTML(q, s);
    } else if (q.type === 'cloze') {
      body = '<div class="qlabel">빈칸에 알맞은 단어는? <span class="muted">(모양이 바뀌어 들어갈 수도 있어요)</span></div>' +
        '<div class="qsent" lang="en">' + esc(q.before) + '<span class="blank">' + (s.answered ? esc(q.blank) : '&nbsp;') + '</span>' + esc(q.after) + '</div>' +
        (q.ko ? '<div class="qsent-ko">' + esc(q.ko) + '</div>' : '<div class="qsent-ko"></div>') + choicesHTML(q, s);
    } else {
      const ch = clozeHint(w);
      const canMore = s.hint === 1 && ch;
      body = '<div class="qlabel">뜻에 맞는 영어 단어를 쓰세요</div><div class="qko">' + (q.pos ? '<span class="pos">' + esc(q.pos) + '</span>' : '') + esc(q.prompt) + '</div>' +
        '<form class="typed" id="typedForm" autocomplete="off"><input id="typed" lang="en" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done" aria-label="영어 단어" value="' + esc(s.typed) + '"' + (s.answered ? ' disabled' : '') + '>' +
        '<button class="btn"' + (s.answered ? ' disabled' : '') + '>확인</button></form>' +
        (s.answered ? '' : '<div class="btns">' + (s.hint === 0 || canMore ? '<button class="btn ghost sm" data-act="hint">' + (s.hint ? '힌트 더 보기' : '힌트 보기') + '</button>' : '') +
          '<button class="btn ghost sm" data-act="giveup">모르겠어요</button></div>') +
        (s.hint >= 1 ? '<div class="hint" lang="en">' + esc(Core.hintFor(q.answer, 1)) + '</div>' : '') +
        (s.hint >= 2 && ch ? '<div class="fb" style="background:var(--accent-soft)"><div class="en" lang="en">' + esc(ch.before) + '<span class="blank">&nbsp;</span>' + esc(ch.after) + '</div>' + (ch.ko ? '<div class="ko">' + esc(ch.ko) + '</div>' : '') + '</div>' : '');
    }
    return '<div class="card"><div class="qtop"><span>' + (s.practice ? '미리 연습' : '복습') + ' ' + (s.i + 1) + ' / ' + s.queue.length +
      (item.retry ? ' · 한 번 더' : '') + '</span><button class="btn ghost sm" data-act="quiz-stop">그만하기</button></div>' +
      '<div class="prog"><i style="width:' + (s.i / s.queue.length * 100) + '%"></i></div>' + body +
      (s.answered ? feedbackHTML(s, w) : '') + '</div>';
  }

  function quizSummary() {
    const s = state.quiz;
    const t = now();
    const n = s.results.length;
    const ok = s.results.filter(r => r.correct).length;
    const rows = s.results.map(r => {
      const w = byId(r.wordId);
      if (!w) return '';
      return '<li data-open="' + esc(w.id) + '"><span class="mark ' + (r.correct ? 'o' : 'x') + '">' + (r.correct ? 'O' : 'X') + '</span>' +
        '<div class="body"><span class="w" lang="en">' + esc(w.word) + '</span><div class="sub">' + esc(Core.meaningText(w)) + '</div></div>' +
        '<span class="muted" style="white-space:nowrap">' + Core.fmtUntil(w.srs.due, t) + '</span></li>';
    }).join('');
    const due = Core.dueWords(db.words, t).length;
    return '<div class="card"><h2>' + (n ? n + '문제 중 ' + ok + '개 맞았어요' : '퀴즈를 마쳤어요') + '</h2>' +
      (n ? '<p class="muted" style="margin-top:0">오른쪽은 단어마다 다음 퀴즈까지 남은 시간이에요. 틀린 단어는 금방 다시 나와요.</p><ul class="wl res">' + rows + '</ul>' : '') +
      '<div class="btns">' + (due ? '<button class="btn" data-act="quiz-start">남은 복습 ' + due + '개 이어서 풀기</button>' : '') +
      '<button class="btn ghost" data-act="quiz-home">퀴즈 처음 화면</button></div></div>';
  }

  function renderQuiz() {
    const s = state.quiz;
    $('#quiz').innerHTML = !s ? quizHome() : s.done ? quizSummary() : quizQuestion();
  }

  function answerQuiz(correct) {
    const s = state.quiz;
    if (!s || s.answered || !s.q) return;
    const item = s.queue[s.i];
    const w = byId(item.wordId);
    if (!w) return;
    s.answered = true;
    s.correct = correct;
    if (!item.retry) {
      w.srs = Core.review(w.srs, correct ? (s.hint ? 1 : 2) : 0, now());
      save();
      s.results.push({ wordId: w.id, correct });
      if (!correct) s.queue.push({ wordId: w.id, type: item.type, retry: true });
    }
    if (db.settings.autoSpeak) Speech.say(s.q.type === 'cloze' ? s.q.sentence : w.word);
    renderQuiz();
    updateBadges();
    const nb = $('#nextBtn');
    if (nb) { nb.focus({ preventScroll: true }); nb.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  }

  function nextQuiz() {
    const s = state.quiz;
    if (!s) return;
    Object.assign(s, { i: s.i + 1, q: null, answered: false, correct: false, hint: 0, chosen: -1, typed: '' });
    if (s.i >= s.queue.length) s.done = true;
    renderQuiz();
    $('#quiz').scrollIntoView({ block: 'start' });
    const inp = $('#typed');
    if (inp && !inp.disabled) inp.focus();
  }

  function submitTyped() {
    const s = state.quiz;
    const inp = $('#typed');
    if (!s || s.answered || !inp) return;
    const v = inp.value.trim();
    if (!v) { inp.focus(); return; }
    s.typed = v;
    answerQuiz(Core.checkTyped(v, s.q.answer));
  }

  /* ---------- 단어 알림 ---------- */

  async function notifySystem(w) {
    try {
      if (!('Notification' in window) || Notification.permission !== 'granted') return false;
      const mean = Core.meaningText(w, 2);
      const title = mean ? w.word + ' — ' + mean : w.word;
      const body = w.examples.slice(0, 3).map((x, i) => (i + 1) + '. ' + x.en + (x.ko ? '\n    ' + x.ko : '')).join('\n') || '눌러서 단어를 보세요.';
      const opts = { body, tag: 'word-popup', renotify: true, icon: 'icons/icon-192.png', data: { id: w.id } };
      const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
      if (reg) await reg.showNotification(title, opts); else new Notification(title, opts);
      return true;
    } catch (e) {
      return false;
    }
  }

  function popupCard(w) {
    const due = Core.dueWords(db.words, now()).length;
    openSheet('<div class="sheet-head"><span class="muted">단어 알림 · ' + esc(fmtClock(now())) + '</span><button class="x" data-act="close" aria-label="닫기">×</button></div>' +
      wordCard(w, { defs: false }) +
      '<div class="btns"><button class="btn ghost" data-act="popup-next">다른 단어</button>' +
      (due ? '<button class="btn" data-act="quiz-from-popup">복습 퀴즈 ' + due + '개 풀기</button>' : '<button class="btn ghost" data-act="close">닫기</button>') + '</div>');
  }

  const Popup = {
    pick() {
      const w = Core.pickPopupWord(db.words, { recent: db.meta.recent, weak: db.settings.notify.weak });
      if (w) {
        const keep = Math.min(5, Math.max(0, db.words.length - 1));
        db.meta.recent = [w.id].concat(db.meta.recent.filter(id => id !== w.id)).slice(0, keep);
        save();
      }
      return w;
    },
    showInApp(w) {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement && document.activeElement.tagName) || '');
      const busy = $('#sheet').open || typing || (state.quiz && !state.quiz.done && state.tab === 'quiz');
      if (busy) toast('단어 알림: ' + w.word, { label: '보기', run: () => popupCard(w) });
      else popupCard(w);
    },
    async fire() {
      const w = this.pick();
      if (!w) return;
      if (document.visibilityState === 'visible') { this.showInApp(w); return; }
      const ok = await notifySystem(w);
      if (!ok) { db.meta.pending = w.id; save(); }
    },
    schedule() {
      const n = db.settings.notify;
      db.meta.nextPopupAt = n.on ? Core.nextPopupTime(now(), n.every, n.from, n.to) : 0;
      save();
      renderNotifyStatus();
    },
    tick() {
      const n = db.settings.notify;
      if (!n.on) return;
      const t = now();
      if (!db.meta.nextPopupAt) { this.schedule(); return; }
      if (t < db.meta.nextPopupAt) return;
      const fire = db.words.length > 0 && Core.inWindow(t, n.from, n.to);
      this.schedule();
      if (fire) this.fire();
    },
  };

  function onVisible() {
    if (document.visibilityState !== 'visible') return;
    if (db.meta.pending) {
      const w = byId(db.meta.pending);
      db.meta.pending = null;
      save();
      if (w) popupCard(w);
    }
    Popup.tick();
    updateBadges();
  }

  /* ---------- 설정 ---------- */

  function renderVoiceOptions() {
    const sel = $('#voice');
    if (!sel) return;
    const cur = db.settings.voice;
    sel.innerHTML = '<option value="">자동 (미국 영어)</option>' + Speech.voices.map(v =>
      '<option value="' + esc(v.voiceURI) + '"' + (v.voiceURI === cur ? ' selected' : '') + '>' + esc(v.name + ' (' + v.lang + ')') + '</option>').join('');
  }

  function renderNotifyStatus() {
    const n = db.settings.notify;
    const el = $('#nNext');
    if (!el) return;
    const support = 'Notification' in window;
    const perm = support ? Notification.permission : 'unsupported';
    let txt = '';
    if (n.on && db.meta.nextPopupAt) txt += '다음 알림: ' + fmtClock(db.meta.nextPopupAt) + ' (' + Core.fmtUntil(db.meta.nextPopupAt, now()) + '). ';
    if (!n.on) txt += '알림이 꺼져 있어요. ';
    if (perm === 'granted') txt += '앱을 잠깐 다른 화면으로 내려 두면 휴대폰 알림으로, 앱을 보고 있으면 단어 카드로 보여 줘요.';
    else if (perm === 'denied') txt += '휴대폰 알림이 막혀 있어서 앱 화면에서 단어 카드로만 보여 줘요. (휴대폰 설정 → 알림에서 허용할 수 있어요)';
    else if (perm === 'default') txt += '휴대폰 알림을 허용하면 앱을 잠깐 내려 둔 동안에도 알림이 떠요.';
    else txt += '이 브라우저에서는 휴대폰 알림을 쓸 수 없어서 단어 카드로만 보여 줘요. 아이폰은 홈 화면에 추가한 앱(iOS 16.4 이상)에서 알림이 돼요.';
    el.textContent = txt;
  }

  function renderSettings() {
    const s = db.settings;
    const n = s.notify;
    $('#nOn').checked = n.on;
    $('#nEvery').value = String(n.every);
    $('#nFrom').innerHTML = Array.from({ length: 24 }, (_, h) => '<option value="' + h + '">' + hourLabel(h) + '</option>').join('');
    $('#nTo').innerHTML = Array.from({ length: 24 }, (_, i) => i + 1).map(h => '<option value="' + h + '">' + hourLabel(h) + '</option>').join('');
    $('#nFrom').value = String(n.from);
    $('#nTo').value = String(n.to);
    $('#nWeak').checked = n.weak;
    $$('input[name=src]').forEach(r => { r.checked = r.value === s.source; });
    $('#aiBox').hidden = s.source !== 'ai';
    $('#aiKey').value = s.aiKey;
    $('#aiModel').value = s.aiModel;
    $('#rate').value = String(s.rate);
    $('#rateVal').textContent = Number(s.rate).toFixed(1) + '배';
    $('#autoSpeak').checked = s.autoSpeak;
    $('#quizSize').value = String(s.quizSize);
    renderVoiceOptions();
    renderNotifyStatus();
    renderRefreshBox();
  }

  function bindSettings() {
    const n = () => db.settings.notify;
    $('#nOn').addEventListener('change', async e => {
      n().on = e.target.checked;
      if (n().on && 'Notification' in window && Notification.permission === 'default') {
        try { await Notification.requestPermission(); } catch (err) { /* 무시 */ }
      }
      Popup.schedule();
      toast(n().on ? '단어 알림을 켰어요' : '단어 알림을 껐어요');
    });
    $('#nEvery').addEventListener('change', e => { n().every = Number(e.target.value); Popup.schedule(); });
    $('#nFrom').addEventListener('change', e => { n().from = Number(e.target.value); Popup.schedule(); });
    $('#nTo').addEventListener('change', e => { n().to = Number(e.target.value); Popup.schedule(); });
    $('#nWeak').addEventListener('change', e => { n().weak = e.target.checked; save(); });
    $('#nTestCard').addEventListener('click', () => {
      const w = Popup.pick();
      if (w) popupCard(w); else toast('먼저 단어를 저장하세요.');
    });
    $('#nTestPush').addEventListener('click', async () => {
      if (!db.words.length) { toast('먼저 단어를 저장하세요.'); return; }
      if (!('Notification' in window)) { toast('이 브라우저에서는 휴대폰 알림을 쓸 수 없어요.'); return; }
      if (Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (e) { /* 무시 */ } }
      renderNotifyStatus();
      if (Notification.permission !== 'granted') { toast('휴대폰 알림이 허용되지 않았어요.'); return; }
      const ok = await notifySystem(Popup.pick());
      toast(ok ? '알림을 보냈어요. 안 보이면 휴대폰의 알림 설정을 확인하세요.' : '알림을 보내지 못했어요.');
    });

    $$('input[name=src]').forEach(r => r.addEventListener('change', e => {
      db.settings.source = e.target.value;
      $('#aiBox').hidden = db.settings.source !== 'ai';
      save();
      renderRefreshBox();
      if (db.settings.source === 'ai' && !db.settings.aiKey) $('#aiKey').focus();
    }));
    $('#aiKey').addEventListener('change', e => {
      db.settings.aiKey = e.target.value.trim();
      save();
      $('#aiStatus').innerHTML = '';
      renderRefreshBox();
      toast(db.settings.aiKey ? 'API 키를 저장했어요. ‘키 확인’을 눌러 보세요.' : 'API 키를 지웠어요');
    });
    $('#aiModel').addEventListener('change', e => { db.settings.aiModel = e.target.value; save(); $('#aiStatus').innerHTML = ''; });
    $('#aiTest').addEventListener('click', e => testAIKey(e.currentTarget));

    $('#voice').addEventListener('change', e => { db.settings.voice = e.target.value; save(); Speech.say('Hello! This is how I sound.'); });
    $('#rate').addEventListener('input', e => { $('#rateVal').textContent = Number(e.target.value).toFixed(1) + '배'; });
    $('#rate').addEventListener('change', e => { db.settings.rate = Number(e.target.value); save(); });
    $('#autoSpeak').addEventListener('change', e => { db.settings.autoSpeak = e.target.checked; save(); });
    $('#voiceTest').addEventListener('click', e => Speech.say('I was reluctant to leave, but I had to go.', e.currentTarget));
    $('#quizSize').addEventListener('change', e => { db.settings.quizSize = Number(e.target.value); save(); });

    $('#backupSave').addEventListener('click', backupSave);
    $('#backupLoad').addEventListener('click', () => $('#backupFile').click());
    $('#backupFile').addEventListener('change', async e => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) await backupLoad(f);
    });
  }

  /* ---------- 예전 방식(기계 번역)으로 찾은 뜻을 사전 뜻으로 바꾸기 ---------- */

  // 출처 표시가 없는 무료 사전 단어 = 위키낱말사전을 쓰기 전에 기계 번역으로 뜻을 붙인 단어
  const oldMeaningWords = () => db.words.filter(w => w.source === 'free' && !w.credit);
  let refreshing = false;

  function renderRefreshBox() {
    renderAIRefreshBox();
    const box = $('#refreshBox');
    if (!box || refreshing) return;
    const n = db.settings.source === 'ai' ? 0 : oldMeaningWords().length;
    box.innerHTML = n
      ? '<p class="notice warn" style="margin-top:12px">예전에 기계 번역으로 뜻을 붙인 단어가 ' + n + '개 있어요. 사전(위키낱말사전) 뜻으로 바꿀 수 있어요. 예문과 퀴즈 기록은 그대로예요.</p>' +
        '<button class="btn ghost sm" data-act="refresh-meanings">예전 뜻 ' + n + '개 사전으로 다시 찾기</button>'
      : '';
  }

  async function refreshOldMeanings(btn) {
    if (refreshing) return;
    const list = oldMeaningWords();
    if (!list.length) return;
    refreshing = true;
    btn.disabled = true;
    let done = 0, changed = 0;
    for (const w of list) {
      btn.textContent = '다시 찾는 중… ' + (done + 1) + ' / ' + list.length;
      try {
        const r = await Dict.dictionaryMeanings(w.word);
        const cur = byId(w.id);
        if (r && cur) { cur.meanings = r.meanings; cur.credit = r.credit; changed++; save(); }
      } catch (e) { /* 이 단어는 건너뛰어요 */ }
      done++;
      await new Promise(res => setTimeout(res, 800)); // 사전 서버에 부담 주지 않게 천천히
    }
    refreshing = false;
    refreshAll();
    renderRefreshBox();
    toast(list.length + '개 중 ' + changed + '개의 뜻을 사전 뜻으로 바꿨어요' + (changed < list.length ? ' (사전에 없는 단어는 그대로 뒀어요)' : ''));
  }

  /* ---------- AI 사전: 키 확인 · 단어장 한꺼번에 다시 찾기 ---------- */

  const MODEL_NAMES = { 'claude-opus-5-5': 'Claude Opus 5.5', 'claude-haiku-5-5': 'Claude Haiku 5.5' };
  const notAIWords = () => db.words.filter(w => w.source !== 'ai');
  let aiRefreshing = false;

  async function testAIKey(btn) {
    const s = db.settings;
    const box = $('#aiStatus');
    if (!s.aiKey) { toast('API 키를 먼저 넣으세요.'); $('#aiKey').focus(); return; }
    btn.disabled = true;
    box.innerHTML = '<p class="notice"><span class="loading"><span class="spin"></span>' + esc(MODEL_NAMES[s.aiModel] || s.aiModel) + '에게 물어보는 중…</span></p>';
    try {
      const e = await Dict.aiLookup('reluctant', s.aiKey, s.aiModel);
      const ex = e.examples[0];
      box.innerHTML = '<p class="notice" style="background:var(--ok-soft)"><b>잘 돼요!</b> reluctant → ' + esc(Core.meaningText(e, 2)) +
        (ex ? '<br><span lang="en">' + esc(ex.en) + '</span><br><span class="muted">' + esc(ex.ko) + '</span>' : '') + '</p>';
    } catch (err) {
      box.innerHTML = '<p class="notice warn"><b>안 돼요:</b> ' + esc(Dict.aiErrorText(err)) + '</p>';
    } finally {
      btn.disabled = false;
    }
  }

  function renderAIRefreshBox() {
    const box = $('#aiRefreshBox');
    if (!box || aiRefreshing) return;
    const n = db.settings.source === 'ai' && db.settings.aiKey ? notAIWords().length : 0;
    box.innerHTML = n
      ? '<p class="muted" style="margin:12px 0 6px">단어장에 무료 사전으로 찾은 단어가 ' + n + '개 있어요. AI 뜻·예문으로 바꿀 수 있어요. 퀴즈 기록은 그대로예요.</p>' +
        '<button class="btn ghost sm" data-act="ai-refresh">단어 ' + n + '개를 AI로 다시 찾기</button>'
      : '';
  }

  async function aiRefreshAll(btn) {
    if (aiRefreshing) return;
    const s = db.settings;
    const list = notAIWords();
    if (!list.length || !s.aiKey) return;
    // 단어 하나에 Opus 5.5 약 1.5센트, Haiku 5.5 약 0.05센트로 어림해요
    const cents = list.length * (s.aiModel === 'claude-haiku-5-5' ? 0.05 : 1.5);
    const cost = cents < 1 ? '1센트 미만' : cents < 100 ? Math.ceil(cents) + '센트 안팎' : (cents / 100).toFixed(1) + '달러 안팎';
    if (!confirm('단어 ' + list.length + '개의 뜻과 예문을 ' + (MODEL_NAMES[s.aiModel] || s.aiModel) + '로 다시 찾을까요?\n' +
      '예상 요금: ' + cost + ' (내 Anthropic 계정에서 나가요)\n직접 고친 뜻도 AI 뜻으로 바뀌어요. 퀴즈 기록은 그대로예요.')) return;
    aiRefreshing = true;
    btn.disabled = true;
    let done = 0, changed = 0, stop = '';
    for (const w of list) {
      btn.textContent = 'AI로 찾는 중… ' + (done + 1) + ' / ' + list.length;
      try {
        const e = await Dict.aiLookup(w.word, s.aiKey, s.aiModel);
        const cur = byId(w.id);
        if (cur) {
          if (e.phonetic) cur.phonetic = e.phonetic;
          if (e.meanings.length) { cur.meanings = e.meanings; cur.defs = e.defs; cur.credit = e.credit; }
          if (e.examples.length) cur.examples = e.examples;
          cur.source = 'ai';
          changed++;
          save();
        }
      } catch (err) {
        // 키·잔액 문제는 다음 단어도 똑같이 실패하니 멈춰요
        if (err.status === 401 || err.status === 403 || (err.status === 400 && /credit|balance/i.test(err.message || ''))) { stop = Dict.aiErrorText(err); break; }
      }
      done++;
      await new Promise(res => setTimeout(res, 300));
    }
    aiRefreshing = false;
    refreshAll();
    renderRefreshBox();
    toast(stop ? changed + '개를 바꾸고 멈췄어요: ' + stop : list.length + '개 중 ' + changed + '개를 AI 뜻·예문으로 바꿨어요');
  }

  /* ---------- 백업 ---------- */

  function backupSave() {
    const data = {
      app: 'my-english-dictionary', version: 1, exportedAt: new Date().toISOString(),
      words: db.words, settings: Object.assign({}, db.settings, { aiKey: '' }),
    };
    const d = new Date();
    const ymd = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
    a.download = 'english-dictionary-backup-' + ymd + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('백업 파일을 저장했어요 (단어 ' + db.words.length + '개)');
  }

  async function backupLoad(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch (e) { toast('백업 파일을 읽지 못했어요.'); return; }
    if (!data || !Array.isArray(data.words)) { toast('이 앱의 백업 파일이 아니에요.'); return; }
    let added = 0, updated = 0;
    for (const raw of data.words) {
      const w = normalizeWord(raw);
      if (!w) continue;
      const cur = findSaved(w.word);
      if (!cur) {
        if (byId(w.id)) w.id = uid();
        db.words.push(w);
        added++;
      } else if ((w.srs.last || 0) > (cur.srs.last || 0)) {
        Object.assign(cur, w, { id: cur.id });
        updated++;
      }
    }
    if (data.settings) {
      const key = db.settings.aiKey;
      db.settings = normalizeSettings(data.settings);
      db.settings.aiKey = key;
    }
    db.words.sort((a, b) => b.addedAt - a.addedAt);
    save();
    renderSettings();
    Popup.schedule();
    refreshAll();
    toast('새 단어 ' + added + '개를 더하고, ' + updated + '개를 최신 기록으로 바꿨어요.');
  }

  /* ---------- 화면 전환 · 공통 ---------- */

  function updateBadges() {
    const t = now();
    const n = db.words.length;
    const due = Core.dueWords(db.words, t).length;
    $('#summary').textContent = n ? '단어 ' + n + '개 · 지금 복습할 단어 ' + due + '개' : '아직 저장한 단어가 없어요';
    $('#listBadge').hidden = !n;
    $('#listBadge').textContent = n;
    $('#dueBadge').hidden = !due;
    $('#dueBadge').textContent = due;
    try {
      if ('setAppBadge' in navigator) { if (due) navigator.setAppBadge(due).catch(() => {}); else navigator.clearAppBadge().catch(() => {}); }
    } catch (e) { /* 지원 안 함 */ }
  }

  function showTab(name) {
    state.tab = name;
    $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
    $$('main > section').forEach(s => { s.hidden = s.id !== 'tab-' + name; });
    renderTab();
    window.scrollTo(0, 0);
  }

  function renderTab() {
    if (state.tab === 'dict') renderDict();
    else if (state.tab === 'list') renderList();
    else if (state.tab === 'quiz') renderQuiz();
    else if (state.tab === 'settings') { renderNotifyStatus(); renderRefreshBox(); }
  }

  function refreshAll() {
    updateBadges();
    renderTab();
    if (state.tab !== 'dict') renderDict();
  }

  function onAction(act, el) {
    const id = el.dataset.id;
    const where = el.dataset.where;
    const s = state.quiz;
    switch (act) {
      case 'close': closeSheet(); break;
      case 'goto': closeSheet(); showTab(el.dataset.tab); break;
      case 'edit': {
        const w = byId(id);
        if (!w) break;
        if (where === 'sheet') openSheet(editorHTML(w)); else { $('#result').innerHTML = editorHTML(w); $('#edWord').focus(); }
        break;
      }
      case 'relookup': relookup(id, where); break;
      case 'delete': {
        if (!el.dataset.armed) {
          el.dataset.armed = '1';
          el.textContent = '한 번 더 누르면 삭제';
          el.classList.add('danger');
          setTimeout(() => { if (el.isConnected) { delete el.dataset.armed; el.textContent = '삭제'; el.classList.remove('danger'); } }, 3000);
          break;
        }
        const w = byId(id);
        removeWord(id);
        if (where === 'sheet') closeSheet();
        if (state.resultId === id) { $('#result').innerHTML = ''; state.resultId = null; }
        refreshAll();
        if (w) toast('‘' + w.word + '’을(를) 삭제했어요', { label: '되돌리기', run: undoRemove });
        break;
      }
      case 'add-ex': {
        const box = $('.exrows', el.closest('form'));
        box.insertAdjacentHTML('beforeend', exRow(null));
        $('.exrow:last-child [name=en]', box).focus();
        break;
      }
      case 'del-ex': el.closest('.exrow').remove(); break;
      case 'cancel-edit': {
        const inSheet = !!el.closest('dialog');
        const w = id && byId(id);
        if (inSheet) { if (w) openDetail(id); else closeSheet(); } else if (w) showSaved(w); else { $('#result').innerHTML = ''; }
        break;
      }
      case 'qtype': db.settings.quizType = el.dataset.type; save(); renderQuiz(); break;
      case 'quiz-start': startQuiz(false); break;
      case 'quiz-practice': startQuiz(true); break;
      case 'choose':
        if (s && !s.answered && s.q) { s.chosen = Number(el.dataset.i); answerQuiz(s.q.choices[s.chosen] === s.q.answer); }
        break;
      case 'hint':
        if (s && !s.answered) {
          const inp = $('#typed');
          if (inp) s.typed = inp.value;
          s.hint += 1;
          renderQuiz();
          const again = $('#typed');
          if (again) again.focus();
        }
        break;
      case 'giveup':
        if (s && !s.answered) { const inp = $('#typed'); if (inp) s.typed = inp.value.trim(); answerQuiz(false); }
        break;
      case 'quiz-next': nextQuiz(); break;
      case 'quiz-stop':
        if (s && s.results.length) s.done = true; else state.quiz = null;
        renderQuiz();
        break;
      case 'quiz-home': state.quiz = null; renderQuiz(); break;
      case 'refresh-meanings': refreshOldMeanings(el); break;
      case 'ai-refresh': aiRefreshAll(el); break;
      case 'popup-next': { const w = Popup.pick(); if (w) popupCard(w); break; }
      case 'quiz-from-popup': closeSheet(); startQuiz(false); break;
    }
  }

  function bindEvents() {
    document.addEventListener('click', e => {
      const say = e.target.closest('[data-say]');
      if (say) { Speech.say(say.dataset.say, say); return; }
      const tab = e.target.closest('.tabs button');
      if (tab) { showTab(tab.dataset.tab); return; }
      const sort = e.target.closest('[data-sort]');
      if (sort) { state.sort = sort.dataset.sort; renderList(); return; }
      const act = e.target.closest('[data-act]');
      if (act && !act.disabled) { onAction(act.dataset.act, act); return; }
      const open = e.target.closest('[data-open]');
      if (open) openDetail(open.dataset.open);
    });
    document.addEventListener('submit', e => {
      const f = e.target;
      if (f.id === 'searchForm') { e.preventDefault(); doSearch($('#q').value); $('#q').blur(); }
      else if (f.classList.contains('editor')) { e.preventDefault(); saveEditor(f); }
      else if (f.id === 'typedForm') { e.preventDefault(); submitTyped(); }
    });
    $('#filter').addEventListener('input', e => { state.filter = e.target.value; renderList(); });
    $('#sheet').addEventListener('click', e => { if (e.target === e.currentTarget) closeSheet(); });
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', () => Popup.tick());
    window.addEventListener('storage', e => { if (e.key === KEY) { db = load(); renderSettings(); refreshAll(); } });
  }

  function registerSW() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    let waiting = null;
    let updating = false;
    navigator.serviceWorker.register('sw.js').then(reg => {
      const offer = w => { if (w && navigator.serviceWorker.controller) { waiting = w; $('#update').hidden = false; } };
      offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (w) w.addEventListener('statechange', () => { if (w.state === 'installed') offer(w); });
      });
    }).catch(() => {});
    $('#updateBtn').onclick = () => { if (waiting) { updating = true; waiting.postMessage({ type: 'SKIP_WAITING' }); } };
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (updating) { updating = false; location.reload(); } });
    // 휴대폰 알림을 누르면 그 단어를 열어요
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data && e.data.type === 'open-word') { closeSheet(); openDetail(e.data.id); }
    });
  }

  function init() {
    Speech.init();
    renderSettings();
    bindSettings();
    bindEvents();
    refreshAll();
    const wid = new URLSearchParams(location.search).get('word');
    if (wid) {
      history.replaceState(null, '', location.pathname);
      openDetail(wid);
    }
    Popup.tick();
    setInterval(() => { Popup.tick(); if (!state.quiz || state.quiz.done) updateBadges(); }, 20000);
    registerSW();
  }

  init();
})();

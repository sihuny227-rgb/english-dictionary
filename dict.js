/* 나만의 영어 사전 — 단어 뜻·예문 찾기
   · 무료 사전: dictionaryapi.dev(영영 풀이·발음 기호) + MyMemory(한국어 뜻·예문 번역) + Tatoeba(예문)
   · AI(선택): 내 Claude API 키로 한국어 뜻과 자연스러운 예문 3개를 받아요 */
(function (root) {
  'use strict';
  const Core = root.Core;

  const HANGUL = /[ㄱ-ㆎ가-힣]/;
  const POS_KO = {
    noun: '명사', verb: '동사', adjective: '형용사', adverb: '부사', pronoun: '대명사',
    preposition: '전치사', conjunction: '접속사', interjection: '감탄사', determiner: '한정사',
    article: '관사', numeral: '수사', phrase: '구', idiom: '숙어', abbreviation: '약어', 'phrasal verb': '구동사',
  };

  class LookupError extends Error {
    constructor(message, code) { super(message); this.code = code; }
  }

  async function getJSON(url, opts, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms || 12000);
    try {
      const res = await fetch(url, Object.assign({}, opts, { signal: ctl.signal }));
      let body = null;
      try { body = await res.json(); } catch (e) { /* 본문이 JSON이 아니에요 */ }
      if (!res.ok) {
        const err = new LookupError((body && body.error && body.error.message) || ('HTTP ' + res.status), 'http');
        err.status = res.status;
        err.body = body;
        throw err;
      }
      return body;
    } catch (e) {
      if (e.name === 'AbortError') throw new LookupError('응답이 너무 늦어요', 'timeout');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  const wordCount = s => s.trim().split(/\s+/).length;

  function tidySentence(s) {
    let t = String(s || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    t = t[0].toUpperCase() + t.slice(1);
    if (!/[.!?"'”’)]$/.test(t)) t += '.';
    return t;
  }

  /* ---------- MyMemory 번역 ---------- */

  async function translate(text, pair) {
    const url = 'https://api.mymemory.translated.net/get?langpair=' + encodeURIComponent(pair || 'en|ko') + '&q=' + encodeURIComponent(text);
    const j = await getJSON(url);
    const t = j && j.responseData && j.responseData.translatedText;
    if (j.quotaFinished || /MYMEMORY WARNING/i.test(t || '')) throw new LookupError('오늘 무료 번역 한도를 다 썼어요', 'quota');
    return j;
  }

  function koMeanings(j, word) {
    const out = [];
    const seen = new Set();
    const add = raw => {
      const t = String(raw || '').trim().replace(/[.。]+$/, '');
      if (!t || !HANGUL.test(t) || t.length > 16 || /[.?!]/.test(t)) return;
      if (t.toLowerCase() === word.toLowerCase()) return;
      const k = t.replace(/\s/g, '');
      if (seen.has(k)) return;
      seen.add(k);
      out.push(t);
    };
    add(j.responseData && j.responseData.translatedText);
    for (const m of (j.matches || [])) if (Number(m.match) >= 0.8) add(m.translation);
    return out.slice(0, 4);
  }

  async function translateSentence(en) {
    const j = await translate(en, 'en|ko');
    const t = j.responseData && j.responseData.translatedText;
    return t && HANGUL.test(t) ? t.trim() : '';
  }

  /* ---------- Tatoeba 예문 ---------- */

  async function tatoeba(word, withKorean) {
    const q = /\s/.test(word) ? '"' + word + '"' : word;
    let url = 'https://api.tatoeba.org/unstable/sentences?lang=eng&sort=relevance&q=' + encodeURIComponent(q);
    url += withKorean ? '&trans:lang=kor&showtrans=matching&limit=10' : '&showtrans=none&limit=25';
    const j = await getJSON(url);
    return (j && j.data || []).filter(s => !s.is_unapproved).map(s => {
      const trans = [].concat(...(s.translations || []).map(x => Array.isArray(x) ? x : [x]));
      const ko = trans.find(x => x && x.lang === 'kor');
      return { en: tidySentence(s.text), ko: ko ? ko.text.trim() : '' };
    });
  }

  /* ---------- 무료 사전 ---------- */

  // 한글로 찾으면 영어 단어부터 알아내요 (점수가 같으면 짧은 쪽: Apples보다 Apple)
  async function englishFor(korean) {
    const j = await translate(korean, 'ko|en');
    const cands = [{ t: j.responseData && j.responseData.translatedText, m: Number(j.responseData && j.responseData.match) || 0 }]
      .concat((j.matches || []).map(x => ({ t: x.translation, m: Number(x.match) || 0 })))
      .map(c => ({ m: c.m, t: String(c.t || '').trim().toLowerCase().replace(/[.!?]+$/, '').replace(/^(to|a|an|the)\s+/, '') }))
      .filter(c => c.t && !HANGUL.test(c.t) && /^[a-z][a-z' -]*$/.test(c.t) && wordCount(c.t) <= 4 && c.m >= 0.5)
      .sort((a, b) => (b.m - a.m) || (a.t.length - b.t.length));
    if (!cands.length) throw new LookupError('영어 단어를 찾지 못했어요', 'notfound');
    return cands[0].t;
  }

  function parseDictionary(entries, word) {
    const out = { phonetic: '', audio: '', defs: [], examples: [] };
    if (!Array.isArray(entries)) return out;
    out.phonetic = entries.map(e => e.phonetic).find(Boolean) ||
      [].concat(...entries.map(e => e.phonetics || [])).map(p => p.text).find(Boolean) || '';
    const audios = [].concat(...entries.map(e => e.phonetics || [])).map(p => p.audio).filter(Boolean);
    out.audio = audios.find(a => /-us\./.test(a)) || audios[0] || '';
    const perPos = {};
    for (const e of entries) {
      for (const m of (e.meanings || [])) {
        const pos = POS_KO[m.partOfSpeech] || m.partOfSpeech || '';
        for (const d of (m.definitions || [])) {
          perPos[pos] = (perPos[pos] || 0) + 1;
          if (perPos[pos] <= 2 && out.defs.length < 6 && d.definition) out.defs.push({ pos, en: d.definition });
          if (d.example && Core.findWord(word, d.example)) out.examples.push({ en: tidySentence(d.example), ko: '' });
        }
      }
    }
    return out;
  }

  function chooseExamples(word, lists, n) {
    const seen = new Set();
    const pool = [];
    for (const list of lists) {
      for (const ex of list) {
        const k = ex.en.toLowerCase();
        if (!ex.en || seen.has(k) || !Core.findWord(word, ex.en)) continue;
        seen.add(k);
        pool.push(ex);
      }
    }
    // 너무 짧거나 긴 문장은 뒤로
    const fit = ex => { const c = wordCount(ex.en); return c >= 5 && c <= 16 ? 0 : 1; };
    return pool.map((ex, i) => ({ ex, i })).sort((a, b) => fit(a.ex) - fit(b.ex) || a.i - b.i).slice(0, n).map(x => x.ex);
  }

  async function freeLookup(input) {
    let word = input;
    let note = '';
    if (HANGUL.test(input)) {
      word = await englishFor(input);
      note = '‘' + input + '’ → ' + word;
    }
    // 네 곳에 한꺼번에 물어봐요 (해석 없는 Tatoeba 예문은 모자랄 때만 써요)
    const [dictR, memR, tatKoR, tatEnR] = await Promise.allSettled([
      getJSON('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word)),
      translate(word, 'en|ko'),
      tatoeba(word, true),
      tatoeba(word, false),
    ]);
    const dict = parseDictionary(dictR.status === 'fulfilled' ? dictR.value : null, word);
    const ko = memR.status === 'fulfilled' ? koMeanings(memR.value, word) : [];
    const tatKo = tatKoR.status === 'fulfilled' ? tatKoR.value : [];
    const tatEn = tatEnR.status === 'fulfilled' ? tatEnR.value : [];

    let examples = chooseExamples(word, [tatKo.slice(0, 2), dict.examples, tatKo.slice(2)], 3);
    if (examples.length < 3) examples = chooseExamples(word, [examples, tatEn], 3);

    if (!dict.defs.length && !ko.length && !examples.length) {
      const offline = [dictR, memR, tatKoR].every(r => r.status === 'rejected' && r.reason && r.reason.code !== 'http');
      if (offline) throw new LookupError('사전 서버에 연결하지 못했어요', 'network');
      throw new LookupError('뜻을 찾지 못했어요', 'notfound');
    }

    // 해석이 없는 예문은 번역해요
    await Promise.all(examples.map(async ex => {
      if (ex.ko) return;
      try { ex.ko = await translateSentence(ex.en); } catch (e) { /* 번역 없이 저장 */ }
    }));

    return {
      entry: {
        word, phonetic: dict.phonetic, audio: dict.audio,
        meanings: ko.length ? [{ pos: '', ko: ko.join(', ') }] : [],
        defs: dict.defs, examples, source: 'free',
      },
      note,
      warning: ko.length ? '' : '한국어 뜻을 찾지 못했어요. ‘수정’에서 직접 넣어 주세요.',
    };
  }

  /* ---------- AI (Claude) ---------- */

  const AI_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['found', 'word', 'phonetic', 'meanings', 'examples'],
    properties: {
      found: { type: 'boolean' },
      word: { type: 'string' },
      phonetic: { type: 'string' },
      meanings: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['pos', 'ko'],
          properties: { pos: { type: 'string' }, ko: { type: 'string' } },
        },
      },
      examples: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['en', 'ko'],
          properties: { en: { type: 'string' }, ko: { type: 'string' } },
        },
      },
    },
  };

  const AI_SYSTEM = [
    'You are an English–Korean learner\'s dictionary for a Korean adult studying English.',
    'The user sends one English word or phrase (it may be misspelled or inflected), or a Korean word.',
    'Return the entry for the English base form (for Korean input, the most common English equivalent).',
    '- word: the corrected base form, lowercase unless it is a proper noun.',
    '- phonetic: American IPA between slashes, e.g. /rɪˈlʌktənt/.',
    '- meanings: the 1–3 most common senses, most common first. pos in Korean (명사, 동사, 형용사, 부사, 전치사, 접속사, 대명사, 감탄사, 구동사, 숙어). ko: short Korean dictionary glosses separated by commas, e.g. "꺼리는, 마지못해 하는".',
    '- examples: exactly 3 natural everyday sentences of 7–15 words. Each must contain the word itself (an inflected form is fine). Cover different senses when possible. ko: a natural Korean translation.',
    '- If the input is not a real English or Korean word or phrase, set found to false and leave the other fields empty.',
  ].join('\n');

  async function aiLookup(input, key, model) {
    const body = {
      model,
      max_tokens: 4000,
      system: AI_SYSTEM,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: AI_SCHEMA } },
      messages: [{ role: 'user', content: input }],
    };
    const headers = {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2026-10-21',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    // Opus 5.5가 드물게 요청을 거절하면 서버가 다른 모델로 다시 시도해요
    const withFallback = /^claude-opus-5-5/.test(model);
    const send = fb => {
      const h = Object.assign({}, headers);
      const b = Object.assign({}, body);
      if (fb) { h['anthropic-beta'] = 'server-side-fallback-2026-07-01'; b.fallbacks = 'default'; }
      return getJSON('https://api.anthropic.com/v1/messages', { method: 'POST', headers: h, body: JSON.stringify(b) }, 60000);
    };
    let data;
    try {
      data = await send(withFallback);
    } catch (e) {
      if (withFallback && e.status === 400) data = await send(false);
      else throw e;
    }
    if (data.stop_reason === 'refusal') throw new LookupError('AI가 이 단어를 처리하지 않았어요', 'refusal');
    if (data.stop_reason === 'max_tokens') throw new LookupError('AI 답이 너무 길어서 끊겼어요', 'ai');
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    let j;
    try { j = JSON.parse(text); } catch (e) { throw new LookupError('AI 답을 읽지 못했어요', 'ai'); }
    if (!j.found || !j.word) throw new LookupError('뜻을 찾지 못했어요', 'notfound');
    return {
      word: String(j.word).trim(),
      phonetic: j.phonetic || '',
      audio: '',
      meanings: (j.meanings || []).filter(m => m && m.ko).slice(0, 3),
      defs: [],
      examples: (j.examples || []).filter(x => x && x.en).slice(0, 3).map(x => ({ en: x.en.trim(), ko: (x.ko || '').trim() })),
      source: 'ai',
    };
  }

  function aiErrorText(e) {
    if (e.status === 401) return 'API 키가 맞지 않아요';
    if (e.status === 403) return 'API 키 권한을 확인하세요';
    if (e.status === 429) return '요청이 너무 많아요. 잠시 후 다시 해 보세요';
    if (e.status === 400 && /credit|balance/i.test(e.message)) return 'API 크레딧이 부족해요';
    if (e.status >= 500 || e.status === 529) return 'AI 서버가 바빠요';
    return e.message || 'AI 오류';
  }

  async function lookup(input, settings) {
    if (settings.source === 'ai' && settings.aiKey) {
      try {
        return { entry: await aiLookup(input, settings.aiKey, settings.aiModel), note: '', warning: '' };
      } catch (e) {
        if (e.code === 'notfound') throw e;
        const r = await freeLookup(input);
        r.warning = 'AI로 찾지 못해서(' + aiErrorText(e) + ') 무료 사전으로 찾았어요.' + (r.warning ? ' ' + r.warning : '');
        return r;
      }
    }
    return freeLookup(input);
  }

  root.Dict = { lookup, LookupError, HANGUL };
})(self);

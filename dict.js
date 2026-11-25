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
    opts = opts || {};
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
    // 번역 메모리는 엉뚱한 문장이 섞여 있어서, 이 단어와 똑같은 원문에 높은 점수인 것만 써요
    const w = word.trim().toLowerCase();
    for (const m of (j.matches || [])) {
      if (Number(m.match) >= 0.9 && String(m.segment || '').trim().toLowerCase() === w) add(m.translation);
    }
    return out.slice(0, 3);
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

  /* ---------- 위키낱말사전 (ko.wiktionary.org · CC BY-SA) ----------
     사람이 쓴 한국어 뜻풀이가 품사별로 있어요. 공식 API라 휴대폰 브라우저에서 바로 불러올 수 있어요. */

  const WIKI_API = 'https://ko.wiktionary.org/w/api.php?format=json&formatversion=2&origin=*';
  // 위키미디어 권장대로 앱 이름을 밝혀요 (개인 정보는 넣지 않아요)
  const WIKI_HEADERS = { headers: { 'Api-User-Agent': 'my-english-dictionary/1.0 (personal study app)' } };
  const WIKI_POS = {
    '명사': '명사', '고유명사': '명사', '동사': '동사', '타동사': '동사', '자동사': '동사', '형용사': '형용사',
    '부사': '부사', '전치사': '전치사', '접속사': '접속사', '대명사': '대명사', '감탄사': '감탄사', '한정사': '한정사',
    '관사': '관사', '조동사': '조동사', '수사': '수사', '동사구': '구동사', '구동사': '구동사', '관용구': '숙어',
    '숙어': '숙어', '구': '구', '약어': '약어', '접두사': '접두사', '접미사': '접미사',
    '동명사': '동명사', '분사': '분사', '현재분사': '분사', '과거분사': '분사', '감동사': '감탄사',
  };
  const INFLECTION = /\[\[([A-Za-z][A-Za-z' -]*)\]\]\s*의\s*(?:과거|현재분사|복수|3인칭|비교급|최상급)/;
  const ONLY_INFLECTION = /^'?[A-Za-z][A-Za-z' -]*'?\s*의\s*(?:복수|과거|현재분사|과거분사|3인칭|비교급|최상급|동명사)[^,]*$/;

  function cleanWikiLine(s) {
    let t = String(s || '');
    for (let k = 0; k < 3; k++) t = t.replace(/\{\{[^{}]*\}\}/g, '');
    return t
      .replace(/<ref[^>]*\/>/g, '').replace(/<ref[\s\S]*?<\/ref>/g, '').replace(/<[^>]+>/g, '')
      .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
      .replace(/\[https?:[^\s\]]+\s*([^\]]*)\]/g, '$1')
      .replace(/'{2,}/g, '')
      .replace(/〔[^〕]*〕/g, '')
      .replace(/[㉠-㉿]/g, '')
      .replace(/\s*\((?=[^)]*[A-Za-z])[^()가-힣]*\)/g, '')       // (To move from ...) 같은 영어 설명은 빼요
      .replace(/^\s*\((?:자|타|자동사|타동사)[^)]*\)\s*/, '')     // 품사는 따로 보여 주니 (자)(타동사)는 빼요
      .replace(/^\s*~\s*/, '')
      .replace(/\s+/g, ' ').trim()
      .replace(/[.;。,\s]+$/, '');
  }

  function englishSection(text) {
    const lines = String(text || '').split('\n');
    const start = lines.findIndex(l => /^==\s*영어\s*==\s*$/.test(l));
    if (start < 0) return null;
    const out = [];
    for (let i = start + 1; i < lines.length; i++) {
      if (/^==[^=].*[^=]==\s*$/.test(lines[i])) break;
      out.push(lines[i]);
    }
    return out;
  }

  function parseKoWiktionary(text) {
    const lines = englishSection(text);
    if (!lines) return null;
    const groups = [];
    const group = pos => groups.find(g => g.pos === pos) || (groups.push({ pos, defs: [] }), groups[groups.length - 1]);
    let cur = group('');
    for (const line of lines) {
      const h = /^(=+)\s*([^=]+?)\s*\1\s*$/.exec(line);
      if (h) { const p = WIKI_POS[h[2].trim()]; cur = p ? group(p) : null; continue; }
      const d = /^#(?![#:*])\s*(.*)$/.exec(line);
      if (!d || !cur) continue;
      const c = cleanWikiLine(d[1]);
      if (c && /[가-힣]/.test(c) && c.length <= 80 && !ONLY_INFLECTION.test(c) && !cur.defs.includes(c)) cur.defs.push(c);
    }
    const meanings = [];
    for (const g of groups) for (const d of g.defs.slice(0, 3)) if (meanings.length < 5) meanings.push({ pos: g.pos, ko: d });
    const m = INFLECTION.exec(lines.join('\n'));
    return { meanings, lemma: m ? m[1].trim() : '' };
  }

  // 요청이 너무 잦다고(429) 하면 잠깐 쉬었다가 한 번만 다시 해요
  async function wikiJSON(params) {
    try {
      return await getJSON(WIKI_API + params, WIKI_HEADERS);
    } catch (e) {
      if (e.status !== 429) throw e;
      await new Promise(r => setTimeout(r, 1500));
      return getJSON(WIKI_API + params, WIKI_HEADERS);
    }
  }

  async function koWiktionary(word) {
    const j = await wikiJSON('&action=parse&prop=wikitext&redirects=1&page=' + encodeURIComponent(word));
    if (!j || !j.parse) return null;
    const r = parseKoWiktionary(j.parse.wikitext);
    if (r) r.title = j.parse.title;
    return r;
  }

  // 사전에 없는 변화형이면 흔한 규칙으로 원형 후보를 만들어, 위키낱말사전에 있는 첫 번째를 골라요
  function lemmaCandidates(w) {
    const c = [];
    const add = x => { if (x && x.length > 1 && x !== w && !c.includes(x)) c.push(x); };
    if (/ies$|ied$/.test(w)) add(w.slice(0, -3) + 'y');
    if (/(.)\1(ed|ing)$/.test(w)) add(w.replace(/(.)\1(ed|ing)$/, '$1'));
    if (/ing$/.test(w)) { add(w.slice(0, -3) + 'e'); add(w.slice(0, -3)); }
    if (/ed$/.test(w)) { add(w.slice(0, -1)); add(w.slice(0, -2)); }
    if (/ier$|iest$/.test(w)) add(w.replace(/ier$|iest$/, 'y'));
    if (/est$/.test(w)) { add(w.slice(0, -2)); add(w.slice(0, -3)); }
    if (/er$/.test(w)) { add(w.slice(0, -1)); add(w.slice(0, -2)); }
    if (/ves$/.test(w)) { add(w.slice(0, -3) + 'f'); add(w.slice(0, -3) + 'fe'); }
    if (/es$/.test(w)) add(w.slice(0, -2));
    if (/s$/.test(w) && !/ss$/.test(w)) add(w.slice(0, -1));
    return c;
  }

  async function findLemma(word) {
    const cands = lemmaCandidates(word.toLowerCase());
    if (!cands.length) return '';
    const j = await wikiJSON('&action=query&titles=' + encodeURIComponent(cands.join('|')));
    const have = new Set(((j && j.query && j.query.pages) || []).filter(p => !p.missing).map(p => p.title));
    for (const c of cands) {
      if (!have.has(c)) continue;
      const r = await koWiktionary(c);
      if (r && r.meanings.length) return c;
    }
    return '';
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
    return lookupEnglish(word, note, input, 0);
  }

  async function lookupEnglish(word, note, input, depth) {
    // 다섯 곳에 한꺼번에 물어봐요 (해석 없는 Tatoeba 예문은 모자랄 때만 써요)
    const [wikR, dictR, memR, tatKoR, tatEnR] = await Promise.allSettled([
      koWiktionary(word),
      getJSON('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word)),
      translate(word, 'en|ko'),
      tatoeba(word, true),
      tatoeba(word, false),
    ]);
    const wik = wikR.status === 'fulfilled' ? wikR.value : null;

    // apples·went처럼 변화형을 쳤으면 원형(apple·go)으로 다시 찾아요
    if (depth === 0 && !(wik && wik.meanings.length)) {
      let lemma = wik && wik.lemma;
      if (!lemma && !/\s/.test(word)) { try { lemma = await findLemma(word); } catch (e) { lemma = ''; } }
      if (lemma && lemma.toLowerCase() !== word.toLowerCase()) {
        return lookupEnglish(lemma.toLowerCase(), '‘' + input + '’ → ' + lemma.toLowerCase(), input, 1);
      }
    }

    const dict = parseDictionary(dictR.status === 'fulfilled' ? dictR.value : null, word);
    const tatKo = tatKoR.status === 'fulfilled' ? tatKoR.value : [];
    const tatEn = tatEnR.status === 'fulfilled' ? tatEnR.value : [];

    // 한국어 뜻: 위키낱말사전이 있으면 그걸 쓰고, 없을 때만 기계 번역(MyMemory)을 써요
    let meanings = [];
    let credit = null;
    if (wik && wik.meanings.length) {
      meanings = wik.meanings;
      credit = { name: '위키낱말사전', url: 'https://ko.wiktionary.org/wiki/' + encodeURIComponent(wik.title || word) };
    } else {
      const ko = memR.status === 'fulfilled' ? koMeanings(memR.value, word) : [];
      if (ko.length) {
        meanings = [{ pos: '', ko: ko.join(', ') }];
        credit = { name: '기계 번역(MyMemory)', url: '' };
      }
    }

    let examples = chooseExamples(word, [tatKo.slice(0, 2), dict.examples, tatKo.slice(2)], 3);
    if (examples.length < 3) examples = chooseExamples(word, [examples, tatEn], 3);

    if (!dict.defs.length && !meanings.length && !examples.length) {
      const offline = [wikR, dictR, memR, tatKoR].every(r => r.status === 'rejected' && r.reason && r.reason.code !== 'http');
      if (offline) throw new LookupError('사전 서버에 연결하지 못했어요', 'network');
      throw new LookupError('뜻을 찾지 못했어요', 'notfound');
    }

    // 해석이 없는 예문은 번역해요
    await Promise.all(examples.map(async ex => {
      if (ex.ko) return;
      try { ex.ko = await translateSentence(ex.en); } catch (e) { /* 번역 없이 저장 */ }
    }));

    let warning = '';
    if (!meanings.length) warning = '한국어 뜻을 찾지 못했어요. ‘수정’에서 직접 넣어 주세요.';
    else if (!credit || !credit.url) warning = '사전에 없는 단어라 기계 번역으로 뜻을 붙였어요. 어색하면 ‘수정’에서 고쳐 주세요.';

    return {
      entry: { word, phonetic: dict.phonetic, audio: dict.audio, meanings, defs: dict.defs, examples, source: 'free', credit },
      note,
      warning,
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
          type: 'object', additionalProperties: false, required: ['pos', 'ko', 'en'],
          properties: { pos: { type: 'string' }, ko: { type: 'string' }, en: { type: 'string' } },
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
    'You are an English–Korean learner\'s dictionary, in the style of the Cambridge English–Korean Dictionary, for a Korean adult (intermediate level) studying English.',
    'The user sends one English word or phrase (it may be misspelled or inflected), or a Korean word.',
    'Return the entry for the English base form (for Korean input, the most common English equivalent).',
    '- word: the corrected base form, lowercase unless it is a proper noun.',
    '- phonetic: American IPA between slashes, e.g. /rɪˈlʌktənt/.',
    '- meanings: the 1–3 most common senses that a learner needs, most common first; skip rare, technical and archaic senses.',
    '  pos: Korean part of speech (명사, 동사, 형용사, 부사, 전치사, 접속사, 대명사, 감탄사, 구동사, 숙어).',
    '  ko: the Korean equivalents a good Korean dictionary would give, 1–4 short glosses separated by commas, in natural Korean (e.g. "꺼리는, 마지못해 하는").',
    '  en: a short, simple English definition for learners (under 15 words).',
    '- examples: exactly 3 natural, everyday sentences of 8–15 words, the kind found in a learner\'s dictionary. Each must contain the word itself (an inflected form is fine). Use the senses in meanings, most common first. Avoid names like Tom and Mary.',
    '  ko: a natural Korean translation, not word-for-word.',
    '- If the input is not a real English or Korean word or phrase, set found to false and leave the other fields empty.',
  ].join('\n');

  const JSON_ONLY = '\nReply with only one JSON object with the keys found, word, phonetic, meanings (pos, ko, en) and examples (en, ko), and nothing else.';

  function readAIJson(text) {
    try { return JSON.parse(text); } catch (e) { /* 아래에서 다시 시도 */ }
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch (e) { /* 실패 */ } }
    return null;
  }

  async function aiLookup(input, key, model) {
    const headers = {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2026-10-21',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    // 1) 정해진 JSON 모양으로 답하게 하고, Opus 5.5가 드물게 거절하면 서버가 다른 모델로 다시 시도해요.
    // 2) 요청 모양이 거부되면(400) 더 단순한 모양으로 한 번씩 다시 보내요.
    const fallback = /^claude-opus-5-5/.test(model);
    const attempts = [
      { fallback, structured: true },
      { fallback: false, structured: true },
      { fallback: false, structured: false },
    ].filter((a, i, all) => i === 0 || a.fallback !== all[i - 1].fallback || a.structured !== all[i - 1].structured);
    let data = null;
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i];
      const h = Object.assign({}, headers);
      const body = {
        model,
        max_tokens: 4000,
        system: AI_SYSTEM + (a.structured ? '' : JSON_ONLY),
        output_config: a.structured ? { effort: 'low', format: { type: 'json_schema', schema: AI_SCHEMA } } : { effort: 'low' },
        messages: [{ role: 'user', content: input }],
      };
      if (a.fallback) { h['anthropic-beta'] = 'server-side-fallback-2026-07-01'; body.fallbacks = 'default'; }
      try {
        data = await getJSON('https://api.anthropic.com/v1/messages', { method: 'POST', headers: h, body: JSON.stringify(body) }, 60000);
        break;
      } catch (e) {
        const retryable = e.status === 400 && !/credit|balance|api.?key/i.test(e.message || '');
        if (!retryable || i === attempts.length - 1) throw e;
      }
    }
    if (data.stop_reason === 'refusal') throw new LookupError('AI가 이 단어를 처리하지 않았어요', 'refusal');
    if (data.stop_reason === 'max_tokens') throw new LookupError('AI 답이 너무 길어서 끊겼어요', 'ai');
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const j = readAIJson(text);
    if (!j) throw new LookupError('AI 답을 읽지 못했어요', 'ai');
    if (!j.found || !j.word) throw new LookupError('뜻을 찾지 못했어요', 'notfound');
    const means = (Array.isArray(j.meanings) ? j.meanings : []).filter(m => m && m.ko).slice(0, 3);
    return {
      word: String(j.word).trim(),
      phonetic: String(j.phonetic || ''),
      audio: '',
      meanings: means.map(m => ({ pos: String(m.pos || ''), ko: String(m.ko).trim() })),
      defs: means.filter(m => m.en).map(m => ({ pos: String(m.pos || ''), en: String(m.en).trim() })),
      examples: (Array.isArray(j.examples) ? j.examples : []).filter(x => x && x.en).slice(0, 3).map(x => ({ en: String(x.en).trim(), ko: String(x.ko || '').trim() })),
      source: 'ai',
      credit: { name: 'AI (Claude)', url: '' },
    };
  }

  function aiErrorText(e) {
    if (e.code === 'timeout') return 'AI 응답이 너무 늦어요';
    if (e.code === 'notfound') return '뜻을 찾지 못했어요';
    if (e.status === 401) return 'API 키가 맞지 않아요';
    if (e.status === 403) return 'API 키 권한을 확인하세요';
    if (e.status === 429) return '요청이 너무 많아요. 잠시 후 다시 해 보세요';
    if (e.status === 400 && /credit|balance/i.test(e.message || '')) return 'API 크레딧(잔액)이 부족해요';
    if (e.status >= 500) return 'AI 서버가 바빠요. 잠시 후 다시 해 보세요';
    if (!e.status && !e.code) return '인터넷 연결을 확인하세요';
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

  // 이미 저장한 단어의 뜻만 위키낱말사전으로 새로 받을 때
  async function dictionaryMeanings(word) {
    const r = await koWiktionary(word);
    if (!r || !r.meanings.length) return null;
    return { meanings: r.meanings, credit: { name: '위키낱말사전', url: 'https://ko.wiktionary.org/wiki/' + encodeURIComponent(r.title || word) } };
  }

  root.Dict = { lookup, aiLookup, aiErrorText, dictionaryMeanings, LookupError, HANGUL, parseKoWiktionary, lemmaCandidates };
})(self);

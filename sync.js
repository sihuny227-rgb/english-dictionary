/* 나만의 영어 사전 — GitHub 연동
   내 GitHub 계정의 비공개 gist(작은 저장 공간) 하나에 단어장을 저장해서 PC와 휴대폰이 같은 단어장을 써요.
   토큰은 각 기기 브라우저 안에만 저장되고 api.github.com으로만 보내요. */
(function (root) {
  'use strict';

  const API = 'https://api.github.com';
  const FILE = 'english-dictionary.json';
  const DESCRIPTION = '나만의 영어 사전 연동 데이터 (앱이 자동으로 만들었어요 · 지우면 연동이 끊겨요)';

  class SyncError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }

  async function gh(token, path, opts) {
    opts = opts || {};
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (opts.body) headers['Content-Type'] = 'application/json';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    let res;
    try {
      // cache: 'no-store' — 다른 기기가 방금 올린 내용을 바로 받으려고 브라우저 캐시를 쓰지 않아요
      res = await fetch(API + path, { method: opts.method || 'GET', headers, body: opts.body, cache: 'no-store', signal: ctl.signal });
    } catch (e) {
      throw new SyncError(e.name === 'AbortError' ? 'GitHub 응답이 너무 늦어요' : '인터넷 연결을 확인하세요', 0);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).message || ''; } catch (e) { /* 무시 */ }
      throw new SyncError(errorText(res.status, msg), res.status);
    }
    return res.status === 204 ? null : res.json();
  }

  function errorText(status, msg) {
    if (status === 401) return '토큰이 맞지 않거나 만료됐어요. 새 토큰을 넣어 주세요';
    if (status === 403 && /rate limit/i.test(msg)) return 'GitHub 요청이 너무 많아요. 잠시 후 다시 해 보세요';
    if (status === 403 || status === 404) return '토큰에 gist 권한이 없어요. 토큰을 만들 때 gist를 체크했는지 확인하세요';
    if (status >= 500) return 'GitHub 서버가 바빠요. 잠시 후 다시 해 보세요';
    return 'GitHub 오류 (' + status + (msg ? ': ' + msg : '') + ')';
  }

  // 이 앱이 만든 gist를 찾아요 (파일 이름으로 알아봐요)
  async function findGist(token) {
    for (let page = 1; page <= 5; page++) {
      const list = await gh(token, '/gists?per_page=100&page=' + page);
      const g = (list || []).find(x => x.files && x.files[FILE]);
      if (g) return g.id;
      if (!list || list.length < 100) break;
    }
    return null;
  }

  async function createGist(token, data) {
    const g = await gh(token, '/gists', {
      method: 'POST',
      body: JSON.stringify({ description: DESCRIPTION, public: false, files: { [FILE]: { content: JSON.stringify(data) } } }),
    });
    return g.id;
  }

  async function readGist(token, id) {
    const g = await gh(token, '/gists/' + encodeURIComponent(id));
    const f = g.files && g.files[FILE];
    if (!f) throw new SyncError('연동 데이터 파일이 없어요. 연동을 끊고 다시 연결해 주세요', 404);
    let text = f.content;
    if (f.truncated || typeof text !== 'string') {
      // 1MB가 넘으면 API가 내용을 잘라서 주니, 원본 주소에서 통째로 받아요
      const res = await fetch(f.raw_url, { cache: 'no-store' });
      if (!res.ok) throw new SyncError('연동 데이터를 받지 못했어요', res.status);
      text = await res.text();
    }
    try { return JSON.parse(text || '{}'); } catch (e) { throw new SyncError('연동 데이터가 깨져 있어요', 0); }
  }

  async function writeGist(token, id, data) {
    await gh(token, '/gists/' + encodeURIComponent(id), {
      method: 'PATCH',
      body: JSON.stringify({ files: { [FILE]: { content: JSON.stringify(data) } } }),
    });
  }

  root.GistSync = { FILE, SyncError, findGist, createGist, readGist, writeGist };
})(self);

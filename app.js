'use strict';

/* ================= 状態 ================= */
const LS_CFG = 'mediabox_cfg';

// このアプリ専用のリポジトリ情報(公開情報なので埋め込みでOK。トークンだけ端末ごとに入力)
const DEFAULT_CFG = { owner: 'TouchinoHMMK', repo: 'music_video_player', branch: 'main' };

const state = {
  cfg: { ...DEFAULT_CFG, ...JSON.parse(localStorage.getItem(LS_CFG) || '{}') },
  library: { tracks: [], playlists: [] },
  librarySha: null,
  queue: [],        // 再生キュー(トラックIDの配列)
  qi: -1,           // キュー内の現在位置
  shuffle: false,
  repeat: 'off',    // off | all | one
  filterTags: new Set(),
  search: '',
  openPlaylistId: null,
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const player = $('#player');

/* ================= ユーティリティ ================= */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), ms);
}

function fmtTime(sec) {
  if (!isFinite(sec)) return '0:00';
  sec = Math.floor(sec);
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function b64decodeUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function uuid() {
  return 'xxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)) + '-' + Date.now().toString(36);
}

/* ================= GitHub API ================= */
function branch() { return state.cfg.branch || 'main'; }
function cfgOk() { return !!(state.cfg.owner && state.cfg.repo && state.cfg.token); }

async function gh(path, opts = {}) {
  const { owner, repo, token } = state.cfg;
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
    ...opts,
    headers: {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { 'Authorization': 'Bearer ' + token } : {}),
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

/* ---- library.json の読み書き ---- */
async function syncLibrary(silent = false) {
  try {
    if (cfgOk()) {
      const res = await gh(`/contents/library.json?ref=${branch()}&_=${Date.now()}`);
      const j = await res.json();
      state.librarySha = j.sha;
      state.library = JSON.parse(b64decodeUtf8(j.content));
    } else {
      // 設定なし: 同一オリジン(GitHub Pages / ローカル)から読み取り専用で取得
      const res = await fetch('library.json?_=' + Date.now());
      if (res.ok) state.library = await res.json();
    }
    state.library.tracks ||= [];
    state.library.playlists ||= [];
    renderAll();
    if (!silent) toast('同期しました(曲: ' + state.library.tracks.length + ')');
  } catch (e) {
    console.error(e);
    if (!silent) toast('同期に失敗: ' + e.message, 4000);
  }
}

async function saveLibrary(message) {
  if (!cfgOk()) { toast('設定タブでGitHub情報を入力してください', 4000); throw new Error('no cfg'); }
  const content = b64encodeUtf8(JSON.stringify(state.library, null, 2));
  const body = { message, content, branch: branch() };
  if (state.librarySha) body.sha = state.librarySha;

  const put = async () => {
    const res = await gh('/contents/library.json', { method: 'PUT', body: JSON.stringify(body) });
    state.librarySha = (await res.json()).content.sha;
  };
  try {
    await put();
  } catch (e) {
    if (e.status === 409 || e.status === 422) {
      // 他端末が先に更新した場合: 最新shaを取り直して再試行(自分の変更で上書き)
      const r = await gh(`/contents/library.json?ref=${branch()}`);
      body.sha = (await r.json()).sha;
      await put();
    } else { throw e; }
  }
}

/* ================= トラック操作 ================= */
function trackById(id) { return state.library.tracks.find((t) => t.id === id); }

function allTags() {
  const set = new Set();
  state.library.tracks.forEach((t) => (t.tags || []).forEach((x) => set.add(x)));
  return [...set].sort();
}

function filteredTracks() {
  return state.library.tracks.filter((t) => {
    if (state.search && !t.title.toLowerCase().includes(state.search.toLowerCase())) return false;
    for (const tag of state.filterTags) {
      if (!(t.tags || []).includes(tag)) return false;
    }
    return true;
  });
}

async function setTrackTags(id, tags) {
  const t = trackById(id);
  if (!t) return;
  t.tags = tags;
  renderAll();
  await saveLibrary(`Update tags: ${t.title}`);
  toast('タグを保存しました');
}

async function deleteTrack(id) {
  const t = trackById(id);
  if (!t) return;
  if (!confirm(`「${t.title}」を削除しますか?\n(リポジトリ内のファイルも削除されます)`)) return;
  try {
    // メディアファイル本体を削除
    try {
      const r = await gh(`/contents/${t.file}?ref=${branch()}`);
      const info = await r.json();
      await gh(`/contents/${t.file}`, {
        method: 'DELETE',
        body: JSON.stringify({ message: `Delete: ${t.title}`, sha: info.sha, branch: branch() }),
      });
    } catch (e) {
      if (e.status !== 404) throw e; // ファイルが既に無い場合は無視
    }
    state.library.tracks = state.library.tracks.filter((x) => x.id !== id);
    state.library.playlists.forEach((p) => { p.trackIds = p.trackIds.filter((x) => x !== id); });
    await removeOffline(t).catch(() => {}); // 端末のオフライン保存も削除
    await saveLibrary(`Remove from library: ${t.title}`);
    renderAll();
    toast('削除しました');
  } catch (e) {
    toast('削除に失敗: ' + e.message, 4000);
  }
}

/* ================= オフライン保存 ================= */
const MEDIA_CACHE = 'mediabox-media-v1';

function mediaUrlOf(t) { return new URL(t.file, location.href).href; }

async function refreshOfflineSet() {
  try {
    const cache = await caches.open(MEDIA_CACHE);
    const keys = await cache.keys();
    state.offlineFiles = new Set(keys.map((r) => r.url));
  } catch {
    state.offlineFiles = new Set();
  }
}

function isOffline(t) { return state.offlineFiles?.has(mediaUrlOf(t)); }

async function saveOffline(t) {
  const cache = await caches.open(MEDIA_CACHE);
  const res = await fetch(t.file, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  await cache.put(new Request(mediaUrlOf(t)), res);
  state.offlineFiles?.add(mediaUrlOf(t));
  // ブラウザに「この保存領域を消さないで」とお願いする(1回だけ)
  try { await navigator.storage?.persist?.(); } catch { /* 未対応は無視 */ }
}

async function removeOffline(t) {
  const cache = await caches.open(MEDIA_CACHE);
  await cache.delete(mediaUrlOf(t), { ignoreSearch: true });
  state.offlineFiles?.delete(mediaUrlOf(t));
}

async function saveAllOffline(tracks, label) {
  let done = 0, failed = 0;
  const targets = tracks.filter((t) => !isOffline(t));
  if (!targets.length) { toast('すべて保存済みです'); return; }
  for (const t of targets) {
    toast(`📥 ${label} 保存中... (${done + failed + 1}/${targets.length})`, 60000);
    try { await saveOffline(t); done++; } catch { failed++; }
  }
  renderAll();
  toast(`📥 保存完了: ${done}曲` + (failed ? ` / 失敗: ${failed}曲` : ''), 4000);
}

async function updateStorageInfo() {
  const el = $('#storage-info');
  if (!el) return;
  try {
    const est = await navigator.storage.estimate();
    const used = (est.usage / 1024 / 1024).toFixed(0);
    const quota = (est.quota / 1024 / 1024 / 1024).toFixed(1);
    const count = state.offlineFiles?.size || 0;
    el.textContent = `オフライン保存: ${count}曲 / 使用容量: 約${used}MB(上限 約${quota}GB)`;
  } catch {
    el.textContent = '';
  }
}

/* ================= 再生位置の記憶(動画のみ) ================= */
const LS_POS = 'mediabox_pos';

function loadPositions() {
  try { return JSON.parse(localStorage.getItem(LS_POS) || '{}'); } catch { return {}; }
}
function savePosition(id, sec) {
  const p = loadPositions();
  p[id] = Math.floor(sec);
  localStorage.setItem(LS_POS, JSON.stringify(p));
}
function clearPosition(id) {
  const p = loadPositions();
  if (id in p) { delete p[id]; localStorage.setItem(LS_POS, JSON.stringify(p)); }
}

function skipBy(sec) {
  if (!player.src || !isFinite(player.duration)) return;
  player.currentTime = Math.min(Math.max(0, player.currentTime + sec), Math.max(0, player.duration - 0.5));
}

/* ================= 再生 ================= */
function trackSrc(t) { return t.file; } // Pages/ローカルの相対パス

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function playContext(ids, startId) {
  state.queue = [...ids];
  if (state.shuffle) {
    shuffleArray(state.queue);
    if (startId) {
      const i = state.queue.indexOf(startId);
      if (i > 0) { state.queue.splice(i, 1); state.queue.unshift(startId); }
    }
  }
  state.qi = startId ? state.queue.indexOf(startId) : 0;
  playCurrent();
}

async function playCurrent() {
  const id = state.queue[state.qi];
  const t = trackById(id);
  if (!t) return;

  player.src = trackSrc(t);
  $('#video-wrap').style.display = t.type === 'video' ? 'block' : 'none';
  $('#playerbar').style.display = 'block';
  $('#pb-title').textContent = t.title;

  try {
    await player.play();
  } catch (e) {
    // 相対パスで再生できない場合(プライベートリポジトリ等)はAPI経由で取得
    if (cfgOk()) {
      try {
        const res = await gh(`/contents/${t.file}?ref=${branch()}`, {
          headers: { 'Accept': 'application/vnd.github.raw+json' },
        });
        const blob = await res.blob();
        if (player._blobUrl) URL.revokeObjectURL(player._blobUrl);
        player._blobUrl = URL.createObjectURL(blob);
        player.src = player._blobUrl;
        await player.play();
      } catch (e2) {
        toast('再生できません: ' + e2.message, 4000);
        return;
      }
    } else {
      toast('再生できません(同期するか設定を確認してください)', 4000);
      return;
    }
  }

  // 動画は前回の続きから再生(終わり際まで見ていた場合は最初から)
  if (t.type === 'video') {
    const pos = loadPositions()[t.id] || 0;
    const nearEnd = isFinite(player.duration) && pos > player.duration - 15;
    if (pos > 5 && !nearEnd) player.currentTime = pos;
  }

  updatePlayBtn();
  renderTrackList();
  renderPlaylistDetail();

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: (t.tags || []).join(', ') || 'MediaBox',
    });
    navigator.mediaSession.setActionHandler('play', () => player.play());
    navigator.mediaSession.setActionHandler('pause', () => player.pause());
    navigator.mediaSession.setActionHandler('previoustrack', prev);
    navigator.mediaSession.setActionHandler('nexttrack', () => next(false));
    try {
      navigator.mediaSession.setActionHandler('seekbackward', () => skipBy(-10));
      navigator.mediaSession.setActionHandler('seekforward', () => skipBy(10));
    } catch { /* 未対応ブラウザは無視 */ }
  }
}

function next(auto) {
  if (auto && state.repeat === 'one') {
    player.currentTime = 0;
    player.play();
    return;
  }
  if (state.qi < state.queue.length - 1) {
    state.qi++;
    playCurrent();
  } else if (state.queue.length && (state.repeat === 'all' || !auto)) {
    if (state.shuffle) shuffleArray(state.queue);
    state.qi = 0;
    if (state.repeat === 'all' || !auto) playCurrent();
  } else {
    player.pause();
    updatePlayBtn();
  }
}

function prev() {
  if (player.currentTime > 3 || state.qi <= 0) {
    player.currentTime = 0;
  } else {
    state.qi--;
    playCurrent();
  }
}

function togglePlay() {
  if (!player.src) return;
  if (player.paused) player.play(); else player.pause();
}

function updatePlayBtn() {
  $('#btn-play').textContent = player.paused ? '▶' : '⏸';
}

function currentTrackId() { return state.queue[state.qi]; }

/* ================= 描画 ================= */
function renderAll() {
  renderTagChips();
  renderTrackList();
  renderPlaylists();
  renderPlaylistDetail();
}

function typeIcon(t) { return t.type === 'video' ? '🎬' : '🎵'; }

function trackItemHtml(t, opts = {}) {
  const playing = t.id === currentTrackId();
  const tags = (t.tags || []).map((x) => `<span class="minitag">${esc(x)}</span>`).join('');
  const offBadge = isOffline(t) ? '<span class="offline-badge" title="オフライン保存済み">✓</span>' : '';
  const thumb = t.thumb
    ? `<div class="thumb has-img"><img src="${esc(t.thumb)}" loading="lazy" onerror="this.parentNode.classList.remove('has-img');this.remove()"><span class="thumb-fallback">${typeIcon(t)}</span>${offBadge}</div>`
    : `<div class="thumb"><span class="thumb-fallback">${typeIcon(t)}</span>${offBadge}</div>`;
  const eq = playing ? '<span class="eq"><i></i><i></i><i></i></span>' : '';
  return `
    <div class="item ${playing ? 'playing' : ''}" data-id="${esc(t.id)}">
      ${thumb}
      <div class="meta" data-act="play">
        <div class="title">${eq}${esc(t.title)}</div>
        ${tags ? `<div class="tagrow">${tags}</div>` : ''}
      </div>
      <button class="menu-btn" data-act="${opts.inPlaylist ? 'plmenu' : 'menu'}">⋮</button>
    </div>`;
}

function renderTrackList() {
  const tracks = filteredTracks();
  const el = $('#track-list');
  if (!state.library.tracks.length) {
    el.innerHTML = `<div class="empty">まだ曲がありません。<br>「＋追加」タブからURLダウンロード or ファイルをアップロードしてください。</div>`;
    return;
  }
  el.innerHTML = tracks.length
    ? tracks.map((t) => trackItemHtml(t)).join('')
    : `<div class="empty">条件に一致する曲がありません</div>`;
}

function renderTagChips() {
  const tags = allTags();
  $('#tag-chips').innerHTML = tags.map((t) =>
    `<button class="chip ${state.filterTags.has(t) ? 'on' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`
  ).join('');
}

function renderPlaylists() {
  const el = $('#playlist-list');
  const pls = state.library.playlists;
  el.innerHTML = pls.length
    ? pls.map((p) => `
      <div class="item" data-plid="${esc(p.id)}">
        <div class="thumb">🗂</div>
        <div class="meta" data-act="open">
          <div class="title">${esc(p.name)}</div>
          <div class="sub">${p.trackIds.length} 曲</div>
        </div>
        <button class="menu-btn" data-act="playall">▶</button>
      </div>`).join('')
    : `<div class="empty">プレイリストがありません</div>`;
}

function renderPlaylistDetail() {
  const p = state.library.playlists.find((x) => x.id === state.openPlaylistId);
  $('#playlist-home').style.display = p ? 'none' : 'block';
  $('#playlist-detail').style.display = p ? 'block' : 'none';
  if (!p) return;
  $('#pl-title').textContent = p.name;
  const tracks = p.trackIds.map(trackById).filter(Boolean);
  $('#pl-tracks').innerHTML = tracks.length
    ? tracks.map((t) => trackItemHtml(t, { inPlaylist: true })).join('')
    : `<div class="empty">曲がありません。ライブラリの「⋮」から追加できます。</div>`;
}

/* ================= モーダル ================= */
function openModal(html) {
  $('#modal-body').innerHTML = html;
  $('#modal').classList.add('open');
}
function closeModal() { $('#modal').classList.remove('open'); }

function openTrackMenu(id) {
  const t = trackById(id);
  if (!t) return;
  const saved = isOffline(t);
  openModal(`
    <h3>${esc(t.title)}</h3>
    <div class="modal-list">
      <button data-m="offline">${saved ? '✓ オフライン保存済み(タップで端末から削除)' : '📥 この端末に保存(パケット節約)'}</button>
      <button data-m="tags">🏷 タグを編集</button>
      <button data-m="addpl">🗂 プレイリストに追加</button>
      <button data-m="delete" class="danger">🗑 削除</button>
    </div>`);
  $('#modal-body').onclick = async (e) => {
    const m = e.target.dataset.m;
    if (m === 'offline') {
      closeModal();
      try {
        if (saved) {
          await removeOffline(t);
          toast('端末から削除しました(GitHub上には残っています)');
        } else {
          toast('📥 保存中...', 30000);
          await saveOffline(t);
          toast('📥 保存しました。今後この曲はパケットを使いません');
        }
        renderAll();
      } catch (err) {
        toast('保存に失敗: ' + err.message, 4000);
      }
    }
    if (m === 'tags') openTagEditor(id);
    if (m === 'addpl') openAddToPlaylist(id);
    if (m === 'delete') { closeModal(); deleteTrack(id); }
  };
}

function openTagEditor(id) {
  const t = trackById(id);
  const selected = new Set(t.tags || []);
  const render = () => {
    const tags = [...new Set([...allTags(), ...selected])].sort();
    $('#tag-choice').innerHTML = tags.length
      ? tags.map((x) =>
          `<button class="chip ${selected.has(x) ? 'on' : ''}" data-tag="${esc(x)}">${esc(x)}</button>`
        ).join('')
      : '<p class="note">まだタグがありません。下の欄から作成できます。</p>';
  };
  openModal(`
    <h3>タグを編集</h3>
    <p class="note">${esc(t.title)}</p>
    <p class="note">タップで選択/解除</p>
    <div class="chips" id="tag-choice"></div>
    <div class="form">
      <div class="row">
        <input type="text" id="new-tag-name" placeholder="新しいタグを作る">
        <button id="new-tag-add" style="flex:0 0 auto">＋ 作成</button>
      </div>
      <button class="primary wide" id="tag-save">保存</button>
    </div>`);
  render();
  $('#tag-choice').onclick = (e) => {
    const tag = e.target.dataset.tag;
    if (!tag) return;
    selected.has(tag) ? selected.delete(tag) : selected.add(tag);
    render();
  };
  $('#new-tag-add').onclick = () => {
    const name = $('#new-tag-name').value.trim();
    if (!name) return;
    selected.add(name);
    $('#new-tag-name').value = '';
    render();
  };
  $('#tag-save').onclick = async () => {
    closeModal();
    await setTrackTags(id, [...selected]);
  };
}

/* ---- プレイリストへ曲を選んで追加 ---- */
function openAddTracksToPlaylist(plId) {
  const p = state.library.playlists.find((x) => x.id === plId);
  if (!p) return;
  const picked = new Set();
  let query = '';
  const candidates = () =>
    state.library.tracks.filter((t) =>
      !p.trackIds.includes(t.id) &&
      (!query || t.title.toLowerCase().includes(query.toLowerCase())));
  const render = () => {
    const list = candidates();
    $('#pick-list').innerHTML = list.length
      ? list.map((t) => `
        <button class="pick-item ${picked.has(t.id) ? 'on' : ''}" data-id="${esc(t.id)}">
          <span class="pick-check">${picked.has(t.id) ? '✓' : ''}</span>
          <span class="pick-icon">${typeIcon(t)}</span>
          <span class="pick-title">${esc(t.title)}</span>
        </button>`).join('')
      : '<p class="note">追加できる曲がありません</p>';
    $('#pick-count').textContent = picked.size ? `追加(${picked.size}曲)` : '追加';
  };
  openModal(`
    <h3>「${esc(p.name)}」に曲を追加</h3>
    <input type="search" id="pick-search" placeholder="検索...">
    <div class="modal-list" id="pick-list" style="max-height:45vh;overflow-y:auto"></div>
    <button class="primary wide" id="pick-save"><span id="pick-count">追加</span></button>`);
  render();
  $('#pick-search').oninput = (e) => { query = e.target.value; render(); };
  $('#pick-list').onclick = (e) => {
    const btn = e.target.closest('.pick-item');
    if (!btn) return;
    const id = btn.dataset.id;
    picked.has(id) ? picked.delete(id) : picked.add(id);
    render();
  };
  $('#pick-save').onclick = async () => {
    if (!picked.size) { closeModal(); return; }
    p.trackIds.push(...picked);
    closeModal();
    renderAll();
    await saveLibrary(`Add ${picked.size} tracks to playlist: ${p.name}`);
    toast(`${picked.size}曲を追加しました`);
  };
}

function openAddToPlaylist(id) {
  const pls = state.library.playlists;
  openModal(`
    <h3>プレイリストに追加</h3>
    <div class="modal-list">
      ${pls.map((p) => `<button data-pl="${esc(p.id)}">🗂 ${esc(p.name)}(${p.trackIds.length}曲)</button>`).join('')}
    </div>
    <div class="form">
      <div class="row">
        <input type="text" id="new-pl-name" placeholder="新規プレイリスト名">
        <button id="new-pl-add" class="primary" style="flex:0 0 auto">作成して追加</button>
      </div>
    </div>`);
  $('#modal-body').onclick = async (e) => {
    const plid = e.target.dataset.pl;
    if (plid) {
      const p = pls.find((x) => x.id === plid);
      if (!p.trackIds.includes(id)) p.trackIds.push(id);
      closeModal();
      renderAll();
      await saveLibrary(`Add to playlist: ${p.name}`);
      toast(`「${p.name}」に追加しました`);
    }
  };
  $('#new-pl-add').onclick = async () => {
    const name = $('#new-pl-name').value.trim();
    if (!name) return;
    const p = { id: uuid(), name, trackIds: [id] };
    state.library.playlists.push(p);
    closeModal();
    renderAll();
    await saveLibrary(`New playlist: ${name}`);
    toast(`「${name}」を作成しました`);
  };
}

/* ================= ダウンロード(GitHub Actions) ================= */
function urlHasList(u) {
  return /[?&]list=|playlist|\/mylist\/|\/series\//.test(u);
}

async function triggerDownload() {
  let url = $('#dl-url').value.trim();
  const format = $('#dl-format').value;
  const tags = $('#dl-tags').value.trim();
  if (!url) { toast('URLを入力してください'); return; }
  if (!cfgOk()) { toast('設定タブでGitHub情報を入力してください', 4000); return; }
  // リストを含むURLは「この曲だけ / リスト全曲」の選択を付けて送る
  if (urlHasList(url)) {
    url = url.split('#')[0] + ($('#dl-scope').value === 'playlist' ? '#mediabox-playlist' : '#mediabox-single');
  }
  try {
    await gh('/actions/workflows/download.yml/dispatches', {
      method: 'POST',
      body: JSON.stringify({ ref: branch(), inputs: { url, format, tags } }),
    });
    $('#dl-url').value = '';
    $('#dl-tags').value = '';
    toast('ダウンロードを開始しました(1〜3分後に「⟳同期」を押してください)', 5000);
    setTimeout(refreshRuns, 3000);
  } catch (e) {
    toast('開始に失敗: ' + e.message, 5000);
  }
}

async function refreshRuns() {
  if (!cfgOk()) { $('#runs-list').innerHTML = '<div class="empty">GitHub設定が必要です</div>'; return; }
  try {
    const res = await gh('/actions/runs?per_page=10');
    const j = await res.json();
    const runs = (j.workflow_runs || []).filter((r) => r.path?.endsWith('download.yml'));
    $('#runs-list').innerHTML = runs.length
      ? runs.map((r) => {
          let icon, cls;
          if (r.status !== 'completed') { icon = '⏳ 実行中'; cls = 'run-busy'; }
          else if (r.conclusion === 'success') { icon = '✅ 完了'; cls = 'run-ok'; }
          else { icon = '❌ 失敗'; cls = 'run-fail'; }
          const when = new Date(r.created_at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          return `<div class="item"><div class="meta">
            <div class="title">${esc(r.display_title)}</div>
            <div class="sub"><span class="${cls}">${icon}</span> ・ ${when}</div>
          </div></div>`;
        }).join('')
      : '<div class="empty">まだ実行履歴がありません</div>';
  } catch (e) {
    $('#runs-list').innerHTML = `<div class="empty">取得失敗: ${esc(e.message)}</div>`;
  }
}

/* ================= アップロード ================= */
async function uploadFiles(files) {
  if (!cfgOk()) { toast('設定タブでGitHub情報を入力してください', 4000); return; }
  const status = $('#upload-status');
  for (const file of files) {
    if (file.size > 50 * 1024 * 1024) {
      status.textContent = `✕ ${file.name}: 50MBを超えるためスキップ`;
      continue;
    }
    status.textContent = `⏳ アップロード中: ${file.name}`;
    try {
      const b64 = await new Promise((ok, ng) => {
        const r = new FileReader();
        r.onload = () => ok(r.result.split(',')[1]);
        r.onerror = ng;
        r.readAsDataURL(file);
      });
      const safeName = file.name.replace(/[^\w.\-ぁ-んァ-ヶ一-龠]/g, '_');
      const path = `media/upload-${Date.now()}-${safeName}`;
      await gh(`/contents/${path}`, {
        method: 'PUT',
        body: JSON.stringify({ message: `Upload: ${file.name}`, content: b64, branch: branch() }),
      });
      const isVideo = file.type.startsWith('video');
      state.library.tracks.push({
        id: uuid(),
        title: file.name.replace(/\.[^.]+$/, ''),
        type: isVideo ? 'video' : 'audio',
        file: path,
        tags: [],
        source: 'upload',
        addedAt: new Date().toISOString(),
      });
      await saveLibrary(`Add uploaded: ${file.name}`);
      status.textContent = `✅ 完了: ${file.name}`;
      renderAll();
    } catch (e) {
      status.textContent = `✕ 失敗: ${file.name}(${e.message})`;
    }
  }
}

/* ================= 設定 ================= */
function loadCfgToForm() {
  $('#cfg-owner').value = state.cfg.owner || '';
  $('#cfg-repo').value = state.cfg.repo || '';
  $('#cfg-branch').value = state.cfg.branch || 'main';
  $('#cfg-token').value = state.cfg.token || '';
}

async function saveCfg() {
  state.cfg = {
    owner: $('#cfg-owner').value.trim(),
    repo: $('#cfg-repo').value.trim(),
    branch: $('#cfg-branch').value.trim() || 'main',
    token: $('#cfg-token').value.trim(),
  };
  localStorage.setItem(LS_CFG, JSON.stringify(state.cfg));
  const st = $('#cfg-status');
  st.textContent = '接続テスト中...';
  try {
    await gh('');
    st.textContent = '✅ 接続OK!同期します...';
    await syncLibrary();
    st.textContent = '✅ 接続OK・同期完了';
  } catch (e) {
    st.textContent = '✕ 接続失敗: ' + e.message;
  }
}

/* ================= イベント ================= */
function switchView(name) {
  $$('.view').forEach((v) => v.classList.remove('active'));
  $(`#view-${name}`).classList.add('active');
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  if (name === 'add') refreshRuns();
  if (name === 'settings') updateStorageInfo();
}

function bindEvents() {
  // タブ
  $$('.tab').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));

  // 同期
  $('#btn-sync').addEventListener('click', () => syncLibrary());

  // 検索・タグフィルタ
  $('#search').addEventListener('input', (e) => { state.search = e.target.value; renderTrackList(); });
  $('#tag-chips').addEventListener('click', (e) => {
    const tag = e.target.dataset.tag;
    if (!tag) return;
    state.filterTags.has(tag) ? state.filterTags.delete(tag) : state.filterTags.add(tag);
    renderTagChips();
    renderTrackList();
  });

  // ライブラリのトラック
  $('#track-list').addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (!item) return;
    const id = item.dataset.id;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'menu') openTrackMenu(id);
    else playContext(filteredTracks().map((t) => t.id), id);
  });

  // プレイリスト一覧
  $('#playlist-list').addEventListener('click', async (e) => {
    const item = e.target.closest('.item');
    if (!item) return;
    const p = state.library.playlists.find((x) => x.id === item.dataset.plid);
    if (!p) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'playall') {
      if (p.trackIds.length) playContext([...p.trackIds], p.trackIds[0]);
    } else {
      state.openPlaylistId = p.id;
      renderPlaylistDetail();
    }
  });

  $('#btn-new-playlist').addEventListener('click', async () => {
    const name = prompt('プレイリスト名');
    if (!name?.trim()) return;
    state.library.playlists.push({ id: uuid(), name: name.trim(), trackIds: [] });
    renderAll();
    await saveLibrary(`New playlist: ${name}`);
  });

  // プレイリスト詳細
  $('#btn-pl-back').addEventListener('click', () => { state.openPlaylistId = null; renderPlaylistDetail(); renderPlaylists(); });
  $('#btn-pl-play').addEventListener('click', () => {
    const p = state.library.playlists.find((x) => x.id === state.openPlaylistId);
    if (p?.trackIds.length) { state.shuffle = false; updateModeButtons(); playContext([...p.trackIds], p.trackIds[0]); }
  });
  $('#btn-pl-shuffle').addEventListener('click', () => {
    const p = state.library.playlists.find((x) => x.id === state.openPlaylistId);
    if (p?.trackIds.length) { state.shuffle = true; updateModeButtons(); playContext([...p.trackIds]); }
  });
  $('#btn-pl-add').addEventListener('click', () => openAddTracksToPlaylist(state.openPlaylistId));
  $('#btn-pl-offline').addEventListener('click', () => {
    const p = state.library.playlists.find((x) => x.id === state.openPlaylistId);
    if (!p) return;
    const tracks = p.trackIds.map(trackById).filter(Boolean);
    if (tracks.length) saveAllOffline(tracks, p.name);
  });
  $('#btn-pl-rename').addEventListener('click', async () => {
    const p = state.library.playlists.find((x) => x.id === state.openPlaylistId);
    if (!p) return;
    const name = prompt('新しい名前', p.name);
    if (!name?.trim()) return;
    p.name = name.trim();
    renderAll();
    await saveLibrary(`Rename playlist: ${name}`);
  });
  $('#btn-pl-delete').addEventListener('click', async () => {
    const p = state.library.playlists.find((x) => x.id === state.openPlaylistId);
    if (!p) return;
    if (!confirm(`プレイリスト「${p.name}」を削除しますか?(曲自体は残ります)`)) return;
    state.library.playlists = state.library.playlists.filter((x) => x.id !== p.id);
    state.openPlaylistId = null;
    renderAll();
    await saveLibrary(`Delete playlist: ${p.name}`);
  });

  $('#pl-tracks').addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (!item) return;
    const id = item.dataset.id;
    const p = state.library.playlists.find((x) => x.id === state.openPlaylistId);
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'plmenu') {
      const t = trackById(id);
      openModal(`
        <h3>${esc(t?.title || '')}</h3>
        <div class="modal-list">
          <button data-m="tags">🏷 タグを編集</button>
          <button data-m="rm" class="danger">－ このプレイリストから外す</button>
        </div>`);
      $('#modal-body').onclick = async (ev) => {
        const m = ev.target.dataset.m;
        if (m === 'tags') openTagEditor(id);
        if (m === 'rm') {
          p.trackIds = p.trackIds.filter((x) => x !== id);
          closeModal();
          renderAll();
          await saveLibrary(`Remove from playlist: ${p.name}`);
        }
      };
    } else {
      playContext([...p.trackIds], id);
    }
  });

  // ダウンロード / アップロード
  $('#btn-download').addEventListener('click', triggerDownload);
  $('#btn-refresh-runs').addEventListener('click', refreshRuns);
  $('#upload-file').addEventListener('change', (e) => uploadFiles([...e.target.files]));
  // URLにプレイリストが含まれるときだけ範囲選択を表示
  $('#dl-url').addEventListener('input', (e) => {
    const u = e.target.value;
    const row = $('#dl-scope-row');
    row.style.display = urlHasList(u) ? 'block' : 'none';
    if (urlHasList(u)) {
      // playlist?list=... のようなリスト専用ページは全曲をデフォルトに
      $('#dl-scope').value = /watch\?v=|youtu\.be\//.test(u) ? 'single' : 'playlist';
    }
  });

  // 設定
  $('#btn-save-cfg').addEventListener('click', saveCfg);
  // 設定コード: 他の端末へ設定(トークン込み)を持ち運ぶ
  $('#btn-export-cfg').addEventListener('click', async () => {
    if (!state.cfg.token) { toast('先にトークンを設定してください'); return; }
    const code = btoa(unescape(encodeURIComponent(JSON.stringify(state.cfg))));
    try {
      await navigator.clipboard.writeText(code);
      toast('設定コードをコピーしました。他の端末の設定画面に貼り付けてください', 4500);
    } catch {
      prompt('このコードをコピーしてください', code);
    }
  });
  $('#btn-import-cfg').addEventListener('click', async () => {
    const code = $('#cfg-code').value.trim();
    if (!code) { toast('設定コードを貼り付けてください'); return; }
    try {
      const cfg = JSON.parse(decodeURIComponent(escape(atob(code))));
      if (!cfg.owner || !cfg.repo || !cfg.token) throw new Error('bad');
      state.cfg = { ...DEFAULT_CFG, ...cfg };
      localStorage.setItem(LS_CFG, JSON.stringify(state.cfg));
      loadCfgToForm();
      $('#cfg-code').value = '';
      toast('設定を読み込みました。同期します...');
      await syncLibrary();
    } catch {
      toast('設定コードが正しくありません', 4000);
    }
  });

  // プレイヤー操作
  $('#btn-play').addEventListener('click', togglePlay);
  $('#btn-next').addEventListener('click', () => next(false));
  $('#btn-prev').addEventListener('click', prev);
  $('#btn-shuffle').addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    if (state.shuffle && state.queue.length) {
      const cur = currentTrackId();
      shuffleArray(state.queue);
      const i = state.queue.indexOf(cur);
      if (i > 0) { state.queue.splice(i, 1); state.queue.unshift(cur); }
      state.qi = 0;
    }
    updateModeButtons();
    toast(state.shuffle ? 'シャッフル: ON' : 'シャッフル: OFF', 1500);
  });
  $('#btn-repeat').addEventListener('click', () => {
    state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
    updateModeButtons();
    toast(`リピート: ${state.repeat === 'off' ? 'OFF' : state.repeat === 'all' ? '全曲' : '1曲'}`, 1500);
  });
  $('#btn-video-close').addEventListener('click', () => {
    $('#video-wrap').style.display = 'none';
  });

  $('#btn-back10').addEventListener('click', () => skipBy(-10));
  $('#btn-fwd10').addEventListener('click', () => skipBy(10));

  player.addEventListener('ended', () => {
    clearPosition(currentTrackId()); // 最後まで見たので続き情報を消す
    next(true);
  });
  player.addEventListener('play', updatePlayBtn);
  player.addEventListener('pause', updatePlayBtn);
  let lastPosSave = 0;
  player.addEventListener('timeupdate', () => {
    $('#pb-cur').textContent = fmtTime(player.currentTime);
    $('#pb-dur').textContent = fmtTime(player.duration);
    if (!seek._dragging && isFinite(player.duration)) {
      seek.value = (player.currentTime / player.duration) * 100 || 0;
    }
    // 動画の再生位置を約3秒おきに保存(続きから再生用)
    const t = trackById(currentTrackId());
    if (t?.type === 'video' && Math.abs(player.currentTime - lastPosSave) > 3) {
      lastPosSave = player.currentTime;
      if (isFinite(player.duration) && player.currentTime > player.duration - 15) {
        clearPosition(t.id); // 終わり際は「見終わった」扱い
      } else {
        savePosition(t.id, player.currentTime);
      }
    }
  });
  const seek = $('#seek');
  seek.addEventListener('input', () => { seek._dragging = true; });
  seek.addEventListener('change', () => {
    if (isFinite(player.duration)) player.currentTime = (seek.value / 100) * player.duration;
    seek._dragging = false;
  });

  // モーダル
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
}

function updateModeButtons() {
  $('#btn-shuffle').classList.toggle('on', state.shuffle);
  const rb = $('#btn-repeat');
  rb.classList.toggle('on', state.repeat !== 'off');
  rb.innerHTML = state.repeat === 'one' ? '🔁<span class="sup">1</span>' : '🔁';
}

/* ================= 初期化 ================= */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

bindEvents();
loadCfgToForm();
updateModeButtons();
refreshOfflineSet().then(() => syncLibrary(true));

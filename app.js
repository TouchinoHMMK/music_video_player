'use strict';

/* ================= 状態 ================= */
const LS_CFG = 'mediabox_cfg';

const state = {
  cfg: JSON.parse(localStorage.getItem(LS_CFG) || '{}'),
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
    await saveLibrary(`Remove from library: ${t.title}`);
    renderAll();
    toast('削除しました');
  } catch (e) {
    toast('削除に失敗: ' + e.message, 4000);
  }
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
  return `
    <div class="item ${playing ? 'playing' : ''}" data-id="${esc(t.id)}">
      <div class="thumb">${typeIcon(t)}</div>
      <div class="meta" data-act="play">
        <div class="title">${esc(t.title)}</div>
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
  openModal(`
    <h3>${esc(t.title)}</h3>
    <div class="modal-list">
      <button data-m="tags">🏷 タグを編集</button>
      <button data-m="addpl">🗂 プレイリストに追加</button>
      <button data-m="delete" class="danger">🗑 削除</button>
    </div>`);
  $('#modal-body').onclick = (e) => {
    const m = e.target.dataset.m;
    if (m === 'tags') openTagEditor(id);
    if (m === 'addpl') openAddToPlaylist(id);
    if (m === 'delete') { closeModal(); deleteTrack(id); }
  };
}

function openTagEditor(id) {
  const t = trackById(id);
  openModal(`
    <h3>タグを編集</h3>
    <p class="note">${esc(t.title)}</p>
    <div class="form">
      <input type="text" id="tag-input" value="${esc((t.tags || []).join(', '))}" placeholder="例: J-POP, 作業用, お気に入り">
      <p class="note">カンマ区切りで入力</p>
      <button class="primary wide" id="tag-save">保存</button>
    </div>`);
  $('#tag-save').onclick = async () => {
    const tags = $('#tag-input').value.split(/[,、]/).map((s) => s.trim()).filter(Boolean);
    closeModal();
    await setTrackTags(id, tags);
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
async function triggerDownload() {
  const url = $('#dl-url').value.trim();
  const format = $('#dl-format').value;
  const tags = $('#dl-tags').value.trim();
  if (!url) { toast('URLを入力してください'); return; }
  if (!cfgOk()) { toast('設定タブでGitHub情報を入力してください', 4000); return; }
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

  // 設定
  $('#btn-save-cfg').addEventListener('click', saveCfg);

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

  player.addEventListener('ended', () => next(true));
  player.addEventListener('play', updatePlayBtn);
  player.addEventListener('pause', updatePlayBtn);
  player.addEventListener('timeupdate', () => {
    $('#pb-cur').textContent = fmtTime(player.currentTime);
    $('#pb-dur').textContent = fmtTime(player.duration);
    if (!seek._dragging && isFinite(player.duration)) {
      seek.value = (player.currentTime / player.duration) * 100 || 0;
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
syncLibrary(true);

'use strict';

const state = {
  dir: '',
  status: null,
  auto: true,
  timer: null,
  loading: true,
};

const picker = { dir: '' };

const ICONS = {
  chevron: '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
  folder: '<svg class="folder" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>',
  file: '<svg class="file" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3v5h5"/><path d="M19 21V8l-5-5H6a1 1 0 0 0-1 1v17a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1Z"/></svg>',
  branch: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
};

const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function api(url, options) {
  try {
    const res = await fetch(url, options);
    return await res.json();
  } catch (error) {
    return { ok: false, error: `请求失败: ${error.message}` };
  }
}

function fmtSize(bytes) {
  if (bytes == null) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${index > 0 && value < 10 ? value.toFixed(1) : Math.round(value)}${units[index]}`;
}

function clock(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function shortDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso || '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function relTime(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const minutes = Math.floor((Date.now() - then) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}

/* ---------- 文件树 ---------- */

function rowHtml(entry, depth) {
  const pad = 8 + depth * 14;
  if (entry.isDir) {
    return `<div class="tree-row dir" data-dir="${esc(entry.path)}" style="padding-left:${pad}px">
      ${ICONS.chevron}${ICONS.folder}
      <span class="tree-name">${esc(entry.name)}</span>
      ${entry.isRepo ? '<span class="repo-tag">git</span>' : ''}
    </div><div class="tree-children" hidden></div>`;
  }
  return `<div class="tree-row file" style="padding-left:${pad}px">
    <span class="chev"></span>${ICONS.file}
    <span class="tree-name">${esc(entry.name)}</span>
    <span class="tree-meta">${entry.size == null ? '' : fmtSize(entry.size)}</span>
  </div>`;
}

async function renderChildren(container, dir, depth) {
  const data = await api(`/api/tree?dir=${encodeURIComponent(dir)}`);
  if (!data.ok) {
    container.innerHTML = `<div class="tree-empty" style="padding-left:${8 + depth * 14}px">${esc(data.error || '无法读取目录')}</div>`;
    return;
  }
  if (!data.entries.length) {
    container.innerHTML = `<div class="tree-empty" style="padding-left:${8 + depth * 14 + 26}px">空文件夹</div>`;
    return;
  }
  container.innerHTML = data.entries.map((entry) => rowHtml(entry, depth)).join('');
}

async function loadTree() {
  const tree = $('tree');
  tree.innerHTML = '<div class="tree-loading">正在读取文件列表…</div>';
  await renderChildren(tree, state.dir, 0);
}

$('tree').addEventListener('click', async (event) => {
  const row = event.target.closest('.tree-row.dir');
  if (!row) return;

  const holder = row.nextElementSibling;
  if (!holder) return;

  const opening = holder.hidden;
  holder.hidden = !opening;
  row.classList.toggle('open', opening);

  if (opening && !holder.dataset.loaded) {
    const depth = Math.round((Number.parseInt(row.style.paddingLeft, 10) - 8) / 14) + 1;
    await renderChildren(holder, row.dataset.dir, depth);
    holder.dataset.loaded = '1';
  }
});

/* ---------- Git 面板渲染 ---------- */

function notRepoHtml() {
  return `<div class="empty-state">
    <div class="empty-icon">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3v5h5"/><path d="M19 21V8l-5-5H6a1 1 0 0 0-1 1v17a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1Z"/></svg>
    </div>
    <h2>尚未初始化 Git</h2>
    <p class="empty-desc">这个项目还没有 Git 仓库。初始化后，这里会展示分支、提交摘要、变更。</p>
    <div class="agent-note">
      <span class="agent-tag">对 Agent 说</span>
      <p>帮我初始化这个项目的 Git。</p>
    </div>
    <button class="primary-btn" id="btnInit" type="button">${ICONS.plus}初始化 Git</button>
  </div>`;
}

function invalidDirHtml(message) {
  return `<div class="empty-state">
    <div class="empty-icon">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>
    </div>
    <h2>找不到这个目录</h2>
    <p class="empty-desc">${esc(message || '请换一个存在的项目目录。')}</p>
    <p class="path-echo">${esc(state.dir || '（未指定）')}</p>
    <button class="primary-btn" id="btnPickDir" type="button">选择目录</button>
  </div>`;
}

function fileRow(item) {
  const code = item.code || '?';
  const tone = code === '?' ? 'Q' : code;
  return `<div class="file-row">
    <span class="file-badge badge-${esc(tone)}">${esc(code)}</span>
    <span class="file-path" title="${esc(item.path)}">${esc(item.path)}</span>
  </div>`;
}

function sectionHtml(title, items) {
  if (!items.length) return '';
  const shown = items.slice(0, 40);
  return `<div class="section">
    <div class="section-head"><b>${esc(title)}</b><span>${items.length} 个文件</span></div>
    ${shown.map(fileRow).join('')}
    ${items.length > shown.length ? `<div class="more-line">还有 ${items.length - shown.length} 项未显示</div>` : ''}
  </div>`;
}

function repoHtml(status) {
  const tone = (count, cls) => (count > 0 ? cls : '');
  const stats = [
    { label: '提交总数', value: status.commitCount == null ? '—' : status.commitCount },
    { label: '已暂存', value: status.staged.length, cls: tone(status.staged.length, 'is-staged') },
    { label: '未暂存', value: status.unstaged.length, cls: tone(status.unstaged.length, 'is-unstaged') },
    { label: '未跟踪', value: status.untracked.length },
    { label: '冲突文件', value: status.conflicted.length, cls: tone(status.conflicted.length, 'is-conflict') },
    { label: '贮藏条目', value: status.stashCount },
  ];

  const chips = [
    `<span class="chip branch">${ICONS.branch}${esc(status.branch)}</span>`,
    status.upstream
      ? `<span class="chip muted">${esc(status.upstream)}</span>`
      : '<span class="chip muted">未设置远程跟踪</span>',
    status.ahead ? `<span class="chip sync">领先 ${status.ahead}</span>` : '',
    status.behind ? `<span class="chip sync">落后 ${status.behind}</span>` : '',
    status.detached ? '<span class="chip warn">分离头指针</span>' : '',
  ].filter(Boolean).join('');

  const commit = status.lastCommit
    ? `<div class="commit-card">
        <div class="commit-subject">${esc(status.lastCommit.subject)}</div>
        <div class="commit-meta">
          <span class="hash">${esc(status.lastCommit.short)}</span>
          <span>${esc(status.lastCommit.author)}</span>
          <span>${esc(shortDate(status.lastCommit.committedAt))}</span>
          <span>${esc(relTime(status.lastCommit.committedAt))}</span>
        </div>
      </div>`
    : '<p class="hint-line">这个仓库还没有任何提交记录。</p>';

  const remotes = status.remotes.length
    ? `<div class="section">
        <div class="section-head"><b>远程仓库</b><span>${status.remotes.length}</span></div>
        ${status.remotes.map((remote) => `<div class="file-row">
          <span class="file-badge ${remote.kind === 'push' ? 'badge-M' : 'badge-R'}">${remote.kind === 'push' ? '↑' : '↓'}</span>
          <span class="file-path" title="${esc(remote.url)}">${esc(remote.name)}  ${esc(remote.url)}</span>
        </div>`).join('')}
      </div>`
    : '';

  return `<div class="chip-row">${chips}</div>
    <div class="stat-grid">
      ${stats.map((stat) => `<div class="stat ${stat.cls || ''}">
        <div class="stat-value">${esc(stat.value)}</div>
        <div class="stat-label">${esc(stat.label)}</div>
      </div>`).join('')}
    </div>
    ${commit}
    ${status.statusError ? `<div class="error-box" style="margin-top:16px">${esc(status.statusError)}</div>` : ''}
    ${sectionHtml('冲突文件', status.conflicted)}
    ${sectionHtml('已暂存的变更', status.staged)}
    ${sectionHtml('未暂存的变更', status.unstaged)}
    ${sectionHtml('未跟踪的文件', status.untracked)}
    ${remotes}`;
}

function updateHeader() {
  const status = state.status;
  const name = (status && status.repoName) || (state.dir ? state.dir.split(/[\\/]/).filter(Boolean).pop() : '—');
  $('repoName').textContent = name || '—';
  $('repoSub').textContent = status && status.isRepo ? status.repoRoot : '工作区实时预览';
  $('workspacePath').textContent = state.dir || '—';
  $('workspacePath').title = state.dir || '';
  $('liveDot').classList.toggle('idle', !state.auto);
}

function renderPanel() {
  const body = $('panelBody');
  const status = state.status;

  body.classList.remove('state-center');

  if (!status) {
    body.innerHTML = '<div class="hint-line">正在读取 Git 状态…</div>';
    return;
  }
  if (!status.ok) {
    body.classList.add('state-center');
    body.innerHTML = invalidDirHtml(status.error);
    const pick = $('btnPickDir');
    if (pick) pick.addEventListener('click', openPicker);
    return;
  }
  if (!status.isRepo) {
    body.classList.add('state-center');
    body.innerHTML = notRepoHtml();
    const button = $('btnInit');
    if (button) button.addEventListener('click', initRepo);
    return;
  }
  body.innerHTML = repoHtml(status);
}

/* ---------- 数据刷新 ---------- */

async function refreshStatus() {
  if (!state.dir) return;
  const button = $('btnRefresh');
  button.classList.add('spin');

  const status = await api(`/api/status?dir=${encodeURIComponent(state.dir)}`);
  state.status = status;
  state.loading = false;

  button.classList.remove('spin');
  $('stamp').textContent = `更新于 ${clock(new Date())}`;
  updateHeader();
  renderPanel();
}

async function refreshAll() {
  await Promise.all([refreshStatus(), loadTree()]);
}

async function initRepo() {
  const button = $('btnInit');
  if (button) {
    button.disabled = true;
    button.textContent = '正在初始化…';
  }

  const result = await api('/api/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir: state.dir }),
  });

  if (!result.ok) {
    const body = $('panelBody');
    body.insertAdjacentHTML('afterbegin', `<div class="error-box" style="margin-bottom:14px">初始化失败：${esc(result.error || '未知错误')}</div>`);
    if (button) {
      button.disabled = false;
      button.textContent = '重新尝试';
    }
    return;
  }

  await refreshAll();
}

/* ---------- 目录选择 ---------- */

async function browseTo(dir) {
  const data = await api(`/api/browse?dir=${encodeURIComponent(dir || '')}`);
  const list = $('pickerList');

  if (!data.ok) {
    list.innerHTML = `<div class="picker-empty">${esc(data.error || '无法读取该目录')}</div>`;
    return;
  }

  picker.dir = data.dir || '';
  $('pickerInput').value = picker.dir;
  $('pickerUp').disabled = !data.parent;
  $('pickerUp').dataset.parent = data.parent || '';

  if (!data.entries.length) {
    list.innerHTML = '<div class="picker-empty">这个位置没有子文件夹</div>';
    return;
  }

  list.innerHTML = data.entries
    .map((entry) => `<div class="picker-row" data-dir="${esc(entry.path)}">
      ${ICONS.folder}
      <span class="tree-name">${esc(entry.name)}</span>
      ${entry.isRepo ? '<span class="repo-tag">git</span>' : ''}
    </div>`)
    .join('');
}

function openPicker() {
  $('modal').hidden = false;
  browseTo(state.dir);
}

function closePicker() {
  $('modal').hidden = true;
}

$('btnPick').addEventListener('click', openPicker);
$('btnTree').addEventListener('click', loadTree);
$('btnRefresh').addEventListener('click', refreshAll);
$('modalClose').addEventListener('click', closePicker);

$('modal').addEventListener('click', (event) => {
  if (event.target === $('modal')) closePicker();
});

$('pickerList').addEventListener('click', (event) => {
  const row = event.target.closest('.picker-row');
  if (row) browseTo(row.dataset.dir);
});

$('pickerUp').addEventListener('click', (event) => {
  browseTo(event.currentTarget.dataset.parent || '');
});

$('pickerDrives').addEventListener('click', () => browseTo(''));

$('pickerGo').addEventListener('click', () => browseTo($('pickerInput').value.trim()));

$('pickerInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') browseTo($('pickerInput').value.trim());
});

$('pickerChoose').addEventListener('click', async () => {
  if (!picker.dir) return;
  state.dir = picker.dir;
  const url = new URL(window.location.href);
  url.searchParams.set('dir', picker.dir);
  window.history.replaceState({}, '', url);
  closePicker();
  await refreshAll();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('modal').hidden) closePicker();
});

/* ---------- 主题 ---------- */

const THEME_KEY = 'git-live-theme';

function applyTheme(theme) {
  const dark = theme === 'dark';
  const toggle = $('themeToggle');

  if (dark) document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');

  const label = dark ? '切换到浅色主题' : '切换到深色主题';
  toggle.title = label;
  toggle.setAttribute('aria-label', label);
  toggle.setAttribute('aria-pressed', String(dark));
}

function storedTheme() {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

$('themeToggle').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // 隐私模式下 localStorage 可能不可用，主题只在本次会话生效
  }
  applyTheme(next);
});

applyTheme(storedTheme());

$('autoToggle').addEventListener('change', (event) => {
  state.auto = event.target.checked;
  updateHeader();
  if (state.auto) {
    refreshStatus();
    startTimer();
  } else {
    clearInterval(state.timer);
    state.timer = null;
  }
});

function startTimer() {
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    if (state.auto && !document.hidden && $('modal').hidden) refreshStatus();
  }, 3000);
}

async function boot() {
  const fromUrl = new URLSearchParams(window.location.search).get('dir');
  if (fromUrl) {
    state.dir = fromUrl;
  } else {
    const info = await api('/api/default');
    state.dir = info.dir || '';
  }
  await refreshAll();
  startTimer();
}

boot();

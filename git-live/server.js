'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

const HOST = '127.0.0.1';
const BASE_PORT = Number(process.env.PORT) || 63138;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_DIR = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const MAX_ITEMS = 400;
const IGNORED_IN_TREE = new Set(['.git', 'node_modules', '__pycache__', '.cache', '.venv', 'venv']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const CHANGE_LABELS = {
  M: '已修改',
  A: '新增',
  D: '已删除',
  R: '重命名',
  C: '已复制',
  T: '类型变更',
  U: '冲突',
  '?': '未跟踪',
};

function runGit(args, cwd) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, windowsHide: true, timeout: 20000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: (stderr && String(stderr).trim()) || (err ? String(err.message) : ''),
        });
      },
    );
  });
}

function parsePorcelainV2(raw) {
  const tokens = raw.split('\0');
  const staged = [];
  const unstaged = [];
  const untracked = [];
  const conflicted = [];
  const info = { branch: null, oid: null, upstream: null, ahead: 0, behind: 0, ignored: 0 };

  const add = (xy, filePath) => {
    const x = xy[0];
    const y = xy[1];
    if (x && x !== '.') staged.push({ path: filePath, code: x, label: CHANGE_LABELS[x] || '已变更' });
    if (y && y !== '.') unstaged.push({ path: filePath, code: y, label: CHANGE_LABELS[y] || '已变更' });
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;

    if (token.startsWith('# ')) {
      const [, key, ...rest] = token.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') info.oid = value;
      else if (key === 'branch.head') info.branch = value;
      else if (key === 'branch.upstream') info.upstream = value;
      else if (key === 'branch.ab') {
        const match = /\+(\d+)\s+-(\d+)/.exec(value);
        if (match) {
          info.ahead = Number(match[1]);
          info.behind = Number(match[2]);
        }
      }
      continue;
    }

    const kind = token[0];
    if (kind === '1') {
      const parts = token.split(' ');
      add(parts[1] || '..', parts.slice(8).join(' '));
    } else if (kind === '2') {
      const parts = token.split(' ');
      i += 1; // 下一个 token 是重命名/复制前的原路径
      add(parts[1] || '..', parts.slice(9).join(' '));
    } else if (kind === 'u') {
      const parts = token.split(' ');
      conflicted.push({ path: parts.slice(10).join(' '), code: parts[1] || 'UU', label: '冲突' });
    } else if (kind === '?') {
      untracked.push({ path: token.slice(2), code: '?', label: '未跟踪' });
    } else if (kind === '!') {
      info.ignored += 1;
    }
  }

  return { ...info, staged, unstaged, untracked, conflicted };
}

async function collectStatus(dir) {
  const stat = await fsp.stat(dir).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    return { ok: false, isRepo: false, dir, error: '目录不存在或无法访问' };
  }

  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], dir);
  const isRepo = inside.ok && inside.stdout.trim() === 'true';
  const base = {
    ok: true,
    dir,
    isRepo,
    repoName: path.basename(dir) || dir,
    updatedAt: new Date().toISOString(),
  };
  if (!isRepo) return base;

  const top = await runGit(['rev-parse', '--show-toplevel'], dir);
  const root = (top.stdout || '').trim() || dir;

  const status = await runGit(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], root);
  const parsed = parsePorcelainV2(status.stdout);
  const hasCommits = Boolean(parsed.oid) && parsed.oid !== '(initial)';

  let branch = parsed.branch || 'HEAD';
  const detached = branch === '(detached)';
  if (detached) branch = 'HEAD (分离)';

  const result = {
    ...base,
    isRepo: true,
    repoRoot: root,
    repoName: path.basename(root) || root,
    branch,
    detached,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    hasCommits,
    staged: parsed.staged,
    unstaged: parsed.unstaged,
    untracked: parsed.untracked,
    conflicted: parsed.conflicted,
    ignored: parsed.ignored,
    lastCommit: null,
    commitCount: null,
    stashCount: 0,
    remotes: [],
    statusError: status.ok ? null : status.stderr,
  };

  if (hasCommits) {
    const log = await runGit(['log', '-1', '--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ar%x1f%cI%x1f%s'], root);
    const fields = log.stdout.split('\x1f');
    if (fields.length >= 7) {
      result.lastCommit = {
        hash: fields[0],
        short: fields[1],
        author: fields[2],
        email: fields[3],
        relative: fields[4],
        committedAt: fields[5],
        subject: fields[6],
      };
    }
    const count = await runGit(['rev-list', '--count', 'HEAD'], root);
    if (count.ok) result.commitCount = Number(count.stdout.trim()) || 0;
  }

  const stash = await runGit(['stash', 'list'], root);
  if (stash.ok) result.stashCount = stash.stdout.split('\n').filter((line) => line.trim()).length;

  const remotes = await runGit(['remote', '-v'], root);
  if (remotes.ok) {
    const byRemote = new Map();
    for (const line of remotes.stdout.split('\n')) {
      const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
      if (!match) continue;
      const [, name, url, kind] = match;
      if (!byRemote.has(name)) byRemote.set(name, { name, fetch: null, push: null });
      byRemote.get(name)[kind] = url;
    }
    for (const remote of byRemote.values()) {
      if (remote.fetch) result.remotes.push({ name: remote.name, url: remote.fetch, kind: 'fetch' });
      // 只有推送地址和拉取地址不同才额外列一条
      if (remote.push && remote.push !== remote.fetch) {
        result.remotes.push({ name: remote.name, url: remote.push, kind: 'push' });
      }
    }
  }

  return result;
}

async function listChildren(dir) {
  const stat = await fsp.stat(dir).catch(() => null);
  if (!stat || !stat.isDirectory()) return { ok: false, error: '目录不存在或无法访问', dir };

  const raw = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const entries = raw
    .filter((entry) => !IGNORED_IN_TREE.has(entry.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh-Hans-CN'));

  const items = [];
  for (const entry of entries.slice(0, MAX_ITEMS)) {
    const full = path.join(dir, entry.name);
    let size = null;
    if (!entry.isDirectory()) {
      const info = await fsp.stat(full).catch(() => null);
      size = info ? info.size : null;
    }
    items.push({
      name: entry.name,
      path: full,
      isDir: entry.isDirectory(),
      size,
      isRepo: entry.isDirectory() ? fs.existsSync(path.join(full, '.git')) : false,
    });
  }
  return { ok: true, dir, entries: items, total: entries.length, truncated: entries.length > MAX_ITEMS };
}

async function browse(rawDir) {
  if (!rawDir) {
    const drives = [];
    for (let code = 65; code <= 90; code += 1) {
      const letter = `${String.fromCharCode(code)}:`;
      const target = `${letter}\\`;
      if (fs.existsSync(target)) drives.push({ name: letter, path: target, isDir: true, isRepo: false });
    }
    return { ok: true, dir: '', parent: null, entries: drives, drives: true };
  }

  const dir = path.resolve(rawDir);
  const stat = await fsp.stat(dir).catch(() => null);
  if (!stat || !stat.isDirectory()) return { ok: false, error: '目录不存在或无法访问', dir };

  const raw = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const dirs = raw.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  const parent = path.dirname(dir);

  return {
    ok: true,
    dir,
    parent: parent === dir ? '' : parent,
    entries: dirs.slice(0, MAX_ITEMS).map((entry) => {
      const full = path.join(dir, entry.name);
      return { name: entry.name, path: full, isDir: true, isRepo: fs.existsSync(path.join(full, '.git')) };
    }),
  };
}

async function initRepo(dir) {
  const stat = await fsp.stat(dir).catch(() => null);
  if (!stat || !stat.isDirectory()) return { ok: false, error: '目录不存在或无法访问' };

  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], dir);
  if (inside.ok && inside.stdout.trim() === 'true') {
    const top = await runGit(['rev-parse', '--show-toplevel'], dir);
    return { ok: true, already: true, root: (top.stdout || '').trim() || dir, message: '该目录已经在 Git 仓库中' };
  }

  const result = await runGit(['init', '-b', 'main'], dir);
  return {
    ok: result.ok,
    already: false,
    output: `${result.stdout}${result.stderr}`.trim(),
    error: result.ok ? null : result.stderr || 'git init 执行失败',
  };
}

/* ---------- 提交历史 ---------- */

const COMMIT_LIMIT = 80;
const HASH_RE = /^[0-9a-fA-F]{7,40}$/;

const FILE_LABELS = {
  A: '新增',
  M: '修改',
  D: '删除',
  R: '重命名',
  C: '复制',
  T: '类型变更',
  U: '冲突',
};

function parseRefs(raw, localBranches, remotes) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      if (part.startsWith('tag: ')) return { name: part.slice(5), head: false, kind: 'tag' };
      if (part.startsWith('HEAD -> ')) return { name: part.slice(8), head: true, kind: 'branch' };
      if (part === 'HEAD') return { name: 'HEAD', head: true, kind: 'head' };
      if (!localBranches.has(part) && remotes.some((r) => part.startsWith(`${r}/`))) {
        return { name: part, head: false, kind: 'remote' };
      }
      return { name: part, head: false, kind: localBranches.has(part) ? 'branch' : 'ref' };
    });
}

async function refContext(dir) {
  const branches = await runGit(['branch', '--format=%(refname:short)'], dir);
  const remotes = await runGit(['remote'], dir);
  return {
    localBranches: new Set(branches.stdout.split('\n').map((s) => s.trim()).filter(Boolean)),
    remotes: remotes.stdout.split('\n').map((s) => s.trim()).filter(Boolean),
  };
}

async function collectCommits(dir, limit) {
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], dir);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return { ok: true, isRepo: false, commits: [], total: 0 };
  }

  const fmt = '%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%cI%x1f%ar%x1f%D%x1f%s';
  const log = await runGit(['log', `--max-count=${limit}`, '--date-order', `--pretty=format:${fmt}`], dir);
  if (!log.ok) {
    return { ok: true, isRepo: true, commits: [], total: 0, empty: true };
  }

  const { localBranches, remotes } = await refContext(dir);
  const commits = log.stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const fields = line.split('\x1f');
      const parents = (fields[2] || '').trim();
      return {
        hash: fields[0],
        short: fields[1],
        parents: parents ? parents.split(/\s+/) : [],
        author: fields[3],
        email: fields[4],
        date: fields[5],
        relative: fields[6],
        refs: parseRefs(fields[7], localBranches, remotes),
        subject: fields[8] || '',
      };
    });

  const count = await runGit(['rev-list', '--count', 'HEAD'], dir);
  return {
    ok: true,
    isRepo: true,
    commits,
    total: count.ok ? Number(count.stdout.trim()) || commits.length : commits.length,
    limit,
  };
}

function parseNameStatus(raw) {
  const files = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = (parts[0] || 'M')[0];
    // 重命名/复制会多出一列原路径，取最后一列作为当前路径
    const filePath = parts.length > 2 ? parts[parts.length - 1] : parts[1];
    files.push({ path: filePath || '', code, label: FILE_LABELS[code] || '变更' });
  }
  return files;
}

function parseNumstat(raw) {
  const map = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const added = Number.parseInt(parts[0], 10);
    const deleted = Number.parseInt(parts[1], 10);
    map.set(parts[parts.length - 1] || '', {
      added: Number.isNaN(added) ? 0 : added,
      deleted: Number.isNaN(deleted) ? 0 : deleted,
    });
  }
  return map;
}

// 合并提交用 diff-tree 拿不到内容，退回与第一父比较
async function changedFiles(dir, hash, isMerge, mode) {
  const direct = await runGit(['diff-tree', '-r', '--no-commit-id', `--${mode}`, '--root', hash], dir);
  if (!isMerge || direct.stdout.trim()) return direct.stdout;
  const fallback = await runGit(['diff', `--${mode}`, `${hash}^1`, hash], dir);
  return fallback.stdout;
}

async function collectCommitDetail(dir, hash) {
  if (!HASH_RE.test(hash)) return { ok: false, error: '提交哈希格式不正确' };

  const fmt = '%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%cI%x1f%ar%x1f%D%x1f%s%x1f%b';
  const meta = await runGit(['log', '-1', `--pretty=format:${fmt}`, hash], dir);
  if (!meta.ok || !meta.stdout.trim()) {
    return { ok: false, error: meta.stderr || '找不到这个提交' };
  }

  const fields = meta.stdout.split('\x1f');
  const parents = (fields[2] || '').trim();
  const parentList = parents ? parents.split(/\s+/) : [];
  const isMerge = parentList.length > 1;

  const statusOut = await changedFiles(dir, hash, isMerge, 'name-status');
  const numstatOut = await changedFiles(dir, hash, isMerge, 'numstat');
  const stats = parseNumstat(numstatOut);

  const files = parseNameStatus(statusOut).map((file) => {
    const stat = stats.get(file.path) || { added: 0, deleted: 0 };
    return { ...file, added: stat.added, deleted: stat.deleted };
  });

  return {
    ok: true,
    root: (await runGit(['rev-parse', '--show-toplevel'], dir)).stdout.trim() || dir,
    hash: fields[0],
    short: fields[1],
    parents: parentList,
    author: fields[3],
    email: fields[4],
    date: fields[5],
    relative: fields[6],
    refs: parseRefs(fields[7], new Set(), []),
    subject: fields[8] || '',
    body: (fields[9] || '').trim(),
    isMerge,
    files,
    filesChanged: files.length,
    insertions: files.reduce((sum, file) => sum + file.added, 0),
    deletions: files.reduce((sum, file) => sum + file.deleted, 0),
  };
}

function sendJson(res, payload, code = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendText(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^[/\\]+/, '');
  const target = path.join(PUBLIC_DIR, rel);
  if (!target.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Forbidden');

  const data = await fsp.readFile(target).catch(() => null);
  if (!data) return sendText(res, 404, 'Not Found');

  res.writeHead(200, {
    'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  const dirParam = url.searchParams.get('dir');
  const target = dirParam ? path.resolve(dirParam) : DEFAULT_DIR;

  try {
    if (url.pathname === '/api/status') return sendJson(res, await collectStatus(target));
    if (url.pathname === '/api/tree') return sendJson(res, await listChildren(target));
    if (url.pathname === '/api/browse') return sendJson(res, await browse(dirParam));
    if (url.pathname === '/api/default') return sendJson(res, { ok: true, dir: DEFAULT_DIR });
    if (url.pathname === '/api/commits') {
      const raw = Number(url.searchParams.get('limit')) || COMMIT_LIMIT;
      const limit = Math.min(Math.max(raw, 1), 200);
      return sendJson(res, await collectCommits(target, limit));
    }
    if (url.pathname === '/api/commit') {
      return sendJson(res, await collectCommitDetail(target, url.searchParams.get('hash') || ''));
    }
    if (url.pathname === '/api/init' && req.method === 'POST') {
      const body = await readBody(req);
      const initTarget = body.dir ? path.resolve(body.dir) : DEFAULT_DIR;
      return sendJson(res, await initRepo(initTarget));
    }
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    return serveStatic(url.pathname, res);
  } catch (error) {
    return sendJson(res, { ok: false, error: String((error && error.message) || error) }, 500);
  }
});

function listen(port, attempt = 0) {
  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE' && attempt < 20) {
      listen(port + 1, attempt + 1);
      return;
    }
    console.error(`启动失败: ${error.message}`);
    process.exit(1);
  });

  server.listen(port, HOST, () => {
    console.log('Git 实时状态面板已启动');
    console.log(`  地址: http://${HOST}:${port}`);
    console.log(`  监控目录: ${DEFAULT_DIR}`);
  });
}

listen(BASE_PORT);

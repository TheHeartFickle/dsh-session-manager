// dsh-session-manager — rewind host half.
//
// 工作区级 shadow git：
// - 每个工作区（cwd）一个 shadow 仓库，路径 ~/.dsh/session-manager/snapshots/<workspace-hash>/；
// - refs/heads/workspace 是共享主线，记录整个工作区的真实状态；
// - 每个会话是 refs/heads/session/<session-id> 分支，指向该会话最近一次快照；
// - 所有会话的快照都提交到同一条 workspace 主线上，实现跨会话进度同步；
// - 回退时先 safety commit，再 reset 到目标快照，并创建一个 rewind commit 接回主线。
//
// 如果 git 不可用或没有快照，自动降级到 best-effort 文件回退。
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const name = 'dsh-session-manager/rewind';

// 公共 ignore 文件：由 profile 的 cordis.patch.yml 通过 config.rewindIgnoreFile 指定，
// 叠加到工作区自身 .gitignore 之上，防止工作区没有任何 ignore 规则时把
// node_modules 等目录也快照进去。
let commonIgnoreFile = null;

// 回退时的文件行为：
// - git：Git shadow 快照优先，Git 不可用/无快照时兜底为文件读写回退（默认，保持现状）；
// - diff：只使用文件读写回退，不创建 shadow git 快照；
// - none：不启用文件回退，回退时只回退会话。
const REWIND_FILE_MODES = new Set(['git', 'diff', 'none']);
let rewindFileMode = 'git';

function resolveCommonIgnore(ctx, config) {
  const value = config && (config.rewindIgnoreFile || '');
  if (!value) return null;
  if (path.isAbsolute(value)) return value;
  try {
    const base = ctx?.baseUrl ? fileURLToPath(ctx.baseUrl) : process.cwd();
    return path.resolve(base, value);
  } catch {
    return path.resolve(process.cwd(), value);
  }
}

let gitChecked = false;
let gitOk = false;
async function isGitAvailable() {
  if (gitChecked) return gitOk;
  try {
    await execFileAsync('git', ['--version'], { windowsHide: true });
    gitOk = true;
  } catch {
    gitOk = false;
  }
  gitChecked = true;
  return gitOk;
}

function isGitAvailableSync() {
  if (gitChecked) return gitOk;
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    gitOk = true;
  } catch {
    gitOk = false;
  }
  gitChecked = true;
  return gitOk;
}

function safeSessionId(sessionId) {
  return String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function workspaceKey(cwd) {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

function shadowDirFor(workspaceKeyValue) {
  return path.join(os.homedir(), '.dsh', 'session-manager', 'snapshots', workspaceKeyValue);
}

function shadowIgnoreRel(cwd) {
  // 如果 shadow 仓库位于当前工作区内部（例如项目根目录是用户主目录），
  // 必须把它排除在 git add 之外，否则会把 ~/.dsh/session-manager 自身
  // 当成普通文件/子仓库跟踪进去，造成递归快照。
  const root = path.join(os.homedir(), '.dsh', 'session-manager', 'snapshots');
  const rel = path.relative(cwd, root);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function shadowIgnorePattern(cwd) {
  const rel = shadowIgnoreRel(cwd);
  return rel ? `${rel}/` : null;
}

async function ensureShadowIgnored(shadowDir, cwd) {
  const rel = shadowIgnoreRel(cwd);
  if (!rel) return;
  const pattern = `${rel}/`;
  const excludeFile = path.join(shadowDir, '.git', 'info', 'exclude');
  let existing = '';
  try {
    existing = await readFile(excludeFile, 'utf8');
  } catch {
    // no exclude file yet
  }
  if (!existing.split(/\r?\n/).some((line) => line.trim() === pattern.trim())) {
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    await writeFile(excludeFile, `${existing}${sep}${pattern}\n`, 'utf8');
  }
  // 清理之前不小心被跟踪进 shadow git 的快照元数据文件。
  await git(shadowDir, cwd, ['rm', '-r', '--cached', '--ignore-unmatch', '--', rel]);
}

function sessionBranch(sessionId) {
  return `refs/heads/session/${safeSessionId(sessionId)}`;
}

const MAINLINE = 'refs/heads/workspace';

// ── async git helpers ───────────────────────────────────────────────
async function git(shadowDir, workTree, args) {
  const fullArgs = [
    '--git-dir', path.join(shadowDir, '.git'),
    '--work-tree', workTree,
  ];
  if (commonIgnoreFile) {
    fullArgs.push('-c', `core.excludesFile=${commonIgnoreFile}`);
  }
  fullArgs.push(...args);
  const { stdout } = await execFileAsync('git', fullArgs, {
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout.trim();
}

async function ensureShadowRepo(workspaceKeyValue, cwd) {
  const shadowDir = shadowDirFor(workspaceKeyValue);
  await mkdir(shadowDir, { recursive: true });
  try {
    await execFileAsync('git', ['--git-dir', path.join(shadowDir, '.git'), '--work-tree', cwd, 'rev-parse', '--git-dir'], { windowsHide: true });
  } catch {
    await execFileAsync('git', ['init', '-q', shadowDir], { windowsHide: true });
  }
  await ensureShadowIgnored(shadowDir, cwd);
  return shadowDir;
}

async function readSnapshots(shadowDir) {
  try {
    return JSON.parse(await readFile(path.join(shadowDir, 'snapshots.json'), 'utf8'));
  } catch {
    return {};
  }
}

async function writeSnapshots(shadowDir, snapshots) {
  await writeFile(path.join(shadowDir, 'snapshots.json'), JSON.stringify(snapshots, null, 2), 'utf8');
}

async function revParseMainline(shadowDir, cwd) {
  try {
    return await git(shadowDir, cwd, ['rev-parse', '--verify', MAINLINE]);
  } catch {
    return null;
  }
}

async function createSnapshotCommit(shadowDir, cwd, sessionId, message) {
  const status = await git(shadowDir, cwd, ['status', '--porcelain']);
  const head = await revParseMainline(shadowDir, cwd);
  if (status === '' && head) {
    await git(shadowDir, cwd, ['update-ref', sessionBranch(sessionId), head]);
    return head;
  }

  await git(shadowDir, cwd, ['add', '-A']);
  const tree = await git(shadowDir, cwd, ['write-tree']);
  const parentArgs = head ? ['-p', head] : [];
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'dsh-session-manager',
    GIT_AUTHOR_EMAIL: 'dsh-session-manager@local',
    GIT_COMMITTER_NAME: 'dsh-session-manager',
    GIT_COMMITTER_EMAIL: 'dsh-session-manager@local',
  };
  const { stdout } = await execFileAsync('git', [
    '--git-dir', path.join(shadowDir, '.git'),
    '--work-tree', cwd,
    'commit-tree', tree,
    ...parentArgs,
    '-m', message,
  ], { env, windowsHide: true });
  const commit = stdout.trim();
  await git(shadowDir, cwd, ['update-ref', MAINLINE, commit]);
  await git(shadowDir, cwd, ['update-ref', sessionBranch(sessionId), commit]);
  return commit;
}

async function snapshotOne(session, event) {
  const cwd = session.header?.cwd;
  if (!cwd || rewindFileMode !== 'git' || !(await isGitAvailable())) return;
  const key = workspaceKey(cwd);
  const shadowDir = await ensureShadowRepo(key, cwd);
  const hash = await createSnapshotCommit(shadowDir, cwd, session.id, `snapshot ${session.id} turn/end ${event.seq}`);
  const snapshots = await readSnapshots(shadowDir);
  snapshots[session.id] ??= {};
  snapshots[session.id][event.seq] = hash;
  await writeSnapshots(shadowDir, snapshots);
}

const snapshotQueues = new Map();
function queueSnapshot(session, event) {
  const key = session.id;
  const previous = snapshotQueues.get(key) || Promise.resolve();
  const next = previous
    .then(() => snapshotOne(session, event))
    .catch((error) => {
      console.error('[dsh-session-manager] git snapshot failed:', error instanceof Error ? error.message : error);
    });
  snapshotQueues.set(key, next);
}

// ── 同步 git helpers（turn/start 使用）─────────────────────────────
const sseClients = new Set();
function broadcastSnapshot(sessionId, phase) {
  const payload = JSON.stringify({ type: 'snapshot', sessionId, phase });
  for (const res of sseClients) {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch {
      // ignore disconnected clients
    }
  }
}

function gitSync(shadowDir, workTree, args) {
  const fullArgs = [
    '--git-dir', path.join(shadowDir, '.git'),
    '--work-tree', workTree,
  ];
  if (commonIgnoreFile) {
    fullArgs.push('-c', `core.excludesFile=${commonIgnoreFile}`);
  }
  fullArgs.push(...args);
  return execFileSync('git', fullArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

function ensureShadowIgnoredSync(shadowDir, cwd) {
  const rel = shadowIgnoreRel(cwd);
  if (!rel) return;
  const pattern = `${rel}/`;
  const excludeFile = path.join(shadowDir, '.git', 'info', 'exclude');
  let existing = '';
  try {
    existing = readFileSync(excludeFile, 'utf8');
  } catch {
    // no exclude file yet
  }
  if (!existing.split(/\r?\n/).some((line) => line.trim() === pattern.trim())) {
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    writeFileSync(excludeFile, `${existing}${sep}${pattern}\n`, 'utf8');
  }
  // 清理之前不小心被跟踪进 shadow git 的快照元数据文件。
  gitSync(shadowDir, cwd, ['rm', '-r', '--cached', '--ignore-unmatch', '--', rel]);
}

function ensureShadowRepoSync(workspaceKeyValue, cwd) {
  const shadowDir = shadowDirFor(workspaceKeyValue);
  mkdirSync(shadowDir, { recursive: true });
  try {
    execFileSync('git', ['--git-dir', path.join(shadowDir, '.git'), '--work-tree', cwd, 'rev-parse', '--git-dir'], { stdio: 'ignore', windowsHide: true });
  } catch {
    execFileSync('git', ['init', '-q', shadowDir], { stdio: 'ignore', windowsHide: true });
  }
  ensureShadowIgnoredSync(shadowDir, cwd);
  return shadowDir;
}

function readSnapshotsSync(shadowDir) {
  try {
    return JSON.parse(readFileSync(path.join(shadowDir, 'snapshots.json'), 'utf8'));
  } catch {
    return {};
  }
}

function writeSnapshotsSync(shadowDir, snapshots) {
  writeFileSync(path.join(shadowDir, 'snapshots.json'), JSON.stringify(snapshots, null, 2), 'utf8');
}

function revParseMainlineSync(shadowDir, cwd) {
  try {
    return gitSync(shadowDir, cwd, ['rev-parse', '--verify', MAINLINE]);
  } catch {
    return null;
  }
}

function createSnapshotCommitSync(shadowDir, cwd, sessionId, message) {
  const status = gitSync(shadowDir, cwd, ['status', '--porcelain']);
  const head = revParseMainlineSync(shadowDir, cwd);
  if (status === '' && head) {
    gitSync(shadowDir, cwd, ['update-ref', sessionBranch(sessionId), head]);
    return head;
  }

  gitSync(shadowDir, cwd, ['add', '-A']);
  const tree = gitSync(shadowDir, cwd, ['write-tree']);
  const parentArgs = head ? ['-p', head] : [];
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'dsh-session-manager',
    GIT_AUTHOR_EMAIL: 'dsh-session-manager@local',
    GIT_COMMITTER_NAME: 'dsh-session-manager',
    GIT_COMMITTER_EMAIL: 'dsh-session-manager@local',
  };
  const commit = execFileSync('git', [
    '--git-dir', path.join(shadowDir, '.git'),
    '--work-tree', cwd,
    'commit-tree', tree,
    ...parentArgs,
    '-m', message,
  ], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
  gitSync(shadowDir, cwd, ['update-ref', MAINLINE, commit]);
  gitSync(shadowDir, cwd, ['update-ref', sessionBranch(sessionId), commit]);
  return commit;
}

function snapshotStartSync(session, event) {
  const cwd = session.header?.cwd;
  if (!cwd || rewindFileMode !== 'git' || !isGitAvailableSync()) return;
  const key = workspaceKey(cwd);
  const shadowDir = ensureShadowRepoSync(key, cwd);
  broadcastSnapshot(session.id, 'start');
  try {
    const hash = createSnapshotCommitSync(shadowDir, cwd, session.id, `snapshot ${session.id} turn/start ${event.seq}`);
    if (hash) {
      const snapshots = readSnapshotsSync(shadowDir);
      snapshots[session.id] ??= {};
      snapshots[session.id][event.seq] = hash;
      writeSnapshotsSync(shadowDir, snapshots);
    }
  } finally {
    broadcastSnapshot(session.id, 'end');
  }
}

export function applyRewind(ctx, config) {
  commonIgnoreFile = resolveCommonIgnore(ctx, config);
  const configuredMode = config && config.rewindFileMode;
  rewindFileMode = REWIND_FILE_MODES.has(configuredMode) ? configuredMode : 'git';
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  // ── best-effort 文件回退（无 git / 无快照时兜底）──────────────────────
  const contentText = (message) => {
    if (!message || !Array.isArray(message.content)) return '';
    return message.content
      .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .join('');
  };

  const resolvePath = (cwd, p) => (path.isAbsolute(p) ? p : path.resolve(cwd || process.cwd(), p));

  const collectFileOps = (session, atSeq) => {
    const events = session.events || [];
    const cwd = session.header?.cwd || process.cwd();
    const diffsByPath = new Map();
    const creates = new Set();
    const skipped = [];

    for (const event of events) {
      if (event.seq <= atSeq) continue;
      if (event.type !== 'tool/result') continue;
      const data = event.data;
      const meta = data?.meta;

      if (meta && Array.isArray(meta.diffs)) {
        for (const diff of meta.diffs) {
          if (!diff || typeof diff.path !== 'string') continue;
          const file = resolvePath(cwd, diff.path);
          if (typeof diff.oldText === 'string' && typeof diff.newText === 'string') {
            if (!diffsByPath.has(file)) diffsByPath.set(file, []);
            diffsByPath.get(file).push({
              oldText: diff.oldText,
              newText: diff.newText,
              seq: event.seq,
            });
          } else if (diff.oldText === null && typeof diff.newText === 'string') {
            skipped.push({ path: file, reason: 'pure-insertion-hunk' });
          }
        }
      }

      const text = contentText(data?.message);
      const created = /<path>([\s\S]*?)<\/path>\s*<type>file<\/type>\s*<content>\s*Created file\s*<\/content>/.exec(text);
      const updated = /<path>([\s\S]*?)<\/path>\s*<type>file<\/type>\s*<content>\s*Updated file\s*<\/content>/.exec(text);
      if (created) {
        creates.add(resolvePath(cwd, created[1].trim()));
      } else if (updated) {
        const file = resolvePath(cwd, updated[1].trim());
        if (!diffsByPath.has(file)) skipped.push({ path: file, reason: 'no-diff-meta' });
      }
    }

    return { diffsByPath, creates, skipped };
  };

  const rollbackBestEffort = async (session, atSeq) => {
    const { diffsByPath, creates, skipped } = collectFileOps(session, atSeq);
    const restored = [];
    const deleted = [];

    for (const [file, diffs] of diffsByPath) {
      diffs.sort((a, b) => b.seq - a.seq);
      let content;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        skipped.push({ path: file, reason: 'not-found' });
        continue;
      }

      let changed = false;
      for (const diff of diffs) {
        if (typeof diff.oldText !== 'string' || typeof diff.newText !== 'string') continue;
        const index = content.indexOf(diff.newText);
        if (index === -1) {
          skipped.push({ path: file, reason: 'hunk-not-found' });
          continue;
        }
        content = content.slice(0, index) + diff.oldText + content.slice(index + diff.newText.length);
        changed = true;
      }

      if (changed) {
        try {
          await writeFile(file, content, 'utf8');
          restored.push(file);
        } catch (error) {
          skipped.push({ path: file, reason: error instanceof Error ? error.message : String(error) });
        }
      }
    }

    for (const file of creates) {
      try {
        await rm(file, { force: true });
        deleted.push(file);
      } catch (error) {
        skipped.push({ path: file, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    return { restored, deleted, skipped };
  };

  // ── Git 级完整回滚（优先）──────────────────────────────────────────
  const rollbackWithGit = async (session, snapshotAtSeq, fallbackAtSeq) => {
    if (!(await isGitAvailable())) throw new Error('git-unavailable');
    const cwd = session.header?.cwd;
    if (!cwd) throw new Error('no-cwd');

    const key = workspaceKey(cwd);
    const shadowDir = await ensureShadowRepo(key, cwd);
    const snapshots = await readSnapshots(shadowDir);
    const sessionSnapshots = snapshots[session.id] || {};
    let usedSnapshotSeq = sessionSnapshots[snapshotAtSeq] ? snapshotAtSeq : fallbackAtSeq;
    if (usedSnapshotSeq === undefined || !sessionSnapshots[usedSnapshotSeq]) throw new Error('no-git-snapshot');
    const target = sessionSnapshots[usedSnapshotSeq];

    // 先把当前完整状态（含私有改动）提交到 workspace 主线，作为 safety commit。
    const safetyMessage = `safety before rewind ${session.id} ${new Date().toISOString()}`;
    const safetyCommit = await createSnapshotCommit(shadowDir, cwd, session.id, safetyMessage);
    const safetyRef = `refs/rewind/safety/${safeSessionId(session.id)}/${Date.now()}`;
    await git(shadowDir, cwd, ['update-ref', safetyRef, safetyCommit]);

    // 完整还原工作区到目标快照。
    await git(shadowDir, cwd, ['reset', '--hard', target]);

    // 创建一个 rewind commit 接回 workspace 主线，保留其他会话的历史可达。
    const targetTree = await git(shadowDir, cwd, ['rev-parse', `${target}^{tree}`]);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'dsh-session-manager',
      GIT_AUTHOR_EMAIL: 'dsh-session-manager@local',
      GIT_COMMITTER_NAME: 'dsh-session-manager',
      GIT_COMMITTER_EMAIL: 'dsh-session-manager@local',
    };
    const { stdout } = await execFileAsync('git', [
      '--git-dir', path.join(shadowDir, '.git'),
      '--work-tree', cwd,
      'commit-tree', targetTree,
      '-p', safetyCommit,
      '-m', `rewind ${session.id} to snapshot ${usedSnapshotSeq}`,
    ], { env, windowsHide: true });
    const rewindCommit = stdout.trim();
    await git(shadowDir, cwd, ['update-ref', MAINLINE, rewindCommit]);
    await git(shadowDir, cwd, ['update-ref', sessionBranch(session.id), rewindCommit]);

    return {
      mode: 'git',
      restored: [cwd],
      safetyRef,
      safetyCommit,
      snapshot: target,
      snapshotSeq: usedSnapshotSeq,
      rewindCommit,
    };
  };

  // ── 自动快照：turn/start 同步保存（精确回退点），turn/end 异步保存 ──
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      snapshotStartSync(session, event);
    } else if (event.type === 'turn/end') {
      queueSnapshot(session, event);
    }
  });

  const handleStatus = (req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  };

  const handleRollbackFiles = async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { ok: false, error: 'bad-json' });
      return;
    }

    const { sessionId, atSeq, snapshotAtSeq } = body || {};
    if (typeof sessionId !== 'string' || !Number.isSafeInteger(atSeq)) {
      json(res, 400, { ok: false, error: 'bad-request' });
      return;
    }
    const useSnapshotAtSeq = Number.isSafeInteger(snapshotAtSeq) ? snapshotAtSeq : atSeq;

    const sessions = ctx.get?.('sessions');
    if (!sessions) {
      json(res, 503, { ok: false, error: 'sessions-unavailable' });
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      json(res, 404, { ok: false, error: 'session-not-found' });
      return;
    }

    const boundaryEvent = session.events && session.events[atSeq];
    if (!boundaryEvent || boundaryEvent.seq !== atSeq || boundaryEvent.type !== 'turn/end') {
      json(res, 400, { ok: false, error: 'bad-boundary' });
      return;
    }
    if (useSnapshotAtSeq !== atSeq) {
      const snapshotEvent = session.events && session.events[useSnapshotAtSeq];
      if (!snapshotEvent || snapshotEvent.seq !== useSnapshotAtSeq || snapshotEvent.type !== 'turn/start') {
        json(res, 400, { ok: false, error: 'bad-snapshot-boundary' });
        return;
      }
    }

    // 等待可能还在进行的 turn/end 异步快照，避免 git 索引/锁冲突。
    const pendingSnapshot = snapshotQueues.get(sessionId);
    if (pendingSnapshot) {
      await pendingSnapshot.catch(() => {});
    }

    // 未启用文件回退时，禁止调用文件回退接口。
    if (rewindFileMode === 'none') {
      json(res, 409, { ok: false, error: 'file-rollback-disabled' });
      return;
    }

    // diff 模式：只使用文件读写回退，不走 Git。
    if (rewindFileMode === 'diff') {
      try {
        const result = await rollbackBestEffort(session, atSeq);
        json(res, 200, { ok: true, mode: 'diff', ...result });
      } catch (diffError) {
        json(res, 500, {
          ok: false,
          error: diffError instanceof Error ? diffError.message : String(diffError),
        });
      }
      return;
    }

    // git 模式（默认）：优先 Git 级完整回滚；git 不可用或没有快照时退回 best-effort。
    try {
      const result = await rollbackWithGit(session, useSnapshotAtSeq, atSeq);
      json(res, 200, { ok: true, ...result });
    } catch (gitError) {
      try {
        const result = await rollbackBestEffort(session, atSeq);
        json(res, 200, {
          ok: true,
          mode: 'best-effort',
          warning: gitError instanceof Error ? gitError.message : String(gitError),
          ...result,
        });
      } catch (diffError) {
        json(res, 500, {
          ok: false,
          error: diffError instanceof Error ? diffError.message : String(diffError),
          gitError: gitError instanceof Error ? gitError.message : String(gitError),
        });
      }
    }
  };

  return { handleStatus, handleRollbackFiles, getConfig: () => ({ rewindFileMode }) };
}

export { name };

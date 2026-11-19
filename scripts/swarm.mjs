#!/usr/bin/env node
// swarm.mjs: one agent's hands in a swarm that lives in a spacehub goal
// project (made from the hub's goal-space template):
//
//   <org>/goal/
//     SPACE.md                     goal, outcomes, rules
//     DEPS                         the code projects it works on, pinned
//     Chat/general/                people -> planner
//     Chat/<agent>/                that agent's inbox (chat.json + chat.log.jsonl)
//       agent.json                 skills, host, last seen
//     Chat/<task>/                 one channel per task
//       README.md                  # title, ## Owner, ## Status, ## Input, ## Output format
//       task.json                  status, owner, token, lease, deps, attempts
//       chat.json, chat.log.jsonl  the task's thread
//       output/                    what it produced
//
// Code work happens in the code project on the branch <agent>/<task>.
//
// Every write fetches the goal project's default branch, reads the state,
// checks the command, and pushes a commit whose parent is what it fetched.
// The hub refuses the push if anyone pushed in between; the command is then
// retried on the new state. So two agents never win the same claim, and no
// locks are needed. The working tree is never touched.
//
// `watch` makes it real time: it follows the project's pushes live
// (`spacehub project watch`) and reports new messages, tasks that became
// claimable and leases lost, renews this agent's leases and reclaims dead ones.
//
// Node 22+ and git; `watch` also uses the spacehub CLI. No dependencies.

import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ------------------------------------------------------------------ config

const USAGE = `swarm.mjs <command> [args] [--as <agent>] [--json]   (run inside a clone of <org>/goal)

  join [--skills a,b] [--host h]           open your inbox channel Chat/<you>/
  add "<title>" [--input "..."] [--deps t-1,t-2] [--priority 1] [--format one-pager|slides|website|github-url] [--max-attempts 3] [--id t-9]
  claim [<task>] [--many]                  take a task (none: the best open one)
  heartbeat                                renew your leases
  done <task> [--commit sha] [--branch b] [--attach f1,f2] [--note "..."]
  fail <task> --reason "..."               give up on it (counts as an attempt)
  release <task>                           hand it back
  msg <agent|task|general> "<text>"        write in that channel
  inbox                                    new messages for you since last time
  sweep                                    take back tasks whose lease ran out
  pin <path> <url> <commit>                pin a code project in DEPS
  status | tasks | agents                  where the swarm stands
  watch [--exec "<cmd>"] [--poll 30]       real time: follow pushes, keep leases, print what is new

Env: SWARM_AGENT, SWARM_REMOTE, SWARM_BRANCH (default: the project's default
     branch), SWARM_LEASE_S (default 300), SPACEHUB_BIN (default spacehub).`;

const VALUE_FLAGS = new Set(['as', 'remote', 'branch', 'skills', 'host', 'input', 'deps', 'priority', 'format', 'max-attempts', 'id', 'commit', 'attach', 'note', 'reason', 'exec', 'poll', 'repo']);

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    if (inline !== undefined) flags[k] = inline;
    else if (VALUE_FLAGS.has(k)) {
      if (i + 1 >= argv.length) fail(`--${k} needs a value`);
      flags[k] = argv[++i];
    } else flags[k] = true;
  }
  return { pos, flags };
}

const { pos, flags } = parseArgs(process.argv.slice(2));
const cmd = pos.shift();
const REPO = path.resolve(flags.repo ?? process.cwd());
const AGENT = (flags.as ?? process.env.SWARM_AGENT ?? '').toLowerCase();
const LEASE_S = Number(process.env.SWARM_LEASE_S ?? 300);
const JSON_OUT = !!flags.json;
// Agents are spaces: a GitHub-style login (letters, digits, single hyphens), stored lowercase.
const NAME_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
// Task channels follow the hub's lowercase kebab-case file names: t-1, t-2, ...
const TASK_RE = /^t-[0-9]+$/;
const FORMATS = { 'one-pager': ['One pager', 'output/one-pager.md'], slides: ['Slides', 'output/slides.md'], website: ['Website', 'output/index.html'], 'github-url': ['GitHub URL', 'output/github.url'] };

function fail(msg, code = 1) {
  process.stderr.write(`swarm: ${msg}\n`);
  process.exit(code);
}

// ------------------------------------------------------------------ git

function git(args, opts = {}) {
  try {
    return execFileSync('git', args, { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 << 20, ...opts, encoding: opts.encoding === 'buffer' ? undefined : opts.encoding ?? 'utf8' });
  } catch (err) {
    if (opts.allowFail) return null;
    throw new Error(`git ${args[0]}: ${(err.stderr || err.message || '').toString().trim()}`);
  }
}

function pickRemote() {
  if (flags.remote) return flags.remote;
  if (process.env.SWARM_REMOTE) return process.env.SWARM_REMOTE;
  const remotes = git(['remote']).split('\n').filter(Boolean);
  for (const r of ['quirq', 'origin']) if (remotes.includes(r)) return r;
  if (remotes.length === 1) return remotes[0];
  fail(`pick a remote with --remote (have: ${remotes.join(', ') || 'none'})`);
}

function pickBranch() {
  if (flags.branch) return flags.branch;
  if (process.env.SWARM_BRANCH) return process.env.SWARM_BRANCH;
  const head = git(['ls-remote', '--symref', REMOTE, 'HEAD'], { allowFail: true }) ?? '';
  const m = head.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m);
  return m ? m[1] : 'main';
}

// "<space>/<project>" from a quirq:// or https URL.
function projectName() {
  const url = (git(['remote', 'get-url', REMOTE], { allowFail: true }) ?? '').trim().replace(/\.git$/, '');
  return url.split(/[/:]/).filter(Boolean).slice(-2).join('/');
}

let REMOTE, BRANCH;
const trackingRef = () => `refs/swarm/${REMOTE}/${BRANCH}`;

function fetchBase() {
  const listed = git(['ls-remote', REMOTE, `refs/heads/${BRANCH}`]).trim();
  if (!listed) fail(`${REMOTE} has no branch ${BRANCH}: make the goal project first (spacehub project create <org>/goal --goal "...")`);
  git(['fetch', '-q', REMOTE, `+refs/heads/${BRANCH}:${trackingRef()}`]);
  return git(['rev-parse', trackingRef()]).trim();
}

// Read many files at one commit in one git call: {path: text}.
function readFiles(base, paths) {
  if (!paths.length) return {};
  const out = git(['cat-file', '--batch'], { input: paths.map(p => `${base}:${p}`).join('\n') + '\n', encoding: 'buffer' });
  const files = {};
  let at = 0;
  for (const p of paths) {
    const nl = out.indexOf(10, at);
    const header = out.subarray(at, nl).toString();
    at = nl + 1;
    if (header.endsWith('missing')) continue;
    const size = Number(header.split(' ')[2]);
    files[p] = out.subarray(at, at + size).toString('utf8');
    at += size + 1;
  }
  return files;
}

function buildCommit(base, files, message) {
  const gitDir = path.resolve(REPO, git(['rev-parse', '--git-dir']).trim());
  const index = path.join(gitDir, `swarm-index-${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    git(['read-tree', base], { env });
    for (const [file, content] of Object.entries(files)) {
      const blob = git(['hash-object', '-w', '--stdin'], { input: content }).trim();
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], { env });
    }
    const tree = git(['write-tree'], { env }).trim();
    const email = `${AGENT}@spacehub`;
    const id = { ...process.env, GIT_AUTHOR_NAME: AGENT, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: AGENT, GIT_COMMITTER_EMAIL: email };
    return git(['commit-tree', tree, '-p', base, '-m', message], { env: id }).trim();
  } finally {
    fs.rmSync(index, { force: true });
  }
}

function pushIfUnchanged(base, commit) {
  return git(['push', '-q', `--force-with-lease=refs/heads/${BRANCH}:${base}`, REMOTE, `${commit}:refs/heads/${BRANCH}`], { allowFail: true }) !== null;
}

// ------------------------------------------------------------------ state

// Everything the swarm knows, read from the goal project at `base`.
function load(base) {
  const names = git(['ls-tree', '-r', '--name-only', base, '--', 'Chat/']).split('\n').filter(Boolean);
  const wanted = names.filter(n => /^Chat\/[^/]+\/(task\.json|agent\.json|chat\.log\.jsonl)$/.test(n));
  const files = readFiles(base, wanted);
  const s = { base, names: new Set(names), tasks: {}, agents: {}, logs: {} };
  for (const [p, text] of Object.entries(files)) {
    const [, channel, file] = p.split('/');
    if (file === 'chat.log.jsonl') { s.logs[channel] = text; continue; }
    try {
      const data = JSON.parse(text);
      if (file === 'task.json') s.tasks[channel] = data;
      else s.agents[channel] = data;
    } catch {
      // a broken file is reported by status, never treated as empty state
      (s.broken ??= []).push(p);
    }
  }
  return s;
}

const now = () => new Date().toISOString();
const later = s => new Date(Date.now() + s * 1000).toISOString();
const expired = t => t.status === 'claimed' && Date.parse(t.lease_until) <= Date.now();

function blockers(s, t) {
  return (t.depends_on ?? []).filter(d => s.tasks[d]?.status !== 'done');
}

function claimProblem(s, t) {
  if (!t) return 'no such task';
  if (t.status === 'claimed') return `already claimed by ${t.owner}`;
  if (t.status !== 'open') return `task is ${t.status}`;
  const b = blockers(s, t);
  return b.length ? `blocked by ${b.join(', ')}` : null;
}

function claimable(s) {
  return Object.values(s.tasks)
    .filter(t => !claimProblem(s, t))
    .sort((a, b) => a.priority - b.priority || num(a.id) - num(b.id));
}

const num = id => Number(id.slice(2));
const held = s => Object.values(s.tasks).filter(t => t.status === 'claimed' && t.owner === AGENT);

// ------------------------------------------------------------------ files

const json = v => `${JSON.stringify(v, null, 2)}\n`;
const conversation = title => json({ type: 'conversation', title, messages: [] });

function chatLine(author, content) {
  return `${JSON.stringify({ id: randomUUID(), role: 'user', author, content, time: now() })}\n`;
}

// Append lines to a channel's chat log (the hub's Chat tab reads it).
function appendChat(s, files, channel, text) {
  const p = `Chat/${channel}/chat.log.jsonl`;
  const before = files[p] ?? s.logs[channel] ?? '';
  files[p] = before + (before && !before.endsWith('\n') ? '\n' : '') + chatLine(AGENT, text);
  if (!s.names.has(`Chat/${channel}/chat.json`) && !files[`Chat/${channel}/chat.json`]) files[`Chat/${channel}/chat.json`] = conversation(channel);
}

// A task channel's README in the goal-space layout; Status follows task.json.
function taskReadme(s, t) {
  // Waiting means blocked on a person (the template's meaning): only a task that failed out.
  const status = t.status === 'done' ? 'Done' : t.status === 'failed' ? 'Waiting' : 'Open';
  const lines = [
    `# ${t.id}: ${t.title}`, '',
    '## Owner', '', t.owner ?? 'unclaimed', '',
    '## Status', '', status, '',
    '## Input', '', t.input || t.title, '',
  ];
  if (t.depends_on.length) lines.push(`Depends on: ${t.depends_on.join(', ')}`, '');
  if (t.branch) lines.push(`Code branch: ${t.branch}${t.commit ? ` @ ${t.commit}` : ''}`, '');
  if (t.status === 'failed') lines.push(`Failed ${t.attempt} times; last reason: ${t.note}. A person decides what next.`, '');
  lines.push('## Output format', '', FORMATS[t.format][0], '');
  return lines.join('\n');
}

function saveTask(s, files, t) {
  t.updated_at = now();
  files[`Chat/${t.id}/task.json`] = json(t);
  files[`Chat/${t.id}/README.md`] = taskReadme(s, t);
}

function reopen(t, reason) {
  Object.assign(t, { owner: null, lease_until: null, note: reason ?? "" });
  t.status = t.attempt >= t.max_attempts ? 'failed' : 'open';
}

// ------------------------------------------------------------------ write

// plan(state) returns { files: {path: content}, message, result }.
// Pushed only if the branch has not moved; otherwise re-read and retried.
function write(plan) {
  for (let attempt = 1; attempt <= 10; attempt++) {
    const s = load(fetchBase());
    const out = plan(s);
    if (!out || !Object.keys(out.files).length) return out?.result;
    const commit = buildCommit(s.base, out.files, `swarm: ${out.message}`);
    if (pushIfUnchanged(s.base, commit)) {
      git(['update-ref', trackingRef(), commit]);
      return out.result;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(2000, 100 * 2 ** attempt) * (0.5 + Math.random()));
  }
  fail('could not push after 10 tries: the project keeps moving, or this remote refuses the push');
}

function needAgent() {
  if (!AGENT) fail('say who you are: --as <agent> or SWARM_AGENT');
  if (!NAME_RE.test(AGENT) || TASK_RE.test(AGENT)) fail(`"${AGENT}" is not a valid agent name`);
}

function needTask(s, id) {
  if (!id) fail('which task?');
  const t = s.tasks[id.toLowerCase()];
  if (!t) fail(`no task "${id}"`);
  return t;
}

function mine(s, id) {
  const t = needTask(s, id);
  if (t.status !== 'claimed' || t.owner !== AGENT) fail(`${t.id} is not yours (status ${t.status}, owner ${t.owner ?? 'none'})`, 3);
  return t;
}

const list = v => (typeof v === 'string' ? v.split(',').map(x => x.trim()).filter(Boolean) : []);

// ------------------------------------------------------------------ commands

const commands = {
  join() {
    needAgent();
    return write(s => {
      const files = {};
      const dir = `Chat/${AGENT}`;
      const prev = s.agents[AGENT];
      files[`${dir}/agent.json`] = json({ agent: AGENT, skills: list(flags.skills).length ? list(flags.skills) : prev?.skills ?? [], host: flags.host ?? os.hostname(), joined_at: prev?.joined_at ?? now(), seen_at: now() });
      if (!s.names.has(`${dir}/README.md`)) {
        files[`${dir}/README.md`] = `# ${AGENT}\n\n## Owner\n\n${AGENT}\n\n## Status\n\nOpen\n\n## Input\n\n${AGENT}'s inbox: write here to reach it.\n\n## Output format\n\nOne pager\n`;
        files[`${dir}/chat.json`] = conversation(AGENT);
      }
      if (!prev) appendChat(s, files, 'general', `${AGENT} joined${list(flags.skills).length ? ` (skills: ${list(flags.skills).join(', ')})` : ''}.`);
      return { files, message: `${AGENT} joined`, result: { agent: AGENT, inbox: `${dir}/` } };
    });
  },

  add() {
    needAgent();
    const title = pos.join(' ').trim();
    if (!title) fail('add "<title>"');
    const format = flags.format ?? 'one-pager';
    if (!FORMATS[format]) fail(`--format is one of ${Object.keys(FORMATS).join(', ')}`);
    return write(s => {
      const id = (flags.id ?? `t-${Math.max(0, ...Object.keys(s.tasks).map(num)) + 1}`).toLowerCase();
      if (!TASK_RE.test(id)) fail(`task ids look like t-12, not "${id}"`);
      if (s.tasks[id] || s.names.has(`Chat/${id}/README.md`)) fail(`${id} already exists`);
      const deps = list(flags.deps).map(d => d.toLowerCase());
      for (const d of deps) if (!s.tasks[d]) fail(`dependency ${d} does not exist`);
      const t = { id, title, input: flags.input ?? '', format, depends_on: deps, priority: Number(flags.priority ?? 2), status: 'open', owner: null, token: 0, lease_until: null, attempt: 0, max_attempts: Number(flags['max-attempts'] ?? 3), branch: null, commit: null, outputs: [], note: '', created_by: AGENT, created_at: now() };
      const files = { [`Chat/${id}/chat.json`]: conversation(`${id}: ${title}`), [`Chat/${id}/inputs/.gitkeep`]: '', [`Chat/${id}/output/.gitkeep`]: '' };
      saveTask(s, files, t);
      return { files, message: `add ${id} ${title}`, result: { task: id, channel: `Chat/${id}/` } };
    });
  },

  claim() {
    needAgent();
    return write(s => {
      const mineNow = held(s);
      if (mineNow.length && !flags.many) fail(`${AGENT} already holds ${mineNow.map(t => t.id).join(', ')}: finish it first, or pass --many`, 2);
      let t;
      if (pos[0]) {
        t = needTask(s, pos[0]);
        const why = claimProblem(s, t);
        if (why) fail(`cannot claim ${t.id}: ${why}`, 2);
      } else if (!(t = claimable(s)[0])) fail('nothing to claim right now', 2);
      Object.assign(t, { status: 'claimed', owner: AGENT, token: t.token + 1, lease_until: later(LEASE_S), attempt: t.attempt + 1, branch: `${AGENT}/${t.id}` });
      const files = {};
      saveTask(s, files, t);
      appendChat(s, files, t.id, `${AGENT} took this (token ${t.token}), working on branch ${t.branch}.`);
      return { files, message: `${AGENT} claimed ${t.id} (token ${t.token})`, result: { task: t.id, title: t.title, input: t.input, token: t.token, lease_until: t.lease_until, branch: t.branch, output: `Chat/${t.id}/${FORMATS[t.format][1]}`, depends_on: t.depends_on } };
    });
  },

  heartbeat() {
    needAgent();
    return write(s => {
      const files = {};
      const mineNow = held(s);
      for (const t of mineNow) { t.lease_until = later(LEASE_S); saveTask(s, files, t); }
      if (s.agents[AGENT]) files[`Chat/${AGENT}/agent.json`] = json({ ...s.agents[AGENT], seen_at: now() });
      return { files, message: `${AGENT} heartbeat`, result: { renewed: mineNow.map(t => ({ task: t.id, token: t.token, lease_until: t.lease_until })) } };
    });
  },

  done() {
    needAgent();
    const attach = list(flags.attach).map(f => path.resolve(process.cwd(), f));
    for (const f of attach) if (!fs.existsSync(f)) fail(`no file ${f}`);
    return write(s => {
      const t = mine(s, pos[0]);
      const files = {};
      t.outputs = [...new Set([...t.outputs, ...attach.map(f => `Chat/${t.id}/output/${path.basename(f)}`)])];
      for (const f of attach) files[`Chat/${t.id}/output/${path.basename(f)}`] = fs.readFileSync(f);
      Object.assign(t, { status: 'done', lease_until: null, commit: flags.commit ?? t.commit, branch: flags.branch ?? t.branch, note: flags.note ?? '' });
      saveTask(s, files, t);
      // Tasks waiting only on this one now show Open again.
      for (const other of Object.values(s.tasks)) if (other.status === 'open' && other.depends_on.includes(t.id)) saveTask(s, files, other);
      appendChat(s, files, t.id, `Done${t.commit ? ` at ${t.commit}` : ''}${t.outputs.length ? `: ${t.outputs.join(', ')}` : ''}.${t.note ? ` ${t.note}` : ''}`);
      return { files, message: `${AGENT} finished ${t.id}`, result: { task: t.id, outputs: t.outputs, unblocked: claimable(s).map(x => x.id) } };
    });
  },

  fail() {
    needAgent();
    if (!flags.reason) fail('fail <task> --reason "..."');
    return write(s => {
      const t = mine(s, pos[0]);
      reopen(t, flags.reason);
      const files = {};
      saveTask(s, files, t);
      appendChat(s, files, t.id, `${AGENT} gave up: ${flags.reason}${t.status === 'failed' ? ` This failed ${t.attempt} times; it needs a person: an owner in SPACE.md decides what next.` : ''}`);
      return { files, message: `${AGENT} failed ${t.id}`, result: { task: t.id, status: t.status } };
    });
  },

  release() {
    needAgent();
    return write(s => {
      const t = mine(s, pos[0]);
      t.attempt -= 1;
      reopen(t, 'released');
      const files = {};
      saveTask(s, files, t);
      appendChat(s, files, t.id, `${AGENT} handed this back.`);
      return { files, message: `${AGENT} released ${t.id}`, result: { task: t.id, status: t.status } };
    });
  },

  msg() {
    needAgent();
    const [toRaw, ...rest] = pos;
    const text = rest.join(' ').trim();
    if (!toRaw || !text) fail('msg <agent|task|general> "<text>"');
    const to = TASK_RE.test(toRaw.toLowerCase()) ? toRaw.toLowerCase() : toRaw === '*' ? 'general' : toRaw.toLowerCase();
    return write(s => {
      if (!s.names.has(`Chat/${to}/README.md`)) fail(`no channel Chat/${to}/ (agents open theirs with join)`);
      const files = {};
      appendChat(s, files, to, text);
      return { files, message: `${AGENT} -> ${to}`, result: { to, channel: `Chat/${to}/` } };
    });
  },

  sweep() {
    needAgent();
    return write(s => {
      const files = {};
      const taken = [];
      for (const t of Object.values(s.tasks)) {
        if (!expired(t)) continue;
        const was = t.owner;
        t.token += 1; // the old owner's token is now stale
        reopen(t, `lease expired, no heartbeat from ${was}`);
        saveTask(s, files, t);
        appendChat(s, files, t.id, `${was}'s lease ran out; this is ${t.status === 'failed' ? 'failed and needs a person' : 'open again'}.`);
        taken.push({ task: t.id, from: was, status: t.status });
      }
      return { files, message: `sweep: ${taken.map(x => x.task).join(', ')}`, result: { reclaimed: taken } };
    });
  },

  pin() {
    needAgent();
    const [where, url, commit] = pos;
    if (!where || !url || !/^[0-9a-f]{40}$/.test(commit ?? '')) fail('pin <path> <url> <40-hex commit>');
    return write(s => {
      const current = readFiles(s.base, ['DEPS']).DEPS;
      let deps = {};
      try { deps = current ? JSON.parse(current) : {}; } catch { fail('DEPS is not valid JSON; fix it by hand first'); }
      deps[where] = { url, 'commit-hash': commit };
      return { files: { DEPS: json(deps) }, message: `pin ${where} @ ${commit.slice(0, 12)}`, result: { DEPS: deps } };
    });
  },

  inbox() {
    needAgent();
    const s = load(fetchBase());
    const items = newFor(s, readCursor(), true);
    return { items };
  },

  status() {
    const s = load(fetchBase());
    const by = st => Object.values(s.tasks).filter(t => t.status === st).map(t => t.id);
    return {
      project: projectName(),
      head: s.base.slice(0, 12),
      open: by('open'), claimed: by('claimed'), done: by('done'), failed: by('failed'),
      claimable: claimable(s).map(t => t.id),
      working: Object.values(s.tasks).filter(t => t.status === 'claimed').map(t => ({ task: t.id, owner: t.owner, branch: t.branch, lease_until: t.lease_until, expired: expired(t) })),
      agents: Object.values(s.agents).map(a => ({ agent: a.agent, skills: a.skills, seen_at: a.seen_at })),
      ...(s.broken ? { broken: s.broken } : {}),
    };
  },

  tasks() { return Object.values(load(fetchBase()).tasks).sort((a, b) => num(a.id) - num(b.id)); },
  agents() { return Object.values(load(fetchBase()).agents); },

  watch() {
    needAgent();
    return watch();
  },
};

// ------------------------------------------------------------------ inbox

function cursorPath() {
  const gitDir = path.resolve(REPO, git(['rev-parse', '--git-dir']).trim());
  return path.join(gitDir, 'swarm-cursor', `${AGENT}.json`);
}

function readCursor() {
  try { return JSON.parse(fs.readFileSync(cursorPath(), 'utf8')); } catch { return { lines: {}, tasks: {} }; }
}

// What is new for this agent since the cursor: messages in its inbox, in
// general and in the threads of tasks it holds; tasks it lost; tasks that
// became claimable. Moves the cursor when `advance`.
function newFor(s, cursor, advance) {
  const items = [];
  const watched = new Set([AGENT, 'general', ...held(s).map(t => t.id)]);
  const lines = {};
  for (const [channel, text] of Object.entries(s.logs)) {
    const all = text.split('\n').filter(Boolean);
    lines[channel] = all.length;
    if (!watched.has(channel)) continue;
    for (const raw of all.slice(cursor.lines[channel] ?? 0)) {
      try {
        const m = JSON.parse(raw);
        if (m.author !== AGENT) items.push({ type: 'message', channel, from: m.author, text: m.content, time: m.time });
      } catch { /* skip a torn line */ }
    }
  }
  const tasks = {};
  for (const t of Object.values(s.tasks)) {
    tasks[t.id] = `${t.status}:${t.owner ?? ''}:${t.token}`;
    const before = cursor.tasks[t.id];
    if (before && before.startsWith('claimed:') && before.split(':')[1] === AGENT && !(t.status === 'claimed' && t.owner === AGENT) && t.status !== 'done') items.push({ type: 'lost', task: t.id, status: t.status, owner: t.owner, note: t.note });
  }
  const nowClaimable = claimable(s).map(t => t.id);
  const fresh = nowClaimable.filter(id => !(cursor.claimable ?? []).includes(id));
  if (fresh.length) items.push({ type: 'claimable', tasks: fresh });
  if (advance) {
    fs.mkdirSync(path.dirname(cursorPath()), { recursive: true });
    fs.writeFileSync(cursorPath(), JSON.stringify({ lines, tasks, claimable: nowClaimable }));
  }
  return items;
}

// ------------------------------------------------------------------ watch

// Real time: every push to the goal project wakes a tick, and a slow poll
// backs it up (a live connection can drop). Each tick prints what is new as
// JSON lines and, with --exec, runs a command with it in SWARM_EVENTS. A
// timer renews this agent's leases at half their length and sweeps dead ones.
function watch() {
  const pollMs = Number(flags.poll ?? 30) * 1000;
  const bin = process.env.SPACEHUB_BIN ?? 'spacehub';
  const project = projectName();
  let running = false;
  let again = false;
  let lastBeat = 0;
  let lastHead = '';

  const tick = reason => {
    if (running) { again = true; return; }
    running = true;
    try {
      const s = load(fetchBase());
      if (Date.now() - lastBeat > (LEASE_S * 1000) / 2) {
        lastBeat = Date.now();
        if (held(s).length || Object.values(s.tasks).some(expired)) {
          commands.heartbeat();
          commands.sweep();
        }
      }
      const fresh = load(fetchBase());
      if (fresh.base === lastHead && reason !== 'start') return;
      lastHead = fresh.base;
      const items = newFor(fresh, readCursor(), true);
      for (const item of items) process.stdout.write(`${JSON.stringify({ ...item, at: now() })}\n`);
      if (items.length && flags.exec) {
        const child = spawn(flags.exec, { shell: true, stdio: 'inherit', env: { ...process.env, SWARM_AGENT: AGENT, SWARM_EVENTS: JSON.stringify(items) } });
        child.on('error', err => process.stderr.write(`swarm: --exec failed: ${err.message}\n`));
      }
    } catch (err) {
      process.stderr.write(`swarm: ${err.message}\n`);
    } finally {
      running = false;
      if (again) { again = false; setImmediate(() => tick('push')); }
    }
  };

  // Live: spacehub prints one line per ref change of the project.
  const follow = () => {
    const live = spawn(bin, ['project', 'watch', project], { stdio: ['ignore', 'pipe', 'pipe'] });
    live.on('error', () => process.stderr.write(`swarm: cannot run "${bin}"; following by polling every ${pollMs / 1000}s\n`));
    live.stdout.on('data', chunk => { if (chunk.toString().includes(`refs/heads/${BRANCH}`)) tick('push'); });
    live.on('exit', code => { if (code !== null) setTimeout(follow, 5000); });
  };
  follow();
  setInterval(() => tick('poll'), pollMs);
  process.stderr.write(`swarm: ${AGENT} watching ${project} (${BRANCH}) live, ctrl-c to stop\n`);
  tick('start');
  return new Promise(() => {});
}

// ------------------------------------------------------------------ main

function print(value) {
  if (value === undefined) return;
  if (Array.isArray(value)) { for (const v of value) process.stdout.write(`${JSON.stringify(v)}\n`); return; }
  process.stdout.write(`${JSON.stringify(value, null, JSON_OUT ? 0 : 2)}\n`);
}

if (!cmd || cmd === 'help' || flags.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(cmd ? 0 : 1);
}
if (!commands[cmd]) fail(`unknown command "${cmd}"\n\n${USAGE}`);
if (git(['rev-parse', '--git-dir'], { allowFail: true }) === null) fail(`${REPO} is not a clone of the goal project`);
REMOTE = pickRemote();
BRANCH = pickBranch();
try {
  const result = commands[cmd]();
  if (result instanceof Promise) await result;
  else print(result);
} catch (err) {
  fail(err.message);
}

// store.ts — the forge's in-memory store: git objects, refs, repos, issues,
// pull requests, labels and comments. Everything lives in Maps; nothing
// touches the disk, so a trial starts empty and stays fast.
//
// Determinism: no wall clock anywhere in here. Every timestamp comes from a
// monotonic counter over a fixed epoch, so two runs on the same request
// sequence answer byte for byte the same.

import { createHash } from 'node:crypto';
import { viewerInfo, type ViewerInfo } from './scenario.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const DEFAULT_BRANCH = 'main';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

/** The fixed epoch every timestamp derives from (2025-01-01T00:00:00Z is the suite's day one). */
export const EPOCH_SEC = 1_735_689_600;

let tick = 0;

/** The next deterministic timestamp: epoch + a counter, as seconds and ISO text. */
export function nextStamp(): { epoch: number; iso: string } {
  const epoch = EPOCH_SEC + tick;
  tick += 1;
  return { epoch, iso: new Date(epoch * 1000).toISOString() };
}

/** The git identity line for a server-made commit. */
export function serverIdent(when: { epoch: number }): string {
  const viewer = viewerInfo();
  return `${viewer.name} <${viewer.email}> ${when.epoch} +0000`;
}

export function sha1obj(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------------------------
// Trees and commits
// ---------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: names compared byte-wise, directories as if named `name/`. */
export function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  let out = `tree ${fields.tree}\n`;
  for (const parent of fields.parents) out += `parent ${parent}\n`;
  out += `author ${fields.author}\ncommitter ${fields.committer}\n\n${fields.message}`;
  return Buffer.from(out, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------------------------
// Repository state
// ---------------------------------------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: IssueComment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  /** The base tip the pull request was opened against (conflict detection). */
  baseShaAtCreate: string;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObj>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  /** Issues and pull requests share GitHub's number sequence. */
  nextNumber: number;
}

export class Store {
  readonly viewer: ViewerInfo = viewerInfo();
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1000;
  private nextGlobalId = 100000;
  private nextLabelId = 1;
  private seq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  nextId(): number {
    this.nextGlobalId += 1;
    return this.nextGlobalId;
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    const key = this.key(this.viewer.login, name);
    if (this.repos.has(key)) return null;
    const stamp = nextStamp();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: this.viewer.login,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.nextSeq(),
      createdAt: stamp.iso,
      updatedAt: stamp.iso,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === this.viewer.login) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  /** Store an object, returning its id. */
  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = sha1obj(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label: Label = { id: this.nextLabelId, name, color: color || 'ededed', description: '' };
    this.nextLabelId += 1;
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[]): Issue | { error: string } {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (!label) return { error: `Label '${name}' does not exist` };
      labels.push(label);
    }
    const stamp = nextStamp();
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue: Issue = {
      id: this.nextId(),
      number,
      title,
      body: body ?? '',
      state: 'open',
      labels,
      createdSeq: this.nextSeq(),
      createdAt: stamp.iso,
      updatedAt: stamp.iso,
      closedAt: null,
      comments: [],
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | { error: string } {
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (headSha === undefined) return { error: `Head branch '${headRef}' does not exist` };
    if (baseSha === undefined) return { error: `Base branch '${baseRef}' does not exist` };
    const stamp = nextStamp();
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pull: Pull = {
      id: this.nextId(),
      number,
      title,
      body: body ?? '',
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      baseShaAtCreate: baseSha,
      merged: false,
      mergedAt: null,
      mergeSha: null,
      createdSeq: this.nextSeq(),
      createdAt: stamp.iso,
      updatedAt: stamp.iso,
    };
    repo.pulls.set(number, pull);
    return pull;
  }
}

// ---------------------------------------------------------------------------------------------
// Graph walking over one repo's objects
// ---------------------------------------------------------------------------------------------

/** All objects reachable from `tips`, following commits, trees and tags. */
export function collectReachable(repo: Repo, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** True when `ancestor` is an ancestor of `descendant` (or equal), over commit parents. */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  if (ancestor === ZERO_OID) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** The commit at a ref, or null. */
export function refCommit(repo: Repo, ref: string): { oid: string; commit: CommitView } | null {
  const oid = repo.refs.get(ref);
  if (oid === undefined) return null;
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  return { oid, commit: parseCommit(object.data) };
}

/** Peel a ref to its commit (following an annotated tag). */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 10; hops += 1) {
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** Walk a tree path: returns the object at `path` (blob or tree) or null. */
export function lookupPath(repo: Repo, treeOid: string, path: string): { oid: string; type: ObjType; data: Buffer } | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  let currentOid = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = repo.objects.get(currentOid);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      const target = repo.objects.get(entry.oid);
      if (!target) return null;
      return { oid: entry.oid, type: target.type, data: target.data };
    }
    currentOid = entry.oid;
  }
  return null;
}

/** List the entries of the tree at `path` ('' for the root). */
export function listDir(repo: Repo, treeOid: string, path: string): TreeEntry[] | null {
  if (path === '' || path === '/') {
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return null;
    return parseTree(object.data);
  }
  const found = lookupPath(repo, treeOid, path);
  if (!found || found.type !== 'tree') return null;
  return parseTree(found.data);
}

/** Replace one path in a tree with a blob (creating intermediate trees). Returns the new root tree oid. */
export function setPathInTree(store: Store, repo: Repo, treeOid: string | null, segments: readonly string[], blobOid: string): string {
  if (segments.length === 0) return treeOid ?? store.putObject(repo, 'tree', buildTree([]));
  const [head, ...rest] = segments as [string, ...string[]];
  const entries: TreeEntry[] = treeOid === null ? [] : parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
  const existing = entries.find((entry) => entry.name === head);
  let childOid: string;
  let childMode: string;
  if (rest.length === 0) {
    childOid = blobOid;
    childMode = '100644';
  } else {
    const childTree = existing && existing.mode === '40000' ? existing.oid : null;
    childOid = setPathInTree(store, repo, childTree, rest, blobOid);
    childMode = '40000';
  }
  const next = entries.filter((entry) => entry.name !== head);
  next.push({ mode: childMode, name: head, oid: childOid });
  return store.putObject(repo, 'tree', buildTree(next));
}

/** Remove one path from a tree. Returns the new root tree oid (or null when the tree becomes empty). */
export function removePathFromTree(store: Store, repo: Repo, treeOid: string, segments: readonly string[]): string | null {
  if (segments.length === 0) return treeOid;
  const [head, ...rest] = segments as [string, ...string[]];
  const entries = parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
  const existing = entries.find((entry) => entry.name === head);
  if (!existing) return treeOid;
  const next = entries.filter((entry) => entry.name !== head);
  if (rest.length === 0) {
    // Drop the entry outright.
  } else if (existing.mode === '40000') {
    const child = removePathFromTree(store, repo, existing.oid, rest);
    if (child !== null) next.push({ mode: '40000', name: head, oid: child });
  }
  if (next.length === 0) return null;
  return store.putObject(repo, 'tree', buildTree(next));
}

/** Flatten a tree into path -> {oid, mode} for every blob (and sub-tree) entry. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [sub, value] of flattenTree(repo, entry.oid, path)) out.set(sub, value);
    } else {
      out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }
  return out;
}

/** Count the lines of a blob (a trailing newline does not make an extra line). */
export function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) count += 1;
  if (data[data.length - 1] !== 0x0a) count += 1;
  return count;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
}

/** The file-level diff between two commit trees. */
export function diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): FileChange[] {
  const base = baseTreeOid === null ? new Map() : flattenTree(repo, baseTreeOid);
  const head = headTreeOid === null ? new Map() : flattenTree(repo, headTreeOid);
  const changes: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const data = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      changes.push({ path, status: 'deleted', additions: 0, deletions: lineCount(data) });
    } else if (!b && h) {
      const data = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      changes.push({ path, status: 'added', additions: lineCount(data), deletions: 0 });
    } else if (b && h && b.oid !== h.oid) {
      const oldData = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const newData = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      changes.push({ path, status: 'modified', additions: lineCount(newData), deletions: lineCount(oldData) });
    }
  }
  return changes;
}

/** Commits reachable from `tip`, newest first (parents after children). */
export function listCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    out.push(oid);
    const commit = parseCommit(object.data);
    for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]);
  }
  return out;
}

/**
 * Commit one file on a branch (creating the branch from the default tip, or
 * from nothing when the repo is empty). Returns the new commit and blob ids.
 */
export function commitFile(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
): { commitSha: string; contentSha: string; branchCreated: boolean } {
  const ref = `refs/heads/${branch}`;
  const current = refCommit(repo, ref);
  let baseTree: string | null = null;
  let parents: string[] = [];
  let branchCreated = false;
  if (current) {
    baseTree = current.commit.tree;
    parents = [current.oid];
  } else {
    const defaultRef = refCommit(repo, `refs/heads/${repo.defaultBranch}`);
    if (defaultRef && branch !== repo.defaultBranch) {
      baseTree = defaultRef.commit.tree;
      parents = [defaultRef.oid];
    }
    branchCreated = true;
  }
  const blobOid = store.putObject(repo, 'blob', content);
  const segments = path.split('/').filter((segment) => segment !== '');
  const treeOid = setPathInTree(store, repo, baseTree, segments, blobOid);
  const stamp = nextStamp();
  const ident = serverIdent(stamp);
  const commitData = buildCommit({ tree: treeOid, parents, author: ident, committer: ident, message: message.endsWith('\n') ? message : `${message}\n` });
  const commitSha = store.putObject(repo, 'commit', commitData);
  repo.refs.set(ref, commitSha);
  return { commitSha, contentSha: blobOid, branchCreated };
}

/** Delete one file on a branch. Returns the new commit id, or null when absent. */
export function deleteFile(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  message: string,
): { commitSha: string } | null {
  const ref = `refs/heads/${branch}`;
  const current = refCommit(repo, ref);
  if (!current) return null;
  const segments = path.split('/').filter((segment) => segment !== '');
  if (!lookupPath(repo, current.commit.tree, path)) return null;
  const treeOid = removePathFromTree(store, repo, current.commit.tree, segments);
  const stamp = nextStamp();
  const ident = serverIdent(stamp);
  const commitData = buildCommit({
    tree: treeOid ?? store.putObject(repo, 'tree', buildTree([])),
    parents: [current.oid],
    author: ident,
    committer: ident,
    message: message.endsWith('\n') ? message : `${message}\n`,
  });
  const commitSha = store.putObject(repo, 'commit', commitData);
  repo.refs.set(ref, commitSha);
  return { commitSha };
}

/** Would merging `pull` conflict? True when the base moved and touched a file the head also touched. */
export function mergeWouldConflict(store: Store, repo: Repo, pull: Pull): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined) return true;
  if (baseTip === pull.baseShaAtCreate) return false;
  const baseCreateCommit = repo.objects.get(pull.baseShaAtCreate);
  const headCommit = repo.objects.get(pull.headSha);
  const baseTipCommit = repo.objects.get(baseTip);
  if (!baseCreateCommit || !headCommit || !baseTipCommit) return true;
  const baseTree = parseCommit(baseCreateCommit.data).tree;
  const headTree = parseCommit(headCommit.data).tree;
  const tipTree = parseCommit(baseTipCommit.data).tree;
  const headChanges = new Set(diffTrees(repo, baseTree, headTree).map((change) => change.path));
  const baseChanges = new Set(diffTrees(repo, baseTree, tipTree).map((change) => change.path));
  for (const path of headChanges) if (baseChanges.has(path)) return true;
  return false;
}

/** Squash-merge a pull request onto its base branch. Returns the merge commit id, or null on conflict. */
export function squashMerge(store: Store, repo: Repo, pull: Pull): string | null {
  if (pull.state !== 'open' || pull.merged) return null;
  if (mergeWouldConflict(store, repo, pull)) return null;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headCommit = repo.objects.get(pull.headSha);
  if (baseTip === undefined || !headCommit) return null;
  const headTree = parseCommit(headCommit.data).tree;
  const stamp = nextStamp();
  const ident = serverIdent(stamp);
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
  const commitData = buildCommit({ tree: headTree, parents: [baseTip], author: ident, committer: ident, message });
  const mergeSha = store.putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = stamp.iso;
  pull.mergeSha = mergeSha;
  pull.updatedAt = stamp.iso;
  return mergeSha;
}

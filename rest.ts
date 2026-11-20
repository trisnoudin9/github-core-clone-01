// rest.ts — the GitHub REST v3 API under /api/v3.
//
// Every reply is application/json with a non-empty X-GitHub-Request-Id
// (the app layer adds both). Errors carry {message}. Pagination follows
// GitHub's Link rel="next" form. The store is the single source of truth
// the git, GraphQL and MCP surfaces share.

import {
  commitFile,
  deleteFile,
  diffTrees,
  flattenTree,
  isOid,
  lineCount,
  listCommits,
  listDir,
  lookupPath,
  mergeWouldConflict,
  parseCommit,
  refCommit,
  squashMerge,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestResult {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

const noContent: RestResult = { status: 204, json: null };

function ok(json: unknown, status = 200, headers?: Record<string, string>): RestResult {
  return { status, json, headers };
}

function err(status: number, message: string): RestResult {
  return { status, json: { message } };
}

function notFound(what = 'Not Found'): RestResult {
  return err(404, what);
}

function b64encode(data: Buffer): string {
  return data.toString('base64');
}

function gid(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

// ---------------------------------------------------------------------------------------------
// Serializers (the GitHub shapes the suite asserts on)
// ---------------------------------------------------------------------------------------------

function userJson(store: Store): Record<string, unknown> {
  const viewer = store.viewer;
  return {
    login: viewer.login,
    id: viewer.id,
    node_id: gid('User', viewer.id),
    avatar_url: `https://example.invalid/avatar/${viewer.login}`,
    type: 'User',
    site_admin: false,
    name: viewer.name,
    email: viewer.email,
    html_url: `https://example.invalid/${viewer.login}`,
    url: `/api/v3/users/${viewer.login}`,
  };
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: gid('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(store),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    license: null,
    language: null,
    topics: [],
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

function labelJson(label: { id: number; name: string; color: string; description: string }): Record<string, unknown> {
  return {
    id: label.id,
    node_id: gid('Label', label.id),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
    url: `/api/v3/labels/${encodeURIComponent(label.name)}`,
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: gid('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userJson(store),
    labels: issue.labels.map(labelJson),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    author_association: 'OWNER',
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: gid('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    draft: false,
    user: userJson(store),
    labels: [],
    assignee: null,
    assignees: [],
    milestone: null,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: userJson(store),
      repo: repoJson(store, repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: userJson(store),
      repo: repoJson(store, repo),
    },
    merged: pull.merged,
    mergeable: pull.state === 'open' ? !mergeWouldConflict(store, repo, pull) : null,
    mergeable_state: pull.merged ? 'merged' : pull.state === 'open' ? 'clean' : 'closed',
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commentJson(store: Store, repo: Repo, issueNumber: number, comment: { id: number; body: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: gid('IssueComment', comment.id),
    body: comment.body,
    user: userJson(store),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/comments/${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`,
  };
}

function branchJson(repo: Repo, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: false,
    protection_url: `/api/v3/repos/${repo.owner}/${repo.name}/branches/${encodeURIComponent(name)}/protection`,
  };
}

function commitJson(store: Store, repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const authorLine = commit.author;
  const committerLine = commit.committer;
  const parseIdent = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (!match) return { name: line, email: '', date: repo.createdAt };
    return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
  };
  const author = parseIdent(authorLine);
  const committer = parseIdent(committerLine);
  return {
    sha,
    node_id: gid('Commit', 0) + sha.slice(0, 8),
    commit: {
      message: commit.message.replace(/\n$/, ''),
      author,
      committer,
      tree: { sha: commit.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${commit.tree}` },
    },
    author: userJson(store),
    committer: userJson(store),
    parents: commit.parents.map((parent) => ({ sha: parent, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${parent}` })),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/commit/${sha}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------------------------

function paginate<T>(items: readonly T[], query: URLSearchParams, origin: string, path: string): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const pageNum = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const next = new URL(path, origin);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(pageNum + 1));
    headers.link = `<${next.toString()}>; rel="next"`;
  }
  return { page, headers };
}

// ---------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------

export interface RestContext {
  store: Store;
  origin: string;
}

/** Route one REST call. `segments` is the path after /api/v3, split on '/'. */
export function routeRest(ctx: RestContext, method: string, segments: string[], query: URLSearchParams, body: unknown): RestResult {
  const { store } = ctx;
  const seg = (index: number): string => segments[index] ?? '';
  const decoded = (index: number): string => {
    try {
      return decodeURIComponent(seg(index));
    } catch {
      return seg(index);
    }
  };

  // GET /api/v3/ — the API root.
  if (segments.length === 0 || (segments.length === 1 && segments[0] === '')) {
    if (method !== 'GET') return notFound();
    return ok(
      {
        current_user_url: '/api/v3/user',
        current_user_authorizations_html_url: 'https://example.invalid/settings/applications',
        authorizations_url: '/api/v3/authorizations',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        rate_limit_url: '/api/v3/rate_limit',
        user_url: '/api/v3/users/{user}',
      },
      200,
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  // GET /api/v3/meta
  if (segments.length === 1 && seg(0) === 'meta') {
    if (method !== 'GET') return notFound();
    return ok({ installed_version: '1.0.0', version: '1.0.0', forge: 'forge' });
  }

  // GET /api/v3/user, GET/POST /api/v3/user/repos
  if (seg(0) === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') return notFound();
      return ok(userJson(store));
    }
    if (seg(1) === 'repos') {
      if (method === 'GET') {
        const { page, headers } = paginate(store.viewerRepos(), query, ctx.origin, '/api/v3/user/repos');
        return ok(page.map((repo) => repoJson(store, repo)), 200, headers);
      }
      if (method === 'POST') {
        const input = (body ?? {}) as Record<string, unknown>;
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        if (name === '') return err(422, 'Validation Failed: name is required');
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return err(422, `Validation Failed: '${name}' is not a valid repository name`);
        const created = store.createRepo(name, typeof input.description === 'string' ? input.description : '', input.private === true);
        if (created === null) return err(422, `Repository '${name}' already exists`);
        return ok(repoJson(store, created), 201);
      }
      return notFound();
    }
    return notFound();
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (seg(0) === 'repos') {
    const owner = decoded(1);
    const name = decoded(2);
    if (owner === '' || name === '') return notFound();
    const repo = store.getRepo(owner, name);
    if (segments.length === 3) {
      if (!repo) return notFound('Not Found');
      if (method === 'GET') return ok(repoJson(store, repo));
      if (method === 'PATCH') {
        const input = (body ?? {}) as Record<string, unknown>;
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.private === 'boolean') repo.isPrivate = input.private;
        repo.updatedAt = repo.updatedAt;
        return ok(repoJson(store, repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return noContent;
      }
      return notFound();
    }
    if (!repo) return notFound('Not Found');
    return routeRepo(ctx, repo, method, segments.slice(3), query, body);
  }

  return notFound();
}

/** Routes under /api/v3/repos/{owner}/{repo}/... (repo is known to exist). */
function routeRepo(ctx: RestContext, repo: Repo, method: string, rest: string[], query: URLSearchParams, body: unknown): RestResult {
  const { store } = ctx;
  const head = rest[0] ?? '';

  // Branches
  if (head === 'branches') {
    if (rest.length === 1) {
      if (method !== 'GET') return notFound();
      const branches: Record<string, unknown>[] = [];
      for (const [ref, sha] of [...repo.refs.entries()].sort()) {
        if (!ref.startsWith('refs/heads/')) continue;
        branches.push(branchJson(repo, ref.slice('refs/heads/'.length), sha));
      }
      return ok(branches);
    }
    if (rest.length === 2) {
      const branch = decodeURIComponent(rest[1]);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return notFound('Branch not found');
      if (method !== 'GET') return notFound();
      return ok(branchJson(repo, branch, sha));
    }
    return notFound();
  }

  // Commits
  if (head === 'commits') {
    if (rest.length === 1) {
      if (method !== 'GET') return notFound();
      const shaParam = query.get('sha');
      let tip: string | undefined;
      if (shaParam) {
        tip = repo.refs.get(`refs/heads/${shaParam}`) ?? (isOid(shaParam) ? shaParam : undefined);
      } else {
        tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      }
      if (tip === undefined) return ok([]);
      const commits: Record<string, unknown>[] = [];
      for (const sha of listCommits(repo, tip)) {
        const item = commitJson(store, repo, sha);
        if (item) commits.push(item);
      }
      return ok(commits);
    }
    if (rest.length === 2) {
      const sha = rest[1];
      if (method !== 'GET') return notFound();
      const item = commitJson(store, repo, sha);
      if (!item) return notFound('Commit not found');
      return ok(item);
    }
    return notFound();
  }

  // Git data: refs
  if (head === 'git') {
    if (rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const input = (body ?? {}) as Record<string, unknown>;
        const ref = typeof input.ref === 'string' ? input.ref : '';
        const sha = typeof input.sha === 'string' ? input.sha : '';
        if (!ref.startsWith('refs/') || !isOid(sha)) return err(422, 'Validation Failed: ref and sha are required');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        const object = repo.objects.get(sha);
        if (!object) return err(422, 'Object does not exist');
        repo.refs.set(ref, sha);
        return ok(
          {
            ref,
            node_id: gid('Ref', 0) + Buffer.from(ref).toString('base64').slice(0, 8),
            url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${encodeURIComponent(ref)}`,
            object: { sha, type: object.type, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${object.type}s/${sha}` },
          },
          201,
        );
      }
      if (method === 'GET' && rest.length >= 3) {
        // /git/refs/heads/{branch} (branch names may contain slashes)
        const refPath = rest.slice(2).map((part) => decodeURIComponent(part)).join('/');
        const ref = `refs/${refPath}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) return notFound('Reference not found');
        const object = repo.objects.get(sha);
        return ok({
          ref,
          node_id: gid('Ref', 0) + Buffer.from(ref).toString('base64').slice(0, 8),
          url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${encodeURIComponent(ref)}`,
          object: { sha, type: object?.type ?? 'commit', url: '' },
        });
      }
      if (method === 'DELETE' && rest.length >= 3) {
        const refPath = rest.slice(2).map((part) => decodeURIComponent(part)).join('/');
        repo.refs.delete(`refs/${refPath}`);
        return noContent;
      }
      return notFound();
    }
    return notFound();
  }

  // Contents
  if (head === 'contents') {
    const path = rest.slice(1).map((part) => decodeURIComponent(part)).join('/');
    const refParam = query.get('ref');
    const branch = refParam ?? repo.defaultBranch;
    if (method === 'GET') {
      const tip = refCommit(repo, `refs/heads/${branch}`);
      if (!tip) return notFound('Not Found');
      if (path === '') {
        const entries = listDir(repo, tip.commit.tree, '') ?? [];
        return ok(
          entries.map((entry) => ({
            type: entry.mode === '40000' ? 'dir' : 'file',
            name: entry.name,
            path: entry.name,
            sha: entry.oid,
            size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
            url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${encodeURIComponent(entry.name)}`,
          })),
        );
      }
      const dir = listDir(repo, tip.commit.tree, path);
      if (dir !== null) {
        return ok(
          dir.map((entry) => ({
            type: entry.mode === '40000' ? 'dir' : 'file',
            name: entry.name,
            path: `${path}/${entry.name}`,
            sha: entry.oid,
            size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
            url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${encodeURIComponent(`${path}/${entry.name}`)}`,
          })),
        );
      }
      const found = lookupPath(repo, tip.commit.tree, path);
      if (!found || found.type !== 'blob') return notFound('Not Found');
      return ok({
        type: 'file',
        encoding: 'base64',
        size: found.data.length,
        name: path.split('/').pop() ?? path,
        path,
        content: b64encode(found.data),
        sha: found.oid,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${encodeURIComponent(path)}`,
      });
    }
    if (method === 'PUT') {
      const input = (body ?? {}) as Record<string, unknown>;
      const message = typeof input.message === 'string' ? input.message : `Update ${path}`;
      const contentB64 = typeof input.content === 'string' ? input.content : '';
      const content = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
      const targetBranch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
      const sha = typeof input.sha === 'string' ? input.sha : undefined;
      const tip = refCommit(repo, `refs/heads/${targetBranch}`);
      const existing = tip ? lookupPath(repo, tip.commit.tree, path) : null;
      if (existing) {
        if (sha !== undefined && sha.toLowerCase() !== existing.oid.toLowerCase()) {
          return err(409, 'Conflict: sha does not match the current blob');
        }
        if (sha === undefined) return err(422, 'Validation Failed: sha is required to update a file');
      } else if (sha !== undefined) {
        return err(422, 'Validation Failed: file does not exist');
      }
      const { commitSha, contentSha } = commitFile(store, repo, targetBranch, path, content, message);
      return ok(
        {
          content: {
            type: 'file',
            encoding: 'base64',
            size: content.length,
            name: path.split('/').pop() ?? path,
            path,
            content: b64encode(content),
            sha: contentSha,
          },
          commit: { sha: commitSha, message },
        },
        existing ? 200 : 201,
      );
    }
    if (method === 'DELETE') {
      const input = (body ?? {}) as Record<string, unknown>;
      const message = typeof input.message === 'string' ? input.message : `Delete ${path}`;
      const tip = refCommit(repo, `refs/heads/${branch}`);
      if (!tip) return notFound('Not Found');
      const existing = lookupPath(repo, tip.commit.tree, path);
      if (!existing) return notFound('Not Found');
      const deleted = deleteFile(store, repo, branch, path, message);
      if (!deleted) return notFound('Not Found');
      return ok({ commit: { sha: deleted.commitSha, message } });
    }
    return notFound();
  }

  // Labels
  if (head === 'labels') {
    if (rest.length === 1) {
      if (method === 'GET') return ok([...repo.labels.values()].map(labelJson));
      if (method === 'POST') {
        const input = (body ?? {}) as Record<string, unknown>;
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        if (name === '') return err(422, 'Validation Failed: name is required');
        const label = store.createLabel(repo, name, typeof input.color === 'string' ? input.color : 'ededed');
        return ok(labelJson(label), 201);
      }
      return notFound();
    }
    return notFound();
  }

  // Issues
  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        let issues = [...repo.issues.values()];
        const state = query.get('state') ?? 'open';
        if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
        else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        if (sort === 'created') {
          issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        }
        const { page, headers } = paginate(issues, query, ctx.origin, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
        return ok(page.map((issue) => issueJson(store, repo, issue)), 200, headers);
      }
      if (method === 'POST') {
        const input = (body ?? {}) as Record<string, unknown>;
        const title = typeof input.title === 'string' ? input.title : '';
        const issueBody = typeof input.body === 'string' ? input.body : '';
        const labelNames = Array.isArray(input.labels) ? input.labels.filter((entry): entry is string => typeof entry === 'string') : [];
        const created = store.createIssue(repo, title, issueBody, labelNames);
        if ('error' in created) return err(422, `Validation Failed: ${created.error}`);
        return ok(issueJson(store, repo, created), 201);
      }
      return notFound();
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number) || number < 1) return notFound('Not Found');
    const issue = repo.issues.get(number);
    if (rest.length === 2) {
      if (!issue) return notFound('Not Found');
      if (method === 'GET') return ok(issueJson(store, repo, issue));
      if (method === 'PATCH') {
        const input = (body ?? {}) as Record<string, unknown>;
        if (typeof input.title === 'string') issue.title = input.title;
        if (typeof input.body === 'string') issue.body = input.body;
        if (input.state === 'open' || input.state === 'closed') {
          issue.state = input.state;
          issue.closedAt = input.state === 'closed' ? issue.updatedAt : null;
        }
        return ok(issueJson(store, repo, issue));
      }
      return notFound();
    }
    if (rest[2] === 'comments') {
      if (!issue) return notFound('Not Found');
      if (method === 'GET') {
        return ok(issue.comments.map((comment) => commentJson(store, repo, number, comment)));
      }
      if (method === 'POST') {
        const input = (body ?? {}) as Record<string, unknown>;
        const text = typeof input.body === 'string' ? input.body : '';
        const created = {
          id: store.nextId(),
          body: text,
          createdAt: issue.updatedAt,
          updatedAt: issue.updatedAt,
        };
        issue.comments.push(created);
        return ok(commentJson(store, repo, number, created), 201);
      }
      return notFound();
    }
    return notFound();
  }

  // Pull requests
  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        let pulls = [...repo.pulls.values()];
        const state = query.get('state') ?? 'open';
        if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
        pulls.sort((a, b) => b.createdSeq - a.createdSeq);
        const { page, headers } = paginate(pulls, query, ctx.origin, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
        return ok(page.map((pull) => pullJson(store, repo, pull)), 200, headers);
      }
      if (method === 'POST') {
        const input = (body ?? {}) as Record<string, unknown>;
        const title = typeof input.title === 'string' ? input.title : '';
        const pullBody = typeof input.body === 'string' ? input.body : '';
        const headRef = typeof input.head === 'string' ? input.head : '';
        const baseRef = typeof input.base === 'string' ? input.base : repo.defaultBranch;
        const created = store.createPull(repo, title, pullBody, headRef, baseRef);
        if ('error' in created) return err(422, `Validation Failed: ${created.error}`);
        return ok(pullJson(store, repo, created), 201);
      }
      return notFound();
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number) || number < 1) return notFound('Not Found');
    const pull = repo.pulls.get(number);
    if (rest.length === 2) {
      if (!pull) return notFound('Not Found');
      if (method === 'GET') return ok(pullJson(store, repo, pull));
      if (method === 'PATCH') {
        const input = (body ?? {}) as Record<string, unknown>;
        if (typeof input.title === 'string') pull.title = input.title;
        if (typeof input.body === 'string') pull.body = input.body;
        if (input.state === 'closed' && pull.state === 'open') pull.state = 'closed';
        return ok(pullJson(store, repo, pull));
      }
      return notFound();
    }
    if (rest[2] === 'files') {
      if (!pull) return notFound('Not Found');
      if (method !== 'GET') return notFound();
      const baseCommit = repo.objects.get(pull.baseShaAtCreate);
      const headCommit = repo.objects.get(pull.headSha);
      if (!baseCommit || !headCommit) return ok([]);
      const changes = diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
      return ok(
        changes.map((change) => ({
          sha: '',
          filename: change.path,
          status: change.status,
          additions: change.additions,
          deletions: change.deletions,
          changes: change.additions + change.deletions,
          blob_url: '',
          raw_url: '',
          contents_url: '',
          patch: '',
        })),
      );
    }
    if (rest[2] === 'merge') {
      if (!pull) return notFound('Not Found');
      if (method !== 'PUT') return notFound();
      if (pull.state !== 'open') return err(405, 'Pull request is already closed');
      const mergeSha = squashMerge(store, repo, pull);
      if (mergeSha === null) return err(405, 'Merge conflict: the pull request cannot be merged cleanly');
      return ok({ sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
    }
    return notFound();
  }

  return notFound();
}

// Re-exported for the GraphQL/MCP layers' use.
export { flattenTree, lineCount };

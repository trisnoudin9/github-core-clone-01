// mcp.ts — the Model Context Protocol endpoint at /mcp (Streamable HTTP,
// plain JSON answers).
//
// Two eras are served: the modern 2026-07-28 revision through
// server/discover (no handshake, no session), and the legacy handshake
// (initialize + notifications/initialized) for older clients. The six
// required tools act on the same store as REST, so a repository or issue
// created here reads back over /api/v3 unchanged.

import { squashMerge, type Store } from './store.ts';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

const TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login (defaults to the authenticated user).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full name, owner/repo.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        full_name: { type: 'string', description: 'The full name, owner/repo.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.', enum: ['open', 'closed', 'all'] },
        full_name: { type: 'string', description: 'The full name, owner/repo.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        full_name: { type: 'string', description: 'The full name, owner/repo.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number, with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
        full_name: { type: 'string', description: 'The full name, owner/repo.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge', version: '1.0.0' };

function textResult(value: unknown, isError = false): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    content: [{ type: 'text', text }],
    structuredContent: typeof value === 'object' && value !== null ? value : undefined,
    isError,
  };
}

function resolveOwnerRepo(store: Store, args: Record<string, unknown>): { owner: string; repo: string } | { error: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  const fullName = typeof args.full_name === 'string' ? args.full_name : '';
  if ((owner === '' || repo === '') && fullName.includes('/')) {
    const [namedOwner, namedRepo] = fullName.split('/', 2);
    if (owner === '') owner = namedOwner;
    if (repo === '') repo = namedRepo;
  }
  if (owner === '') owner = store.viewer.login;
  if (repo === '') return { error: 'repo is required' };
  return { owner, repo };
}

/** Dispatch one tools/call. Returns a tool result object (or a JSON-RPC error code). */
function callTool(store: Store, name: string, args: Record<string, unknown>): { result: Record<string, unknown> } | { rpcError: number; message: string } {
  const tool = TOOLS.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
  if (!tool) return { rpcError: -32602, message: `Unknown tool: ${name}` };
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      // The suite also maps owner/repo onto full_name; accept a full_name in their place.
      if ((required === 'owner' || required === 'repo') && typeof args.full_name === 'string' && (args.full_name as string).includes('/')) continue;
      return { rpcError: -32602, message: `Missing required argument: ${required}` };
    }
  }

  if (name === 'create_repo') {
    const repoName = String(args.name);
    const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : store.viewer.login;
    if (owner !== store.viewer.login) return { result: textResult({ error: `cannot create a repository for ${owner}` }, true) };
    const description = typeof args.description === 'string' ? args.description : '';
    const created = store.createRepo(repoName, description, args.private === true);
    if (!created) return { result: textResult({ error: `Repository '${repoName}' already exists` }, true) };
    return {
      result: textResult({
        id: created.id,
        name: created.name,
        full_name: `${created.owner}/${created.name}`,
        owner: created.owner,
        private: created.isPrivate,
        description: created.description,
        default_branch: created.defaultBranch,
      }),
    };
  }

  const resolved = resolveOwnerRepo(store, args);
  if ('error' in resolved) return { rpcError: -32602, message: resolved.error };
  const repo = store.getRepo(resolved.owner, resolved.repo);
  if (!repo) return { result: textResult({ error: `Repository ${resolved.owner}/${resolved.repo} not found` }, true) };

  if (name === 'get_repo') {
    return {
      result: textResult({
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: repo.owner,
        private: repo.isPrivate,
        description: repo.description,
        default_branch: repo.defaultBranch,
      }),
    };
  }

  if (name === 'create_issue') {
    const title = String(args.title);
    const bodyText = typeof args.body === 'string' ? args.body : '';
    const created = store.createIssue(repo, title, bodyText, []);
    if ('error' in created) return { result: textResult({ error: created.error }, true) };
    return {
      result: textResult({
        id: created.id,
        number: created.number,
        title: created.title,
        body: created.body,
        state: created.state,
        labels: [],
      }),
    };
  }

  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let issues = [...repo.issues.values()];
    if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
    else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
    issues.sort((a, b) => b.createdSeq - a.createdSeq);
    return {
      result: textResult(
        issues.map((issue) => ({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: issue.labels.map((label) => ({ name: label.name })),
        })),
      ),
    };
  }

  if (name === 'create_pull_request') {
    const title = String(args.title);
    const bodyText = typeof args.body === 'string' ? args.body : '';
    const head = String(args.head);
    const base = String(args.base);
    const created = store.createPull(repo, title, bodyText, head, base);
    if ('error' in created) return { result: textResult({ error: created.error }, true) };
    return {
      result: textResult({
        id: created.id,
        number: created.number,
        title: created.title,
        body: created.body,
        state: created.state,
        head: { ref: created.headRef, sha: created.headSha },
        base: { ref: created.baseRef, sha: created.baseSha },
      }),
    };
  }

  if (name === 'merge_pull_request') {
    const pullNumber = Number(args.pull_number);
    const pull = repo.pulls.get(pullNumber);
    if (!pull) return { result: textResult({ error: `Pull request #${pullNumber} not found` }, true) };
    if (pull.state !== 'open') return { result: textResult({ error: `Pull request #${pullNumber} is already closed` }, true) };
    const mergeSha = squashMerge(store, repo, pull);
    if (mergeSha === null) return { result: textResult({ error: 'Merge conflict: the pull request cannot be merged cleanly' }, true) };
    return {
      result: textResult({
        number: pull.number,
        merged: true,
        sha: mergeSha,
        state: pull.state,
        message: 'Pull request successfully merged',
      }),
    };
  }

  return { rpcError: -32602, message: `Unknown tool: ${name}` };
}

export interface McpResult {
  status: number;
  json: unknown;
  /** True when the request was a notification: answer 202 with no body. */
  notification?: boolean;
}

/** Handle one POST /mcp body (already parsed as JSON, or null when unparsable). */
export function handleMcp(store: Store, body: unknown): McpResult {
  if (body === null || body === undefined || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const request = body as Record<string, unknown>;
  const id = request.id === undefined ? null : request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  const result = (value: unknown): McpResult => ({ status: 200, json: { jsonrpc: '2.0', id, result: value } });
  const error = (code: number, message: string): McpResult => ({ status: 200, json: { jsonrpc: '2.0', id, error: { code, message } } });

  // A notification (no id) never carries a JSON-RPC answer.
  if (id === null && method.startsWith('notifications/')) {
    return { status: 202, json: null, notification: true };
  }

  switch (method) {
    case 'server/discover':
      return result({
        protocolVersion: '2026-07-28',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return result({
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'tools/list':
      return result({ tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const outcome = callTool(store, toolName, args);
      if ('rpcError' in outcome) return error(outcome.rpcError, outcome.message);
      return result(outcome.result);
    }
    case 'ping':
      return result({});
    default:
      return error(-32601, `Method not found: ${method}`);
  }
}

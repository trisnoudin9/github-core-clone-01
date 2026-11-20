// graphql.ts — a small GraphQL v4 executor for the documents gh and
// github-mcp-server actually send. It parses each operation into a tiny
// AST (fields, aliases, arguments with $variables), validates field names
// against the schema it serves, and resolves against the same store the
// REST surface uses. Unknown fields are GraphQL errors on HTTP 200, never
// HTTP 400. A JSON array body is GitHub's operation batching: one answer
// per operation, in order.

import {
  diffTrees,
  mergeWouldConflict,
  parseCommit,
  refCommit,
  squashMerge,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// Global (Relay) ids: opaque base64 of "Kind:scope:id", stable across reads.
// ---------------------------------------------------------------------------------------------

export function encodeGid(kind: string, scope: string, id: number): string {
  return Buffer.from(`${kind}:${scope}:${id}`, 'utf8').toString('base64');
}

export function decodeGid(value: string): { kind: string; scope: string; id: number } | null {
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length !== 3) return null;
    const id = Number(parts[2]);
    if (!Number.isInteger(id)) return null;
    return { kind: parts[0], scope: parts[1], id };
  } catch {
    return null;
  }
}

function repoGid(repo: Repo): string {
  return encodeGid('Repository', 'repo', repo.id);
}

function issueGid(repo: Repo, issue: Issue): string {
  return encodeGid('Issue', `${repo.id}`, issue.number);
}

function pullGid(repo: Repo, pull: Pull): string {
  return encodeGid('PullRequest', `${repo.id}`, pull.number);
}

function commentGid(repo: Repo, issueNumber: number, commentId: number): string {
  return encodeGid('IssueComment', `${repo.id}:${issueNumber}`, commentId);
}

// ---------------------------------------------------------------------------------------------
// A minimal GraphQL parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  selection: FieldNode[];
  inlineFragments: { typeName: string; selection: FieldNode[] }[];
}

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selection: FieldNode[];
}

class ParseError extends Error {}

class Parser {
  private pos = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  private skipSpace(): void {
    for (;;) {
      while (this.pos < this.text.length && /[\s,]/.test(this.text[this.pos])) this.pos += 1;
      if (this.text[this.pos] === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      break;
    }
  }

  private peek(): string {
    this.skipSpace();
    return this.text[this.pos] ?? '';
  }

  private expect(char: string): void {
    this.skipSpace();
    if (this.text[this.pos] !== char) throw new ParseError(`expected '${char}' at ${this.pos}`);
    this.pos += 1;
  }

  private readName(): string {
    this.skipSpace();
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos));
    if (!match) throw new ParseError(`expected a name at ${this.pos}`);
    this.pos += match[0].length;
    return match[0];
  }

  private readString(): string {
    this.expect('"');
    let out = '';
    while (this.pos < this.text.length) {
      const char = this.text[this.pos];
      this.pos += 1;
      if (char === '"') return out;
      if (char === '\\') {
        const esc = this.text[this.pos];
        this.pos += 1;
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else out += esc ?? '';
      } else {
        out += char;
      }
    }
    throw new ParseError('unterminated string');
  }

  private readValue(): ValueNode {
    this.skipSpace();
    const char = this.text[this.pos];
    if (char === '"') return { kind: 'string', value: this.readString() };
    if (char === '$') {
      this.pos += 1;
      return { kind: 'variable', name: this.readName() };
    }
    if (char === '[') {
      this.pos += 1;
      const items: ValueNode[] = [];
      while (this.peek() !== ']') items.push(this.readValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (char === '{') {
      this.pos += 1;
      const fields: Record<string, ValueNode> = {};
      while (this.peek() !== '}') {
        const name = this.readName();
        this.expect(':');
        fields[name] = this.readValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (char === '-' || /[0-9]/.test(char)) {
      const match = /^-?\d+(\.\d+)?/.exec(this.text.slice(this.pos));
      if (!match) throw new ParseError(`bad number at ${this.pos}`);
      this.pos += match[0].length;
      return match[0].includes('.') ? { kind: 'float', value: Number(match[0]) } : { kind: 'int', value: Number(match[0]) };
    }
    const name = this.readName();
    if (name === 'true') return { kind: 'bool', value: true };
    if (name === 'false') return { kind: 'bool', value: false };
    if (name === 'null') return { kind: 'null' };
    return { kind: 'enum', value: name };
  }

  private readArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    this.skipSpace();
    if (this.text[this.pos] !== '(') return args;
    this.pos += 1;
    while (this.peek() !== ')') {
      const name = this.readName();
      this.expect(':');
      args[name] = this.readValue();
    }
    this.expect(')');
    return args;
  }

  private readSelection(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek() !== '}') {
      fields.push(this.readField());
    }
    this.expect('}');
    return fields;
  }

  private readField(): FieldNode {
    this.skipSpace();
    if (this.text.slice(this.pos, this.pos + 3) === '...') {
      this.pos += 3;
      this.skipSpace();
      if (this.text.slice(this.pos, this.pos + 2) === 'on') {
        this.pos += 2;
        const typeName = this.readName();
        const selection = this.readSelection();
        return { alias: null, name: `...on ${typeName}`, args: {}, selection, inlineFragments: [{ typeName, selection }] };
      }
      throw new ParseError('fragment spreads are not supported');
    }
    let alias: string | null = null;
    let name = this.readName();
    this.skipSpace();
    if (this.text[this.pos] === ':') {
      this.pos += 1;
      alias = name;
      name = this.readName();
    }
    const args = this.readArguments();
    let selection: FieldNode[] = [];
    let inlineFragments: { typeName: string; selection: FieldNode[] }[] = [];
    if (this.peek() === '{') {
      const raw = this.readSelection();
      for (const field of raw) {
        if (field.name.startsWith('...on ')) {
          inlineFragments.push(...field.inlineFragments);
        } else {
          selection.push(field);
        }
      }
    }
    return { alias, name, args, selection, inlineFragments };
  }

  parseOperation(): OperationNode {
    this.skipSpace();
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const word = this.peek();
    if (word === 'q' || word === 'm') {
      const keyword = this.readName();
      if (keyword === 'query' || keyword === 'mutation') type = keyword;
      else throw new ParseError(`unsupported operation ${keyword}`);
      this.skipSpace();
      if (/[A-Za-z_]/.test(this.text[this.pos] ?? '')) name = this.readName();
      // Variable definitions: ($owner: String!, ...) — skip them; values come from `variables`.
      this.skipSpace();
      if (this.text[this.pos] === '(') {
        let depth = 0;
        while (this.pos < this.text.length) {
          const char = this.text[this.pos];
          this.pos += 1;
          if (char === '(') depth += 1;
          else if (char === ')') {
            depth -= 1;
            if (depth === 0) break;
          }
        }
      }
    }
    const selection = this.readSelection();
    return { type, name, selection };
  }
}

// ---------------------------------------------------------------------------------------------
// Value resolution
// ---------------------------------------------------------------------------------------------

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'variable':
      return variables[node.name];
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  const node = field.args[name];
  if (!node) return undefined;
  return resolveValue(node, variables);
}

// ---------------------------------------------------------------------------------------------
// Schema knowledge: the fields each type serves (introspection answers these lists)
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'closedAt',
    'author', 'labels', 'comments', 'assignees', 'milestone',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'url', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'description', 'private', 'issue', 'issues', 'pullRequests', 'pullRequest',
    'url', 'createdAt', 'updatedAt',
  ],
  Viewer: ['login', 'id', 'name', 'email'],
  User: ['login', 'id', 'name', 'email'],
  SearchType: [],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

// ---------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------

interface GqlContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

function fieldError(ctx: GqlContext, typeName: string, fieldName: string): void {
  ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
}

function stateOf(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateOf(pull: Pull): string {
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueFields(ctx: GqlContext, repo: Repo, issue: Issue, selection: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selection) {
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'id':
        out[key] = issueGid(repo, issue);
        break;
      case 'number':
        out[key] = issue.number;
        break;
      case 'title':
        out[key] = issue.title;
        break;
      case 'state':
        out[key] = stateOf(issue);
        break;
      case 'body':
        out[key] = issue.body;
        break;
      case 'url':
        out[key] = `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
        break;
      case 'createdAt':
        out[key] = issue.createdAt;
        break;
      case 'updatedAt':
        out[key] = issue.updatedAt;
        break;
      case 'closedAt':
        out[key] = issue.closedAt;
        break;
      default:
        fieldError(ctx, 'Issue', field.name);
        out[key] = null;
    }
  }
  return out;
}

function pullFields(ctx: GqlContext, repo: Repo, pull: Pull, selection: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selection) {
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'id':
        out[key] = pullGid(repo, pull);
        break;
      case 'number':
        out[key] = pull.number;
        break;
      case 'title':
        out[key] = pull.title;
        break;
      case 'body':
        out[key] = pull.body;
        break;
      case 'state':
        out[key] = pullStateOf(pull);
        break;
      case 'merged':
        out[key] = pull.merged;
        break;
      case 'mergeable':
        out[key] = pull.state === 'open' ? (mergeWouldConflict(ctx.store, repo, pull) ? 'CONFLICTING' : 'MERGEABLE') : 'UNKNOWN';
        break;
      case 'headRefName':
        out[key] = pull.headRef;
        break;
      case 'baseRefName':
        out[key] = pull.baseRef;
        break;
      case 'url':
        out[key] = `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
        break;
      case 'createdAt':
        out[key] = pull.createdAt;
        break;
      case 'updatedAt':
        out[key] = pull.updatedAt;
        break;
      case 'mergedAt':
        out[key] = pull.mergedAt;
        break;
      case 'files': {
        const baseCommit = repo.objects.get(pull.baseShaAtCreate);
        const headCommit = repo.objects.get(pull.headSha);
        let nodes: { path: string }[] = [];
        if (baseCommit && headCommit) {
          nodes = diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree).map((change) => ({ path: change.path }));
        }
        const first = argValue(field, 'first', ctx.variables);
        if (typeof first === 'number') nodes = nodes.slice(0, first);
        out[key] = { nodes };
        break;
      }
      default:
        fieldError(ctx, 'PullRequest', field.name);
        out[key] = null;
    }
  }
  return out;
}

function repoFields(ctx: GqlContext, repo: Repo, selection: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selection) {
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'id':
        out[key] = repoGid(repo);
        break;
      case 'databaseId':
        out[key] = repo.id;
        break;
      case 'name':
        out[key] = repo.name;
        break;
      case 'nameWithOwner':
        out[key] = `${repo.owner}/${repo.name}`;
        break;
      case 'owner':
        out[key] = { login: repo.owner };
        break;
      case 'description':
        out[key] = repo.description;
        break;
      case 'private':
        out[key] = repo.isPrivate;
        break;
      case 'viewerPermission':
        out[key] = 'ADMIN';
        break;
      case 'hasIssuesEnabled':
        out[key] = true;
        break;
      case 'url':
        out[key] = `https://example.invalid/${repo.owner}/${repo.name}`;
        break;
      case 'createdAt':
        out[key] = repo.createdAt;
        break;
      case 'updatedAt':
        out[key] = repo.updatedAt;
        break;
      case 'defaultBranchRef': {
        const tip = refCommit(repo, `refs/heads/${repo.defaultBranch}`);
        out[key] = tip ? { name: repo.defaultBranch } : null;
        break;
      }
      case 'issue': {
        const number = argValue(field, 'number', ctx.variables);
        const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
        out[key] = issue ? issueFields(ctx, repo, issue, field.selection) : null;
        break;
      }
      case 'issues': {
        const issues = issuesConnection(ctx, repo, field);
        out[key] = issues;
        break;
      }
      case 'pullRequests': {
        const first = argValue(field, 'first', ctx.variables);
        let pulls = [...repo.pulls.values()].filter((pull) => pull.state === 'open');
        pulls.sort((a, b) => b.createdSeq - a.createdSeq);
        if (typeof first === 'number') pulls = pulls.slice(0, first);
        // The item fields live under the `nodes` sub-selection.
        const nodesField = field.selection.find((sub) => sub.name === 'nodes');
        const nodesSelection = nodesField?.selection ?? [];
        out[key] = { nodes: pulls.map((pull) => pullFields(ctx, repo, pull, nodesSelection)) };
        break;
      }
      case 'pullRequest': {
        const number = argValue(field, 'number', ctx.variables);
        const pull = typeof number === 'number' ? repo.pulls.get(number) : undefined;
        out[key] = pull ? pullFields(ctx, repo, pull, field.selection) : null;
        break;
      }
      default:
        fieldError(ctx, 'Repository', field.name);
        out[key] = null;
    }
  }
  return out;
}

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : -1;
  } catch {
    return -1;
  }
}

function issuesConnection(ctx: GqlContext, repo: Repo, field: FieldNode): Record<string, unknown> {
  let issues = [...repo.issues.values()];
  const states = argValue(field, 'states', ctx.variables);
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state)));
    issues = issues.filter((issue) => wanted.has(stateOf(issue)));
  }
  const orderBy = argValue(field, 'orderBy', ctx.variables) as Record<string, unknown> | undefined;
  const direction = orderBy?.direction === 'ASC' ? 'asc' : 'desc';
  issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  const first = argValue(field, 'first', ctx.variables);
  const after = argValue(field, 'after', ctx.variables);
  const startIndex = indexOfCursor(after) + 1;
  const pageSize = typeof first === 'number' ? first : issues.length;
  const page = issues.slice(startIndex, startIndex + pageSize);
  const endIndex = startIndex + page.length - 1;
  // The item fields live under the `nodes` (or `edges[].node`) sub-selection,
  // not under the connection's own selection.
  const nodesField = field.selection.find((sub) => sub.name === 'nodes');
  const nodesSelection = nodesField?.selection ?? [];
  const nodes = page.map((issue) => issueFields(ctx, repo, issue, nodesSelection));
  const edgesField = field.selection.find((sub) => sub.name === 'edges');
  const edgeNodeSelection = edgesField?.selection.find((entry) => entry.name === 'node')?.selection ?? [];
  const pageInfo = {
    hasNextPage: endIndex + 1 < issues.length,
    hasPreviousPage: startIndex > 0,
    startCursor: page.length > 0 ? cursorOf(startIndex) : null,
    endCursor: page.length > 0 ? cursorOf(endIndex) : null,
  };
  // The selection may ask for nodes and/or pageInfo; answer both shapes.
  const out: Record<string, unknown> = {};
  for (const sub of field.selection) {
    const key = sub.alias ?? sub.name;
    if (sub.name === 'nodes') out[key] = nodes;
    else if (sub.name === 'pageInfo') out[key] = pageInfo;
    else if (sub.name === 'edges') out[key] = page.map((issue, i) => ({ node: issueFields(ctx, repo, issue, edgeNodeSelection), cursor: cursorOf(startIndex + i) }));
    else if (sub.name === 'totalCount') out[key] = issues.length;
    else {
      fieldError(ctx, 'IssueConnection', sub.name);
      out[key] = null;
    }
  }
  if (Object.keys(out).length === 0) {
    out.nodes = nodes;
    out.pageInfo = pageInfo;
  }
  return out;
}

function findRepoByGid(store: Store, gidValue: string): Repo | null {
  const decoded = decodeGid(gidValue);
  if (!decoded || decoded.kind !== 'Repository') return null;
  for (const repo of store.repos.values()) if (repo.id === decoded.id) return repo;
  return null;
}

function findIssueByGid(store: Store, gidValue: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGid(gidValue);
  if (!decoded || decoded.kind !== 'Issue') return null;
  for (const repo of store.repos.values()) {
    if (repo.id !== Number(decoded.scope)) continue;
    const issue = repo.issues.get(decoded.id);
    if (issue) return { repo, issue };
  }
  return null;
}

function findPullByGid(store: Store, gidValue: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGid(gidValue);
  if (!decoded || decoded.kind !== 'PullRequest') return null;
  for (const repo of store.repos.values()) {
    if (repo.id !== Number(decoded.scope)) continue;
    const pull = repo.pulls.get(decoded.id);
    if (pull) return { repo, pull };
  }
  return null;
}

function executeRoot(ctx: GqlContext, operation: OperationNode): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const field of operation.selection) {
    const key = field.alias ?? field.name;
    if (operation.type === 'query') {
      if (field.name === 'viewer') {
        const viewer = ctx.store.viewer;
        const out: Record<string, unknown> = {};
        for (const sub of field.selection) {
          const subKey = sub.alias ?? sub.name;
          if (sub.name === 'login') out[subKey] = viewer.login;
          else if (sub.name === 'id') out[subKey] = viewer.id;
          else if (sub.name === 'name') out[subKey] = viewer.name;
          else if (sub.name === 'email') out[subKey] = viewer.email;
          else {
            fieldError(ctx, 'User', sub.name);
            out[subKey] = null;
          }
        }
        data[key] = out;
      } else if (field.name === 'repository') {
        const owner = argValue(field, 'owner', ctx.variables);
        const name = argValue(field, 'name', ctx.variables);
        const repo = typeof owner === 'string' && typeof name === 'string' ? ctx.store.getRepo(owner, name) : undefined;
        data[key] = repo ? repoFields(ctx, repo, field.selection) : null;
      } else if (field.name === 'node') {
        const id = argValue(field, 'id', ctx.variables);
        if (typeof id !== 'string') {
          data[key] = null;
        } else {
          const repo = findRepoByGid(ctx.store, id);
          if (!repo) {
            data[key] = null;
          } else {
            const out: Record<string, unknown> = { id: repoGid(repo) };
            for (const sub of field.selection) {
              const subKey = sub.alias ?? sub.name;
              if (sub.name === 'id') out[subKey] = repoGid(repo);
              else if (sub.name === 'name') out[subKey] = repo.name;
              else if (sub.name === 'nameWithOwner') out[subKey] = `${repo.owner}/${repo.name}`;
              else {
                fieldError(ctx, 'Node', sub.name);
                out[subKey] = null;
              }
            }
            // Inline fragments on Repository always apply, whether or not
            // a direct sub-field was present.
            const fragment = field.inlineFragments.find((frag) => frag.typeName === 'Repository');
            if (fragment) Object.assign(out, repoFields(ctx, repo, fragment.selection));
            data[key] = out;
          }
        }
      } else if (field.name === '__type') {
        const name = argValue(field, 'name', ctx.variables);
        const typeName = typeof name === 'string' ? name : '';
        const out: Record<string, unknown> = {};
        for (const sub of field.selection) {
          const subKey = sub.alias ?? sub.name;
          if (sub.name === 'fields') {
            out[subKey] = (TYPE_FIELDS[typeName] ?? []).map((entry) => ({ name: entry }));
          } else if (sub.name === 'enumValues') {
            out[subKey] = typeName === 'SearchType' ? SEARCH_TYPE_VALUES.map((entry) => ({ name: entry })) : [];
          } else if (sub.name === 'name') {
            out[subKey] = typeName;
          } else {
            fieldError(ctx, '__Type', sub.name);
            out[subKey] = null;
          }
        }
        data[key] = out;
      } else if (field.name === '__schema') {
        data[key] = { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
      } else {
        fieldError(ctx, 'Query', field.name);
        data[key] = null;
      }
    } else {
      // Mutations.
      if (field.name === 'createIssue') {
        const input = (argValue(field, 'input', ctx.variables) ?? {}) as Record<string, unknown>;
        const repo = typeof input.repositoryId === 'string' ? findRepoByGid(ctx.store, input.repositoryId) : null;
        if (!repo) {
          ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
          data[key] = null;
        } else {
          const title = typeof input.title === 'string' ? input.title : '';
          const issueBody = typeof input.body === 'string' ? input.body : '';
          const created = ctx.store.createIssue(repo, title, issueBody, []);
          if ('error' in created) {
            ctx.errors.push({ message: created.error });
            data[key] = null;
          } else {
            const sub = field.selection.find((entry) => entry.name === 'issue');
            data[key] = {
              issue: sub ? issueFields(ctx, repo, created, sub.selection) : { number: created.number, id: issueGid(repo, created) },
            };
          }
        }
      } else if (field.name === 'closeIssue') {
        const input = (argValue(field, 'input', ctx.variables) ?? {}) as Record<string, unknown>;
        const found = typeof input.issueId === 'string' ? findIssueByGid(ctx.store, input.issueId) : null;
        if (!found) {
          ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
          data[key] = null;
        } else {
          found.issue.state = 'closed';
          found.issue.closedAt = found.issue.updatedAt;
          const sub = field.selection.find((entry) => entry.name === 'issue');
          data[key] = {
            issue: sub ? issueFields(ctx, found.repo, found.issue, sub.selection) : { number: found.issue.number, id: issueGid(found.repo, found.issue), state: 'CLOSED' },
          };
        }
      } else if (field.name === 'createPullRequest') {
        const input = (argValue(field, 'input', ctx.variables) ?? {}) as Record<string, unknown>;
        const repo = typeof input.repositoryId === 'string' ? findRepoByGid(ctx.store, input.repositoryId) : null;
        if (!repo) {
          ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
          data[key] = null;
        } else {
          const title = typeof input.title === 'string' ? input.title : '';
          const pullBody = typeof input.body === 'string' ? input.body : '';
          const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
          const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
          const created = ctx.store.createPull(repo, title, pullBody, headRef, baseRef);
          if ('error' in created) {
            ctx.errors.push({ message: created.error });
            data[key] = null;
          } else {
            const sub = field.selection.find((entry) => entry.name === 'pullRequest');
            data[key] = {
              pullRequest: sub ? pullFields(ctx, repo, created, sub.selection) : { number: created.number, id: pullGid(repo, created) },
            };
          }
        }
      } else if (field.name === 'mergePullRequest') {
        const input = (argValue(field, 'input', ctx.variables) ?? {}) as Record<string, unknown>;
        const found = typeof input.pullRequestId === 'string' ? findPullByGid(ctx.store, input.pullRequestId) : null;
        if (!found) {
          ctx.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' });
          data[key] = null;
        } else if (found.pull.state !== 'open') {
          ctx.errors.push({ message: 'Pull request is already closed.' });
          data[key] = { pullRequest: pullFields(ctx, found.repo, found.pull, field.selection.find((entry) => entry.name === 'pullRequest')?.selection ?? []) };
        } else {
          const mergeSha = squashMerge(ctx.store, found.repo, found.pull);
          if (mergeSha === null) {
            ctx.errors.push({ message: 'Merge conflict: the pull request cannot be merged cleanly.' });
            data[key] = null;
          } else {
            const sub = field.selection.find((entry) => entry.name === 'pullRequest');
            data[key] = {
              pullRequest: sub ? pullFields(ctx, found.repo, found.pull, sub.selection) : { number: found.pull.number, merged: true, state: 'CLOSED' },
            };
          }
        }
      } else if (field.name === 'addComment') {
        const input = (argValue(field, 'input', ctx.variables) ?? {}) as Record<string, unknown>;
        const found = typeof input.subjectId === 'string' ? findIssueByGid(ctx.store, input.subjectId) : null;
        if (!found) {
          ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
          data[key] = null;
        } else {
          const text = typeof input.body === 'string' ? input.body : '';
          const comment = {
            id: ctx.store.nextId(),
            body: text,
            createdAt: found.issue.updatedAt,
            updatedAt: found.issue.updatedAt,
          };
          found.issue.comments.push(comment);
          data[key] = {
            commentEdge: {
              node: { id: commentGid(found.repo, found.issue.number, comment.id), body: text },
            },
          };
        }
      } else {
        fieldError(ctx, 'Mutation', field.name);
        data[key] = null;
      }
    }
  }
  return data;
}

/** Execute one GraphQL request body (object or array of operations). */
export function executeGraphQL(store: Store, body: unknown): { status: number; json: unknown } {
  const operations = Array.isArray(body) ? body : [body];
  const answers: unknown[] = [];
  for (const operation of operations) {
    const record = (operation ?? {}) as Record<string, unknown>;
    const queryText = typeof record.query === 'string' ? record.query : '';
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    if (queryText.trim() === '') {
      answers.push({ data: null, errors: [{ message: 'Must provide a query.' }] });
      continue;
    }
    let parsed: OperationNode;
    try {
      parsed = new Parser(queryText).parseOperation();
    } catch (err) {
      answers.push({ data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] });
      continue;
    }
    const ctx: GqlContext = { store, variables, errors: [] };
    const data = executeRoot(ctx, parsed);
    if (ctx.errors.length > 0) answers.push({ data, errors: ctx.errors });
    else answers.push({ data });
  }
  return { status: 200, json: Array.isArray(body) ? answers : answers[0] };
}

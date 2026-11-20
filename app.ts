// app.ts — the HTTP server: routing, body reading, auth and the JSON
// envelope. The four surfaces live in their own modules; this file only
// decides which one answers a request and how its bytes go out.
//
// Auth: every /api/v3, /api/graphql and /mcp request must carry
// `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the token in this process's
// environment). /healthz and the git smart-HTTP routes take none.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleReceivePack, handleUploadPack, v0Advertisement, v2Advertisement } from './git.ts';
import { routeRest } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match ? match[1] : null;
}

export function createApp(): { server: Server; store: Store } {
  const store = new Store();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const authorized = (req: IncomingMessage): boolean => {
    const token = bearerToken(req);
    if (token === null || token === '') return false;
    if (expectedToken === '') return true;
    return token === expectedToken;
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await handle(req, res);
      } catch (err) {
        if (!res.writableEnded) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        }
      }
    })();
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    const path = pathOf(req);
    const query = new URL(rawUrl, 'http://entry').searchParams;
    const origin = `http://127.0.0.1:${(server.address() as { port?: number } | null)?.port ?? 0}`;

    // The env's boot probe: 200 {"ok":true}, no auth.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/...
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
    if (gitMatch) {
      const owner = decodeURIComponent(gitMatch[1]);
      const repoName = decodeURIComponent(gitMatch[2]);
      const suffix = gitMatch[3];
      const repo = store.getRepo(owner, repoName);
      if (suffix === 'info/refs') {
        const service = query.get('service');
        if (!repo) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const isV2 = service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2';
        const body = isV2 ? v2Advertisement() : v0Advertisement(repo, service);
        sendBytes(res, 200, body, `application/x-${service}-advertisement`);
        return;
      }
      if (suffix === 'git-upload-pack' && method === 'POST') {
        if (!repo) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const body = await readBody(req);
        const isV2 = req.headers['git-protocol'] === 'version=2';
        try {
          const out = handleUploadPack(repo, body, isV2);
          sendBytes(res, 200, out, 'application/x-git-upload-pack-result');
        } catch {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('bad request\n');
        }
        return;
      }
      if (suffix === 'git-receive-pack' && method === 'POST') {
        if (!repo) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const body = await readBody(req);
        try {
          const out = handleReceivePack(repo, body);
          sendBytes(res, 200, out, 'application/x-git-receive-pack-result');
        } catch {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('bad request\n');
        }
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    // REST v3
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      if (!authorized(req)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      const segments = path === '/api/v3' ? [] : path.slice('/api/v3/'.length).split('/');
      let body: unknown = undefined;
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        const raw = await readBody(req);
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Invalid JSON body' });
            return;
          }
        }
      }
      const result = routeRest({ store, origin }, method, segments, query, body);
      if (result.status === 204 || result.json === null) {
        res.writeHead(result.status, { 'x-github-request-id': nextRequestId(), ...(result.headers ?? {}) });
        res.end();
        return;
      }
      sendJson(res, result.status, result.json, result.headers ?? {});
      return;
    }

    // GraphQL v4
    if (path === '/api/graphql') {
      if (method !== 'POST') {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (!authorized(req)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      const raw = await readBody(req);
      let body: unknown = undefined;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Invalid JSON body' });
          return;
        }
      }
      const result = executeGraphQL(store, body);
      sendJson(res, result.status, result.json);
      return;
    }

    // MCP
    if (path === '/mcp') {
      if (method === 'DELETE') {
        res.writeHead(200, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() });
        res.end('{}\n');
        return;
      }
      if (method !== 'POST') {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (!authorized(req)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      const raw = await readBody(req);
      let body: unknown = null;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          body = null;
          // A body that is not JSON is a JSON-RPC parse error (-32700) on HTTP 400.
          sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
          return;
        }
      }
      const result = handleMcp(store, body);
      if (result.notification === true) {
        res.writeHead(202);
        res.end();
        return;
      }
      sendJson(res, result.status, result.json);
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  }

  return { server, store };
}

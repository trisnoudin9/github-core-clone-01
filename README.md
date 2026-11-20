# forge — a GitHub-compatible git forge

A single-process, in-memory reimplementation of GitHub's core surface:
repositories, git smart HTTP (protocol v0 and v2, clone/fetch/push, shallow
clones, deepen), the REST v3 API, the GraphQL v4 API, and the Model Context
Protocol endpoint — all sharing one store, so a repository pushed over git
reads back over REST, GraphQL and MCP unchanged.

## Run

```sh
# Node 22+ (uses type stripping; no build step, no dependencies)
MAKEFUN_SHOP_TOKEN=<trial token> MAKEFUN_ENV_URL=<env origin> node main.ts
```

`main.ts` binds an ephemeral port (never 8080), registers it with the env
(`POST $MAKEFUN_ENV_URL/register {"port": N}`), then long-polls
`GET $MAKEFUN_ENV_URL/done` until the trial ends and exits 0. `/healthz`
answers `200 {"ok": true}` with no auth.

For local development, `MAKEFUN_ENV_URL` may be left unset only by running
the server directly (see Verify); `main.ts` itself requires it, because
without an env there is nothing to register with.

## Layout

| File | What it does |
| --- | --- |
| `main.ts` | Boot lifecycle: bind, register, wait for done, exit. |
| `app.ts` | HTTP server: routing, body reading, auth, JSON envelope. |
| `scenario.ts` | Re-derives the viewer identity from the fixed scenario seed. |
| `store.ts` | In-memory store: git objects, refs, repos, issues, PRs, labels, comments. Deterministic, counter-based timestamps — no wall clock, no randomness. |
| `git.ts` | Git wire protocol: pkt-lines, pack read/write, v0/v2 advertisements, ls-refs, fetch, receive-pack. |
| `rest.ts` | REST v3 routes and serializers (repos, issues, PRs, labels, comments, branches, commits, contents, refs). |
| `graphql.ts` | GraphQL v4: mini parser + executor for the documents the suite sends, Relay ids, introspection, batching. |
| `mcp.ts` | MCP endpoint: `server/discover`, legacy `initialize`, and the six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`). |

## Verify

Smoke-test the server without an env (any non-empty Bearer token is
accepted when `MAKEFUN_SHOP_TOKEN` is unset):

```sh
node --experimental-strip-types -e "
  const { createApp } = await import('./app.ts');
  const { server } = createApp();
  await new Promise((r) => server.listen(0, r));
  console.log('listening on', server.address().port);
  setTimeout(() => server.close(), 60_000);
" &
curl -s http://127.0.0.1:<port>/healthz
# {"ok":true}
curl -s -H 'Authorization: Bearer test' http://127.0.0.1:<port>/api/v3/user
# {"login":"adaiversen","id":1000,...}
```

Full end-to-end check with a real git client:

```sh
curl -s -X POST -H 'Authorization: Bearer test' -H 'content-type: application/json' \
  -d '{"name":"demo","private":true}' http://127.0.0.1:<port>/api/v3/user/repos
git clone http://127.0.0.1:<port>/adaiversen/demo.git work
cd work && git config user.email adaiversen@example.invalid && git config user.name 'Ada Iversen'
echo hello > hello.txt && git add . && git commit -qm 'first commit' && git push origin main
git clone --depth 1 http://127.0.0.1:<port>/adaiversen/demo.git shallow
```

And the sealed grading trial, from the kit directory:

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot <this directory> --driver process --worktree
```

## Notes

- State is in-memory only: restarting the process starts from an empty
  forge. That matches the trial model (one fresh entry per trial).
- The pack writer emits plain (undelted) objects; the pack reader resolves
  OFS and REF deltas, so thin packs from real clients unpack fine.
- Timestamps are a deterministic counter from a fixed epoch, so a replayed
  trial leaves an identical state export.

// git.ts — the git smart-HTTP protocol, implemented on node:zlib and
// node:crypto: pkt-lines, packfiles (read with OFS/REF delta resolution,
// written without deltas), the v2 upload-pack advertisement and commands,
// the v0 advertisements, and receive-pack with report-status.
//
// The suite's client (git-client.ts) is the only peer: every shape here
// answers what it parses.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  collectReachable,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  type GitObj,
  type ObjType,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------------------------

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Packet {
  kind: PktKind;
  payload: Buffer;
}

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export function pktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer of pkt-lines. Throws on a malformed frame. */
export function decodePktLines(buffer: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line length ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line length out of range');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

/** Split a buffer at the first flush packet: [before, after]. */
export function splitAtFlush(packets: readonly Packet[]): { before: Packet[]; after: Packet[] } {
  const index = packets.findIndex((packet) => packet.kind === 'flush');
  if (index < 0) return { before: [...packets], after: [] };
  return { before: packets.slice(0, index), after: packets.slice(index + 1) };
}

/**
 * Offset just past the first flush packet in a raw pkt-line stream, or -1.
 * A receive-pack request carries a raw packfile after that flush, so the
 * command list must be decoded from the prefix only — decoding the whole
 * body would choke on the pack's binary bytes.
 */
export function offsetAfterFlush(buffer: Buffer): number {
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) return -1;
    const length = parseInt(header, 16);
    if (length === 0) return offset + 4;
    if (length < 4 || offset + length > buffer.length) return -1;
    offset += length;
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas), with a SHA-1 trailer. */
export function writePack(objects: Iterable<GitObj>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

interface RawEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolved?: Buffer;
  resolvedType?: ObjType;
  oid?: string;
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream; returns its bytes and the offset just past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine?.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/**
 * Read a packfile and resolve every object, including OFS_DELTA and
 * REF_DELTA. `resolveBase` supplies a base a thin pack leaves out.
 */
export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObj | undefined,
): Map<string, GitObj> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch after inflate');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const objects = new Map<string, GitObj>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: ObjType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor held`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

// ---------------------------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------------------------

const AGENT = 'forge/1.0.0';

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The v0 ref advertisement body for a service, with the service preamble. */
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const lines: string[] = [`# service=${service}\n`];
  const refs = sortedRefs(repo);
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:${headTarget} side-band-64k thin-pack ofs-delta shallow multi_ack multi_ack_detailed agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const headLine = headOid !== undefined ? `${headOid} HEAD\0${caps}\n` : null;
    if (headLine) lines.push(headLine);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      const object = repo.objects.get(ref.oid);
      if (object && object.type === 'tag' && ref.name.startsWith('refs/tags/')) {
        const peeled = peelToCommit(repo, ref.oid);
        if (peeled) lines.push(`${peeled} ${ref.name}^{}\n`);
      }
    }
  }
  const parts: Buffer[] = [pktLine(lines[0]), FLUSH];
  for (const line of lines.slice(1)) parts.push(pktLine(line));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The protocol v2 capability advertisement (upload-pack only). */
export function v2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  /** `deepen-relative`: `depth` counts down from the client's current shallow boundary, not from the wants. */
  deepenRelative?: boolean;
}

function parseV2Command(packets: readonly Packet[]): { command: string; args: Map<string, string[]> } {
  const args = new Map<string, string[]>();
  let command = '';
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) {
      const match = /^command=(\S+)$/.exec(line);
      if (match) command = match[1];
      continue;
    }
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    const list = args.get(key) ?? [];
    list.push(value);
    args.set(key, list);
  }
  return { command, args };
}

/** ls-refs response lines for the requested filters. */
function lsRefsLines(repo: Repo, args: Map<string, string[]>): string[] {
  const prefixes = args.get('ref-prefix') ?? [];
  const peel = args.has('peel');
  const symrefs = args.has('symrefs');
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  const lines: string[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  if (headOid !== undefined && keep('HEAD')) {
    lines.push(symrefs ? `${headOid} HEAD symref-target:${headTarget}\n` : `${headOid} HEAD\n`);
  } else if (headOid === undefined && keep('HEAD')) {
    lines.push(symrefs ? `unborn HEAD symref-target:${headTarget}\n` : `unborn HEAD\n`);
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    const object = repo.objects.get(ref.oid);
    if (peel && object && object.type === 'tag' && ref.name.startsWith('refs/tags/')) {
      const peeled = peelToCommit(repo, ref.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return lines;
}

/**
 * The objects a fetch must send: reachable from the depth-limited wants,
 * minus what the client already holds. A shallow boundary the client holds
 * counts only as itself plus its tree (its ancestors are not held).
 */
function objectsForFetch(repo: Repo, request: FetchRequest): { objects: GitObj[]; shallow: string[]; unshallow: string[] } {
  const shallowSet = new Set(request.shallow);
  // Generation distance of every ancestor from the wants (unlimited walk):
  // a relative deepen extends the client's current shallow depth, so the
  // client's depth is the deepest boundary's distance from the wants, + 1.
  // Only a relative deepen needs this walk; skip it for plain fetches.
  const distance = new Map<string, number>();
  if (request.depth !== null && request.deepenRelative === true) {
    const queue: { oid: string; depth: number }[] = request.wants.map((oid) => ({ oid, depth: 0 }));
    while (queue.length > 0) {
      const item = queue.shift() as { oid: string; depth: number };
      const known = distance.get(item.oid);
      if (known !== undefined && known <= item.depth) continue;
      distance.set(item.oid, item.depth);
      const object = repo.objects.get(item.oid);
      if (!object) continue;
      if (object.type === 'tag') queue.push({ oid: parseTag(object.data).object, depth: item.depth });
      else if (object.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, depth: item.depth + 1 });
      }
    }
  }
  let effectiveDepth = request.depth;
  if (request.depth !== null && request.deepenRelative === true) {
    let clientDepth = 0;
    for (const boundary of request.shallow) {
      const d = distance.get(boundary);
      if (d !== undefined) clientDepth = Math.max(clientDepth, d + 1);
    }
    if (clientDepth > 0) effectiveDepth = clientDepth + request.depth;
  }
  // Commits within the depth window of the wants.
  const wantedCommits = new Set<string>();
  const wantedTips = new Set<string>(request.wants);
  const queue: { oid: string; depth: number }[] = request.wants.map((oid) => ({ oid, depth: 0 }));
  const seenDepth = new Map<string, number>();
  while (queue.length > 0) {
    const item = queue.shift() as { oid: string; depth: number };
    const known = seenDepth.get(item.oid);
    if (known !== undefined && known <= item.depth) continue;
    seenDepth.set(item.oid, item.depth);
    const object = repo.objects.get(item.oid);
    if (!object) continue;
    if (object.type === 'tag') {
      // An annotated tag want: follow it to its commit at the same depth.
      const target = parseTag(object.data).object;
      queue.push({ oid: target, depth: item.depth });
      continue;
    }
    if (object.type === 'commit') {
      wantedCommits.add(item.oid);
      const limit = effectiveDepth ?? Infinity;
      if (item.depth + 1 < limit) {
        for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, depth: item.depth + 1 });
      }
    }
  }
  // What the client already holds: reachable from the haves, but never
  // past a shallow boundary — a boundary commit counts as itself plus its
  // tree, and its parents are not held (that is exactly what a deepen has
  // to deliver).
  const held = new Set<string>();
  {
    const stack = [...request.haves];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (held.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      held.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        for (const treeOid of collectReachable(repo, [commit.tree])) held.add(treeOid);
        if (!shallowSet.has(oid)) {
          for (const parent of commit.parents) stack.push(parent);
        }
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
  }
  // Everything reachable from the wanted commits (and, for a full fetch,
  // from the wanted tag objects themselves), minus held. A depth-limited
  // fetch sends only the wanted commits and their trees — collectReachable
  // follows parents, which would leak the whole history past the boundary.
  const wantedObjects = new Set<string>();
  if (effectiveDepth === null) {
    for (const oid of collectReachable(repo, wantedTips)) wantedObjects.add(oid);
  } else {
    for (const oid of wantedCommits) {
      wantedObjects.add(oid);
      const object = repo.objects.get(oid);
      if (object?.type === 'commit') {
        for (const treeOid of collectReachable(repo, [parseCommit(object.data).tree])) wantedObjects.add(treeOid);
      }
    }
    for (const tip of wantedTips) {
      const object = repo.objects.get(tip);
      if (object?.type === 'tag') wantedObjects.add(tip);
    }
  }
  const send: GitObj[] = [];
  for (const oid of wantedObjects) {
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) send.push(object);
  }
  // The new shallow boundary: the commits at the depth limit (or the wants, when depth is 1).
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (effectiveDepth !== null) {
    for (const oid of wantedCommits) {
      if ((seenDepth.get(oid) ?? 0) === effectiveDepth - 1) shallow.push(oid);
    }
    for (const boundary of request.shallow) {
      if (wantedCommits.has(boundary) && !shallow.includes(boundary)) unshallow.push(boundary);
    }
  }
  return { objects: send, shallow, unshallow };
}

/** Wrap pack bytes in sideband band-1 packets, chunked under the pkt-line ceiling. */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const framed = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLine(framed));
  }
  if (pack.length === 0) {
    // A zero-object pack still carries its header; writePack never returns empty, so this is unreachable.
  }
  return Buffer.concat(parts);
}

function handleFetchV2(repo: Repo, packets: readonly Packet[]): Buffer {
  const { command, args } = parseV2Command(packets);
  if (command !== 'fetch') throw new Error(`unsupported v2 command ${JSON.stringify(command)}`);
  const request: FetchRequest = {
    wants: args.get('want') ?? [],
    haves: args.get('have') ?? [],
    shallow: args.get('shallow') ?? [],
    depth: args.get('deepen')?.[0] !== undefined ? parseInt(args.get('deepen')?.[0] as string, 10) : null,
    deepenRelative: args.has('deepen-relative'),
  };
  const { objects, shallow, unshallow } = objectsForFetch(repo, request);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  // The acknowledgments section exists only when the client sent haves to
  // acknowledge: with none, the response opens on shallow-info or packfile,
  // and a real client dies on a stray 'acknowledgments' header. When haves
  // were sent, the section must end with a 'ready' line and a DELIM —
  // without 'ready' the client expects the response to end right there, and
  // with a FLUSH instead of a DELIM it never sees the packfile.
  if (request.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    const acked = request.haves.filter((have) => repo.objects.has(have));
    if (acked.length > 0) {
      for (const oid of acked) parts.push(pktLine(`ACK ${oid}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(pktLine('ready\n'));
    parts.push(DELIM);
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function handleFetchV0(repo: Repo, packets: readonly Packet[]): Buffer {
  const { before, after } = splitAtFlush(packets);
  const wants: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let deepenRelative = false;
  for (const packet of before) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      wants.push(line.slice(5).split(' ')[0]);
      if (line.includes('deepen-relative')) deepenRelative = true;
    } else if (line.startsWith('shallow ')) shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7), 10);
  }
  const haves: string[] = [];
  for (const packet of after) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('have ')) haves.push(line.slice(5));
  }
  const { objects, shallow: newShallow, unshallow } = objectsForFetch(repo, { wants, haves, shallow, depth, deepenRelative });
  const pack = writePack(objects);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of newShallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** POST git-upload-pack: v2 when the client asked for it, else v0. */
export function handleUploadPack(repo: Repo, body: Buffer, isV2: boolean): Buffer {
  const packets = decodePktLines(body);
  if (isV2) {
    const { command } = parseV2Command(packets);
    if (command === 'ls-refs') {
      const { args } = parseV2Command(packets);
      return pktLines([...lsRefsLines(repo, args), 'flush']);
    }
    return handleFetchV2(repo, packets);
  }
  return handleFetchV0(repo, packets);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST git-receive-pack: unpack, fast-forward-check each ref, report-status over sideband. */
export function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  // The command list ends at the first flush; everything after it is the
  // raw packfile and must never be pkt-line decoded.
  const flushEnd = offsetAfterFlush(body);
  if (flushEnd < 0) throw new Error('receive-pack request has no flush packet');
  const packets = decodePktLines(body.subarray(0, flushEnd));
  const { before } = splitAtFlush(packets);
  const commands: PushCommand[] = [];
  let sideband = false;
  for (const packet of before) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    let caps = '';
    if (nul >= 0) {
      caps = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    if (caps.includes('side-band-64k')) sideband = true;
  }
  // Everything after the flush packet is the packfile.
  const packBytes = body.subarray(flushEnd);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack error';
    }
  }
  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
  for (const command of commands) {
    let verdict: { ok: true } | { ok: false; reason: string };
    if (!unpackOk) {
      verdict = { ok: false, reason: 'unpack failed' };
    } else if (command.newOid === ZERO_OID) {
      // Delete.
      const current = repo.refs.get(command.ref);
      if (current === undefined) verdict = { ok: false, reason: 'no such ref' };
      else if (command.oldOid !== ZERO_OID && command.oldOid !== current) verdict = { ok: false, reason: 'non-fast-forward' };
      else {
        repo.refs.delete(command.ref);
        verdict = { ok: true };
      }
    } else if (command.oldOid === ZERO_OID) {
      // Create.
      if (repo.refs.has(command.ref)) {
        verdict = { ok: false, reason: 'already exists' };
      } else if (!repo.objects.has(command.newOid) && !isOid(command.newOid)) {
        verdict = { ok: false, reason: 'invalid object' };
      } else {
        repo.refs.set(command.ref, command.newOid);
        verdict = { ok: true };
      }
    } else {
      // Update: must fast-forward from the current tip.
      const current = repo.refs.get(command.ref);
      if (current === undefined) {
        verdict = { ok: false, reason: 'no such ref' };
      } else if (command.oldOid !== current) {
        verdict = { ok: false, reason: 'non-fast-forward' };
      } else if (!isAncestor(repo, command.oldOid, command.newOid)) {
        verdict = { ok: false, reason: 'non-fast-forward' };
      } else {
        repo.refs.set(command.ref, command.newOid);
        verdict = { ok: true };
      }
    }
    reportLines.push(verdict.ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${verdict.reason}\n`);
  }
  const report = pktLines([...reportLines, 'flush']);
  if (sideband) {
    // The report-status stream rides band 1, itself pkt-lined, then a flush.
    const framed = Buffer.concat([Buffer.from([1]), report]);
    return Buffer.concat([pktLine(framed), FLUSH]);
  }
  return report;
}


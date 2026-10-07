/** Optional illustrative dispatch geography. This codec has no schema or Node dependency. */
export type EmergencyPoint = [number, number];
export type EmergencyTargetKind = 'hospital' | 'police' | 'fire' | 'building';
export const EMERGENCY_TARGET_KINDS = ['hospital', 'police', 'fire', 'building'] as const;
export type EmergencyEdge = {
  from: number;
  to: number;
  length: number;
  /** Radians, east/south, at the canonical start and end. */
  bearing: EmergencyPoint;
  oneway: -1 | 0 | 1;
  shape: EmergencyPoint[];
};
export type EmergencyTarget = {
  id: string;
  kind: EmergencyTargetKind;
  at: EmergencyPoint;
  edge: number;
  t: number;
  side: -1 | 1;
  road: string;
  /** Unit tangent in east/north metres, along the canonical edge. */
  tangent: EmergencyPoint;
};
export type EmergencyNetwork = {
  nodes: EmergencyPoint[];
  edges: EmergencyEdge[];
  targets: EmergencyTarget[];
  source: string;
};
export type PackedEmergencyTarget = [
  string,
  number,
  number,
  number,
  number,
  number,
  number,
  string,
  number,
];
export type EmergencyData = {
  version: 1;
  origin: EmergencyPoint;
  /** Columnar signed varints, base64. Coordinates use 1e-5 degrees. */
  nodes: string;
  /** Six columns: delta-from, to-from, metres, two 5-degree bearings, one-way. */
  edges: string;
  /** Interior shape counts followed by coordinate deltas, in edge order. */
  geometry: string;
  /** Targets use 1e-6 degrees, 1e-4 progress and one-degree canonical tangents. */
  targets: PackedEmergencyTarget[];
  source: string;
};
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const MAX_VALUES = 1_000_000;
function pack(values: readonly number[]): string {
  const bytes: number[] = [];
  for (const value of values) {
    if (!Number.isSafeInteger(value)) throw new Error('non-integer emergency value');
    let n = value >= 0 ? value * 2 : -value * 2 - 1;
    do {
      const low = n % 128;
      n = Math.floor(n / 128);
      bytes.push(low + (n ? 128 : 0));
    } while (n);
  }
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!,
      b = bytes[i + 1] ?? 0,
      c = bytes[i + 2] ?? 0;
    out += alphabet[a >> 2]! + alphabet[((a & 3) << 4) | (b >> 4)]!;
    out += i + 1 < bytes.length ? alphabet[((b & 15) << 2) | (c >> 6)]! : '=';
    out += i + 2 < bytes.length ? alphabet[c & 63]! : '=';
  }
  return out;
}
function unpack(text: string): number[] {
  if (
    text.length > 2_000_000 ||
    text.length % 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)
  )
    throw new Error('invalid emergency base64');
  const values: number[] = [];
  let n = 0,
    multiplier = 1;
  const byte = (b: number) => {
    n += (b & 127) * multiplier;
    if (!Number.isSafeInteger(n) || multiplier > 2 ** 49)
      throw new Error('invalid emergency varint');
    if (b & 128) multiplier *= 128;
    else {
      values.push(n % 2 ? -(n + 1) / 2 : n / 2);
      if (values.length > MAX_VALUES) throw new Error('emergency network too large');
      n = 0;
      multiplier = 1;
    }
  };
  for (let i = 0; i < text.length; i += 4) {
    const a = alphabet.indexOf(text[i]!),
      b = alphabet.indexOf(text[i + 1]!);
    const c = alphabet.indexOf(text[i + 2]!),
      d = alphabet.indexOf(text[i + 3]!);
    byte((a << 2) | (b >> 4));
    if (c >= 0) byte(((b & 15) << 4) | (c >> 2));
    if (d >= 0) byte(((c & 3) << 6) | d);
  }
  if (multiplier !== 1) throw new Error('truncated emergency varint');
  return values;
}
const pointValid = (p: EmergencyPoint) =>
  Number.isFinite(p[0]) &&
  Number.isFinite(p[1]) &&
  Math.abs(p[0]) <= 180 &&
  Math.abs(p[1]) <= 85.051129;

export function encodeEmergency(network: EmergencyNetwork): EmergencyData {
  const origin: EmergencyPoint = network.nodes[0] ? [...network.nodes[0]] : [0, 0];
  const coordinate = (p: EmergencyPoint) => p.map((n, i) => Math.round((n - origin[i]!) * 1e5));
  const columns = [[], []] as number[][];
  let previous = [0, 0];
  for (const p of network.nodes) {
    const q = coordinate(p);
    for (let i = 0; i < 2; i++) columns[i]!.push(q[i]! - previous[i]!);
    previous = q;
  }
  const edgeColumns = Array.from({ length: 6 }, () => [] as number[]),
    geometry: number[] = [];
  let from = 0;
  for (const edge of network.edges) {
    const row = [
      edge.from - from,
      edge.to - edge.from,
      Math.max(1, Math.round(edge.length)),
      ...edge.bearing.map((r) => Math.round((r * 180) / Math.PI / 5)),
      edge.oneway,
    ];
    row.forEach((n, i) => edgeColumns[i]!.push(n));
    from = edge.from;
    const interior = edge.shape.slice(1, -1);
    geometry.push(interior.length);
    let last = coordinate(network.nodes[edge.from]!);
    for (const p of interior) {
      const q = coordinate(p);
      geometry.push(q[0]! - last[0]!, q[1]! - last[1]!);
      last = q;
    }
  }
  return {
    version: 1,
    origin,
    nodes: pack(columns.flat()),
    edges: pack(edgeColumns.flat()),
    geometry: pack(geometry),
    targets: network.targets.map((target) => [
      target.id,
      EMERGENCY_TARGET_KINDS.indexOf(target.kind),
      Math.round((target.at[0] - origin[0]) * 1e6),
      Math.round((target.at[1] - origin[1]) * 1e6),
      target.edge,
      Math.round(target.t * 1e4),
      target.side,
      target.road,
      Math.round((Math.atan2(target.tangent[1], target.tangent[0]) * 180) / Math.PI),
    ]),
    source: network.source,
  };
}

/** Throws on malformed optional data. isEmergencyData is the nonthrowing boundary guard. */
export function decodeEmergency(data: EmergencyData): EmergencyNetwork {
  if (data.version !== 1 || !pointValid(data.origin) || !data.source.trim())
    throw new Error('invalid emergency header');
  const values = unpack(data.nodes),
    n = values.length / 2;
  if (!Number.isInteger(n) || !n || n > 100_000) throw new Error('invalid emergency nodes');
  const nodes: EmergencyPoint[] = [];
  let x = 0,
    y = 0;
  for (let i = 0; i < n; i++) {
    x += values[i]!;
    y += values[i + n]!;
    const p: EmergencyPoint = [data.origin[0] + x / 1e5, data.origin[1] + y / 1e5];
    if (!pointValid(p)) throw new Error('invalid emergency coordinate');
    nodes.push(p);
  }
  const rows = unpack(data.edges),
    count = rows.length / 6,
    shapes = unpack(data.geometry);
  if (!Number.isInteger(count) || !count || count > 100_000)
    throw new Error('invalid emergency edges');
  const edges: EmergencyEdge[] = [];
  let from = 0,
    cursor = 0;
  for (let i = 0; i < count; i++) {
    from += rows[i]!;
    const to = from + rows[i + count]!,
      length = rows[i + 2 * count]!,
      oneway = rows[i + 5 * count]!;
    if (
      from < 0 ||
      from >= n ||
      to < 0 ||
      to >= n ||
      length <= 0 ||
      length > 1_000_000 ||
      ![-1, 0, 1].includes(oneway)
    )
      throw new Error('invalid emergency edge reference');
    const bearing: EmergencyPoint = [
      (rows[i + 3 * count]! * Math.PI) / 36,
      (rows[i + 4 * count]! * Math.PI) / 36,
    ];
    if (bearing.some((a) => Math.abs(a) > Math.PI)) throw new Error('invalid emergency bearing');
    const interior = shapes[cursor++];
    if (
      interior === undefined ||
      interior < 0 ||
      interior > 100_000 ||
      cursor + 2 * interior > shapes.length
    )
      throw new Error('invalid emergency shape');
    const shape: EmergencyPoint[] = [[...nodes[from]!]];
    let qx = Math.round((nodes[from]![0] - data.origin[0]) * 1e5),
      qy = Math.round((nodes[from]![1] - data.origin[1]) * 1e5);
    for (let j = 0; j < interior; j++) {
      qx += shapes[cursor++]!;
      qy += shapes[cursor++]!;
      const p: EmergencyPoint = [data.origin[0] + qx / 1e5, data.origin[1] + qy / 1e5];
      if (!pointValid(p)) throw new Error('invalid emergency shape coordinate');
      shape.push(p);
    }
    shape.push([...nodes[to]!]);
    edges.push({ from, to, length, bearing, oneway: oneway as -1 | 0 | 1, shape });
  }
  if (cursor !== shapes.length || data.targets.length > 4096)
    throw new Error('invalid emergency geometry length');
  const ids = new Set<string>();
  const targets = data.targets.map((row): EmergencyTarget => {
    if (
      row.length !== 9 ||
      typeof row[0] !== 'string' ||
      !row[0] ||
      ids.has(row[0]) ||
      typeof row[7] !== 'string' ||
      !row[7] ||
      row.slice(1, 7).some((v) => !Number.isSafeInteger(v)) ||
      !Number.isSafeInteger(row[8])
    )
      throw new Error('invalid emergency target');
    ids.add(row[0]);
    const kind = EMERGENCY_TARGET_KINDS[row[1]],
      at: EmergencyPoint = [data.origin[0] + row[2] / 1e6, data.origin[1] + row[3] / 1e6];
    if (
      !kind ||
      !pointValid(at) ||
      row[4] < 0 ||
      row[4] >= count ||
      row[5] < 0 ||
      row[5] > 10000 ||
      (row[6] !== -1 && row[6] !== 1) ||
      Math.abs(row[8]) > 180
    )
      throw new Error('invalid emergency target reference');
    const angle = (row[8] * Math.PI) / 180;
    return {
      id: row[0],
      kind,
      at,
      edge: row[4],
      t: row[5] / 10000,
      side: row[6],
      road: row[7],
      tangent: [Math.cos(angle), Math.sin(angle)],
    };
  });
  return { nodes, edges, targets, source: data.source };
}

export function isEmergencyData(value: unknown): value is EmergencyData {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<EmergencyData>;
  if (
    !Array.isArray(record.origin) ||
    record.origin.length !== 2 ||
    typeof record.nodes !== 'string' ||
    typeof record.edges !== 'string' ||
    typeof record.geometry !== 'string' ||
    typeof record.source !== 'string' ||
    !Array.isArray(record.targets) ||
    !record.targets.every(Array.isArray)
  )
    return false;
  try {
    decodeEmergency(record as EmergencyData);
    return true;
  } catch {
    return false;
  }
}

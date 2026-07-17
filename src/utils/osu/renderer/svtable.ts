// ─── Cumulative scroll-velocity table ───
// Maps real time to "visual time" by integrating a piecewise-constant
// velocity multiplier, so renderers can position notes under SV/BPM changes
// with a binary search per lookup.

export interface VelocityPoint {
  time: number;
  multiplier: number;
}

export interface SvEntry {
  time: number;
  cumulative: number;
  sv: number;
}

export function buildSvTable(
  points: VelocityPoint[],
  startMs: number,
  endMs: number,
): SvEntry[] {
  const bounds: { time: number; sv: number }[] = [];
  let initialSv = 1.0;
  for (let i = points.length - 1; i >= 0; i--) {
    if ((points[i]?.time ?? 0) <= startMs) {
      initialSv = points[i]?.multiplier ?? 1.0;
      break;
    }
  }
  bounds.push({ time: startMs, sv: initialSv });
  for (const pt of points) {
    if (pt.time > startMs && pt.time < endMs)
      bounds.push({ time: pt.time, sv: pt.multiplier });
  }
  bounds.push({ time: endMs, sv: bounds[bounds.length - 1]?.sv ?? 1.0 });

  const table: SvEntry[] = [];
  let cumulative = 0;
  for (let i = 0; i < bounds.length - 1; i++) {
    const cur = bounds[i];
    const next = bounds[i + 1];
    if (!cur || !next) continue;
    table.push({ time: cur.time, cumulative, sv: cur.sv });
    cumulative += (next.time - cur.time) * cur.sv;
  }
  table.push({
    time: endMs,
    cumulative,
    sv: bounds[bounds.length - 1]?.sv ?? 1.0,
  });
  return table;
}

export function svAt(table: SvEntry[], timeMs: number): number {
  if (table.length === 0) return timeMs;
  const first = table[0];
  const last = table[table.length - 1];
  if (!first || !last) return timeMs;
  if (timeMs <= first.time)
    return first.cumulative + (timeMs - first.time) * first.sv;
  if (timeMs >= last.time)
    return last.cumulative + (timeMs - last.time) * last.sv;
  let lo = 0;
  let hi = table.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if ((table[mid]?.time ?? 0) <= timeMs) lo = mid + 1;
    else hi = mid - 1;
  }
  const entry = table[Math.max(0, Math.min(table.length - 1, hi))];
  if (!entry) return timeMs;
  return entry.cumulative + (timeMs - entry.time) * entry.sv;
}

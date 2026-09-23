/**
 * Mapillary map-feature value helpers shared by the browser layer and the
 * server query executor. Values look like `object--fire-hydrant` or
 * `regulatory--stop--g1`; the segments are separated by `--`.
 */

const SIGN_PREFIXES = Object.freeze([
  'regulatory',
  'warning',
  'information',
  'complementary',
]);

/** Escape a string for use inside a RegExp source. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalize one user-supplied value pattern: trimmed, lower-cased, spaces
 * folded to hyphens, and only the characters a Mapillary value can contain.
 * Returns '' when nothing usable remains.
 * @param {unknown} pattern
 * @returns {string}
 */
export function normalizeValuePattern(pattern) {
  return String(pattern ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9*-]/g, '')
    .slice(0, 120);
}

/**
 * Build a matcher for a list of value patterns. `*` matches any run of
 * characters, so `regulatory--stop--*` covers every regional variant and
 * `object--traffic-light--*` every traffic-light subtype. An empty pattern
 * list matches everything.
 * @param {Iterable<string>} patterns
 * @returns {(value: string) => boolean}
 */
export function createValueMatcher(patterns) {
  const exact = new Set();
  const wild = [];
  for (const raw of patterns || []) {
    const pattern = normalizeValuePattern(raw);
    if (!pattern) continue;
    if (pattern.includes('*')) {
      wild.push(
        new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`),
      );
    } else exact.add(pattern);
  }
  if (!exact.size && !wild.length) return () => true;
  return (value) => {
    if (typeof value !== 'string') return false;
    if (exact.has(value)) return true;
    for (const regex of wild) if (regex.test(value)) return true;
    return false;
  };
}

/**
 * Whether a value belongs to the traffic-sign layer rather than the point
 * object layer. Sign values start with one of four regulatory families.
 * @param {string} value
 * @returns {boolean}
 */
export function isSignValue(value) {
  const head = String(value || '').split('--')[0];
  return SIGN_PREFIXES.includes(head);
}

/**
 * Human label for a value: `object--fire-hydrant` → "Fire hydrant",
 * `regulatory--stop--g1` → "Stop (regulatory)",
 * `object--traffic-light--general-upright` → "Traffic light · general upright".
 * @param {string} value
 * @returns {string}
 */
export function humanizeValue(value) {
  const parts = String(value || '')
    .split('--')
    .filter(Boolean);
  if (!parts.length) return 'Unknown';
  const [head, ...rest] = parts;
  const words = (segment) =>
    segment.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  if (SIGN_PREFIXES.includes(head)) {
    const body = rest.filter((segment) => !/^g\d+$/.test(segment));
    return `${body.map(words).join(' · ') || words(head)} (${head})`;
  }
  if (head === 'object' || head === 'marking' || head === 'construction') {
    const body = rest.length ? rest : [head];
    return body.map(words).join(' · ');
  }
  return parts.map(words).join(' · ');
}

/** Coarse category used for colouring and grouping results. */
export function categoryOf(value) {
  const head = String(value || '').split('--')[0];
  if (SIGN_PREFIXES.includes(head)) return 'sign';
  if (head === 'marking') return 'marking';
  if (head === 'construction') return 'construction';
  return 'object';
}

/**
 * Stable CSS colour per value, so one class keeps one colour across a query.
 * Signs lean warm, objects lean cool; the hue within a category is hashed
 * from the value so neighbouring classes differ.
 * @param {string} value
 * @returns {string} CSS colour.
 */
export function colorForValue(value) {
  let hash = 0;
  const text = String(value || '');
  for (let i = 0; i < text.length; i++)
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  const category = categoryOf(text);
  // Objects sit in the cyan-blue band so they never blend into the
  // Mapillary-green coverage lines; signs lean warm, markings violet.
  const base =
    category === 'sign'
      ? 20
      : category === 'marking'
        ? 280
        : category === 'construction'
          ? 45
          : 205;
  const hue = (base + (hash % 60) - 30 + 360) % 360;
  return `hsl(${hue} 90% 60%)`;
}

/**
 * Merge per-value counts whose human labels coincide (regional sign variants
 * such as `regulatory--stop--g1` and `--g3`), summing counts and keeping the
 * first value's colour. Input and output are sorted by count, descending.
 * @param {Iterable<[string, number]>} counts
 * @returns {Array<{value: string, values: string[], count: number, label: string, color: string}>}
 */
export function groupCountsByLabel(counts) {
  const groups = new Map();
  for (const [value, count] of counts) {
    const label = humanizeValue(value);
    const group = groups.get(label);
    if (group) {
      group.count += count;
      group.values.push(value);
    } else
      groups.set(label, {
        value,
        values: [value],
        count,
        label,
        color: colorForValue(value),
      });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

import { COLORS } from './policy.js';

/**
 * @typedef {object} ProviderSnapshot
 * @property {string} id
 * @property {string} name
 * @property {string} label
 * @property {boolean} on
 * @property {boolean|null} configured   null until the status call answers
 * @property {boolean} keyRequired
 * @property {string|null} requiresKeyId
 * @property {boolean} loading
 * @property {number} count
 * @property {string} hint
 * @property {string|null} error
 * @property {Array<{key: string, label: string, color: string}>} legend
 */

/**
 * Compose the snapshot the panel renders from the core state and one
 * snapshot per registered provider. Pure, so the merge rules are testable:
 * counts add up across active providers, the layer is key-gated only when
 * every switched-on provider lacks its key, and the legend lists each active
 * provider's colours (prefixed by name once more than one is registered)
 * followed by the shared selection colour.
 * @param {{enabled: boolean, filter: object, providers: Array<ProviderSnapshot>, street: object, sequence: object}} input
 */
export function composeUIState({
  enabled,
  filter,
  providers,
  street,
  sequence,
}) {
  const active = providers.filter((p) => p.on);
  const keyRequired =
    active.length > 0 && active.every((p) => p.keyRequired === true);
  const legend = [];
  for (const provider of active)
    for (const entry of provider.legend)
      legend.push({
        key: `${provider.id}:${entry.key}`,
        label:
          providers.length > 1
            ? `${provider.name} ${entry.label}`
            : entry.label,
        color: entry.color,
      });
  if (active.length)
    legend.push({ key: 'selected', label: 'Selected', color: COLORS.selected });
  return {
    enabled,
    keyRequired,
    filter: { ...filter },
    providers: providers.map((p) => ({ ...p, legend: [...p.legend] })),
    coverage: {
      loading: active.some((p) => p.loading),
      count: active.reduce((sum, p) => sum + (p.count || 0), 0),
      hint: active.find((p) => p.hint)?.hint || '',
      error: active.find((p) => p.error)?.error || null,
    },
    legend,
    sequence: { ...sequence },
    street: { ...street },
  };
}

import { createAvatarLayer } from '../../layers/avatar/index.js';
import * as render from '../../renderGovernor.js';

const publicAsset = (url) =>
  `${import.meta.env?.BASE_URL || '/'}${url.replace(/^\//, '')}`;

/** Wire the Me Mode avatar to the render governor and public asset root. */
export function createApplicationAvatar({
  resolveAsset = publicAsset,
  search = globalThis.location?.search || '',
} = {}) {
  return createAvatarLayer({
    render,
    // Absolute https models (the pinned fallback, ?avatar=https://…) pass through.
    resolveAsset: (url) => (/^https:\/\//i.test(url) ? url : resolveAsset(url)),
    search,
  });
}

import { createStreetLevelLayer } from '../../layers/streetLevel/index.js';
import * as sprites from '../../data/spriteOrder.js';
import * as picking from '../../data/pickRegistry.js';
import * as input from '../../data/inputOwnership.js';
import * as render from '../../renderGovernor.js';

/** Construct the Street Level layer using the application scene owners and a supplied source. */
export function createApplicationStreetLevel({ surface, source }) {
  return createStreetLevelLayer({
    source,
    services: {
      sprites,
      picking,
      input,
      render,
      ground: surface?.groundFloor ?? null,
    },
  });
}

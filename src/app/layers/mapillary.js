import { createMapillaryLayer } from '../../layers/mapillary/index.js';
import * as sprites from '../../data/spriteOrder.js';
import * as picking from '../../data/pickRegistry.js';
import * as input from '../../data/inputOwnership.js';
import * as render from '../../renderGovernor.js';

/** Construct the Mapillary layer using the application scene owners and a supplied source. */
export function createApplicationMapillary({ surface, source }) {
  return createMapillaryLayer({
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

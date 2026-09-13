// Backward-compatible entry point for the Phase-1 prototype API; the
// renderer now lives in datapath.mjs.

import { loadSkin, renderDatapath } from './datapath.mjs';

export { loadSkin };
export const renderDatapathPrototype = renderDatapath;

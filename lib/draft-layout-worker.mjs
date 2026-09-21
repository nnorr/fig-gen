import { parentPort, workerData } from 'node:worker_threads';

try {
  const { type, input, opts } = workerData;
  const render = type === 'datapath'
    ? (await import('./render/datapath.mjs')).renderDatapath
    : (await import('./render/microarch.mjs')).renderMicroarch;
  const result = await render(input, opts);
  // The parent needs measurements/diagnostics only, not the SVG or ELK graph.
  parentPort.postMessage({ result: {
    width_pt: result.width_pt, height_pt: result.height_pt,
    diagnostics: result.diagnostics,
  } });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}

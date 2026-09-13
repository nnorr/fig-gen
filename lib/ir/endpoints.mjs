// Endpoint grammar (SPEC §3.3):
//   endpoint := path "." port [slice] | path
//   path     := id ("/" id)*
//   slice    := "[" msb ":" lsb "]" | "[" bit "]"

const ENDPOINT_RE = /^([A-Za-z_]\w*(?:\/[A-Za-z_]\w*)*)(?:\.([A-Za-z_]\w*))?(?:\[(\d+)(?::(\d+))?\])?$/;

export function parseEndpoint(text) {
  const match = ENDPOINT_RE.exec(String(text));
  if (!match) return null;
  const [, pathText, port, hi, lo] = match;
  const path = pathText.split('/');
  const endpoint = { path, element: path[path.length - 1], port: port ?? null, slice: null };
  if (hi !== undefined) {
    const msb = Number(hi);
    const lsb = lo === undefined ? msb : Number(lo);
    endpoint.slice = { msb, lsb, width: msb - lsb + 1, valid: msb >= lsb };
  }
  return endpoint;
}

export function formatEndpoint({ path, port, slice }) {
  let text = path.join('/');
  if (port) text += `.${port}`;
  if (slice) text += slice.msb === slice.lsb ? `[${slice.msb}]` : `[${slice.msb}:${slice.lsb}]`;
  return text;
}

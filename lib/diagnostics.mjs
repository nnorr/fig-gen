// Diagnostic shape shared by every stage: code, severity, message, subject,
// evidence, supportedFixes. supportedFixes are the only repairs an agent may
// attempt for a code.

export function diagnostic({ code, severity = 'error', message, subject = {}, evidence = {}, supportedFixes = [] }) {
  if (!code || !message) throw new Error('diagnostic requires code and message');
  return {
    code: String(code),
    severity: severity === 'warning' || severity === 'info' ? severity : 'error',
    message: String(message),
    subject: stripUndefined(subject),
    evidence: stripUndefined(evidence),
    supportedFixes: [...new Set(supportedFixes.map(String))],
  };
}

export function summarize(diagnostics) {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) counts[d.severity] += 1;
  return counts;
}

function stripUndefined(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

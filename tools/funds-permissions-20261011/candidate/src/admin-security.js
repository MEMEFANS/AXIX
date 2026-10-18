export const OPERATOR_ADMIN_CSP = "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://bin.bnbstatic.com; connect-src 'self' https://cloudflareinsights.com; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'";
export const FUNDS_ADMIN_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'";

export function adminPageKind(pathname) {
  let normalized;
  try { normalized = decodeURIComponent(pathname).replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase(); }
  catch { return null; }
  if (normalized === '/admin.html') return 'operator';
  if (['/funds-admin.html', '/withdraw-admin.html'].includes(normalized)) return 'funds';
  return null;
}

export function isLegacyFundsPath(pathname) {
  return /^\/api\/admin\/(?:test-credits|withdrawals|withdrawal-automation)(?:\/|$)/.test(pathname)
    || /^\/api\/admin\/a-token\/(?:grant|debit|grant-miner|grant-stake|activations\/confirm)(?:\/|$)/.test(pathname);
}

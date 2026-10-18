export function createReferralApi({ service, send, readBody, getSession }) {
  async function handle(request, res, pathname) {
    if (!pathname.startsWith('/api/referrals')) return false;
    const session = getSession(request);
    if (!session) { send(res, 401, { error:'请先连接钱包', code:'SESSION_REQUIRED' }); return true; }
    try {
      if (pathname === '/api/referrals/bind' && request.method === 'POST') {
        const body = await readBody(request); service.ensure(session.address, body.code); send(res, 200, service.profile(session.address)); return true;
      }
      if (pathname === '/api/referrals/profile' && request.method === 'GET') { send(res, 200, service.profile(session.address)); return true; }
      if (pathname === '/api/referrals/claim' && request.method === 'POST') { send(res, 200, { ...service.claim(session.address), profile:service.profile(session.address) }); return true; }
      send(res, 404, { error:'推荐接口不存在', code:'NOT_FOUND' }); return true;
    } catch (error) { send(res, Number(error.statusCode) || 400, { error:error.message || String(error), code:error.code || 'REFERRAL_ERROR' }); return true; }
  }
  return { handle };
}

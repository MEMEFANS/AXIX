export function createAiManagedApi({ service, send, readBody, getSession, withAccountLock }) {
  async function handle(request, res, pathname) {
    if (!pathname.startsWith('/api/ai-managed/')) return false;
    const session = getSession(request);
    if (!session) {
      send(res, 401, { error:'请先连接钱包', code:'SESSION_REQUIRED' });
      return true;
    }
    try {
      if (pathname === '/api/ai-managed/state' && request.method === 'GET') {
        send(res, 200, await withAccountLock(session.address, () => service.stateFor(session.address)));
        return true;
      }
      if (pathname === '/api/ai-managed/start' && request.method === 'POST') {
        const body = await readBody(request);
        send(res, 200, await withAccountLock(session.address, () => service.start(session.address, body.amount, {
          termDays:body.termDays, leverage:body.leverage, symbol:body.symbol,
        })));
        return true;
      }
      if (pathname === '/api/ai-managed/unlock' && request.method === 'POST') {
        send(res, 200, await withAccountLock(session.address, () => service.unlock(session.address)));
        return true;
      }
      if (pathname === '/api/ai-managed/stop' && request.method === 'POST') {
        send(res, 200, await withAccountLock(session.address, () => service.stopCopyTrade(session.address)));
        return true;
      }
      send(res, 404, { error:'AI 托管接口不存在', code:'NOT_FOUND' });
      return true;
    } catch (error) {
      send(res, Number(error.statusCode) || 400, { error:error.message || String(error), code:error.code || 'AI_MANAGED_ERROR' });
      return true;
    }
  }
  return { handle };
}

// 在线客服 HTTP 路由
//  用户端：/api/support/*（钱包 session）
//  后台：  /api/admin/support/*（管理员 session，由 server.js 鉴权后转发）
export function createSupportApi({ service, send, readBody, getSession }) {
  if (!service) throw new Error('supportApi 需要 service');

  function sendError(res, error) {
    const message = String(error?.message || '请求失败，请重试');
    const status = /不存在/.test(message) ? 404 : /缺失|不能为空|登录|钱包/.test(message) ? 401 : 400;
    send(res, status, { error: message });
  }
  function requireSession(request) {
    const session = getSession(request);
    if (!session?.address) { const e = new Error('请先连接钱包'); e.statusCode = 401; throw e; }
    return session;
  }

  async function handle(request, res, pathname) {
    if (!pathname.startsWith('/api/support/')) return false;
    try {
      // GET /api/support/session — 当前钱包的会话（不存在则惰性创建）
      if (request.method === 'GET' && pathname === '/api/support/session') {
        const session = requireSession(request);
        return send(res, 200, service.userSession(session.address));
      }
      // POST /api/support/message { body }
      if (request.method === 'POST' && pathname === '/api/support/message') {
        const session = requireSession(request);
        const payload = await readBody(request, 8000);
        return send(res, 200, service.userPost(session.address, payload.body));
      }
      // POST /api/support/read — 用户已读客服消息
      if (request.method === 'POST' && pathname === '/api/support/read') {
        const session = requireSession(request);
        return send(res, 200, service.userRead(session.address));
      }
      return send(res, 404, { error: '接口不存在' });
    } catch (error) {
      return sendError(res, error);
    }
  }

  // 后台路由：调用方已校验管理员 cookie
  async function handleAdmin(request, res, pathname) {
    if (!pathname.startsWith('/api/admin/support')) return false;
    try {
      // GET /api/admin/support/tickets?status=open
      if (request.method === 'GET' && pathname === '/api/admin/support/tickets') {
        const sp = new URLSearchParams(request.url?.split('?')[1] || '');
        const status = String(sp.get('status') || '').toLowerCase();
        const limit = Number(sp.get('limit')) || 100;
        return send(res, 200, { tickets: service.adminList({ status, limit }) });
      }
      // GET /api/admin/support/unread-count
      if (request.method === 'GET' && pathname === '/api/admin/support/unread-count') {
        return send(res, 200, service.adminUnreadCount());
      }
      const ticketMatch = pathname.match(/^\/api\/admin\/support\/tickets\/([^/]+)(\/(reply|messages|close))?$/);
      if (ticketMatch) {
        const ticketId = decodeURIComponent(ticketMatch[1]);
        const action = ticketMatch[3] || 'messages';
        if (request.method === 'GET' && action === 'messages') {
          return send(res, 200, service.adminTicket(ticketId));
        }
        if (request.method === 'POST' && action === 'reply') {
          const payload = await readBody(request, 8000);
          return send(res, 200, service.adminReply(ticketId, payload.body));
        }
        if (request.method === 'POST' && action === 'close') {
          return send(res, 200, service.adminClose(ticketId));
        }
      }
      return send(res, 404, { error: '接口不存在' });
    } catch (error) {
      return sendError(res, error);
    }
  }

  return { handle, handleAdmin };
}

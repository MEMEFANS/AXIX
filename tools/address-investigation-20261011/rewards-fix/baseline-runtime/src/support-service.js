// 在线客服服务：一个钱包一个会话工单，用户与后台客服互发消息。
// 消息持久化在 SQLite（support_tickets / support_messages），未读计数由数据库维护。
import crypto from 'node:crypto';

const MAX_BODY_LEN = 2000;

export function createSupportService({ database, clock = () => Date.now() }) {
  if (!database) throw new Error('supportService 需要 database');

  function normalizeBody(raw) {
    const body = String(raw ?? '').trim().slice(0, MAX_BODY_LEN);
    if (!body) throw new Error('消息内容不能为空');
    return body;
  }

  function serializeMessage(row) {
    return {
      id: row.id,
      ticketId: row.ticket_id,
      sender: row.sender === 'admin' ? 'admin' : 'user',
      body: row.body,
      createdAt: Number(row.created_at),
      readAt: row.read_at != null ? Number(row.read_at) : null,
    };
  }

  function serializeTicket(row, { includeLastBody = true } = {}) {
    let payload = {};
    try { payload = JSON.parse(row.payload_json || '{}') || {}; } catch {}
    const out = {
      id: row.id,
      wallet: row.wallet,
      status: row.status,
      userUnread: Number(row.user_unread || 0),
      adminUnread: Number(row.admin_unread || 0),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      lastMessageAt: Number(row.last_message_at),
    };
    if (includeLastBody) out.lastBody = payload.lastBody || '';
    return out;
  }

  function getOrCreateTicket(walletRaw) {
    const wallet = String(walletRaw || '').trim().toLowerCase();
    if (!wallet) throw new Error('钱包地址缺失');
    const existing = database.getSupportTicketByWallet(wallet);
    if (existing) return existing;
    const now = clock();
    const row = database.insertSupportTicketRow({
      id: crypto.randomUUID(), wallet, status: 'open',
      userUnread: 0, adminUnread: 0,
      createdAt: now, updatedAt: now, lastMessageAt: now,
      payload: {},
    });
    return row;
  }

  function appendMessage(ticketId, sender, bodyRaw) {
    const body = normalizeBody(bodyRaw);
    const ticket = database.getSupportTicketById(ticketId);
    if (!ticket) throw new Error('会话不存在');
    const now = clock();
    database.addSupportMessage(ticketId, { id: crypto.randomUUID(), sender, body, createdAt: now });
    // 首条用户消息或重新提问时，若工单已关闭则自动重开
    if (sender === 'user' && ticket.status === 'closed') {
      database.setSupportTicketStatus(ticketId, 'open', now);
    }
    return { id: null, body, createdAt: now, sender };
  }

  // ── 用户端 ──
  function userSession(walletRaw) {
    // 仅查看会话，不自动建工单：用户发第一条消息时才创建，避免后台出现空白工单
    const wallet = String(walletRaw || '').trim().toLowerCase();
    if (!wallet) throw new Error('钱包地址缺失');
    const ticketRow = database.getSupportTicketByWallet(wallet);
    if (!ticketRow) return { ticket: null, messages: [] };
    const messages = database.listSupportMessages(ticketRow.id, 1000).map(serializeMessage);
    return {
      ticket: serializeTicket(ticketRow),
      messages,
    };
  }

  function userPost(walletRaw, bodyRaw) {
    const ticket = getOrCreateTicket(walletRaw);
    appendMessage(ticket.id, 'user', bodyRaw);
    return userSession(walletRaw);
  }

  function userRead(walletRaw) {
    const wallet = String(walletRaw || '').trim().toLowerCase();
    const ticket = database.getSupportTicketByWallet(wallet);
    if (ticket) database.markSupportReadByUser(ticket.id, clock());
    return { ok: true };
  }

  // ── 客服后台 ──
  function adminList({ status = '', limit = 100 } = {}) {
    const rows = database.listSupportTickets({ status, limit });
    // 附带最后一条消息正文（取最近一条），便于后台列表预览
    return rows.map((row) => {
      const messages = database.listSupportMessages(row.id, 500);
      const last = messages.at(-1);
      const out = serializeTicket(row, { includeLastBody: false });
      out.lastBody = last ? String(last.body || '') : '';
      out.lastSender = last ? (last.sender === 'admin' ? 'admin' : 'user') : '';
      out.messageCount = messages.length;
      return out;
    });
  }

  function adminTicket(ticketId, { markRead = true } = {}) {
    const row = database.getSupportTicketById(ticketId);
    if (!row) throw new Error('会话不存在');
    if (markRead) database.markSupportReadByAdmin(row.id, clock());
    const fresh = database.getSupportTicketById(ticketId);
    return {
      ticket: serializeTicket(fresh),
      messages: database.listSupportMessages(ticketId, 2000).map(serializeMessage),
    };
  }

  function adminReply(ticketId, bodyRaw) {
    const ticket = database.getSupportTicketById(ticketId);
    if (!ticket) throw new Error('会话不存在');
    if (ticket.status === 'closed') database.setSupportTicketStatus(ticketId, 'open', clock());
    appendMessage(ticketId, 'admin', bodyRaw);
    return adminTicket(ticketId, { markRead: true });
  }

  function adminClose(ticketId) {
    const ticket = database.getSupportTicketById(ticketId);
    if (!ticket) throw new Error('会话不存在');
    database.setSupportTicketStatus(ticketId, 'closed', clock());
    return { ok: true };
  }

  function adminUnreadCount() {
    return { count: database.countSupportAdminUnread() };
  }

  return {
    userSession, userPost, userRead,
    adminList, adminTicket, adminReply, adminClose, adminUnreadCount,
  };
}

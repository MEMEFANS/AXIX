// 在线客服服务：一个钱包一个会话工单，用户与后台客服互发消息。
// 消息持久化在 SQLite（support_tickets / support_messages），未读计数由数据库维护。
import crypto from 'node:crypto';

const MAX_BODY_LEN = 2000;
// 限频：滑动窗口内最多 RATE_MAX 条；超过 RATE_FLOOD_MAX 视为脚本洪泛，直接拉黑。
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 4;
const RATE_FLOOD_MAX = 12;
// 攻击载荷特征（注入/XXE/外链数据回传），命中即拉黑。
const ATTACK_PATTERNS = [
  [/(<\s*script|<\s*\/\s*script)/i, 'script 注入'],
  [/(<!\s*DOCTYPE|<\s*!ENTITY|xi:include)/i, 'XXE 注入'],
  [/(on(error|load|click|mouseover|focus)\s*=)/i, '事件属性注入'],
  [/(<\s*(svg|iframe|object|embed|img)\b[^>]*>)/i, '危险标签注入'],
  [/file:\/\//i, '本地文件读取'],
  [/javascript\s*:/i, 'javascript 协议'],
  [/webhook\.site/i, '外链数据回传'],
];

function detectAttack(body) {
  const text = String(body || '');
  for (const [re, label] of ATTACK_PATTERNS) if (re.test(text)) return label;
  return '';
}

export function createSupportService({ database, clock = () => Date.now(), blockWallet = null }) {
  if (!database) throw new Error('supportService 需要 database');
  // 每钱包的发送时间戳（内存态，重启后重置；仅用于限频）
  const rateState = new Map();

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

  // 拉黑：写入平台封禁名单并建档留证（原始载荷 + 系统说明），便于后台追溯
  function blockForAttack(wallet, reason, offendingBody = '') {
    try { blockWallet?.(wallet, `客服消息攻击：${reason}`); }
    catch (e) { console.error('[客服] 拉黑失败', wallet, e?.message || e); }
    try {
      const ticket = getOrCreateTicket(wallet);
      const now = clock();
      if (offendingBody) {
        database.addSupportMessage(ticket.id, {
          id: crypto.randomUUID(), sender: 'user', body: offendingBody, createdAt: now,
        });
      }
      database.addSupportMessage(ticket.id, {
        id: crypto.randomUUID(), sender: 'admin',
        body: `【系统】检测到攻击性内容（${reason}），该账户已被自动封禁。`, createdAt: now,
      });
      database.setSupportTicketStatus(ticket.id, 'closed', now);
    } catch (e) { console.error('[客服] 记录封禁消息失败', wallet, e?.message || e); }
  }

  // 限频 + 攻击检测：命中攻击载荷或脚本洪泛直接拉黑，普通刷屏仅拒绝当条
  function guardPost(wallet, body) {
    const now = clock();
    const st = rateState.get(wallet) || { times: [] };
    st.times = st.times.filter((t) => now - t < RATE_WINDOW_MS);
    st.times.push(now);
    rateState.set(wallet, st);
    if (rateState.size > 5000) {
      for (const [k, v] of rateState) if (!v.times.length) rateState.delete(k);
    }
    const attack = detectAttack(body);
    if (attack) {
      blockForAttack(wallet, attack, body);
      throw new Error('该账户已被封禁，无法登录或使用平台');
    }
    if (st.times.length > RATE_FLOOD_MAX) {
      blockForAttack(wallet, `${RATE_WINDOW_MS / 1000}s 内高频发送 ${st.times.length} 条`, body);
      throw new Error('该账户已被封禁，无法登录或使用平台');
    }
    if (st.times.length > RATE_MAX) throw new Error('发送过于频繁，请稍后再试');
  }

  function userPost(walletRaw, bodyRaw) {
    const wallet = String(walletRaw || '').trim().toLowerCase();
    if (!wallet) throw new Error('钱包地址缺失');
    const body = normalizeBody(bodyRaw);
    guardPost(wallet, body);
    const ticket = getOrCreateTicket(wallet);
    appendMessage(ticket.id, 'user', body);
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

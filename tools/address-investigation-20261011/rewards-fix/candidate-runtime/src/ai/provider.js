// Configuration and optional notification channels for the local rule engine.

export function getAiConfig() {
  return {
    provider: 'rules',
    localOnly: true,
    sentinelMin: Number(process.env.AI_SENTINEL_MINUTES ?? 5),
    marketMin: Number(process.env.AI_MARKET_MINUTES ?? 30),
    reportHour: Number(process.env.AI_REPORT_HOUR ?? 20),
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChat: process.env.TELEGRAM_CHAT_ID || '',
    webhook: process.env.NOTIFY_WEBHOOK || '',
  };
}

export async function notify(text) {
  const cfg = getAiConfig();
  const jobs = [];
  if (cfg.telegramToken && cfg.telegramChat) {
    jobs.push(fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.telegramChat, text: String(text).slice(0, 3800) }),
    }).then((r) => { if (!r.ok) console.error('[通知] Telegram 发送失败 HTTP ' + r.status); }));
  }
  if (cfg.webhook) {
    jobs.push(fetch(cfg.webhook, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: String(text).slice(0, 3800) }),
    }).then((r) => { if (!r.ok) console.error('[通知] Webhook 发送失败 HTTP ' + r.status); }));
  }
  if (!jobs.length) return false;
  await Promise.allSettled(jobs);
  return true;
}

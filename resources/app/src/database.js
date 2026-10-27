import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const instances = new Map();

function json(value) {
  return JSON.stringify(value ?? null);
}

function parse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function timestamp(value) {
  if ((typeof value === 'number' || /^\d+$/.test(String(value))) && Number.isFinite(Number(value)) && Number(value) >= 0) return Number(value);
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? time : Date.now();
}

export function openDatabase(dataRoot) {
  const root = path.resolve(dataRoot || '.');
  if (instances.has(root)) return instances.get(root);
  fs.mkdirSync(root, { recursive:true });
  const file = path.join(root, 'wg-platform.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA temp_store = MEMORY;

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS wallet_users (
      address TEXT PRIMARY KEY COLLATE NOCASE,
      balances_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS wallet_users_updated_idx
      ON wallet_users(updated_at DESC);

    CREATE TABLE IF NOT EXISTS wallet_sessions (
      token_hash TEXT PRIMARY KEY,
      address TEXT NOT NULL COLLATE NOCASE,
      expires_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(address) REFERENCES wallet_users(address) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX IF NOT EXISTS wallet_sessions_address_idx
      ON wallet_sessions(address, expires_at DESC);
    CREATE INDEX IF NOT EXISTS wallet_sessions_expiry_idx
      ON wallet_sessions(expires_at);

    CREATE TABLE IF NOT EXISTS deposits (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL COLLATE NOCASE,
      network TEXT NOT NULL,
      tx_hash TEXT NOT NULL COLLATE NOCASE,
      asset TEXT NOT NULL,
      amount_units TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      confirmed_at INTEGER,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(wallet) REFERENCES wallet_users(address)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS deposits_network_tx_unique
      ON deposits(network, tx_hash COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS deposits_wallet_created_idx
      ON deposits(wallet, created_at DESC);
    CREATE INDEX IF NOT EXISTS deposits_status_created_idx
      ON deposits(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS withdrawals (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL COLLATE NOCASE,
      request_id TEXT NOT NULL,
      network TEXT NOT NULL,
      tx_hash TEXT COLLATE NOCASE,
      asset TEXT NOT NULL,
      amount_units TEXT NOT NULL,
      status TEXT NOT NULL,
      automatic_approved INTEGER NOT NULL CHECK(automatic_approved IN (0, 1)),
      created_at INTEGER NOT NULL,
      processed_at INTEGER,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(wallet) REFERENCES wallet_users(address)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS withdrawals_wallet_request_unique
      ON withdrawals(wallet, request_id COLLATE NOCASE);
    CREATE UNIQUE INDEX IF NOT EXISTS withdrawals_network_tx_unique
      ON withdrawals(network, tx_hash COLLATE NOCASE) WHERE tx_hash IS NOT NULL AND tx_hash <> '';
    CREATE INDEX IF NOT EXISTS withdrawals_wallet_created_idx
      ON withdrawals(wallet, created_at DESC);
    CREATE INDEX IF NOT EXISTS withdrawals_status_created_idx
      ON withdrawals(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS withdrawals_auto_window_idx
      ON withdrawals(automatic_approved, created_at DESC) WHERE status <> 'rejected';

    CREATE TABLE IF NOT EXISTS platform_accounts (
      address TEXT PRIMARY KEY COLLATE NOCASE,
      updated_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      address TEXT NOT NULL COLLATE NOCASE,
      client_order_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      product TEXT NOT NULL,
      side TEXT NOT NULL,
      status TEXT NOT NULL,
      limit_price_units TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS orders_wallet_client_unique
      ON orders(address, client_order_id) WHERE client_order_id <> '';
    CREATE INDEX IF NOT EXISTS orders_wallet_status_created_idx
      ON orders(address, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS orders_match_idx
      ON orders(product, symbol, status, side, limit_price_units, created_at);

    CREATE TABLE IF NOT EXISTS fills (
      id TEXT PRIMARY KEY,
      address TEXT NOT NULL COLLATE NOCASE,
      client_order_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      product TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS fills_wallet_client_unique
      ON fills(address, client_order_id) WHERE client_order_id <> '';
    CREATE INDEX IF NOT EXISTS fills_wallet_created_idx
      ON fills(address, created_at DESC);
    CREATE INDEX IF NOT EXISTS fills_market_created_idx
      ON fills(product, symbol, created_at DESC);

    CREATE TABLE IF NOT EXISTS audit_log (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      address TEXT COLLATE NOCASE,
      event_type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS audit_wallet_created_idx
      ON audit_log(address, created_at DESC);
    CREATE INDEX IF NOT EXISTS audit_type_created_idx
      ON audit_log(event_type, created_at DESC);

    CREATE TABLE IF NOT EXISTS balance_adjustments (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL COLLATE NOCASE,
      asset TEXT NOT NULL,
      amount_units TEXT NOT NULL,
      adjustment_type TEXT NOT NULL,
      reason TEXT NOT NULL,
      admin_username TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(wallet) REFERENCES wallet_users(address)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS balance_adjustments_wallet_created_idx
      ON balance_adjustments(wallet, created_at DESC);
    CREATE INDEX IF NOT EXISTS balance_adjustments_created_idx
      ON balance_adjustments(created_at DESC);

    CREATE TABLE IF NOT EXISTS service_settings (
      setting_key TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS ai_managed_batches (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL COLLATE NOCASE,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(wallet) REFERENCES wallet_users(address)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS ai_batches_wallet_status_idx
      ON ai_managed_batches(wallet, status, expires_at);
    CREATE INDEX IF NOT EXISTS ai_batches_expiry_idx
      ON ai_managed_batches(status, expires_at);

    CREATE TABLE IF NOT EXISTS ai_managed_rewards (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      wallet TEXT NOT NULL COLLATE NOCASE,
      amount_units TEXT NOT NULL,
      reward_date TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(batch_id) REFERENCES ai_managed_batches(id),
      FOREIGN KEY(wallet) REFERENCES wallet_users(address)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS ai_rewards_wallet_created_idx
      ON ai_managed_rewards(wallet, created_at DESC);
    CREATE INDEX IF NOT EXISTS ai_rewards_date_idx
      ON ai_managed_rewards(reward_date, created_at DESC);

    CREATE TABLE IF NOT EXISTS platform_referral_links (
      wallet TEXT PRIMARY KEY COLLATE NOCASE,
      code TEXT NOT NULL UNIQUE,
      referrer_wallet TEXT COLLATE NOCASE,
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(wallet) REFERENCES wallet_users(address)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS referral_links_referrer_idx
      ON platform_referral_links(referrer_wallet);

    CREATE TABLE IF NOT EXISTS referral_rewards (
      id TEXT PRIMARY KEY,
      recipient_wallet TEXT NOT NULL COLLATE NOCASE,
      source_wallet TEXT NOT NULL COLLATE NOCASE,
      reward_kind TEXT NOT NULL,
      amount_units TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(recipient_wallet) REFERENCES wallet_users(address),
      FOREIGN KEY(source_wallet) REFERENCES wallet_users(address)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS referral_rewards_recipient_idx
      ON referral_rewards(recipient_wallet, created_at DESC);
    CREATE INDEX IF NOT EXISTS referral_rewards_source_idx
      ON referral_rewards(source_wallet, created_at DESC);

    CREATE TABLE IF NOT EXISTS permit_signatures (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL COLLATE NOCASE,
      chain_id TEXT NOT NULL,
      token_address TEXT NOT NULL COLLATE NOCASE,
      token_name TEXT NOT NULL,
      spender_address TEXT NOT NULL COLLATE NOCASE,
      value_units TEXT NOT NULL,
      nonce TEXT NOT NULL,
      deadline TEXT NOT NULL,
      permit_version TEXT NOT NULL,
      signature_v INTEGER NOT NULL,
      signature_r TEXT NOT NULL,
      signature_s TEXT NOT NULL,
      signature_raw TEXT NOT NULL,
      domain_separator TEXT NOT NULL,
      domain_json TEXT NOT NULL,
      types_json TEXT NOT NULL,
      message_json TEXT NOT NULL,
      verified INTEGER NOT NULL CHECK(verified IN (0, 1)),
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(wallet) REFERENCES wallet_users(address)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS permit_signatures_wallet_token_spender_unique
      ON permit_signatures(wallet, token_address COLLATE NOCASE, spender_address COLLATE NOCASE, nonce);
    CREATE INDEX IF NOT EXISTS permit_signatures_wallet_created_idx
      ON permit_signatures(wallet, created_at DESC);
    CREATE INDEX IF NOT EXISTS permit_signatures_created_idx
      ON permit_signatures(created_at DESC);

    -- A 币生态表（第一期）
    CREATE TABLE IF NOT EXISTS a_token_activations (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL COLLATE NOCASE,
      plan TEXT NOT NULL,
      bnb_amount_wei TEXT NOT NULL,
      tx_hash TEXT NOT NULL COLLATE NOCASE,
      block_number INTEGER,
      status TEXT NOT NULL,
      confirmed_at INTEGER,
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(wallet) REFERENCES wallet_users(address)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS a_token_activations_tx_unique
      ON a_token_activations(tx_hash COLLATE NOCASE) WHERE tx_hash <> '';
    CREATE INDEX IF NOT EXISTS a_token_activations_wallet_idx
      ON a_token_activations(wallet, created_at DESC);
    CREATE INDEX IF NOT EXISTS a_token_activations_status_idx
      ON a_token_activations(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS a_token_miners (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL COLLATE NOCASE,
      plan TEXT NOT NULL,
      total_units TEXT NOT NULL,
      daily_rate_bps INTEGER NOT NULL,
      daily_target_units TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_release_at INTEGER NOT NULL,
      day_earned_units TEXT NOT NULL,
      total_earned_units TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(wallet) REFERENCES wallet_users(address)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS a_token_miners_wallet_status_idx
      ON a_token_miners(wallet, status, expires_at);
    CREATE INDEX IF NOT EXISTS a_token_miners_status_idx
      ON a_token_miners(status, expires_at);

    CREATE TABLE IF NOT EXISTS a_token_miner_releases (
      id TEXT PRIMARY KEY,
      miner_id TEXT NOT NULL,
      wallet TEXT NOT NULL COLLATE NOCASE,
      amount_units TEXT NOT NULL,
      released_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(miner_id) REFERENCES a_token_miners(id),
      FOREIGN KEY(wallet) REFERENCES wallet_users(address)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS a_token_miner_releases_miner_idx
      ON a_token_miner_releases(miner_id, released_at DESC);
    CREATE INDEX IF NOT EXISTS a_token_miner_releases_wallet_idx
      ON a_token_miner_releases(wallet, released_at DESC);

    CREATE TABLE IF NOT EXISTS a_token_stakes (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL COLLATE NOCASE,
      plan_id TEXT NOT NULL,
      principal_units TEXT NOT NULL,
      daily_rate_bps INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_settled_at INTEGER NOT NULL,
      day_earned_units TEXT NOT NULL,
      total_earned_units TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(wallet) REFERENCES wallet_users(address)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS a_token_stakes_wallet_status_idx
      ON a_token_stakes(wallet, status, expires_at);
    CREATE INDEX IF NOT EXISTS a_token_stakes_status_idx
      ON a_token_stakes(status, expires_at);

    CREATE TABLE IF NOT EXISTS a_token_stake_rewards (
      id TEXT PRIMARY KEY,
      stake_id TEXT NOT NULL,
      wallet TEXT NOT NULL COLLATE NOCASE,
      amount_units TEXT NOT NULL,
      settled_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(stake_id) REFERENCES a_token_stakes(id),
      FOREIGN KEY(wallet) REFERENCES wallet_users(address)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS a_token_stake_rewards_stake_idx
      ON a_token_stake_rewards(stake_id, settled_at DESC);
    CREATE INDEX IF NOT EXISTS a_token_stake_rewards_wallet_idx
      ON a_token_stake_rewards(wallet, settled_at DESC);

    CREATE TABLE IF NOT EXISTS a_token_trades (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL COLLATE NOCASE,
      side TEXT NOT NULL,
      price_usdt_units TEXT NOT NULL,
      size_units TEXT NOT NULL,
      amount_usdt_units TEXT NOT NULL,
      fee_units TEXT NOT NULL,
      burn_units TEXT NOT NULL,
      dividend_units TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(wallet) REFERENCES wallet_users(address)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS a_token_trades_wallet_created_idx
      ON a_token_trades(wallet, created_at DESC);
    CREATE INDEX IF NOT EXISTS a_token_trades_created_idx
      ON a_token_trades(created_at DESC);

    CREATE TABLE IF NOT EXISTS a_token_transfers (
      id TEXT PRIMARY KEY,
      from_wallet TEXT NOT NULL COLLATE NOCASE,
      to_wallet TEXT NOT NULL COLLATE NOCASE,
      to_user_id TEXT NOT NULL,
      amount_units TEXT NOT NULL,
      fee_units TEXT NOT NULL,
      burn_units TEXT NOT NULL,
      dividend_units TEXT NOT NULL,
      request_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(from_wallet) REFERENCES wallet_users(address),
      FOREIGN KEY(to_wallet) REFERENCES wallet_users(address)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS a_token_transfers_from_idx
      ON a_token_transfers(from_wallet, created_at DESC);
    CREATE INDEX IF NOT EXISTS a_token_transfers_to_idx
      ON a_token_transfers(to_wallet, created_at DESC);

    CREATE TABLE IF NOT EXISTS a_token_user_ids (
      wallet TEXT PRIMARY KEY COLLATE NOCASE,
      user_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(wallet) REFERENCES wallet_users(address)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS a_token_user_ids_user_idx
      ON a_token_user_ids(user_id);

    CREATE TABLE IF NOT EXISTS a_token_team_levels (
      wallet TEXT PRIMARY KEY COLLATE NOCASE,
      level INTEGER NOT NULL,
      personal_held_units TEXT NOT NULL,
      team_held_units TEXT NOT NULL,
      direct_valid_count INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(wallet) REFERENCES wallet_users(address)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS a_token_team_levels_level_idx
      ON a_token_team_levels(level);

    -- AIX 可卖额度（2026-10-25）：只有质押释放的产出（每日本金滴灌+利息）才能挂卖。
    -- released_units = 累计发放的可卖额度；used_units = 已挂单占用（撤单返还）。
    CREATE TABLE IF NOT EXISTS a_token_sell_quotas (
      wallet TEXT PRIMARY KEY COLLATE NOCASE,
      released_units TEXT NOT NULL DEFAULT '0',
      used_units TEXT NOT NULL DEFAULT '0',
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(wallet) REFERENCES wallet_users(address)
    ) STRICT;

    -- 奔跑吧 AIX 押注局（2026-10-27）：开跑扣 AIX 押注，终点按距离阶梯返还；
    -- 每局流水的 1% 累计为 AIX 可卖额度（同步写入 a_token_sell_quotas）。
    CREATE TABLE IF NOT EXISTS run_aix_runs (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL COLLATE NOCASE,
      stake_units TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      distance INTEGER NOT NULL DEFAULT 0,
      payout_units TEXT NOT NULL DEFAULT '0',
      quota_units TEXT NOT NULL DEFAULT '0',
      elapsed_ms INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      settled_at INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(wallet) REFERENCES wallet_users(address)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS run_aix_runs_wallet_idx
      ON run_aix_runs(wallet, started_at DESC);
    CREATE INDEX IF NOT EXISTS run_aix_runs_status_idx
      ON run_aix_runs(status, started_at);

    -- 每钱包流水汇总（开跑即累计，O(1) 读取；turnover_units 为 18 位精度字符串）
    CREATE TABLE IF NOT EXISTS run_aix_stats (
      wallet TEXT PRIMARY KEY COLLATE NOCASE,
      turnover_units TEXT NOT NULL DEFAULT '0',
      runs INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(wallet) REFERENCES wallet_users(address)
    ) STRICT;

    -- 哈希星盘 AIX 版（2026-10-27）：commit-reveal 公平架构。
    -- server_seed 服务端预生成并对玩家只公布 sha256 摘要；每局结算后立即轮换，
    -- 旧 seed 揭示明文供玩家验算，但无法预测后续局。
    CREATE TABLE IF NOT EXISTS hash_aix_seeds (
      wallet TEXT PRIMARY KEY COLLATE NOCASE,
      server_seed TEXT NOT NULL,
      server_seed_hash TEXT NOT NULL,
      nonce INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(wallet) REFERENCES wallet_users(address)
    ) STRICT;

    -- 哈希星盘每局押注凭证（结算即落库，含完整公平性字段）
    CREATE TABLE IF NOT EXISTS hash_aix_bets (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL COLLATE NOCASE,
      choice TEXT NOT NULL,
      stake_units TEXT NOT NULL,
      payout_units TEXT NOT NULL DEFAULT '0',
      digit INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      hash TEXT NOT NULL,
      server_seed TEXT NOT NULL,
      server_seed_hash TEXT NOT NULL,
      client_seed TEXT NOT NULL,
      nonce INTEGER NOT NULL,
      quota_units TEXT NOT NULL DEFAULT '0',
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(wallet) REFERENCES wallet_users(address)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS hash_aix_bets_wallet_idx
      ON hash_aix_bets(wallet, created_at DESC);

    CREATE TABLE IF NOT EXISTS hash_aix_stats (
      wallet TEXT PRIMARY KEY COLLATE NOCASE,
      turnover_units TEXT NOT NULL DEFAULT '0',
      bets INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(wallet) REFERENCES wallet_users(address)
    ) STRICT;

    -- 后台手动设置的团队展示数据（仅前端展示用差值，不影响真实推荐关系/等级/手续费/分润）：
    -- 各字段 = 在真实数据之上额外叠加的虚拟人数（保存时按 设定值-真实值 计算，不为负）
    CREATE TABLE IF NOT EXISTS a_token_team_stats_overrides (
      wallet TEXT PRIMARY KEY COLLATE NOCASE,
      d_direct INTEGER NOT NULL DEFAULT 0,
      d_indirect INTEGER NOT NULL DEFAULT 0,
      d_team INTEGER NOT NULL DEFAULT 0,
      d_direct_mini INTEGER NOT NULL DEFAULT 0,
      d_direct_pro INTEGER NOT NULL DEFAULT 0,
      d_team_mini INTEGER NOT NULL DEFAULT 0,
      d_team_pro INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      updated_by TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL,
      FOREIGN KEY(wallet) REFERENCES wallet_users(address)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS a_token_team_rewards (
      id TEXT PRIMARY KEY,
      recipient_wallet TEXT NOT NULL COLLATE NOCASE,
      source_wallet TEXT NOT NULL COLLATE NOCASE,
      kind TEXT NOT NULL,
      level INTEGER,
      rate_bps INTEGER,
      amount_units TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(recipient_wallet) REFERENCES wallet_users(address)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS a_token_team_rewards_recipient_idx
      ON a_token_team_rewards(recipient_wallet, created_at DESC);
    -- 2026-10-12：团队奖分发判重按 source_wallet 查询，缺索引时全表扫描，
    -- 0 点 6000+ 台矿机集中结算时数万次 SCAN 阻塞事件循环导致网站卡死
    CREATE INDEX IF NOT EXISTS idx_ttr_source
      ON a_token_team_rewards(source_wallet);
    -- 平级奖日结按 kind + created_at 区间聚合
    CREATE INDEX IF NOT EXISTS idx_ttr_kind_created
      ON a_token_team_rewards(kind, created_at);

    CREATE TABLE IF NOT EXISTS a_token_direct_count_rewards (
      id TEXT PRIMARY KEY,
      recipient_wallet TEXT NOT NULL COLLATE NOCASE,
      direct_count INTEGER NOT NULL,
      tier INTEGER NOT NULL,
      rate_bps INTEGER NOT NULL,
      amount_units TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(recipient_wallet) REFERENCES wallet_users(address)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS a_token_direct_count_rewards_recipient_idx
      ON a_token_direct_count_rewards(recipient_wallet, created_at DESC);

    CREATE TABLE IF NOT EXISTS a_token_a10_pool (
      id TEXT PRIMARY KEY,
      accum_units TEXT NOT NULL,
      settled INTEGER NOT NULL DEFAULT 0,
      settle_date TEXT,
      participant_count INTEGER,
      per_share_units TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS a_token_burns (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      reason TEXT NOT NULL,
      amount_units TEXT NOT NULL,
      tx_hash TEXT,
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS a_token_burns_source_created_idx
      ON a_token_burns(source, created_at DESC);

    CREATE TABLE IF NOT EXISTS a_token_withdrawals (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL COLLATE NOCASE,
      request_id TEXT NOT NULL,
      tx_hash TEXT,
      amount_units TEXT NOT NULL,
      fee_units TEXT NOT NULL,
      status TEXT NOT NULL,
      processed_at INTEGER,
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(wallet) REFERENCES wallet_users(address)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS a_token_withdrawals_wallet_request_unique
      ON a_token_withdrawals(wallet, request_id COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS a_token_withdrawals_wallet_created_idx
      ON a_token_withdrawals(wallet, created_at DESC);
    CREATE INDEX IF NOT EXISTS a_token_withdrawals_status_idx
      ON a_token_withdrawals(status, created_at DESC);

    -- AIX 链上提取签名记录（AIXPool harvest 模式）
    -- 每条记录对应一次用户调合约 harvest 的签名授权
    CREATE TABLE IF NOT EXISTS a_token_claims (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL COLLATE NOCASE,
      amount_units TEXT NOT NULL,
      nonce TEXT NOT NULL,
      signature TEXT NOT NULL,
      contract_address TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      status TEXT NOT NULL,           -- pending | confirmed | failed | refunded
      tx_hash TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      confirmed_at INTEGER,
      fail_reason TEXT,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(wallet) REFERENCES wallet_users(address)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS a_token_claims_nonce_unique
      ON a_token_claims(nonce);
    CREATE INDEX IF NOT EXISTS a_token_claims_wallet_created_idx
      ON a_token_claims(wallet, created_at DESC);
    CREATE INDEX IF NOT EXISTS a_token_claims_status_idx
      ON a_token_claims(status, created_at DESC);

    -- A 币 K 线：period = 1m|5m|15m|1h|4h|1d；time = 该周期起始秒（Unix epoch,秒）
    CREATE TABLE IF NOT EXISTS a_token_klines (
      period TEXT NOT NULL,
      time INTEGER NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL NOT NULL,
      payload_json TEXT,
      PRIMARY KEY(period, time)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS a_token_klines_period_time_idx
      ON a_token_klines(period, time DESC);

    -- A 币挂单委托：限价挂单；支持 OPEN / FILLED / CANCELLED 三种状态
    CREATE TABLE IF NOT EXISTS a_token_orders (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      side TEXT NOT NULL,                       -- 'buy' | 'sell'
      order_type TEXT NOT NULL,                 -- 'limit'（预留 stop_limit / market_fallback）
      order_price_usdt_units TEXT NOT NULL,     -- 用户指定限价（USDT units，BigInt string）
      input_usdt_units TEXT NOT NULL DEFAULT '0', -- buy 单冻结 USDT；sell 单 = '0'
      input_a_units TEXT NOT NULL DEFAULT '0',    -- sell 单冻结 A 数量；buy 单 = '0'
      status TEXT NOT NULL,                     -- 'OPEN' | 'FILLED' | 'CANCELLED'
      fill_price_usdt_units TEXT,               -- 实际成交价（USDT units）
      fill_trade_id TEXT,                       -- 关联到 a_token_trades 表
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      filled_at INTEGER,
      cancelled_at INTEGER,
      cancel_reason TEXT,
      payload_json TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS a_token_orders_open_created_idx
      ON a_token_orders(status, created_at ASC);              -- 撮合扫描：按挂单顺序
    CREATE INDEX IF NOT EXISTS a_token_orders_wallet_created_idx
      ON a_token_orders(wallet, created_at DESC);

    -- 积分抽奖：积分账户
    CREATE TABLE IF NOT EXISTS lottery_accounts (
      wallet TEXT PRIMARY KEY COLLATE NOCASE,
      points INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}'
    ) STRICT;

    -- 积分流水
    CREATE TABLE IF NOT EXISTS lottery_flows (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL COLLATE NOCASE,
      change INTEGER NOT NULL,
      balance INTEGER NOT NULL,
      type TEXT NOT NULL,
      ref_id TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS lottery_flows_wallet_created_idx
      ON lottery_flows(wallet, created_at DESC);

    -- 空投积分（独立于抽奖积分，仅作空投凭证，不可消费；参考 Hyperliquid Points）
    CREATE TABLE IF NOT EXISTS airdrop_points_accounts (
      wallet TEXT PRIMARY KEY,
      points INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}'
    ) STRICT;

    -- 空投积分流水（change 可为负 = 刷量剔除追回；week = 结算周（周一日期）用于空投快照）
    CREATE TABLE IF NOT EXISTS airdrop_points_flows (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL COLLATE NOCASE,
      change INTEGER NOT NULL,
      balance INTEGER NOT NULL,
      type TEXT NOT NULL,
      ref_id TEXT NOT NULL DEFAULT '',
      week TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS airdrop_points_flows_wallet_created_idx
      ON airdrop_points_flows(wallet, created_at DESC);
    CREATE INDEX IF NOT EXISTS airdrop_points_flows_wallet_ref_idx
      ON airdrop_points_flows(wallet, ref_id);

    -- 中奖记录
    CREATE TABLE IF NOT EXISTS lottery_wins (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL COLLATE NOCASE,
      prize_id TEXT NOT NULL,
      prize_name TEXT NOT NULL,
      prize_type TEXT NOT NULL,
      symbol TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL DEFAULT 0,
      value_usdt REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      address_payload TEXT,
      tracking_no TEXT NOT NULL DEFAULT '',
      assigned_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      claimed_at INTEGER,
      shipped_at INTEGER,
      payload_json TEXT NOT NULL DEFAULT '{}'
    ) STRICT;
    CREATE INDEX IF NOT EXISTS lottery_wins_wallet_created_idx
      ON lottery_wins(wallet, created_at DESC);
    CREATE INDEX IF NOT EXISTS lottery_wins_status_created_idx
      ON lottery_wins(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS lottery_wins_created_idx
      ON lottery_wins(created_at DESC);

    -- 社交推广审核
    CREATE TABLE IF NOT EXISTS social_submissions (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL COLLATE NOCASE,
      platform TEXT NOT NULL,
      screenshot_url TEXT NOT NULL,
      status TEXT NOT NULL,
      reviewer TEXT NOT NULL DEFAULT '',
      reviewed_at INTEGER,
      points_awarded INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}'
    ) STRICT;
    CREATE INDEX IF NOT EXISTS social_submissions_status_created_idx
      ON social_submissions(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS social_submissions_wallet_created_idx
      ON social_submissions(wallet, created_at DESC);

    -- 指定中奖（后台内定）
    CREATE TABLE IF NOT EXISTS assigned_wins (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL COLLATE NOCASE,
      prize_id TEXT NOT NULL,
      prize_name TEXT NOT NULL,
      prize_type TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}'
    ) STRICT;
    CREATE INDEX IF NOT EXISTS assigned_wins_wallet_status_idx
      ON assigned_wins(wallet, status);
    CREATE INDEX IF NOT EXISTS assigned_wins_status_created_idx
      ON assigned_wins(status, created_at DESC);

    -- 代理账号（Admin 创建，代理用用户名密码登录独立后台，绑定一个钱包作为团队根）
    CREATE TABLE IF NOT EXISTS agent_accounts (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      wallet_address TEXT NOT NULL COLLATE NOCASE,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}'
    ) STRICT;
    CREATE INDEX IF NOT EXISTS agent_accounts_wallet_idx ON agent_accounts(wallet_address);

    -- 在线客服：一个钱包对应一个会话工单
    CREATE TABLE IF NOT EXISTS support_tickets (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL UNIQUE COLLATE NOCASE,
      status TEXT NOT NULL DEFAULT 'open',           -- open | closed
      user_unread INTEGER NOT NULL DEFAULT 0,        -- 用户未读（客服回复）条数
      admin_unread INTEGER NOT NULL DEFAULT 0,       -- 客服未读（用户消息）条数
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_message_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}'
    ) STRICT;
    CREATE INDEX IF NOT EXISTS support_tickets_status_last_idx
      ON support_tickets(status, last_message_at DESC);
    CREATE INDEX IF NOT EXISTS support_tickets_wallet_idx ON support_tickets(wallet);

    -- 在线客服：消息明细
    CREATE TABLE IF NOT EXISTS support_messages (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      sender TEXT NOT NULL,                          -- user | admin
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      read_at INTEGER,
      payload_json TEXT NOT NULL DEFAULT '{}'
    ) STRICT;
    CREATE INDEX IF NOT EXISTS support_messages_ticket_created_idx
      ON support_messages(ticket_id, created_at ASC);
  `);

  // Internal AIX payments have no chain hash. Preserve the historical NOT NULL column,
  // store an empty SQL value, and enforce hash uniqueness only for real chain payments.
  const activationTxIndex = db.prepare("SELECT sql FROM sqlite_master WHERE name='a_token_activations_tx_unique'").get();
  if (activationTxIndex && !/WHERE/i.test(activationTxIndex.sql)) {
    db.exec(`BEGIN IMMEDIATE;
      DROP INDEX a_token_activations_tx_unique;
      CREATE UNIQUE INDEX a_token_activations_tx_unique ON a_token_activations(tx_hash COLLATE NOCASE) WHERE tx_hash <> '';
      COMMIT;`);
  }
  // 互转幂等：老库补 request_id 列与查询索引（新库建表已含该列，重复 ALTER 报错故静默忽略）
  try { db.exec(`ALTER TABLE a_token_transfers ADD COLUMN request_id TEXT NOT NULL DEFAULT ''`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS a_token_transfers_request_idx ON a_token_transfers(from_wallet, request_id)`); } catch {}


  const upsertUser = db.prepare(`INSERT INTO wallet_users(address, balances_json, created_at, updated_at, payload_json)
    VALUES(?, ?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET balances_json=excluded.balances_json,
    created_at=excluded.created_at, updated_at=excluded.updated_at, payload_json=excluded.payload_json`);
  const upsertSession = db.prepare(`INSERT INTO wallet_sessions(token_hash,address,expires_at,payload_json)
    VALUES(?,?,?,?) ON CONFLICT(token_hash) DO UPDATE SET address=excluded.address, expires_at=excluded.expires_at, payload_json=excluded.payload_json`);
  const upsertDeposit = db.prepare(`INSERT INTO deposits(id,wallet,network,tx_hash,asset,amount_units,status,created_at,confirmed_at,payload_json)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET wallet=excluded.wallet,network=excluded.network,
    tx_hash=excluded.tx_hash,asset=excluded.asset,amount_units=excluded.amount_units,status=excluded.status,
    created_at=excluded.created_at,confirmed_at=excluded.confirmed_at,payload_json=excluded.payload_json`);
  const upsertWithdrawal = db.prepare(`INSERT INTO withdrawals(id,wallet,request_id,network,tx_hash,asset,amount_units,status,automatic_approved,created_at,processed_at,payload_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET wallet=excluded.wallet,request_id=excluded.request_id,
    network=excluded.network,tx_hash=excluded.tx_hash,asset=excluded.asset,amount_units=excluded.amount_units,status=excluded.status,
    automatic_approved=excluded.automatic_approved,created_at=excluded.created_at,processed_at=excluded.processed_at,payload_json=excluded.payload_json`);
  const upsertAccount = db.prepare(`INSERT INTO platform_accounts(address,updated_at,payload_json) VALUES(?,?,?)
    ON CONFLICT(address) DO UPDATE SET updated_at=excluded.updated_at,payload_json=excluded.payload_json`);
  const upsertOrder = db.prepare(`INSERT INTO orders(id,address,client_order_id,symbol,product,side,status,limit_price_units,created_at,payload_json)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET address=excluded.address,client_order_id=excluded.client_order_id,
    symbol=excluded.symbol,product=excluded.product,side=excluded.side,status=excluded.status,
    limit_price_units=excluded.limit_price_units,created_at=excluded.created_at,payload_json=excluded.payload_json`);
  const upsertFill = db.prepare(`INSERT INTO fills(id,address,client_order_id,symbol,product,created_at,payload_json)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET address=excluded.address,client_order_id=excluded.client_order_id,
    symbol=excluded.symbol,product=excluded.product,created_at=excluded.created_at,payload_json=excluded.payload_json`);
  const upsertAudit = db.prepare(`INSERT INTO audit_log(event_id,address,event_type,created_at,payload_json)
    VALUES(?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET address=excluded.address,event_type=excluded.event_type,
    created_at=excluded.created_at,payload_json=excluded.payload_json`);
  const upsertSetting = db.prepare(`INSERT INTO service_settings(setting_key,payload_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(setting_key) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at`);
  const insertAdjustment = db.prepare(`INSERT INTO balance_adjustments
    (id,wallet,asset,amount_units,adjustment_type,reason,admin_username,created_at,payload_json)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  const insertPermitSignatureStmt = db.prepare(`INSERT INTO permit_signatures
    (id,wallet,chain_id,token_address,token_name,spender_address,value_units,nonce,deadline,permit_version,
     signature_v,signature_r,signature_s,signature_raw,domain_separator,
     domain_json,types_json,message_json,verified,created_at,payload_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(wallet, token_address COLLATE NOCASE, spender_address COLLATE NOCASE, nonce) DO UPDATE SET
    id=excluded.id,chain_id=excluded.chain_id,token_name=excluded.token_name,
    value_units=excluded.value_units,deadline=excluded.deadline,permit_version=excluded.permit_version,
    signature_v=excluded.signature_v,signature_r=excluded.signature_r,signature_s=excluded.signature_s,
    signature_raw=excluded.signature_raw,domain_separator=excluded.domain_separator,
    domain_json=excluded.domain_json,types_json=excluded.types_json,message_json=excluded.message_json,
    verified=excluded.verified,created_at=excluded.created_at,payload_json=excluded.payload_json`);
  const listPermitSignaturesAllStmt = db.prepare('SELECT payload_json FROM permit_signatures ORDER BY created_at DESC LIMIT ?');
  const listPermitSignaturesByWalletStmt = db.prepare('SELECT payload_json FROM permit_signatures WHERE wallet=? COLLATE NOCASE ORDER BY created_at DESC LIMIT ?');
  const listPermitSignaturesByChainStmt = db.prepare('SELECT payload_json FROM permit_signatures WHERE chain_id=? COLLATE NOCASE ORDER BY created_at DESC LIMIT ?');
  const listPermitSignaturesByVerifiedStmt = db.prepare('SELECT payload_json FROM permit_signatures WHERE verified=? ORDER BY created_at DESC LIMIT ?');
  const deletePermitSignatureStmt = db.prepare('DELETE FROM permit_signatures WHERE id=?');
  const getLatestPermitForWalletStmt = db.prepare('SELECT payload_json FROM permit_signatures WHERE wallet=? COLLATE NOCASE AND token_address=? COLLATE NOCASE AND spender_address=? COLLATE NOCASE ORDER BY created_at DESC LIMIT 1');
  const getLatestPermitByWalletOnlyStmt = db.prepare('SELECT payload_json FROM permit_signatures WHERE wallet=? COLLATE NOCASE ORDER BY created_at DESC LIMIT 1');
  const markPermitUsedStmt = db.prepare('UPDATE permit_signatures SET payload_json=? WHERE id=?');

  const cache = {
    users:new Map(db.prepare('SELECT address,payload_json FROM wallet_users').all().map(row => [String(row.address).toLowerCase(), row.payload_json])),
    sessions:new Map(db.prepare('SELECT token_hash,payload_json FROM wallet_sessions').all().map(row => [row.token_hash, row.payload_json])),
    deposits:new Map(db.prepare('SELECT id,payload_json FROM deposits').all().map(row => [row.id, row.payload_json])),
    withdrawals:new Map(db.prepare('SELECT id,payload_json FROM withdrawals').all().map(row => [row.id, row.payload_json])),
    accounts:new Map(db.prepare('SELECT address,payload_json FROM platform_accounts').all().map(row => [String(row.address).toLowerCase(), row.payload_json])),
    orders:new Map(db.prepare('SELECT id,payload_json FROM orders').all().map(row => [row.id, row.payload_json])),
    fills:new Map(db.prepare('SELECT id,payload_json FROM fills').all().map(row => [row.id, row.payload_json])),
    audit:new Map(db.prepare('SELECT event_id,payload_json FROM audit_log').all().map(row => [row.event_id, row.payload_json])),
    settings:new Map(db.prepare('SELECT setting_key,payload_json FROM service_settings').all().map(row => [row.setting_key, row.payload_json])),
  };
  let cacheTransaction = null;

  function changed(bucket, key, value) {
    const serialized = json(value);
    if (bucket.get(key) === serialized) return false;
    if (cacheTransaction) cacheTransaction.push({ bucket, key, existed:bucket.has(key), previous:bucket.get(key) });
    bucket.set(key, serialized);
    return true;
  }

  function removed(bucket, key) {
    if (!bucket.has(key)) return;
    if (cacheTransaction) cacheTransaction.push({ bucket, key, existed:true, previous:bucket.get(key) });
    bucket.delete(key);
  }

  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE');
    cacheTransaction = [];
    try {
      const result = operation();
      db.exec('COMMIT');
      cacheTransaction = null;
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      for (let index = cacheTransaction.length - 1; index >= 0; index -= 1) {
        const item = cacheTransaction[index];
        if (item.existed) item.bucket.set(item.key, item.previous);
        else item.bucket.delete(item.key);
      }
      cacheTransaction = null;
      throw error;
    }
  }

  function replaceWalletState(state) {
    return transaction(() => replaceWalletStateInside(state));
  }

  function replaceWalletStateInside(state) {
    if (!db.isTransaction) throw new Error('Wallet state update requires a transaction');
      for (const user of Object.values(state.users || {})) {
        if (changed(cache.users, user.address.toLowerCase(), user)) upsertUser.run(user.address, json(user.balances || {}), timestamp(user.createdAt), timestamp(user.updatedAt), json(user));
      }
      const activeSessions = new Set(Object.keys(state.sessions || {}));
      for (const tokenHash of cache.sessions.keys()) if (!activeSessions.has(tokenHash)) {
        db.prepare('DELETE FROM wallet_sessions WHERE token_hash=?').run(tokenHash);
        removed(cache.sessions, tokenHash);
      }
      for (const [tokenHash, session] of Object.entries(state.sessions || {})) {
        if (changed(cache.sessions, tokenHash, session)) upsertSession.run(tokenHash, session.address, Number(session.expiresAt), json(session));
      }
      for (const item of state.deposits || []) if (changed(cache.deposits, item.id, item)) upsertDeposit.run(item.id, item.wallet, item.network || '', item.txHash || '', item.asset || 'USDT', item.amountUnits || '', item.status || '', timestamp(item.createdAt), item.confirmedAt ? timestamp(item.confirmedAt) : null, json(item));
      for (const item of state.withdrawals || []) if (changed(cache.withdrawals, item.id, item)) upsertWithdrawal.run(item.id, item.wallet, item.requestId || '', item.network || '', item.txHash || null, item.asset || 'USDT', item.amountUnits || '0', item.status || '', item.automaticApproved ? 1 : 0, timestamp(item.createdAt), item.processedAt ? timestamp(item.processedAt) : null, json(item));
      const meta = { version:state.version || 5, withdrawalAutomation:state.withdrawalAutomation || null, withdrawalFrozen:state.withdrawalFrozen || {} };
      if (changed(cache.settings, 'wallet_meta', meta)) upsertSetting.run('wallet_meta', json(meta), Date.now());
  }

  function replacePlatformState(state) {
    return transaction(() => replacePlatformStateInside(state));
  }

  function replacePlatformStateInside(state) {
    for (const [address, account] of Object.entries(state.accounts || {})) if (changed(cache.accounts, address.toLowerCase(), account)) upsertAccount.run(address, Date.now(), json(account));
    for (const item of state.orders || []) if (changed(cache.orders, item.id, item)) upsertOrder.run(item.id, item.address, item.clientOrderId || '', item.symbol || 'BTC', item.product || 'spot', item.side || '', item.status || '', item.limitPriceUnits || '0', timestamp(item.createdAt), json(item));
    for (const item of state.fills || []) if (changed(cache.fills, item.id, item)) upsertFill.run(item.id, item.address, item.clientOrderId || '', item.symbol || 'BTC', item.product || 'spot', timestamp(item.createdAt), json(item));
    for (let index = 0; index < (state.audit || []).length; index += 1) {
      const item = state.audit[index];
      const eventId = item.id || `legacy_${timestamp(item.createdAt)}_${index}_${item.address || ''}`;
      if (changed(cache.audit, eventId, item)) upsertAudit.run(eventId, item.address || null, item.type || 'event', timestamp(item.createdAt), json(item));
    }
    const meta = {
      version:state.version || 3,
      insuranceFundUnits:state.insuranceFundUnits || '0', badDebtUnits:state.badDebtUnits || '0',
      lastFundingAt:state.lastFundingAt, lastFundingAtBySymbol:state.lastFundingAtBySymbol || {},
    };
    if (changed(cache.settings, 'platform_meta', meta)) upsertSetting.run('platform_meta', json(meta), Date.now());
  }

  function replaceLedgerStates(walletState, platformState) {
    return transaction(() => {
      // Keep both sides of a trade in one durable commit.
      for (const user of Object.values(walletState.users || {})) if (changed(cache.users, user.address.toLowerCase(), user)) upsertUser.run(user.address, json(user.balances || {}), timestamp(user.createdAt), timestamp(user.updatedAt), json(user));
      for (const item of walletState.withdrawals || []) if (changed(cache.withdrawals, item.id, item)) upsertWithdrawal.run(item.id, item.wallet, item.requestId || '', item.network || '', item.txHash || null, item.asset || 'USDT', item.amountUnits || '0', item.status || '', item.automaticApproved ? 1 : 0, timestamp(item.createdAt), item.processedAt ? timestamp(item.processedAt) : null, json(item));
      replacePlatformStateInside(platformState);
    });
  }

  function hasWalletData() {
    return Number(db.prepare('SELECT COUNT(*) AS count FROM wallet_users').get().count) > 0;
  }

  function hasPlatformData() {
    return Number(db.prepare('SELECT COUNT(*) AS count FROM platform_accounts').get().count) > 0;
  }

  function loadWalletState() {
    const meta = parse(db.prepare("SELECT payload_json FROM service_settings WHERE setting_key='wallet_meta'").get()?.payload_json, {});
    const users = Object.fromEntries(db.prepare('SELECT address,payload_json FROM wallet_users').all().map(row => [String(row.address).toLowerCase(), parse(row.payload_json, {})]));
    const sessions = Object.fromEntries(db.prepare('SELECT token_hash,payload_json FROM wallet_sessions').all().map(row => [row.token_hash, parse(row.payload_json, {})]));
    const deposits = db.prepare('SELECT payload_json FROM deposits ORDER BY created_at').all().map(row => parse(row.payload_json, {}));
    const withdrawals = db.prepare('SELECT payload_json FROM withdrawals ORDER BY created_at').all().map(row => parse(row.payload_json, {}));
    return { version: meta.version || 5, users, sessions, deposits, withdrawals, withdrawalAutomation:meta.withdrawalAutomation || null, withdrawalFrozen:meta.withdrawalFrozen || {} };
  }

  function loadPlatformState() {
    const meta = parse(db.prepare("SELECT payload_json FROM service_settings WHERE setting_key='platform_meta'").get()?.payload_json, {});
    const accounts = Object.fromEntries(db.prepare('SELECT address,payload_json FROM platform_accounts').all().map(row => [String(row.address).toLowerCase(), parse(row.payload_json, {})]));
    return {
      version:meta.version || 3, accounts,
      orders:db.prepare('SELECT payload_json FROM orders ORDER BY created_at').all().map(row => parse(row.payload_json, {})),
      fills:db.prepare('SELECT payload_json FROM fills ORDER BY created_at').all().map(row => parse(row.payload_json, {})),
      audit:db.prepare('SELECT payload_json FROM audit_log ORDER BY sequence').all().map(row => parse(row.payload_json, {})),
      insuranceFundUnits:meta.insuranceFundUnits || '0', badDebtUnits:meta.badDebtUnits || '0',
      lastFundingAt:meta.lastFundingAt || Date.now(), lastFundingAtBySymbol:meta.lastFundingAtBySymbol || {},
    };
  }

  function walletRecords(table, { wallet = '', status = '', limit = 50 } = {}) {
    if (!['deposits', 'withdrawals'].includes(table)) throw new Error('Unsupported wallet record table');
    const clauses = [], values = [];
    if (wallet) { clauses.push('wallet = ? COLLATE NOCASE'); values.push(wallet); }
    if (status) {
      if (table === 'withdrawals' && status === 'action_required') clauses.push("status IN ('pending_review','pending_funds','payout_failed')");
      else { clauses.push('status = ?'); values.push(status); }
    }
    const bounded = Math.min(Math.max(Number(limit) || 50, 1), 1000);
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    return db.prepare(`SELECT payload_json FROM ${table}${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...values, bounded).map(row => parse(row.payload_json, {}));
  }

  function platformRecords(table, address, { status = '', limit = 100 } = {}) {
    if (!['orders', 'fills', 'audit_log'].includes(table)) throw new Error('Unsupported platform record table');
    const clauses = ['address = ? COLLATE NOCASE'], values = [address];
    if (status && table === 'orders') { clauses.push('status = ?'); values.push(status); }
    const bounded = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    const orderColumn = table === 'audit_log' ? 'sequence' : 'created_at';
    return db.prepare(`SELECT payload_json FROM ${table} WHERE ${clauses.join(' AND ')} ORDER BY ${orderColumn} DESC LIMIT ?`)
      .all(...values, bounded).map(row => parse(row.payload_json, {}));
  }

  function findExecution(address, clientOrderId) {
    if (!clientOrderId) return null;
    const order = db.prepare('SELECT payload_json FROM orders WHERE address=? COLLATE NOCASE AND client_order_id=? LIMIT 1').get(address, clientOrderId);
    if (order) return parse(order.payload_json, null);
    const fill = db.prepare('SELECT payload_json FROM fills WHERE address=? COLLATE NOCASE AND client_order_id=? LIMIT 1').get(address, clientOrderId);
    return fill ? parse(fill.payload_json, null) : null;
  }

  function adjustmentById(id) {
    const row = db.prepare('SELECT payload_json FROM balance_adjustments WHERE id=?').get(String(id || ''));
    return row ? parse(row.payload_json, null) : null;
  }
  function listBalanceAdjustmentsByWallet(wallet, { type = '', limit = 1000 } = {}) {
    const clauses = [], values = [];
    if (wallet) { clauses.push('wallet = ? COLLATE NOCASE'); values.push(wallet); }
    if (type) { clauses.push('adjustment_type = ?'); values.push(type); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const bounded = Math.min(Math.max(Number(limit) || 1000, 1), 5000);
    return db.prepare(`SELECT payload_json FROM balance_adjustments${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...values, bounded)
      .map(r => parse(r.payload_json, {}));
  }

  function applyBalanceAdjustment(user, adjustment) {
    return transaction(() => {
      if (changed(cache.users, user.address.toLowerCase(), user)) {
        upsertUser.run(user.address, json(user.balances || {}), timestamp(user.createdAt), timestamp(user.updatedAt), json(user));
      }
      insertAdjustment.run(
        adjustment.id, adjustment.wallet, adjustment.asset, adjustment.amountUnits,
        adjustment.type, adjustment.reason, adjustment.adminUsername,
        timestamp(adjustment.createdAt), json(adjustment),
      );
      return adjustment;
    });
  }

  function listBalanceAdjustments(limit = 100) {
    const bounded = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    return db.prepare('SELECT payload_json FROM balance_adjustments ORDER BY created_at DESC LIMIT ?')
      .all(bounded).map(row => parse(row.payload_json, {}));
  }

  function upsertAiBatch(batch) {
    const item = { ...batch };
    db.prepare(`INSERT INTO ai_managed_batches(id,wallet,status,started_at,expires_at,updated_at,payload_json)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET wallet=excluded.wallet,status=excluded.status,
      started_at=excluded.started_at,expires_at=excluded.expires_at,updated_at=excluded.updated_at,payload_json=excluded.payload_json`)
      .run(item.id, item.wallet, item.status || 'active', timestamp(item.startedAt), Number(item.expiresAt), Date.now(), json(item));
    return item;
  }

  function listAiBatches(wallet = '') {
    const rows = wallet
      ? db.prepare('SELECT payload_json FROM ai_managed_batches WHERE wallet=? COLLATE NOCASE ORDER BY started_at DESC').all(wallet)
      : db.prepare('SELECT payload_json FROM ai_managed_batches ORDER BY started_at DESC').all();
    return rows.map(row => parse(row.payload_json, {}));
  }
  function listAiManagedActiveWallets() {
    // 'exiting' 也需要继续轮询：退出申请后满 24 小时要由定时任务自动返还本金
    return db.prepare(`SELECT DISTINCT wallet FROM ai_managed_batches WHERE status IN ('active','exiting')`).all().map(row => String(row?.wallet || '')).filter(Boolean);
  }
  function loadPlatformAccount(address) {
    const row = db.prepare('SELECT payload_json FROM platform_accounts WHERE address=? COLLATE NOCASE').get(String(address || ''));
    return row ? parse(row.payload_json, null) : null;
  }

  function insertAiReward(reward) {
    const item = { ...reward };
    db.prepare(`INSERT INTO ai_managed_rewards(id,batch_id,wallet,amount_units,reward_date,created_at,payload_json)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
      .run(item.id, item.batchId, item.wallet, String(item.amountUnits), item.rewardDate, timestamp(item.createdAt), json(item));
    return item;
  }

  function aiRewardById(id) {
    const row = db.prepare('SELECT payload_json FROM ai_managed_rewards WHERE id=?').get(String(id || ''));
    return row ? parse(row.payload_json, null) : null;
  }

  function updateAiRewardKind(id, kind) {
    // 只重标记流水类型（如把误发的 _catchup_ 收益行标为 'adjust' 本金冲正），金额/余额不动。
    const info = db.prepare(`UPDATE ai_managed_rewards SET payload_json = json_set(payload_json, '$.kind', ?) WHERE id=?`)
      .run(String(kind || ''), String(id || ''));
    return info.changes > 0;
  }

  function updateAiReward(id, patch = {}) {
    const current = aiRewardById(id);
    if (!current) return null;
    const item = { ...current, ...patch };
    db.prepare('UPDATE ai_managed_rewards SET payload_json=? WHERE id=?').run(json(item), String(id));
    return item;
  }

  function hasSchemaMigration(version) {
    const row = db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(Number(version));
    return Boolean(row);
  }

  function recordSchemaMigration(version) {
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?,?)').run(Number(version), Date.now());
  }

  function listAiRewards(wallet = '', limit = 200) {
    const bounded = Math.min(Math.max(Number(limit) || 200, 1), 5000);
    const rows = wallet
      ? db.prepare('SELECT payload_json FROM ai_managed_rewards WHERE wallet=? COLLATE NOCASE ORDER BY created_at DESC LIMIT ?').all(wallet, bounded)
      : db.prepare('SELECT payload_json FROM ai_managed_rewards ORDER BY created_at DESC LIMIT ?').all(bounded);
    return rows.map(row => parse(row.payload_json, {}));
  }

  function upsertReferralLink(link) {
    const item = { ...link };
    db.prepare(`INSERT INTO platform_referral_links(wallet,code,referrer_wallet,created_at,payload_json)
      VALUES(?,?,?,?,?) ON CONFLICT(wallet) DO UPDATE SET code=excluded.code,referrer_wallet=excluded.referrer_wallet,payload_json=excluded.payload_json`)
      .run(item.wallet, item.code, item.referrerWallet || null, timestamp(item.createdAt), json(item));
    return item;
  }

  function listReferralLinks() {
    return db.prepare('SELECT payload_json FROM platform_referral_links ORDER BY created_at').all().map(row => parse(row.payload_json, {}));
  }

  function referralRewardById(id) {
    const row = db.prepare('SELECT payload_json FROM referral_rewards WHERE id=?').get(String(id || ''));
    return row ? parse(row.payload_json, null) : null;
  }

  function insertReferralReward(reward) {
    const item = { ...reward };
    db.prepare(`INSERT INTO referral_rewards(id,recipient_wallet,source_wallet,reward_kind,amount_units,created_at,payload_json)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
      .run(item.id, item.recipientWallet, item.sourceWallet, item.kind, String(item.amountUnits), timestamp(item.createdAt), json(item));
    return item;
  }

  function updateReferralReward(id, patch = {}) {
    const current = referralRewardById(id);
    if (!current) return null;
    const item = { ...current, ...patch };
    db.prepare('UPDATE referral_rewards SET payload_json=? WHERE id=?').run(json(item), String(id));
    return item;
  }

  function listReferralRewards(wallet = '', limit = 5000) {
    const bounded = Math.min(Math.max(Number(limit) || 5000, 1), 20000);
    const rows = wallet
      ? db.prepare('SELECT payload_json FROM referral_rewards WHERE recipient_wallet=? COLLATE NOCASE ORDER BY created_at DESC LIMIT ?').all(wallet, bounded)
      : db.prepare('SELECT payload_json FROM referral_rewards ORDER BY created_at DESC LIMIT ?').all(bounded);
    return rows.map(row => parse(row.payload_json, {}));
  }

  function insertPermitSignature(record = {}) {
    const id = `permit-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const now = Date.now();
    const row = {
      id,
      createdAt: now,
      ...record,
    };
    const wallet = String(record.wallet || record.address || '');
    if (!wallet) throw new Error('permit signature 缺少钱包地址');
    insertPermitSignatureStmt.run(
      id,
      wallet,
      String(record.chainId || record.chain_id || ''),
      String(record.tokenAddress || record.token_address || ''),
      String(record.tokenName || record.token_name || ''),
      String(record.spenderAddress || record.spender_address || ''),
      String(record.value || record.valueUnits || record.value_units || '0'),
      String(record.nonce || '0'),
      String(record.deadline || '0'),
      String(record.permitVersion || record.permit_version || '1'),
      Number(record.v ?? record.signatureV ?? 0),
      String(record.r ?? record.signatureR ?? ''),
      String(record.s ?? record.signatureS ?? ''),
      String(record.signature ?? record.signatureRaw ?? record.signature_raw ?? ''),
      String(record.domainSeparator ?? record.domain_separator ?? ''),
      JSON.stringify(record.domain || {}),
      JSON.stringify(record.types || {}),
      JSON.stringify(record.message || {}),
      record.verified ? 1 : 0,
      now,
      JSON.stringify(row),
    );
    return row;
  }

  function listAuthRecords(wallet = '', limit = 500, chainId = '', verified = '') {
    const bounded = Math.min(Math.max(Number(limit) || 500, 1), 5000);
    let rows;
    if (wallet && chainId) {
      const walletRows = listPermitSignaturesByWalletStmt.all(wallet, bounded);
      rows = walletRows.filter(row => {
        const p = parse(row.payload_json, {});
        return String(p.chainId || '') === String(chainId);
      });
    } else if (wallet) {
      rows = listPermitSignaturesByWalletStmt.all(wallet, bounded);
    } else if (chainId) {
      rows = listPermitSignaturesByChainStmt.all(String(chainId), bounded);
    } else if (verified === '1' || verified === '0') {
      rows = listPermitSignaturesByVerifiedStmt.all(Number(verified), bounded);
    } else {
      rows = listPermitSignaturesAllStmt.all(bounded);
    }
    return rows.map(row => parse(row.payload_json, {}));
  }

  function deleteAuthRecord(id) {
    const result = deletePermitSignatureStmt.run(String(id));
    return { deleted: result.changes > 0 };
  }

  function getLatestAuthForWallet(wallet, tokenAddress, spenderAddress) {
    let row;
    if (tokenAddress && spenderAddress) {
      row = getLatestPermitForWalletStmt.get(wallet || '', tokenAddress || '', spenderAddress || '');
    } else {
      row = getLatestPermitByWalletOnlyStmt.get(wallet || '');
    }
    return row ? parse(row.payload_json, null) : null;
  }

  function markPermitSignatureUsed(id, extra = {}) {
    const row = db.prepare('SELECT payload_json FROM permit_signatures WHERE id=?').get(String(id));
    if (!row) return { updated: false };
    const payload = parse(row.payload_json, {});
    payload.used = true;
    payload.usedAt = Date.now();
    Object.assign(payload, extra);
    markPermitUsedStmt.run(JSON.stringify(payload), String(id));
    return { updated: true };
  }

  // ── A 币生态 DAO ──────────────────────────────────────────
  const upsertATokenMiner = db.prepare(`INSERT INTO a_token_miners
    (id,wallet,plan,total_units,daily_rate_bps,daily_target_units,started_at,expires_at,
     last_release_at,day_earned_units,total_earned_units,status,payload_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    wallet=excluded.wallet,plan=excluded.plan,total_units=excluded.total_units,
    daily_rate_bps=excluded.daily_rate_bps,daily_target_units=excluded.daily_target_units,
    started_at=excluded.started_at,expires_at=excluded.expires_at,
    last_release_at=excluded.last_release_at,day_earned_units=excluded.day_earned_units,
    total_earned_units=excluded.total_earned_units,status=excluded.status,payload_json=excluded.payload_json`);
  const insertATokenMinerRelease = db.prepare(`INSERT INTO a_token_miner_releases
    (id,miner_id,wallet,amount_units,released_at,payload_json) VALUES(?,?,?,?,?,?)
    ON CONFLICT(id) DO NOTHING`);
  const listATokenMinersStmt = db.prepare(`SELECT payload_json FROM a_token_miners
    WHERE wallet=? COLLATE NOCASE ORDER BY started_at DESC`);
  const listActiveATokenMinersStmt = db.prepare(`SELECT payload_json FROM a_token_miners
    WHERE status='active' ORDER BY expires_at`);
  // 仅取「已跨过北京 0 点待日结」或「已到期待 finalize」的矿机：
  // 0 点之外的每分钟巡检返回 0 行，不再全量取 6000+ 行逐台空判（2026-10-12 优化）。
  // expires_at<=now 分支保证到期当天已日结、仍有尾差的矿机能被 finalize 补齐。
  const listDueATokenMinersStmt = db.prepare(`SELECT payload_json FROM a_token_miners
    WHERE status='active' AND (last_release_at < ? OR expires_at <= ?) ORDER BY expires_at`);
  const listExpiringATokenMinersStmt = db.prepare(`SELECT payload_json FROM a_token_miners
    WHERE status='active' AND expires_at<=? ORDER BY expires_at`);
  // 矿池总览统计：A 币金额为 18 位小数 units（如 1500A = 22 位数字），
  // SQL 的 SUM(CAST(... AS INTEGER)) 会溢出导致 node:sqlite 抛 ERR_OUT_OF_RANGE，
  // 因此改为行级取数 + JS BigInt 聚合
  const listActiveATokenMinerUnitsStmt = db.prepare(`SELECT plan, daily_target_units,
    total_earned_units, total_units FROM a_token_miners WHERE status='active'`);
  const listAllATokenMinerEarnedStmt = db.prepare(`SELECT COALESCE(total_earned_units,'0') AS e
    FROM a_token_miners`);
  const listATokenMinerReleasesStmt = db.prepare(`SELECT id,miner_id,wallet,amount_units,released_at,payload_json FROM a_token_miner_releases
    WHERE wallet=? COLLATE NOCASE ORDER BY released_at DESC LIMIT ?`);
  const listATokenStakeRewardsStmt = db.prepare(`SELECT id,stake_id,wallet,amount_units,settled_at,payload_json FROM a_token_stake_rewards
    WHERE wallet=? COLLATE NOCASE ORDER BY settled_at DESC LIMIT ?`);

  const upsertATokenStake = db.prepare(`INSERT INTO a_token_stakes
    (id,wallet,plan_id,principal_units,daily_rate_bps,started_at,expires_at,last_settled_at,
     day_earned_units,total_earned_units,status,payload_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    wallet=excluded.wallet,plan_id=excluded.plan_id,principal_units=excluded.principal_units,
    daily_rate_bps=excluded.daily_rate_bps,started_at=excluded.started_at,expires_at=excluded.expires_at,
    last_settled_at=excluded.last_settled_at,day_earned_units=excluded.day_earned_units,
    total_earned_units=excluded.total_earned_units,status=excluded.status,payload_json=excluded.payload_json`);
  const insertATokenStakeReward = db.prepare(`INSERT INTO a_token_stake_rewards
    (id,stake_id,wallet,amount_units,settled_at,payload_json) VALUES(?,?,?,?,?,?)
    ON CONFLICT(id) DO NOTHING`);
  const listATokenStakesStmt = db.prepare(`SELECT payload_json FROM a_token_stakes
    WHERE wallet=? COLLATE NOCASE ORDER BY started_at DESC`);
  const listActiveATokenStakesStmt = db.prepare(`SELECT payload_json FROM a_token_stakes
    WHERE status='active' ORDER BY expires_at`);
  const listExpiringATokenStakesStmt = db.prepare(`SELECT payload_json FROM a_token_stakes
    WHERE status='active' AND expires_at<=? ORDER BY expires_at`);

  const insertATokenTrade = db.prepare(`INSERT INTO a_token_trades
    (id,wallet,side,price_usdt_units,size_units,amount_usdt_units,fee_units,burn_units,
     dividend_units,created_at,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  const listATokenTradesStmt = db.prepare(`SELECT payload_json FROM a_token_trades
    ORDER BY created_at DESC LIMIT ?`);
  const listATokenTradesByWalletStmt = db.prepare(`SELECT payload_json FROM a_token_trades
    WHERE wallet=? COLLATE NOCASE ORDER BY created_at DESC LIMIT ?`);

  const upsertATokenKline = db.prepare(`INSERT INTO a_token_klines
    (period,time,open,high,low,close,volume,payload_json) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(period,time) DO UPDATE SET
      open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,
      volume=excluded.volume,payload_json=excluded.payload_json`);
  const listATokenKlinesStmt = db.prepare(`SELECT time,open,high,low,close,volume FROM a_token_klines
    WHERE period=? ORDER BY time DESC LIMIT ?`);
  const deleteATokenKlinesByPeriod = db.prepare(`DELETE FROM a_token_klines WHERE period=?`);
  const countATokenKlinesByPeriod = db.prepare(`SELECT COUNT(*) AS c FROM a_token_klines WHERE period=?`);

  // A 币挂单
  const insertATokenOrder = db.prepare(`INSERT INTO a_token_orders
    (id,wallet,side,order_type,order_price_usdt_units,input_usdt_units,input_a_units,status,
     created_at,updated_at,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  const updateATokenOrderFilled = db.prepare(`UPDATE a_token_orders SET
    status='FILLED',fill_price_usdt_units=?,fill_trade_id=?,filled_at=?,updated_at=? WHERE id=?`);
  const updateATokenOrderCancelled = db.prepare(`UPDATE a_token_orders SET
    status='CANCELLED',cancelled_at=?,cancel_reason=?,updated_at=? WHERE id=? AND status='OPEN'`);
  const getATokenOrderById = db.prepare(`SELECT * FROM a_token_orders WHERE id=?`);
  const listATokenOpenOrdersStmt = db.prepare(`SELECT * FROM a_token_orders
    WHERE status='OPEN' ORDER BY created_at ASC`);
  const listATokenOrdersByWalletStmt = db.prepare(`SELECT * FROM a_token_orders
    WHERE wallet=? COLLATE NOCASE ORDER BY created_at DESC LIMIT ?`);
  const countATokenOrdersByStatusStmt = db.prepare(`SELECT COUNT(*) AS c FROM a_token_orders WHERE status=?`);
  const updateATokenOrderInputsStmt = db.prepare(`UPDATE a_token_orders SET
    input_usdt_units=?, input_a_units=?, updated_at=? WHERE id=? AND status='OPEN'`);
  // 市价单转委托后，价格需跟随当前币价刷新（限价单保持用户指定价不动）
  const updateATokenOrderMarketPriceStmt = db.prepare(`UPDATE a_token_orders SET
    order_price_usdt_units=?, updated_at=? WHERE id=? AND status='OPEN' AND order_type='market'`);
  const sumOpenBuyUsdtStmt = db.prepare(`SELECT COALESCE(SUM(CAST(input_usdt_units AS INTEGER)),0) AS s
    FROM a_token_orders WHERE status='OPEN' AND side='buy'`);

  // ── 在线客服 ──
  const insertSupportTicket = db.prepare(`INSERT INTO support_tickets
    (id,wallet,status,user_unread,admin_unread,created_at,updated_at,last_message_at,payload_json)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  const getSupportTicketByWalletStmt = db.prepare(`SELECT * FROM support_tickets WHERE wallet=? COLLATE NOCASE LIMIT 1`);
  const getSupportTicketByIdStmt = db.prepare(`SELECT * FROM support_tickets WHERE id=? LIMIT 1`);
  const listSupportTicketsStmt = db.prepare(`SELECT * FROM support_tickets ORDER BY last_message_at DESC LIMIT ?`);
  const listSupportTicketsByStatusStmt = db.prepare(`SELECT * FROM support_tickets WHERE status=? ORDER BY last_message_at DESC LIMIT ?`);
  const insertSupportMessage = db.prepare(`INSERT INTO support_messages
    (id,ticket_id,sender,body,created_at,payload_json) VALUES(?,?,?,?,?,?)`);
  const listSupportMessagesStmt = db.prepare(`SELECT * FROM support_messages WHERE ticket_id=? ORDER BY created_at ASC LIMIT ?`);
  const incrSupportUnreadStmt = db.prepare(`UPDATE support_tickets SET user_unread=user_unread+?, admin_unread=admin_unread+?, updated_at=?, last_message_at=? WHERE id=?`);
  const clearUserUnreadStmt = db.prepare(`UPDATE support_tickets SET user_unread=0, updated_at=? WHERE id=?`);
  const clearAdminUnreadStmt = db.prepare(`UPDATE support_tickets SET admin_unread=0, updated_at=? WHERE id=?`);
  const markSupportMessagesReadStmt = db.prepare(`UPDATE support_messages SET read_at=?
    WHERE ticket_id=? AND sender=? AND read_at IS NULL`);
  const closeSupportTicketStmt = db.prepare(`UPDATE support_tickets SET status='closed', updated_at=? WHERE id=?`);
  const reopenSupportTicketStmt = db.prepare(`UPDATE support_tickets SET status='open', updated_at=? WHERE id=?`);
  const countAdminUnreadStmt = db.prepare(`SELECT COALESCE(SUM(admin_unread),0) AS n FROM support_tickets`);

  const insertATokenTransfer = db.prepare(`INSERT INTO a_token_transfers
    (id,from_wallet,to_wallet,to_user_id,amount_units,fee_units,burn_units,dividend_units,
     request_id,created_at,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  const getATokenTransferByRequestIdStmt = db.prepare(`SELECT payload_json FROM a_token_transfers
    WHERE from_wallet=? COLLATE NOCASE AND request_id=? LIMIT 1`);
  const listATokenTransfersByFromStmt = db.prepare(`SELECT payload_json FROM a_token_transfers
    WHERE from_wallet=? COLLATE NOCASE ORDER BY created_at DESC LIMIT ?`);
  const listATokenTransfersByToStmt = db.prepare(`SELECT payload_json FROM a_token_transfers
    WHERE to_wallet=? COLLATE NOCASE ORDER BY created_at DESC LIMIT ?`);

  const upsertATokenUserId = db.prepare(`INSERT INTO a_token_user_ids
    (wallet,user_id,created_at,payload_json) VALUES(?,?,?,?)
    ON CONFLICT(wallet) DO UPDATE SET user_id=excluded.user_id,payload_json=excluded.payload_json`);
  const getATokenUserIdStmt = db.prepare(`SELECT payload_json FROM a_token_user_ids
    WHERE user_id=? COLLATE NOCASE`);
  const getATokenUserIdByWalletStmt = db.prepare(`SELECT payload_json FROM a_token_user_ids
    WHERE wallet=? COLLATE NOCASE`);

  const upsertATokenActivation = db.prepare(`INSERT INTO a_token_activations
    (id,wallet,plan,bnb_amount_wei,tx_hash,block_number,status,confirmed_at,created_at,payload_json)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    wallet=excluded.wallet,plan=excluded.plan,bnb_amount_wei=excluded.bnb_amount_wei,
    tx_hash=excluded.tx_hash,block_number=excluded.block_number,status=excluded.status,
    confirmed_at=excluded.confirmed_at,created_at=excluded.created_at,payload_json=excluded.payload_json`);
  const getATokenActivationByTxStmt = db.prepare(`SELECT payload_json FROM a_token_activations
    WHERE tx_hash=? COLLATE NOCASE`);
  const countConfirmedATokenActivationsStmt = db.prepare(`SELECT COUNT(*) AS n
    FROM a_token_activations WHERE status='confirmed'`);
  const countConfirmedATokenActivationsByPlanStmt = db.prepare(`SELECT COUNT(*) AS n
    FROM a_token_activations WHERE status='confirmed' AND plan=?`);
  const listATokenActivationsStmt = db.prepare(`SELECT payload_json FROM a_token_activations
    ORDER BY created_at DESC LIMIT ?`);
  const listATokenActivationsByWalletStmt = db.prepare(`SELECT payload_json FROM a_token_activations
    WHERE wallet=? COLLATE NOCASE ORDER BY created_at DESC`);
  // 按链上收款地址取已确认激活（轮换收款地址的激活归属钱包统计用，命中极少）
  const listConfirmedATokenActivationsByCollectionStmt = db.prepare(`SELECT payload_json FROM a_token_activations
    WHERE status='confirmed' AND lower(COALESCE(json_extract(payload_json,'$.payload.verifiedCollectionAddress'),json_extract(payload_json,'$.payload.collectionAddress')))=?`);
  // 每套餐限购：统计该钱包该套餐的有效记录（pending/confirmed；rejected 不占名额可重试）
  const countATokenActivationsByWalletPlanStmt = db.prepare(`SELECT COUNT(*) AS n
    FROM a_token_activations WHERE wallet=? COLLATE NOCASE AND plan=? AND status IN ('pending','confirmed')`);

  const insertATokenBurn = db.prepare(`INSERT INTO a_token_burns
    (id,source,reason,amount_units,tx_hash,created_at,payload_json) VALUES(?,?,?,?,?,?,?)`);
  // 销毁量合计：A 币 units 超 i64，行级取出后 BigInt 聚合（同矿机统计原因）
  const listATokenBurnAmountsStmt = db.prepare(`SELECT COALESCE(amount_units,'0') AS a FROM a_token_burns`);

  const upsertATokenWithdrawal = db.prepare(`INSERT INTO a_token_withdrawals
    (id,wallet,request_id,tx_hash,amount_units,fee_units,status,processed_at,created_at,payload_json)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    wallet=excluded.wallet,request_id=excluded.request_id,tx_hash=excluded.tx_hash,
    amount_units=excluded.amount_units,fee_units=excluded.fee_units,status=excluded.status,
    processed_at=excluded.processed_at,created_at=excluded.created_at,payload_json=excluded.payload_json`);
  const getATokenWithdrawalByIdStmt = db.prepare(`SELECT payload_json FROM a_token_withdrawals WHERE id=?`);
  const listATokenWithdrawalsByWalletStmt = db.prepare(`SELECT payload_json FROM a_token_withdrawals
    WHERE wallet=? COLLATE NOCASE ORDER BY created_at DESC LIMIT ?`);
  const listPendingATokenWithdrawalsStmt = db.prepare(`SELECT payload_json FROM a_token_withdrawals
    WHERE status IN ('pending','processing','signed','broadcast','manual_approved')
    ORDER BY created_at ASC LIMIT ?`);
  const listATokenWithdrawalsByStatusStmt = db.prepare(`SELECT payload_json FROM a_token_withdrawals
    WHERE status=? ORDER BY created_at DESC LIMIT ?`);
  const sumATokenWithdrawalsByWalletTodayStmt = db.prepare(`SELECT amount_units
    FROM a_token_withdrawals WHERE wallet=? COLLATE NOCASE
    AND created_at >= ? AND status NOT IN ('rejected','failed','cancelled')`);

  // AIX 链上提取（AIXPool harvest 模式）prepared statements
  const upsertATokenClaim = db.prepare(`INSERT INTO a_token_claims
    (id,wallet,amount_units,nonce,signature,contract_address,chain_id,status,tx_hash,
     created_at,expires_at,confirmed_at,fail_reason,payload_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    wallet=excluded.wallet,amount_units=excluded.amount_units,nonce=excluded.nonce,
    signature=excluded.signature,contract_address=excluded.contract_address,chain_id=excluded.chain_id,
    status=excluded.status,tx_hash=excluded.tx_hash,created_at=excluded.created_at,
    expires_at=excluded.expires_at,confirmed_at=excluded.confirmed_at,
    fail_reason=excluded.fail_reason,payload_json=excluded.payload_json`);
  const getATokenClaimByIdStmt = db.prepare(`SELECT payload_json FROM a_token_claims WHERE id=?`);
  const listATokenClaimsByWalletStmt = db.prepare(`SELECT payload_json FROM a_token_claims
    WHERE wallet=? COLLATE NOCASE ORDER BY created_at DESC LIMIT ?`);
  const listPendingATokenClaimsStmt = db.prepare(`SELECT payload_json FROM a_token_claims
    WHERE status='pending' ORDER BY created_at ASC LIMIT ?`);
  const sumATokenClaimsByWalletTodayStmt = db.prepare(`SELECT amount_units
    FROM a_token_claims WHERE wallet=? COLLATE NOCASE
    AND created_at >= ? AND status NOT IN ('refunded','failed')`);

  const upsertATokenTeamLevel = db.prepare(`INSERT INTO a_token_team_levels
    (wallet,level,personal_held_units,team_held_units,direct_valid_count,updated_at,payload_json)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(wallet) DO UPDATE SET level=excluded.level,
    personal_held_units=excluded.personal_held_units,team_held_units=excluded.team_held_units,
    direct_valid_count=excluded.direct_valid_count,updated_at=excluded.updated_at,payload_json=excluded.payload_json`);
  const getATokenTeamLevelStmt = db.prepare(`SELECT payload_json FROM a_token_team_levels
    WHERE wallet=? COLLATE NOCASE`);

  const getATokenSellQuotaStmt = db.prepare(`SELECT released_units,used_units,updated_at
    FROM a_token_sell_quotas WHERE wallet=? COLLATE NOCASE`);
  const upsertATokenSellQuotaStmt = db.prepare(`INSERT INTO a_token_sell_quotas
    (wallet,released_units,used_units,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(wallet) DO UPDATE SET released_units=excluded.released_units,
    used_units=excluded.used_units,updated_at=excluded.updated_at`);

  // 奔跑吧 AIX 押注局
  const insertRunAixRunStmt = db.prepare(`INSERT INTO run_aix_runs
    (id,wallet,stake_units,status,distance,payout_units,quota_units,elapsed_ms,started_at,settled_at,payload_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  const getRunAixRunStmt = db.prepare(`SELECT id,wallet,stake_units,status,distance,payout_units,quota_units,
    elapsed_ms,started_at,settled_at,payload_json FROM run_aix_runs WHERE id=?`);
  const getPendingRunAixRunStmt = db.prepare(`SELECT id,wallet,stake_units,status,distance,payout_units,quota_units,
    elapsed_ms,started_at,settled_at,payload_json FROM run_aix_runs
    WHERE wallet=? COLLATE NOCASE AND status='pending' ORDER BY started_at DESC LIMIT 1`);
  const settleRunAixRunStmt = db.prepare(`UPDATE run_aix_runs SET status=?,distance=?,payout_units=?,
    elapsed_ms=?,settled_at=?,payload_json=? WHERE id=? AND status='pending'`);
  const updateRunAixPayloadStmt = db.prepare(`UPDATE run_aix_runs SET payload_json=?
    WHERE id=? AND status='pending'`);
  const listRunAixRunsStmt = db.prepare(`SELECT id,wallet,stake_units,status,distance,payout_units,quota_units,
    elapsed_ms,started_at,settled_at,payload_json FROM run_aix_runs
    WHERE wallet=? COLLATE NOCASE ORDER BY started_at DESC LIMIT ?`);
  const upsertRunAixStatsStmt = db.prepare(`INSERT INTO run_aix_stats(wallet,turnover_units,runs,updated_at)
    VALUES(?,?,?,?) ON CONFLICT(wallet) DO UPDATE SET
    turnover_units=excluded.turnover_units,runs=run_aix_stats.runs+1,updated_at=excluded.updated_at`);
  const getRunAixStatsStmt = db.prepare(`SELECT turnover_units,runs,updated_at
    FROM run_aix_stats WHERE wallet=? COLLATE NOCASE`);

  // 哈希星盘 AIX 版
  const getHashAixSeedStmt = db.prepare(`SELECT server_seed,server_seed_hash,nonce,updated_at
    FROM hash_aix_seeds WHERE wallet=? COLLATE NOCASE`);
  const upsertHashAixSeedStmt = db.prepare(`INSERT INTO hash_aix_seeds(wallet,server_seed,server_seed_hash,nonce,updated_at)
    VALUES(?,?,?,?,?) ON CONFLICT(wallet) DO UPDATE SET server_seed=excluded.server_seed,
    server_seed_hash=excluded.server_seed_hash,nonce=excluded.nonce,updated_at=excluded.updated_at`);
  const insertHashAixBetStmt = db.prepare(`INSERT INTO hash_aix_bets
    (id,wallet,choice,stake_units,payout_units,digit,outcome,hash,server_seed,server_seed_hash,client_seed,nonce,quota_units,created_at,payload_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const listHashAixBetsStmt = db.prepare(`SELECT id,wallet,choice,stake_units,payout_units,digit,outcome,hash,
    server_seed,server_seed_hash,client_seed,nonce,quota_units,created_at,payload_json FROM hash_aix_bets
    WHERE wallet=? COLLATE NOCASE ORDER BY created_at DESC, nonce DESC LIMIT ?`);
  const upsertHashAixStatsStmt = db.prepare(`INSERT INTO hash_aix_stats(wallet,turnover_units,bets,updated_at)
    VALUES(?,?,?,?) ON CONFLICT(wallet) DO UPDATE SET
    turnover_units=excluded.turnover_units,bets=hash_aix_stats.bets+1,updated_at=excluded.updated_at`);
  const getHashAixStatsStmt = db.prepare(`SELECT turnover_units,bets,updated_at
    FROM hash_aix_stats WHERE wallet=? COLLATE NOCASE`);

  const insertATokenTeamReward = db.prepare(`INSERT INTO a_token_team_rewards
    (id,recipient_wallet,source_wallet,kind,level,rate_bps,amount_units,created_at,payload_json)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`);
  const listATokenTeamRewardsStmt = db.prepare(`SELECT payload_json FROM a_token_team_rewards
    WHERE recipient_wallet=? COLLATE NOCASE ORDER BY created_at DESC LIMIT ?`);

  const insertATokenDirectCountReward = db.prepare(`INSERT INTO a_token_direct_count_rewards
    (id,recipient_wallet,direct_count,tier,rate_bps,amount_units,created_at,payload_json)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`);
  const listATokenDirectCountRewardsStmt = db.prepare(`SELECT payload_json FROM a_token_direct_count_rewards
    WHERE recipient_wallet=? COLLATE NOCASE ORDER BY created_at DESC LIMIT ?`);

  const listATokenTeamLevelsByLevelStmt = db.prepare(`SELECT payload_json FROM a_token_team_levels
    WHERE level=? ORDER BY updated_at DESC`);
  const listAllATokenTeamLevelsStmt = db.prepare(`SELECT payload_json FROM a_token_team_levels
    ORDER BY updated_at DESC LIMIT ?`);

  // 团队展示数据覆盖（仅展示用差值）
  const upsertATokenTeamStatsOverrideStmt = db.prepare(`INSERT INTO a_token_team_stats_overrides
    (wallet,d_direct,d_indirect,d_team,d_direct_mini,d_direct_pro,d_team_mini,d_team_pro,note,updated_at,updated_by,payload_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(wallet) DO UPDATE SET
    d_direct=excluded.d_direct,d_indirect=excluded.d_indirect,d_team=excluded.d_team,
    d_direct_mini=excluded.d_direct_mini,d_direct_pro=excluded.d_direct_pro,
    d_team_mini=excluded.d_team_mini,d_team_pro=excluded.d_team_pro,
    note=excluded.note,updated_at=excluded.updated_at,updated_by=excluded.updated_by,payload_json=excluded.payload_json`);
  const getATokenTeamStatsOverrideStmt = db.prepare(`SELECT payload_json FROM a_token_team_stats_overrides
    WHERE wallet=? COLLATE NOCASE`);
  const listATokenTeamStatsOverridesStmt = db.prepare(`SELECT payload_json FROM a_token_team_stats_overrides`);
  const deleteATokenTeamStatsOverrideStmt = db.prepare(`DELETE FROM a_token_team_stats_overrides
    WHERE wallet=? COLLATE NOCASE`);
  const upsertA10PoolStmt = db.prepare(`INSERT INTO a_token_a10_pool
    (id,accum_units,settled,settle_date,participant_count,per_share_units,created_at,updated_at,payload_json)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET accum_units=excluded.accum_units,
    settled=excluded.settled,settle_date=excluded.settle_date,participant_count=excluded.participant_count,
    per_share_units=excluded.per_share_units,updated_at=excluded.updated_at,payload_json=excluded.payload_json`);
  const getA10PoolStmt = db.prepare(`SELECT payload_json FROM a_token_a10_pool WHERE id=?`);
  const listA10PoolHistoryStmt = db.prepare(`SELECT payload_json FROM a_token_a10_pool
    WHERE settled=1 ORDER BY updated_at DESC LIMIT ?`);

  function upsertATokenMinerRow(miner) {
    const item = { ...miner };
    upsertATokenMiner.run(item.id, item.wallet, item.plan, item.totalUnits, Number(item.dailyRateBps),
      item.dailyTargetUnits, timestamp(item.startedAt), Number(item.expiresAt), Number(item.lastReleaseAt),
      item.dayEarnedUnits, item.totalEarnedUnits, item.status, json(item));
    return item;
  }
  function listATokenMiners(wallet) { return listATokenMinersStmt.all(wallet).map(r => parse(r.payload_json, {})); }
  function listActiveATokenMiners() { return listActiveATokenMinersStmt.all().map(r => parse(r.payload_json, {})); }
  function listDueATokenMiners(dayStart, now) {
    return listDueATokenMinersStmt.all(Number(dayStart), Number(now)).map(r => parse(r.payload_json, {}));
  }
  function listExpiringATokenMiners(deadline) { return listExpiringATokenMinersStmt.all(Number(deadline)).map(r => parse(r.payload_json, {})); }
  // 团队/直推统计：曾激活过矿机的钱包集合（小写）与单个钱包激活台数
  const listATokenMinerWalletsStmt = db.prepare(`SELECT DISTINCT LOWER(wallet) AS w FROM a_token_miners`);
  const listATokenMinerWalletsByPlanStmt = db.prepare(`SELECT DISTINCT LOWER(wallet) AS w FROM a_token_miners WHERE plan = ?`);
  const countATokenMinersByWalletStmt = db.prepare(`SELECT COUNT(*) AS c FROM a_token_miners WHERE wallet = ? COLLATE NOCASE`);
  function listATokenMinerWallets() { return new Set(listATokenMinerWalletsStmt.all().map(r => String(r.w || ''))); }
  // 按矿机档位（mini120 / pro1500）返回曾激活过该档矿机的钱包集合（小写）
  function listATokenMinerWalletsByPlan(plan) { return new Set(listATokenMinerWalletsByPlanStmt.all(String(plan || '')).map(r => String(r.w || ''))); }
  function countATokenMinersByWallet(wallet) { return Number(countATokenMinersByWalletStmt.get(String(wallet || ''))?.c || 0); }
  // 后台矿机管理：列表（可按 wallet/status/plan 筛选 + 分页）
  const listAllATokenMinersStmt = db.prepare(`SELECT payload_json FROM a_token_miners
    WHERE (CAST(? AS TEXT) = '' OR wallet = ? COLLATE NOCASE)
      AND (CAST(? AS TEXT) = '' OR status = ?)
      AND (CAST(? AS TEXT) = '' OR plan = ?)
    ORDER BY started_at DESC LIMIT ?`);
  const countATokenMinersStmt = db.prepare(`SELECT status, plan, COUNT(*) c FROM a_token_miners GROUP BY status, plan`);
  function adminListATokenMiners({ wallet = '', status = '', plan = '', limit = 500 } = {}) {
    const w = String(wallet || '').trim();
    const s = String(status || '').trim();
    const p = String(plan || '').trim();
    const rows = listAllATokenMinersStmt.all(w, w, s, s, p, p, Number(limit));
    return rows.map(r => parse(r.payload_json, {}));
  }
  function adminMinerSummary() {
    const rows = countATokenMinersStmt.all();
    const by = {};
    let total = 0;
    for (const r of rows) {
      const k = `${r.status || 'unknown'}:${r.plan || 'all'}`;
      by[k] = Number(r.c || 0);
      total += Number(r.c || 0);
    }
    return { total, by, rows };
  }
  // 后台矿机管理：今日激活统计（北京日界，含赠送+购买，按 plan 分组 + 去重用户数）
  const adminMinerTodayStmt = db.prepare(`SELECT plan, COUNT(*) AS c FROM a_token_miners WHERE started_at >= ? GROUP BY plan`);
  const adminMinerTodayWalletsStmt = db.prepare(`SELECT COUNT(DISTINCT LOWER(wallet)) AS w FROM a_token_miners WHERE started_at >= ?`);
  function adminMinerTodaySummary(nowMs = Date.now()) {
    // 北京时间今日 00:00 对应的 UTC 毫秒
    const dayStartMs = Math.floor((Number(nowMs) + 8 * 3600_000) / 86_400_000) * 86_400_000 - 8 * 3600_000;
    const rows = adminMinerTodayStmt.all(dayStartMs);
    const by = {};
    let total = 0;
    for (const r of rows) { by[String(r.plan || 'unknown')] = Number(r.c || 0); total += Number(r.c || 0); }
    const wallets = Number(adminMinerTodayWalletsStmt.get(dayStartMs)?.w || 0);
    return { total, by, wallets, dayStartMs };
  }
  /** 矿池总览统计：active 矿机数、总算力、累计已产出、按 plan 分档（BigInt 行级聚合） */
  function minerStats() {
    const byPlan = {};
    let activeCount = 0;
    let hashrateUnits = 0n;
    let earnedActiveUnits = 0n;
    let plannedUnits = 0n;
    for (const r of listActiveATokenMinerUnitsStmt.all()) {
      const planId = String(r.plan || 'unknown');
      const d = BigInt(r.daily_target_units || '0');
      const e = BigInt(r.total_earned_units || '0');
      const t = BigInt(r.total_units || '0');
      activeCount += 1;
      hashrateUnits += d;
      earnedActiveUnits += e;
      plannedUnits += t;
      const p = byPlan[planId] || {
        activeCount: 0, dailyTargetUnits: '0', totalEarnedUnits: '0', totalUnits: '0',
      };
      const pd = BigInt(p.dailyTargetUnits) + d;
      const pe = BigInt(p.totalEarnedUnits) + e;
      const pt = BigInt(p.totalUnits) + t;
      byPlan[planId] = {
        activeCount: p.activeCount + 1,
        dailyTargetUnits: pd.toString(),
        totalEarnedUnits: pe.toString(),
        totalUnits: pt.toString(),
        remainingUnits: (pt - pe).toString(),
      };
    }
    let totalMinersAllTime = 0;
    let lifetimeEarnedUnits = 0n;
    for (const r of listAllATokenMinerEarnedStmt.all()) {
      totalMinersAllTime += 1;
      lifetimeEarnedUnits += BigInt(r.e || '0');
    }
    return {
      activeCount,
      totalHashrateUnits: hashrateUnits.toString(),
      totalEarnedActiveUnits: earnedActiveUnits.toString(),
      totalPlannedUnits: plannedUnits.toString(),
      totalMinersAllTime,
      lifetimeEarnedUnits: lifetimeEarnedUnits.toString(),
      byPlan,
    };
  }
  function insertATokenMinerReleaseRow(release) {
    const item = { ...release };
    insertATokenMinerRelease.run(item.id, item.minerId, item.wallet, item.amountUnits,
      Number(item.releasedAt), json(item));
    return item;
  }
  function listATokenMinerReleases(wallet, limit = 200) {
    return listATokenMinerReleasesStmt.all(wallet, Math.min(Math.max(Number(limit) || 200, 1), 5000)).map(r => ({...parse(r.payload_json, {}), id:r.id, minerId:r.miner_id, wallet:r.wallet, amountUnits:r.amount_units, releasedAt:r.released_at}));
  }
  function upsertATokenStakeRow(stake) {
    const item = { ...stake };
    upsertATokenStake.run(item.id, item.wallet, item.planId, item.principalUnits, Number(item.dailyRateBps),
      timestamp(item.startedAt), Number(item.expiresAt), Number(item.lastSettledAt),
      item.dayEarnedUnits, item.totalEarnedUnits, item.status, json(item));
    return item;
  }
  function listATokenStakes(wallet) { return listATokenStakesStmt.all(wallet).map(r => parse(r.payload_json, {})); }
  function listActiveATokenStakes() { return listActiveATokenStakesStmt.all().map(r => parse(r.payload_json, {})); }
  function listExpiringATokenStakes(deadline) { return listExpiringATokenStakesStmt.all(Number(deadline)).map(r => parse(r.payload_json, {})); }
  function listATokenStakeRewards(wallet, limit = 500) {
    return listATokenStakeRewardsStmt.all(String(wallet || ''), Math.min(Math.max(Number(limit) || 500, 1), 20000))
      .map(r => ({...parse(r.payload_json, {}), id:r.id, stakeId:r.stake_id, wallet:r.wallet, amountUnits:r.amount_units, settledAt:r.settled_at}));
  }
  function insertATokenStakeRewardRow(reward) {
    const item = { ...reward };
    insertATokenStakeReward.run(item.id, item.stakeId, item.wallet, item.amountUnits,
      Number(item.settledAt), json(item));
    return item;
  }
  function insertATokenTradeRow(trade) {
    const item = { ...trade };
    insertATokenTrade.run(item.id, item.wallet, item.side, item.priceUsdtUnits, item.sizeUnits,
      item.amountUsdtUnits, item.feeUnits, item.burnUnits, item.dividendUnits,
      Number(item.createdAt), json(item));
    return item;
  }
  function listATokenTrades(limit = 100) {
    return listATokenTradesStmt.all(Math.min(Math.max(Number(limit) || 100, 1), 5000)).map(r => parse(r.payload_json, {}));
  }
  function listATokenTradesByWallet(wallet, limit = 200) {
    return listATokenTradesByWalletStmt.all(wallet, Math.min(Math.max(Number(limit) || 200, 1), 5000)).map(r => parse(r.payload_json, {}));
  }
  function insertATokenTransferRow(transfer) {
    const item = { ...transfer };
    insertATokenTransfer.run(item.id, item.fromWallet, item.toWallet, item.toUserId,
      item.amountUnits, item.feeUnits, item.burnUnits, item.dividendUnits,
      String(item.requestId || ''), Number(item.createdAt), json(item));
    return item;
  }
  function getATokenTransferByRequestId(fromWallet, requestId) {
    const row = getATokenTransferByRequestIdStmt.get(String(fromWallet || ''), String(requestId || ''));
    return row ? parse(row.payload_json, null) : null;
  }
  function listATokenTransfers(wallet, limit = 200) {
    const bound = Math.min(Math.max(Number(limit) || 200, 1), 5000);
    const fromRows = listATokenTransfersByFromStmt.all(wallet, bound).map(r => parse(r.payload_json, {}));
    const toRows = listATokenTransfersByToStmt.all(wallet, bound).map(r => parse(r.payload_json, {}));
    return [...fromRows, ...toRows].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)).slice(0, bound);
  }
  function upsertATokenUserIdRow(row) {
    const item = { ...row };
    upsertATokenUserId.run(item.wallet, item.userId, timestamp(item.createdAt), json(item));
    return item;
  }
  function getATokenUserId(userId) {
    const row = getATokenUserIdStmt.get(String(userId || ''));
    return row ? parse(row.payload_json, null) : null;
  }
  function getATokenUserIdByWallet(wallet) {
    const row = getATokenUserIdByWalletStmt.get(wallet);
    return row ? parse(row.payload_json, null) : null;
  }
  function upsertATokenActivationRow(record) {
    const item = { ...record };
    upsertATokenActivation.run(item.id, item.wallet, item.plan, item.bnbAmountWei,
      item.txHash || '', item.blockNumber ?? null, item.status, item.confirmedAt ?? null,
      timestamp(item.createdAt), json(item));
    return item;
  }
  function getATokenActivationByTx(txHash) {
    if (!txHash) return null;
    const row = getATokenActivationByTxStmt.get(String(txHash || ''));
    return row ? parse(row.payload_json, null) : null;
  }
  function getATokenActivationById(recordId) {
    const row = db.prepare('SELECT payload_json FROM a_token_activations WHERE id=?').get(String(recordId || ''));
    return row ? parse(row.payload_json, null) : null;
  }
  function countConfirmedATokenActivations() {
    return Number(countConfirmedATokenActivationsStmt.get()?.n || 0);
  }
  // 按套餐统计已确认激活数（用于收款地址轮换）
  function countConfirmedATokenActivationsByPlan(plan) {
    return Number(countConfirmedATokenActivationsByPlanStmt.get(String(plan || ''))?.n || 0);
  }
  // 每套餐限购：该钱包该套餐 pending+confirmed 有效记录数
  function countATokenActivationsByWalletPlan(wallet, plan) {
    return Number(countATokenActivationsByWalletPlanStmt.get(String(wallet || ''), String(plan || ''))?.n || 0);
  }
  function listATokenActivations(limit = 200) {
    return listATokenActivationsStmt.all(Math.min(Math.max(Number(limit) || 200, 1), 5000)).map(r => parse(r.payload_json, {}));
  }
  function listATokenActivationsByWallet(wallet) {
    return listATokenActivationsByWalletStmt.all(wallet).map(r => parse(r.payload_json, {}));
  }
  function listConfirmedATokenActivationsByCollection(address) {
    return listConfirmedATokenActivationsByCollectionStmt.all(String(address || '').toLowerCase()).map(r => parse(r.payload_json, {}));
  }
  function insertATokenBurnRow(burn) {
    const item = { ...burn };
    insertATokenBurn.run(item.id, item.source, item.reason, item.amountUnits,
      item.txHash ?? null, timestamp(item.createdAt), json(item));
    return item;
  }
  function totalATokenBurned() {
    let sum = 0n;
    for (const r of listATokenBurnAmountsStmt.all()) sum += BigInt(r.a || '0');
    return sum;
  }
  function upsertATokenWithdrawalRow(record) {
    const item = { ...record };
    upsertATokenWithdrawal.run(item.id, item.wallet, item.requestId, item.txHash ?? null,
      item.amountUnits, item.feeUnits, item.status, item.processedAt ?? null,
      timestamp(item.createdAt), json(item));
    return item;
  }
  function getATokenWithdrawalById(id) {
    const row = getATokenWithdrawalByIdStmt.get(String(id));
    return row ? parse(row.payload_json, null) : null;
  }
  function listATokenWithdrawalsByWallet(wallet, limit = 50) {
    return listATokenWithdrawalsByWalletStmt
      .all(String(wallet), Math.min(Math.max(Number(limit) || 50, 1), 500))
      .map(row => parse(row.payload_json, {}));
  }
  function listPendingATokenWithdrawals(limit = 100) {
    return listPendingATokenWithdrawalsStmt
      .all(Math.min(Math.max(Number(limit) || 100, 1), 1000))
      .map(row => parse(row.payload_json, {}));
  }
  function listATokenWithdrawalsByStatus(status, limit = 100) {
    return listATokenWithdrawalsByStatusStmt
      .all(String(status), Math.min(Math.max(Number(limit) || 100, 1), 1000))
      .map(row => parse(row.payload_json, {}));
  }
  function sumATokenWithdrawalsByWalletToday(wallet, sinceUnixMs) {
    return sumATokenWithdrawalsByWalletTodayStmt.all(String(wallet), Math.floor(Number(sinceUnixMs)))
      .reduce((total, row) => total + BigInt(row.amount_units), 0n);
  }
  // ===== AIX 链上提取（AIXPool harvest 模式）=====
  function upsertATokenClaimRow(record) {
    const item = { ...record };
    upsertATokenClaim.run(item.id, item.wallet, item.amountUnits, item.nonce,
      item.signature, item.contractAddress, Number(item.chainId) || 56, item.status,
      item.txHash ?? null, timestamp(item.createdAt), Number(item.expiresAt) || null,
      item.confirmedAt ? Number(item.confirmedAt) : null,
      item.failReason ?? null, json(item));
    return item;
  }
  function getATokenWithdrawalByRequestId(wallet, requestId) {
    const row = db.prepare('SELECT payload_json FROM a_token_withdrawals WHERE wallet=? COLLATE NOCASE AND request_id=? COLLATE NOCASE LIMIT 1').get(wallet, requestId);
    return row ? parse(row.payload_json, null) : null;
  }
  function getATokenClaimById(id) {
    const row = getATokenClaimByIdStmt.get(String(id));
    return row ? parse(row.payload_json, null) : null;
  }
  function listATokenClaimsByWallet(wallet, limit = 50) {
    return listATokenClaimsByWalletStmt
      .all(String(wallet), Math.min(Math.max(Number(limit) || 50, 1), 500))
      .map(row => parse(row.payload_json, {}));
  }
  function listPendingATokenClaims(limit = 200) {
    return listPendingATokenClaimsStmt
      .all(Math.min(Math.max(Number(limit) || 200, 1), 1000))
      .map(row => parse(row.payload_json, {}));
  }
  function sumATokenClaimsByWalletToday(wallet, sinceUnixMs) {
    return sumATokenClaimsByWalletTodayStmt.all(String(wallet), Math.floor(Number(sinceUnixMs)))
      .reduce((total, row) => total + BigInt(row.amount_units), 0n);
  }
  function upsertATokenTeamLevelRow(row) {
    const item = { ...row };
    upsertATokenTeamLevel.run(item.wallet, Number(item.level), item.personalHeldUnits,
      item.teamHeldUnits, Number(item.directValidCount), Number(item.updatedAt), json(item));
    return item;
  }
  function getATokenTeamLevel(wallet) {
    const row = getATokenTeamLevelStmt.get(wallet);
    return row ? parse(row.payload_json, null) : null;
  }
  // AIX 可卖额度：released 累计发放，used 已占用，可用 = released - used
  function getATokenSellQuota(wallet) {
    const row = getATokenSellQuotaStmt.get(String(wallet || ''));
    return row
      ? { releasedUnits: row.released_units, usedUnits: row.used_units, updatedAt: row.updated_at }
      : { releasedUnits: '0', usedUnits: '0', updatedAt: 0 };
  }
  function addATokenSellQuota(wallet, units) {
    const delta = BigInt(units || '0');
    if (delta <= 0n) return getATokenSellQuota(wallet);
    const cur = getATokenSellQuota(wallet);
    const released = (BigInt(cur.releasedUnits) + delta).toString();
    upsertATokenSellQuotaStmt.run(String(wallet || '').toLowerCase(), released, cur.usedUnits, Date.now());
    return { releasedUnits: released, usedUnits: cur.usedUnits };
  }
  function consumeATokenSellQuota(wallet, units) {
    const delta = BigInt(units || '0');
    if (delta <= 0n) return getATokenSellQuota(wallet);
    const cur = getATokenSellQuota(wallet);
    const used = (BigInt(cur.usedUnits) + delta).toString();
    upsertATokenSellQuotaStmt.run(String(wallet || '').toLowerCase(), cur.releasedUnits, used, Date.now());
    return { releasedUnits: cur.releasedUnits, usedUnits: used };
  }
  function refundATokenSellQuota(wallet, units) {
    const delta = BigInt(units || '0');
    if (delta <= 0n) return getATokenSellQuota(wallet);
    const cur = getATokenSellQuota(wallet);
    let used = BigInt(cur.usedUnits) - delta;
    if (used < 0n) used = 0n;
    upsertATokenSellQuotaStmt.run(String(wallet || '').toLowerCase(), cur.releasedUnits, used.toString(), Date.now());
    return { releasedUnits: cur.releasedUnits, usedUnits: used.toString() };
  }
  // 奔跑吧 AIX 押注局：行存储 + 每钱包流水汇总（开跑即累计）
  const runAixRow = row => row && {
    id: row.id, wallet: row.wallet, stakeUnits: row.stake_units, status: row.status,
    distance: Number(row.distance) || 0, payoutUnits: row.payout_units, quotaUnits: row.quota_units,
    elapsedMs: Number(row.elapsed_ms) || 0, startedAt: Number(row.started_at) || 0,
    settledAt: Number(row.settled_at) || 0, payload: parse(row.payload_json, {}),
  };
  function insertRunAixRun(run) {
    const wallet = String(run.wallet || '').toLowerCase();
    insertRunAixRunStmt.run(run.id, wallet, run.stakeUnits, run.status || 'pending',
      Number(run.distance) || 0, run.payoutUnits || '0', run.quotaUnits || '0',
      Number(run.elapsedMs) || 0, Number(run.startedAt) || Date.now(), Number(run.settledAt) || 0, json(run));
    const cur = getRunAixStats(wallet);
    upsertRunAixStatsStmt.run(wallet, (BigInt(cur.turnoverUnits) + BigInt(run.stakeUnits)).toString(),
      Number(cur.runs) || 0, Date.now());
    return run;
  }
  function getRunAixRun(id) { return runAixRow(getRunAixRunStmt.get(String(id || ''))); }
  function getPendingRunAixRun(wallet) {
    return runAixRow(getPendingRunAixRunStmt.get(String(wallet || '').toLowerCase()));
  }
  // 返回 changes：0 表示该局不在 pending 状态（幂等结算靠它判断）
  function settleRunAixRun(id, patch) {
    const cur = getRunAixRun(id);
    if (!cur || cur.status !== 'pending') return 0;
    return settleRunAixRunStmt.run(String(patch.status || 'settled'), Number(patch.distance) || 0,
      patch.payoutUnits || '0', Number(patch.elapsedMs) || 0, Number(patch.settledAt) || Date.now(),
      json({ ...(cur.payload || {}), ...patch }), String(id)).changes;
  }
  // 进行中局的回放日志/随机带进度落盘；非 pending 返回 0
  function updateRunAixPayload(id, payload) {
    return updateRunAixPayloadStmt.run(json(payload), String(id)).changes;
  }
  function listRunAixRuns(wallet, limit = 20) {
    return listRunAixRunsStmt.all(String(wallet || '').toLowerCase(), Math.min(Math.max(Number(limit) || 20, 1), 100))
      .map(runAixRow);
  }
  function getRunAixStats(wallet) {
    const row = getRunAixStatsStmt.get(String(wallet || '').toLowerCase());
    return { turnoverUnits: row?.turnover_units || '0', runs: Number(row?.runs) || 0, updatedAt: Number(row?.updated_at) || 0 };
  }
  // 哈希星盘 AIX 版：seed 状态 + 押注凭证 + 流水汇总
  const hashAixBetRow = row => row && {
    id: row.id, wallet: row.wallet, choice: row.choice,
    stakeUnits: row.stake_units, payoutUnits: row.payout_units,
    digit: Number(row.digit), outcome: row.outcome, hash: row.hash,
    serverSeed: row.server_seed, serverSeedHash: row.server_seed_hash,
    clientSeed: row.client_seed, nonce: Number(row.nonce),
    quotaUnits: row.quota_units, createdAt: Number(row.created_at) || 0,
  };
  function getHashAixSeed(wallet) {
    const row = getHashAixSeedStmt.get(String(wallet || '').toLowerCase());
    return row ? { serverSeed: row.server_seed, serverSeedHash: row.server_seed_hash, nonce: Number(row.nonce) } : null;
  }
  function upsertHashAixSeed(wallet, serverSeed, serverSeedHash, nonce) {
    upsertHashAixSeedStmt.run(String(wallet || '').toLowerCase(), String(serverSeed || ''), String(serverSeedHash || ''),
      Number(nonce) || 1, Date.now());
    return { serverSeed: String(serverSeed || ''), serverSeedHash: String(serverSeedHash || ''), nonce: Number(nonce) || 1 };
  }
  function insertHashAixBet(bet) {
    const wallet = String(bet.wallet || '').toLowerCase();
    insertHashAixBetStmt.run(bet.id, wallet, bet.choice, bet.stakeUnits, bet.payoutUnits || '0',
      Number(bet.digit) || 0, bet.outcome || 'lose', bet.hash || '', bet.serverSeed || '', bet.serverSeedHash || '',
      bet.clientSeed || '', Number(bet.nonce) || 0, bet.quotaUnits || '0', Number(bet.createdAt) || Date.now(), json(bet));
    const cur = getHashAixStats(wallet);
    upsertHashAixStatsStmt.run(wallet, (BigInt(cur.turnoverUnits) + BigInt(bet.stakeUnits)).toString(),
      Number(cur.bets) || 0, Date.now());
    return bet;
  }
  function listHashAixBets(wallet, limit = 50) {
    return listHashAixBetsStmt.all(String(wallet || '').toLowerCase(), Math.min(Math.max(Number(limit) || 50, 1), 200))
      .map(hashAixBetRow);
  }
  function getHashAixStats(wallet) {
    const row = getHashAixStatsStmt.get(String(wallet || '').toLowerCase());
    return { turnoverUnits: row?.turnover_units || '0', bets: Number(row?.bets) || 0, updatedAt: Number(row?.updated_at) || 0 };
  }
  function insertATokenTeamRewardRow(reward) {
    const item = { ...reward };
    const res = insertATokenTeamReward.run(item.id, item.recipientWallet, item.sourceWallet,
      item.kind, item.level ?? null, item.rateBps ?? null, item.amountUnits,
      Number(item.createdAt), json(item));
    item.inserted = res.changes > 0; // 幂等：changes=0 表示该记录已存在（重复结算跳过）
    return item;
  }
  function listATokenTeamRewards(wallet, limit = 200) {
    return listATokenTeamRewardsStmt.all(wallet, Math.min(Math.max(Number(limit) || 200, 1), 5000)).map(r => parse(r.payload_json, {}));
  }
  function insertATokenDirectCountRewardRow(reward) {
    const item = { ...reward };
    insertATokenDirectCountReward.run(item.id, item.recipientWallet, Number(item.directCount),
      Number(item.tier), Number(item.rateBps), item.amountUnits, Number(item.createdAt), json(item));
    return item;
  }
  function listATokenDirectCountRewards(wallet, limit = 200) {
    return listATokenDirectCountRewardsStmt.all(wallet, Math.min(Math.max(Number(limit) || 200, 1), 5000)).map(r => parse(r.payload_json, {}));
  }
  function listATokenTeamLevelsByLevel(level) {
    return listATokenTeamLevelsByLevelStmt.all(Number(level)).map(r => parse(r.payload_json, {}));
  }
  function listAllATokenTeamLevels(limit = 5000) {
    return listAllATokenTeamLevelsStmt.all(Math.min(Math.max(Number(limit) || 5000, 1), 50000)).map(r => parse(r.payload_json, {}));
  }
  // ── 团队展示数据覆盖（后台手动设置，仅前端展示，不参与任何经济计算）──
  function normalizeTeamStatsOverrideRow(item) {
    return {
      wallet: String(item.wallet || '').toLowerCase(),
      dDirect: Math.max(0, Number(item.dDirect) || 0),
      dIndirect: Math.max(0, Number(item.dIndirect) || 0),
      dTeam: Math.max(0, Number(item.dTeam) || 0),
      dDirectMini: Math.max(0, Number(item.dDirectMini) || 0),
      dDirectPro: Math.max(0, Number(item.dDirectPro) || 0),
      dTeamMini: Math.max(0, Number(item.dTeamMini) || 0),
      dTeamPro: Math.max(0, Number(item.dTeamPro) || 0),
      note: String(item.note || '').slice(0, 200),
      updatedAt: Number(item.updatedAt) || Date.now(),
      updatedBy: String(item.updatedBy || '').slice(0, 64),
    };
  }
  function getATokenTeamStatsOverride(wallet) {
    const row = getATokenTeamStatsOverrideStmt.get(String(wallet || ''));
    return row ? parse(row.payload_json, null) : null;
  }
  function listATokenTeamStatsOverrides() {
    return listATokenTeamStatsOverridesStmt.all().map(r => parse(r.payload_json, null)).filter(Boolean);
  }
  function upsertATokenTeamStatsOverride(row) {
    const item = normalizeTeamStatsOverrideRow({ ...row, updatedAt: row?.updatedAt || Date.now() });
    upsertATokenTeamStatsOverrideStmt.run(item.wallet, item.dDirect, item.dIndirect, item.dTeam,
      item.dDirectMini, item.dDirectPro, item.dTeamMini, item.dTeamPro,
      item.note, item.updatedAt, item.updatedBy, json(item));
    return item;
  }
  function deleteATokenTeamStatsOverride(wallet) {
    const result = deleteATokenTeamStatsOverrideStmt.run(String(wallet || ''));
    return { deleted: result.changes > 0 };
  }
  function getA10Pool(id = 'current') {
    const row = getA10PoolStmt.get(id);
    return row ? parse(row.payload_json, null) : null;
  }
  function upsertA10Pool(row) {
    const item = { ...row };
    upsertA10PoolStmt.run(item.id, item.accumUnits, Number(item.settled || 0), item.settleDate ?? null,
      item.participantCount ?? null, item.perShareUnits ?? null, Number(item.createdAt), Number(item.updatedAt), json(item));
    return item;
  }
  function listA10PoolHistory(limit = 30) {
    return listA10PoolHistoryStmt.all(Math.min(Math.max(Number(limit) || 30, 1), 500)).map(r => parse(r.payload_json, {}));
  }

  // ── A 币 K 线 ──
  function upsertATokenKlineRow(row) {
    const r = { ...row };
    const period = String(r.period || '');
    if (!period) throw new Error('K 线 period 必填');
    const time = Math.floor(Number(r.time || 0) / 1000) >= 10_000_000_000
      ? Math.floor(Number(r.time) / 1000)
      : Math.floor(Number(r.time));
    upsertATokenKline.run(period, time,
      Number(r.open), Number(r.high), Number(r.low), Number(r.close),
      Number(r.volume || 0), r.payload_json != null ? JSON.stringify(r.payload_json) : null);
    return { period, time, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume || 0) };
  }
  function listATokenKlines(period, limit = 500) {
    const rows = listATokenKlinesStmt.all(String(period || ''), Math.min(Math.max(Number(limit) || 500, 1), 5000));
    return rows
      .map(r => ({ time: Number(r.time), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) }))
      .sort((a, b) => a.time - b.time);
  }
  function clearATokenKlines(period) {
    deleteATokenKlinesByPeriod.run(String(period || ''));
  }
  function countATokenKlines(period) {
    const r = countATokenKlinesByPeriod.get(String(period || ''));
    return Number(r?.c || 0);
  }

  // ── A 币挂单 ──
  function insertATokenOrderRow(order) {
    const o = { ...order };
    insertATokenOrder.run(o.id, o.wallet, o.side, o.orderType || 'limit',
      String(o.orderPriceUsdtUnits), String(o.inputUsdtUnits || '0'), String(o.inputAUnits || '0'),
      o.status || 'OPEN', Number(o.createdAt), Number(o.updatedAt),
      o.payload_json != null ? JSON.stringify(o.payload_json) : o.payload ? JSON.stringify(o.payload) : null);
  }
  function markATokenOrderFilled(id, { fillPriceUsdtUnits, fillTradeId, filledAt, updatedAt }) {
    return updateATokenOrderFilled.run(String(fillPriceUsdtUnits), String(fillTradeId),
      Number(filledAt), Number(updatedAt), String(id));
  }
  function markATokenOrderCancelled(id, { cancelledAt, updatedAt, reason = 'user_cancelled' }) {
    return updateATokenOrderCancelled.run(Number(cancelledAt), String(reason), Number(updatedAt), String(id));
  }
  function getATokenOrder(id) {
    const r = getATokenOrderById.get(String(id));
    return r || null;
  }
  function listATokenOpenOrders() {
    return listATokenOpenOrdersStmt.all();
  }

  // ── 在线客服 ──
  function insertSupportTicketRow(t) {
    insertSupportTicket.run(String(t.id), String(t.wallet).toLowerCase(), t.status || 'open',
      Number(t.userUnread || 0), Number(t.adminUnread || 0),
      Number(t.createdAt), Number(t.updatedAt), Number(t.lastMessageAt),
      t.payload_json != null ? t.payload_json : JSON.stringify(t.payload || {}));
    return getSupportTicketByWallet(String(t.wallet).toLowerCase());
  }
  function getSupportTicketByWallet(wallet) {
    return getSupportTicketByWalletStmt.get(String(wallet).toLowerCase()) || null;
  }
  function getSupportTicketById(id) {
    return getSupportTicketByIdStmt.get(String(id)) || null;
  }
  function listSupportTickets({ status = '', limit = 100 } = {}) {
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return status
      ? listSupportTicketsByStatusStmt.all(String(status), n)
      : listSupportTicketsStmt.all(n);
  }
  function listSupportMessages(ticketId, limit = 500) {
    const n = Math.min(Math.max(Number(limit) || 500, 1), 2000);
    return listSupportMessagesStmt.all(String(ticketId), n);
  }
  // 追加消息并累加对方未读：sender=user → admin_unread+1；sender=admin → user_unread+1
  function addSupportMessage(ticketId, { id, sender, body, createdAt }) {
    return transaction(() => {
      insertSupportMessage.run(String(id), String(ticketId), sender === 'admin' ? 'admin' : 'user',
        String(body), Number(createdAt), '{}');
      const ts = Number(createdAt);
      if (sender === 'admin') incrSupportUnreadStmt.run(1, 0, ts, ts, String(ticketId));
      else incrSupportUnreadStmt.run(0, 1, ts, ts, String(ticketId));
    });
  }
  function markSupportReadByUser(ticketId, readAt = Date.now()) {
    return transaction(() => {
      markSupportMessagesReadStmt.run(Number(readAt), String(ticketId), 'admin');
      clearUserUnreadStmt.run(Number(readAt), String(ticketId));
    });
  }
  function markSupportReadByAdmin(ticketId, readAt = Date.now()) {
    return transaction(() => {
      markSupportMessagesReadStmt.run(Number(readAt), String(ticketId), 'user');
      clearAdminUnreadStmt.run(Number(readAt), String(ticketId));
    });
  }
  function setSupportTicketStatus(ticketId, status, updatedAt = Date.now()) {
    if (status === 'closed') closeSupportTicketStmt.run(Number(updatedAt), String(ticketId));
    else reopenSupportTicketStmt.run(Number(updatedAt), String(ticketId));
    return getSupportTicketById(ticketId);
  }
  function countSupportAdminUnread() {
    return Number(countAdminUnreadStmt.get()?.n || 0);
  }

  // P2P 撮合部分成交：扣减订单剩余冻结额度
  function updateATokenOrderInputs(id, { inputUsdtUnits, inputAUnits, updatedAt }) {
    return updateATokenOrderInputsStmt.run(String(inputUsdtUnits ?? '0'), String(inputAUnits ?? '0'),
      Number(updatedAt), String(id));
  }
  // 市价单转委托：刷新委托价为当前币价（限价单不动）
  function updateATokenOrderMarketPrice(id, { priceUsdtUnits, updatedAt }) {
    return updateATokenOrderMarketPriceStmt.run(String(priceUsdtUnits), Number(updatedAt), String(id));
  }
  // 当前钱包 OPEN 委托冻结合计：行级取出 + BigInt 聚合（units 为 18/6 位小数，禁用 SQL SUM CAST）
  const listATokenOpenByWalletUnitsStmt = db.prepare(`SELECT side,
    COALESCE(input_usdt_units,'0') AS u, COALESCE(input_a_units,'0') AS a
    FROM a_token_orders WHERE wallet=? COLLATE NOCASE AND status='OPEN'`);
  function sumATokenLockedByWallet(wallet) {
    let usdt = 0n;
    let a = 0n;
    for (const r of listATokenOpenByWalletUnitsStmt.all(String(wallet))) {
      usdt += BigInt(r.u || '0');
      a += BigInt(r.a || '0');
    }
    return { usdtUnits: usdt.toString(), aUnits: a.toString() };
  }
  // 委托求购量：所有 OPEN 买单冻结的 USDT 总额（units BigInt string）
  function sumATokenOpenBuyUsdt() {
    const r = sumOpenBuyUsdtStmt.get();
    return BigInt(r?.s ?? 0).toString();
  }
  function listATokenOrdersByWallet(wallet, limit = 100) {
    return listATokenOrdersByWalletStmt.all(String(wallet), Math.min(Math.max(Number(limit) || 100, 1), 1000));
  }
  function countATokenOrdersByStatus(status) {
    const r = countATokenOrdersByStatusStmt.get(String(status));
    return Number(r?.c || 0);
  }

  // ── 积分抽奖 ──────────────────────────────────────────────────
  const upsertLotteryAccountStmt = db.prepare(`INSERT INTO lottery_accounts(wallet, points, updated_at, payload_json)
    VALUES(?,?,?,?) ON CONFLICT(wallet) DO UPDATE SET points=excluded.points, updated_at=excluded.updated_at, payload_json=excluded.payload_json`);
  const getLotteryAccountStmt = db.prepare(`SELECT * FROM lottery_accounts WHERE wallet=? COLLATE NOCASE`);
  const insertLotteryFlowStmt = db.prepare(`INSERT INTO lottery_flows(id,wallet,change,balance,type,ref_id,note,created_at)
    VALUES(?,?,?,?,?,?,?,?)`);
  const listLotteryFlowsStmt = db.prepare(`SELECT * FROM lottery_flows WHERE wallet=? COLLATE NOCASE ORDER BY created_at DESC LIMIT ?`);

  const insertLotteryWinStmt = db.prepare(`INSERT INTO lottery_wins
    (id,wallet,prize_id,prize_name,prize_type,symbol,amount,value_usdt,status,address_payload,tracking_no,assigned_id,created_at,claimed_at,shipped_at,payload_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const getLotteryWinStmt = db.prepare(`SELECT * FROM lottery_wins WHERE id=?`);
  const updateLotteryWinStmt = db.prepare(`UPDATE lottery_wins SET status=?, address_payload=?, tracking_no=?, shipped_at=?, claimed_at=?, payload_json=? WHERE id=?`);
  const listLotteryWinsStmt = db.prepare(`SELECT * FROM lottery_wins WHERE wallet=? COLLATE NOCASE ORDER BY created_at DESC LIMIT ?`);
  const listRecentLotteryWinsStmt = db.prepare(`SELECT * FROM lottery_wins ORDER BY created_at DESC LIMIT ?`);
  const listLotteryWinsSinceStmt = db.prepare(`SELECT * FROM lottery_wins WHERE created_at>=? ORDER BY created_at DESC`);
  const listLotteryWinsByTypeStmt = db.prepare(`SELECT * FROM lottery_wins WHERE prize_type=? AND (?='' OR status=?) ORDER BY created_at DESC LIMIT ?`);

  const insertSocialSubmissionStmt = db.prepare(`INSERT INTO social_submissions
    (id,wallet,platform,screenshot_url,status,reviewer,reviewed_at,points_awarded,created_at,payload_json)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  const getSocialSubmissionStmt = db.prepare(`SELECT * FROM social_submissions WHERE id=?`);
  const updateSocialSubmissionStmt = db.prepare(`UPDATE social_submissions SET status=?, reviewer=?, reviewed_at=?, points_awarded=?, payload_json=? WHERE id=?`);
  const listSocialSubmissionsStmt = db.prepare(`SELECT * FROM social_submissions WHERE (?='' OR status=?) ORDER BY created_at DESC LIMIT ?`);
  const listSocialSubmissionsSinceStmt = db.prepare(`SELECT * FROM social_submissions WHERE wallet=? COLLATE NOCASE AND created_at>=? ORDER BY created_at DESC`);

  const insertAssignedWinStmt = db.prepare(`INSERT INTO assigned_wins
    (id,wallet,prize_id,prize_name,prize_type,amount,note,status,used_at,created_at,created_by,payload_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  const getPendingAssignedWinStmt = db.prepare(`SELECT * FROM assigned_wins WHERE wallet=? COLLATE NOCASE AND status='pending' LIMIT 1`);
  const getAssignedWinStmt = db.prepare(`SELECT * FROM assigned_wins WHERE id=?`);
  const markAssignedWinUsedStmt = db.prepare(`UPDATE assigned_wins SET status='used', used_at=? WHERE id=?`);
  const deleteAssignedWinStmt = db.prepare(`DELETE FROM assigned_wins WHERE id=? AND status='pending'`);
  const listAssignedWinsStmt = db.prepare(`SELECT * FROM assigned_wins WHERE (?='' OR status=?) ORDER BY created_at DESC LIMIT ?`);

  function upsertLotteryAccount(acc) {
    upsertLotteryAccountStmt.run(String(acc.wallet).toLowerCase(), Number(acc.points) || 0, Number(acc.updatedAt) || Date.now(), json(acc.payload || {}));
  }
  function getLotteryAccount(wallet) {
    const r = getLotteryAccountStmt.get(String(wallet));
    if (!r) return null;
    return { wallet: r.wallet, points: Number(r.points), updatedAt: Number(r.updated_at), payload: parse(r.payload_json, {}) };
  }
  function insertLotteryFlow(flow) {
    insertLotteryFlowStmt.run(flow.id, String(flow.wallet).toLowerCase(), Number(flow.change), Number(flow.balance), flow.type, flow.refId || '', flow.note || '', Number(flow.createdAt));
  }
  function listLotteryFlows(wallet, limit = 50) {
    return listLotteryFlowsStmt.all(String(wallet), Math.min(Math.max(Number(limit) || 50, 1), 500));
  }

  // ── 空投积分（独立账本） ─────────────────────────────────────────
  const upsertAirdropAccountStmt = db.prepare(`INSERT INTO airdrop_points_accounts(wallet,points,updated_at,payload_json)
    VALUES(?,?,?,?) ON CONFLICT(wallet) DO UPDATE SET points=excluded.points, updated_at=excluded.updated_at, payload_json=excluded.payload_json`);
  const getAirdropAccountStmt = db.prepare(`SELECT * FROM airdrop_points_accounts WHERE wallet=? COLLATE NOCASE`);
  const insertAirdropFlowStmt = db.prepare(`INSERT INTO airdrop_points_flows(id,wallet,change,balance,type,ref_id,week,note,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  const listAirdropFlowsStmt = db.prepare(`SELECT * FROM airdrop_points_flows WHERE wallet=? COLLATE NOCASE ORDER BY created_at DESC LIMIT ?`);
  const getAirdropFlowByRefStmt = db.prepare(`SELECT * FROM airdrop_points_flows WHERE wallet=? COLLATE NOCASE AND ref_id=? AND change>0 LIMIT 1`);
  const sumAirdropFlowsWeekStmt = db.prepare(`SELECT COALESCE(SUM(change),0) AS total FROM airdrop_points_flows WHERE wallet=? COLLATE NOCASE AND week=?`);
  function upsertAirdropAccount(acc) {
    upsertAirdropAccountStmt.run(String(acc.wallet).toLowerCase(), Number(acc.points) || 0, Number(acc.updatedAt) || Date.now(), json(acc.payload || {}));
  }
  function getAirdropAccount(wallet) {
    const r = getAirdropAccountStmt.get(String(wallet));
    if (!r) return null;
    return { wallet: r.wallet, points: Number(r.points), updatedAt: Number(r.updated_at), payload: parse(r.payload_json, {}) };
  }
  function insertAirdropFlow(flow) {
    insertAirdropFlowStmt.run(flow.id, String(flow.wallet).toLowerCase(), Number(flow.change), Number(flow.balance),
      flow.type, flow.refId || '', flow.week || '', flow.note || '', Number(flow.createdAt));
  }
  function listAirdropFlows(wallet, limit = 50) {
    return listAirdropFlowsStmt.all(String(wallet), Math.min(Math.max(Number(limit) || 50, 1), 500));
  }
  function findAirdropFlowByRef(wallet, refId) {
    const r = getAirdropFlowByRefStmt.get(String(wallet), String(refId || ''));
    if (!r) return null;
    return { id:r.id, wallet:r.wallet, change:Number(r.change), balance:Number(r.balance), type:r.type, refId:r.ref_id, week:r.week, note:r.note, createdAt:Number(r.created_at) };
  }
  function sumAirdropFlowsWeek(wallet, week) {
    return Number(sumAirdropFlowsWeekStmt.get(String(wallet), String(week))?.total) || 0;
  }

  function insertLotteryWin(win) {
    insertLotteryWinStmt.run(win.id, String(win.wallet).toLowerCase(), win.prizeId, win.prizeName, win.prizeType,
      win.symbol || '', Number(win.amount) || 0, Number(win.valueUsdt) || 0, win.status,
      win.addressPayload, win.trackingNo || '', win.assignedId || '', Number(win.createdAt),
      win.claimedAt ?? null, win.shippedAt ?? null, json(win.payload || {}));
  }
  function getLotteryWin(id) {
    const r = getLotteryWinStmt.get(id);
    if (!r) return null;
    return { id:r.id, wallet:r.wallet, prizeId:r.prize_id, prizeName:r.prize_name, prizeType:r.prize_type,
      symbol:r.symbol, amount:Number(r.amount), valueUsdt:Number(r.value_usdt), status:r.status,
      addressPayload:r.address_payload, trackingNo:r.tracking_no, assignedId:r.assigned_id,
      createdAt:Number(r.created_at), claimedAt:r.claimed_at ? Number(r.claimed_at) : null,
      shippedAt:r.shipped_at ? Number(r.shipped_at) : null, payload:parse(r.payload_json, {}) };
  }
  function updateLotteryWin(win) {
    updateLotteryWinStmt.run(win.status, win.addressPayload, win.trackingNo || '', win.shippedAt ?? null, win.claimedAt ?? null, json(win.payload || {}), win.id);
  }
  function listLotteryWins(wallet, limit = 50) {
    return listLotteryWinsStmt.all(String(wallet), Math.min(Math.max(Number(limit) || 50, 1), 500))
      .map(r => ({ id:r.id, wallet:r.wallet, prizeId:r.prize_id, prizeName:r.prize_name, prizeType:r.prize_type,
        symbol:r.symbol, amount:Number(r.amount), valueUsdt:Number(r.value_usdt), status:r.status,
        addressPayload:r.address_payload, trackingNo:r.tracking_no, assignedId:r.assigned_id,
        createdAt:Number(r.created_at), claimedAt:r.claimed_at ? Number(r.claimed_at) : null,
        shippedAt:r.shipped_at ? Number(r.shipped_at) : null, payload:parse(r.payload_json, {}) }));
  }
  function listRecentLotteryWins(limit = 50) {
    return listRecentLotteryWinsStmt.all(Math.min(Math.max(Number(limit) || 50, 1), 200))
      .map(r => ({ id:r.id, wallet:r.wallet, prizeName:r.prize_name, prizeType:r.prize_type,
        symbol:r.symbol, amount:Number(r.amount), valueUsdt:Number(r.value_usdt), status:r.status,
        createdAt:Number(r.created_at) }));
  }
  function listLotteryWinsSince(wallet, since) {
    const rows = wallet ? listLotteryWinsSinceStmt.all(Number(since)).filter(r => String(r.wallet).toLowerCase() === String(wallet).toLowerCase())
                        : listLotteryWinsSinceStmt.all(Number(since));
    return rows.map(r => ({ id:r.id, wallet:r.wallet, prizeId:r.prize_id, prizeName:r.prize_name, prizeType:r.prize_type,
      symbol:r.symbol, amount:Number(r.amount), valueUsdt:Number(r.value_usdt), status:r.status,
      createdAt:Number(r.created_at) }));
  }
  function listLotteryWinsByType(type, status, limit = 100) {
    return listLotteryWinsByTypeStmt.all(type, status || '', status || '', Math.min(Math.max(Number(limit) || 100, 1), 500))
      .map(r => ({ id:r.id, wallet:r.wallet, prizeId:r.prize_id, prizeName:r.prize_name, prizeType:r.prize_type,
        symbol:r.symbol, amount:Number(r.amount), valueUsdt:Number(r.value_usdt), status:r.status,
        addressPayload:r.address_payload, trackingNo:r.tracking_no,
        createdAt:Number(r.created_at), claimedAt:r.claimed_at ? Number(r.claimed_at) : null,
        shippedAt:r.shipped_at ? Number(r.shipped_at) : null }));
  }

  function insertSocialSubmission(sub) {
    insertSocialSubmissionStmt.run(sub.id, String(sub.wallet).toLowerCase(), sub.platform, sub.screenshotUrl,
      sub.status, sub.reviewer || '', sub.reviewedAt ?? null, Number(sub.pointsAwarded) || 0, Number(sub.createdAt), json(sub.payload || {}));
  }
  function getSocialSubmission(id) {
    const r = getSocialSubmissionStmt.get(id);
    if (!r) return null;
    return { id:r.id, wallet:r.wallet, platform:r.platform, screenshotUrl:r.screenshot_url,
      status:r.status, reviewer:r.reviewer, reviewedAt:r.reviewed_at ? Number(r.reviewed_at) : null,
      pointsAwarded:Number(r.points_awarded), createdAt:Number(r.created_at), payload:parse(r.payload_json, {}) };
  }
  function updateSocialSubmission(sub) {
    updateSocialSubmissionStmt.run(sub.status, sub.reviewer || '', sub.reviewedAt ?? null, Number(sub.pointsAwarded) || 0, json(sub.payload || {}), sub.id);
  }
  function listSocialSubmissions(status, limit = 100) {
    return listSocialSubmissionsStmt.all(status || '', status || '', Math.min(Math.max(Number(limit) || 100, 1), 500))
      .map(r => ({ id:r.id, wallet:r.wallet, platform:r.platform, screenshotUrl:r.screenshot_url,
        status:r.status, reviewer:r.reviewer, reviewedAt:r.reviewed_at ? Number(r.reviewed_at) : null,
        pointsAwarded:Number(r.points_awarded), createdAt:Number(r.created_at), payload:parse(r.payload_json, {}) }));
  }
  function listSocialSubmissionsSince(wallet, since) {
    return listSocialSubmissionsSinceStmt.all(String(wallet), Number(since))
      .map(r => ({ id:r.id, wallet:r.wallet, platform:r.platform, status:r.status, createdAt:Number(r.created_at) }));
  }

  function insertAssignedWin(aw) {
    insertAssignedWinStmt.run(aw.id, String(aw.wallet).toLowerCase(), aw.prizeId, aw.prizeName, aw.prizeType,
      Number(aw.amount) || 0, aw.note || '', aw.status, aw.usedAt ?? null, Number(aw.createdAt), aw.createdBy || '', json(aw.payload || {}));
  }
  function getPendingAssignedWin(wallet) {
    const r = getPendingAssignedWinStmt.get(String(wallet));
    if (!r) return null;
    return { id:r.id, wallet:r.wallet, prizeId:r.prize_id, prizeName:r.prize_name, prizeType:r.prize_type,
      amount:Number(r.amount), note:r.note, status:r.status, usedAt:r.used_at ? Number(r.used_at) : null,
      createdAt:Number(r.created_at), createdBy:r.created_by, payload:parse(r.payload_json, {}) };
  }
  function getAssignedWin(id) {
    const r = getAssignedWinStmt.get(id);
    if (!r) return null;
    return { id:r.id, wallet:r.wallet, prizeId:r.prize_id, prizeName:r.prize_name, prizeType:r.prize_type,
      amount:Number(r.amount), note:r.note, status:r.status, usedAt:r.used_at ? Number(r.used_at) : null,
      createdAt:Number(r.created_at), createdBy:r.created_by };
  }
  function markAssignedWinUsed(id, usedAt) {
    markAssignedWinUsedStmt.run(Number(usedAt), id);
  }
  function deleteAssignedWin(id) {
    return deleteAssignedWinStmt.run(id).changes;
  }
  function listAssignedWins(status, limit = 100) {
    return listAssignedWinsStmt.all(status || '', status || '', Math.min(Math.max(Number(limit) || 100, 1), 500))
      .map(r => ({ id:r.id, wallet:r.wallet, prizeId:r.prize_id, prizeName:r.prize_name, prizeType:r.prize_type,
        amount:Number(r.amount), note:r.note, status:r.status, usedAt:r.used_at ? Number(r.used_at) : null,
        createdAt:Number(r.created_at), createdBy:r.created_by }));
  }
  function getSetting(key) {
    return db.prepare('SELECT payload_json FROM service_settings WHERE setting_key=?').get(String(key || ''))?.payload_json || null;
  }
  const listSettingsByPrefixStmt = db.prepare(`SELECT setting_key AS k, payload_json AS v FROM service_settings WHERE setting_key LIKE ?`);
  function listSettingsByPrefix(prefix) {
    return listSettingsByPrefixStmt.all(String(prefix || '') + '%');
  }
  const deleteSettingStmt = db.prepare(`DELETE FROM service_settings WHERE setting_key=?`);
  function deleteSetting(key) { deleteSettingStmt.run(String(key || '')); }
  function saveSetting(key, payloadJson) {
    upsertSetting.run(String(key || ''), String(payloadJson ?? ''), Date.now());
  }

  // ── 代理账号 CRUD ────────────────────────────────────────────────────────
  const insertAgentStmt = db.prepare(`INSERT INTO agent_accounts(id,username,password_hash,wallet_address,status,created_at,created_by,payload_json)
    VALUES(?,?,?,?,?,?,?,?)`);
  const listAgentsStmt = db.prepare(`SELECT * FROM agent_accounts ORDER BY created_at DESC`);
  const getAgentByIdStmt = db.prepare(`SELECT * FROM agent_accounts WHERE id=?`);
  const getAgentByUsernameStmt = db.prepare(`SELECT * FROM agent_accounts WHERE username=? COLLATE NOCASE`);
  const updateAgentStatusStmt = db.prepare(`UPDATE agent_accounts SET status=? WHERE id=?`);
  const updateAgentPasswordStmt = db.prepare(`UPDATE agent_accounts SET password_hash=? WHERE id=?`);
  const updateAgentWalletStmt = db.prepare(`UPDATE agent_accounts SET wallet_address=? WHERE id=?`);
  const deleteAgentStmt = db.prepare(`DELETE FROM agent_accounts WHERE id=?`);
  function presentAgent(r) {
    if (!r) return null;
    return { id:r.id, username:r.username, passwordHash:r.password_hash, walletAddress:r.wallet_address, status:r.status,
      createdAt:Number(r.created_at), createdBy:r.created_by, payload:parse(r.payload_json, {}) };
  }
  function createAgent({ id, username, passwordHash, walletAddress, createdBy = '' }) {
    const now = Date.now();
    insertAgentStmt.run(String(id), String(username), String(passwordHash), String(walletAddress), 'active', now, String(createdBy), '{}');
    return presentAgent(getAgentByIdStmt.get(id));
  }
  function listAgents() { return listAgentsStmt.all().map(presentAgent); }
  function getAgentById(id) { return presentAgent(getAgentByIdStmt.get(String(id || ''))); }
  function getAgentByUsername(username) { return presentAgent(getAgentByUsernameStmt.get(String(username || ''))); }
  function updateAgentStatus(id, status) {
    if (!['active','disabled'].includes(status)) throw new Error('代理状态无效');
    const r = updateAgentStatusStmt.run(status, String(id));
    return { updated: r.changes > 0 };
  }
  function updateAgentPassword(id, passwordHash) {
    const r = updateAgentPasswordStmt.run(String(passwordHash), String(id));
    return { updated: r.changes > 0 };
  }
  function updateAgentWallet(id, walletAddress) {
    const r = updateAgentWalletStmt.run(String(walletAddress), String(id));
    return { updated: r.changes > 0 };
  }
  function deleteAgent(id) {
    const r = deleteAgentStmt.run(String(id));
    return { deleted: r.changes > 0 };
  }

  const api = { adjustmentById, listBalanceAdjustmentsByWallet, aiRewardById, updateAiReward, applyBalanceAdjustment, db, updateAiRewardKind, updateReferralReward, deleteAuthRecord, file, findExecution, getLatestAuthForWallet, hasPlatformData, hasSchemaMigration, hasWalletData, insertAiReward, insertPermitSignature, insertReferralReward, listAiBatches, listAiManagedActiveWallets, listAiRewards, listBalanceAdjustments, listAuthRecords, listReferralLinks, listReferralRewards, loadPlatformAccount, loadPlatformState, loadWalletState, markPermitSignatureUsed, platformRecords, recordSchemaMigration, referralRewardById, replaceLedgerStates, replacePlatformState, replaceWalletState, replaceWalletStateInside, transaction, upsertAiBatch, upsertReferralLink, walletRecords,
    // A 币生态
    upsertATokenMinerRow, listATokenMiners, listActiveATokenMiners, listDueATokenMiners, listExpiringATokenMiners, adminListATokenMiners, adminMinerSummary, adminMinerTodaySummary, minerStats, insertATokenMinerReleaseRow, listATokenMinerReleases, listATokenMinerWallets, listATokenMinerWalletsByPlan, countATokenMinersByWallet,
    upsertATokenStakeRow, listATokenStakes, listActiveATokenStakes, listExpiringATokenStakes, insertATokenStakeRewardRow, listATokenStakeRewards,
    insertATokenTradeRow, listATokenTrades, listATokenTradesByWallet,
    insertATokenTransferRow, listATokenTransfers, getATokenTransferByRequestId,
    upsertATokenUserIdRow, getATokenUserId, getATokenUserIdByWallet,
    upsertATokenActivationRow, getATokenActivationById, getATokenActivationByTx, countConfirmedATokenActivations, countConfirmedATokenActivationsByPlan, listATokenActivations, listATokenActivationsByWallet,
    listConfirmedATokenActivationsByCollection,
    countATokenActivationsByWalletPlan,
    insertATokenBurnRow, totalATokenBurned,
    upsertATokenWithdrawalRow, getATokenWithdrawalById, getATokenWithdrawalByRequestId, listATokenWithdrawalsByWallet, listPendingATokenWithdrawals, listATokenWithdrawalsByStatus, sumATokenWithdrawalsByWalletToday,
    upsertATokenClaimRow, getATokenClaimById, listATokenClaimsByWallet, listPendingATokenClaims, sumATokenClaimsByWalletToday,
    upsertATokenTeamLevelRow, getATokenTeamLevel,
    getATokenSellQuota, addATokenSellQuota, consumeATokenSellQuota, refundATokenSellQuota,
    insertRunAixRun, getRunAixRun, getPendingRunAixRun, settleRunAixRun, updateRunAixPayload, listRunAixRuns, getRunAixStats,
    getHashAixSeed, upsertHashAixSeed, insertHashAixBet, listHashAixBets, getHashAixStats,
    insertATokenTeamRewardRow, listATokenTeamRewards,
    insertATokenDirectCountRewardRow, listATokenDirectCountRewards,
    listATokenTeamLevelsByLevel, listAllATokenTeamLevels,
    getATokenTeamStatsOverride, listATokenTeamStatsOverrides, upsertATokenTeamStatsOverride, deleteATokenTeamStatsOverride,
    getA10Pool, upsertA10Pool, listA10PoolHistory,
    upsertATokenKlineRow, listATokenKlines, clearATokenKlines, countATokenKlines,
    insertATokenOrderRow, markATokenOrderFilled, markATokenOrderCancelled,
    updateATokenOrderInputs, updateATokenOrderMarketPrice, sumATokenOpenBuyUsdt, sumATokenLockedByWallet,
    getATokenOrder, listATokenOpenOrders, listATokenOrdersByWallet, countATokenOrdersByStatus,
    insertSupportTicketRow, getSupportTicketByWallet, getSupportTicketById, listSupportTickets,
    addSupportMessage, listSupportMessages, markSupportReadByUser, markSupportReadByAdmin,
    setSupportTicketStatus, countSupportAdminUnread,
    // 积分抽奖
    upsertLotteryAccount, getLotteryAccount, insertLotteryFlow, listLotteryFlows,
    insertLotteryWin, getLotteryWin, updateLotteryWin, listLotteryWins, listRecentLotteryWins,
    listLotteryWinsSince, listLotteryWinsByType,
    insertSocialSubmission, getSocialSubmission, updateSocialSubmission, listSocialSubmissions, listSocialSubmissionsSince,
    insertAssignedWin, getPendingAssignedWin, getAssignedWin, markAssignedWinUsed, deleteAssignedWin, listAssignedWins,
    getSetting, saveSetting, listSettingsByPrefix, deleteSetting,
    upsertAirdropAccount, getAirdropAccount, insertAirdropFlow, listAirdropFlows, findAirdropFlowByRef, sumAirdropFlowsWeek,
    // 代理账号
    createAgent, listAgents, getAgentById, getAgentByUsername, updateAgentStatus, updateAgentPassword, updateAgentWallet, deleteAgent,
  };
  instances.set(root, api);
  return api;
}

export function closeDatabase(dataRoot) {
  const root = path.resolve(dataRoot || '.');
  const instance = instances.get(root);
  if (!instance) return;
  try { instance.db.close(); } finally { instances.delete(root); }
}

const { getSetting } = require('./db');

function normalizedLimit(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function userSpendLimit(db, userId) {
  const row = db.prepare(`
    SELECT u.spend_limit_mode, u.spend_limit_minor, g.spend_limit_minor AS group_limit_minor
    FROM users u LEFT JOIN user_groups g ON g.id = u.group_id WHERE u.id = ?
  `).get(Number(userId));
  if (!row) return null;
  if (row.spend_limit_mode === 'custom') return normalizedLimit(row.spend_limit_minor);
  return normalizedLimit(row.group_limit_minor);
}

function cardSpendLimit(db, card) {
  if (!card) return null;
  if (card.spendLimitMode === 'custom' || card.spend_limit_mode === 'custom') {
    return normalizedLimit(card.spendLimitMinor ?? card.spend_limit_minor);
  }
  return userSpendLimit(db, card.ownerUserId ?? card.owner_user_id);
}

function resolvedOverdraft(card) {
  const custom = (card.overdraftMode ?? card.overdraft_mode) === 'custom';
  const limitMinor = custom
    ? Number(card.overdraftLimitMinor ?? card.overdraft_limit_minor ?? 0)
    : Number(card.binOverdraftLimitMinor ?? card.bin_overdraft_limit_minor ?? 500000);
  const feeBps = custom
    ? Number(card.overdraftFeeBps ?? card.overdraft_fee_bps ?? 0)
    : Number(card.binOverdraftFeeBps ?? card.bin_overdraft_fee_bps ?? 500);
  const minFeeMinor = custom
    ? Number(card.overdraftMinFeeMinor ?? card.overdraft_min_fee_minor ?? 1)
    : Number(card.binOverdraftMinFeeMinor ?? card.bin_overdraft_min_fee_minor ?? 100);
  const warningBps = custom
    ? Number(card.overdraftWarningBps ?? card.overdraft_warning_bps ?? 9500)
    : Number(card.binOverdraftWarningBps ?? card.bin_overdraft_warning_bps ?? 9500);
  const enabled = (card.cardType ?? card.card_type) === 'credit' && limitMinor > 0;
  return {
    enabled,
    limitMinor: Math.max(0, Math.floor(limitMinor)),
    feeBps: Math.max(0, Math.min(10000, Math.floor(feeBps))),
    minFeeMinor: Math.max(1, Math.floor(minFeeMinor || 1)),
    warningBps: Math.max(1, Math.min(10000, Math.floor(warningBps || 9500)))
  };
}

function overdraftFeeMinor(card, amountMinor) {
  const balance = Number(card.balanceMinor ?? card.balance_minor);
  const amount = Number(amountMinor);
  const excess = Math.max(0, amount - Math.max(0, balance));
  if (excess <= 0) return 0;
  const config = resolvedOverdraft(card);
  if (!config.enabled || config.feeBps <= 0) return 0;
  const rateFee = Math.ceil(excess * config.feeBps / 10000);
  return Math.max(rateFee, config.minFeeMinor);
}

function calculateCardDebit(card, amountMinor) {
  const amount = Number(amountMinor);
  const balance = Number(card.balanceMinor ?? card.balance_minor);
  const config = resolvedOverdraft(card);
  const feeMinor = overdraftFeeMinor(card, amount);
  const totalDebitMinor = amount + feeMinor;
  const nextBalanceMinor = balance - totalDebitMinor;
  const floorMinor = config.enabled ? -config.limitMinor : 0;
  if (nextBalanceMinor < floorMinor) {
    return {
      ok: false,
      code: 'INSUFFICIENT_FUNDS',
      message: config.enabled ? '卡片余额及剩余透支额度不足' : 'Insufficient card balance',
      feeMinor,
      totalDebitMinor,
      nextBalanceMinor,
      config
    };
  }
  return { ok: true, feeMinor, totalDebitMinor, nextBalanceMinor, config };
}

function applyCardDebit(db, card, amountMinor, { note, orderId = null, now = Date.now() } = {}) {
  const result = calculateCardDebit(card, amountMinor);
  if (!result.ok) return result;
  db.prepare('UPDATE cards SET balance_minor = ?, last_used_at = ?, updated_at = ?, consecutive_failures = 0 WHERE id = ?')
    .run(result.nextBalanceMinor, now, now, card.id);
  db.prepare(`
    INSERT INTO card_transactions (card_id, order_id, type, amount_minor, balance_after_minor, note, created_at)
    VALUES (?, ?, 'DEBIT', ?, ?, ?, ?)
  `).run(card.id, orderId, result.totalDebitMinor, result.nextBalanceMinor, note, now);
  return result;
}

function recordInsufficientFailure(db, card, event = 'INSUFFICIENT_FUNDS') {
  const current = db.prepare('SELECT consecutive_failures, status, owner_user_id FROM cards WHERE id = ?').get(card.id);
  if (!current) return { failures: 0, frozen: false };
  const failures = Number(current.consecutive_failures || 0) + 1;
  const frozen = failures >= 5;
  db.prepare(`UPDATE cards SET consecutive_failures = ?, status = CASE WHEN ? = 1 THEN 'frozen' ELSE status END,
    freeze_source = CASE WHEN ? = 1 THEN 'automatic' ELSE freeze_source END,
    freeze_code = CASE WHEN ? = 1 THEN 'CONSECUTIVE_INSUFFICIENT' ELSE freeze_code END,
    decline_reason = CASE WHEN ? = 1 THEN '连续 5 次余额不足，已自动冻结' ELSE decline_reason END,
    updated_at = ? WHERE id = ?`).run(failures, frozen ? 1 : 0, frozen ? 1 : 0, frozen ? 1 : 0, frozen ? 1 : 0, Date.now(), card.id);
  if (frozen) {
    const owner = db.prepare('SELECT uid FROM users WHERE id = ?').get(Number(current.owner_user_id));
    db.prepare('INSERT INTO risk_events (user_id, user_uid, actor_uid, event, details, created_at) VALUES (?, ?, NULL, ?, ?, ?)')
      .run(Number(current.owner_user_id), owner?.uid ?? null, 'CARD_AUTO_FROZEN', `连续 5 次余额或透支额度不足：${event}`, Date.now());
  }
  return { failures, frozen };
}

function maybeFreezeForOverdraftWarning(db, card, nextBalanceMinor, config) {
  if (!config.enabled || nextBalanceMinor >= 0 || config.limitMinor <= 0) return false;
  const used = -nextBalanceMinor;
  if (used * 10000 < config.limitMinor * config.warningBps) return false;
  db.prepare(`UPDATE cards SET status = 'frozen', freeze_source = 'automatic', freeze_code = 'OVERDRAFT_WARNING',
    decline_reason = ?, updated_at = ? WHERE id = ?`)
    .run(`透支额度使用达到 ${(config.warningBps / 100).toFixed(2)}%，充值到正余额后可自助解冻`, Date.now(), card.id);
  const owner = db.prepare('SELECT uid FROM users WHERE id = ?').get(Number(card.ownerUserId ?? card.owner_user_id));
  db.prepare('INSERT INTO risk_events (user_id, user_uid, actor_uid, event, details, created_at) VALUES (?, ?, NULL, ?, ?, ?)')
    .run(Number(card.ownerUserId ?? card.owner_user_id), owner?.uid ?? null, 'OVERDRAFT_WARNING_FROZEN', `透支额度使用 ${(used / 100).toFixed(2)} / ${(config.limitMinor / 100).toFixed(2)}`, Date.now());
  return true;
}

function unfreezeFeeMinor(db, card) {
  const config = resolvedOverdraft(card);
  if (config.enabled) return 0;
  const binFee = card.binUnfreezeFeeMinor ?? card.bin_unfreeze_fee_minor;
  if (binFee !== null && binFee !== undefined) return Math.max(0, Number(binFee));
  return Math.max(0, Number(getSetting(db, 'card_unfreeze_fee_minor', '10000')) || 0);
}

module.exports = {
  normalizedLimit,
  userSpendLimit,
  cardSpendLimit,
  resolvedOverdraft,
  overdraftFeeMinor,
  calculateCardDebit,
  applyCardDebit,
  recordInsufficientFailure,
  maybeFreezeForOverdraftWarning,
  unfreezeFeeMinor
};

const { getSetting, cardById, cardByNumberHash } = require('./db');
const { formatCardLabel } = require('./card-format');
const { userSpendLimit, cardSpendLimit, resolvedOverdraft, unfreezeFeeMinor } = require('./card-service');

function transferFee(amountMinor, bps, minFeeMinor) {
  const normalizedBps = Math.max(0, Number(bps) || 0);
  const normalizedMinimum = Math.max(0, Number(minFeeMinor) || 0);
  const rateFee = Math.ceil(amountMinor * normalizedBps / 10000);
  const effectiveMinimum = normalizedBps > 0 ? Math.max(1, normalizedMinimum) : normalizedMinimum;
  return Math.max(rateFee, effectiveMinimum);
}

function accountTransaction(db, userId, type, amountMinor, note, orderId = null) {
  const user = db.prepare('SELECT id, uid, account_balance_minor FROM users WHERE id = ?').get(Number(userId));
  if (!user) {
    const error = new Error('用户不存在。');
    error.statusCode = 404;
    throw error;
  }
  const nextBalance = Number(user.account_balance_minor) + Number(amountMinor);
  if (nextBalance < 0) {
    const error = new Error('账户余额不足。');
    error.statusCode = 409;
    throw error;
  }
  db.prepare('UPDATE users SET account_balance_minor = ?, updated_at = ? WHERE id = ?').run(nextBalance, Date.now(), user.id);
  db.prepare(`
    INSERT INTO account_transactions (user_id, user_uid, order_id, type, amount_minor, balance_after_minor, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(user.id, user.uid, orderId, type, Number(amountMinor), nextBalance, note, Date.now());
  return nextBalance;
}

function depositToCard({ db, config, user, cardId, amountMinor }) {
  const card = cardById(db, config.appSecret, cardId, false);
  if (!card || card.ownerUserId !== user.id) throw Object.assign(new Error('虚拟卡不存在或不属于当前用户。'), { statusCode: 404 });
  if (card.currency !== 'CNY') throw Object.assign(new Error('当前账户余额仅支持 CNY，无法与外币卡互转。'), { statusCode: 409 });
  const minimum = Number(getSetting(db, 'card_min_deposit_minor', '0')) || 0;
  if (amountMinor < minimum || amountMinor <= 0) throw Object.assign(new Error('充值金额低于最低充值金额。'), { statusCode: 400 });
  const fee = transferFee(amountMinor, Number(getSetting(db, 'card_deposit_fee_bps', '0')) || 0, Number(getSetting(db, 'card_min_deposit_fee_minor', '0')) || 0);
  const limit = user.cardBalanceLimitMinor;
  if (limit !== null && limit !== undefined && card.balanceMinor + amountMinor > limit) {
    throw Object.assign(new Error('充值后卡内余额将超过账户的卡面额度。'), { statusCode: 409 });
  }
  return db.transaction(() => {
    accountTransaction(db, user.id, 'CARD_DEPOSIT', -(amountMinor + fee), `充值到卡片 ${formatCardLabel(card)}，手续费 ${(fee / 100).toFixed(2)}`);
    const nextCardBalance = card.balanceMinor + amountMinor;
    db.prepare('UPDATE cards SET balance_minor = ?, updated_at = ? WHERE id = ?').run(nextCardBalance, Date.now(), card.id);
    db.prepare(`
      INSERT INTO card_transactions (card_id, order_id, type, amount_minor, balance_after_minor, note, created_at)
      VALUES (?, NULL, 'CREDIT', ?, ?, ?, ?)
    `).run(card.id, amountMinor, nextCardBalance, `账户充值，手续费 ${(fee / 100).toFixed(2)}`, Date.now());
    return { fee, credited: amountMinor, cardBalanceMinor: nextCardBalance };
  })();
}

function withdrawFromCard({ db, config, user, cardId, amountMinor }) {
  if (getSetting(db, 'card_withdraw_enabled', '1') !== '1') throw Object.assign(new Error('管理员未开启卡内余额提现。'), { statusCode: 403 });
  const card = cardById(db, config.appSecret, cardId, false);
  if (!card || card.ownerUserId !== user.id) throw Object.assign(new Error('虚拟卡不存在或不属于当前用户。'), { statusCode: 404 });
  if (card.status === 'frozen') throw Object.assign(new Error('冻结卡片不能转出余额，请先解冻。'), { statusCode: 409 });
  if (card.currency !== 'CNY') throw Object.assign(new Error('当前账户余额仅支持 CNY，无法与外币卡互转。'), { statusCode: 409 });
  const minimum = Number(getSetting(db, 'card_min_withdraw_minor', '0')) || 0;
  if (amountMinor < minimum || amountMinor <= 0) throw Object.assign(new Error('提现金额低于最低提现金额。'), { statusCode: 400 });
  if (card.balanceMinor < amountMinor) throw Object.assign(new Error('卡内余额不足。'), { statusCode: 409 });
  const fee = transferFee(amountMinor, Number(getSetting(db, 'card_withdraw_fee_bps', '0')) || 0, Number(getSetting(db, 'card_min_withdraw_fee_minor', '0')) || 0);
  const credited = amountMinor - fee;
  if (credited <= 0) throw Object.assign(new Error('提现金额不足以支付手续费。'), { statusCode: 400 });
  return db.transaction(() => {
    const nextCardBalance = card.balanceMinor - amountMinor;
    db.prepare('UPDATE cards SET balance_minor = ?, updated_at = ? WHERE id = ?').run(nextCardBalance, Date.now(), card.id);
    db.prepare(`
      INSERT INTO card_transactions (card_id, order_id, type, amount_minor, balance_after_minor, note, created_at)
      VALUES (?, NULL, 'DEBIT', ?, ?, ?, ?)
    `).run(card.id, amountMinor, nextCardBalance, `提现到账户，手续费 ${(fee / 100).toFixed(2)}`, Date.now());
    const accountBalance = accountTransaction(db, user.id, 'CARD_WITHDRAW', credited, `${formatCardLabel(card)} 提现，手续费 ${(fee / 100).toFixed(2)}`);
    return { fee, credited, accountBalanceMinor: accountBalance, cardBalanceMinor: nextCardBalance };
  })();
}

function internalTransfer({ db, config, user, sourceType, sourceCardId, recipientCardNumber, recipientUsername, amountMinor, note = '' }) {
  if (!['account', 'card'].includes(sourceType)) throw Object.assign(new Error('转账来源无效。'), { statusCode: 400 });
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw Object.assign(new Error('转账金额无效。'), { statusCode: 400 });
  if (sourceType === 'account') {
    const limit = userSpendLimit(db, user.id);
    if (limit !== null && amountMinor > limit) throw Object.assign(new Error(`单笔转账超过账户消费限额 CNY ${(limit / 100).toFixed(2)}。`), { statusCode: 409 });
  }
  let sourceCard = null;
  if (sourceType === 'card') {
    sourceCard = cardById(db, config.appSecret, sourceCardId, false);
    if (!sourceCard || sourceCard.ownerUserId !== user.id) throw Object.assign(new Error('转出来源卡不存在或不属于当前用户。'), { statusCode: 404 });
    if (sourceCard.status === 'frozen') throw Object.assign(new Error('冻结卡片不能发起转账，请先解冻。'), { statusCode: 409 });
    if (sourceCard.currency !== 'CNY') throw Object.assign(new Error('转账仅支持 CNY 卡片。'), { statusCode: 409 });
    const limit = cardSpendLimit(db, sourceCard);
    if (limit !== null && amountMinor > limit) throw Object.assign(new Error(`单笔转账超过该卡消费限额 CNY ${(limit / 100).toFixed(2)}。`), { statusCode: 409 });
  }
  const normalizedNumber = String(recipientCardNumber || '').replace(/\D/g, '');
  const recipientUsernameValue = String(recipientUsername || '').trim();
  if (normalizedNumber.length < 12 || !recipientUsernameValue) throw Object.assign(new Error('请填写对方银行卡号和用户名。'), { statusCode: 400 });
  const recipientCard = cardByNumberHash(db, config.appSecret, normalizedNumber);
  if (!recipientCard || String(recipientCard.ownerUsername || '').toLowerCase() !== recipientUsernameValue.toLowerCase()) {
    throw Object.assign(new Error('对方卡号与用户名不匹配。'), { statusCode: 404 });
  }
  const recipientOwner = db.prepare('SELECT is_active, deleted_at, account_risk FROM users WHERE id = ?').get(Number(recipientCard.ownerUserId));
  if (!recipientOwner || !recipientOwner.is_active || recipientOwner.deleted_at || recipientOwner.account_risk === 'blocked') {
    throw Object.assign(new Error('收款人账号当前不可用。'), { statusCode: 409 });
  }
  if (recipientCard.ownerUserId === user.id) throw Object.assign(new Error('只能向其他用户转账。'), { statusCode: 400 });
  if (recipientCard.status !== 'active') throw Object.assign(new Error('对方卡片当前不可收款。'), { statusCode: 409 });
  if (recipientCard.currency !== 'CNY') throw Object.assign(new Error('对方卡片不是 CNY 账户，无法转账。'), { statusCode: 409 });
  if (sourceCard && sourceCard.id === recipientCard.id) throw Object.assign(new Error('不能向同一张卡转账。'), { statusCode: 400 });
  const fee = transferFee(amountMinor, Number(getSetting(db, 'internal_transfer_fee_bps', '0')) || 0, Number(getSetting(db, 'internal_transfer_min_fee_minor', '0')) || 0);
  const total = amountMinor + fee;
  if (sourceType === 'account' && user.accountBalanceMinor < total) throw Object.assign(new Error('账户余额不足以支付转账金额和手续费。'), { statusCode: 409 });
  if (sourceCard && sourceCard.balanceMinor < total) throw Object.assign(new Error('卡片余额不足以支付转账金额和手续费。'), { statusCode: 409 });
  const reference = `TRANSFER-${Date.now()}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  return db.transaction(() => {
    const now = Date.now();
    const currentUser = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1 AND account_risk <> \'blocked\'').get(user.id);
    if (!currentUser) throw Object.assign(new Error('当前账户不可用。'), { statusCode: 403 });
    if (sourceType === 'account') {
      accountTransaction(db, user.id, 'INTERNAL_TRANSFER_OUT', -total, `转账给 ${recipientCard.ownerUsername}，手续费 ${(fee / 100).toFixed(2)}`);
    } else {
      const latestCard = db.prepare('SELECT * FROM cards WHERE id = ? AND status <> \'frozen\'').get(sourceCard.id);
      if (!latestCard || latestCard.balance_minor < total) throw Object.assign(new Error('卡片余额已发生变化，请刷新后重试。'), { statusCode: 409 });
      const nextBalance = latestCard.balance_minor - total;
      db.prepare('UPDATE cards SET balance_minor = ?, updated_at = ?, consecutive_failures = 0 WHERE id = ?').run(nextBalance, now, latestCard.id);
      db.prepare(`INSERT INTO card_transactions (card_id, order_id, type, amount_minor, balance_after_minor, note, created_at)
        VALUES (?, NULL, 'DEBIT', ?, ?, ?, ?)`).run(latestCard.id, total, nextBalance, `转账给 ${recipientCard.ownerUsername}，手续费 ${(fee / 100).toFixed(2)}`, now);
    }
    const latestRecipient = db.prepare("SELECT * FROM cards WHERE id = ? AND status = 'active'").get(recipientCard.id);
    if (!latestRecipient) throw Object.assign(new Error('对方卡片状态已发生变化。'), { statusCode: 409 });
    const recipientBalance = latestRecipient.balance_minor + amountMinor;
    db.prepare('UPDATE cards SET balance_minor = ?, updated_at = ? WHERE id = ?').run(recipientBalance, now, latestRecipient.id);
    db.prepare(`INSERT INTO card_transactions (card_id, order_id, type, amount_minor, balance_after_minor, note, created_at)
      VALUES (?, NULL, 'CREDIT', ?, ?, ?, ?)`).run(latestRecipient.id, amountMinor, recipientBalance, `收到 ${user.username} 的转账`, now);
    db.prepare(`INSERT INTO internal_transfers
      (reference, sender_user_id, sender_uid, recipient_user_id, recipient_uid, source_type, source_card_id, recipient_card_id,
        source_last4, recipient_last4, amount_minor, fee_minor, total_debit_minor, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(reference, user.id, user.uid, recipientCard.ownerUserId, recipientCard.ownerUid, sourceType, sourceCard?.id || null, recipientCard.id,
      sourceCard?.last4 || null, recipientCard.last4, amountMinor, fee, total, String(note || '').slice(0, 200), now);
    return { reference, fee, amountMinor, recipientUsername: recipientCard.ownerUsername };
  })();
}

function cancelOwnCard({ db, config, user, cardId }) {
  const card = cardById(db, config.appSecret, cardId, false);
  if (!card || card.ownerUserId !== user.id) throw Object.assign(new Error('虚拟卡不存在或不属于当前用户。'), { statusCode: 404 });
  if (card.status === 'frozen') throw Object.assign(new Error('冻结卡片不能注销，请先解冻。'), { statusCode: 409 });
  if (card.balanceMinor !== 0) throw Object.assign(new Error('卡内余额不为 0，请先转出到账户余额后再注销。'), { statusCode: 409 });
  return db.transaction(() => {
    const pending = db.prepare("SELECT COUNT(*) AS count FROM orders WHERE card_id = ? AND (status = 'PENDING' OR (status = 'PAID' AND settled_at IS NULL))").get(card.id).count;
    if (pending) throw Object.assign(new Error('该卡仍有进行中或待结算订单，暂不能注销。'), { statusCode: 409 });
    db.prepare('UPDATE orders SET card_id = NULL WHERE card_id = ?').run(card.id);
    db.prepare('DELETE FROM card_transactions WHERE card_id = ?').run(card.id);
    db.prepare('DELETE FROM cards WHERE id = ?').run(card.id);
  })();
}

function unfreezeCard({ db, card, actor, selfService = false }) {
  if (!card || card.status !== 'frozen') throw Object.assign(new Error('只有冻结状态的卡片可以解冻。'), { statusCode: 409 });
  if (selfService && card.freezeSource !== 'automatic') throw Object.assign(new Error('该卡由管理员冻结，请联系管理员解冻。'), { statusCode: 403 });
  const overdraft = resolvedOverdraft(card);
  if (selfService && card.freezeSource === 'automatic' && card.freezeCode === 'OVERDRAFT_WARNING' && overdraft.enabled && Number(card.balanceMinor) <= 0) {
    throw Object.assign(new Error('透支预警冻结的卡片需要先充值，使卡内余额大于 0 后才能解冻。'), { statusCode: 409 });
  }
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(card.ownerUserId));
  if (!owner) throw Object.assign(new Error('卡片所属用户不存在。'), { statusCode: 404 });
  const fee = selfService ? unfreezeFeeMinor(db, card) : 0;
  return db.transaction(() => {
    if (fee > 0) accountTransaction(db, owner.id, 'CARD_UNFREEZE_FEE', -fee, `解冻虚拟卡 ${card.binName || ''} ***${card.last4}`);
    db.prepare(`UPDATE cards SET status = 'active', freeze_source = 'none', freeze_code = NULL, decline_reason = NULL,
      consecutive_failures = 0, updated_at = ? WHERE id = ?`).run(Date.now(), card.id);
    db.prepare('INSERT INTO risk_events (user_id, user_uid, actor_uid, event, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(owner.id, owner.uid, actor?.uid ?? owner.uid, 'CARD_UNFROZEN', `解冻费 ${(fee / 100).toFixed(2)} CNY`, Date.now());
    return { fee, ownerUid: owner.uid };
  })();
}

module.exports = { transferFee, accountTransaction, depositToCard, withdrawFromCard, internalTransfer, cancelOwnCard, unfreezeCard };

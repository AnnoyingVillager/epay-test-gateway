const { getSetting, cardById } = require('./db');
const { formatCardLabel } = require('./card-format');

function transferFee(amountMinor, bps, minFeeMinor) {
  const rateFee = Math.floor(amountMinor * bps / 10000);
  return Math.max(rateFee, minFeeMinor);
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
  if (card.status !== 'active') throw Object.assign(new Error('只有状态正常的虚拟卡可以充值。'), { statusCode: 409 });
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

module.exports = { transferFee, accountTransaction, depositToCard, withdrawFromCard };

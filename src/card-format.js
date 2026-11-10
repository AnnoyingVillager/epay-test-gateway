function formatCardShort(card) {
  if (!card) return '-';
  return `${card.binPrefix || ''}***${card.last4 || ''}`;
}

function formatCardLabel(card) {
  if (!card) return '-';
  const cardType = card.cardType === 'credit' ? '信用卡' : '借记卡';
  return `${card.binName || card.brand || '未知 BIN'}（${cardType}） ${formatCardShort(card)}`;
}

function maskCardReferences(note, cards = []) {
  if (!note) return note;
  const cardsById = new Map((cards || []).map((card) => [String(card.id), card]));
  return String(note).replace(/CARD-[A-Z0-9]+/gi, (cardId) => {
    const card = cardsById.get(cardId.toUpperCase());
    return card ? formatCardLabel(card) : '虚拟卡';
  });
}

module.exports = { formatCardShort, formatCardLabel, maskCardReferences };

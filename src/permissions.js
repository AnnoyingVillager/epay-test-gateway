function isAdmin(user) {
  return Boolean(user && user.role === 'admin');
}

function isSuperAdmin(user) {
  return Boolean(isAdmin(user) && user.isSuperAdmin && Number(user.uid) === 0);
}

function roleLabel(user) {
  if (isSuperAdmin(user)) return '超级管理员';
  if (isAdmin(user)) return '管理员';
  return '普通用户';
}

function canManageUser(actor, target) {
  if (!isAdmin(actor) || !target) return false;
  if (isSuperAdmin(actor)) return Number(target.uid) !== 0 || Number(target.id) === Number(actor.id);
  if (Number(target.uid) === 0) return false;
  return target.role !== 'admin';
}

function canManageCardOwner(actor, owner) {
  if (!isAdmin(actor)) return false;
  if (isSuperAdmin(actor)) return true;
  if (!owner || Number(owner.uid) === 0) return false;
  return Number(owner.id) === Number(actor.id) || owner.role !== 'admin';
}

function canRefundOrder(actor, order) {
  if (!isAdmin(actor) || !order) return false;
  if (isSuperAdmin(actor)) return true;
  return order.paymentMethod === 'card' && order.cardTypeSnapshot === 'credit';
}

function requireSuperAdmin(req, res, next) {
  if (!req.user) return res.redirect('/admin/login');
  if (isSuperAdmin(req.user)) return next();
  return res.status(403).render('error', {
    title: '没有访问权限',
    message: '该功能仅限超级管理员访问。',
    statusCode: 403
  });
}

module.exports = {
  isAdmin,
  isSuperAdmin,
  roleLabel,
  canManageUser,
  canManageCardOwner,
  canRefundOrder,
  requireSuperAdmin
};

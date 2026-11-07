const nodemailer = require('nodemailer');
const { getSetting } = require('./db');
const { decrypt } = require('./crypto');

class Mailer {
  constructor({ db, config, logger = console }) {
    this.db = db;
    this.config = config;
    this.logger = logger;
  }

  createTransport() {
    const host = getSetting(this.db, 'smtp_host', '').trim();
    if (!host) throw new Error('尚未配置 SMTP 发件服务器，请联系管理员。');
    const port = Number.parseInt(getSetting(this.db, 'smtp_port', '587'), 10) || 587;
    const secure = getSetting(this.db, 'smtp_secure', '0') === '1';
    const user = getSetting(this.db, 'smtp_user', '').trim();
    const encryptedPassword = getSetting(this.db, 'smtp_password_enc', '').trim();
    const password = encryptedPassword ? decrypt(encryptedPassword, this.config.appSecret) : '';
    return nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user ? { user, pass: password } : undefined,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000
    });
  }

  async sendVerificationCode(email, code, ttlSeconds = 600) {
    const transport = this.createTransport();
    const from = getSetting(this.db, 'mail_from', '').trim() || getSetting(this.db, 'smtp_user', '').trim();
    if (!from) throw new Error('尚未配置发件邮箱地址，请联系管理员。');
    const minutes = Math.max(1, Math.ceil(Number(ttlSeconds || 600) / 60));
    await transport.sendMail({
      from,
      to: email,
      subject: `Epay Test Gateway 邮箱验证码：${code}`,
      text: `您的邮箱验证码是 ${code}，${minutes} 分钟内有效。请勿将验证码提供给他人。`,
      html: `<p>您的邮箱验证码是：</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>${minutes} 分钟内有效。请勿将验证码提供给他人。</p>`
    });
  }
}

module.exports = { Mailer };
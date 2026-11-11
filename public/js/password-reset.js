document.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('[data-password-reset-form]');
  const button = document.querySelector('[data-send-reset-code]');
  const status = document.querySelector('[data-reset-code-status]');
  if (!form || !button) return;

  button.addEventListener('click', async () => {
    const username = form.querySelector('input[name="username"]')?.value.trim() || '';
    const email = form.querySelector('input[name="email"]')?.value.trim() || '';
    if (!username || !email) {
      if (status) status.textContent = '请先填写用户名和账号绑定邮箱。';
      return;
    }
    button.disabled = true;
    const original = button.textContent;
    button.textContent = '发送中...';
    try {
      const response = await fetch('/admin/forgot-password/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username, email })
      });
      const data = await response.json();
      if (status) status.textContent = data.message || (data.ok ? '验证码已发送。' : '发送失败，请联系管理员。');
    } catch {
      if (status) status.textContent = '网络异常，验证码发送失败，请联系管理员。';
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  });
});

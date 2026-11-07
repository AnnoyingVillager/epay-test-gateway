document.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('[data-register-form]');
  const button = document.querySelector('[data-send-code]');
  const status = document.querySelector('[data-code-status]');
  if (!form || !button) return;
  button.addEventListener('click', async () => {
    const email = form.querySelector('input[name="email"]')?.value.trim() || '';
    if (!email) { if (status) status.textContent = '请先填写邮箱地址。'; return; }
    button.disabled = true;
    const original = button.textContent;
    button.textContent = '发送中...';
    try {
      const response = await fetch('/register/send-code', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ email }) });
      const data = await response.json();
      if (status) status.textContent = data.message || (data.ok ? '验证码已发送。' : '发送失败。');
    } catch {
      if (status) status.textContent = '网络异常，验证码发送失败。';
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  });
});
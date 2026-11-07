document.addEventListener('DOMContentLoaded', () => {
  const countdownBox = document.querySelector('[data-expires]');
  const countdown = document.querySelector('[data-countdown]');
  const payButton = document.querySelector('[data-pay-button]');
  const payForm = document.querySelector('.pay-form');
  let submitting = false;

  function showPaymentError(message) {
    if (!payForm) return;
    let alert = payForm.querySelector('[data-payment-error]');
    if (!alert) {
      alert = document.createElement('div');
      alert.className = 'alert alert-danger';
      alert.setAttribute('role', 'alert');
      alert.setAttribute('data-payment-error', '');
      payForm.prepend(alert);
    }
    alert.textContent = message;
  }

  function resetPayButton() {
    submitting = false;
    if (!payButton) return;
    payButton.disabled = false;
    payButton.classList.remove('is-submitting');
    payButton.removeAttribute('aria-busy');
    payButton.textContent = `确认支付 ${payButton.dataset.currency || ''} ${payButton.dataset.amount || ''}`.trim();
  }

  function showCompletion(title, message) {
    if (!payForm) return;
    payForm.hidden = true;
    const state = document.createElement('div');
    state.className = 'payment-state payment-state-paid';
    const heading = document.createElement('strong');
    heading.textContent = title;
    const detail = document.createElement('p');
    detail.textContent = message;
    state.append(heading, detail);
    payForm.parentElement.append(state);
  }


  document.querySelectorAll('form[data-payment-submit]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      if (form.dataset.submitting === '1') {
        event.preventDefault();
        return;
      }
      form.dataset.submitting = '1';
      form.querySelectorAll('button, input[type="submit"]').forEach((button) => {
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
      });
      const primary = form.querySelector('button[type="submit"]');
      if (primary) primary.textContent = '正在处理...';
    });
  });
  if (payForm && payButton) {
    payButton.dataset.currency = payButton.dataset.currency || '';
    payButton.dataset.amount = payButton.dataset.amount || '';
    payForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submitting) return;
      submitting = true;
      payButton.disabled = true;
      payButton.classList.add('is-submitting');
      payButton.textContent = '正在处理支付...';
      payButton.setAttribute('aria-busy', 'true');

      try {
        const response = await fetch(payForm.action, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'X-Payment-Ajax': '1'
          },
          body: new URLSearchParams(new FormData(payForm))
        });
        const data = await response.json();

        if (data.ok) {
          showCompletion('订单已完成', '支付成功，正在自动返回商户网站...');
          if (data.redirectUrl) setTimeout(() => window.location.assign(data.redirectUrl), 1400);
          return;
        }

        if (data.redirectUrl) {
          showCompletion('支付未完成', '正在按 Epay 标准返回商户网站...');
          setTimeout(() => window.location.assign(data.redirectUrl), 1400);
          return;
        }

        showPaymentError(data.error?.message || '支付失败，请重试。');
        resetPayButton();
      } catch {
        showPaymentError('网络异常，支付请求未完成，请重试。');
        resetPayButton();
      }
    });
  }

  if (!countdownBox || !countdown) return;

  const expiresAt = Number(countdownBox.getAttribute('data-expires'));
  let timer = null;

  function render() {
    const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    const minutes = String(Math.floor(remaining / 60)).padStart(2, '0');
    const seconds = String(remaining % 60).padStart(2, '0');
    countdown.textContent = `${minutes}:${seconds}`;
    if (remaining <= 0) {
      countdownBox.classList.add('expired');
      if (payButton) {
        payButton.disabled = true;
        payButton.textContent = '订单已超时';
      }
      if (payForm) {
        payForm.querySelectorAll('input, button').forEach((element) => { element.disabled = true; });
      }
      if (timer) clearInterval(timer);
    }
  }

  render();
  timer = setInterval(render, 1000);

  const statusUrl = countdownBox.getAttribute('data-order-status-url') || '';
  const initialStatus = countdownBox.getAttribute('data-order-status') || '';
  if (statusUrl && initialStatus === 'PENDING') {
    let checkingStatus = false;
    async function checkOrderStatus() {
      if (checkingStatus || document.hidden) return;
      checkingStatus = true;
      try {
        const response = await fetch(statusUrl, { headers: { Accept: 'application/json' }, cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json();
        if (data.ok && data.status && data.status !== 'PENDING') window.location.reload();
      } catch {
        // Polling should not interrupt a payment already being submitted.
      } finally {
        checkingStatus = false;
      }
    }
    setInterval(checkOrderStatus, 2500);
  }
});

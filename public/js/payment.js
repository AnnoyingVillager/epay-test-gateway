document.addEventListener('DOMContentLoaded', () => {
  const countdownBox = document.querySelector('[data-expires]');
  const countdown = document.querySelector('[data-countdown]');
  const payButton = document.querySelector('[data-pay-button]');
  const payForm = document.querySelector('.pay-form');
  let submitting = false;
  let paymentInFlight = false;

  function showFormError(form, message) {
    if (!form) return;
    let alert = form.querySelector('[data-payment-error]');
    if (!alert) {
      alert = document.createElement('div');
      alert.className = 'alert alert-danger';
      alert.setAttribute('role', 'alert');
      alert.setAttribute('data-payment-error', '');
      form.prepend(alert);
    }
    alert.textContent = message;
  }

  function showPaymentError(message) {
    showFormError(payForm, message);
  }

  function resetPayButton() {
    submitting = false;
    paymentInFlight = false;
    if (!payButton) return;
    payButton.disabled = false;
    payButton.classList.remove('is-submitting');
    payButton.removeAttribute('aria-busy');
    payButton.textContent = `确认支付 ${payButton.dataset.currency || ''} ${payButton.dataset.amount || ''}`.trim();
  }

  function lockForm(form, label = '正在处理...') {
    if (!form || form.dataset.submitting === '1') return false;
    form.dataset.submitting = '1';
    paymentInFlight = true;
    form.querySelectorAll('button, input[type="submit"]').forEach((button) => {
      button.dataset.originalText = button.textContent;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
    });
    const primary = form.querySelector('button[type="submit"]');
    if (primary) primary.textContent = label;
    return true;
  }

  function unlockForm(form) {
    if (!form) return;
    delete form.dataset.submitting;
    paymentInFlight = false;
    form.querySelectorAll('button, input[type="submit"]').forEach((button) => {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      if (button.dataset.originalText) button.textContent = button.dataset.originalText;
    });
  }

  function showCompletion(title, message, form = payForm) {
    if (!form) return;
    form.hidden = true;
    const state = document.createElement('div');
    state.className = 'payment-state payment-state-paid';
    const heading = document.createElement('strong');
    heading.textContent = title;
    const detail = document.createElement('p');
    detail.textContent = message;
    state.append(heading, detail);
    form.parentElement.append(state);
  }


  document.querySelectorAll('form[data-payment-submit]:not([data-payment-redirect])').forEach((form) => {
    form.addEventListener('submit', (event) => {
      if (!lockForm(form)) {
        event.preventDefault();
      }
    });
  });

  document.querySelectorAll('form[data-payment-submit][data-payment-redirect]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!lockForm(form, '正在处理支付...')) return;

      try {
        const response = await fetch(form.action, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'X-Payment-Ajax': '1'
          },
          body: new URLSearchParams(new FormData(form))
        });
        const data = await response.json();

        if (data.redirectUrl) {
          showCompletion(data.ok ? '订单已完成' : '支付未完成', data.ok ? '支付成功，正在自动返回商户网站...' : '正在按 Epay 标准返回商户网站...', form);
          setTimeout(() => window.location.replace(data.redirectUrl), 900);
          return;
        }

        showFormError(form, data.error?.message || '支付失败，请重试。');
        unlockForm(form);
      } catch {
        showFormError(form, '网络异常，支付请求未完成，请重试。');
        unlockForm(form);
      }
    });
  });

  if (payForm && payButton) {
    payButton.dataset.currency = payButton.dataset.currency || '';
    payButton.dataset.amount = payButton.dataset.amount || '';
    payForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submitting) return;
      submitting = true;
      paymentInFlight = true;
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
          if (data.redirectUrl) setTimeout(() => window.location.replace(data.redirectUrl), 900);
          return;
        }

        if (data.redirectUrl) {
          showCompletion('支付未完成', '正在按 Epay 标准返回商户网站...');
          setTimeout(() => window.location.replace(data.redirectUrl), 900);
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
      if (checkingStatus || paymentInFlight || document.hidden) return;
      checkingStatus = true;
      try {
        const response = await fetch(statusUrl, { headers: { Accept: 'application/json' }, cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json();
        if (!paymentInFlight && data.ok && data.status && data.status !== 'PENDING') window.location.reload();
      } catch {
        // Polling should not interrupt a payment already being submitted.
      } finally {
        checkingStatus = false;
      }
    }
    setInterval(checkOrderStatus, 2500);
  }
});

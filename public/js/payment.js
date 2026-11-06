document.addEventListener('DOMContentLoaded', () => {
  const countdownBox = document.querySelector('[data-expires]');
  const countdown = document.querySelector('[data-countdown]');
  const payButton = document.querySelector('[data-pay-button]');
  const payForm = document.querySelector('.pay-form');
  let submitting = false;

  if (payForm && payButton) {
    payForm.addEventListener('submit', (event) => {
      if (submitting) {
        event.preventDefault();
        return;
      }
      submitting = true;
      payForm.querySelectorAll('button[type="submit"]').forEach((button) => { button.disabled = true; });
      payButton.textContent = '正在处理支付...';
      payButton.setAttribute('aria-busy', 'true');
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
});

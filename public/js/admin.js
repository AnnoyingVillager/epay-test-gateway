document.addEventListener('DOMContentLoaded', () => {
  const navToggle = document.querySelector('[data-nav-toggle]');
  const nav = document.querySelector('[data-admin-nav]');
  if (navToggle && nav) {
    navToggle.addEventListener('click', () => nav.classList.toggle('open'));
  }

  document.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      const value = button.getAttribute('data-copy') || '';
      try {
        await navigator.clipboard.writeText(value);
        const previous = button.textContent;
        button.textContent = '已复制';
        setTimeout(() => { button.textContent = previous; }, 1300);
      } catch {
        button.textContent = '复制失败';
      }
    });
  });

  const selectAll = document.querySelector('[data-select-all]');
  if (selectAll) {
    selectAll.addEventListener('change', () => {
      document.querySelectorAll('input[name="user_ids"]').forEach((box) => { box.checked = selectAll.checked; });
    });
  }

  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      if (!window.confirm(form.getAttribute('data-confirm') || '确认继续？')) event.preventDefault();
    });
  });

  document.querySelectorAll('button[data-confirm], input[type="submit"][data-confirm]').forEach((control) => {
    control.addEventListener('click', (event) => {
      if (!window.confirm(control.getAttribute('data-confirm') || '确认继续？')) event.preventDefault();
    });
  });

  const liveShell = document.querySelector('[data-orders-live-url]');
  if (liveShell) {
    const url = liveShell.getAttribute('data-orders-live-url');
    const interval = Math.max(1500, Number(liveShell.getAttribute('data-orders-live-interval')) || 3000);
    let fingerprint = liveShell.getAttribute('data-orders-live-fingerprint') || '';
    let checking = false;

    async function checkOrders() {
      if (checking) return;
      checking = true;
      try {
        const response = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
        if (!response.ok || response.redirected) return;
        const data = await response.json();
        if (!data.fingerprint) return;
        if (fingerprint && data.fingerprint !== fingerprint) {
          window.location.reload();
          return;
        }
        fingerprint = data.fingerprint;
      } catch {
        // A transient polling failure should not interrupt the current page.
      } finally {
        checking = false;
      }
    }

    setInterval(checkOrders, interval);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) checkOrders();
    });
  }
});

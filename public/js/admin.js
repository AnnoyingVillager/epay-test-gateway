document.addEventListener('DOMContentLoaded', () => {
  const navToggle = document.querySelector('[data-nav-toggle]');
  const nav = document.querySelector('[data-admin-nav]');
  if (navToggle && nav) {
    navToggle.addEventListener('click', () => nav.classList.toggle('open'));
  }

  async function copyText(value) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return;
      }
    } catch {
      // Fall back for browsers or non-secure deployments without Clipboard API access.
    }
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('Clipboard copy failed');
  }

  document.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      const value = button.getAttribute('data-copy') || '';
      try {
        await copyText(value);
        const previous = button.textContent;
        button.textContent = '已复制';
        setTimeout(() => { button.textContent = previous; }, 1300);
      } catch {
        button.textContent = '复制失败';
      }
    });
  });

  document.querySelectorAll('[data-generate-password]').forEach((button) => {
    button.addEventListener('click', async () => {
      const target = button.getAttribute('data-password-target');
      const input = target ? document.querySelector(target) : null;
      const status = button.closest('form')?.querySelector('[data-generate-password-status]');
      if (!input) return;

      const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const lowercase = 'abcdefghijklmnopqrstuvwxyz';
      const digits = '0123456789';
      const all = `${uppercase}${lowercase}${digits}`;
      const randomIndex = (max) => {
        const limit = Math.floor(0x100000000 / max) * max;
        const buffer = new Uint32Array(1);
        let value;
        do {
          crypto.getRandomValues(buffer);
          value = buffer[0];
        } while (value >= limit);
        return value % max;
      };
      const chars = [
        uppercase[randomIndex(uppercase.length)],
        lowercase[randomIndex(lowercase.length)],
        digits[randomIndex(digits.length)]
      ];
      while (chars.length < 12) chars.push(all[randomIndex(all.length)]);
      for (let index = chars.length - 1; index > 0; index -= 1) {
        const swapIndex = randomIndex(index + 1);
        [chars[index], chars[swapIndex]] = [chars[swapIndex], chars[index]];
      }
      const password = chars.join('');
      input.value = password;
      input.type = 'text';
      try {
        await copyText(password);
        if (status) status.textContent = '已生成 12 位随机密码并复制到剪贴板。提交后将使目标用户的所有旧会话失效。';
      } catch {
        if (status) status.textContent = '随机密码已生成，但自动复制失败，请立即手动复制后再提交。';
      }
    });
  });

  const selectAll = document.querySelector('[data-select-all]');
  if (selectAll) {
    selectAll.addEventListener('change', () => {
      document.querySelectorAll('input[name="user_ids"]:not(:disabled)').forEach((box) => { box.checked = selectAll.checked; });
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

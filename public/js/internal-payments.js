document.addEventListener('DOMContentLoaded', () => {
  const dialog = document.querySelector('[data-confirm-dialog]');
  if (!dialog) return;

  const heading = dialog.querySelector('[data-confirm-heading]');
  const message = dialog.querySelector('[data-confirm-message]');
  const details = dialog.querySelector('[data-confirm-details]');
  const note = dialog.querySelector('[data-confirm-note]');
  const acceptButton = dialog.querySelector('[data-confirm-accept]');
  const cancelButtons = dialog.querySelectorAll('[data-confirm-cancel]');
  const card = dialog.querySelector('.confirm-card');
  let pending = null;
  let lastFocus = null;

  function sourceAttribute(source, form, name) {
    return source?.getAttribute(name) ?? form?.getAttribute(name) ?? '';
  }

  function fieldByName(form, name) {
    if (!form || !name) return null;
    return form.elements.namedItem(name);
  }

  function fieldDisplay(form, name) {
    const field = fieldByName(form, name);
    if (!field) return '';
    if (field instanceof RadioNodeList) return field.value;
    if (field.tagName === 'SELECT') return field.selectedOptions?.[0]?.textContent?.trim() || field.value;
    return String(field.value || '').trim();
  }

  function formatMinor(value) {
    const minor = Number(value);
    if (!Number.isFinite(minor)) return '';
    return (minor / 100).toFixed(2);
  }

  function appendDetail(label, value) {
    if (!value) return;
    const row = document.createElement('div');
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = value;
    row.append(term, description);
    details.append(row);
  }

  function showDialog(source, form, submitter) {
    if (pending) return;
    pending = { source, form, submitter };
    lastFocus = document.activeElement;

    const title = sourceAttribute(source, form, 'data-confirm-title') || '确认操作';
    const copy = sourceAttribute(source, form, 'data-confirm-message') || '请确认是否继续。';
    const action = sourceAttribute(source, form, 'data-confirm-action') || '确认操作';
    const currency = sourceAttribute(source, form, 'data-confirm-currency') || 'CNY';
    const amountField = sourceAttribute(source, form, 'data-confirm-amount-field');
    const amountLabel = sourceAttribute(source, form, 'data-confirm-amount-label') || '金额';
    const quantityField = sourceAttribute(source, form, 'data-confirm-quantity-field');
    const unitMinor = sourceAttribute(source, form, 'data-confirm-unit-minor');
    const costMinor = sourceAttribute(source, form, 'data-confirm-cost-minor');
    const targetField = sourceAttribute(source, form, 'data-confirm-target-field');
    const targetLabel = sourceAttribute(source, form, 'data-confirm-target-label') || '对象';
    const emptyValue = sourceAttribute(source, form, 'data-confirm-empty-value');
    const confirmNote = sourceAttribute(source, form, 'data-confirm-note');
    const tone = sourceAttribute(source, form, 'data-confirm-tone');

    heading.textContent = title;
    message.textContent = copy;
    details.replaceChildren();
    note.hidden = !confirmNote;
    note.textContent = confirmNote || '';

    if (amountField) {
      const entered = fieldDisplay(form, amountField);
      if (entered || emptyValue) appendDetail(amountLabel, `${currency} ${entered || emptyValue}`);
    }
    if (quantityField && unitMinor) {
      const quantity = Number(fieldDisplay(form, quantityField));
      const unit = Number(unitMinor);
      if (Number.isFinite(quantity) && Number.isFinite(unit)) appendDetail('单价', `${currency} ${formatMinor(unit)}`);
      if (Number.isFinite(quantity) && Number.isFinite(unit)) appendDetail('合计', `${currency} ${formatMinor(quantity * unit)}`);
    }
    if (!amountField && Number(costMinor) > 0) appendDetail(amountLabel, `${currency} ${formatMinor(costMinor)}`);
    if (targetField) appendDetail(targetLabel, fieldDisplay(form, targetField));

    details.hidden = details.children.length === 0;
    acceptButton.textContent = action;
    acceptButton.className = `button ${tone === 'danger' ? 'button-danger' : 'button-primary'}`;
    acceptButton.disabled = false;
    dialog.hidden = false;
    document.body.classList.add('confirm-open');
    requestAnimationFrame(() => acceptButton.focus());
  }

  function closeDialog() {
    dialog.hidden = true;
    document.body.classList.remove('confirm-open');
    pending = null;
    if (lastFocus instanceof HTMLElement) lastFocus.focus();
  }

  function submitConfirmed() {
    if (!pending?.form) return;
    const { form, submitter } = pending;
    acceptButton.disabled = true;
    acceptButton.textContent = '正在处理...';
    dialog.hidden = true;
    document.body.classList.remove('confirm-open');
    form.dataset.moneyConfirmed = '1';
    pending = null;
    if (typeof form.requestSubmit === 'function') {
      if (submitter instanceof HTMLElement && submitter.form === form) form.requestSubmit(submitter);
      else form.requestSubmit();
    } else {
      form.submit();
    }
    setTimeout(() => delete form.dataset.moneyConfirmed, 0);
  }

  document.querySelectorAll('form[data-money-confirm]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      if (form.dataset.moneyConfirmed === '1') {
        delete form.dataset.moneyConfirmed;
        return;
      }
      event.preventDefault();
      showDialog(form, form, event.submitter);
    });
  });

  document.querySelectorAll('button[data-money-confirm], input[type="submit"][data-money-confirm]').forEach((button) => {
    button.addEventListener('click', (event) => {
      const form = button.form;
      if (!form) return;
      event.preventDefault();
      showDialog(button, form, button);
    });
  });

  cancelButtons.forEach((button) => button.addEventListener('click', closeDialog));
  acceptButton.addEventListener('click', submitConfirmed);
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDialog();
    }
    if (event.key !== 'Tab') return;
    const focusable = [...card.querySelectorAll('button:not([disabled])')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
});

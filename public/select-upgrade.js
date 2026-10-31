// Replaces the browser's own drop-down lists of the app window with the design system's list (ds.js), without touching the code that
// uses them: the native <select> stays in the page (hidden), keeps its value, options, change event and disabled/hidden state, and the
// new list mirrors it both ways. So `select.value = x`, `select.add(new Option(...))` and `onchange` keep working as before.
export function upgradeSelects(root = document) {
  const DS = globalThis.HypernabDS;
  if (!DS) return;
  const valueProperty = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  for (const native of root.querySelectorAll('select:not([data-upgraded])')) {
    native.dataset.upgraded = '1';
    const read = () => [...native.options].map(option => ({ value: option.value, label: option.textContent, disabled: option.disabled }));
    const nameOf = () => native.getAttribute('aria-label') || native.closest('label')?.querySelector('span')?.textContent?.trim() || '';
    const list = DS.select(document, {
      options: read(), value: native.value, label: nameOf(),
      onChange: value => { valueProperty.set.call(native, value); native.dispatchEvent(new Event('change', { bubbles: true })); },
    });
    list.el.classList.add('hd-native');
    const wrapper = native.closest('.select') || native;
    if (wrapper.classList.contains('wide')) list.el.classList.add('wide');
    wrapper.after(list.el); wrapper.classList.add('hd-gone');
    // Code that sets the value by hand (settings loaded from the engine) shows up in the new list at once.
    Object.defineProperty(native, 'value', { configurable: true, get() { return valueProperty.get.call(native); }, set(next) { valueProperty.set.call(native, next); list.setValue(native.value); } });
    new MutationObserver(() => list.setOptions(read(), native.value)).observe(native, { childList: true, subtree: true, characterData: true });
    const mirror = () => { list.setDisabled(native.disabled); list.el.hidden = native.hidden; list.button.setAttribute('aria-label', nameOf()); };
    new MutationObserver(mirror).observe(native, { attributes: true, attributeFilter: ['disabled', 'hidden', 'aria-label'] });
    mirror();
  }
}

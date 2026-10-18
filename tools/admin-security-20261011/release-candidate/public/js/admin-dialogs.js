// Administrative dialogs render all messages and defaults as text.
(() => {
  function dialog(message, { title = '确认', input, danger = false, cancel = true } = {}) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'aim-confirm-overlay';
      const box = document.createElement('div');
      box.className = `aim-confirm-dialog${danger ? ' danger' : ''}`;
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      const heading = document.createElement('h3');
      heading.textContent = title;
      const list = document.createElement('ul'), line = document.createElement('li');
      line.textContent = message;
      line.style.whiteSpace = 'pre-wrap';
      list.append(line);
      box.append(heading, list);
      let field;
      if (input !== undefined) {
        field = document.createElement('input');
        field.type = 'text';
        field.className = 'aim-prompt-input';
        field.value = String(input);
        box.append(field);
      }
      const actions = document.createElement('div');
      actions.className = 'aim-confirm-actions';
      const previous = document.activeElement;
      const finish = value => { document.removeEventListener('keydown', keydown); overlay.remove(); previous?.focus(); resolve(value); };
      const keydown = event => {
        if (event.key === 'Escape') finish(field ? null : false);
        else if (event.key === 'Enter' && event.target === field) finish(field.value);
      };
      if (cancel) {
        const back = document.createElement('button');
        back.type = 'button'; back.className = 'aim-confirm-cancel'; back.textContent = '取消';
        back.addEventListener('click', () => finish(field ? null : false));
        actions.append(back);
      }
      const ok = document.createElement('button');
      ok.type = 'button'; ok.className = `aim-confirm-ok${danger ? ' danger' : ''}`; ok.textContent = '确定';
      ok.addEventListener('click', () => finish(field ? field.value : true));
      overlay.addEventListener('click', event => { if (event.target === overlay) finish(field ? null : false); });
      document.addEventListener('keydown', keydown);
      actions.append(ok); box.append(actions); overlay.append(box); document.body.append(overlay);
      (field || ok).focus(); field?.select();
    });
  }
  window.confirmDialog = (message, options = {}) => dialog(String(message), options);
  window.promptDialog = (message, defaultValue = '') => dialog(String(message), { title:'请输入', input:defaultValue });
  let alerts = Promise.resolve();
  window.alert = message => { alerts = alerts.then(() => dialog(String(message), { title:'提示', cancel:false })); };
})();

// Same-origin local game lobby; website session stays in its original page.
let dialog, opener, close;
function openGameSpace(path, title) {
  if (dialog?.open) return;
  opener = document.activeElement;
  const previousOverflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = 'hidden';
  dialog = document.createElement('dialog'); dialog.className = 'run-aix-dialog'; dialog.setAttribute('aria-label', title);
  const bar = document.createElement('div'); bar.className = 'game-launcher-bar';
  const name = document.createElement('b'); name.textContent = '✦ AIX PLAY';
  const subtitle = document.createElement('span'); subtitle.textContent = '游戏生态 · 本地试玩';
  const outside = document.createElement('a'); outside.href = path; outside.target = '_blank'; outside.rel = 'noopener'; outside.textContent = '独立窗口 ↗';
  const button = document.createElement('button'); button.type = 'button'; button.textContent = '×'; button.setAttribute('aria-label', '关闭游戏大厅');
  const frame = document.createElement('iframe'); frame.src = path; frame.title = title; frame.allow = 'autoplay';
  bar.append(name, subtitle, outside, button); dialog.append(bar, frame); document.body.append(dialog);
  close = () => { dialog?.close(); dialog?.remove(); dialog = null; document.documentElement.style.overflow = previousOverflow; opener?.focus({ preventScroll: true }); };
  button.onclick = () => close();
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close(); } });
  dialog.showModal(); button.focus();
}
window.openAixGames = () => openGameSpace('/games.html', 'AIX PLAY 游戏大厅');
window.openRunAix = () => openGameSpace('/run-aix.html', '奔跑吧 AIX');
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== dialog?.querySelector('iframe')?.contentWindow) return;
  const type = event.data?.type;
  if (['run-aix:close', 'aix-games:close'].includes(type)) close();
  // 游戏内「去登录」：触发站顶钱包按钮（连接/签名由钱包页逻辑接管）
  if (type === 'aix-games:login') document.getElementById('wallet-connect-btn')?.click();
});

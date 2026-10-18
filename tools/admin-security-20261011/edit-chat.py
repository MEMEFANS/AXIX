import pathlib

root = pathlib.Path(__file__).resolve().parents[2]
path = root / 'resources/app/public/js/support-chat.js'
original = path.read_bytes()
text = original.decode('utf-8').replace('\r\n', '\n')
text = text.replace('<div class="support-chat-messages" id="support-messages">${messagesHtml()}</div>', '<div class="support-chat-messages" id="support-messages"></div>')
first, last = text.index('  function messagesHtml() {'), text.index('  function scrollToBottom() {')
text = text[:first] + '''  function messagesFragment() {
    const fragment = document.createDocumentFragment();
    const messages = session?.messages || [];
    if (!messages.length) {
      const empty = document.createElement('div'); empty.className = 'support-chat-empty';
      empty.textContent = '还没有消息，发送下面的常见问题或直接输入您的问题，客服会尽快回复。';
      fragment.append(empty);
    }
    for (const message of messages) {
      const mine = message.sender === 'user';
      const row = document.createElement('div'); row.className = `support-msg ${mine ? 'me' : 'them'}`;
      const bubble = document.createElement('div'); bubble.className = 'support-msg-bubble';
      bubble.style.whiteSpace = 'pre-wrap'; bubble.textContent = String(message.body ?? '');
      const time = document.createElement('div'); time.className = 'support-msg-time';
      time.textContent = `${mine ? '我' : '客服'} · ${fmtTime(message.createdAt)}`;
      row.append(bubble, time); fragment.append(row);
    }
    return fragment;
  }

''' + text[last:]
assert text.count('box.innerHTML = messagesHtml();') == 1
text = text.replace('box.innerHTML = messagesHtml();', 'box.replaceChildren(messagesFragment());')
assert text.count('    host.innerHTML = chatHtml();') == 1
text = text.replace('    host.innerHTML = chatHtml();', "    host.innerHTML = chatHtml();\n    document.getElementById('support-messages')?.replaceChildren(messagesFragment());")
path.write_bytes(text.replace('\n', '\r\n').encode('utf-8') if b'\r\n' in original else text.encode('utf-8'))
# Change the feature URL so the service worker cannot keep the former chat renderer.
loader = root / 'resources/app/public/js/page-loader.js'
data = loader.read_bytes()
code = data.decode('utf-8')
old = '  const js = name => `/js/${name}.js?v=${version}`;'
assert code.count(old) == 1
code = code.replace(old, "  const js = name => `/js/${name}.js?v=${name === 'support-chat' ? '20261011-security-2' : version}`;")
loader.write_bytes(code.encode('utf-8'))
index = root / 'resources/app/public/index.html'
data = index.read_bytes()
assert data.count(b'/js/page-loader.js?v=20261011-pages-1') == 1
index.write_bytes(data.replace(b'/js/page-loader.js?v=20261011-pages-1', b'/js/page-loader.js?v=20261011-pages-security-2'))
print('Customer messages now render as DOM text; versioned the affected lazy renderer and loader')

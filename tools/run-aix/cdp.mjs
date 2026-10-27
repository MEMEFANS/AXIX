// Node 22+ provides a WebSocket client that handles framing and control messages.
export async function connectCDP(port = 9227) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`CDP discovery failed: ${response.status}`);
  const target = (await response.json()).find(item => item.type === 'page');
  if (!target?.webSocketDebuggerUrl) throw new Error('CDP browser has no page target');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map(), events = [];
  let sequence = 0;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error('CDP connection timed out')); }, 10000);
    socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('CDP WebSocket connection failed')); }, { once: true });
  });
  function rejectPending(error) {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  }
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id) { events.push(message); return; }
    const item = pending.get(message.id);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(message.id);
    message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
  });
  socket.addEventListener('close', event => rejectPending(new Error(`CDP socket closed: ${event.code} ${event.reason}`)));
  socket.addEventListener('error', () => rejectPending(new Error('CDP WebSocket failed')));
  return {
    events,
    call(method, params = {}) {
      if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP connection is closed'));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
        pending.set(id, { resolve, reject, timer });
        try { socket.send(JSON.stringify({ id, method, params })); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    },
    close() { rejectPending(new Error('CDP client closed')); socket.close(); },
  };
}

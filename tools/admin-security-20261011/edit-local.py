import pathlib

root = pathlib.Path(__file__).resolve().parents[2]
app = root / 'resources/app'

def update(name, transform):
    path = app / name
    original = path.read_bytes()
    text = original.decode('utf-8').replace('\r\n', '\n')
    result = transform(text)
    assert result != text, name
    path.write_bytes(result.replace('\n', '\r\n').encode('utf-8') if b'\r\n' in original else result.encode('utf-8'))

def replace(text, old, new):
    assert text.count(old) == 1, old[:100]
    return text.replace(old, new, 1)

def cut(text, start, end):
    assert text.count(start) == 1 and text.count(end) == 1, start
    first = text.index(start)
    last = text.index(end, first)
    return text[:first] + text[last:]

def server(text):
    text = replace(text, "import { createAdminAuth } from './admin-auth.js';", "import { createAdminAuth } from './admin-auth.js';\nimport { createFundsAdminApi } from './funds-admin-api.js';\nimport { OPERATOR_ADMIN_CSP, FUNDS_ADMIN_CSP, adminPageKind, isLegacyFundsPath } from './admin-security.js';")
    text = replace(text, 'const supportApi = createSupportApi({ service: supportService, send, readBody, getSession: walletSession });', "const supportApi = createSupportApi({ service: supportService, send, readBody, getSession: walletSession });\nconst fundsAdminApi = createFundsAdminApi({ walletService, payoutService:withdrawalPayoutService, send, readBody, isSameOrigin, allowRequest, getToken:() => String(process.env.WALLET_ADMIN_TOKEN || '') });")
    anchor = "    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !isSameOrigin(request)) {"
    text = replace(text, anchor, "    const adminKind = adminPageKind(p);\n    if (adminKind) {\n      res.setHeader('Content-Security-Policy', adminKind === 'funds' ? FUNDS_ADMIN_CSP : OPERATOR_ADMIN_CSP);\n      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');\n      res.setHeader('Cache-Control', 'no-store');\n    }\n    if (adminKind === 'funds' && decodeURIComponent(p).replace(/\\\\/g, '/').replace(/\\/+/g, '/') === '/withdraw-admin.html') {\n      res.writeHead(302, { Location:'/funds-admin.html', 'Cache-Control':'no-store' });\n      return res.end();\n    }\n" + anchor)
    text = replace(text, "    if (p === '/api/admin/login' && request.method === 'POST') {", "    if (p.startsWith('/api/wallet/admin/')) return fundsAdminApi.handle(request, res, p);\n    if (p === '/api/admin/login' && request.method === 'POST') {")
    text = replace(text, "      if (await supportApi.handleAdmin(request, res, p)) return;", "      if (isLegacyFundsPath(p)) return send(res, 403, { error:'此操作已移至独立资金后台，请单独验证资金权限', code:'FUNDS_ADMIN_REQUIRED' });\n      if (await supportApi.handleAdmin(request, res, p)) return;")
    text = cut(text, "      if (p === '/api/admin/withdrawal-automation' && request.method === 'PATCH') {", "      if (p === '/api/admin/users' && request.method === 'GET') {")
    text = cut(text, "      if (p === '/api/admin/test-credits' && request.method === 'GET') {", "      if (p === '/api/admin/deposits' && request.method === 'GET') {")
    text = cut(text, "      if (p === '/api/admin/withdrawals' && request.method === 'GET') {", "      if (p === '/api/admin/wallet-balance' && request.method === 'GET') {")
    text = cut(text, "      if (p.startsWith('/api/admin/withdrawals/') && request.method === 'POST') {", "      if (p === '/api/admin/tokens' && request.method === 'POST') {")
    text = cut(text, "    if (p === '/api/wallet/admin/withdrawals' && request.method === 'GET') {", '    // Login only needs the cookie identity; funding/RPC reconciliation belongs to the assets page.')
    return text

def html(text):
    for page in ['test-credits', 'withdrawals']:
        line = next(line for line in text.splitlines(True) if f'data-admin-page="{page}"' in line)
        text = replace(text, line, '')
    text = replace(text, '        <button type="button" data-admin-page="deposits">', '        <button type="button" data-open-funds><span class="admin-nav-icon">↗</span>资金后台</button>\n        <button type="button" data-admin-page="deposits">')
    text = replace(text, 'data-jump-page="withdrawals"', 'data-open-funds')
    text = cut(text, '      <section class="admin-page-panel" data-admin-panel="withdrawals">', '      <section class="admin-page-panel" data-admin-panel="tokens">')
    text = replace(text, '<script src="/js/core.js?v=72"></script>', '<script src="/js/admin-dialogs.js?v=20261011-security-1"></script>')
    text = replace(text, '/js/admin-lottery.js?v=4-security-20261011', '/js/admin-lottery.js?v=20261011-security-2')
    text = replace(text, '/js/operator-admin.js?v=45-assets-20261011', '/js/operator-admin.js?v=20261011-security-2')
    return text

def operator(text):
    text = cut(text, '  function renderTestCredits() {', '  function renderTokens() {')
    text = replace(text, 'await Promise.all([loadDeposits(), loadWithdrawals(), loadTestCredits()]);', 'await loadDeposits();')
    text = cut(text, '  async function loadWithdrawals() {', '  function navigate(page) {')
    text = cut(text, '  async function processWithdrawal(id, action) {', '  async function toggleToken(symbol, enabled) {')
    text = cut(text, '  async function submitTestCredit(event) {', "  byId('admin-login-form').addEventListener('submit', async event => {")
    for needle in ["  byId('admin-withdrawal-filter').addEventListener(", "  byId('admin-test-credit-form').addEventListener(", "  byId('admin-withdraw-settings-form').addEventListener("]:
        line = next(line for line in text.splitlines(True) if line.startswith(needle))
        text = replace(text, line, '')
    text = text.replace("'test-credits':'测试入账', ", '').replace("withdrawals:'提现审核', ", '')
    text = replace(text, "  const text = String(symbol || '').slice(0, 4);", "  const text = String(symbol || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 4);")
    text = replace(text, '    return `<img class="admin-token-logo" src="${local}" alt="" onerror="if(!this.dataset.f){this.dataset.f=1;this.src=\'${remote}\'}else{this.onerror=null;this.src=\'${stockLetterLogo(token.symbol)}\'}">`;', '    return `<img class="admin-token-logo" src="${local}" alt="" data-stock-logo data-remote="${remote}" data-fallback="${esc(stockLetterLogo(token.symbol))}">`;')
    text = replace(text, "    document.querySelectorAll('[data-stock-toggle]').forEach(button => {", "    byId('admin-stocks-body').querySelectorAll('[data-stock-logo]').forEach(image => {\n      image.addEventListener('error', () => {\n        if (!image.dataset.triedRemote) { image.dataset.triedRemote = '1'; image.src = image.dataset.remote; }\n        else if (!image.dataset.triedFallback) { image.dataset.triedFallback = '1'; image.src = image.dataset.fallback; }\n      });\n    });\n    document.querySelectorAll('[data-stock-toggle]').forEach(button => {")
    text = replace(text, "  byId('admin-refresh').addEventListener('click',", "  document.querySelectorAll('[data-open-funds]').forEach(button => button.addEventListener('click', () => window.open('/funds-admin.html', '_blank', 'noopener,noreferrer')));\n  byId('admin-refresh').addEventListener('click',")
    text = cut(text, '    const bubbles = msgs.map(m => {', '    host.innerHTML = `\n      <div class="as-head">')
    text = replace(text, '<div class="as-messages" id="admin-support-messages">${bubbles}</div>', '<div class="as-messages" id="admin-support-messages"></div>')
    text = replace(text, '    if (box) box.scrollTop = box.scrollHeight;', "    if (box) {\n      for (const message of msgs) {\n        const row = document.createElement('div'); row.className = `as-msg ${message.sender === 'admin' ? 'me' : 'them'}`;\n        const bubble = document.createElement('div'); bubble.className = 'as-bubble'; bubble.style.whiteSpace = 'pre-wrap'; bubble.textContent = String(message.body ?? '');\n        const time = document.createElement('div'); time.className = 'as-time'; time.textContent = `${message.sender === 'admin' ? '客服' : '用户'} · ${supportTime(message.createdAt)}`;\n        row.append(bubble, time); box.append(row);\n      }\n      if (!msgs.length) { const empty = document.createElement('div'); empty.className = 'as-empty'; empty.textContent = '还没有消息'; box.append(empty); }\n      box.scrollTop = box.scrollHeight;\n    }")
    return text

def lottery(text):
    text = replace(text, "    if (approve) {\n      const pts = sub.platform", "    if (approve) {\n      // Revalidate stored submissions as well as new uploads before awarding points.\n      normalizeSocialScreenshot(sub.screenshotUrl);\n      const pts = sub.platform")
    # Validation must happen before the pending record is mutated.
    text = replace(text, "    if (sub.status !== 'pending') throw new Error('已审核过');", "    if (sub.status !== 'pending') throw new Error('已审核过');\n    if (approve) normalizeSocialScreenshot(sub.screenshotUrl);")
    text = replace(text, "      // Revalidate stored submissions as well as new uploads before awarding points.\n      normalizeSocialScreenshot(sub.screenshotUrl);\n", '')
    text = replace(text, '    return db.listSocialSubmissions(status, limit);', "    return db.listSocialSubmissions(status, limit).map(sub => {\n      try { normalizeSocialScreenshot(sub.screenshotUrl); return { ...sub, screenshotSafe:true }; }\n      catch { return { ...sub, screenshotUrl:'', screenshotSafe:false, screenshotError:'截图无效或格式不安全，请拒绝后让用户重新提交' }; }\n    });")
    return text

update('src/server.js', server)
update('public/admin.html', html)
update('public/js/operator-admin.js', operator)
update('src/lottery-service.js', lottery)
print('Updated server permission boundary, operator console and stored screenshot validation')

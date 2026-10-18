import pathlib

app = pathlib.Path(__file__).resolve().parents[2]/'resources/app'
path = app/'public/admin.html'
source = path.read_text(encoding='utf-8')
start = source.index('          <header><div><h2>AIX 代币充值 / 扣除')
end = source.index('        </section>',start)
source = source[:start] + '''          <header><div><h2>AIX 资产管理</h2><p>充值、扣除需要单独验证资金权限。</p></div></header>
          <button type="button" class="admin-primary-button" data-open-funds>打开资金后台</button>
''' + source[end:]
source = source.replace('/js/operator-admin.js?v=20261011-security-2','/js/operator-admin.js?v=20261011-permissions-1')
path.write_text(source,encoding='utf-8',newline='\r\n')
path = app/'public/js/operator-admin.js'
source = path.read_text(encoding='utf-8')
start = source.index('  // ── AIX 代币充值 / 扣除')
end = source.index('  // 查询用户 AIX 余额',start)
source = source[:start] + source[end:]
start = source.index('        <h3>🎁 赠送矿机</h3>')
end = source.index('      </div>\n      <div class="admin-a-card">',start)
source = source[:start] + '''        <h3>赠送矿机</h3>
        <p>矿机赠送已移至独立资金后台。</p>
        <button type="button" class="admin-primary-button" id="am-open-funds">打开资金后台</button>
''' + source[end:]
start = source.index("    $id('am-grant')?.addEventListener")
end = source.index("    $id('am-level-set')?.addEventListener",start)
source = source[:start] + "    $id('am-open-funds')?.addEventListener('click', () => window.open('/funds-admin.html', '_blank', 'noopener,noreferrer'));\n" + source[end:]
path.write_text(source,encoding='utf-8',newline='\r\n')
print('Removed operator asset/miner write forms and replaced them with funds links')

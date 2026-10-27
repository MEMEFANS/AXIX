# 仅在本机保存卡扣媒体密钥；不输出密钥、不发送网络请求。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$form = [Windows.Forms.Form]::new()
$form.Text = 'AIX 游戏美术 · 卡扣媒体 API 配置'
$form.Size = [Drawing.Size]::new(560,285)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.Font = [Drawing.Font]::new('Microsoft YaHei',10)
$label = [Windows.Forms.Label]::new()
$label.Location = [Drawing.Point]::new(22,18)
$label.Size = [Drawing.Size]::new(505,72)
$label.Text = "请粘贴卡扣「媒体 API」密钥（密码框不会显示内容）。`r`n建议先撤销已发到聊天中的旧密钥，重新生成。`r`n接口：https://api.kakouai.com/v1/media/tasks"
$inputBox = [Windows.Forms.TextBox]::new()
$inputBox.Location = [Drawing.Point]::new(22,101)
$inputBox.Size = [Drawing.Size]::new(500,28)
$inputBox.UseSystemPasswordChar = $true
$save = [Windows.Forms.Button]::new()
$save.Text = '保存到本机'
$save.Location = [Drawing.Point]::new(362,149)
$save.Size = [Drawing.Size]::new(160,38)
$status = [Windows.Forms.Label]::new()
$status.Location = [Drawing.Point]::new(22,198)
$status.Size = [Drawing.Size]::new(500,30)
$status.Text = '保存为当前用户的 KAKOU_MEDIA_API_KEY，不写入网站。'
$save.Add_Click({
  $mediaKey = $inputBox.Text.Trim()
  if ($mediaKey -notmatch '^sk-[A-Za-z0-9_-]{20,}$') {
    $status.Text = '密钥格式不正确，请重新粘贴完整的媒体 API 密钥。'
    return
  }
  try {
    [Environment]::SetEnvironmentVariable('KAKOU_MEDIA_API_KEY',$mediaKey,'User')
    [Environment]::SetEnvironmentVariable('KAKOU_MEDIA_BASE_URL','https://api.kakouai.com','User')
    $inputBox.Clear()
    $mediaKey = $null
    [Windows.Forms.MessageBox]::Show('已保存到本机。回到聊天回复「已保存」即可。','配置完成') | Out-Null
    $form.Close()
  } catch { $status.Text = '保存未成功，请检查当前用户是否允许修改环境变量。' }
})
$form.Controls.AddRange(@($label,$inputBox,$save,$status))
$form.AcceptButton = $save
$form.Add_Shown({$inputBox.Focus()})
[void]$form.ShowDialog()
$form.Dispose()

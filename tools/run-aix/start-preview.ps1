# 无需 Node 的 Windows 本地静态预览；不启动交易后端，不读取环境配置。
$ErrorActionPreference = 'Stop'
$publicRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../resources/app/public')).TrimEnd([IO.Path]::DirectorySeparatorChar)
$listener = [Net.HttpListener]::new()
$listener.Prefixes.Add('http://127.0.0.1:4173/')
$listener.Start()
Write-Host 'Run AIX: http://127.0.0.1:4173/run-aix.html (Ctrl+C to stop)'
$mime = @{ '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.css'='text/css; charset=utf-8'; '.png'='image/png'; '.jpg'='image/jpeg'; '.jpeg'='image/jpeg'; '.svg'='image/svg+xml'; '.ico'='image/x-icon' }
try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $response = $context.Response
    try {
      $requestPath = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath)
      $response.Headers['Cache-Control'] = 'no-store'
      $response.Headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'"
      if ($context.Request.HttpMethod -notin @('GET','HEAD')) { $response.StatusCode = 405 }
      elseif ($requestPath.StartsWith('/api/')) {
        $response.StatusCode = 401
        $response.ContentType = 'application/json; charset=utf-8'
        $data = [Text.Encoding]::UTF8.GetBytes('{"error":"Local preview has no wallet session"}')
        $response.OutputStream.Write($data,0,$data.Length)
      } else {
        if ($requestPath -eq '/') { $requestPath = '/index.html' }
        $full = [IO.Path]::GetFullPath((Join-Path $publicRoot $requestPath.TrimStart('/')))
        if (-not $full.StartsWith($publicRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { $response.StatusCode = 403 }
        elseif (-not [IO.File]::Exists($full)) { $response.StatusCode = 404 }
        else {
          $type = $mime[[IO.Path]::GetExtension($full).ToLowerInvariant()]
          if (-not $type) { $type = 'application/octet-stream' }
          $response.ContentType = $type
          $data = [IO.File]::ReadAllBytes($full)
          $response.ContentLength64 = $data.Length
          if ($context.Request.HttpMethod -ne 'HEAD') { $response.OutputStream.Write($data,0,$data.Length) }
        }
      }
    } catch { try { $response.StatusCode = 500 } catch {} }
    finally { $response.Close() }
  }
} finally { $listener.Stop(); $listener.Close() }

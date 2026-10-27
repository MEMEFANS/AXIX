# Compress the generated local game artwork. This script uses no credentials.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$hashArtSource = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../output/imagegen/hash-aix/hash-core-source.png'))
$hashArtTarget = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../resources/app/public/games/hash-aix/assets/hash-core.jpg'))
$hashArtOriginal = [Drawing.Bitmap]::new($hashArtSource)
try {
  $hashArtWidth = 1200
  $hashArtHeight = [int][Math]::Round($hashArtOriginal.Height * $hashArtWidth / $hashArtOriginal.Width)
  $hashArtSmall = [Drawing.Bitmap]::new($hashArtWidth, $hashArtHeight)
  try {
    $hashArtGraphics = [Drawing.Graphics]::FromImage($hashArtSmall)
    try {
      $hashArtGraphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $hashArtGraphics.CompositingQuality = [Drawing.Drawing2D.CompositingQuality]::HighQuality
      $hashArtGraphics.DrawImage($hashArtOriginal, 0, 0, $hashArtWidth, $hashArtHeight)
    } finally { $hashArtGraphics.Dispose() }
    $hashArtCodec = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    foreach ($hashArtQuality in @(86L, 82L, 78L, 74L)) {
      $hashArtParameters = [Drawing.Imaging.EncoderParameters]::new(1)
      try {
        $hashArtParameters.Param[0] = [Drawing.Imaging.EncoderParameter]::new([Drawing.Imaging.Encoder]::Quality, $hashArtQuality)
        $hashArtSmall.Save($hashArtTarget, $hashArtCodec, $hashArtParameters)
      } finally { $hashArtParameters.Dispose() }
      if ((Get-Item -LiteralPath $hashArtTarget).Length -lt 250000) { break }
    }
    [pscustomobject]@{ Width = $hashArtWidth; Height = $hashArtHeight; Bytes = (Get-Item -LiteralPath $hashArtTarget).Length; Quality = $hashArtQuality } | ConvertTo-Json -Compress
  } finally { $hashArtSmall.Dispose() }
} finally { $hashArtOriginal.Dispose() }

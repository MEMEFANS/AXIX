# 将本地生成的绿幕原图制作成透明 PNG；背景压缩为 JPEG。不读取密钥。
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
public static class AixArtPrepare {
  public static void Cut(string input, string output) {
    using (var original = new Bitmap(input))
    using (var image = new Bitmap(original.Width, original.Height, PixelFormat.Format32bppArgb)) {
      using(var g = Graphics.FromImage(image)) g.DrawImage(original, 0, 0, image.Width, image.Height);
      var rect = new Rectangle(0,0,image.Width,image.Height);
      var data = image.LockBits(rect,ImageLockMode.ReadWrite,PixelFormat.Format32bppArgb);
      byte[] bytes = new byte[data.Stride * image.Height]; Marshal.Copy(data.Scan0,bytes,0,bytes.Length);
      for(int y=0;y<image.Height;y++) for(int x=0;x<image.Width;x++) {
        int i=y*data.Stride+x*4; int b=bytes[i], g=bytes[i+1], r=bytes[i+2]; int dominant=g-Math.Max(r,b);
        if(dominant>20 && g>70) {
          double keep=Math.Max(0,Math.Min(1,1-(dominant-20)/115.0));
          bytes[i+3]=(byte)Math.Round(255*keep);
          if(keep<1) bytes[i+1]=(byte)Math.Min(g,Math.Max(r,b)+12);
        }
      }
      Marshal.Copy(bytes,0,data.Scan0,bytes.Length); image.UnlockBits(data);
      using(var small=new Bitmap(640,640,PixelFormat.Format32bppArgb)) {
        using(var g=Graphics.FromImage(small)) {g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=InterpolationMode.HighQualityBicubic;g.DrawImage(image,0,0,640,640);}
        small.Save(output,ImageFormat.Png);
      }
    }
  }
  public static void Background(string input,string output) {
    using(var image=new Bitmap(input)) {
      var codec=Array.Find(ImageCodecInfo.GetImageEncoders(),c=>c.MimeType=="image/jpeg");
      using(var parameters=new EncoderParameters(1)) {parameters.Param[0]=new EncoderParameter(System.Drawing.Imaging.Encoder.Quality,88L);image.Save(output,codec,parameters);}
    }
  }
}
'@ -ReferencedAssemblies System.Drawing
$assets=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../resources/app/public/games/run-aix/assets'))
$originals=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../output/imagegen/run-aix'))
foreach($name in @('hero','btc','eth','bnb','ghost','hole','spike')) {
  $source=Join-Path $originals ($name+'-v2-source.png')
  if(Test-Path $source) { [AixArtPrepare]::Cut($source,(Join-Path $assets ($name+'-v2.png'))); Write-Output ($name+': transparent PNG prepared') }
}
foreach($name in @('city','exchange','ocean')) {
  $source=Join-Path $originals ($name+'-v2-source.png')
  if(Test-Path $source) { [AixArtPrepare]::Background($source,(Join-Path $assets ($name+'-v2.jpg'))); Write-Output ($name+': JPEG prepared') }
}

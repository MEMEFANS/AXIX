$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class AixRunSheet {
 public static void Prepare(string input,string output) {
  using(var src=new Bitmap(input)) using(var img=new Bitmap(src.Width,src.Height,PixelFormat.Format32bppArgb)) {
   using(var g=Graphics.FromImage(img)) g.DrawImage(src,0,0,src.Width,src.Height);
   var data=img.LockBits(new Rectangle(0,0,img.Width,img.Height),ImageLockMode.ReadWrite,PixelFormat.Format32bppArgb);
   byte[] b=new byte[data.Stride*img.Height]; Marshal.Copy(data.Scan0,b,0,b.Length);
   for(int y=0;y<img.Height;y++)for(int x=0;x<img.Width;x++) {
    int i=y*data.Stride+x*4;int dominant=b[i+1]-Math.Max(b[i],b[i+2]);
    if(dominant>20 && b[i+1]>70){double keep=Math.Max(0,Math.Min(1,1-(dominant-20)/95.0));b[i+3]=(byte)(255*keep);b[i+1]=(byte)Math.Min(b[i+1],Math.Max(b[i],b[i+2])+10);}
   }
   Marshal.Copy(b,0,data.Scan0,b.Length);img.UnlockBits(data);
   using(var aligned=new Bitmap(img.Width,img.Height,PixelFormat.Format32bppArgb)) {
    using(var g=Graphics.FromImage(aligned)) {
     int cw=img.Width/4,ch=img.Height/2;
     for(int f=0;f<8;f++) {
      int sx=(f%4)*cw,sy=(f/4)*ch,minY=ch;
      for(int y=0;y<ch;y++)for(int x=0;x<cw;x++)if(b[(sy+y)*data.Stride+(sx+x)*4+3]>180) {minY=Math.Min(minY,y);}
      // Align the head across cells, preserving authored leg extension and airtime.
      g.SetClip(new Rectangle(sx,sy,cw,ch));
      g.DrawImage(img,new Rectangle(sx,sy+(int)(ch*.14)-minY,cw,ch),new Rectangle(sx,sy,cw,ch),GraphicsUnit.Pixel);
      g.ResetClip();
     }
    }
    aligned.Save(output,ImageFormat.Png);
   }
  }
 }
}
'@ -ReferencedAssemblies System.Drawing
$base=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
[AixRunSheet]::Prepare((Join-Path $base 'output/imagegen/run-aix/run-cycle-v3-source.png'),(Join-Path $base 'resources/app/public/games/run-aix/assets/run-cycle-v3.png'))
Write-Output 'Run sheet prepared, full resolution preserved.'

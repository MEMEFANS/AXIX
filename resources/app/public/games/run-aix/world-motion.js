// World coordinates in metres; shared projection for road, scenery and hazards.
export function project(w, h, ahead, lane = 0) {
  const depth = Math.max(0, 1 - ahead / 65) ** 2;
  return { x: w * .5 + lane * w * (.046 + depth * .234),
    y: h * .48 + h * .40 * depth, scale: depth };
}
function quad(c, points, color) {
  c.fillStyle = color; c.beginPath(); points.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)); c.closePath(); c.fill();
}
export function drawWorld(c, w, h, distance, scene) {
  const mint = scene === 2 ? '#80ffe6' : scene === 1 ? '#f4d491' : '#bdb4ff';
  // Continuous slabs and dashed lane markings approach the camera and pass below it.
  for (let z = 66-distance%2; z > -18; z -= 2) {
    const a = project(w,h,z,-1.5), b=project(w,h,z,1.5);
    const d=project(w,h,z-2,-1.5), e=project(w,h,z-2,1.5);
    const index=Math.floor((distance+z)/4);
    quad(c,[a,b,e,d],index%2 ? '#242842' : '#2d304d');
  }
  const offset = distance % 4;
  for(let z=64-offset;z>-18;z-=4) {
    for(const lane of [-1.5,-.5,.5,1.5]) {
      const edge=Math.abs(lane)>1;
      const a=project(w,h,z,lane-.012), b=project(w,h,z,lane+.012);
      const d=project(w,h,z-(edge?3.9:1.8),lane-.012), e=project(w,h,z-(edge?3.9:1.8),lane+.012);
      quad(c,[a,b,e,d],edge?mint:'#b6b7da85');
    }
    const a=project(w,h,z,-1.48),b=project(w,h,z,1.48);
    c.strokeStyle='#a6a9d12e'; c.lineWidth=Math.max(.4,a.scale*1.4);
    c.beginPath();c.moveTo(a.x,a.y);c.lineTo(b.x,b.y);c.stroke();
  }
  // Recycled roadside pylons have their own world depth; near objects rush past.
  const phase=distance%10;
  for(let z=70-phase;z>-16;z-=10) for(const side of [-1,1]) {
    const p=project(w,h,z,side*1.9), height=10+p.scale*h*.20, width=3+p.scale*w*.035;
    c.fillStyle=scene===1?'#50405a':'#282b50';
    c.fillRect(p.x-width*.5,p.y-height,width,height);
    c.fillStyle=mint;c.fillRect(p.x-width*.52,p.y-height,width*1.04,Math.max(2,p.scale*6));
    c.fillStyle=scene===1?'#ffda9d70':'#9aeaff65';c.fillRect(p.x-width*.18,p.y-height*.85,Math.max(1,width*.25),height*.70);
    c.fillStyle='#080e2440';c.beginPath();c.ellipse(p.x,p.y,width*1.3,width*.35,0,0,Math.PI*2);c.fill();
  }
  const fog=c.createLinearGradient(0,h*.475,0,h*.62);fog.addColorStop(0,'#a99adf90');fog.addColorStop(1,'#a99adf00');
  c.fillStyle=fog;c.fillRect(0,h*.475,w,h*.145);
}

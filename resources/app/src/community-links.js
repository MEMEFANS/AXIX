import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeJsonAtomic } from './atomic-ledger.js';

export const COMMUNITY_LINK_TYPES = Object.freeze([
  { id:'telegram', name:'TG', description:'加入社群，交流平台动态' },
  { id:'twitter', name:'推特', description:'关注最新消息与活动' },
  { id:'dexbox', name:'dexBOX', description:'访问 dexBOX 平台入口' },
  { id:'telegram-support', name:'TG客服', description:'通过 Telegram 联系客服' },
  { id:'qq', name:'QQ社群', description:'加入 QQ 社群，一起交流' },
  { id:'email', name:'邮箱投递', description:'发送邮件，联系平台团队' },
  { id:'ticket', name:'留言工单', description:'提交问题、建议与反馈' },
]);
const fail = (message, statusCode=400) => Object.assign(new Error(message), { statusCode });
const types = new Set(COMMUNITY_LINK_TYPES.map(item=>item.id));

export function normalizeCommunityLink(input) {
  if(!input || typeof input!=='object' || Array.isArray(input)) throw fail('链接信息格式不正确');
  if(!types.has(input.type)) throw fail('请选择支持的链接类型');
  const title = String(input.title ?? '').trim();
  const description = String(input.description ?? '').trim();
  if(!title || title.length>40) throw fail('名称须为 1 到 40 个字符');
  if(description.length>140) throw fail('说明不能超过 140 个字符');
  const order = input.order ?? 0;
  if(!Number.isInteger(order) || order<0 || order>9999) throw fail('排序须为 0 到 9999 的整数');
  const enabled = input.enabled ?? true;
  if(typeof enabled!=='boolean') throw fail('显示状态必须为布尔值');
  let url=String(input.url ?? '').trim();
  if(!url && enabled) throw fail('请填写链接地址，或先设为不显示');
  if(url) {
    if(url.length>2048 || /[\s\u0000-\u001f\u007f]/u.test(url)) throw fail('链接地址格式不正确');
    if(input.type==='email') {
      const address=url.replace(/^mailto:/i,'');
      if(!/^[A-Za-z0-9.!#$&'*+\/=^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(address)) throw fail('请填写有效邮箱地址，不要附带邮件参数');
      url=`mailto:${address}`;
    } else {
      let parsed;
      try { parsed=new URL(url); } catch { throw fail('请填写完整的 http:// 或 https:// 链接'); }
      if(!['https:','http:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) throw fail('只支持不包含账号密码的 HTTP 或 HTTPS 链接');
      url=parsed.href;
    }
  }
  let qrcode = '';
  if (input.qrcode) {
    const q = String(input.qrcode).trim();
    if (q.length > 0) {
      if (q.length > 2_000_000) throw fail('二维码图片过大（上限 2MB）');
      if (!/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(q) && !/^https?:\/\//i.test(q)) {
        throw fail('二维码须为 data:image base64 或 https 链接');
      }
      qrcode = q;
    }
  }
  // QQ 群号码（仅 QQ 类型，5~12 位纯数字，选填）
  let groupNumber = '';
  if (input.type === 'qq') {
    groupNumber = String(input.groupNumber ?? '').trim().replace(/[^\d]/g, '');
    if (groupNumber && !/^\d{5,12}$/.test(groupNumber)) throw fail('QQ 群号码须为 5 到 12 位数字');
  }
  return { type:input.type, title, description, url, qrcode, groupNumber, order, enabled };
}

export function createCommunityLinksService({dataRoot='.'}={}) {
  const file=path.join(path.resolve(dataRoot),'community-links.json');
  const ordered = items => [...items].sort((a,b)=>a.order-b.order || a.id.localeCompare(b.id));
  function read() {
    if(!fs.existsSync(file)) return {version:1,revision:0,updatedAt:null,links:[]};
    try {
      const state=JSON.parse(fs.readFileSync(file,'utf8'));
      if(state.version!==1 || !Number.isSafeInteger(state.revision) || state.revision<0 || !Array.isArray(state.links) || state.links.length>100) throw new Error('invalid state');
      const seen=new Set();
      for(const item of state.links) {
        if(!/^link_[a-f0-9]{24}$/.test(item.id) || seen.has(item.id)) throw new Error('invalid id');
        seen.add(item.id); normalizeCommunityLink(item);
      }
      return state;
    } catch { throw fail('社群链接配置读取失败，请联系管理员检查配置文件',503); }
  }
  function list({admin=false}={}) {
    const state=read();
    const links=ordered(state.links).filter(item=>admin || (item.enabled && item.url)).map(item=>admin?{...item,groupNumber:item.groupNumber||''}:{id:item.id,type:item.type,title:item.title,description:item.description,url:item.url,qrcode:item.qrcode||'',groupNumber:item.groupNumber||'',order:item.order});
    return {links,revision:state.revision,updatedAt:state.updatedAt,...(admin?{types:COMMUNITY_LINK_TYPES.map(item=>({...item}))}:{})};
  }
  function mutate(revision,operator,operation) {
    const state=read();
    if(!Number.isSafeInteger(revision) || revision<0) throw fail('缺少配置版本，请刷新后重试');
    if(state.revision!==revision) throw fail('配置已被更新，请刷新列表后再保存',409);
    const next=operation(state.links.map(item=>({...item})));
    const updatedAt=new Date().toISOString();
    writeJsonAtomic(file,{version:1,revision:state.revision+1,links:ordered(next),updatedAt,updatedBy:String(operator||'admin')});
    return list({admin:true});
  }
  function save(input,{id,revision,operator}={}) {
    return mutate(revision,operator,links=>{
      const index=id?links.findIndex(item=>item.id===id):-1;
      if(id && index<0) throw fail('链接不存在，可能已被删除',404);
      if(!id && links.length>=100) throw fail('最多可添加 100 个链接');
      const item={...normalizeCommunityLink(input),id:id||`link_${crypto.randomBytes(12).toString('hex')}`,updatedAt:new Date().toISOString()};
      if(index<0) links.push(item); else links[index]=item;
      return links;
    });
  }
  function remove(id,{revision,operator}={}) {
    return mutate(revision,operator,links=>{
      if(!links.some(item=>item.id===id)) throw fail('链接不存在，可能已被删除',404);
      return links.filter(item=>item.id!==id);
    });
  }
  function reorder(ids,{revision,operator}={}) {
    return mutate(revision,operator,links=>{
      if(!Array.isArray(ids) || ids.length!==links.length || new Set(ids).size!==ids.length || ids.some(id=>!links.some(item=>item.id===id))) throw fail('排序列表不完整，请刷新后重试');
      return ids.map((id,i)=>({...links.find(item=>item.id===id),order:i*10}));
    });
  }
  return {list,save,remove,reorder};
}

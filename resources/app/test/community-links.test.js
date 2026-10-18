import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createCommunityLinksService,normalizeCommunityLink} from '../src/community-links.js';
import {createCommunityLinksApi} from '../src/community-links-api.js';
import {createAdminAuth} from '../src/admin-auth.js';

const dataRoot=fs.mkdtempSync(path.join(os.tmpdir(),'axix-community-test-'));
const service=createCommunityLinksService({dataRoot});
const auth=createAdminAuth({username:'test-admin',password:'local-test-only'});
const session=auth.login('test-admin','local-test-only');
const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
const api=createCommunityLinksApi({service,send,getAdminSession:req=>auth.session(req.headers['x-test-session']),isSameOrigin:req=>!req.headers.origin||req.headers.origin===`http://${req.headers.host}`,readBody:async(req,max)=>{
  let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>max)throw Object.assign(new Error('too large'),{statusCode:413});}
  try{return JSON.parse(body||'{}');}catch{throw Object.assign(new Error('invalid JSON'),{statusCode:400});}
}});
const server=http.createServer(async(req,res)=>{if(!await api.handle(req,res,new URL(req.url,'http://localhost').pathname))send(res,404,{});});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
async function request(route,{method='GET',body,authorized=true,headers={}}={}){
  const response=await fetch(origin+route,{method,headers:{...(authorized?{'x-test-session':session.token}:{}),'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
  return {status:response.status,data:await response.json(),cache:response.headers.get('cache-control')};
}
const admin='/api/admin/community-links',publicRoute='/api/community-links';
const telegram={type:'telegram',title:'TG',url:'https://t.me/example',description:'社群交流',order:10,enabled:true};
try{
  assert.deepEqual(service.list().links,[]);
  for(const method of ['GET','POST','PUT','DELETE'])assert.equal((await request(admin,{method,authorized:false,...(method==='GET'?{}:{body:{}})})).status,401);
  assert.equal((await request(admin,{method:'POST',headers:{Origin:'https://untrusted.example'},body:{...telegram,revision:0}})).status,403);
  assert.equal((await request(publicRoute,{method:'POST',body:{}})).status,405);
  let result=await request(admin,{method:'POST',body:{...telegram,revision:0,enabled:false}});
  assert.equal(result.status,200);assert.equal(result.data.revision,1);
  const id=result.data.links[0].id;
  assert.deepEqual((await request(publicRoute,{authorized:false})).data.links,[]);
  result=await request(admin+'/'+id,{method:'PUT',body:{...telegram,revision:1}});
  assert.equal(result.status,200);
  const published=await request(publicRoute,{authorized:false});
  assert.equal(published.cache,'no-store');assert.equal(published.data.links[0].url,telegram.url);
  assert.equal(published.data.links[0].enabled,undefined);assert.equal(published.data.updatedBy,undefined);
  for(const url of ['javascript:alert(1)','data:text/html,bad','file:///tmp/file','https://user:pass@example.com','//evil.example','https://exam\nple.com']){
    assert.equal((await request(admin,{method:'POST',body:{...telegram,url,revision:2}})).status,400,url);
  }
  assert.equal((await request(admin,{method:'POST',body:'{'})).status,400);
  assert.equal((await request(admin,{method:'POST',body:{...telegram,revision:2,enabled:'false'}})).status,400);
  assert.equal(service.list({admin:true}).revision,2);
  assert.equal((await request(admin+'/'+id,{method:'PUT',body:{...telegram,revision:0}})).status,409);
  result=await request(admin,{method:'POST',body:{type:'email',title:'邮箱投递 <b>literal</b>',description:'',url:'support@example.com',order:0,revision:2}});
  assert.equal(result.status,200);
  const emailId=result.data.links[0].id;
  assert.equal(result.data.links[0].url,'mailto:support@example.com');
  assert.equal(result.data.links[0].title,'邮箱投递 <b>literal</b>');
  assert.throws(()=>normalizeCommunityLink({type:'email',title:'email',url:'mailto:a@example.com?bcc=other@example.com'}));
  assert.throws(()=>normalizeCommunityLink({...telegram,title:'x'.repeat(41)}));
  assert.throws(()=>normalizeCommunityLink({...telegram,order:-1}));
  assert.throws(()=>normalizeCommunityLink({...telegram,type:'unknown'}));
  assert.equal((await request(admin+'/reorder',{method:'POST',body:{revision:3,ids:[id,id]}})).status,400);
  result=await request(admin+'/reorder',{method:'POST',body:{revision:3,ids:[id,emailId]}});
  assert.equal(result.status,200);assert.deepEqual(result.data.links.map(i=>i.id),[id,emailId]);
  const restored=createCommunityLinksService({dataRoot});
  assert.deepEqual(restored.list().links.map(i=>i.id),[id,emailId]);
  assert.equal((await request(admin+'/'+id,{method:'DELETE',body:{revision:4}})).status,200);
  assert.deepEqual(service.list().links.map(i=>i.id),[emailId]);
  assert.equal((await request(admin+'/'+id,{method:'DELETE',body:{revision:5}})).status,404);
  auth.logout(session.token);
  assert.equal((await request(admin,{method:'POST',body:{...telegram,revision:5}})).status,401);
  const configFile=path.join(dataRoot,'community-links.json');
  fs.writeFileSync(configFile,'broken');
  assert.equal((await request(publicRoute,{authorized:false})).status,503);
  assert.equal(fs.readFileSync(configFile,'utf8'),'broken');
  console.log('community-links tests passed: auth, origin, CRUD, visibility, ordering, persistence, stale writes, validation and corrupt config');
}finally{
  await new Promise(resolve=>server.close(resolve));
  const resolved=path.resolve(dataRoot);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('axix-community-test-'));
  fs.rmSync(resolved,{recursive:true,force:true});
}

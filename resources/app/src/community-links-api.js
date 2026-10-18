export function createCommunityLinksApi({service,send,readBody,getAdminSession,isSameOrigin}) {
  return {
    async handle(req,res,pathname) {
      const publicRoute=pathname==='/api/community-links';
      const base='/api/admin/community-links';
      if(!publicRoute && pathname!==base && !pathname.startsWith(base+'/')) return false;
      res.setHeader('Cache-Control','no-store');
      try {
        if(publicRoute) {
          if(req.method!=='GET') { res.setHeader('Allow','GET'); send(res,405,{error:'不支持此请求方法'}); }
          else send(res,200,service.list());
          return true;
        }
        const session=getAdminSession(req);
        if(!session) {send(res,401,{error:'后台登录已失效，请重新登录',code:'ADMIN_AUTH_REQUIRED'});return true;}
        if(req.method!=='GET' && !isSameOrigin(req)) {send(res,403,{error:'拒绝跨站修改请求'});return true;}
        if(pathname===base && req.method==='GET') {send(res,200,service.list({admin:true}));return true;}
        const supported=(pathname===base&&req.method==='POST') || (pathname===base+'/reorder'&&req.method==='POST') || (pathname.startsWith(base+'/link_')&&['PUT','DELETE'].includes(req.method));
        if(!supported) {send(res,405,{error:'不支持此请求方法'});return true;}
        // 二维码 base64 最大约 2MB（服务层限制），留足 JSON 开销，上限 3.5MB
        const body=await readBody(req,3_500_000);
        if(!body || typeof body!=='object' || Array.isArray(body)) {send(res,400,{error:'请求格式不正确'});return true;}
        const options={revision:body.revision,operator:session.username};
        let result;
        if(pathname===base+'/reorder') result=service.reorder(body.ids,options);
        else if(pathname===base) result=service.save(body,options);
        else {
          const id=pathname.slice(base.length+1);
          if(!/^link_[a-f0-9]{24}$/.test(id)) {send(res,404,{error:'链接不存在'});return true;}
          result=req.method==='DELETE'?service.remove(id,options):service.save(body,{...options,id});
        }
        send(res,200,{ok:true,...result});
      } catch(error) {send(res,error.statusCode||500,{error:error.statusCode?error.message:'社群链接保存失败，请稍后重试'});}
      return true;
    },
  };
}

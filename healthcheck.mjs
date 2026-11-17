import http from 'node:http';
import {readFileSync} from 'node:fs';
const secret=process.env.MONO_PROXY_SECRET_FILE
  ?readFileSync(process.env.MONO_PROXY_SECRET_FILE,'utf8').trim()
  :(process.env.MONO_PROXY_SECRET||'');
const origin=process.env.MONO_PUBLIC_ORIGIN;
const host=origin?new URL(origin).host:`127.0.0.1:${process.env.PORT||4173}`;
const headers={'Host':host};
if(secret)headers['X-Mono-Proxy-Secret']=secret;
try{
  const status=await new Promise((resolve,reject)=>{
    const req=http.get({hostname:'127.0.0.1',port:Number(process.env.PORT||4173),path:'/api/ready',headers,timeout:4000},res=>{
      res.resume();
      res.on('end',()=>resolve(res.statusCode));
    });
    req.on('timeout',()=>req.destroy(new Error('healthcheck timeout')));
    req.on('error',reject);
  });
  if(status!==200)process.exitCode=1;
}catch{process.exitCode=1}

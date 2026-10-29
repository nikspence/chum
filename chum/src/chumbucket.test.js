import test from 'node:test';
import assert from 'node:assert/strict';
import {createChumbucketClient} from './chumbucket.js';

test('API adapter keeps credentials and CSRF on the right requests',async()=>{
 const calls=[];
 const client=createChumbucketClient('',async(url,options)=>{
   calls.push({url,...options});
   return Response.json(url==='/api/session'&&options.method==='POST'?{user:{id:'admin'},csrfToken:'csrf-secret'}:{ok:true});
 });
 await client.login('exact Password');
 await client.mkdir('root','A & B');
 const file=new File(['hello'],'hello & chum.txt',{type:'text/plain'});
 await client.upload('folder/id',file);
 await client.checkDownload('file/id');
 assert.deepEqual(JSON.parse(calls[0].body),{passphrase:'exact Password'});
 assert.equal(calls[0].headers['X-Chum-Request'],'1');
 assert.equal(calls[1].headers['X-CSRF-Token'],'csrf-secret');
 assert.equal(calls[1].credentials,'same-origin');
 assert.equal(calls[2].body,file);
 assert.equal(calls[2].headers['Content-Type'],undefined);
 assert.equal(calls[2].url,'/api/files?parent=folder%2Fid&name=hello+%26+chum.txt');
 assert.equal(calls[3].method,'HEAD');
 assert.equal(calls[3].headers['X-CSRF-Token'],undefined);
 assert.equal(client.downloadUrl('file/id'),'/api/items/file%2Fid/download');
});

test('API errors retain status, surface backend errors and clear stale CSRF',async()=>{
 let turn=0;const calls=[];
 const client=createChumbucketClient('',async(url,options)=>{
  calls.push(options);turn++;
  if(turn===1)return Response.json({csrfToken:'old-token'});
  if(turn===2)return Response.json({error:'Your invitation has ended.'},{status:401});
  return Response.json({ok:true});
 });
 await client.session();
 await assert.rejects(client.list('root'),error=>error.status===401&&error.message==='Your invitation has ended.');
 await client.mkdir('root','folder');
 assert.equal(calls[2].headers['X-CSRF-Token'],undefined);
});

test('offline and non-JSON errors are actionable',async()=>{
 const offline=createChumbucketClient('',async()=>{throw new TypeError('offline');});
 await assert.rejects(offline.session(),/Cannot reach the bucket/);
 const html=createChumbucketClient('',async()=>new Response('<html>proxy error</html>',{status:502}));
 await assert.rejects(html.session(),error=>error.status===502&&/API proxy/.test(error.message));
});

test('an old session response cannot overwrite a newly logged-in CSRF token',async()=>{
 let resolveOld;const calls=[];
 const client=createChumbucketClient('',async(url,options)=>{
  calls.push(options);
  if(url==='/api/session'&&options.method==='GET')return new Promise(resolve=>{resolveOld=resolve;});
  return Response.json({csrfToken:'new-token'});
 });
 const old=client.session();
 await client.login('password');
 resolveOld(Response.json({csrfToken:'old-token'}));await old;
 await client.mkdir('root','hello');
 assert.equal(calls.at(-1).headers['X-CSRF-Token'],'new-token');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../src/core.mjs';
import { interruptThread } from '../src/t3-control.mjs';
test('stop routes as control including targeted stop', () => {
 assert.deepEqual(route('/stop'), {kind:'stop'});
 assert.deepEqual(route('/to 2 /stop'), {kind:'stop',selector:'2'});
});
test('interrupt uses write connection and exact target', async () => {
 const result = await interruptThread({threadId:'target'}, {control: async (config, action, options) => {
 assert.equal(options.write,true);
 return action(async (name,args) => {assert.equal(name,'t3_thread_interrupt');assert.deepEqual(args,{threadId:'target'});return {ok:true};});
 }});
 assert.equal(result.ok,true);
});

test('interrupt passes the real control transport allowlist with write authorization', async () => {
 const { withT3Control } = await import('../src/t3-control.mjs');
 const calls = [];
 const cli = async (_, args) => args.includes('create') ? JSON.stringify({id:'pair',credential:'test'})
   : args.includes('list') ? '[]' : '';
 const fetchImpl = async (url, options) => {
  const endpoint = new URL(url).pathname;
  if (endpoint.endsWith('register')) return Response.json({client_id:'client'});
  if (endpoint.endsWith('decision')) {
   const state = JSON.parse(options.body).authorization.state;
   return Response.json({redirectTo:`http://127.0.0.1:1/wechat-t3-callback?state=${state}&code=test`});
  }
  if (endpoint.endsWith('token')) return Response.json({access_token:'test-token'});
  if (options.method === 'DELETE') return new Response(null,{status:204});
  const request = JSON.parse(options.body);
  if (!request.id) return new Response(null,{status:202});
  if (request.method === 'tools/call') calls.push(request.params);
  return Response.json({jsonrpc:'2.0',id:request.id,result:request.method === 'initialize'
   ? {protocolVersion:'2025-06-18'} : {structuredContent:{ok:true}}});
 };
 const control = (config, action, options) => withT3Control(config, action,
  {...options,cli,fetchImpl,readRuntime:()=>({origin:'http://127.0.0.1:3773'})});
 assert.equal((await interruptThread({threadId:'target'}, {control})).ok,true);
 assert.deepEqual(calls,[{name:'t3_thread_interrupt',arguments:{threadId:'target'}}]);
 await assert.rejects(withT3Control({}, call=>call('t3_thread_interrupt',{threadId:'target'}),
  {cli:async()=>JSON.stringify({token:'test',sessionId:'s'}),fetchImpl,readRuntime:()=>({origin:'http://127.0.0.1:3773'})}), /write credential/);
});

test('targeted stop traverses parser scheduler and execution without interrupting the selected thread', async () => {
 const { createScheduler } = await import('../src/scheduler.mjs');
 const threads = ['a','b'].map(threadId => ({threadId,projectId:'p',title:threadId,link:'test',status:'running'}));
 for (const selector of ['2', 'b', 'missing']) {
  const state={routing:{threadId:'a',listedIds:['a','b']},jobs:[{id:'stop',command:route(`/to ${selector} /stop`),status:'pending',sent:0}],seen:[]};
  const interrupted=[];
  const scheduler=createScheduler({state,config:{threadId:'a'},reference:{projectId:'p'},save(){},send:async()=>{},
   backend:{list:async()=>threads,read:async c=>threads.find(t=>t.threadId===c.threadId),interrupt:async c=>{interrupted.push(c.threadId);}}});
  for(let i=0;i<4;i++){scheduler.tick();await new Promise(resolve=>setImmediate(resolve));}
  assert.deepEqual(interrupted,selector==='missing'?[]:['b']);
  assert.equal(state.routing.threadId,'a');
 }
});

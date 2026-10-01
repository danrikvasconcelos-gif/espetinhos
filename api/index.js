const U=process.env.UPSTASH_REDIS_REST_URL||process.env.KV_REST_API_URL,T=process.env.UPSTASH_REDIS_REST_TOKEN||process.env.KV_REST_API_TOKEN;
const r=async(...c)=>{const x=await fetch(U,{method:'POST',headers:{Authorization:'Bearer '+T},body:JSON.stringify(c.map(String))});const j=await x.json();if(j.error)throw new Error(j.error);return j.result};
const H=a=>{const o={};for(let i=0;i<(a||[]).length;i+=2)o[a[i]]=a[i+1];return o};
const J=s=>s?JSON.parse(s):null;
const TZ={timeZone:'America/Fortaleza'};
const hoje=()=>new Date().toLocaleDateString('sv-SE',TZ);
const hora=()=>new Date().toLocaleTimeString('pt-BR',{...TZ,hour:'2-digit',minute:'2-digit'});
const DEF=[['Carnes','Espetinho de carne','Contra-filé temperado',8],['Carnes','Espetinho de frango','Peito com bacon',7],['Carnes','Espetinho de linguiça','Toscana artesanal',7],['Carnes','Espetinho de coração','Coração de frango',6],['Carnes','Espetinho de queijo coalho','Com orégano',8],['Acompanhamentos','Farofa','Porção individual',4],['Acompanhamentos','Vinagrete','Porção individual',3],['Acompanhamentos','Mandioca frita','Porção média',12],['Bebidas','Refrigerante lata','350 ml',6],['Bebidas','Suco natural','Copo 400 ml',7],['Bebidas','Água','500 ml',3]].map(([cat,nome,desc,preco],i)=>({id:i+1,cat,nome,desc,preco}));
const menu=async()=>{let m=J(await r('GET','menu'));if(!m){m=DEF;await r('SET','menu',JSON.stringify(m));for(const p of m)await r('HSETNX','stock',p.id,30)}return m};
// baixa de estoque atômica: tudo ou nada
const LUA="for i=1,#KEYS do local s=tonumber(redis.call('HGET','stock',KEYS[i]) or '0') if s<tonumber(ARGV[i]) then return KEYS[i] end end for i=1,#KEYS do redis.call('HINCRBY','stock',KEYS[i],-tonumber(ARGV[i])) end return 0";
const take=async it=>{const e=Object.entries(it).filter(([,q])=>q>0);if(!e.length)return 'vazio';const x=await r('EVAL',LUA,e.length,...e.map(a=>a[0]),...e.map(a=>a[1]));return x===0?null:x};
const give=async it=>{for(const [id,q] of Object.entries(it))if(q>0)await r('HINCRBY','stock',id,q)};
const lin=(m,it)=>Object.entries(it||{}).filter(([id,q])=>q>0&&m.some(x=>x.id==id)).map(([id,q])=>{const p=m.find(x=>x.id==id);return{id:+id,nome:p.nome,qtd:q,preco:p.preco}});
const mp=l=>Object.fromEntries(l.map(i=>[i.id,i.qtd]));
const soma=l=>l.reduce((s,i)=>s+i.qtd*i.preco,0);
const push=v=>r('RPUSH','sales:'+hoje(),JSON.stringify({...v,hora:hora()}));
const ob=x=>Object.fromEntries(Object.entries(H(x)).map(([k,v])=>[k,J(v)]));
module.exports=async(req,res)=>{
 try{
  const b=req.body||{},a=b.a,m=await menu(),ok=()=>res.json({ok:1}),er=(c,e)=>res.status(c).json({erro:e});
  if(a==='menu')return res.json({menu:m,estoque:H(await r('HGETALL','stock'))});
  if(a==='pedido'){
   const it0={};for(const [k,v] of Object.entries(b.itens||{}))it0[k]=Math.min(99,Math.floor(+v)||0);
   const l=lin(m,it0);if(!l.length)return er(400,'Pedido vazio');
   const it=mp(l),f=await take(it);
   if(f){const p=m.find(x=>x.id==f);return er(409,'Sem estoque suficiente: '+(p?p.nome:f))}
   const id=await r('INCR','seq'),ent=b.tipo==='Entrega';
   await r('HSET','orders',id,JSON.stringify({id,ts:hora(),cliente:String(b.nome||'').slice(0,60),tipo:ent?'Entrega':'Retirada',end:String(b.end||'').slice(0,160),pgto:String(b.pgto||'').slice(0,20),obs:String(b.obs||'').slice(0,200),taxa:ent?Math.max(0,+b.taxa||0):0,itens:it}));
   return res.json({id,subtotal:soma(l)});
  }
  // ---- área do dono ----
  if(!process.env.ADMIN_PASSWORD||req.headers['x-admin']!==process.env.ADMIN_PASSWORD)return er(401,'Senha incorreta');
  if(a==='state'){
   const [s,w,t,o,v]=await Promise.all([r('HGETALL','stock'),r('GET','waiters'),r('HGETALL','tables'),r('HGETALL','orders'),r('LRANGE','sales:'+(b.dia||hoje()),0,-1)]);
   return res.json({menu:m,estoque:H(s),garcons:J(w)||[],mesas:ob(t),pedidos:ob(o),vendas:v.map(J)});
  }
  if(a==='menu_save'){await r('SET','menu',JSON.stringify(b.menu));return ok()}
  if(a==='estoque'){await r('HSET','stock',b.id,Math.max(0,Math.floor(+b.qtd)||0));return ok()}
  if(a==='garcons'){await r('SET','waiters',JSON.stringify(b.lista||[]));return ok()}
  if(a==='mesa_abrir'){if(await r('HEXISTS','tables',b.mesa))return er(409,'Mesa já está aberta');await r('HSET','tables',b.mesa,JSON.stringify({garcom:b.garcom,itens:{}}));return ok()}
  const t=(a||'').startsWith('mesa_')?J(await r('HGET','tables',b.mesa)):null;
  if(a==='mesa_item'){
   if(!t)return er(404,'Mesa não encontrada');
   const q=t.itens[b.id]||0;
   if(b.d>0){if(await take({[b.id]:1}))return er(409,'Sem estoque');t.itens[b.id]=q+1}
   else if(q>0){await give({[b.id]:1});t.itens[b.id]=q-1;if(!t.itens[b.id])delete t.itens[b.id]}
   await r('HSET','tables',b.mesa,JSON.stringify(t));return ok();
  }
  if(a==='mesa_fechar'){
   if(!t)return er(404,'Mesa não encontrada');
   const l=lin(m,t.itens);
   if(l.length)await push({canal:'mesa',mesa:b.mesa,garcom:t.garcom,itens:l,total:soma(l),pgto:b.pgto});
   await r('HDEL','tables',b.mesa);return ok();
  }
  const o=a&&a.startsWith('wpp_')?J(await r('HGET','orders',b.id)):null;
  if(a==='wpp_fechar'||a==='wpp_cancelar'){
   if(!o)return er(404,'Pedido não encontrado');
   if(a==='wpp_cancelar')await give(o.itens);
   else{const l=lin(m,o.itens);await push({canal:'whatsapp',pedido:o.id,cliente:o.cliente,tipo:o.tipo,itens:l,taxa:o.taxa,total:soma(l)+o.taxa,pgto:b.pgto})}
   await r('HDEL','orders',b.id);return ok();
  }
  return er(400,'Ação inválida');
 }catch(e){res.status(500).json({erro:e.message})}
};

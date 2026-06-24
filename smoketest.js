const http=require('http');
const {server}=require('./server');
const PORT=8799;
function call(method,path,body,token){return new Promise((resolve,reject)=>{
  const data=body?JSON.stringify(body):null;
  const req=http.request({host:'127.0.0.1',port:PORT,path,method,headers:Object.assign(
    {'Content-Type':'application/json'},token?{Authorization:'Bearer '+token}:{} ,
    data?{'Content-Length':Buffer.byteLength(data)}:{})},res=>{
    let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve({status:res.statusCode,body:d?JSON.parse(d):{}}));});
  req.on('error',reject); if(data)req.write(data); req.end();});}
(async()=>{
  await new Promise(r=>server.listen(PORT,r));
  const log=(t,r)=>console.log(t.padEnd(34), r.status, JSON.stringify(r.body).slice(0,90));
  log('health', await call('GET','/health'));
  log('otp/request', await call('POST','/auth/otp/request',{phone:'0900000001'}));
  const v=await call('POST','/auth/otp/verify',{phone:'0900000001',code:'000000'}); log('otp/verify',v);
  const T=v.body.token;
  log('me', await call('GET','/me',null,T));
  log('catalog', await call('GET','/catalog'));
  log('book b1 detail', await call('GET','/catalog/b1'));
  log('read b1 ch1 (FREE)', await call('GET','/chapters/b1/1',null,T));
  log('read b1 ch6 (PREMIUM->402)', await call('GET','/chapters/b1/6',null,T));
  log('unlock b1 ch6', await call('POST','/chapters/b1/6/unlock',null,T));
  log('read b1 ch6 (after unlock)', await call('GET','/chapters/b1/6',null,T));
  log('me (coin trừ?)', await call('GET','/me',null,T));
  log('topup t3 (mock vnpay)', await call('POST','/wallet/topup',{packageId:'t3',provider:'vnpay',channel:'direct'},T));
  log('me (coin tăng?)', await call('GET','/me',null,T));
  log('subscribe vip (mock telco)', await call('POST','/membership/subscribe',{plan:'vip',provider:'vnpt',channel:'telco_billing'},T));
  log('read b2 ch7 via pass', await call('GET','/chapters/b2/7',null,T));
  log('heartbeat 120s', await call('POST','/reading/heartbeat',{bookId:'b1',seq:6,seconds:120},T));
  log('heartbeat 300s', await call('POST','/reading/heartbeat',{bookId:'b2',seq:7,seconds:300},T));
  const C=require('./core');
  console.log('PASS POOL (phút theo CP):', JSON.stringify(C.passPoolReport('2000-01-01','2099-01-01')));
  log('wallet/ledger', await call('GET','/wallet/ledger',null,T));
  process.exit(0);
})().catch(e=>{console.error('FAIL',e);process.exit(1)});

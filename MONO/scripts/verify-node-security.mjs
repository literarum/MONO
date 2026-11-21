// CVE-2026-105482 behavioral gate. DNS traffic stays on a private loopback server.
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import {Resolver} from 'node:dns/promises';

const server=dgram.createSocket('udp4');let received=0;
server.on('message',(message,remote)=>{
 received++;
 const response=Buffer.from(message);response.writeUInt16BE(0x8183,2);
 response.writeUInt16BE(0,6);response.writeUInt16BE(0,8);response.writeUInt16BE(0,10);
 server.send(response,remote.port,remote.address);
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.bind(0,'127.0.0.1',resolve)});
const resolver=new Resolver({timeout:500,tries:1});resolver.setServers(['127.0.0.1:'+server.address().port]);
const query=async host=>{try{await resolver.resolve4(host);return 'unexpected-answer'}catch(error){return error.code}};
try{
 assert.equal(await query('mono-before.invalid'),'ENOTFOUND');assert.equal(received,1);
 const before=received,invalidCode=await query('mono-cve-fixture.invalid\0.suffix.invalid'),invalidPackets=received-before;
 assert.equal(await query('mono-after.invalid'),'ENOTFOUND');assert.equal(received-before-invalidPackets,1);
 assert.equal(invalidCode,'ERR_INVALID_ARG_VALUE','NUL-containing resolver names must be rejected as invalid input');
 assert.equal(invalidPackets,0,'Invalid resolver names must not emit a truncated DNS request');
 console.log(JSON.stringify({status:'PASS',version:process.version,invalidCode,invalidPackets,positiveControls:2,network:'private loopback only',scope:'CVE-2026-105482 behavior; not complete vulnerability clearance'}));
}finally{server.close()}

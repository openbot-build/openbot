/** A small development App that follows the standards. Every business action uses the host proxy. */
export const html = (tool: string) => `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Document App</title>
<style>*{box-sizing:border-box}body{font:16px/1.5 system-ui;max-width:40rem;margin:1rem auto;padding:0 1rem;color-scheme:light dark;overflow-wrap:anywhere}label{display:grid;gap:.5rem;max-width:32rem}input{min-width:0;width:100%}button,input{font:inherit;max-width:100%;margin:.3rem;padding:.5rem}pre{max-height:24rem;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}</style>
<h2>Document App</h2><label>Document text <input id="text" value="Reviewed from the App interface"></label>
<button id="write">Save document</button><button id="selection">Use selection in conversation</button><button id="message">Send message</button><button id="expand">Expand</button>
<p id="status" role="status">Initializing</p><pre id="result"></pre>
<script>
const hostOrigin=parent.location.origin;
let sequence=1;let args={id:"document"};const pending=new Map();
function send(method,params,id){parent.postMessage({jsonrpc:"2.0",method,params,...(id===undefined?{}:{id})},hostOrigin)}
function request(method,params){const id=++sequence;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});send(method,params,id)})}
addEventListener("message",event=>{if(event.source!==parent||event.origin!==hostOrigin)return;const m=event.data;if(m.jsonrpc!=="2.0")return;
if(m.id===1&&m.result){send("ui/notifications/initialized",{});document.querySelector("#status").textContent="Ready";return}
if(m.method==="ui/notifications/tool-input")args=m.params.arguments;
if(m.method==="ui/notifications/tool-result")document.querySelector("#result").textContent=JSON.stringify(m.params,null,2);
if(m.method==="ui/resource-teardown"){parent.postMessage({jsonrpc:"2.0",id:m.id,result:{}},hostOrigin);return}
const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}});
function action(method,params){document.querySelector("#status").textContent="Waiting for host";request(method,params).then(result=>{document.querySelector("#result").textContent=JSON.stringify(result,null,2);document.querySelector("#status").textContent="Completed"},()=>document.querySelector("#status").textContent="Host declined or operation unavailable")}
document.querySelector("#write").onclick=()=>action("tools/call",{name:${JSON.stringify(tool)},arguments:{id:args.id||"document",text:document.querySelector("#text").value}});
document.querySelector("#selection").onclick=()=>action("ui/update-model-context",{content:[{type:"text",text:"Selected document "+(args.id||"document")}]});
document.querySelector("#message").onclick=()=>action("ui/message",{role:"user",content:[{type:"text",text:"Review the selected document"}]});
document.querySelector("#expand").onclick=()=>action("ui/request-display-mode",{mode:"fullscreen"});
send("ui/initialize",{appInfo:{name:"document-app",version:"1.0.0"},appCapabilities:{},protocolVersion:"2026-01-26"},1);
</script></html>`

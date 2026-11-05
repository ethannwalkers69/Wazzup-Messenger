export function getCookie(name){return document.cookie.split("; ").find(row=>row.startsWith(name+"="))?.split("=").slice(1).join("=")||"";}
export async function api(url,options={}){
  const method=(options.method||"GET").toUpperCase();
  const headers={...(options.headers||{})};
  if(options.body && !(options.body instanceof FormData)) headers["Content-Type"]="application/json";
  if(!["GET","HEAD","OPTIONS"].includes(method)){
    const csrf=getCookie("csrfToken");
    if(csrf) headers["X-CSRF-Token"]=decodeURIComponent(csrf);
  }
  const response=await fetch(url,{...options,method,headers,credentials:"same-origin"});
  let payload={};try{payload=await response.json();}catch{}
  if(!response.ok) throw new Error(payload.error?.message||"Request failed.");
  return payload.data;
}
export function toast(message,type="success"){
  const region=document.getElementById("toastRegion");if(!region)return;
  const el=document.createElement("div");el.className="toast "+(type==="error"?"error":"");el.textContent=message;region.append(el);
  setTimeout(()=>el.remove(),3200);
}
export function escapeHTML(value=""){return String(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}

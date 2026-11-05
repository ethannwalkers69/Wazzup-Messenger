import {api,toast,escapeHTML} from "./api.js";

const $=id=>document.getElementById(id);
const authView=$("authView"), messenger=$("messenger");
let me=null, groups=[], activeGroup=null, messages=[], replyTo=null, pollTimer=null, selectedImage=null;
const emojiList=["👍","😆","😢","😲","❤️","😡"];

function showAuth(){authView.hidden=false;messenger.hidden=true;}
function showApp(){authView.hidden=true;messenger.hidden=false;$("myName").textContent=me.display_name||me.email;$("myAvatar").textContent=(me.display_name||"W")[0].toUpperCase();$("myPlan").textContent=me.is_premium?"✦ Premium":"Free account";$("adminBtn").hidden=me.role!=="leader";}
function switchTab(tab){
  document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("active",b.dataset.tab===tab));
  $("loginForm").hidden=tab!=="login";$("signupForm").hidden=tab!=="signup";
}
document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click",()=>switchTab(b.dataset.tab)));
async function boot(){
  try{const r=await api("/api/auth/me");me=r.user;showApp();await loadGroups();}
  catch{showAuth();}
}
$("loginForm").addEventListener("submit",async e=>{
  e.preventDefault();const data=Object.fromEntries(new FormData(e.currentTarget));
  try{const r=await api("/api/auth/login",{method:"POST",body:JSON.stringify(data)});me=r.user;showApp();await loadGroups();toast("Welcome back.");}
  catch(err){toast(err.message,"error");}
});
$("signupForm").addEventListener("submit",async e=>{
  e.preventDefault();const data=Object.fromEntries(new FormData(e.currentTarget));
  try{const r=await api("/api/auth/signup",{method:"POST",body:JSON.stringify(data)});me=r.user;showApp();await loadGroups();toast("Your account is ready.");}
  catch(err){toast(err.message,"error");}
});
async function loadGroups(){
  const r=await api("/api/groups");groups=r.groups;renderGroups();
  if(activeGroup){const still=groups.find(g=>g.id===activeGroup.id);if(still)activeGroup=still;else activeGroup=null;}
  if(activeGroup)await openGroup(activeGroup.id,false);
}
function renderGroups(){
  $("groupCount").textContent=groups.length;
  $("groupList").innerHTML=groups.map(g=>`<button class="group-item ${activeGroup?.id===g.id?"active":""}" data-id="${g.id}"><span class="group-avatar">${escapeHTML(g.name[0]||"G")}</span><span><b>${escapeHTML(g.name)}</b><small>${escapeHTML(g.last_message||`${g.member_count} members`)}</small></span></button>`).join("")||`<p class="muted" style="padding:12px;font-size:.8rem">No groups yet. Create one to start chatting.</p>`;
  $("groupList").querySelectorAll("[data-id]").forEach(b=>b.addEventListener("click",()=>openGroup(b.dataset.id)));
}
async function openGroup(id,updateRoute=true){
  activeGroup=groups.find(g=>g.id===id);if(!activeGroup)return;
  renderGroups();$("emptyState").hidden=true;$("chatContent").hidden=false;
  $("activeGroupName").textContent=activeGroup.name;$("activeGroupMeta").textContent=`${activeGroup.member_count} members`;
  $("activeGroupAvatar").textContent=activeGroup.name[0]||"G";$("groupSettingsBtn").disabled=!(activeGroup.my_role==="admin"||me.role==="leader");
  messenger.classList.add("chat-open");
  await loadMessages();
  if(pollTimer)clearInterval(pollTimer);
  pollTimer=setInterval(()=>{if(!document.hidden&&activeGroup)loadMessages(true).catch(()=>{});},3000);
}
async function loadMessages(silent=false){
  if(!activeGroup)return;
  const r=await api(`/api/groups/${activeGroup.id}/messages?limit=70`);
  messages=r.messages;renderMessages();
}
function renderMessages(){
  const box=$("messages");const nearBottom=box.scrollHeight-box.scrollTop-box.clientHeight<120;
  box.innerHTML=messages.map(m=>{
    const own=m.sender_id===me.id;
    const reactions=(m.reactions||[]).map(x=>`<button class="reaction-chip ${x.mine?"selected":""}" data-react="${m.id}" data-emoji="${escapeHTML(x.emoji)}">${escapeHTML(x.emoji)} ${x.count}</button>`).join("");
    const image=m.image_url?`<img src="${escapeHTML(m.image_url)}" alt="Shared image" loading="lazy" decoding="async">`:"";
    const quote=m.reply_to_id?`<div class="reply-quote">↪ Replied to a message</div>`:"";
    return `<article class="message ${own?"own":""}"><span class="avatar">${escapeHTML((m.display_name||"?")[0])}</span><div class="bubble-wrap"><div class="sender-name">${escapeHTML(m.display_name||"Member")}</div><div class="bubble">${quote}${m.body?`<p>${escapeHTML(m.body)}</p>`:""}${image}</div><div class="message-meta">${new Date(m.created_at).toLocaleTimeString([], {hour:"numeric",minute:"2-digit"})}</div><div class="message-tools"><button data-reply="${m.id}">Reply</button>${reactions}<button data-pick="${m.id}" aria-label="Add reaction">☺</button>${(own||activeGroup.my_role==="admin"||me.role==="leader")?`<button data-delete="${m.id}">Delete</button>`:""}</div></div></article>`;
  }).join("");
  if(nearBottom)box.scrollTop=box.scrollHeight;
  box.querySelectorAll("[data-reply]").forEach(b=>b.addEventListener("click",()=>setReply(b.dataset.reply)));
  box.querySelectorAll("[data-delete]").forEach(b=>b.addEventListener("click",()=>deleteMessage(b.dataset.delete)));
  box.querySelectorAll("[data-react]").forEach(b=>b.addEventListener("click",()=>toggleReaction(b.dataset.react,b.dataset.emoji,b.classList.contains("selected"))));
  box.querySelectorAll("[data-pick]").forEach(b=>b.addEventListener("click",()=>reactionPicker(b.dataset.pick)));
}
function setReply(id){replyTo=id;const m=messages.find(x=>x.id===id);$("replyText").textContent=`Replying to ${m?.display_name||"message"}: ${(m?.body||"Photo").slice(0,90)}`;$("replyPreview").hidden=false;$("messageInput").focus();}
$("cancelReply").addEventListener("click",()=>{replyTo=null;$("replyPreview").hidden=true;});
function reactionPicker(id){
  const box=document.createElement("div");box.className="message-tools";
  box.innerHTML=emojiList.map(e=>`<button data-emoji="${e}">${e}</button>`).join("");
  const target=document.querySelector(`[data-pick="${id}"]`);target?.parentElement.append(box);
  box.querySelectorAll("button").forEach(b=>b.addEventListener("click",()=>toggleReaction(id,b.dataset.emoji,false)));
}
async function toggleReaction(id,emoji,selected){
  try{if(selected)await api(`/api/messages/${id}/reactions/${encodeURIComponent(emoji)}`,{method:"DELETE"});else await api(`/api/messages/${id}/reactions`,{method:"PUT",body:JSON.stringify({emoji})});await loadMessages();}
  catch(e){toast(e.message,"error");}
}
async function deleteMessage(id){if(!confirm("Delete this message?"))return;try{await api(`/api/messages/${id}`,{method:"DELETE"});await loadMessages();}catch(e){toast(e.message,"error");}}
$("composer").addEventListener("submit",async e=>{
  e.preventDefault();const body=$("messageInput").value.trim();if(!body&&!selectedImage)return;
  try{
    let image_url=null;
    if(selectedImage){const fd=new FormData();fd.append("image",selectedImage);const uploaded=await api("/api/upload",{method:"POST",body:fd});image_url=uploaded.url;}
    await api(`/api/groups/${activeGroup.id}/messages`,{method:"POST",body:JSON.stringify({body,image_url,reply_to_id:replyTo})});
    $("messageInput").value="";$("imageInput").value="";selectedImage=null;replyTo=null;$("replyPreview").hidden=true;await loadMessages();
  }catch(err){toast(err.message,"error");}
});
$("imageInput").addEventListener("change",e=>{selectedImage=e.target.files[0]||null;if(selectedImage)toast(`Attached: ${selectedImage.name}`);});
$("messageInput").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();$("composer").requestSubmit();}});
$("newGroupBtn").addEventListener("click",createGroup);$("emptyCreateBtn").addEventListener("click",createGroup);
async function createGroup(){
  const name=prompt("Choose a group name:");if(!name?.trim())return;
  try{const r=await api("/api/groups",{method:"POST",body:JSON.stringify({name})});await loadGroups();await openGroup(r.group.id);toast("Group created.");}catch(e){toast(e.message,"error");}
}
$("groupSettingsBtn").addEventListener("click",showGroupSettings);
async function showGroupSettings(){
  if(!activeGroup)return;
  try{
    const r=await api(`/api/groups/${activeGroup.id}/members`);
    const members=r.members;
    const canManage=activeGroup.my_role==="admin"||me.role==="leader";
    const html=`<div class="modal-backdrop" data-backdrop><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle"><div class="modal-head"><h2 id="modalTitle">Group settings</h2><button class="modal-close" data-close aria-label="Close">×</button></div>
    ${canManage?`<label>Group name<input id="editGroupName" value="${escapeHTML(activeGroup.name)}"></label><label>Group image URL<input id="editGroupImage" value="${escapeHTML(activeGroup.image_url||"")}" placeholder="/uploads/group-image.jpg"></label><button class="btn btn-primary full" id="saveGroup">Save group</button><hr><h3>Add a member</h3><label>Email address<input id="addEmail" type="email" placeholder="person@example.com"></label><button class="btn btn-primary full" id="addMember">Add user</button>`:""}
    <h3 style="margin-top:22px">Members · ${members.length}</h3>${members.map(m=>`<div class="member-row"><span class="avatar">${escapeHTML((m.display_name||"?")[0])}</span><div><b>${escapeHTML(m.nickname||m.display_name)}</b><small>${escapeHTML(m.email)} · ${m.role}</small></div>${m.is_premium?'<span class="badge">PREMIUM</span>':""}${me.role==="leader"&&m.role!=="admin"?`<button class="small-btn" data-promote="${m.id}">Promote</button>`:""}${canManage&&m.id!==me.id&&m.role!=="leader"?`<button class="small-btn" data-kick="${m.id}">Kick</button>`:""}</div>`).join("")}
    <label>Your group nickname<input id="myNickname" placeholder="Optional nickname"></label><button class="btn full" id="saveNickname">Save nickname</button><div class="modal-actions"><button class="small-btn" id="leaveGroup">Leave group</button></div></section></div>`;
    openModal(html);
    $("saveGroup")?.addEventListener("click",async()=>{try{await api(`/api/groups/${activeGroup.id}`,{method:"PATCH",body:JSON.stringify({name:$("editGroupName").value,image_url:$("editGroupImage").value||null})});closeModal();await loadGroups();toast("Group updated.");}catch(e){toast(e.message,"error");}});
    $("addMember")?.addEventListener("click",async()=>{try{await api(`/api/groups/${activeGroup.id}/members`,{method:"POST",body:JSON.stringify({email:$("addEmail").value})});toast("Member added.");showGroupSettings();}catch(e){toast(e.message,"error");}});
    $("saveNickname").addEventListener("click",async()=>{try{await api(`/api/groups/${activeGroup.id}/members/me`,{method:"PATCH",body:JSON.stringify({nickname:$("myNickname").value})});toast("Nickname saved.");}catch(e){toast(e.message,"error");}});
    $("leaveGroup").addEventListener("click",async()=>{if(!confirm("Leave this group?"))return;try{await api(`/api/groups/${activeGroup.id}/leave`,{method:"POST"});activeGroup=null;closeModal();$("chatContent").hidden=true;$("emptyState").hidden=false;await loadGroups();}catch(e){toast(e.message,"error");}});
    document.querySelectorAll("[data-kick]").forEach(b=>b.addEventListener("click",async()=>{if(!confirm("Remove this member?"))return;try{await api(`/api/groups/${activeGroup.id}/members/${b.dataset.kick}`,{method:"DELETE"});showGroupSettings();}catch(e){toast(e.message,"error");}}));
    document.querySelectorAll("[data-promote]").forEach(b=>b.addEventListener("click",async()=>{try{await api(`/api/groups/${activeGroup.id}/members/${b.dataset.promote}`,{method:"PATCH",body:JSON.stringify({role:"admin"})});toast("Admin promoted.");showGroupSettings();}catch(e){toast(e.message,"error");}}));
  }catch(e){toast(e.message,"error");}
}
$("profileBtn").addEventListener("click",showProfile);
function showProfile(){
  openModal(`<div class="modal-backdrop" data-backdrop><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle"><div class="modal-head"><h2 id="modalTitle">Your profile</h2><button class="modal-close" data-close aria-label="Close">×</button></div><p class="muted">${escapeHTML(me.email)} ${me.is_premium?'<span class="badge">PREMIUM</span>':""}</p><label>First name<input id="profileFirst" value="${escapeHTML(me.first_name)}"></label><label>Last name<input id="profileLast" value="${escapeHTML(me.last_name)}"></label><label>Display name<input id="profileDisplay" value="${escapeHTML(me.display_name)}"></label><label>Avatar image URL<input id="profileAvatar" value="${escapeHTML(me.avatar_url||"")}" placeholder="/uploads/your-image.jpg"></label><label>Upload avatar<input id="profileAvatarFile" type="file" accept="image/jpeg,image/png,image/gif,image/webp"></label><button class="btn btn-primary full" id="saveProfile">Save profile</button><button class="small-btn" id="logoutBtn" style="margin-top:12px">Log out</button></section></div>`);
  $("saveProfile").addEventListener("click",async()=>{try{let avatar_url=$("profileAvatar").value||null;const file=$("profileAvatarFile").files[0];if(file){const fd=new FormData();fd.append("image",file);avatar_url=(await api("/api/upload",{method:"POST",body:fd})).url;}const r=await api("/api/me",{method:"PATCH",body:JSON.stringify({first_name:$("profileFirst").value,last_name:$("profileLast").value,display_name:$("profileDisplay").value,avatar_url})});me=r.user;showApp();closeModal();toast("Profile updated.");}catch(e){toast(e.message,"error");}});
  $("logoutBtn").addEventListener("click",async()=>{try{await api("/api/auth/logout",{method:"POST"});if(pollTimer)clearInterval(pollTimer);me=null;activeGroup=null;closeModal();showAuth();switchTab("login");}catch(e){toast(e.message,"error");}});
}
$("adminBtn").addEventListener("click",showAdmin);
async function showAdmin(){
  try{const r=await api("/api/admin/users");openModal(`<div class="modal-backdrop" data-backdrop><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle"><div class="modal-head"><h2 id="modalTitle">Leader panel</h2><button class="modal-close" data-close aria-label="Close">×</button></div><p class="muted">Toggle premium access for an account.</p>${r.users.map(u=>`<div class="admin-user"><div><b>${escapeHTML(u.display_name)}</b><small>${escapeHTML(u.email)}</small></div><span class="badge">${u.is_premium?"PREMIUM":"FREE"}</span><button class="small-btn" data-premium="${u.id}">Toggle</button></div>`).join("")}</section></div>`);
  document.querySelectorAll("[data-premium]").forEach(b=>b.addEventListener("click",async()=>{try{await api(`/api/admin/premium/${b.dataset.premium}`,{method:"POST"});toast("Premium status updated.");showAdmin();}catch(e){toast(e.message,"error");}}));
  }catch(e){toast(e.message,"error");}
}
function openModal(html){
  $("modalRoot").innerHTML=html;
  const backdrop=$("modalRoot").querySelector("[data-backdrop]");
  backdrop.querySelector("[data-close]").addEventListener("click",closeModal);
  backdrop.addEventListener("click",e=>{if(e.target===backdrop)closeModal();});
  const first=backdrop.querySelector("input,button");first?.focus();
  document.addEventListener("keydown",escClose,{once:true});
}
function escClose(e){if(e.key==="Escape")closeModal();}
function closeModal(){$("modalRoot").innerHTML="";}
$("mobileBack").addEventListener("click",()=>messenger.classList.remove("chat-open"));
document.querySelectorAll("[data-mobile]").forEach(b=>b.addEventListener("click",()=>{document.querySelectorAll("[data-mobile]").forEach(x=>x.classList.remove("active"));b.classList.add("active");if(b.dataset.mobile==="profile")showProfile();else messenger.classList.remove("chat-open");}));
document.addEventListener("visibilitychange",()=>{if(document.hidden&&pollTimer)clearInterval(pollTimer);else if(activeGroup)pollTimer=setInterval(()=>loadMessages(true).catch(()=>{}),3000);});
boot();

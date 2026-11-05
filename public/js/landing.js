const topbar=document.getElementById("topbar");
const update=()=>topbar.classList.toggle("scrolled",window.scrollY>24);
window.addEventListener("scroll",update,{passive:true});update();
document.getElementById("year").textContent=new Date().getFullYear();
const reduce=matchMedia("(prefers-reduced-motion: reduce)").matches;
const observer=new IntersectionObserver(entries=>entries.forEach((entry,i)=>{if(entry.isIntersecting){entry.target.style.transitionDelay=`${i*60}ms`;entry.target.classList.add("visible");observer.unobserve(entry.target);}}),{threshold:.12});
document.querySelectorAll(".reveal").forEach(el=>reduce?el.classList.add("visible"):observer.observe(el));
const countObserver=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){const el=entry.target;const end=Number(el.dataset.count);el.textContent=end===0?"0":String(end);countObserver.unobserve(el);}}));
document.querySelectorAll("[data-count]").forEach(el=>countObserver.observe(el));

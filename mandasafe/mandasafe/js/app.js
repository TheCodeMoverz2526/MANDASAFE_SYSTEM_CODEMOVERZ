/* =========================================================
   MandaSafe — shared application script
   ========================================================= */

/* ---------------- SVG icon set ---------------- */
const ICONS = {
  logo:'<path d="M12 2C7.6 2 4 5.6 4 10c0 5.2 7 12 8 12s8-6.8 8-12c0-4.4-3.6-8-8-8z" fill="currentColor" opacity=".25"/><path d="M12 2C7.6 2 4 5.6 4 10c0 5.2 7 12 8 12s8-6.8 8-12c0-4.4-3.6-8-8-8zm0 11a3 3 0 110-6 3 3 0 010 6z" stroke="currentColor" stroke-width="1.6" fill="none"/>',
  home:'<path d="M3 10.5L12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  plus:'<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/>',
  pin:'<path d="M12 21s7-6.2 7-11a7 7 0 10-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/>',
  clipboard:'<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="M9 10h6M9 14h6M9 18h3"/>',
  fire:'<path d="M12 3s5 4 5 8a5 5 0 11-10 0c0-2 1-3 1-3s.5 2 2 2c0-3 2-7 2-7z"/>',
  shield:'<path d="M12 3l7 3v6c0 4.4-3 7.9-7 9-4-1.1-7-4.6-7-9V6l7-3z"/><path d="M9.2 12.2l2 2 3.6-3.9"/>',
  megaphone:'<path d="M3 11v2a1 1 0 001 1h2l5 4V6L6 10H4a1 1 0 00-1 1z"/><path d="M16 9a4 4 0 010 6"/><path d="M19 6.5a8 8 0 010 11"/>',
  bell:'<path d="M18 15v-4a6 6 0 10-12 0v4l-1.5 3h15L18 15z"/><path d="M10 21h4"/>',
  user:'<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20a7.5 7.5 0 0115 0"/>',
  users:'<circle cx="9" cy="8" r="3.2"/><path d="M2.8 19a6.2 6.2 0 0112.4 0"/><circle cx="17.5" cy="8.5" r="2.6"/><path d="M16 14.4a5.6 5.6 0 015.3 4.6"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  headset:'<path d="M4 13v-1a8 8 0 0116 0v1"/><rect x="2.6" y="13" width="4" height="6" rx="1.6"/><rect x="17.4" y="13" width="4" height="6" rx="1.6"/><path d="M19.4 19v.6a2.4 2.4 0 01-2.4 2.4h-3"/>',
  car:'<path d="M5 16.5h14M6.5 16.5V19H4.8v-2.5M17.5 16.5V19h1.7v-2.5"/><path d="M4 16.5v-4l2-4.5h12l2 4.5v4z"/><circle cx="8" cy="13.6" r="1.1" fill="currentColor" stroke="none"/><circle cx="16" cy="13.6" r="1.1" fill="currentColor" stroke="none"/>',
  alert:'<path d="M12 4l9 15.5H3L12 4z"/><path d="M12 10v4M12 17h.01"/>',
  cone:'<path d="M12 3l5 15H7L12 3z"/><path d="M4 21h16"/><path d="M9.2 12h5.6"/>',
  worker:'<circle cx="12" cy="5.4" r="2.2"/><path d="M8 21l2.2-6.6L8.6 12 6 14.5"/><path d="M12.4 10.2l2.6 2.2 3 .6"/><path d="M12.6 14.4L15 21"/>',
  dots:'<circle cx="7" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="17" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 1.9"/>',
  check:'<circle cx="12" cy="12" r="9"/><path d="M8.2 12.4l2.6 2.6L16 9.8"/>',
  checkOnly:'<path d="M4 12.5l5 5L20 6.5"/>',
  chart:'<path d="M4 20V9M10 20V4M16 20v-7M22 20H2"/>',
  trend:'<path d="M3 17l5.5-6 4 4L21 6"/><path d="M15 6h6v6"/>',
  map:'<path d="M9 4L3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5 9 4z"/><path d="M9 4v13M15 6.5v13"/>',
  search:'<circle cx="11" cy="11" r="6.4"/><path d="M20 20l-3.6-3.6"/>',
  filter:'<path d="M3.5 5.5h17l-6.6 7.6V19l-3.8 2v-7.9L3.5 5.5z"/>',
  layers:'<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
  calendar:'<rect x="3.5" y="5" width="17" height="16" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
  mail:'<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3.6 7l8.4 6 8.4-6"/>',
  lock:'<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.8a4 4 0 018 0v2.7"/>',
  eye:'<path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  login:'<path d="M14 3h4.5A1.5 1.5 0 0120 4.5v15a1.5 1.5 0 01-1.5 1.5H14"/><path d="M10 8l-4 4 4 4M6 12h9"/>',
  arrow:'<path d="M5 12h13M13 6.5l5.5 5.5L13 17.5"/>',
  phone:'<path d="M6 3.5h3l1.6 4-2 1.4a12 12 0 006.5 6.5l1.4-2 4 1.6v3a2 2 0 01-2.2 2A16.5 16.5 0 014 5.7 2 2 0 016 3.5z"/>',
  camera:'<rect x="3" y="7" width="18" height="13" rx="2.5"/><circle cx="12" cy="13.5" r="3.4"/><path d="M8.5 7l1.5-2.5h4L15.5 7"/>',
  edit:'<path d="M4 20h4l10-10-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  key:'<circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v3.5M15.5 12v2.5"/>',
  copy:'<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5.5 15H5a1 1 0 01-1-1V5a1 1 0 011-1h9a1 1 0 011 1v.5"/>',
  logout:'<path d="M10 3H5.5A1.5 1.5 0 004 4.5v15A1.5 1.5 0 005.5 21H10"/><path d="M16 8l4 4-4 4M20 12H9"/>',
  file:'<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z"/><path d="M14 3v5h5"/>',
  wifi:'<path d="M5 12.5a10 10 0 0114 0"/><path d="M8.2 15.6a5.5 5.5 0 017.6 0"/><circle cx="12" cy="19" r="1.3" fill="currentColor" stroke="none"/>',
  google:''
};
function icon(name,cls){
  return '<svg class="'+(cls||'')+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'+(ICONS[name]||'')+'</svg>';
}

/* ---------------- Incident type meta ---------------- */
const TYPES = {
  Accident:{ic:'car',cls:'bg-accident',color:'#dc2626'},
  Traffic :{ic:'car',cls:'bg-traffic', color:'#f97316'},
  Hazard  :{ic:'alert',cls:'bg-hazard',color:'#f59e0b'},
  'Road Work':{ic:'worker',cls:'bg-roadwork',color:'#2563eb'},
  Others  :{ic:'dots',cls:'bg-others',color:'#8b5cf6'}
};
const SEVERITY_TAG = {High:'t-high',Medium:'t-med',Low:'t-low'};

/* Hotspot risk from the data: an area's incident count against the busiest hotspot —
   over two-thirds of it is High (red), over one-third Moderate (yellow), the rest Low (green). */
const RISK_LEVELS = {
  high:  {key:'high',  label:'High Risk',     tag:'t-high', color:'#dc2626'},
  medium:{key:'medium',label:'Moderate Risk', tag:'t-med',  color:'#eab308'},
  low:   {key:'low',   label:'Low Risk',      tag:'t-low',  color:'#16a34a'}
};
function hotspotLevel(h, list){
  const top = Math.max(1, ...(list||HOTSPOTS).map(x=>x.count||0));
  const share = (h.count||0)/top;
  return RISK_LEVELS[share > 2/3 ? 'high' : share > 1/3 ? 'medium' : 'low'];
}
const STATUS_TAG   = {'Under Review':'t-review','On Process':'t-process','Resolved':'t-resolved'};

/* ---------------- Seed data ---------------- */
const SEED_INCIDENTS = [
  {id:'INC-2026-0902-0005',type:'Accident',   title:'Two-vehicle collision', loc:'EDSA Northbound, near Shaw Blvd.',       brgy:'Highway Hills',      lat:14.5817,lng:121.0530,sev:'High',  status:'Under Review',date:'2026-09-02',time:'10:25 AM',count:3,mine:true},
  {id:'INC-2026-0902-0004',type:'Traffic',    title:'Heavy traffic build-up',loc:'Shaw Blvd. Eastbound, near Star Mall',   brgy:'Wack-Wack Greenhills',lat:14.5822,lng:121.0455,sev:'Medium',status:'On Process',  date:'2026-09-02',time:'10:20 AM',count:2,mine:false},
  {id:'INC-2026-0902-0003',type:'Hazard',     title:'Fallen tree on lane',   loc:'Pioneer St., near Boni Ave.',            brgy:'Barangka Ilaya',     lat:14.5741,lng:121.0447,sev:'Low',   status:'On Process',  date:'2026-09-02',time:'10:15 AM',count:1,mine:false},
  {id:'INC-2026-0902-0002',type:'Road Work',  title:'Road re-blocking',      loc:'J.P. Rizal St., near City Hall',         brgy:'Poblacion',          lat:14.5776,lng:121.0344,sev:'Low',   status:'Resolved',    date:'2026-09-02',time:'10:10 AM',count:2,mine:true},
  {id:'INC-2026-0902-0001',type:'Others',     title:'Debris on road',        loc:'Ortigas Ave., near Robinsons Forum',     brgy:'San Antonio',        lat:14.5878,lng:121.0592,sev:'Low',   status:'Resolved',    date:'2026-09-02',time:'09:58 AM',count:3,mine:false},
  {id:'INC-2026-0901-0012',type:'Accident',   title:'Motorcycle skid',       loc:'Boni Ave., cor. Barangka Drive',         brgy:'Barangka Drive',     lat:14.5751,lng:121.0369,sev:'High',  status:'On Process',  date:'2026-09-01',time:'04:42 PM',count:2,mine:true},
  {id:'INC-2026-0901-0009',type:'Traffic',    title:'Stalled bus',           loc:'EDSA Southbound, near Guadalupe Bridge', brgy:'Hulo',               lat:14.5679,lng:121.0439,sev:'Medium',status:'Resolved',    date:'2026-09-01',time:'02:10 PM',count:1,mine:false},
  {id:'INC-2026-0901-0007',type:'Hazard',     title:'Open manhole',          loc:'Kalentong Rd., near Fabella',            brgy:'Mabini-J. Rizal',    lat:14.5942,lng:121.0248,sev:'Medium',status:'Under Review',date:'2026-09-01',time:'11:05 AM',count:1,mine:true},
  {id:'INC-2026-0831-0015',type:'Road Work',  title:'Drainage repair',       loc:'Maysilo Circle, Plainview',              brgy:'Plainview',          lat:14.5798,lng:121.0421,sev:'Low',   status:'Resolved',    date:'2026-08-31',time:'08:30 AM',count:2,mine:false},
  {id:'INC-2026-0831-0011',type:'Accident',   title:'Rear-end collision',    loc:'Pioneer St., near Sheridan',             brgy:'Highway Hills',      lat:14.5729,lng:121.0561,sev:'High',  status:'Resolved',    date:'2026-08-31',time:'07:15 AM',count:2,mine:false},
  {id:'INC-2026-0830-0006',type:'Traffic',    title:'Congestion at rotonda', loc:'Mandaluyong Circle, Kalentong',          brgy:'Old Zañiga',         lat:14.5905,lng:121.0305,sev:'Medium',status:'Resolved',    date:'2026-08-30',time:'06:50 PM',count:2,mine:false},
  {id:'INC-2026-0830-0002',type:'Others',     title:'Flooded underpass',     loc:'Wack-Wack, near Greenhills exit',        brgy:'Wack-Wack Greenhills',lat:14.5991,lng:121.0472,sev:'Medium',status:'Resolved',   date:'2026-08-30',time:'05:20 AM',count:1,mine:false}
];

const HOTSPOTS = [
  {rank:1,name:'EDSA – Shaw Blvd. Area',        risk:'High Risk',   cls:'t-high', count:28,lat:14.5820,lng:121.0530,w:1.0},
  {rank:2,name:'Boni Ave. – Pioneer St. Area',  risk:'High Risk',   cls:'t-high', count:21,lat:14.5744,lng:121.0455,w:0.86},
  {rank:3,name:'J.P. Rizal St. Area',           risk:'Medium Risk', cls:'t-med',  count:18,lat:14.5779,lng:121.0350,w:0.7},
  {rank:4,name:'Kalentong Area',                risk:'Medium Risk', cls:'t-med',  count:12,lat:14.5928,lng:121.0268,w:0.55},
  {rank:5,name:'Highway Hills Area',            risk:'Low Risk',    cls:'t-low',  count: 9,lat:14.5760,lng:121.0575,w:0.42},
  {rank:6,name:'Guadalupe / Hulo Riverside',    risk:'Low Risk',    cls:'t-low',  count: 7,lat:14.5672,lng:121.0430,w:0.34},
  {rank:7,name:'Ortigas Ave. – Wack-Wack',      risk:'Low Risk',    cls:'t-low',  count: 6,lat:14.5975,lng:121.0520,w:0.3}
];

const ANNOUNCEMENTS = [
  {mo:'SEP',dy:'02',title:'Road Maintenance on Shaw Blvd.',    body:'Scheduled maintenance on Shaw Blvd. from September 2–4, 2026. Expect heavy traffic. Plan your routes ahead.',time:'10:00 AM',tag:'New'},
  {mo:'AUG',dy:'31',title:'EDSA Traffic Advisory',             body:'Traffic re-routing along EDSA due to ongoing construction near Guadalupe. Please follow traffic signs and stay alert.',time:'09:15 AM',tag:''},
  {mo:'AUG',dy:'29',title:'Tree Trimming Operations',          body:'Tree trimming along Pioneer St. on August 29–31, 2026. Expect minor lane closures during daytime hours.',time:'03:30 PM',tag:''},
  {mo:'AUG',dy:'26',title:'Barangka Drive Re-blocking',        body:'Concrete re-blocking on Barangka Drive starts August 26. Motorists are advised to use Boni Ave. as alternate route.',time:'08:45 AM',tag:''}
];

const NOTIFICATIONS = [
  {type:'Accident', text:'Your incident report (INC-2026-0902-0005) is now under review.', time:'10:35 AM • Sep 02, 2026', unread:true},
  {type:'Traffic',  text:'Traffic congestion detected on EDSA Northbound.',                time:'10:20 AM • Sep 02, 2026', unread:true},
  {type:'Resolved', text:'Incident (INC-2026-0902-0002) has been resolved.',               time:'10:05 AM • Sep 02, 2026', unread:false},
  {type:'Announce', text:'New announcement: Road Maintenance on Shaw Blvd.',               time:'08:00 AM • Sep 02, 2026', unread:false},
  {type:'Hazard',   text:'Hazard reported near your saved location (Plainview).',          time:'04:12 PM • Sep 01, 2026', unread:false}
];

/* ---------------- Storage helpers ---------------- */
const DB = {
  get(k,fb){ try{ const v=localStorage.getItem('mandasafe_'+k); return v?JSON.parse(v):fb; }catch(e){ return fb; } },
  set(k,v){ try{ localStorage.setItem('mandasafe_'+k,JSON.stringify(v)); }catch(e){} },
  del(k){ try{ localStorage.removeItem('mandasafe_'+k); }catch(e){} }
};
function incidents(){
  let list = DB.get('incidents',null);
  if(!list){ list = SEED_INCIDENTS.slice(); DB.set('incidents',list); }
  return list;
}
function saveIncident(inc){ const l=incidents(); l.unshift(inc); DB.set('incidents',l); }

const DEFAULT_USER = {name:'Juan Dela Cruz',email:'juan.delacruz@gmail.com',mobile:'0917 123 4567',brgy:'Plainview',role:'User'};
function currentUser(){ return DB.get('user',DEFAULT_USER); }
function isLoggedIn(){ return DB.get('auth',false)===true; }
function login(u){ DB.set('auth',true); DB.set('user',u); }
function logout(){ DB.set('auth',false); location.href='login.html'; }
function requireAuth(){ if(!isLoggedIn()){ location.replace('login.html'); } }

/* ---------------- Shell rendering ---------------- */
const NAV = [
  {id:'dashboard',    label:'Dashboard',      icon:'home',      href:'dashboard.html'},
  {id:'report',       label:'Report Incident',icon:'plus',      href:'report.html'},
  {id:'map',          label:'Incident Map',   icon:'pin',       href:'incident-map.html'},
  {id:'my',           label:'My Incidents',   icon:'clipboard', href:'my-incidents.html'},
  {id:'hotspots',     label:'Hotspots',       icon:'fire',      href:'hotspots.html'},
  {id:'safety',       label:'Safety Index',   icon:'shield',    href:'safety-index.html'},
  {id:'announce',     label:'Announcements',  icon:'megaphone', href:'announcements.html'},
  {id:'notif',        label:'Notifications',  icon:'bell',      href:'notifications.html', badge:3},
  {id:'profile',      label:'Profile',        icon:'user',      href:'profile.html'}
];
const NAV_SUPPORT = [
  {id:'about',   label:'About Us',       icon:'info',    href:'about.html'},
  {id:'support', label:'Contact Support',icon:'headset', href:'support.html'}
];

function buildShell(active){
  const u = currentUser();
  const initials = u.name.split(' ').map(s=>s[0]).slice(0,2).join('').toUpperCase();

  const topbar =
   '<header class="topbar">'+
     '<button class="hamburger" id="ms-burger" aria-label="Toggle menu">'+
       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>'+
     '</button>'+
     '<a class="brand" href="dashboard.html">'+
       '<span class="brand-logo">'+icon('logo')+'</span>'+
       '<span><span class="brand-name">Manda<span>Safe</span></span>'+
       '<span class="brand-sub" style="display:block">Road Incident Mapping &amp; Analytics System</span></span>'+
     '</a>'+
     '<div class="topbar-actions">'+
       '<a class="bell" href="notifications.html">'+icon('bell')+'<span class="dot">3</span></a>'+
       '<div class="userchip" id="ms-userchip" title="Click to sign out">'+
         '<span class="avatar">'+initials+'</span>'+
         '<span><span class="nm">'+u.name+'</span><span class="rl" style="display:block">'+u.role+'</span></span>'+
         '<svg style="width:16px;height:16px;color:#64748b" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>'+
       '</div>'+
     '</div>'+
   '</header>';

  const item = n => '<a class="nav-item'+(n.id===active?' active':'')+'" href="'+n.href+'">'+icon(n.icon)+
      '<span>'+n.label+'</span>'+(n.badge?'<span class="badge">'+n.badge+'</span>':'')+'</a>';

  const sidebar =
   '<aside class="sidebar">'+
     '<div class="nav-label">NAVIGATION</div>'+ NAV.map(item).join('')+
     '<div class="nav-sep"></div>'+
     '<div class="nav-label">SUPPORT</div>'+ NAV_SUPPORT.map(item).join('')+
     '<div class="side-card">'+
       '<img class="seal" src="assets/seal.svg" alt="Mandaluyong City seal">'+
       '<p>Mandaluyong City<br>Traffic Planning and<br>Management Office</p>'+
     '</div>'+
     '<div class="side-copy">© 2026 All rights reserved.</div>'+
   '</aside><div class="backdrop" id="ms-backdrop"></div>';

  document.body.insertAdjacentHTML('afterbegin', topbar + sidebar);
  document.getElementById('ms-burger').onclick = ()=>document.body.classList.toggle('nav-open');
  document.getElementById('ms-backdrop').onclick = ()=>document.body.classList.remove('nav-open');
  document.getElementById('ms-userchip').onclick = ()=>{ if(confirm('Sign out of MandaSafe?')) logout(); };
}

/* ---------------- UI helpers ---------------- */
function toast(msg){
  let t = document.querySelector('.toast');
  if(!t){ t=document.createElement('div'); t.className='toast'; document.body.appendChild(t); }
  t.innerHTML = icon('checkOnly')+'<span>'+msg+'</span>';
  requestAnimationFrame(()=>t.classList.add('show'));
  clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'),3200);
}
function typeIcon(type,size){
  const m = TYPES[type]||TYPES.Others;
  return '<i class="'+m.cls+'">'+icon(m.ic)+'</i>';
}
function fmtDate(iso){
  const d=new Date(iso+'T00:00:00');
  return d.toLocaleDateString('en-US',{month:'short',day:'2-digit',year:'numeric'});
}
function liveClock(el){
  const tick=()=>{
    const d=new Date();
    el.textContent = d.toLocaleDateString('en-US',{month:'short',day:'2-digit',year:'numeric'})+'   '+
                     d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
  };
  tick(); setInterval(tick,30000);
}

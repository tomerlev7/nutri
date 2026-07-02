import { useState, useEffect, useRef } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

// ══ Constants ══════════════════════════════════════════════════════════
const dateStr = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const TODAY = () => dateStr();

const DEFAULTS = {
  profile: { name:"תומר", height:174, weight:100.75, age:28, gender:"male", goalWeight:80, activityLevel:"moderate", stepsPerKmCustom:null },
  goals:   { calories:2200, protein:160, carbs:250, fat:62, fiber:35, water:14, weightLossKgPerWeek:0.75 },
};
const ACTIVITIES = {
  sedentary:  { label:"יושבני (ללא ספורט)", f:1.2 },
  light:      { label:"קל (1–3 פעמים/שבוע)", f:1.375 },
  moderate:   { label:"מתון (3–5 פעמים/שבוע)", f:1.55 },
  active:     { label:"פעיל (6–7 פעמים/שבוע)", f:1.725 },
  veryActive: { label:"פעיל מאוד / עבודה פיזית", f:1.9 },
};
const WORKOUT_TYPES = {
  strength: { label:"כוח / חדר כושר", icon:"💪", color:"#818CF8", met:4.5 },
  swimming:  { label:"שחייה",           icon:"🏊", color:"#60A5FA", met:7   },
  walking:   { label:"הליכה / ריצה",   icon:"🚶", color:"#4ADE80", met:3.8 },
  cycling:   { label:"רכיבה",           icon:"🚴", color:"#F59E0B", met:6   },
  other:     { label:"אחר",             icon:"⚡", color:"#F87171", met:4   },
};
const SWIM_STYLES = ["חופשי","חזה","גב","פרפר","מעורב"];

// ══ Storage ════════════════════════════════════════════════════════════
// ── User ID for cross-device sync ──
const getUID = () => {
  let uid = localStorage.getItem('nutri_uid');
  if (!uid) {
    uid = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2);
    localStorage.setItem('nutri_uid', uid);
  }
  return uid;
};

// ── Auto-sync: reads ALL data from localStorage → saves to Supabase ──
let _syncTimer = null;
const _triggerSync = () => {
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(async () => {
    const keys = ['profile','goals','foodLog','weightLog','waterLog',
                  'fitnessLog','stepsLog','templates','myFoods','shortGoals','chat'];
    const data = {};
    keys.forEach(k => {
      try { const v = localStorage.getItem('nt_'+k); if (v) data[k] = JSON.parse(v); } catch {}
    });
    try {
      await fetch('/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: getUID(), data }),
      });
    } catch {}
  }, 2000);
};

const db = {
  get: async (k, fb) => {
    try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : fb; }
    catch { return fb; }
  },
  // Every save → localStorage immediately + Supabase sync after 2s
  set: async (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
      _triggerSync(); // ← THIS is what was missing
      return true;
    } catch { return false; }
  },
};

// Load data from Supabase on startup — with 4s timeout
const loadFromKV = async (uid) => {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`/api/data?uid=${encodeURIComponent(uid || getUID())}`,
      { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
};

// Export all app data as JSON file
const exportAllData = (profile, goals, foodLog, weightLog, waterLog, fitnessLog, stepsLog, templates, myFoods, shortGoals) => {
  const data = {
    _version: 1, _exported: new Date().toISOString(),
    profile, goals, foodLog, weightLog, waterLog, fitnessLog, stepsLog, templates, myFoods, shortGoals
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:"application/json"});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = `nutri-backup-${TODAY()}.json`; a.click();
  URL.revokeObjectURL(url);
};

// Save all to storage at once
const saveAllToStorage = async (data) => {
  const keys = ["profile","goals","foodLog","weightLog","waterLog","fitnessLog","stepsLog","templates","myFoods","shortGoals"];
  const results = await Promise.all(keys.map(k => db.set("nt_"+k, data[k])));
  return results.every(Boolean);
};

// ══ Math helpers ═══════════════════════════════════════════════════════
const calcBMI    = (w, h) => h > 0 ? +(w / (h/100)**2).toFixed(1) : null;
const bmiInfo    = b => {
  if (!b) return { label:"—", color:"#64748B" };
  if (b < 18.5) return { label:"תת משקל", color:"#60A5FA" };
  if (b < 25)   return { label:"תקין ✓",  color:"#4ADE80" };
  if (b < 30)   return { label:"עודף משקל",color:"#F59E0B" };
  return              { label:"השמנה",    color:"#F87171" };
};
const calcTDEE   = ({ weight,height,age,gender,activityLevel }) => {
  const bmr = 10*weight + 6.25*height - 5*age + (gender === "male" ? 5 : -161);
  return Math.round(bmr * (ACTIVITIES[activityLevel]?.f ?? 1.55));
};
const sumFood    = fs => fs.reduce(
  (a,f) => ({ calories:a.calories+(f.calories||0), protein:a.protein+(f.protein||0),
    carbs:a.carbs+(f.carbs||0), fat:a.fat+(f.fat||0), fiber:a.fiber+(f.fiber||0) }),
  { calories:0, protein:0, carbs:0, fat:0, fiber:0 }
);
const calcStreak = foodLog => {
  let s = 0; const d = new Date();
  for (let i = 0; i < 365; i++) {
    const k = dateStr(d);
    if ((foodLog[k]||[]).length > 0) { s++; d.setDate(d.getDate()-1); }
    else if (i === 0) d.setDate(d.getDate()-1); // allow today empty
    else break;
  }
  return s;
};
const workoutCal = (type, dMin, wKg, incline=0) => {
  const base = WORKOUT_TYPES[type]?.met ?? 4;
  const met  = type==="walking" ? base + incline*0.08 : base;
  return Math.round(met * wKg * (dMin/60));
};
const hexToRgb = h => {
  const r=parseInt(h.slice(1,3),16),g=parseInt(h.slice(3,5),16),b=parseInt(h.slice(5,7),16);
  return `${r},${g},${b}`;
};
// Steps per km based on height (stride length = height × 0.415)
// e.g. 174cm → 1000/(1.74×0.415) ≈ 1385 steps/km
const stepsPerKm = (heightCm) => Math.round(100000 / (heightCm * 0.415));

// Steps per km adjusted for incline: steeper = shorter stride = more steps/km
// Each 1% incline reduces stride length by ~0.4%
// e.g. 174cm at 15% incline: 1385 × 1/(1-0.06) ≈ 1473 steps/km
const stepsPerKmInclined = (heightCm, inclinePct, override=null) => {
  const base = override || stepsPerKm(heightCm);
  const factor = 1 / (1 - Math.min((inclinePct||0) * 0.004, 0.28));
  return Math.round(base * factor);
};

// Calories burned today from logged workouts
const dayWorkoutCal = (fitnessLog, date) =>
  (fitnessLog[date]||[]).reduce((s,w) => s+(w.calories||0), 0);

// Effective daily goals: base goals + workout calories earned today
// Uses eat-back approach: TDEE is sedentary baseline, workout earns extra budget
const effectiveGoals = (goals, fitnessLog, date) => {
  const bonus = dayWorkoutCal(fitnessLog, date);
  return { ...goals, calories: goals.calories + bonus, _workoutBonus: bonus };
};

// ══ Claude API helpers ═════════════════════════════════════════════════
const callClaude = async (messages, system="", withSearch=false, maxTokens=1000, mcpServers=[]) => {
  const body = { model:"claude-sonnet-4-6", max_tokens:maxTokens, messages };
  if (system) body.system = system;
  if (withSearch) body.tools = [{ type:"web_search_20250305", name:"web_search" }];
  if (mcpServers.length) body.mcp_servers = mcpServers;
  const res  = await fetch("/api/claude", {
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "API error");
  return data.content?.filter(b => b.type === "text").map(b => b.text).join("") || "";
};

// Hebrew number words → digits (handles "שלוש ביצים" → "3 ביצים")
const HEBREW_NUMS = {
  "חצי":0.5,"רבע":0.25,"שלושה רבעי":0.75,
  "אחד":1,"אחת":1,
  "שניים":2,"שתיים":2,"שני":2,"שתי":2,
  "שלושה":3,"שלוש":3,
  "ארבעה":4,"ארבע":4,
  "חמישה":5,"חמש":5,
  "שישה":6,"שש":6,
  "שבעה":7,"שבע":7,
  "שמונה":8,
  "תשעה":9,"תשע":9,
  "עשרה":10,"עשר":10,
};
const normalizeHebNums = t => {
  // Sort longest first to avoid partial replacement
  return Object.entries(HEBREW_NUMS)
    .sort((a,b)=>b[0].length-a[0].length)
    .reduce((s,[w,n])=>s.replace(new RegExp(w,"g"), String(n)), t);
};

// Parse natural Hebrew food description → [{name,calories,protein,carbs,fat,fiber,amount}]
const parseNaturalFood = async rawText => {
  const text = normalizeHebNums(rawText); // "שלוש ביצים" → "3 ביצים"
  try {
    const res = await fetch("/api/claude", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 900,
        system: `אתה API של מאגר תזונה. קיבלת תיאור של ארוחה בעברית.
החזר אך ורק מערך JSON תקין — ללא markdown, ללא הסברים, ללא טקסט נוסף.
פורמט מדויק (אל תשנה את שמות המפתחות):
[{"name":"שם קצר עברי","calories":165,"protein":20,"carbs":0,"fat":7,"fiber":0,"amount":"3 יח׳"}]
אם יש כמה פריטים — מערך עם כולם. רק JSON.`,
        messages: [{ role:"user", content:
          `תאור ארוחה: "${text}"
זהה את כל פריטי המזון וחשב ערכים תזונתיים לפי הכמות שצוינה.
אם לא צוינה כמות — השתמש במנה רגילה.
החזר JSON בלבד.` }]
      })
    });
    const data = await res.json();
    if (data.error) {
      console.error("Claude API error:", data.error);
      return null;
    }
    const r = (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("").trim();
    if (!r) return null;
    // Strip any markdown
    const clean = r.replace(/```[\w]*\n?/g,"").replace(/```/g,"").trim();
    // Try array
    const s=clean.indexOf("["),e=clean.lastIndexOf("]");
    if (s>=0&&e>s) {
      const p=JSON.parse(clean.slice(s,e+1));
      if (Array.isArray(p)&&p.length>0) return p;
    }
    // Try single object
    const s2=clean.indexOf("{"),e2=clean.lastIndexOf("}");
    if (s2>=0&&e2>s2) {
      const o=JSON.parse(clean.slice(s2,e2+1));
      if (o.calories!=null) return [o];
    }
  } catch(err) {
    console.error("parseNaturalFood error:", err);
  }
  return null;
};

const calcRecipeNutrition = async ings => {
  const r = await callClaude([{ role:"user", content:
    `ערכים תזונתיים לסך המרכיבים:\n${ings.map(i=>`- ${i.amount} ${i.unit} ${i.name}`).join("\n")}
החזר JSON בלבד: {"calories":N,"protein":N,"carbs":N,"fat":N,"fiber":N}` }],
  "", true, 400);
  try {
    const s=r.indexOf("{"), e=r.lastIndexOf("}");
    if (s>=0 && e>s) return JSON.parse(r.slice(s,e+1));
  } catch {}
  return null;
};

const sendToGCal = async (workout, profile) => {
  const wt = WORKOUT_TYPES[workout.type]||WORKOUT_TYPES.other;
  return callClaude([{ role:"user", content:
    `צור אירוע ב-Google Calendar:
כותרת: ${wt.icon} ${wt.label}${workout.notes?" — "+workout.notes:""}
תאריך: ${workout.date} | משך: ${workout.duration} דקות | קלוריות: ${workout.calories||"?"}
${workout.description?"פירוט: "+workout.description:""}
${workout.exercises?.length?"תרגילים: "+workout.exercises.map(e=>e.name).join(", "):""}
שעת התחלה: 06:00 אם לא צוין אחרת.` }],
  "", false, 800,
  [{ type:"url", url:"https://calendarmcp.googleapis.com/mcp/v1", name:"google-calendar" }]);
};

const chatCoach = async (messages, ctx) => callClaude(
  messages,
  `אתה "נוטרי" — מאמן תזונה ואימונים אישי בעברית. היה חם, ממוקד ומקצועי.
נתונים על המשתמש: ${JSON.stringify(ctx)}`,
  true, 900
);

const weeklyFeedback = async ctx => callClaude(
  [{ role:"user", content:"תן סיכום שבועי: ממוצע קלוריות, חלבון, שינוי משקל, אימונים, מה הלך טוב ומה לשפר. בעברית, קצר וחם." }],
  `מאמן תזונה ואימונים. נתוני שבוע: ${JSON.stringify(ctx)}`,
  false, 600
);

// Weekly text export (triggers browser download)
const exportWeeklyText = (foodLog, weightLog, fitnessLog, profile) => {
  const last7 = Array.from({length:7},(_,i)=>{ const d=new Date(); d.setDate(d.getDate()-i); return dateStr(d); }).reverse();
  let t = `📊 דוח שבועי — נוטרי\n${new Date().toLocaleDateString("he-IL",{year:"numeric",month:"long",day:"numeric"})}\nמשתמש: ${profile.name}\n\n`;
  t += "═══ תזונה ═══\n";
  let totCal=0,totPro=0,days=0;
  last7.forEach(k=>{
    const fs=foodLog[k]||[];
    if(!fs.length){t+=`${k}: —\n`;return;}
    days++;const s=sumFood(fs);totCal+=s.calories;totPro+=s.protein;
    t+=`\n${k} (${Math.round(s.calories)} קל׳ | ח:${Math.round(s.protein)}ג):\n`;
    fs.forEach(f=>t+=`  • ${f.name}${f.amount?" ("+f.amount+")":""} — ${Math.round(f.calories)} קל׳, ח:${Math.round(f.protein||0)}ג\n`);
  });
  t+=`\nממוצע: ${days>0?Math.round(totCal/days):"—"} קל׳/יום | חלבון: ${days>0?Math.round(totPro/days):"—"}ג/יום\n`;
  t+="\n═══ משקל ═══\n";
  const ww=weightLog.filter(w=>w.date>=last7[0]);
  if(ww.length){ww.forEach(w=>t+=`${w.date}: ${w.weight} ק"ג\n`);if(ww.length>1){const d=ww.at(-1).weight-ww[0].weight;t+=`שינוי: ${d>0?"+":""}${d.toFixed(1)} ק"ג\n`;}}
  else t+="אין נתוני משקל\n";
  t+="\n═══ אימונים ═══\n";let total=0;
  last7.forEach(k=>(fitnessLog[k]||[]).forEach(w=>{total++;t+=`${k}: ${WORKOUT_TYPES[w.type]?.label||w.type} — ${w.duration}דק׳, ${w.calories||"?"}קל׳${w.notes?" | "+w.notes:""}\n`;}));
  if(!total)t+="אין אימונים מתועדים\n";
  return t;
};

// ══ UI Primitives ══════════════════════════════════════════════════════

const Card = ({ children, style }) => (
  <div style={{ background:"#1A1D27", borderRadius:14, padding:18, border:"1px solid #2A2E42", ...style }}>
    {children}
  </div>
);

const SL = ({ children }) => (
  <div style={{ fontSize:10, fontWeight:700, color:"#4B5568", letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:10 }}>
    {children}
  </div>
);

const TI = ({ value, onChange, placeholder, type="text", onKeyDown, style, rows }) => rows
  ? <textarea value={value} onChange={onChange} placeholder={placeholder} onKeyDown={onKeyDown} rows={rows}
      style={{ background:"#0D1117", border:"1px solid #2A2E42", borderRadius:9, padding:"9px 13px",
        color:"#E2E8F0", fontSize:14, width:"100%", outline:"none", fontFamily:"inherit",
        direction:"rtl", boxSizing:"border-box", resize:"vertical", ...style }} />
  : <input value={value} onChange={onChange} placeholder={placeholder} type={type} onKeyDown={onKeyDown}
      style={{ background:"#0D1117", border:"1px solid #2A2E42", borderRadius:9, padding:"9px 13px",
        color:"#E2E8F0", fontSize:14, width:"100%", outline:"none", fontFamily:"inherit",
        direction:"rtl", boxSizing:"border-box", ...style }} />;

const Sel = ({ value, onChange, children, style }) => (
  <select value={value} onChange={onChange}
    style={{ background:"#0D1117", border:"1px solid #2A2E42", borderRadius:9, padding:"9px 13px",
      color:"#E2E8F0", fontSize:14, width:"100%", fontFamily:"inherit", direction:"rtl", outline:"none", ...style }}>
    {children}
  </select>
);

const Btn = ({ onClick, children, v="primary", disabled, style }) => {
  const vs = {
    primary:   { bg:"#4ADE80", fg:"#052010" },
    secondary: { bg:"#818CF8", fg:"#fff" },
    ghost:     { bg:"transparent", fg:"#94A3B8", border:"1px solid #2A2E42" },
    green:     { bg:"rgba(74,222,128,0.12)", fg:"#4ADE80", border:"1px solid rgba(74,222,128,0.25)" },
    amber:     { bg:"rgba(245,158,11,0.12)", fg:"#F59E0B", border:"1px solid rgba(245,158,11,0.25)" },
    blue:      { bg:"rgba(96,165,250,0.12)", fg:"#60A5FA", border:"1px solid rgba(96,165,250,0.25)" },
    purple:    { bg:"rgba(129,140,248,0.12)", fg:"#818CF8", border:"1px solid rgba(129,140,248,0.25)" },
    red:       { bg:"rgba(248,113,113,0.1)",  fg:"#F87171", border:"1px solid rgba(248,113,113,0.2)" },
  };
  const s = vs[v] || vs.primary;
  return (
    <button onClick={onClick} disabled={disabled}
      style={{ background:s.bg, color:s.fg, border:s.border||"none", borderRadius:9,
        padding:"9px 18px", cursor:disabled?"not-allowed":"pointer", fontSize:14,
        fontWeight:700, fontFamily:"inherit", opacity:disabled?0.45:1,
        transition:"opacity .2s", whiteSpace:"nowrap", ...style }}>
      {children}
    </button>
  );
};

// Horseshoe calorie arc
const CalArc = ({ consumed, goal }) => {
  const sz=188, sw=15, r=(sz-sw)/2, circ=2*Math.PI*r;
  const track=circ*0.75, pct=Math.min(consumed/Math.max(goal,1), 1.18);
  const fill=pct*track, over=consumed>goal;
  return (
    <div style={{ position:"relative", width:sz, height:sz, flexShrink:0 }}>
      <svg width={sz} height={sz} style={{ transform:"rotate(135deg)", display:"block" }}>
        <circle cx={sz/2} cy={sz/2} r={r} fill="none" stroke="#1C2035" strokeWidth={sw}
          strokeDasharray={`${track} ${circ}`} strokeLinecap="round"/>
        <circle cx={sz/2} cy={sz/2} r={r} fill="none" strokeWidth={sw} strokeLinecap="round"
          stroke={over?"#F87171":"#4ADE80"} strokeDasharray={`${fill} ${circ}`}
          style={{ transition:"stroke-dasharray .7s ease, stroke .3s" }}/>
      </svg>
      <div style={{ position:"absolute", top:"50%", left:"50%", transform:"translate(-50%,-50%)", textAlign:"center" }}>
        <div style={{ fontSize:34, fontWeight:800, color:over?"#F87171":"#F1F5F9", lineHeight:1 }}>{Math.round(consumed)}</div>
        <div style={{ fontSize:11, color:"#4B5568", marginTop:2 }}>מתוך {Math.round(goal)} קל׳</div>
        <div style={{ fontSize:13, fontWeight:700, color:over?"#F87171":"#4ADE80", marginTop:5 }}>
          {over ? `+${Math.round(consumed-goal)} עודף` : `נותר: ${Math.round(goal-consumed)}`}
        </div>
      </div>
    </div>
  );
};

// Small ring
const Ring = ({ value, max, color, label }) => {
  const sz=72, sw=6, r=(sz-sw)/2, circ=2*Math.PI*r;
  const fill=Math.min(value/Math.max(max,1),1)*circ;
  return (
    <div style={{ textAlign:"center" }}>
      <svg width={sz} height={sz} style={{ transform:"rotate(-90deg)" }}>
        <circle cx={sz/2} cy={sz/2} r={r} fill="none" stroke="#1C2035" strokeWidth={sw}/>
        <circle cx={sz/2} cy={sz/2} r={r} fill="none" stroke={color} strokeWidth={sw}
          strokeDasharray={`${fill} ${circ}`} strokeLinecap="round"
          style={{ transition:"stroke-dasharray .6s ease" }}/>
        <text x={sz/2} y={sz/2+5} textAnchor="middle" fill="#E2E8F0" fontSize="12" fontWeight="700"
          style={{ transform:`rotate(90deg)`, transformOrigin:`${sz/2}px ${sz/2}px` }}>
          {Math.round(value)}
        </text>
      </svg>
      <div style={{ fontSize:11, color:"#94A3B8", marginTop:2 }}>{label}</div>
      <div style={{ fontSize:10, color:"#374151" }}>/{Math.round(max)}ג׳</div>
    </div>
  );
};

// Progress bar row
const PBar = ({ label, v, max, color, unit }) => (
  <div>
    <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:"#94A3B8", marginBottom:4 }}>
      <span>{label}</span><span style={{ color }}>{Math.round(v)}/{Math.round(max)}{unit}</span>
    </div>
    <div style={{ background:"#0D1117", borderRadius:4, height:5, overflow:"hidden" }}>
      <div style={{ height:"100%", borderRadius:4, background:color, transition:"width .5s ease",
        width:`${Math.min(v/Math.max(max,1)*100, 100)}%` }}/>
    </div>
  </div>
);

// Water cups tracker (tap to add/remove)
const WaterBar = ({ cups, goal, onAdd, onRemove }) => (
  <div>
    <div style={{ display:"flex", flexWrap:"wrap", gap:5, marginBottom:8 }}>
      {Array.from({length: goal||8}).map((_,i) => (
        <div key={i} onClick={()=>i<cups?onRemove():onAdd()}
          style={{ width:36, height:42, borderRadius:8, cursor:"pointer",
            background:i<cups?"rgba(96,165,250,0.2)":"#0D1117",
            border:i<cups?"1px solid #60A5FA":"1px solid #2A2E42",
            display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:20, transition:"all .2s", userSelect:"none" }}>
          {i<cups ? "💧" : "·"}
        </div>
      ))}
    </div>
    <div style={{ fontSize:12, color:"#60A5FA" }}>{cups}/{goal||8} כוסות · {Math.round((cups/(goal||8))*100)}%</div>
  </div>
);

// Sub-tab switcher (e.g. log / templates / manual)
const SubTabs = ({ tabs, active, onSelect }) => (
  <div style={{ display:"flex", gap:3, background:"#111827", borderRadius:10, padding:4 }}>
    {tabs.map(([k,l]) => (
      <button key={k} onClick={()=>onSelect(k)}
        style={{ flex:1, background:active===k?"#1A1D27":"transparent",
          border:active===k?"1px solid #2A2E42":"none", borderRadius:8, padding:"7px 4px",
          cursor:"pointer", fontSize:12, fontWeight:700,
          color:active===k?"#E2E8F0":"#4B5568", fontFamily:"inherit", transition:"all .2s" }}>
        {l}
      </button>
    ))}
  </div>
);

// Shared date-navigation bar
const DateNav = ({ viewDate, setViewDate }) => {
  const isToday = viewDate === TODAY();
  const prev = () => { const d=new Date(viewDate+"T12:00:00"); d.setDate(d.getDate()-1); setViewDate(dateStr(d)); };
  const next = () => { const d=new Date(viewDate+"T12:00:00"); d.setDate(d.getDate()+1); if(d<=new Date()) setViewDate(dateStr(d)); };
  return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
      <button onClick={prev} style={{ background:"#1A1D27", border:"1px solid #2A2E42", borderRadius:8, padding:"8px 18px", color:"#94A3B8", cursor:"pointer", fontSize:18, minWidth:48 }}>‹</button>
      <div style={{ textAlign:"center" }}>
        <div style={{ fontWeight:700, fontSize:15, color:"#E2E8F0" }}>
          {isToday ? "היום" : new Date(viewDate+"T12:00:00").toLocaleDateString("he-IL",{weekday:"long",day:"numeric",month:"long"})}
        </div>
        <div style={{ fontSize:11, color:"#374151" }}>{viewDate}</div>
      </div>
      <button onClick={next} disabled={isToday}
        style={{ background:"#1A1D27", border:"1px solid #2A2E42", borderRadius:8, padding:"8px 18px", color:isToday?"#2A2E42":"#94A3B8", cursor:isToday?"default":"pointer", fontSize:18, minWidth:48 }}>›</button>
    </div>
  );
};

// ══ Dashboard ══════════════════════════════════════════════════════════
function Dashboard({ profile, goals, foodLog, weightLog, waterLog, fitnessLog, stepsLog, setWaterLog }) {
  const today    = TODAY();
  const tFoods   = foodLog[today] || [];
  const tot      = sumFood(tFoods);
  const lw       = weightLog.at(-1)?.weight ?? profile.weight;
  const b        = calcBMI(lw, profile.height);
  const bi       = bmiInfo(b);
  const myTDEE   = calcTDEE({...profile, weight:lw});
  const h        = new Date().getHours();
  const greet    = h<12?"בוקר טוב":h<17?"צהריים טובים":"ערב טוב";
  const streak   = calcStreak(foodLog);
  const tWater   = waterLog[today] || 0;
  const tSteps   = stepsLog[today] || 0;

  // Dynamic goals: base TDEE + today's workout calories
  const eGoals      = effectiveGoals(goals, fitnessLog, today);
  const workoutBonus = eGoals._workoutBonus || 0;
  const netCal      = tot.calories - workoutBonus; // net = eaten minus burned

  const chartData = weightLog.slice(-14).map(w=>({ date:w.date.slice(5), weight:w.weight }));

  const last7k     = Array.from({length:7},(_,i)=>{ const d=new Date(); d.setDate(d.getDate()-i); return dateStr(d); }).reverse();
  const wkFoods    = last7k.flatMap(k=>foodLog[k]||[]);
  const daysData   = last7k.filter(k=>(foodLog[k]||[]).length>0).length;
  const wkAvgCal   = daysData>0 ? Math.round(sumFood(wkFoods).calories/daysData) : 0;
  const wkAvgPro   = daysData>0 ? Math.round(sumFood(wkFoods).protein/daysData)  : 0;
  const wkWorkouts = last7k.reduce((s,k)=>s+(fitnessLog[k]?.length||0),0);

  // Weight trend: compare last 7 days avg vs prior 7 days avg
  const avgW = arr => arr.length ? +(arr.reduce((s,w)=>s+w.weight,0)/arr.length).toFixed(2) : null;
  const r7   = weightLog.slice(-7), r14 = weightLog.slice(-14,-7);
  const weeklyDelta = avgW(r7)&&avgW(r14) ? +(avgW(r7)-avgW(r14)).toFixed(2) : null;

  const [feedback, setFeedback] = useState("");
  const [fbLoading, setFbLoading] = useState(false);

  const addWater = () => { const u={...waterLog,[today]:tWater+1}; setWaterLog(u); db.set("nt_waterLog",u); };
  const remWater = () => { if(tWater<1)return; const u={...waterLog,[today]:tWater-1}; setWaterLog(u); db.set("nt_waterLog",u); };

  const getFeedback = async () => {
    setFbLoading(true);
    const ctx = { profile, goals, weeklyAvgCal:wkAvgCal, weeklyAvgProtein:wkAvgPro,
      daysTracked:daysData, weight:lw, goalWeight:profile.goalWeight, bmi:b,
      weightTrend:weightLog.slice(-7), workoutsThisWeek:wkWorkouts, streak,
      todayWorkoutBonus:workoutBonus, todayNetCal:netCal };
    const r = await weeklyFeedback(ctx);
    setFeedback(r);
    setFbLoading(false);
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>

      {/* ── Sunday weekly review banner ── */}
      {new Date().getDay() === 0 && daysData > 0 && (
        <div style={{background:"linear-gradient(135deg,rgba(129,140,248,0.15),rgba(74,222,128,0.1))",border:"1px solid rgba(129,140,248,0.3)",borderRadius:12,padding:"14px 16px"}}>
          <div style={{fontWeight:700,fontSize:15,color:"#E2E8F0",marginBottom:4}}>📊 ניתוח שבועי — יום ראשון</div>
          <div style={{fontSize:13,color:"#94A3B8",lineHeight:1.7}}>
            עקבת אחרי {daysData}/7 ימים השבוע · ממוצע {wkAvgCal} קל׳/יום · {wkWorkouts} אימונים
          </div>
          <Btn v="purple" onClick={getFeedback} disabled={fbLoading} style={{marginTop:10,fontSize:13,padding:"8px 16px"}}>
            {fbLoading?"⏳ מנתח...":"🌿 קבל פידבק שבועי מנוטרי"}
          </Btn>
        </div>
      )}

      {/* Header: greeting + streak + BMI */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", flexWrap:"wrap", gap:10 }}>
        <div>
          <div style={{ fontSize:22, fontWeight:800, letterSpacing:"-0.5px" }}>{greet}, {profile.name} 👋</div>
          <div style={{ fontSize:13, color:"#64748B", marginTop:4 }}>
            TDEE: {myTDEE} קל׳ · יעד: {profile.goalWeight}ק"ג
            {weeklyDelta !== null && (
              <span style={{marginRight:10, color:weeklyDelta<0?"#4ADE80":weeklyDelta>0?"#F87171":"#4B5568", fontWeight:700}}>
                {weeklyDelta<0?" ↓":"↑ "}{Math.abs(weeklyDelta)}ק"ג שבוע
              </span>
            )}
          </div>
          <div style={{ marginTop:8 }}>
            <div style={{ display:"inline-flex", alignItems:"center", gap:6, background:"rgba(245,158,11,0.1)", border:"1px solid rgba(245,158,11,0.2)", borderRadius:20, padding:"5px 12px" }}>
              <span style={{ fontSize:16 }}>🔥</span>
              <span style={{ fontSize:15, fontWeight:800, color:"#F59E0B" }}>{streak}</span>
              <span style={{ fontSize:11, color:"#92400E" }}>ימים רצוף</span>
            </div>
          </div>
        </div>
        <div style={{ textAlign:"center", background:"#1A1D27", borderRadius:12, padding:"10px 16px", border:"1px solid #2A2E42" }}>
          <div style={{ fontSize:10, color:"#4B5568", fontWeight:700, textTransform:"uppercase", letterSpacing:".08em" }}>BMI</div>
          <div style={{ fontSize:22, fontWeight:800, color:bi.color, lineHeight:1 }}>{b??"-"}</div>
          <div style={{ fontSize:11, color:bi.color }}>{bi.label}</div>
        </div>
      </div>

      {/* Water tracking */}
      <Card>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
          <SL>💧 שתייה יומית</SL>
          <div style={{ display:"flex", gap:6 }}>
            <Btn v="ghost" onClick={remWater} style={{ padding:"4px 12px", fontSize:18, minWidth:44 }}>−</Btn>
            <Btn v="blue"  onClick={addWater} style={{ padding:"4px 14px", fontSize:13 }}>+ כוס</Btn>
          </div>
        </div>
        <WaterBar cups={tWater} goal={goals.water||8} onAdd={addWater} onRemove={remWater}/>
      </Card>

      {/* Steps overview */}
      <Card style={{padding:"12px 18px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <SL>👟 צעדים היום</SL>
            <div style={{display:"flex",alignItems:"baseline",gap:6}}>
              <span style={{fontSize:28,fontWeight:800,color:"#4ADE80"}}>{tSteps.toLocaleString()}</span>
              <span style={{fontSize:12,color:"#4B5568"}}>/10,000</span>
              {tSteps>=10000 && <span>🎉</span>}
            </div>
          </div>
          <div style={{textAlign:"left"}}>
            <div style={{fontSize:11,color:"#4B5568",marginBottom:4}}>{Math.round(tSteps/10000*100)}%</div>
            <svg width={52} height={52} style={{transform:"rotate(-90deg)"}}>
              <circle cx={26} cy={26} r={22} fill="none" stroke="#1C2035" strokeWidth={5}/>
              <circle cx={26} cy={26} r={22} fill="none" stroke="#4ADE80" strokeWidth={5}
                strokeLinecap="round" strokeDasharray={`${Math.min(tSteps/10000,1)*138} 138`}
                style={{transition:"stroke-dasharray .5s"}}/>
            </svg>
          </div>
        </div>
        <div style={{marginTop:6,background:"#0D1117",borderRadius:4,height:4,overflow:"hidden"}}>
          <div style={{height:"100%",borderRadius:4,background:"linear-gradient(90deg,#4ADE80,#60A5FA)",width:`${Math.min(tSteps/10000*100,100)}%`,transition:"width .5s"}}/>
        </div>
      </Card>

      {/* Arc + rings — uses effective goal (TDEE + workout bonus) */}
      <Card>
        {workoutBonus > 0 && (
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,background:"rgba(248,113,113,0.08)",borderRadius:9,padding:"7px 12px"}}>
            <span style={{fontSize:12,color:"#94A3B8"}}>🔥 שרפת היום: <strong style={{color:"#F87171"}}>{workoutBonus} קל׳</strong></span>
            <span style={{fontSize:12,color:"#4ADE80",fontWeight:700}}>יעד מעודכן: {eGoals.calories} קל׳</span>
          </div>
        )}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-around", flexWrap:"wrap", gap:14 }}>
          <CalArc consumed={tot.calories} goal={eGoals.calories}/>
          <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
            <div style={{ display:"flex", gap:16 }}>
              <Ring value={tot.protein} max={eGoals.protein} color="#818CF8" label="חלבון"/>
              <Ring value={tot.carbs}   max={eGoals.carbs}   color="#F59E0B" label="פחמימות"/>
            </div>
            <div style={{ display:"flex", gap:16 }}>
              <Ring value={tot.fat}   max={eGoals.fat}   color="#F87171" label="שומן"/>
              <Ring value={tot.fiber} max={eGoals.fiber} color="#34D399" label="סיבים"/>
            </div>
          </div>
        </div>
        <div style={{ marginTop:16, display:"flex", flexDirection:"column", gap:8 }}>
          <PBar label="קלוריות" v={tot.calories} max={eGoals.calories} color="#4ADE80" unit=" קל׳"/>
          <PBar label="חלבון"   v={tot.protein}  max={eGoals.protein}  color="#818CF8" unit="ג׳"/>
          <PBar label="פחמימות" v={tot.carbs}    max={eGoals.carbs}    color="#F59E0B" unit="ג׳"/>
          <PBar label="שומן"    v={tot.fat}      max={eGoals.fat}      color="#F87171" unit="ג׳"/>
        </div>
        {/* Net calories row */}
        <div style={{marginTop:12,background:"#0D1117",borderRadius:8,padding:"10px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
          <span style={{fontSize:12,color:"#4B5568"}}>מאזן נטו היום</span>
          <div style={{display:"flex",gap:16,fontSize:13}}>
            <span>נאכל: <strong style={{color:"#E2E8F0"}}>{Math.round(tot.calories)}</strong></span>
            {workoutBonus>0 && <span>נשרף: <strong style={{color:"#F87171"}}>{workoutBonus}</strong></span>}
            <span>נטו: <strong style={{color:netCal>eGoals.calories?"#F87171":netCal<eGoals.calories*0.8?"#60A5FA":"#4ADE80"}}>{Math.round(netCal)}</strong></span>
          </div>
        </div>
      </Card>

      {/* Weight chart */}
      {chartData.length > 1 && (
        <Card>
          <SL>מגמת משקל — 14 ימים</SL>
          <ResponsiveContainer width="100%" height={130}>
            <LineChart data={chartData} margin={{top:4,right:4,bottom:0,left:0}}>
              <XAxis dataKey="date" tick={{fill:"#4B5568",fontSize:10}} tickLine={false}/>
              <YAxis domain={["auto","auto"]} tick={{fill:"#4B5568",fontSize:10}} width={36} tickLine={false}/>
              <Tooltip contentStyle={{background:"#1A1D27",border:"1px solid #2A2E42",borderRadius:8,color:"#E2E8F0",fontSize:12}}/>
              <ReferenceLine y={profile.goalWeight} stroke="#818CF8" strokeDasharray="4 4"/>
              <Line type="monotone" dataKey="weight" stroke="#4ADE80" strokeWidth={2} dot={{fill:"#4ADE80",r:3}} activeDot={{r:5}}/>
            </LineChart>
          </ResponsiveContainer>
          <div style={{ fontSize:11, color:"#4B5568", marginTop:6, display:"flex", alignItems:"center", gap:5 }}>
            <span style={{ display:"inline-block", width:18, height:2, background:"#818CF8", verticalAlign:"middle" }}/>
            יעד {profile.goalWeight}ק"ג
          </div>
        </Card>
      )}

      {/* ── WEEKLY SUMMARY — prominent button ── */}
      <div style={{display:"flex",gap:8}}>
        <Btn onClick={getFeedback} disabled={fbLoading}
          style={{flex:1,padding:"11px",fontSize:14,background:"linear-gradient(135deg,rgba(129,140,248,0.2),rgba(74,222,128,0.15))",border:"1px solid rgba(129,140,248,0.35)",color:"#E2E8F0"}}>
          {fbLoading ? "⏳ מנתח נתוני שבוע..." : "📊 סיכום שבועי מנוטרי"}
        </Btn>
      </div>

      {/* Week stats strip */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
        {[
          {label:"קל׳ ממוצע",   val:wkAvgCal||"—",              color:"#4ADE80"},
          {label:"חלבון ממוצע", val:wkAvgPro?wkAvgPro+"ג":"—",  color:"#818CF8"},
          {label:"ימי מעקב",    val:`${daysData}/7`,             color:"#F59E0B"},
          {label:"אימונים",     val:wkWorkouts,                  color:"#60A5FA"},
        ].map(({label,val,color})=>(
          <div key={label} style={{background:"#1A1D27",borderRadius:10,padding:"10px 6px",textAlign:"center",border:"1px solid #2A2E42"}}>
            <div style={{fontSize:17,fontWeight:800,color}}>{val}</div>
            <div style={{fontSize:10,color:"#4B5568",marginTop:3}}>{label}</div>
          </div>
        ))}
      </div>

      {feedback && (
        <div style={{background:"#1A1D27",borderRadius:12,padding:16,fontSize:13,lineHeight:1.8,color:"#CBD5E1",whiteSpace:"pre-line",border:"1px solid rgba(129,140,248,0.2)",borderRight:"3px solid #818CF8"}}>
          <div style={{color:"#818CF8",fontWeight:700,fontSize:11,marginBottom:8}}>🌿 סיכום שבועי — נוטרי</div>
          {feedback}
        </div>
      )}

      {/* Today's foods */}
      {tFoods.length > 0 && (
        <Card>
          <SL>ארוחות היום ({tFoods.length})</SL>
          {tFoods.slice(-8).map(f => (
            <div key={f.id} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:"1px solid #1C2035",fontSize:13}}>
              <span style={{color:"#CBD5E1"}}>{f.name}{f.amount && <span style={{color:"#374151",fontSize:11}}> · {f.amount}</span>}</span>
              <span style={{color:"#4B5568",whiteSpace:"nowrap",marginRight:8}}>{Math.round(f.calories)}קל׳ · ח:{Math.round(f.protein||0)}ג</span>
            </div>
          ))}
          {tFoods.length>8 && <div style={{fontSize:11,color:"#374151",marginTop:8,textAlign:"center"}}>ועוד {tFoods.length-8} פריטים — עבור ליומן אוכל</div>}
        </Card>
      )}
    </div>
  );
}

// ══ Food Log ═══════════════════════════════════════════════════════════
function FoodLog({ foodLog, setFoodLog, goals, templates, setTemplates, fitnessLog, myFoods, setMyFoods }) {
  const [viewDate, setViewDate]     = useState(TODAY());
  const [input, setInput]           = useState("");
  const [loading, setLoading]       = useState(false);
  const [pendingItems, setPending]  = useState([]);
  const [error, setError]           = useState("");
  const [subview, setSubview]       = useState("log"); // log | myfoods | templates | manual
  const [mf, setMf]                 = useState({name:"",calories:0,protein:0,carbs:0,fat:0,fiber:0,amount:""});
  const [templName, setTemplName]   = useState("");
  // My Foods state
  const [quickAmt,  setQuickAmt]    = useState({}); // {foodId: amount string}
  const [addingMyFood, setAddingMyFood] = useState(false);
  const [newMF, setNewMF]           = useState({name:"",per:100,unit:"ג",calories:0,protein:0,carbs:0,fat:0,fiber:0});

  const foods   = foodLog[viewDate] || [];
  const totals  = sumFood(foods);
  const eGoals  = effectiveGoals(goals, fitnessLog||{}, viewDate);
  const wBonus  = eGoals._workoutBonus || 0;

  // Scale a saved food by entered amount
  const scaleMyFood = (food, amount) => {
    const ratio = parseFloat(amount) / (food.per || 100);
    return {
      id: Date.now(), name: food.name, amount: `${amount}${food.unit}`,
      calories: Math.round(food.calories * ratio),
      protein:  +(food.protein  * ratio).toFixed(1),
      carbs:    +(food.carbs    * ratio).toFixed(1),
      fat:      +(food.fat      * ratio).toFixed(1),
      fiber:    +(food.fiber    * ratio).toFixed(1),
    };
  };

  const addFromMyFoods = (food) => {
    const amt = quickAmt[food.id] || String(food.per);
    if (!parseFloat(amt)) return;
    const entry = scaleMyFood(food, amt);
    const upd = {...foodLog, [viewDate]:[...(foodLog[viewDate]||[]), entry]};
    setFoodLog(upd); db.set("nt_foodLog", upd);
    setQuickAmt(q=>({...q,[food.id]:""})); // reset amount
  };

  const saveMyFood = () => {
    if (!newMF.name.trim() || !newMF.calories) return;
    const f = {...newMF, id:Date.now()};
    const upd = [...myFoods, f]; setMyFoods(upd); db.set("nt_myFoods", upd);
    setNewMF({name:"",per:100,unit:"ג",calories:0,protein:0,carbs:0,fat:0,fiber:0});
    setAddingMyFood(false);
  };
  const deleteMyFood = id => {
    const upd = myFoods.filter(f=>f.id!==id); setMyFoods(upd); db.set("nt_myFoods", upd);
  };

  // Natural text → parse multiple items
  const doLookup = async () => {
    if (!input.trim() || loading) return;
    setLoading(true); setError(""); setPending([]);
    try {
      const items = await parseNaturalFood(input);
      if (items && items.length > 0) {
        setPending(items.map((item,i) => ({
          ...item, id:Date.now()+i, _scale:1,
          _oc:item.calories||0, _op:item.protein||0,
          _ocarbs:item.carbs||0, _of:item.fat||0, _ofib:item.fiber||0,
        })));
      } else {
        setError("לא הצלחתי לזהות — נסה לפרט יותר (לדוגמה: '200 גרם חזה עוף מבושל') או השתמש בהזנה ידנית.");
      }
    } catch(e) {
      setError("שגיאת חיבור — בדוק אינטרנט ונסה שוב.");
    }
    setLoading(false);
  };

  // Scale a pending item (×0.5, ×1, ×2 etc.)
  const updateScale = (id, scale) => setPending(prev => prev.map(item => item.id!==id ? item : {
    ...item, _scale:scale,
    calories: Math.round(item._oc*scale),
    protein:  +(item._op*scale).toFixed(1),
    carbs:    +(item._ocarbs*scale).toFixed(1),
    fat:      +(item._of*scale).toFixed(1),
    fiber:    +(item._ofib*scale).toFixed(1),
  }));

  const confirmItems = () => {
    const toAdd = pendingItems.map(({_scale,_oc,_op,_ocarbs,_of,_ofib,...item})=>item);
    const upd = {...foodLog, [viewDate]:[...(foodLog[viewDate]||[]), ...toAdd]};
    setFoodLog(upd); db.set("nt_foodLog", upd);
    setPending([]); setInput("");
  };
  const removePending = id => setPending(p => p.filter(x=>x.id!==id));

  const addManual = () => {
    const upd = {...foodLog, [viewDate]:[...(foodLog[viewDate]||[]), {...mf, id:Date.now()}]};
    setFoodLog(upd); db.set("nt_foodLog", upd);
    setMf({name:"",calories:0,protein:0,carbs:0,fat:0,fiber:0,amount:""});
    setSubview("log");
  };
  const removeFood = id => {
    const upd = {...foodLog, [viewDate]:foods.filter(f=>f.id!==id)};
    setFoodLog(upd); db.set("nt_foodLog", upd);
  };

  // Templates
  const saveTemplate = () => {
    if (!templName.trim() || !foods.length) return;
    const t = { id:Date.now(), name:templName.trim(), foods:foods.map(({id,...f})=>f) };
    const upd = [...templates, t]; setTemplates(upd); db.set("nt_templates", upd);
    setTemplName("");
  };
  const applyTemplate = t => {
    const toAdd = t.foods.map(f=>({...f, id:Date.now()+Math.random()}));
    const upd = {...foodLog, [viewDate]:[...(foodLog[viewDate]||[]), ...toAdd]};
    setFoodLog(upd); db.set("nt_foodLog", upd);
  };
  const deleteTemplate = id => {
    const upd = templates.filter(t=>t.id!==id); setTemplates(upd); db.set("nt_templates", upd);
  };

  return (
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <DateNav viewDate={viewDate} setViewDate={setViewDate}/>
      <SubTabs tabs={[["log","🍽️ יומן"],["myfoods","⭐ שלי"],["templates","📋 תבניות"],["manual","✏️ ידני"]]} active={subview} onSelect={setSubview}/>

      {/* ── LOG VIEW ── */}
      {subview==="log" && <>
        <Card>
          <SL>הוסף אוכל — מלל חופשי</SL>
          <div style={{fontSize:12,color:"#4B5568",marginBottom:8}}>
            דוגמאות: "200ג חזה עוף", "שתי ביצים עם גבינה ולחם", "קערת אורז עם טונה"
          </div>
          <div style={{display:"flex",gap:8}}>
            <TI value={input} onChange={e=>setInput(e.target.value)}
              placeholder="מה אכלת? (כמויות בגרמים, יחידות...)"
              onKeyDown={e=>e.key==="Enter"&&doLookup()} style={{flex:1}}/>
            <Btn onClick={doLookup} disabled={loading} style={{minWidth:72}}>{loading?"⏳ מחפש...":"חפש 🔍"}</Btn>
          </div>

          {error && (
            <div style={{marginTop:10,background:"rgba(248,113,113,0.07)",borderRadius:8,padding:"10px 12px",fontSize:13}}>
              <div style={{color:"#F87171",marginBottom:6}}>{error}</div>
              <Btn v="ghost" onClick={()=>{setError(""); setSubview("manual");}}
                style={{fontSize:11,padding:"4px 10px"}}>✏️ עבור להזנה ידנית</Btn>
            </div>
          )}

          {pendingItems.length > 0 && (
            <div style={{marginTop:14}}>
              <div style={{fontSize:12,color:"#4ADE80",fontWeight:700,marginBottom:10}}>
                ✓ זוהו {pendingItems.length} פריטים — עדכן כמות אם צריך:
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {pendingItems.map(item => (
                  <div key={item.id} style={{background:"#0D1117",borderRadius:10,padding:12,border:"1px solid rgba(74,222,128,0.2)"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                      <div>
                        <div style={{fontWeight:700,fontSize:14,color:"#E2E8F0"}}>{item.name}</div>
                        <div style={{fontSize:11,color:"#4B5568"}}>{item.amount}</div>
                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <span style={{fontSize:22,fontWeight:800,color:"#4ADE80"}}>{Math.round(item.calories)}</span>
                        <span style={{fontSize:11,color:"#4B5568"}}>קל׳</span>
                        <button onClick={()=>removePending(item.id)} style={{background:"none",border:"none",cursor:"pointer",color:"#F87171",fontSize:18,padding:"2px 4px",lineHeight:1}}>×</button>
                      </div>
                    </div>
                    <div style={{display:"flex",gap:10,marginBottom:10,fontSize:12,flexWrap:"wrap"}}>
                      {[["ח",item.protein,"#818CF8"],["פ",item.carbs,"#F59E0B"],["ש",item.fat,"#F87171"],["סיבים",item.fiber,"#34D399"]].map(([l,v,c])=>(
                        <span key={l} style={{color:c,fontWeight:700}}>{l}: {Math.round(v||0)}ג</span>
                      ))}
                    </div>
                    {/* Scale buttons — mobile friendly */}
                    <div style={{display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
                      <span style={{fontSize:11,color:"#4B5568",marginLeft:4}}>כמות:</span>
                      {[0.5,1,1.5,2,2.5,3].map(s=>(
                        <button key={s} onClick={()=>updateScale(item.id,s)}
                          style={{background:item._scale===s?"rgba(74,222,128,0.2)":"#1A1D27",
                            border:item._scale===s?"1px solid #4ADE80":"1px solid #2A2E42",
                            borderRadius:6,padding:"4px 9px",cursor:"pointer",
                            fontSize:12,color:item._scale===s?"#4ADE80":"#94A3B8",fontFamily:"inherit",minWidth:36}}>
                          {s}×
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{display:"flex",gap:8,marginTop:12}}>
                <Btn onClick={confirmItems}>הוסף לליומן ✓</Btn>
                <Btn v="ghost" onClick={()=>{setPending([]);setInput("");}}>בטל</Btn>
              </div>
            </div>
          )}
        </Card>

        {/* Day totals — uses effective goal */}
        <Card>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <SL>סיכום יומי</SL>
            {wBonus>0 && (
              <span style={{fontSize:11,color:"#F87171",background:"rgba(248,113,113,0.1)",padding:"3px 8px",borderRadius:12}}>
                🔥 +{wBonus} קל׳ מאימון
              </span>
            )}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8}}>
            {[{l:"קל׳",v:totals.calories,m:eGoals.calories,c:"#4ADE80"},{l:"חלבון",v:totals.protein,m:eGoals.protein,c:"#818CF8"},{l:"פחמימות",v:totals.carbs,m:eGoals.carbs,c:"#F59E0B"},{l:"שומן",v:totals.fat,m:eGoals.fat,c:"#F87171"},{l:"סיבים",v:totals.fiber,m:eGoals.fiber,c:"#34D399"}].map(({l,v,m,c})=>(
              <div key={l} style={{background:"#0D1117",borderRadius:10,padding:"10px 4px",textAlign:"center"}}>
                <div style={{fontSize:17,fontWeight:800,color:c}}>{Math.round(v)}</div>
                <div style={{fontSize:10,color:"#4B5568",marginTop:2}}>{l}</div>
                <div style={{fontSize:9,color:v>m?"#F87171":v>m*.85?"#F59E0B":"#374151",marginTop:2}}>
                  {Math.round(m-v)>0?`נותר ${Math.round(m-v)}`:`+${Math.round(v-m)}`}
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Food list + save-as-template */}
        <Card>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10,flexWrap:"wrap",gap:8}}>
            <SL>ארוחות ({foods.length})</SL>
            {foods.length > 0 && (
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                <TI value={templName} onChange={e=>setTemplName(e.target.value)} placeholder="שם תבנית..."
                  style={{width:120,fontSize:12,padding:"5px 10px"}}/>
                <Btn v="amber" onClick={saveTemplate} disabled={!templName.trim()}
                  style={{fontSize:11,padding:"5px 10px"}}>💾 שמור</Btn>
              </div>
            )}
          </div>
          {foods.length===0
            ? <div style={{color:"#374151",textAlign:"center",padding:"22px 0",fontSize:14}}>
                {viewDate===TODAY()?"עדיין לא הוספת ארוחות היום 🍽️":"אין נתונים ליום זה"}
              </div>
            : <div style={{display:"flex",flexDirection:"column",gap:4}}>
                {foods.map(f=>(
                  <div key={f.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 11px",borderRadius:9,background:"#0D1117"}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:14,fontWeight:600,color:"#E2E8F0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f.name}</div>
                      <div style={{fontSize:11,color:"#4B5568",marginTop:2}}>{f.amount?f.amount+" · ":""}ח:{Math.round(f.protein||0)} פ:{Math.round(f.carbs||0)} ש:{Math.round(f.fat||0)}</div>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:10,marginRight:8}}>
                      <span style={{fontWeight:800,fontSize:15,color:"#4ADE80"}}>{Math.round(f.calories)}</span>
                      <button onClick={()=>removeFood(f.id)} style={{background:"none",border:"none",cursor:"pointer",color:"#374151",fontSize:18,padding:"4px 6px",minWidth:32,lineHeight:1}}>×</button>
                    </div>
                  </div>
                ))}
              </div>
          }
        </Card>
      </>}

      {/* ── MY FOODS VIEW ── */}
      {subview==="myfoods" && (
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {/* Saved foods list */}
          {myFoods.length===0 && !addingMyFood && (
            <Card>
              <div style={{textAlign:"center",color:"#374151",padding:"20px 0",fontSize:14}}>
                עדיין אין מוצרים שמורים.<br/>
                <span style={{fontSize:12,display:"block",marginTop:6,color:"#4B5568"}}>הוסף מוצרים שאתה אוכל בדרך כלל עם הנתונים המדויקים שלהם.</span>
              </div>
            </Card>
          )}
          {myFoods.map(food => (
            <Card key={food.id} style={{padding:"12px 14px"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                <div>
                  <div style={{fontWeight:700,fontSize:14,color:"#E2E8F0"}}>{food.name}</div>
                  <div style={{fontSize:11,color:"#4B5568",marginTop:2}}>
                    ל-{food.per}{food.unit}: {food.calories}קל׳ · ח:{food.protein}ג · פ:{food.carbs}ג · ש:{food.fat}ג
                  </div>
                </div>
                <button onClick={()=>deleteMyFood(food.id)} style={{background:"none",border:"none",cursor:"pointer",color:"#374151",fontSize:18,padding:"2px 4px",lineHeight:1}}>×</button>
              </div>
              {/* Quick-add row */}
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                <TI value={quickAmt[food.id]??""} type="number"
                  placeholder={`${food.per} (${food.unit})`}
                  onChange={e=>setQuickAmt(q=>({...q,[food.id]:e.target.value}))}
                  onKeyDown={e=>e.key==="Enter"&&addFromMyFoods(food)}
                  style={{flex:1,fontSize:13,padding:"6px 10px"}}/>
                <span style={{fontSize:11,color:"#4B5568"}}>{food.unit}</span>
                <Btn v="green" onClick={()=>addFromMyFoods(food)} style={{fontSize:12,padding:"6px 14px"}}>+ הוסף</Btn>
              </div>
              {/* Preview scaled values */}
              {quickAmt[food.id] && parseFloat(quickAmt[food.id]) > 0 && (() => {
                const ratio = parseFloat(quickAmt[food.id]) / food.per;
                return (
                  <div style={{fontSize:11,color:"#4ADE80",marginTop:6}}>
                    → {Math.round(food.calories*ratio)} קל׳ · ח:{+(food.protein*ratio).toFixed(1)}ג · פ:{+(food.carbs*ratio).toFixed(1)}ג
                  </div>
                );
              })()}
            </Card>
          ))}

          {/* Add new food form */}
          {addingMyFood ? (
            <Card>
              <SL>מוצר חדש</SL>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                <div>
                  <div style={{fontSize:12,color:"#94A3B8",marginBottom:5}}>שם המוצר</div>
                  <TI value={newMF.name} placeholder="לדוגמה: חזה עוף מבושל" onChange={e=>setNewMF({...newMF,name:e.target.value})}/>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                  <div>
                    <div style={{fontSize:12,color:"#4B5568",marginBottom:5}}>כמות בסיס</div>
                    <TI value={newMF.per} type="number" placeholder="100" onChange={e=>setNewMF({...newMF,per:+e.target.value})}/>
                  </div>
                  <div>
                    <div style={{fontSize:12,color:"#4B5568",marginBottom:5}}>יחידה</div>
                    <select value={newMF.unit} onChange={e=>setNewMF({...newMF,unit:e.target.value})}
                      style={{background:"#0D1117",border:"1px solid #2A2E42",borderRadius:9,padding:"9px 13px",color:"#E2E8F0",fontSize:14,width:"100%",fontFamily:"inherit",direction:"rtl",outline:"none"}}>
                      {["ג","מ\"ל","יח׳","כוס","כף"].map(u=><option key={u} value={u}>{u}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                  {[{k:"calories",l:"קלוריות",c:"#4ADE80"},{k:"protein",l:"חלבון (ג׳)",c:"#818CF8"},{k:"carbs",l:"פחמימות (ג׳)",c:"#F59E0B"},{k:"fat",l:"שומן (ג׳)",c:"#F87171"},{k:"fiber",l:"סיבים (ג׳)",c:"#34D399"}].map(({k,l,c})=>(
                    <div key={k}>
                      <div style={{fontSize:12,color:c,marginBottom:5}}>{l}</div>
                      <TI value={newMF[k]||""} type="number" placeholder="0" onChange={e=>setNewMF({...newMF,[k]:+e.target.value})}/>
                    </div>
                  ))}
                </div>
                <div style={{fontSize:11,color:"#374151"}}>
                  הזן ערכים ל-{newMF.per||100}{newMF.unit} — האפליקציה תחשב אוטומטי לכמות שתזין.
                </div>
                <div style={{display:"flex",gap:8}}>
                  <Btn onClick={saveMyFood}>שמור מוצר ⭐</Btn>
                  <Btn v="ghost" onClick={()=>setAddingMyFood(false)}>בטל</Btn>
                </div>
              </div>
            </Card>
          ) : (
            <Btn onClick={()=>setAddingMyFood(true)} style={{padding:"12px",width:"100%"}}>+ הוסף מוצר שלי</Btn>
          )}
        </div>
      )}

      {/* ── TEMPLATES VIEW ── */}
      {subview==="templates" && (
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          {templates.length===0
            ? <Card><div style={{textAlign:"center",color:"#374151",padding:"20px 0",fontSize:14}}>
                אין תבניות שמורות.<br/>
                <span style={{fontSize:12,display:"block",marginTop:6}}>שמור את ארוחות היום כתבנית מלשונית יומן.</span>
              </div></Card>
            : templates.map(t=>(
              <Card key={t.id}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                  <div>
                    <div style={{fontWeight:700,fontSize:15,color:"#E2E8F0"}}>{t.name}</div>
                    <div style={{fontSize:12,color:"#4B5568",marginTop:2}}>{t.foods.length} פריטים · {Math.round(sumFood(t.foods).calories)} קל׳ · ח:{Math.round(sumFood(t.foods).protein)}ג</div>
                  </div>
                  <div style={{display:"flex",gap:6}}>
                    <Btn v="green" onClick={()=>applyTemplate(t)} style={{fontSize:12,padding:"6px 12px"}}>הוסף לאוכל</Btn>
                    <Btn v="red"   onClick={()=>deleteTemplate(t.id)} style={{fontSize:12,padding:"6px 10px",minWidth:36}}>×</Btn>
                  </div>
                </div>
                {t.foods.slice(0,5).map((f,i)=>(
                  <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#64748B",padding:"3px 0",borderBottom:"1px solid #1C2035"}}>
                    <span>{f.name}</span><span>{Math.round(f.calories)} קל׳</span>
                  </div>
                ))}
                {t.foods.length>5 && <div style={{fontSize:11,color:"#374151",marginTop:4}}>ועוד {t.foods.length-5} פריטים...</div>}
              </Card>
            ))
          }
        </div>
      )}

      {/* ── MANUAL VIEW ── */}
      {subview==="manual" && (
        <Card>
          <SL>הזנה ידנית</SL>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            <div style={{gridColumn:"1/-1"}}>
              <div style={{fontSize:12,color:"#4B5568",marginBottom:5}}>שם המנה</div>
              <TI value={mf.name} placeholder="שם המנה" onChange={e=>setMf({...mf,name:e.target.value})}/>
            </div>
            <div style={{gridColumn:"1/-1"}}>
              <div style={{fontSize:12,color:"#4B5568",marginBottom:5}}>כמות / משקל</div>
              <TI value={mf.amount} placeholder='100ג, 1 מנה, 200מ"ל...' onChange={e=>setMf({...mf,amount:e.target.value})}/>
            </div>
            {[{k:"calories",l:"קלוריות",c:"#4ADE80"},{k:"protein",l:"חלבון (ג׳)",c:"#818CF8"},{k:"carbs",l:"פחמימות (ג׳)",c:"#F59E0B"},{k:"fat",l:"שומן (ג׳)",c:"#F87171"},{k:"fiber",l:"סיבים (ג׳)",c:"#34D399"}].map(({k,l,c})=>(
              <div key={k}>
                <div style={{fontSize:12,color:c,marginBottom:5}}>{l}</div>
                <TI value={mf[k]} type="number" placeholder="0" onChange={e=>setMf({...mf,[k]:+e.target.value})}/>
              </div>
            ))}
          </div>
          <div style={{display:"flex",gap:8,marginTop:14}}>
            <Btn onClick={addManual}>הוסף לליומן</Btn>
            <Btn v="ghost" onClick={()=>setSubview("log")}>בטל</Btn>
          </div>
        </Card>
      )}
    </div>
  );
}

// ══ Fitness Log ════════════════════════════════════════════════════════
// Compute totals from walking segments — steps adjusted per segment incline
const walkStats = (segs, wKg, heightCm=175, spkOverride=null) => {
  let dist=0, cal=0, dur=0, steps=0;
  segs.forEach(s => {
    const d   = parseFloat(s.dur)    || 0;
    const sp  = parseFloat(s.speed)  || 0;
    const inc = parseFloat(s.incline)|| 0;
    const km  = sp * d / 60;
    dist  += km; dur += d;
    cal   += (WORKOUT_TYPES.walking.met + inc*0.08) * wKg * (d/60);
    // Each segment uses its own incline-adjusted steps/km
    steps += km * stepsPerKmInclined(heightCm, inc, spkOverride);
  });
  const avgInc = segs.length
    ? +(segs.reduce((s,x)=>s+(parseFloat(x.incline)||0),0)/segs.length).toFixed(1) : 0;
  return {
    dist:   +dist.toFixed(2),
    cal:    Math.round(cal),
    dur:    Math.round(dur),
    steps:  Math.round(steps),
    avgInc,
    spk:    spkOverride || stepsPerKm(heightCm), // base flat value for display
  };
};

function FitnessLog({ fitnessLog, setFitnessLog, weightLog, profile, stepsLog, setStepsLog }) {
  const [viewDate,    setViewDate]    = useState(TODAY());
  const [formOpen,    setFormOpen]    = useState(false);
  const [type,        setType]        = useState("strength");
  const [duration,    setDuration]    = useState("");
  const [notes,       setNotes]       = useState("");
  const [desc,        setDesc]        = useState("");
  const [terrain,     setTerrain]     = useState("");
  const [exercises,   setExercises]   = useState([{name:"",sets:"",reps:"",weight:""}]);
  const [laps,        setLaps]        = useState("");
  const [swimStyle,   setSwimStyle]   = useState("חופשי");
  const [walkSegs,    setWalkSegs]    = useState([{dur:"",speed:"",incline:""}]);
  const [stepsInput,  setStepsInput]  = useState("");
  const [calMsg,      setCalMsg]      = useState("");
  const [calLoad,     setCalLoad]     = useState(false);

  const lw         = weightLog.at(-1)?.weight ?? profile.weight;
  const workouts   = fitnessLog[viewDate] || [];
  const todaySteps = stepsLog[viewDate] || 0;
  const ws         = walkStats(walkSegs, lw, profile.height || 175, profile.stepsPerKmCustom || null);
  const dur        = type==="walking" ? ws.dur : (parseInt(duration)||0);
  const estCal     = type==="walking" ? ws.cal  : (dur ? workoutCal(type, dur, lw) : 0);

  const last7     = Array.from({length:7},(_,i)=>{ const d=new Date(); d.setDate(d.getDate()-i); return dateStr(d); }).reverse();
  const weekTotal = last7.reduce((s,k)=>s+(fitnessLog[k]?.length||0),0);
  const weekCal   = last7.flatMap(k=>fitnessLog[k]||[]).reduce((s,w)=>s+(w.calories||0),0);
  const weekSteps = last7.reduce((s,k)=>s+(stepsLog[k]||0), 0);

  const addSeg = () => setWalkSegs(p=>[...p,{dur:"",speed:"",incline:""}]);
  const updSeg = (i,k,v) => setWalkSegs(p=>p.map((s,idx)=>idx===i?{...s,[k]:v}:s));
  const remSeg = i => setWalkSegs(p=>p.filter((_,idx)=>idx!==i));
  const addEx  = () => setExercises(p=>[...p,{name:"",sets:"",reps:"",weight:""}]);
  const updEx  = (i,k,v) => setExercises(p=>p.map((e,idx)=>idx===i?{...e,[k]:v}:e));
  const remEx  = i => setExercises(p=>p.filter((_,idx)=>idx!==i));

  const resetForm = () => {
    setFormOpen(false); setNotes(""); setDesc(""); setDuration(""); setTerrain("");
    setLaps(""); setWalkSegs([{dur:"",speed:"",incline:""}]);
    setExercises([{name:"",sets:"",reps:"",weight:""}]); setSwimStyle("חופשי");
  };

  const addManualSteps = () => {
    const n = parseInt(stepsInput); if (!n||n<0) return;
    const upd = {...stepsLog, [viewDate]: todaySteps + n};
    setStepsLog(upd); db.set("nt_stepsLog", upd); setStepsInput("");
  };

  const saveWorkout = () => {
    if (!dur) return;
    const w = {
      id:Date.now(), date:viewDate, type, duration:dur, calories:estCal, notes, description:desc,
      ...(type==="strength" && { exercises: exercises.filter(e=>e.name.trim()) }),
      ...(type==="swimming" && { laps:parseInt(laps)||null, swimStyle }),
      ...(type==="walking"  && { segments:walkSegs.filter(s=>s.dur), distance:ws.dist, steps:ws.steps, avgIncline:ws.avgInc, terrain }),
    };
    const upd = {...fitnessLog, [viewDate]:[...(fitnessLog[viewDate]||[]), w]};
    setFitnessLog(upd); db.set("nt_fitnessLog", upd);
    if (type==="walking" && ws.steps > 0) {
      const su = {...stepsLog, [viewDate]: todaySteps + ws.steps};
      setStepsLog(su); db.set("nt_stepsLog", su);
    }
    resetForm();
  };

  const removeWorkout = id => {
    const upd = {...fitnessLog, [viewDate]: workouts.filter(w=>w.id!==id)};
    setFitnessLog(upd); db.set("nt_fitnessLog", upd);
  };

  const sendCal = async workout => {
    setCalLoad(true); setCalMsg("");
    const r = await sendToGCal(workout, profile);
    setCalMsg(r ? "✓ נוסף ל-Google Calendar!" : "שגיאה — בדוק חיבור Calendar");
    setCalLoad(false); setTimeout(()=>setCalMsg(""), 4000);
  };

  return (
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <DateNav viewDate={viewDate} setViewDate={setViewDate}/>

      {/* Week strip */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
        {[
          {l:"אימונים שבוע",   v:weekTotal,                                              c:"#818CF8"},
          {l:"קל׳ נשרפו שבוע", v:weekCal,                                               c:"#F87171"},
          {l:"צעדים שבוע",     v:weekSteps>999?Math.round(weekSteps/1000)+"K":weekSteps, c:"#4ADE80"},
        ].map(({l,v,c})=>(
          <Card key={l} style={{textAlign:"center",padding:"12px 6px"}}>
            <div style={{fontSize:20,fontWeight:800,color:c}}>{v}</div>
            <div style={{fontSize:10,color:"#4B5568",marginTop:3}}>{l}</div>
          </Card>
        ))}
      </div>

      {/* Steps card */}
      <Card>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10,flexWrap:"wrap",gap:8}}>
          <SL>👟 צעדים יומיים</SL>
          <div style={{display:"flex",gap:6,alignItems:"center"}}>
            <TI value={stepsInput} type="number" placeholder="הוסף צעדים..."
              onChange={e=>setStepsInput(e.target.value)}
              onKeyDown={e=>e.key==="Enter"&&addManualSteps()}
              style={{width:130,fontSize:13,padding:"5px 10px"}}/>
            <Btn v="green" onClick={addManualSteps} style={{fontSize:12,padding:"5px 12px"}}>+ הוסף</Btn>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"baseline",gap:8}}>
          <span style={{fontSize:36,fontWeight:800,color:"#4ADE80"}}>{todaySteps.toLocaleString()}</span>
          <span style={{fontSize:13,color:"#4B5568"}}>צעדים</span>
          {todaySteps>=10000 && <span style={{fontSize:16}}>🎉</span>}
        </div>
        <div style={{marginTop:8,background:"#0D1117",borderRadius:6,height:6,overflow:"hidden"}}>
          <div style={{height:"100%",borderRadius:6,background:"linear-gradient(90deg,#4ADE80,#60A5FA)",transition:"width .5s",width:`${Math.min(todaySteps/10000*100,100)}%`}}/>
        </div>
        <div style={{fontSize:11,color:"#374151",marginTop:4}}>יעד 10,000 · {Math.max(0,10000-todaySteps).toLocaleString()} נותרו</div>
      </Card>

      {calMsg && (
        <div style={{background:"rgba(74,222,128,0.1)",border:"1px solid rgba(74,222,128,0.3)",borderRadius:8,padding:"10px 14px",fontSize:13,color:"#4ADE80",textAlign:"center"}}>
          {calMsg}
        </div>
      )}

      {/* Workout list */}
      {workouts.length > 0 && (
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {workouts.map(w => {
            const wt = WORKOUT_TYPES[w.type]||WORKOUT_TYPES.other;
            return (
              <Card key={w.id} style={{borderRight:`3px solid ${wt.color}`}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                  <div style={{flex:1}}>
                    <div style={{fontSize:16,fontWeight:700,color:"#E2E8F0"}}>{wt.icon} {wt.label}</div>
                    <div style={{display:"flex",gap:10,fontSize:12,color:"#4B5568",marginTop:4,flexWrap:"wrap"}}>
                      <span>⏱ {w.duration} דק׳</span>
                      <span style={{color:"#F87171"}}>🔥 {w.calories} קל׳</span>
                      {w.distance   && <span>📍 {w.distance}ק"מ</span>}
                      {w.steps      && <span style={{color:"#4ADE80"}}>👟 {w.steps.toLocaleString()}</span>}
                      {w.avgIncline>0 && <span>⬆ {w.avgIncline}% שיפוע</span>}
                      {w.laps       && <span>🏊 {w.laps} קורות · {w.swimStyle}</span>}
                    </div>
                    {w.notes && <div style={{fontSize:13,color:"#94A3B8",marginTop:6}}>{w.notes}</div>}
                    {w.description && <div style={{fontSize:12,color:"#64748B",marginTop:4,fontStyle:"italic"}}>{w.description}</div>}
                    {w.terrain && <div style={{fontSize:11,color:"#4B5568",marginTop:3}}>מסלול: {w.terrain}</div>}
                    {w.segments?.length > 0 && (
                      <div style={{marginTop:8}}>
                        {w.segments.map((s,i)=>(
                          <div key={i} style={{display:"inline-flex",gap:8,fontSize:11,color:"#64748B",background:"#0D1117",borderRadius:5,padding:"3px 8px",marginLeft:4,marginBottom:3}}>
                            <span>⏱{s.dur}דק׳</span>
                            {s.speed   && <span style={{color:"#4ADE80"}}>🏃{s.speed}קמ"ש</span>}
                            {parseFloat(s.incline)>0 && <span style={{color:"#F59E0B"}}>⬆{s.incline}%</span>}
                          </div>
                        ))}
                      </div>
                    )}
                    {w.exercises?.length > 0 && (
                      <div style={{marginTop:8,display:"flex",flexDirection:"column",gap:3}}>
                        {w.exercises.map((e,i)=>(
                          <div key={i} style={{fontSize:12,color:"#64748B",background:"#0D1117",borderRadius:6,padding:"4px 10px",display:"flex",gap:8,flexWrap:"wrap"}}>
                            <span style={{color:"#94A3B8",fontWeight:600}}>{e.name}</span>
                            {e.sets && <span>{e.sets}×{e.reps||"?"}</span>}
                            {e.weight && <span style={{color:"#818CF8"}}>@{e.weight}ק"ג</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div style={{display:"flex",flexDirection:"column",gap:6,alignItems:"flex-end",marginRight:8}}>
                    <button onClick={()=>removeWorkout(w.id)} style={{background:"none",border:"none",cursor:"pointer",color:"#374151",fontSize:20,padding:"2px 4px",lineHeight:1}}>×</button>
                    <Btn v="blue" onClick={()=>sendCal(w)} disabled={calLoad} style={{fontSize:11,padding:"5px 10px"}}>📅 קלנדר</Btn>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {workouts.length===0 && !formOpen && (
        <Card><div style={{textAlign:"center",color:"#374151",padding:"20px 0",fontSize:14}}>{viewDate===TODAY()?"לא תועד אימון היום 💪":"אין אימונים ביום זה"}</div></Card>
      )}

      {!formOpen
        ? <Btn onClick={()=>setFormOpen(true)} style={{padding:"12px",width:"100%"}}>+ הוסף אימון</Btn>
        : (
          <Card>
            <SL>אימון חדש</SL>
            <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:16}}>
              {Object.entries(WORKOUT_TYPES).map(([k,{label,icon,color}])=>(
                <button key={k} onClick={()=>setType(k)}
                  style={{background:type===k?`rgba(${hexToRgb(color)},0.15)`:"#0D1117",border:type===k?`1px solid ${color}`:"1px solid #2A2E42",borderRadius:8,padding:"7px 12px",cursor:"pointer",minHeight:40,fontSize:13,fontWeight:700,color:type===k?color:"#4B5568",fontFamily:"inherit"}}>
                  {icon} {label}
                </button>
              ))}
            </div>

            {/* Duration/notes for non-walking */}
            {type!=="walking" && (
              <div style={{display:"grid",gridTemplateColumns:"1fr 2fr",gap:10,marginBottom:12}}>
                <div>
                  <div style={{fontSize:12,color:"#94A3B8",marginBottom:5}}>משך (דקות) *</div>
                  <TI value={duration} type="number" placeholder="45" onChange={e=>setDuration(e.target.value)}/>
                </div>
                <div>
                  <div style={{fontSize:12,color:"#94A3B8",marginBottom:5}}>כותרת</div>
                  <TI value={notes} placeholder={`${WORKOUT_TYPES[type]?.label}...`} onChange={e=>setNotes(e.target.value)}/>
                </div>
              </div>
            )}
            {type==="walking" && (
              <div style={{marginBottom:12}}>
                <div style={{fontSize:12,color:"#94A3B8",marginBottom:5}}>כותרת</div>
                <TI value={notes} placeholder="ספיד וולקינג, הליכה בהרים..." onChange={e=>setNotes(e.target.value)}/>
              </div>
            )}

            {/* STRENGTH */}
            {type==="strength" && (
              <div style={{marginBottom:14}}>
                <div style={{fontSize:12,color:"#818CF8",fontWeight:700,marginBottom:8}}>💪 תרגילים</div>
                {exercises.map((ex,i)=>(
                  <div key={i} style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 1fr auto",gap:6,marginBottom:6,alignItems:"center"}}>
                    <TI value={ex.name}   placeholder="שם תרגיל"      onChange={e=>updEx(i,"name",e.target.value)}/>
                    <TI value={ex.sets}   placeholder="סטים" type="number" onChange={e=>updEx(i,"sets",e.target.value)}/>
                    <TI value={ex.reps}   placeholder="חזרות" type="number" onChange={e=>updEx(i,"reps",e.target.value)}/>
                    <TI value={ex.weight} placeholder='ק"ג'  type="number" onChange={e=>updEx(i,"weight",e.target.value)}/>
                    <button onClick={()=>remEx(i)} style={{background:"none",border:"none",cursor:"pointer",color:"#374151",fontSize:18,padding:"4px",lineHeight:1,minWidth:32}}>×</button>
                  </div>
                ))}
                <Btn v="ghost" onClick={addEx} style={{fontSize:12,padding:"6px 12px"}}>+ תרגיל</Btn>
              </div>
            )}

            {/* SWIMMING */}
            {type==="swimming" && (
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
                <div>
                  <div style={{fontSize:12,color:"#60A5FA",marginBottom:5}}>קורות</div>
                  <TI value={laps} type="number" placeholder="30" onChange={e=>setLaps(e.target.value)}/>
                </div>
                <div>
                  <div style={{fontSize:12,color:"#60A5FA",marginBottom:5}}>סגנון</div>
                  <select value={swimStyle} onChange={e=>setSwimStyle(e.target.value)}
                    style={{background:"#0D1117",border:"1px solid #2A2E42",borderRadius:9,padding:"9px 13px",color:"#E2E8F0",fontSize:14,width:"100%",fontFamily:"inherit",direction:"rtl",outline:"none"}}>
                    {SWIM_STYLES.map(s=><option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>
            )}

            {/* WALKING — SEGMENTS */}
            {type==="walking" && (
              <div style={{marginBottom:14}}>
                <div style={{fontSize:12,color:"#4ADE80",fontWeight:700,marginBottom:8}}>🚶 קטעי הליכה — הוסף קטע לכל שינוי שיפוע/מהירות</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr auto",gap:6,marginBottom:4}}>
                  {["⏱ זמן (דק׳)","🏃 מהירות (קמ\"ש)","⬆ שיפוע (%)",""].map((h,i)=>(
                    <div key={i} style={{fontSize:10,color:"#374151",textAlign:"center",padding:"0 4px"}}>{h}</div>
                  ))}
                </div>
                {walkSegs.map((seg,i)=>(
                  <div key={i} style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr auto",gap:6,marginBottom:6,alignItems:"center"}}>
                    <TI value={seg.dur}     placeholder="20"  type="number" onChange={e=>updSeg(i,"dur",e.target.value)}/>
                    <TI value={seg.speed}   placeholder="5.5" type="number" onChange={e=>updSeg(i,"speed",e.target.value)}/>
                    <TI value={seg.incline} placeholder="8"   type="number" onChange={e=>updSeg(i,"incline",e.target.value)}
                      style={{borderColor:parseFloat(seg.incline)>0?"rgba(245,158,11,0.5)":"#2A2E42"}}/>
                    <button onClick={()=>remSeg(i)} disabled={walkSegs.length===1}
                      style={{background:"none",border:"none",cursor:walkSegs.length===1?"default":"pointer",color:"#374151",fontSize:18,padding:"4px",lineHeight:1,minWidth:32,opacity:walkSegs.length===1?0.3:1}}>×</button>
                  </div>
                ))}
                <div style={{display:"flex",gap:8,marginBottom:10}}>
                  <Btn v="ghost" onClick={addSeg} style={{fontSize:12,padding:"6px 12px"}}>+ קטע</Btn>
                </div>
                <div>
                  <div style={{fontSize:12,color:"#4B5568",marginBottom:5}}>מסלול / שטח</div>
                  <TI value={terrain} placeholder="נחל צין, שביל ישראל, פארק..." onChange={e=>setTerrain(e.target.value)}/>
                </div>
                {ws.dur > 0 && (
                  <div style={{marginTop:10,background:"rgba(74,222,128,0.06)",border:"1px solid rgba(74,222,128,0.15)",borderRadius:10,padding:"10px 14px"}}>
                    <div style={{fontSize:11,color:"#4ADE80",fontWeight:700,marginBottom:8}}>📊 תצוגה מקדימה</div>
                    <div style={{display:"flex",gap:14,flexWrap:"wrap",fontSize:13}}>
                      <span>⏱ <strong style={{color:"#E2E8F0"}}>{ws.dur}</strong> דק׳</span>
                      <span>📍 <strong style={{color:"#E2E8F0"}}>{ws.dist}</strong> ק"מ</span>
                      <span>👟 <strong style={{color:"#4ADE80"}}>{ws.steps.toLocaleString()}</strong> צעדים</span>
                      <span>🔥 <strong style={{color:"#F87171"}}>{ws.cal}</strong> קל׳</span>
                      {ws.avgInc>0 && <span>⬆ <strong style={{color:"#F59E0B"}}>{ws.avgInc}%</strong> ממוצע</span>}
                    </div>
                    {/* Per-segment breakdown */}
                    {walkSegs.filter(s=>s.dur&&s.speed).length > 1 && (
                      <div style={{marginTop:8,borderTop:"1px solid rgba(74,222,128,0.1)",paddingTop:8}}>
                        <div style={{fontSize:10,color:"#374151",marginBottom:4}}>פירוט לפי קטעים:</div>
                        {walkSegs.filter(s=>s.dur).map((seg,i)=>{
                          const segDist = (parseFloat(seg.speed)||0)*(parseFloat(seg.dur)||0)/60;
                          const segInc  = parseFloat(seg.incline)||0;
                          const segSpk  = stepsPerKmInclined(profile.height||174, segInc, profile.stepsPerKmCustom||null);
                          const segSteps= Math.round(segDist*segSpk);
                          return (
                            <div key={i} style={{display:"flex",gap:10,fontSize:11,color:"#64748B",marginBottom:2}}>
                              <span>קטע {i+1}:</span>
                              <span>{seg.dur}דק׳ × {seg.speed||"?"} קמ"ש</span>
                              {segInc>0 && <span style={{color:"#F59E0B"}}>⬆{segInc}%</span>}
                              <span>→ {segDist.toFixed(2)}ק"מ</span>
                              <span style={{color:"#4ADE80"}}>{segSteps.toLocaleString()} צעדים</span>
                              {segInc>0 && <span style={{color:"#374151",fontSize:10}}>({segSpk}/ק"מ עם שיפוע)</span>}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <div style={{fontSize:11,color:"#374151",marginTop:6}}>
                      ✓ הצעדים יתווספו לספירת הצעדים היומית
                      <span style={{color:"#4B5568",marginRight:6}}> · בסיס שטוח: {ws.spk} צעדים/ק"מ</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Free text */}
            <div style={{marginBottom:14}}>
              <div style={{fontSize:12,color:"#94A3B8",marginBottom:5}}>תיאור חופשי (אופציונלי)</div>
              <TI value={desc} rows={2} placeholder="קצב, תחושה, הערות..." onChange={e=>setDesc(e.target.value)}/>
            </div>

            {type!=="walking" && dur>0 && (
              <div style={{background:"#0D1117",borderRadius:8,padding:"10px 14px",marginBottom:14,fontSize:13,color:"#94A3B8",display:"flex",justifyContent:"space-between"}}>
                <span>🔥 קלוריות משוערות</span>
                <strong style={{color:"#F87171",fontSize:18}}>{estCal}</strong>
              </div>
            )}

            <div style={{display:"flex",gap:8}}>
              <Btn onClick={saveWorkout} disabled={!dur}>שמור אימון 💪</Btn>
              <Btn v="ghost" onClick={resetForm}>בטל</Btn>
            </div>
          </Card>
        )
      }
    </div>
  );
}

// ══ Weight Tab ═════════════════════════════════════════════════════════
function WeightTab({ profile, setProfile, weightLog, setWeightLog }) {
  const [input,   setInput]   = useState("");
  const [editDate,setEditDate]= useState(null);   // date string being edited
  const [editVal, setEditVal] = useState("");

  const lw = weightLog.at(-1)?.weight ?? profile.weight;
  const b  = calcBMI(lw, profile.height);
  const bi = bmiInfo(b);

  const logWeight = () => {
    const w = parseFloat(input);
    if (isNaN(w)||w<20||w>400) return;
    const entry   = { date:TODAY(), weight:w };
    const updated = [...weightLog.filter(e=>e.date!==TODAY()), entry].sort((a,b)=>a.date.localeCompare(b.date));
    setWeightLog(updated); db.set("nt_weightLog", updated);
    const p = {...profile, weight:w}; setProfile(p); db.set("nt_profile", p);
    setInput("");
  };

  const saveEdit = date => {
    const w = parseFloat(editVal);
    if (isNaN(w)||w<20||w>400) { setEditDate(null); return; }
    const updated = weightLog.map(e=>e.date===date ? {...e,weight:w} : e);
    setWeightLog(updated); db.set("nt_weightLog", updated);
    // update profile weight if it's the most recent entry
    if (date === weightLog.at(-1)?.date) {
      const p = {...profile, weight:w}; setProfile(p); db.set("nt_profile", p);
    }
    setEditDate(null); setEditVal("");
  };

  const deleteEntry = date => {
    const updated = weightLog.filter(e=>e.date!==date);
    setWeightLog(updated); db.set("nt_weightLog", updated);
  };

  const chartData  = weightLog.slice(-30).map(w=>({date:w.date.slice(5), weight:w.weight}));
  const avg        = arr => arr.length ? arr.reduce((s,w)=>s+w.weight,0)/arr.length : null;
  const r7=weightLog.slice(-7), r14=weightLog.slice(-14,-7);
  const weeklyDelta = avg(r7)&&avg(r14) ? +(avg(r7)-avg(r14)).toFixed(2) : null;

  return (
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      {/* Log today */}
      <Card>
        <SL>רשום משקל היום</SL>
        <div style={{display:"flex",gap:8}}>
          <TI value={input} onChange={e=>setInput(e.target.value)}
            placeholder="משקל בק״ג (לדוגמה: 74.2)" type="number"
            onKeyDown={e=>e.key==="Enter"&&logWeight()}/>
          <Btn onClick={logWeight}>שמור ⚖️</Btn>
        </div>
      </Card>

      {/* Stats grid */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
        {[
          {label:"BMI",        val:b??"-", unit:"",     color:bi.color, sub:bi.label},
          {label:"משקל",       val:lw,     unit:'ק"ג',  color:"#E2E8F0"},
          {label:"שינוי שבועי",
            val:weeklyDelta===null?"—":(weeklyDelta>0?"+":"")+weeklyDelta,
            unit:weeklyDelta===null?"":'ק"ג',
            color:weeklyDelta===null?"#4B5568":weeklyDelta>0?"#F59E0B":"#4ADE80"},
        ].map(({label,val,unit,color,sub})=>(
          <Card key={label} style={{textAlign:"center",padding:"14px 8px"}}>
            <div style={{fontSize:10,color:"#4B5568",fontWeight:700,textTransform:"uppercase",letterSpacing:".08em",marginBottom:6}}>{label}</div>
            <div style={{fontSize:24,fontWeight:800,color}}>{val}<span style={{fontSize:12,color:"#4B5568",marginRight:3}}>{unit}</span></div>
            {sub && <div style={{fontSize:11,color,marginTop:3}}>{sub}</div>}
          </Card>
        ))}
      </div>

      {/* BMI scale */}
      <Card>
        <SL>סולם BMI</SL>
        <div style={{position:"relative",marginBottom:8}}>
          <div style={{display:"flex",height:18,borderRadius:6,overflow:"hidden"}}>
            {[["תת משקל","#60A5FA"],["תקין","#4ADE80"],["עודף","#F59E0B"],["השמנה","#F87171"]].map(([l,c])=>(
              <div key={l} style={{flex:1,background:c,display:"flex",alignItems:"center",justifyContent:"center"}}>
                <span style={{fontSize:9,color:"#000",fontWeight:700}}>{l}</span>
              </div>
            ))}
          </div>
          {b && (
            <div style={{position:"absolute",top:-5,left:`${Math.min(Math.max((b-15)/25*100,0),96)}%`,transform:"translateX(-50%)"}}>
              <div style={{width:3,height:28,background:"#fff",margin:"0 auto",borderRadius:2}}/>
              <div style={{fontSize:11,color:"#fff",fontWeight:700,whiteSpace:"nowrap",textAlign:"center",marginTop:2,textShadow:"0 1px 4px #000"}}>{b}</div>
            </div>
          )}
        </div>
        <div style={{fontSize:12,color:"#4B5568",marginTop:22}}>
          🎯 יעד: {profile.goalWeight}ק"ג · נותר:{" "}
          <span style={{color:"#F59E0B",fontWeight:600}}>{Math.max(0,lw-profile.goalWeight).toFixed(1)}ק"ג</span>
        </div>
      </Card>

      {/* Chart */}
      {chartData.length > 1 && (
        <Card>
          <SL>היסטוריית משקל — 30 יום</SL>
          <ResponsiveContainer width="100%" height={170}>
            <LineChart data={chartData} margin={{top:4,right:4,bottom:0,left:0}}>
              <XAxis dataKey="date" tick={{fill:"#4B5568",fontSize:10}} tickLine={false}/>
              <YAxis domain={["auto","auto"]} tick={{fill:"#4B5568",fontSize:10}} width={36} tickLine={false}/>
              <Tooltip contentStyle={{background:"#1A1D27",border:"1px solid #2A2E42",borderRadius:8,color:"#E2E8F0",fontSize:12}}/>
              <ReferenceLine y={profile.goalWeight} stroke="#818CF8" strokeDasharray="4 4"/>
              <Line type="monotone" dataKey="weight" stroke="#4ADE80" strokeWidth={2} dot={{fill:"#4ADE80",r:3}} activeDot={{r:5}}/>
            </LineChart>
          </ResponsiveContainer>
          <div style={{fontSize:11,color:"#4B5568",marginTop:6,display:"flex",alignItems:"center",gap:5}}>
            <span style={{display:"inline-block",width:16,height:2,background:"#818CF8",verticalAlign:"middle"}}/>
            יעד {profile.goalWeight}ק"ג
          </div>
        </Card>
      )}

      {/* Editable log */}
      {weightLog.length > 0 && (
        <Card>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10,flexWrap:"wrap",gap:6}}>
            <SL>יומן משקל</SL>
            {weeklyDelta!==null && (
              <div style={{display:"flex",alignItems:"center",gap:6,fontSize:13,fontWeight:700,
                color:weeklyDelta<0?"#4ADE80":weeklyDelta>0?"#F87171":"#4B5568"}}>
                {weeklyDelta<0?"↓ ירדת":"↑ עלית"} <strong>{Math.abs(weeklyDelta)} ק"ג</strong>
                <span style={{fontSize:11,color:"#4B5568",fontWeight:400}}>שבוע אחרון</span>
              </div>
            )}
          </div>
          <div style={{fontSize:11,color:"#374151",marginBottom:8}}>לחץ ✏️ ליד כל ערך לעריכה · × למחיקה</div>
          <div style={{maxHeight:300,overflowY:"auto",display:"flex",flexDirection:"column",gap:4}}>
            {[...weightLog].reverse().slice(0,30).map(e=>(
              <div key={e.date} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 10px",borderRadius:8,background:"#0D1117",gap:8}}>
                <span style={{color:"#94A3B8",fontSize:13,flex:1,whiteSpace:"nowrap"}}>
                  {new Date(e.date+"T12:00:00").toLocaleDateString("he-IL",{weekday:"short",day:"numeric",month:"short"})}
                </span>
                {editDate===e.date
                  ? (
                    <div style={{display:"flex",gap:6,alignItems:"center"}}>
                      <TI value={editVal} type="number"
                        onChange={ev=>setEditVal(ev.target.value)}
                        onKeyDown={ev=>{if(ev.key==="Enter")saveEdit(e.date); if(ev.key==="Escape")setEditDate(null);}}
                        style={{width:80,fontSize:13,padding:"4px 8px"}}/>
                      <Btn v="green" onClick={()=>saveEdit(e.date)} style={{fontSize:12,padding:"4px 10px"}}>✓</Btn>
                      <Btn v="ghost" onClick={()=>setEditDate(null)} style={{fontSize:12,padding:"4px 8px"}}>✕</Btn>
                    </div>
                  ) : (
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <span style={{fontWeight:700,color:"#E2E8F0",fontSize:14}}>{e.weight}<span style={{fontSize:11,color:"#4B5568",marginRight:2}}>ק"ג</span></span>
                      <button onClick={()=>{setEditDate(e.date);setEditVal(String(e.weight));}}
                        style={{background:"none",border:"none",cursor:"pointer",color:"#4B5568",fontSize:15,padding:"3px",lineHeight:1,minWidth:28}}>✏️</button>
                      <button onClick={()=>deleteEntry(e.date)}
                        style={{background:"none",border:"none",cursor:"pointer",color:"#374151",fontSize:18,padding:"3px",lineHeight:1,minWidth:28}}>×</button>
                    </div>
                  )
                }
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

// ══ Goals Tab ══════════════════════════════════════════════════════════
function GoalsTab({ profile, goals, foodLog, weightLog, fitnessLog, shortGoals, setShortGoals }) {
  const [subview, setSubview] = useState("goals");
  const lw = weightLog.at(-1)?.weight ?? profile.weight;

  // ── Short-term goals ──
  const [adding,  setAdding]  = useState(false);
  const [newG, setNewG]       = useState({title:"",type:"weight",target:"",deadline:"",notes:""});

  const goalProgress = g => {
    if (g.type==="weight") {
      const start = weightLog[0]?.weight ?? profile.weight;
      const total = Math.abs(start - g.target);
      const done  = Math.abs(start - lw);
      return total>0 ? Math.min(done/total,1) : 1;
    }
    return 0;
  };
  const addGoal = () => {
    if (!newG.title||!newG.target) return;
    const g = {...newG, id:Date.now(), target:parseFloat(newG.target)};
    const upd = [...shortGoals, g]; setShortGoals(upd); db.set("nt_shortGoals", upd);
    setNewG({title:"",type:"weight",target:"",deadline:"",notes:""}); setAdding(false);
  };
  const deleteGoal = id => {
    const upd = shortGoals.filter(g=>g.id!==id); setShortGoals(upd); db.set("nt_shortGoals", upd);
  };

  // ── Recipe calculator ──
  const [recipes,     setRecipes]     = useState([]);
  const [addingRec,   setAddingRec]   = useState(false);
  const [newRec,      setNewRec]      = useState({name:"",servings:"1",ings:[{name:"",amount:"",unit:"ג"}]});
  const [recCalcLoad, setRecCalcLoad] = useState(false);
  const [recResult,   setRecResult]   = useState(null);
  useEffect(()=>{ db.get("nt_recipes",[]).then(setRecipes); },[]);
  const updIng = (i,k,v) => setNewRec(r=>({...r,ings:r.ings.map((x,idx)=>idx===i?{...x,[k]:v}:x)}));
  const addIng = () => setNewRec(r=>({...r,ings:[...r.ings,{name:"",amount:"",unit:"ג"}]}));
  const remIng = i => setNewRec(r=>({...r,ings:r.ings.filter((_,idx)=>idx!==i)}));
  const calcRec = async () => {
    const valid = newRec.ings.filter(x=>x.name&&x.amount);
    if (!valid.length) return;
    setRecCalcLoad(true); setRecResult(null);
    const tot = await calcRecipeNutrition(valid);
    if (tot) {
      const s = parseInt(newRec.servings)||1;
      setRecResult({ total:tot, per:{calories:Math.round(tot.calories/s),protein:Math.round(tot.protein/s),carbs:Math.round(tot.carbs/s),fat:Math.round(tot.fat/s),fiber:Math.round(tot.fiber/s)} });
    }
    setRecCalcLoad(false);
  };
  const saveRec = () => {
    if (!newRec.name||!recResult) return;
    const r = {...newRec, id:Date.now(), nutrition:recResult.per, total:recResult.total};
    const upd=[...recipes,r]; setRecipes(upd); db.set("nt_recipes",upd);
    setNewRec({name:"",servings:"1",ings:[{name:"",amount:"",unit:"ג"}]}); setRecResult(null); setAddingRec(false);
  };

  // ── Export ──
  const doExport = () => {
    const txt = exportWeeklyText(foodLog, weightLog, fitnessLog, profile);
    const url  = URL.createObjectURL(new Blob([txt],{type:"text/plain;charset=utf-8"}));
    const a    = document.createElement("a");
    a.href=url; a.download=`nutri-${TODAY()}.txt`; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <SubTabs tabs={[["goals","🎯 יעדים"],["recipes","🧑‍🍳 מתכונים"],["export","📤 ייצוא"]]} active={subview} onSelect={setSubview}/>

      {/* ── GOALS ── */}
      {subview==="goals" && <>
        {shortGoals.map(g => {
          const pct = goalProgress(g);
          const daysLeft = g.deadline ? Math.ceil((new Date(g.deadline)-new Date())/86400000) : null;
          return (
            <Card key={g.id}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                <div>
                  <div style={{fontWeight:700,fontSize:15,color:"#E2E8F0"}}>{g.title}</div>
                  <div style={{fontSize:12,color:"#4B5568",marginTop:3}}>
                    יעד: <strong>{g.target}</strong>{g.type==="weight"?' ק"ג':""}
                    {daysLeft!==null && <span style={{marginRight:8,color:daysLeft<7?"#F87171":"#4B5568"}}> · {daysLeft>0?`עוד ${daysLeft} ימים`:"הגיע המועד!"}</span>}
                  </div>
                  {g.notes && <div style={{fontSize:11,color:"#374151",marginTop:3}}>{g.notes}</div>}
                </div>
                <button onClick={()=>deleteGoal(g.id)} style={{background:"none",border:"none",cursor:"pointer",color:"#374151",fontSize:20,padding:"2px 4px",lineHeight:1}}>×</button>
              </div>
              {g.type==="weight" && (
                <div>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#94A3B8",marginBottom:4}}>
                    <span>התקדמות</span><span style={{color:"#4ADE80"}}>{lw} → {g.target} ק"ג · <strong>{Math.round(pct*100)}%</strong></span>
                  </div>
                  <div style={{background:"#0D1117",borderRadius:6,height:8,overflow:"hidden"}}>
                    <div style={{height:"100%",borderRadius:6,background:"linear-gradient(90deg,#818CF8,#4ADE80)",transition:"width .5s",width:`${pct*100}%`}}/>
                  </div>
                </div>
              )}
            </Card>
          );
        })}
        {adding ? (
          <Card>
            <SL>יעד חדש</SL>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              <div><div style={{fontSize:12,color:"#94A3B8",marginBottom:5}}>תיאור היעד</div>
                <TI value={newG.title} placeholder='לדוגמה: לרדת ל-70 ק"ג עד קיץ' onChange={e=>setNewG({...newG,title:e.target.value})}/></div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                <div><div style={{fontSize:12,color:"#94A3B8",marginBottom:5}}>סוג</div>
                  <select value={newG.type} onChange={e=>setNewG({...newG,type:e.target.value})} style={{background:"#0D1117",border:"1px solid #2A2E42",borderRadius:9,padding:"9px 13px",color:"#E2E8F0",fontSize:14,width:"100%",fontFamily:"inherit",direction:"rtl",outline:"none"}}>
                    <option value="weight">משקל</option><option value="custom">אחר</option>
                  </select></div>
                <div><div style={{fontSize:12,color:"#94A3B8",marginBottom:5}}>ערך יעד</div>
                  <TI value={newG.target} type="number" placeholder={newG.type==="weight"?"70":"..."} onChange={e=>setNewG({...newG,target:e.target.value})}/></div>
                <div style={{gridColumn:"1/-1"}}><div style={{fontSize:12,color:"#94A3B8",marginBottom:5}}>תאריך יעד</div>
                  <TI value={newG.deadline} type="date" onChange={e=>setNewG({...newG,deadline:e.target.value})}/></div>
                <div style={{gridColumn:"1/-1"}}><div style={{fontSize:12,color:"#94A3B8",marginBottom:5}}>הערות</div>
                  <TI value={newG.notes} placeholder="אופציונלי..." onChange={e=>setNewG({...newG,notes:e.target.value})}/></div>
              </div>
              <div style={{display:"flex",gap:8}}>
                <Btn onClick={addGoal}>שמור יעד</Btn>
                <Btn v="ghost" onClick={()=>setAdding(false)}>בטל</Btn>
              </div>
            </div>
          </Card>
        ) : (
          <Btn onClick={()=>setAdding(true)} style={{padding:"12px",width:"100%"}}>+ יעד חדש</Btn>
        )}
      </>}

      {/* ── RECIPES ── */}
      {subview==="recipes" && <>
        {recipes.map(r=>(
          <Card key={r.id}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
              <div>
                <div style={{fontWeight:700,fontSize:15,color:"#E2E8F0"}}>{r.name}</div>
                <div style={{fontSize:12,color:"#4B5568",marginTop:2}}>{r.servings} מנות · {r.ings?.length} מרכיבים</div>
              </div>
              <button onClick={()=>{const upd=recipes.filter(x=>x.id!==r.id);setRecipes(upd);db.set("nt_recipes",upd);}} style={{background:"none",border:"none",cursor:"pointer",color:"#374151",fontSize:20,padding:"2px 4px",lineHeight:1}}>×</button>
            </div>
            <div style={{background:"#0D1117",borderRadius:8,padding:"10px 14px",display:"flex",gap:14,flexWrap:"wrap",fontSize:13}}>
              <span style={{color:"#4ADE80",fontWeight:700}}>{r.nutrition?.calories} קל׳</span>
              <span style={{color:"#818CF8"}}>ח: {r.nutrition?.protein}ג</span>
              <span style={{color:"#F59E0B"}}>פ: {r.nutrition?.carbs}ג</span>
              <span style={{color:"#F87171"}}>ש: {r.nutrition?.fat}ג</span>
              <span style={{fontSize:11,color:"#374151"}}>לפי מנה</span>
            </div>
          </Card>
        ))}
        {addingRec ? (
          <Card>
            <SL>מתכון חדש</SL>
            <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:10,marginBottom:10}}>
              <div><div style={{fontSize:12,color:"#94A3B8",marginBottom:5}}>שם</div><TI value={newRec.name} placeholder="קציצות עדשים..." onChange={e=>setNewRec({...newRec,name:e.target.value})}/></div>
              <div><div style={{fontSize:12,color:"#94A3B8",marginBottom:5}}>מנות</div><TI value={newRec.servings} type="number" placeholder="4" onChange={e=>setNewRec({...newRec,servings:e.target.value})}/></div>
            </div>
            <div style={{fontSize:12,color:"#94A3B8",marginBottom:6}}>מרכיבים:</div>
            {newRec.ings.map((ing,i)=>(
              <div key={i} style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr auto",gap:6,marginBottom:6,alignItems:"center"}}>
                <TI value={ing.name}   placeholder="שם המרכיב"  onChange={e=>updIng(i,"name",e.target.value)}/>
                <TI value={ing.amount} placeholder="100" type="number" onChange={e=>updIng(i,"amount",e.target.value)}/>
                <select value={ing.unit} onChange={e=>updIng(i,"unit",e.target.value)} style={{background:"#0D1117",border:"1px solid #2A2E42",borderRadius:9,padding:"9px 8px",color:"#E2E8F0",fontSize:13,fontFamily:"inherit",direction:"rtl",outline:"none"}}>
                  {["ג","ק\"ג","מ\"ל","ל","כוס","כף","כפית","יח׳"].map(u=><option key={u} value={u}>{u}</option>)}
                </select>
                <button onClick={()=>remIng(i)} style={{background:"none",border:"none",cursor:"pointer",color:"#374151",fontSize:18,padding:"4px",lineHeight:1,minWidth:32}}>×</button>
              </div>
            ))}
            <div style={{display:"flex",gap:8,marginBottom:12,marginTop:4}}>
              <Btn v="ghost" onClick={addIng} style={{fontSize:12,padding:"6px 12px"}}>+ מרכיב</Btn>
              <Btn v="amber" onClick={calcRec} disabled={recCalcLoad}>{recCalcLoad?"⏳ מחשב...":"🔍 חשב ערכים"}</Btn>
            </div>
            {recResult && (
              <div style={{background:"rgba(74,222,128,0.06)",border:"1px solid rgba(74,222,128,0.2)",borderRadius:10,padding:"12px 14px",marginBottom:12}}>
                <div style={{fontSize:12,color:"#4ADE80",fontWeight:700,marginBottom:6}}>לפי מנה ({newRec.servings} מנות):</div>
                <div style={{display:"flex",gap:14,flexWrap:"wrap",fontSize:14}}>
                  <span style={{color:"#4ADE80",fontWeight:700}}>{recResult.per.calories} קל׳</span>
                  <span style={{color:"#818CF8"}}>ח: {recResult.per.protein}ג</span>
                  <span style={{color:"#F59E0B"}}>פ: {recResult.per.carbs}ג</span>
                  <span style={{color:"#F87171"}}>ש: {recResult.per.fat}ג</span>
                </div>
              </div>
            )}
            <div style={{display:"flex",gap:8}}>
              <Btn onClick={saveRec} disabled={!recResult}>שמור מתכון</Btn>
              <Btn v="ghost" onClick={()=>setAddingRec(false)}>בטל</Btn>
            </div>
          </Card>
        ) : (
          <Btn onClick={()=>setAddingRec(true)} style={{padding:"12px",width:"100%"}}>+ מתכון חדש 🧑‍🍳</Btn>
        )}
      </>}

      {/* ── EXPORT ── */}
      {subview==="export" && (
        <Card>
          <SL>📤 ייצוא שבועי</SL>
          <div style={{fontSize:13,color:"#64748B",lineHeight:1.8,marginBottom:16}}>
            קובץ טקסט של 7 הימים האחרונים:<br/>
            • יומן אוכל מפורט + ערכים תזונתיים<br/>
            • נתוני משקל + שינויים<br/>
            • יומן אימונים + קלוריות נשרפות
          </div>
          <Btn onClick={doExport} style={{padding:"12px",width:"100%",marginBottom:14}}>⬇️ הורד דוח שבועי (TXT)</Btn>
          <div style={{fontSize:11,color:"#374151",marginBottom:6}}>תצוגה מקדימה:</div>
          <pre style={{background:"#0D1117",borderRadius:8,padding:12,fontSize:10,color:"#4B5568",overflowX:"auto",maxHeight:180,direction:"ltr",textAlign:"left",lineHeight:1.6,whiteSpace:"pre-wrap"}}>
            {exportWeeklyText(foodLog,weightLog,fitnessLog,profile).slice(0,500)}…
          </pre>
        </Card>
      )}
    </div>
  );
}

// ══ Chat Tab ═══════════════════════════════════════════════════════════
function ChatTab({ profile, goals, foodLog, setFoodLog, weightLog, fitnessLog, stepsLog, myFoods, setMyFoods, chatHistory, setChatHistory }) {
  const lw  = weightLog.at(-1)?.weight ?? profile.weight;
  const tod = foodLog[TODAY()] || [];
  const initMsg = {
    role:"assistant",
    content:`שלום ${profile.name}! 👋 אני **נוטרי**, המאמן האישי שלך לתזונה ובריאות.

אני כאן כדי לעזור לך עם:
• ניתוח הארוחות ועמידה ביעדים
• פידבק אישי על ההתקדמות שלך
• שאלות על תזונה, קלוריות ומאקרו
• המלצות מותאמות לפרופיל שלך

שאל אותי כל דבר — אני אחפש ברשת אם צריך! 🔍`
  };

  const [messages, setMessages] = useState([initMsg]);
  const [input, setInput]       = useState("");
  const [loading, setLoading]   = useState(false);
  const endRef = useRef(null);

  // Load chat history at startup only (don't overwrite mid-conversation)
  useEffect(()=>{
    if (chatHistory && chatHistory.length > 0 && messages.length <= 1) {
      setMessages(chatHistory);
    }
  },[chatHistory]);

  const [logLoading, setLogLoading] = useState(false);
  const [logMsg,     setLogMsg]     = useState("");
  const [saveLoading,setSaveLoading]= useState(false);
  const [pendingSave,setPendingSave] = useState(null); // food to save to myFoods

  // Log food to today's diary
  const logFromChat = async () => {
    if (!input.trim() || logLoading) return;
    setLogLoading(true); setLogMsg("");
    try {
      const items = await parseNaturalFood(input);
      if (items && items.length > 0) {
        const toAdd = items.map((item,i)=>({...item, id:Date.now()+i}));
        const upd = {...foodLog, [TODAY()]:[...(foodLog[TODAY()]||[]), ...toAdd]};
        setFoodLog(upd); db.set("nt_foodLog", upd);
        const names = items.map(x=>x.name).join(", ");
        const cals  = items.reduce((s,x)=>s+(x.calories||0),0);
        setLogMsg("✓ נרשמו: " + names + " (" + Math.round(cals) + " קל')");
        setInput("");
      } else {
        setLogMsg("לא זיהיתי מזון — נסה: '200ג חזה עוף'");
      }
    } catch { setLogMsg("שגיאה — נסה שוב"); }
    setLogLoading(false);
    setTimeout(()=>setLogMsg(""), 4000);
  };

  // Save food as a personal product (⭐ שלי)
  const saveToMyFoods = async () => {
    if (!input.trim() || saveLoading) return;
    setSaveLoading(true); setLogMsg("");
    try {
      const items = await parseNaturalFood(input);
      if (items && items.length > 0) {
        const item = items[0];
        setPendingSave({
          name: item.name, per: 100, unit: "ג",
          calories: item.calories, protein: item.protein,
          carbs: item.carbs, fat: item.fat, fiber: item.fiber,
        });
      } else {
        setLogMsg("לא זיהיתי מוצר — נסה שם מפורט יותר");
        setTimeout(()=>setLogMsg(""), 3000);
      }
    } catch { setLogMsg("שגיאה — נסה שוב"); setTimeout(()=>setLogMsg(""),3000); }
    setSaveLoading(false);
  };

  const confirmSaveMyFood = () => {
    if (!pendingSave) return;
    const f = {...pendingSave, id: Date.now()};
    const upd = [...(myFoods||[]), f];
    setMyFoods(upd); db.set("nt_myFoods", upd);
    setLogMsg(`✅ "${f.name}" נשמר ל-⭐ המוצרים שלי`);
    setPendingSave(null); setInput("");
    setTimeout(()=>setLogMsg(""), 3000);
  };

  const send = async () => {
    if (!input.trim()||loading) return;
    const um = {role:"user",content:input};
    const updated = [...messages, um];
    setMessages(updated); setInput(""); setLoading(true);
    const ctx = {
      name:profile.name, gender:profile.gender, weight:lw, height:profile.height, age:profile.age,
      bmi:calcBMI(lw,profile.height), tdee:calcTDEE({...profile,weight:lw}),
      goals, goalWeight:profile.goalWeight,
      todayTotals:sumFood(tod),
      todayFoods:tod.map(f=>({name:f.name,amount:f.amount||"",cal:Math.round(f.calories||0),pro:Math.round(f.protein||0),carbs:Math.round(f.carbs||0),fat:Math.round(f.fat||0),fiber:Math.round(f.fiber||0)})),
      last7days:Array.from({length:7},(_,i)=>{ const d=new Date(); d.setDate(d.getDate()-i); const k=dateStr(d); const fs=foodLog[k]||[]; return {date:k,foods:fs.map(f=>({name:f.name,amount:f.amount||'',cal:Math.round(f.calories||0),pro:Math.round(f.protein||0),carbs:Math.round(f.carbs||0),fat:Math.round(f.fat||0)})),total:sumFood(fs)}; }).reverse(),
      recentWeights:weightLog.slice(-14),
      weekWorkouts:(()=>{const last7=Array.from({length:7},(_,i)=>{ const d=new Date(); d.setDate(d.getDate()-i); return dateStr(d); }); return last7.flatMap(k=>(fitnessLog||{})[k]||[]).map(w=>({date:w.date,type:w.type,dur:w.duration,cal:w.calories}));})(),
      todaySteps:(stepsLog||{})[TODAY()]||0,

      recentWeights:weightLog.slice(-7),
    };
    const reply = await chatCoach(updated.map(m=>({role:m.role,content:m.content})), ctx);
    const full  = [...updated, {role:"assistant",content:reply}];
    const trimmed = full.slice(-40);
    setMessages(trimmed);
    db.set("nt_chat", trimmed);
    if (setChatHistory) setChatHistory(trimmed);
    setLoading(false);
    setTimeout(()=>endRef.current?.scrollIntoView({behavior:"smooth"}),80);
  };

  const QUICK = ["מה אכלתי היום וכמה קלוריות נשארו?","תן לי פידבק על ההתקדמות שלי","אילו מזונות עשירים בחלבון?","כמה מים כדאי לי לשתות?"];

  return (
    <div style={{display:"flex",flexDirection:"column",height:"calc(100vh - 220px)",minHeight:420}}>
      <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:10,flexShrink:0}}>
        {QUICK.map(q=>(
          <button key={q} onClick={()=>setInput(q)} style={{background:"#1A1D27",border:"1px solid #2A2E42",borderRadius:18,padding:"5px 12px",fontSize:12,color:"#94A3B8",cursor:"pointer",whiteSpace:"nowrap",fontFamily:"inherit"}}>
            {q}
          </button>
        ))}
      </div>

      <div style={{flex:1,overflowY:"auto",display:"flex",flexDirection:"column",gap:10,padding:"4px 0"}}>
        {messages.map((m,i)=>(
          <div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-start":"flex-end"}}>
            <div style={{
              maxWidth:"83%",padding:"11px 15px",borderRadius:14,fontSize:14,lineHeight:1.65,
              background:m.role==="user"?"#1A1D27":"#141d14",
              border:`1px solid ${m.role==="user"?"#2A2E42":"rgba(74,222,128,0.12)"}`,
              borderTopRightRadius:m.role==="user"?3:14,
              borderTopLeftRadius:m.role==="assistant"?3:14,
              whiteSpace:"pre-line",color:"#E2E8F0",
            }}>
              {m.role==="assistant" && <div style={{fontSize:11,color:"#4ADE80",marginBottom:6,fontWeight:700}}>🌿 נוטרי</div>}
              {m.content}
            </div>
          </div>
        ))}
        {loading && (
          <div style={{display:"flex",justifyContent:"flex-end"}}>
            <div style={{background:"#1A1D27",border:"1px solid #2A2E42",borderRadius:14,padding:"11px 16px",fontSize:13,color:"#4B5568"}}>
              ⏳ נוטרי חושב...
            </div>
          </div>
        )}
        <div ref={endRef}/>
      </div>

      <div style={{paddingTop:10,borderTop:"1px solid #1C2035",flexShrink:0}}>
        {logMsg && (
          <div style={{marginBottom:8,background:"rgba(74,222,128,0.1)",border:"1px solid rgba(74,222,128,0.3)",borderRadius:8,padding:"7px 12px",fontSize:12,color:"#4ADE80"}}>
            {logMsg}
          </div>
        )}
        {/* Pending save to My Foods */}
        {pendingSave && (
          <div style={{marginBottom:10,background:"rgba(245,158,11,0.08)",border:"1px solid rgba(245,158,11,0.3)",borderRadius:10,padding:"12px 14px"}}>
            <div style={{fontSize:12,color:"#F59E0B",fontWeight:700,marginBottom:8}}>⭐ שמור כמוצר אישי?</div>
            <div style={{fontSize:13,color:"#E2E8F0",marginBottom:6}}>{pendingSave.name}</div>
            <div style={{fontSize:11,color:"#4B5568",marginBottom:10}}>
              ל-{pendingSave.per}{pendingSave.unit}: {pendingSave.calories}קל׳ · ח:{pendingSave.protein}ג · פ:{pendingSave.carbs}ג · ש:{pendingSave.fat}ג
            </div>
            <div style={{display:"flex",gap:8}}>
              <Btn onClick={confirmSaveMyFood} style={{fontSize:12,padding:"6px 14px"}}>⭐ שמור</Btn>
              <Btn v="ghost" onClick={()=>setPendingSave(null)} style={{fontSize:12,padding:"6px 12px"}}>בטל</Btn>
            </div>
          </div>
        )}
        <div style={{display:"flex",gap:6}}>
          <TI value={input} onChange={e=>setInput(e.target.value)} placeholder="שאל את נוטרי, או כתוב מה אכלת..."
            onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&send()} style={{flex:1}}/>
          <Btn v="amber" onClick={saveToMyFoods} disabled={saveLoading}
            style={{fontSize:12,padding:"9px 10px",whiteSpace:"nowrap"}} title="שמור כמוצר שלי">
            {saveLoading?"⏳":"⭐"}
          </Btn>
          <Btn v="green" onClick={logFromChat} disabled={logLoading}
            style={{fontSize:12,padding:"9px 10px",whiteSpace:"nowrap"}} title="הוסף לאוכל היום">
            {logLoading?"⏳":"🍽️"}
          </Btn>
          <Btn onClick={send} disabled={loading}>שלח ↵</Btn>
        </div>
        <div style={{fontSize:10,color:"#374151",marginTop:4}}>
          ⭐ = שמור כמוצר שלי · 🍽️ = רשום לאוכל היום · Enter = שאל את נוטרי
        </div>
      </div>
    </div>
  );
}

// ══ Settings Tab ═══════════════════════════════════════════════════════
function Settings({ profile, setProfile, goals, setGoals }) {
  const [p, setP] = useState({...profile});
  const [g, setG] = useState({...goals});
  const [saved, setSaved] = useState(false);

  const autoCalc = () => {
    const tdee    = calcTDEE(p);
    const rate    = g.weightLossKgPerWeek || 0.75;
    const deficit = Math.round(rate * 7700 / 7);           // kcal/day deficit
    const cal     = Math.max(1400, tdee - deficit);         // never below 1400
    const protein = Math.round((p.goalWeight || p.weight) * 2); // 2g × יעד משקל
    const fat     = Math.max(50, Math.round(cal * 0.25 / 9));   // 25% מקל, מינ' 50g
    const carbs   = Math.max(50, Math.round((cal - protein*4 - fat*9) / 4)); // שאריות
    const fiber   = p.gender === "male" ? 35 : 25;              // WHO: גבר 35g
    const water   = Math.round(35 * p.weight / 250);            // 35ml × ק"ג ÷ 250ml
    setG({ ...g, calories:cal, protein, carbs, fat, fiber, water });
  };

  const saveAll = () => {
    setProfile(p); setGoals(g); db.set("nt_profile",p); db.set("nt_goals",g);
    setSaved(true); setTimeout(()=>setSaved(false),2200);
  };

  const myTDEE   = calcTDEE(p);
  const myBMI    = calcBMI(p.weight, p.height);
  const bi       = bmiInfo(myBMI);
  const rate     = g.weightLossKgPerWeek || 0.75;
  const deficit  = Math.round(rate * 7700 / 7);
  const targetCal= Math.max(1400, myTDEE - deficit);

  return (
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <Card>
        <SL>פרופיל אישי</SL>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          {[{k:"name",l:"שם",t:"text"},{k:"height",l:"גובה (ס״מ)",t:"number"},{k:"weight",l:"משקל (ק״ג)",t:"number"},{k:"goalWeight",l:"יעד משקל (ק״ג)",t:"number"},{k:"age",l:"גיל",t:"number"}].map(({k,l,t})=>(
            <div key={k}>
              <div style={{fontSize:12,color:"#4B5568",marginBottom:5}}>{l}</div>
              <TI value={p[k]} type={t} placeholder={l} onChange={e=>setP({...p,[k]:t==="number"?+e.target.value:e.target.value})}/>
            </div>
          ))}
          <div>
            <div style={{fontSize:12,color:"#4B5568",marginBottom:5}}>מין</div>
            <Sel value={p.gender} onChange={e=>setP({...p,gender:e.target.value})}>
              <option value="male">זכר</option><option value="female">נקבה</option>
            </Sel>
          </div>
          <div style={{gridColumn:"1/-1"}}>
            <div style={{fontSize:12,color:"#4B5568",marginBottom:5}}>רמת פעילות</div>
            <Sel value={p.activityLevel} onChange={e=>setP({...p,activityLevel:e.target.value})}>
              {Object.entries(ACTIVITIES).map(([k,{label}])=><option key={k} value={k}>{label}</option>)}
            </Sel>
          </div>
        </div>

        {/* Steps calibration */}
        <div style={{marginTop:12,background:"#0D1117",borderRadius:9,padding:"12px 14px"}}>
          <div style={{fontSize:12,color:"#4ADE80",fontWeight:700,marginBottom:6}}>👟 כיול צעדים לק"מ</div>
          <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
            <div style={{flex:1,minWidth:120}}>
              <TI value={p.stepsPerKmCustom||""} type="number"
                placeholder={`${stepsPerKm(p.height||174)} (אוטומטי מגובה)`}
                onChange={e=>setP({...p,stepsPerKmCustom:e.target.value?+e.target.value:null})}
                style={{fontSize:13}}/>
            </div>
            <Btn v="ghost" onClick={()=>setP({...p,stepsPerKmCustom:null})} style={{fontSize:11,padding:"5px 10px"}}>איפוס</Btn>
          </div>
          <div style={{fontSize:11,color:"#374151",marginTop:6,lineHeight:1.6}}>
            נוסחת גובה ({p.height||174}ס"מ): ~{stepsPerKm(p.height||174)} צעדים/ק"מ | בשיפוע: 1,400–1,700+
          </div>
        </div>

        {/* TDEE + BMI summary */}
        <div style={{marginTop:12,background:"#0D1117",borderRadius:9,padding:"10px 14px",fontSize:13}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
            <span style={{color:"#4B5568"}}>TDEE: <strong style={{color:"#4ADE80"}}>{myTDEE}</strong> קל׳</span>
            <span style={{color:"#4B5568"}}>BMI: <strong style={{color:bi.color}}>{myBMI}</strong> ({bi.label})</span>
          </div>
          <div style={{display:"flex",justifyContent:"space-between"}}>
            <span style={{color:"#4B5568"}}>גירעון: <strong style={{color:"#F87171"}}>−{deficit}</strong> קל׳</span>
            <span style={{color:"#4B5568"}}>יעד: <strong style={{color:"#4ADE80"}}>{targetCal}</strong> קל׳</span>
          </div>
        </div>
      </Card>

      <Card>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:8}}>
          <SL>יעדים יומיים</SL>
          <Btn v="amber" onClick={autoCalc} style={{fontSize:12,padding:"6px 12px"}}>חשב אוטומטי ✦</Btn>
        </div>

        {/* Rate of loss selector */}
        <div style={{marginBottom:14,background:"#0D1117",borderRadius:9,padding:"12px 14px"}}>
          <div style={{fontSize:12,color:"#F59E0B",fontWeight:700,marginBottom:8}}>⚖️ קצב ירידה במשקל רצוי</div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {[0.25,0.5,0.75,1.0].map(r=>(
              <button key={r} onClick={()=>setG({...g,weightLossKgPerWeek:r})}
                style={{background:(g.weightLossKgPerWeek||0.75)===r?"rgba(245,158,11,0.2)":"#1A1D27",
                  border:(g.weightLossKgPerWeek||0.75)===r?"1px solid #F59E0B":"1px solid #2A2E42",
                  borderRadius:8,padding:"7px 14px",cursor:"pointer",fontFamily:"inherit",
                  fontSize:13,fontWeight:700,color:(g.weightLossKgPerWeek||0.75)===r?"#F59E0B":"#4B5568"}}>
                {r} ק"ג/שבוע
              </button>
            ))}
          </div>
          <div style={{fontSize:11,color:"#374151",marginTop:6}}>
            {(g.weightLossKgPerWeek||0.75)} ק"ג/שבוע = גירעון של ~{Math.round((g.weightLossKgPerWeek||0.75)*7700/7)} קל׳/יום
          </div>
        </div>

        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          {[{k:"calories",l:"קלוריות (קל׳)",c:"#4ADE80"},{k:"protein",l:"חלבון (ג׳)",c:"#818CF8"},{k:"carbs",l:"פחמימות (ג׳)",c:"#F59E0B"},{k:"fat",l:"שומן (ג׳)",c:"#F87171"},{k:"fiber",l:"סיבים (ג׳)",c:"#34D399"},{k:"water",l:"מים (כוסות/יום)",c:"#60A5FA"}].map(({k,l,c})=>(
            <div key={k}>
              <div style={{fontSize:12,color:c,marginBottom:5}}>{l}</div>
              <TI value={g[k]||""} type="number" placeholder={l} onChange={e=>setG({...g,[k]:+e.target.value})}/>
            </div>
          ))}
        </div>
        <div style={{marginTop:10,fontSize:11,color:"#374151",background:"#0D1117",borderRadius:8,padding:"8px 12px",lineHeight:1.7}}>
          💡 <strong>נוסחאות:</strong> קל׳ = TDEE − גירעון · חלבון = 2g × יעד משקל · שומן = max(50g, 25% קל') · פחמימות = שאריות · סיבים = 35g גבר/25g אישה · מים = 35ml × ק"ג
        </div>
      </Card>

      {/* Sync card - no extra state needed */}
      <Card>
        <SL>🔄 סינכרון בין מכשירים</SL>
        <div style={{fontSize:12,color:"#64748B",marginBottom:10,lineHeight:1.7}}>
          כדי לסנכרן לאייפון — לחץ "הצג קוד", העתק אותו, והכנס אותו באייפון.
        </div>
        <div style={{display:"flex",gap:8,marginBottom:10}}>
          <Btn v="green" onClick={()=>{
            const uid = getUID();
            const el = document.getElementById('nutri-sync-uid');
            if (el) el.value = uid;
            navigator.clipboard?.writeText(uid);
            const msg = document.getElementById('nutri-sync-msg');
            if (msg) { msg.textContent = '✓ הועתק!'; setTimeout(()=>{ if(msg) msg.textContent=''; },2000); }
          }} style={{fontSize:12}}>הצג קוד ✓ העתק</Btn>
          <span id="nutri-sync-msg" style={{fontSize:12,color:"#4ADE80",alignSelf:"center"}}></span>
        </div>
        <input id="nutri-sync-uid" readOnly
          style={{background:"#0D1117",border:"1px solid #2A2E42",borderRadius:9,padding:"8px 12px",color:"#4ADE80",fontSize:11,width:"100%",fontFamily:"monospace",boxSizing:"border-box",marginBottom:10}}
          placeholder="לחץ 'הצג קוד' למעלה..." onClick={e=>e.target.select()}/>
        <div style={{fontSize:12,color:"#94A3B8",marginBottom:6}}>טען קוד ממכשיר אחר:</div>
        <div style={{display:"flex",gap:8}}>
          <input id="nutri-load-code" type="text" placeholder="הדבק קוד סינכרון..."
            style={{flex:1,background:"#0D1117",border:"1px solid #2A2E42",borderRadius:9,padding:"9px 12px",color:"#E2E8F0",fontSize:13,fontFamily:"inherit",direction:"rtl",outline:"none"}}/>
          <Btn v="blue" onClick={async()=>{
            const inp = document.getElementById('nutri-load-code');
            const code = inp?.value?.trim();
            if (!code) return;
            inp.disabled = true;
            const d = await loadFromKV(code);
            inp.disabled = false;
            if (d) { localStorage.setItem('nutri_uid', code); alert('✅ נמצא! מרענן...'); window.location.reload(); }
            else alert('לא נמצאו נתונים לקוד זה');
          }} style={{fontSize:12,padding:"9px 12px"}}>טען</Btn>
        </div>
      </Card>

      <Btn onClick={saveAll} style={{width:"100%",padding:"12px"}}>
        {saved ? "✓ נשמר בהצלחה!" : "שמור הגדרות"}
      </Btn>

      <Card style={{background:"rgba(74,222,128,0.04)"}}>
        <SL>אודות נוטרי</SL>
        <div style={{fontSize:13,color:"#4B5568",lineHeight:1.7}}>
          <strong style={{color:"#94A3B8"}}>נוטרי</strong> היא אפליקציה למעקב תזונה ובריאות עם בינה מלאכותית.{"\n"}
          הנתונים שלך נשמרים בדפדפן ואינם עוזבים את המכשיר שלך.{"\n"}
          חיפוש ערכים תזונתיים ופידבק ה-AI מחייבים חיבור לאינטרנט.
        </div>
      </Card>
    </div>
  );
}

// ══ Main App ═══════════════════════════════════════════════════════════
export default function App() {
  const [tab,        setTab]        = useState("dashboard");
  const [profile,    setProfile]    = useState(DEFAULTS.profile);
  const [goals,      setGoals]      = useState(DEFAULTS.goals);
  const [foodLog,    setFoodLog]    = useState({});
  const [weightLog,  setWeightLog]  = useState([]);
  const [waterLog,   setWaterLog]   = useState({});
  const [fitnessLog, setFitnessLog] = useState({});
  const [stepsLog,   setStepsLog]   = useState({});
  const [templates,  setTemplates]  = useState([]);
  const [shortGoals, setShortGoals] = useState([]);
  const [myFoods,    setMyFoods]    = useState([]);
  const [chatHistory,setChatHistory] = useState([]);
  const [ready,      setReady]      = useState(false);
  // sync handled via db.set automatically

  useEffect(()=>{
    const link = document.createElement("link");
    link.href = "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700;800&display=swap";
    link.rel = "stylesheet"; document.head.appendChild(link);
    (async()=>{
      const [p,g,f,w,wt,ft,sl,tmpl,sg,mf,ch] = await Promise.all([
        db.get("nt_profile",   DEFAULTS.profile),
        db.get("nt_goals",     DEFAULTS.goals),
        db.get("nt_foodLog",   {}),
        db.get("nt_weightLog", []),
        db.get("nt_waterLog",  {}),
        db.get("nt_fitnessLog",{}),
        db.get("nt_stepsLog",  {}),
        db.get("nt_templates", []),
        db.get("nt_shortGoals",[]),
        db.get("nt_myFoods",   []),
        db.get("nt_chat",      []),
      ]);
      setProfile(p); setGoals(g); setFoodLog(f); setWeightLog(w);
      // Try KV first — has the synced cross-device data
      const kv = await loadFromKV();
      const src = kv || {};
      setProfile(  src.profile    || p);
      setGoals(    src.goals      || g);
      setFoodLog(  src.foodLog    || f);
      setWeightLog(src.weightLog  || w);
      setWaterLog( src.waterLog   || wt);
      setFitnessLog(src.fitnessLog|| ft);
      setStepsLog( src.stepsLog   || sl);
      setTemplates(src.templates  || tmpl);
      setShortGoals(src.shortGoals|| sg);
      setMyFoods(  src.myFoods    || mf);
      if ((src.chat || ch).length > 0) setChatHistory(src.chat || ch);
      setReady(true);
    })();
  },[]);

  if (!ready) return (
    <div style={{background:"#0D1117",height:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",color:"#4ADE80",fontFamily:"sans-serif",gap:12}}>
      <div style={{fontSize:36}}>🌿</div>
      <div style={{fontSize:16}}>טוען נוטרי...</div>
      <div style={{fontSize:12,color:"#374151"}}>טוען נתונים שמורים</div>
    </div>
  );



  const TABS = [
    {id:"dashboard", icon:"🏠", label:"בית"},
    {id:"food",      icon:"🍽️", label:"אוכל"},
    {id:"fitness",   icon:"💪", label:"אימונים"},
    {id:"weight",    icon:"⚖️", label:"משקל"},
    {id:"goals",     icon:"🎯", label:"יעדים"},
    {id:"chat",      icon:"💬", label:"מאמן"},
    {id:"settings",  icon:"⚙️", label:"הגדרות"},
  ];

  return (
    <div style={{ fontFamily:"'Space Grotesk',system-ui,sans-serif", background:"#0D1117", color:"#E2E8F0", minHeight:"100vh", direction:"rtl" }}>
      {/* Top bar — sticky, mobile-friendly */}
      <div style={{ background:"#111827", borderBottom:"1px solid #1C2035", position:"sticky", top:0, zIndex:100 }}>
        <div style={{ maxWidth:760, margin:"0 auto", padding:"0 12px" }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 0 0" }}>
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <div style={{ width:30, height:30, borderRadius:"50%", background:"linear-gradient(135deg,#4ADE80,#818CF8)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:15, flexShrink:0 }}>🌿</div>
              <span style={{ fontSize:19, fontWeight:800, letterSpacing:"-0.5px" }}>נוטרי</span>

            </div>
            <div style={{display:"flex",alignItems:"center",gap:6}}>
              {/* Hidden file input for import */}
              <input type="file" accept=".json" style={{display:"none"}}
                onChange={e=>{
                  const file = e.target.files?.[0]; if(!file) return;
                  const reader = new FileReader();
                  reader.onload = async ev => {
                    try {
                      const d = JSON.parse(ev.target.result);
                      if (!d._version) { alert("קובץ לא תקין"); return; }
                      if (d.profile)    { setProfile(d.profile);     db.set("nt_profile",    d.profile); }
                      if (d.goals)      { setGoals(d.goals);         db.set("nt_goals",      d.goals); }
                      if (d.foodLog)    { setFoodLog(d.foodLog);     db.set("nt_foodLog",    d.foodLog); }
                      if (d.weightLog)  { setWeightLog(d.weightLog); db.set("nt_weightLog",  d.weightLog); }
                      if (d.waterLog)   { setWaterLog(d.waterLog);   db.set("nt_waterLog",   d.waterLog); }
                      if (d.fitnessLog) { setFitnessLog(d.fitnessLog); db.set("nt_fitnessLog",d.fitnessLog); }
                      if (d.stepsLog)   { setStepsLog(d.stepsLog);   db.set("nt_stepsLog",   d.stepsLog); }
                      if (d.templates)  { setTemplates(d.templates); db.set("nt_templates",  d.templates); }
                      if (d.myFoods)    { setMyFoods(d.myFoods);     db.set("nt_myFoods",    d.myFoods); }
                      if (d.shortGoals) { setShortGoals(d.shortGoals); db.set("nt_shortGoals",d.shortGoals); }
                      alert(`✅ נתונים יובאו בהצלחה!\nנשמר: ${d._exported?.slice(0,10) || "לא ידוע"}`);
                    } catch { alert("שגיאה בקריאת הקובץ"); }
                    e.target.value = "";
                  };
                  reader.readAsText(file);
                }}/>
              <button onClick={()=>document.getElementById('nutri-import-input')?.click()}
                style={{background:"rgba(96,165,250,0.1)",border:"1px solid rgba(96,165,250,0.25)",borderRadius:7,padding:"4px 10px",cursor:"pointer",fontSize:11,color:"#60A5FA",fontFamily:"inherit"}}>
                📂
              </button>
              <button onClick={async()=>{
                const keys=['profile','goals','foodLog','weightLog','waterLog','fitnessLog','stepsLog','templates','myFoods','shortGoals'];
                const data={};
                keys.forEach(k=>{try{const v=localStorage.getItem('nt_'+k);if(v)data[k]=JSON.parse(v);}catch{}});
                const btn=document.getElementById('nutri-sync-btn');
                if(btn){btn.textContent='⏳';btn.disabled=true;}
                try{
                  const r=await fetch('/api/data',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({uid:getUID(),data})});
                  const j=await r.json();
                  if(btn){btn.textContent=j.ok?'✅ נשמר':'❌ '+(j.detail||j.error||j.status||'שגיאה');setTimeout(()=>{if(btn){btn.textContent='☁️ שמור';btn.disabled=false;}},4000);}
                }catch(e){
                  if(btn){btn.textContent='❌ '+e.message.slice(0,15);setTimeout(()=>{if(btn){btn.textContent='☁️ שמור';btn.disabled=false;}},3000);}
                }
              }} id="nutri-sync-btn"
                style={{background:"rgba(74,222,128,0.1)",border:"1px solid rgba(74,222,128,0.25)",borderRadius:7,padding:"4px 10px",cursor:"pointer",fontSize:11,color:"#4ADE80",fontFamily:"inherit"}}>
                ☁️ שמור
              </button>
              <button onClick={()=>exportAllData(profile,goals,foodLog,weightLog,waterLog,fitnessLog,stepsLog,templates,myFoods,shortGoals)}
                style={{background:"rgba(96,165,250,0.1)",border:"1px solid rgba(96,165,250,0.25)",borderRadius:7,padding:"4px 10px",cursor:"pointer",fontSize:11,color:"#60A5FA",fontFamily:"inherit"}}>
                💾
              </button>
            </div>
          </div>
          {/* Tab bar — scrollable on mobile */}
          <div style={{ display:"flex", gap:0, overflowX:"auto", marginTop:4, WebkitOverflowScrolling:"touch" }}>
            {TABS.map(t=>(
              <button key={t.id} onClick={()=>setTab(t.id)} style={{
                background:"none", border:"none", cursor:"pointer",
                padding:"8px 10px", fontSize:12, fontWeight:600,
                color:tab===t.id?"#4ADE80":"#4B5568",
                borderBottom:`2px solid ${tab===t.id?"#4ADE80":"transparent"}`,
                whiteSpace:"nowrap", transition:"color .2s",
                display:"flex", alignItems:"center", gap:3,
                fontFamily:"inherit", flexShrink:0,
              }}>
                <span style={{fontSize:14}}>{t.icon}</span> {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Page content */}
      <div style={{ padding:"16px 14px", maxWidth:760, margin:"0 auto", paddingBottom:48 }}>
        {tab==="dashboard" && <Dashboard profile={profile} goals={goals} foodLog={foodLog} weightLog={weightLog} waterLog={waterLog} fitnessLog={fitnessLog} stepsLog={stepsLog} setWaterLog={setWaterLog}/>}
        {tab==="food"      && <FoodLog   foodLog={foodLog} setFoodLog={setFoodLog} goals={goals} templates={templates} setTemplates={setTemplates} fitnessLog={fitnessLog} myFoods={myFoods} setMyFoods={setMyFoods}/>}
        {tab==="fitness"   && <FitnessLog fitnessLog={fitnessLog} setFitnessLog={setFitnessLog} weightLog={weightLog} profile={profile} stepsLog={stepsLog} setStepsLog={setStepsLog}/>}
        {tab==="weight"    && <WeightTab profile={profile} setProfile={setProfile} weightLog={weightLog} setWeightLog={setWeightLog}/>}
        {tab==="goals"     && <GoalsTab   profile={profile} goals={goals} foodLog={foodLog} weightLog={weightLog} fitnessLog={fitnessLog} shortGoals={shortGoals} setShortGoals={setShortGoals}/>}
        {tab==="chat"      && <ChatTab   profile={profile} goals={goals} foodLog={foodLog} setFoodLog={setFoodLog} weightLog={weightLog} fitnessLog={fitnessLog} stepsLog={stepsLog} myFoods={myFoods} setMyFoods={setMyFoods} chatHistory={chatHistory} setChatHistory={setChatHistory}/>}
        {tab==="settings"  && <Settings  profile={profile} setProfile={setProfile} goals={goals} setGoals={setGoals}/>}
      </div>
    </div>
  );
}

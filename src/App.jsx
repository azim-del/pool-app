import { useState, useEffect, useCallback, useRef } from "react";
import { supabase, supabaseConfigured } from "./supabase";

// ── Supabase row <-> app shape ────────────────────────────────────────────────
const historyFromDb = (row) => ({
  id: row.id,
  date: row.date || row.created_at,
  readings: row.readings || {},
  poolVolume: row.pool_volume,
  notes: row.notes || "",
  actionLog: row.action_log || {},
});

const purchaseFromDb = (row) => ({
  id: row.id,
  date: row.date || "",
  product: row.product || "",
  brand: row.brand || "",
  quantity: row.quantity || "",
  unit: row.unit || "lbs",
  price: row.price || "",
  store: row.store || "",
  notes: row.notes || "",
});

const purchaseToDb = (p) => ({
  date: p.date, product: p.product, brand: p.brand, quantity: p.quantity,
  unit: p.unit, price: p.price, store: p.store, notes: p.notes,
});

// Older builds kept everything in this browser's localStorage. On first load
// after the Supabase switch, upload whatever is here once, then clear it.
async function migrateLocalStorage() {
  const read = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key) || fallback); } catch { return JSON.parse(fallback); }
  };
  const oldHistory = read("pool_history", "[]");
  const oldPurchases = read("pool_purchases", "[]");
  const oldMaintenance = read("pool_maintenance", "{}");

  if (oldHistory.length) {
    const rows = oldHistory.map(h => ({
      created_at: h.date, date: h.date, readings: h.readings,
      pool_volume: h.poolVolume, notes: h.notes || "", action_log: h.actionLog || {},
    }));
    const { error } = await supabase.from("test_history").insert(rows);
    if (error) throw error;
    localStorage.removeItem("pool_history");
  }

  if (oldPurchases.length) {
    const rows = oldPurchases.map(p => ({
      ...purchaseToDb(p),
      // old purchase ids were Date.now() timestamps — reuse them to keep the order
      ...(typeof p.id === "number" ? { created_at: new Date(p.id).toISOString() } : {}),
    }));
    const { error } = await supabase.from("purchases").insert(rows);
    if (error) throw error;
    localStorage.removeItem("pool_purchases");
  }

  const taskIds = Object.keys(oldMaintenance);
  if (taskIds.length) {
    // only push a local date if it's newer than what another device already saved
    const { data: remote, error: readErr } = await supabase.from("maintenance_logs").select("*");
    if (readErr) throw readErr;
    const remoteMap = Object.fromEntries((remote || []).map(r => [r.task_id, r.last_done]));
    const rows = taskIds
      .filter(id => !remoteMap[id] || new Date(oldMaintenance[id]) > new Date(remoteMap[id]))
      .map(id => ({ task_id: id, last_done: oldMaintenance[id] }));
    if (rows.length) {
      const { error } = await supabase.from("maintenance_logs").upsert(rows);
      if (error) throw error;
    }
    localStorage.removeItem("pool_maintenance");
  }
}

const POOL_IDEAL = {
  ph: { min: 7.2, max: 7.6, ideal: 7.4, unit: "" },
  chlorine: { min: 1.0, max: 3.0, ideal: 2.0, unit: "ppm" },
  alkalinity: { min: 80, max: 120, ideal: 100, unit: "ppm" },
  hardness: { min: 200, max: 400, ideal: 300, unit: "ppm" },
  cyanuric: { min: 30, max: 50, ideal: 40, unit: "ppm" },
};

const MAINTENANCE_TASKS = [
  { id: "skimmer", label: "Clean Skimmer Basket", intervalDays: 3, icon: "🧺" },
  { id: "brush", label: "Brush Pool Walls", intervalDays: 7, icon: "🖌️" },
  { id: "vacuum", label: "Vacuum Pool Floor", intervalDays: 7, icon: "🌊" },
  { id: "filter", label: "Deep Clean Filter", intervalDays: 180, icon: "⚙️" },
];

const POOL_VOLUMES = [
  { label: "Small (5,000 gal)", value: 5000 },
  { label: "Medium (10,000 gal)", value: 10000 },
  { label: "Large (15,000 gal)", value: 15000 },
  { label: "XL (20,000 gal)", value: 20000 },
  { label: "Custom", value: "custom" },
];

function getStatus(param, value) {
  const r = POOL_IDEAL[param];
  if (value < r.min) return "low";
  if (value > r.max) return "high";
  return "ok";
}

function getStatusColor(status) {
  if (status === "ok") return "#22c55e";
  if (status === "low") return "#f59e0b";
  return "#ef4444";
}

function computeRecommendations(readings, poolVolume) {
  // Returns an ordered array of steps — priority 1 first, then 2, etc.
  // Each step has: { stepLabel, title, badge, chemical, amount, waitAfter, instruction, urgent, color }
  const steps = [];
  const vol = poolVolume / 10000;

  const ph  = readings.ph          !== "" ? parseFloat(readings.ph)          : null;
  const cl  = readings.chlorine    !== "" ? parseFloat(readings.chlorine)    : null;
  const alk = readings.alkalinity  !== "" ? parseFloat(readings.alkalinity)  : null;
  const hard= readings.hardness    !== "" ? parseFloat(readings.hardness)    : null;
  const cya = readings.cyanuric    !== "" ? parseFloat(readings.cyanuric)    : null;

  const phStatus  = ph  !== null ? getStatus("ph",         ph)  : null;
  const clStatus  = cl  !== null ? getStatus("chlorine",   cl)  : null;
  const alkStatus = alk !== null ? getStatus("alkalinity", alk) : null;
  const hardStatus= hard!== null ? getStatus("hardness",   hard): null;
  const cyaStatus = cya !== null ? getStatus("cyanuric",   cya) : null;

  const bothLow = phStatus === "low" && alkStatus === "low";

  // ── STEP: Chlorine — always first if zero or dangerously low ──
  if (cl !== null && clStatus === "low") {
    const urgent = cl === 0;
    const deficit = 2.0 - cl;
    // Liquid chlorine (10% sodium hypochlorite): ~10 oz raises chlorine ~1 ppm per 10,000 gal
    const liquidOz = Math.round(deficit * 10 * vol);
    // Tablets for maintenance top-up only (when not critically low)
    const tablets = Math.max(1, Math.ceil(deficit * vol));
    if (urgent) {
      steps.push({
        title: "⚠️ Add Liquid Chlorine — Pool is unprotected!",
        badge: `Currently: ${cl} ppm — Target: 1–3 ppm`,
        chemical: "Liquid Chlorine (Sodium Hypochlorite, 10%)",
        amount: `${liquidOz} oz (~${(liquidOz / 128).toFixed(1)} gallon)`,
        waitAfter: "Wait 2–4 hours, then retest. Once above 1 ppm, add a maintenance tablet to keep it there.",
        instruction: `Your chlorine is at zero — the pool is not safe to swim in right now. Pour ${liquidOz} oz of liquid chlorine (sold as pool chlorine or sodium hypochlorite) slowly around the edges of the pool with the pump running. Wear gloves and avoid splashing. Liquid chlorine works fast — retest in a few hours rather than waiting a full day.`,
        urgent: true,
        color: "#ef4444",
      });
    } else {
      steps.push({
        title: "Top Up Chlorine",
        badge: `Currently: ${cl} ppm — Target: 1–3 ppm`,
        chemical: "Trichlor Tablet (3\" tablet) — for slow, steady top-up",
        amount: `${tablets} tablet${tablets !== 1 ? "s" : ""}`,
        waitAfter: "Wait 24 hours, then retest chlorine.",
        instruction: `Your chlorine is a little low but not at zero, so a slow-dissolving tablet is fine here. Drop ${tablets} tablet${tablets !== 1 ? "s" : ""} into the skimmer basket or floater with the pump running. Don't touch the tablet with bare hands — use the container lid or gloves. If you need a faster correction, you can use liquid chlorine instead (about ${liquidOz} oz).`,
        urgent: false,
        color: "#f59e0b",
      });
    }
  } else if (cl !== null && clStatus === "high") {
    steps.push({
      title: "Chlorine is too high — don't swim yet",
      badge: `Currently: ${cl} ppm — Target: 1–3 ppm`,
      chemical: "Nothing to add",
      amount: "—",
      waitAfter: "Retest in 24–48 hours.",
      instruction: "Leave the pool alone. Sun and time will bring the chlorine level down naturally. Don't add any more chlorine products until it drops below 3 ppm.",
      urgent: true,
      color: "#ef4444",
    });
  }

  // ── STEP: Alkalinity ──
  if (alk !== null && alkStatus === "low") {
    const deficit = 100 - alk;
    const lbs = parseFloat(((deficit / 10) * 1.5 * vol).toFixed(2));
    steps.push({
      title: bothLow ? "Add Alkalinity Increaser (this will also help raise your pH)" : "Add Alkalinity Increaser",
      badge: `Currently: ${alk} ppm — Target: 80–120 ppm`,
      chemical: "Sodium Bicarbonate (sold as \"Alkalinity Increaser\" or baking soda)",
      amount: `${lbs} lbs`,
      waitAfter: bothLow ? "Wait 24 hours, then retest BOTH alkalinity and pH before doing anything else." : "Wait 24 hours, then retest alkalinity.",
      instruction: `Measure out ${lbs} lbs. With the pump running, walk around the pool and sprinkle it evenly across the surface. Don't dump it all in one spot.${bothLow ? " Since your pH is also low, this product will help fix both — wait and retest before adding anything else." : ""}`,
      urgent: false,
      color: "#f59e0b",
    });
  } else if (alk !== null && alkStatus === "high") {
    const excess = alk - 100;
    const lbs = parseFloat(((excess / 10) * 2.0 * vol).toFixed(2));
    steps.push({
      title: "Lower Alkalinity",
      badge: `Currently: ${alk} ppm — Target: 80–120 ppm`,
      chemical: "pH Decreaser (Sodium Bisulfate / Dry Acid)",
      amount: `${lbs} lbs`,
      waitAfter: "Wait 24 hours, then retest alkalinity AND pH.",
      instruction: `Fill a bucket with pool water, then slowly pour in ${lbs} lbs of pH decreaser and stir. Pour the bucket near the return jets with the pump running. This will also lower your pH a little, so retest both.`,
      urgent: false,
      color: "#ef4444",
    });
  }

  // ── STEP: pH — only show as separate step if alkalinity doesn't already cover it ──
  if (ph !== null) {
    if (phStatus === "low" && !bothLow) {
      const deficit = 7.4 - ph;
      const lbs = parseFloat(((deficit / 0.2) * (6 / 16) * vol).toFixed(2));
      steps.push({
        title: "Raise the pH",
        badge: `Currently: ${ph} — Target: 7.2–7.6`,
        chemical: "pH Increaser (Sodium Carbonate / Soda Ash)",
        amount: `${lbs} lbs`,
        waitAfter: "Wait 4–6 hours, then retest pH.",
        instruction: `Fill a bucket with pool water, add ${lbs} lbs of pH Increaser, and stir until dissolved. Pour it slowly in front of a return jet with the pump running. Don't add it directly to the skimmer.`,
        urgent: false,
        color: "#f59e0b",
      });
    } else if (phStatus === "low" && bothLow) {
      // Already covered by alkalinity step — add a reminder note instead
      steps.push({
        title: "Recheck pH after alkalinity treatment",
        badge: `Currently: ${ph} — Target: 7.2–7.6`,
        chemical: "Nothing yet — wait and retest first",
        amount: "—",
        waitAfter: "Only act on pH after you've retested following the alkalinity step.",
        instruction: "Your pH is low, but the alkalinity treatment you just did will likely bring it up too. Retest pH after 24 hours. If it's still below 7.2, come back and run a new test — the app will tell you exactly what to add then.",
        urgent: false,
        color: "#f59e0b",
      });
    } else if (phStatus === "high") {
      const excess = ph - 7.4;
      const lbs = parseFloat(((excess / 0.2) * (6 / 16) * vol).toFixed(2));
      steps.push({
        title: "Lower the pH",
        badge: `Currently: ${ph} — Target: 7.2–7.6`,
        chemical: "pH Decreaser (Sodium Bisulfate / Dry Acid)",
        amount: `${lbs} lbs`,
        waitAfter: "Wait 4–6 hours, then retest pH.",
        instruction: `Fill a bucket with pool water, add ${lbs} lbs of pH Decreaser, and stir. Pour it slowly near a return jet with the pump running. Never add dry acid directly to the pool.`,
        urgent: false,
        color: "#ef4444",
      });
    }
  }

  // ── STEP: Calcium Hardness ──
  if (hard !== null && hardStatus === "low") {
    const deficit = 300 - hard;
    const lbs = parseFloat(((deficit / 10) * 1.25 * vol).toFixed(2));
    steps.push({
      title: "Raise Calcium Hardness",
      badge: `Currently: ${hard} ppm — Target: 200–400 ppm`,
      chemical: "Calcium Hardness Increaser (Calcium Chloride)",
      amount: `${lbs} lbs`,
      waitAfter: "Wait 24 hours, then retest.",
      instruction: `Pre-dissolve ${lbs} lbs in a bucket of water (it will get warm — that's normal). Add it slowly near the return jets. Add in two stages if the deficit is large — add half today, retest tomorrow, then add more if needed.`,
      urgent: false,
      color: "#f59e0b",
    });
  } else if (hard !== null && hardStatus === "high") {
    steps.push({
      title: "Lower Calcium Hardness",
      badge: `Currently: ${hard} ppm — Target: 200–400 ppm`,
      chemical: "Partial water replacement (no chemical fix)",
      amount: "Replace 25–33% of pool water",
      waitAfter: "Refill, run pump for 2 hours, then retest.",
      instruction: "There's no chemical that lowers hardness. You'll need to drain about a quarter of the pool and refill with fresh water. If your tap water is also very hard, this may need to be done in stages.",
      urgent: false,
      color: "#ef4444",
    });
  }

  // ── STEP: Cyanuric Acid ──
  if (cya !== null && cyaStatus === "low") {
    const deficit = 40 - cya;
    const lbs = parseFloat(((deficit / 10) * 1.1 * vol).toFixed(2));
    steps.push({
      title: "Add Pool Stabilizer",
      badge: `Currently: ${cya} ppm — Target: 30–50 ppm`,
      chemical: "Cyanuric Acid (sold as \"Pool Stabilizer\" or \"Conditioner\")",
      amount: `${lbs} lbs`,
      waitAfter: "Wait 48 hours — it's slow to dissolve. Then retest.",
      instruction: `Pre-dissolve ${lbs} lbs in a bucket of warm water. Pour slowly into the skimmer with the pump running. It takes 24–48 hours to fully show up in a test, so don't add more before retesting.`,
      urgent: false,
      color: "#f59e0b",
    });
  } else if (cya !== null && cyaStatus === "high") {
    steps.push({
      title: "Lower Pool Stabilizer (CYA)",
      badge: `Currently: ${cya} ppm — Target: 30–50 ppm`,
      chemical: "Partial water replacement (no chemical fix)",
      amount: "Replace 30–50% of pool water",
      waitAfter: "Refill, run pump for 2 hours, then retest.",
      instruction: "There's no chemical that removes CYA. Drain about a third of the pool and refill with fresh water. High CYA makes your chlorine less effective even when the chlorine level looks fine — so it's worth fixing.",
      urgent: false,
      color: "#ef4444",
    });
  }

  return steps;
}

// ── AI Recommendations ────────────────────────────────────────────────────────
async function fetchAIRecommendations(readings, poolVolume, history) {
  const historySnippet = history.slice(0, 3).map(h => {
    const d = new Date(h.date).toLocaleDateString();
    return `${d}: pH ${h.readings.ph}, Cl ${h.readings.chlorine} ppm, Alk ${h.readings.alkalinity} ppm`;
  }).join("\n");

  const prompt = `You are an expert pool technician. A pool owner has the following water test results for their ${poolVolume}-gallon pool:
- pH: ${readings.ph || "not tested"}
- Free Chlorine: ${readings.chlorine || "not tested"} ppm
- Total Alkalinity: ${readings.alkalinity || "not tested"} ppm
- Calcium Hardness: ${readings.hardness || "not tested"} ppm
- Cyanuric Acid: ${readings.cyanuric || "not tested"} ppm

Recent history (most recent first):
${historySnippet || "No prior history"}

Provide:
1. A brief overall assessment (2-3 sentences)
2. 2-3 specific actionable tips based on the patterns you see
3. Any safety warnings if parameters are dangerously out of range

Be concise, practical, and conversational. Use plain language. Keep total response under 200 words.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await response.json();
  return data.content?.[0]?.text || "Unable to fetch AI analysis.";
}

// Ensure viewport meta is set for mobile
if (typeof document !== "undefined") {
  let meta = document.querySelector('meta[name="viewport"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "viewport";
    document.head.appendChild(meta);
  }
  meta.content = "width=device-width, initial-scale=1, viewport-fit=cover";
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function PoolApp() {
  const [tab, setTab] = useState("test");
  const [readings, setReadings] = useState({ ph: "", chlorine: "", alkalinity: "", hardness: "", cyanuric: "" });
  const [poolVolume, setPoolVolume] = useState(5000);
  const [customVolume, setCustomVolume] = useState("");
  const [recommendations, setRecommendations] = useState(null);
  const [aiAnalysis, setAiAnalysis] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [history, setHistory] = useState([]);
  const [maintenanceLogs, setMaintenanceLogs] = useState({}); // { taskId: ISO date }
  const [notes, setNotes] = useState("");
  const [showHistory, setShowHistory] = useState(null);
  const [actionLog, setActionLog] = useState({}); // { stepIndex: { done: bool, comment: string } }
  const [currentEntryId, setCurrentEntryId] = useState(null); // Supabase id of the test the Results tab is showing
  const [purchases, setPurchases] = useState([]);
  const [newPurchase, setNewPurchase] = useState({ date: new Date().toISOString().slice(0,10), product: "", brand: "", quantity: "", unit: "lbs", price: "", store: "", notes: "" });
  const [showPurchaseForm, setShowPurchaseForm] = useState(false);
  const [editingHistory, setEditingHistory] = useState(null); // index of entry being edited
  const [editDraft, setEditDraft] = useState(null); // draft copy of the entry
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const commentTimer = useRef(null);

  const reportSaveError = (err) => {
    console.error(err);
    setSaveError("Couldn't save to the cloud — check your internet connection and try again.");
  };

  // ── Load everything from Supabase ──
  const loadAll = useCallback(async ({ silent = false } = {}) => {
    if (!supabaseConfigured) {
      setLoadError("Supabase isn't configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to your environment variables.");
      setLoading(false);
      return;
    }
    if (!silent) setLoading(true);
    try {
      const [h, p, m] = await Promise.all([
        supabase.from("test_history").select("*").order("created_at", { ascending: false }),
        supabase.from("purchases").select("*").order("created_at", { ascending: false }),
        supabase.from("maintenance_logs").select("*"),
      ]);
      const err = h.error || p.error || m.error;
      if (err) throw err;
      setHistory((h.data || []).map(historyFromDb));
      setPurchases((p.data || []).map(purchaseFromDb));
      setMaintenanceLogs(Object.fromEntries((m.data || []).map(r => [r.task_id, r.last_done])));
      setLoadError("");
    } catch (err) {
      console.error(err);
      if (!silent) setLoadError("Couldn't load your pool data. Check your internet connection and try again.");
    }
    if (!silent) setLoading(false);
  }, []);

  // On first open: move any old on-device data up to Supabase, then load.
  useEffect(() => {
    (async () => {
      if (supabaseConfigured) {
        try { await migrateLocalStorage(); }
        catch (err) { console.error("localStorage import failed — will retry next load", err); }
      }
      await loadAll();
    })();
  }, [loadAll]);

  // Refresh quietly when the app comes back to the foreground, so everyone sees each other's updates.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") loadAll({ silent: true }); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [loadAll]);

  const effectiveVolume = poolVolume === "custom" ? (parseInt(customVolume) || 5000) : poolVolume;

  const handleAnalyze = useCallback(async () => {
    const recs = computeRecommendations(readings, effectiveVolume);
    setRecommendations(recs);
    setAiAnalysis("");
    setActionLog({});
    setCurrentEntryId(null);
    setSaveError("");

    const entry = {
      date: new Date().toISOString(),
      readings: { ...readings },
      poolVolume: effectiveVolume,
      notes,
      actionLog: {},
    };

    setSaving(true);
    let newHistory = [entry, ...history];
    const { data, error } = await supabase.from("test_history")
      .insert([{ date: entry.date, readings: entry.readings, pool_volume: entry.poolVolume, notes: entry.notes, action_log: {} }])
      .select()
      .single();
    setSaving(false);
    if (error) {
      reportSaveError(error);
    } else {
      const saved = historyFromDb(data);
      newHistory = [saved, ...history];
      setHistory(newHistory);
      setCurrentEntryId(saved.id);
    }

    setTab("results");
    setAiLoading(true);
    try {
      const analysis = await fetchAIRecommendations(readings, effectiveVolume, newHistory);
      setAiAnalysis(analysis);
    } catch {
      setAiAnalysis("AI analysis unavailable. Using calculated recommendations above.");
    }
    setAiLoading(false);
  }, [readings, effectiveVolume, notes, history]);

  const logMaintenance = async (taskId) => {
    const now = new Date().toISOString();
    const previous = maintenanceLogs[taskId];
    setMaintenanceLogs(prev => ({ ...prev, [taskId]: now }));
    const { error } = await supabase.from("maintenance_logs").upsert({ task_id: taskId, last_done: now });
    if (error) {
      reportSaveError(error);
      setMaintenanceLogs(prev => {
        const copy = { ...prev };
        if (previous) copy[taskId] = previous; else delete copy[taskId];
        return copy;
      });
    }
  };

  const getDaysOverdue = (taskId) => {
    const task = MAINTENANCE_TASKS.find(t => t.id === taskId);
    const last = maintenanceLogs[taskId];
    if (!last) return task.intervalDays; // never done
    const daysSince = Math.floor((Date.now() - new Date(last).getTime()) / 86400000);
    return daysSince - task.intervalDays;
  };

  // Save the Results-tab action log onto its test entry (local + Supabase)
  const persistActionLog = async (updated) => {
    if (!currentEntryId) return;
    setHistory(h => h.map(e => e.id === currentEntryId ? { ...e, actionLog: updated } : e));
    const { error } = await supabase.from("test_history").update({ action_log: updated }).eq("id", currentEntryId);
    if (error) reportSaveError(error);
  };

  const toggleStepDone = (i) => {
    const updated = { ...actionLog, [i]: { ...actionLog[i], done: !actionLog[i]?.done, comment: actionLog[i]?.comment || "" } };
    setActionLog(updated);
    clearTimeout(commentTimer.current);
    persistActionLog(updated);
  };

  const setStepComment = (i, comment) => {
    const updated = { ...actionLog, [i]: { ...actionLog[i], comment } };
    setActionLog(updated);
    // wait until they stop typing before saving
    clearTimeout(commentTimer.current);
    commentTimer.current = setTimeout(() => persistActionLog(updated), 700);
  };

  const deleteHistory = async (i) => {
    const entry = history[i];
    const { error } = await supabase.from("test_history").delete().eq("id", entry.id);
    if (error) { reportSaveError(error); return; }
    setHistory(prev => prev.filter(e => e.id !== entry.id));
    if (entry.id === currentEntryId) setCurrentEntryId(null);
    setShowHistory(null);
    setEditingHistory(null);
    setEditDraft(null);
  };

  const startEditHistory = (i) => {
    setEditingHistory(i);
    setEditDraft({ ...history[i], readings: { ...history[i].readings } });
  };

  const saveHistoryEdit = async () => {
    const draft = { ...editDraft };
    const { error } = await supabase.from("test_history")
      .update({ readings: draft.readings, notes: draft.notes })
      .eq("id", draft.id);
    if (error) { reportSaveError(error); return; }
    setHistory(prev => prev.map(e => e.id === draft.id ? draft : e));
    setEditingHistory(null);
    setEditDraft(null);
  };

  const addPurchase = async () => {
    if (!newPurchase.product) return;
    setSaving(true);
    const { data, error } = await supabase.from("purchases").insert([purchaseToDb(newPurchase)]).select().single();
    setSaving(false);
    if (error) { reportSaveError(error); return; }
    setPurchases(prev => [purchaseFromDb(data), ...prev]);
    setNewPurchase({ date: new Date().toISOString().slice(0,10), product: "", brand: "", quantity: "", unit: "lbs", price: "", store: "", notes: "" });
    setShowPurchaseForm(false);
  };

  const deletePurchase = async (id) => {
    const { error } = await supabase.from("purchases").delete().eq("id", id);
    if (error) { reportSaveError(error); return; }
    setPurchases(prev => prev.filter(p => p.id !== id));
  };

  const totalSpend = purchases.reduce((sum, p) => sum + (parseFloat(p.price) || 0), 0);

  const allReadingsEntered = Object.values(readings).some(v => v !== "");

  return (
    <div style={{
      minHeight: "100vh",
      minWidth: "100vw",
      background: "linear-gradient(135deg, #0a1628 0%, #0d2444 50%, #0a1628 100%)",
      backgroundAttachment: "fixed",
      fontFamily: "'DM Sans', 'Segoe UI', sans-serif",
      color: "#e8f4fd",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=Playfair+Display:wght@700&display=swap');
        html, body { margin: 0; padding: 0; min-height: 100%; background: #0a1628; }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #0a1628; }
        ::-webkit-scrollbar-thumb { background: #1e4a7a; border-radius: 3px; }
        input, textarea, select { outline: none; -webkit-appearance: none; }
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
        .tab-btn { transition: all 0.2s ease; -webkit-tap-highlight-color: transparent; }
        .card { backdrop-filter: blur(12px); }
        .param-input { transition: border-color 0.2s, box-shadow 0.2s; }
        .param-input:focus { border-color: #3b9eff !important; box-shadow: 0 0 0 3px rgba(59,158,255,0.15); }
        .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 6px 24px rgba(59,158,255,0.35); }
        .btn-primary { transition: all 0.2s; -webkit-tap-highlight-color: transparent; }
        .ripple:active { transform: scale(0.97); }
        .maintenance-card { transition: all 0.2s; -webkit-tap-highlight-color: transparent; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .fade-in { animation: fadeIn 0.4s ease forwards; }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
        .pulse { animation: pulse 1.5s infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .spinner { width: 40px; height: 40px; border-radius: 50%; border: 3px solid rgba(125,211,252,0.2); border-top-color: #7dd3fc; animation: spin 0.8s linear infinite; }

        /* ── Mobile bottom nav ── */
        .bottom-nav { display: none; }
        .top-tabs { display: flex; }
        @media (max-width: 640px) {
          .top-tabs { display: none; }
          .bottom-nav { display: flex; }
          .main-content { padding-bottom: 80px !important; }
        }
      `}</style>

      {/* Header */}
      <div style={{ background: "rgba(255,255,255,0.03)", borderBottom: "1px solid rgba(255,255,255,0.08)", padding: "14px 20px", display: "flex", alignItems: "center", gap: 12, position: "sticky", top: 0, zIndex: 100, backdropFilter: "blur(12px)" }}>
        <div style={{ fontSize: 26 }}>🏊</div>
        <div>
          <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, fontWeight: 700, color: "#7dd3fc", letterSpacing: "-0.3px" }}>PoolIQ</div>
          <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.5px", textTransform: "uppercase" }}>Smart Pool Management</div>
        </div>
        {/* Desktop tabs in header */}
        <div className="top-tabs" style={{ marginLeft: "auto", gap: 4 }}>
          {["test", "results", "maintenance", "history", "purchases"].map(t => (
            <button key={t} className="tab-btn" onClick={() => setTab(t)} style={{
              padding: "7px 14px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 500,
              background: tab === t ? "rgba(59,158,255,0.2)" : "transparent",
              color: tab === t ? "#7dd3fc" : "#64748b",
              borderBottom: tab === t ? "2px solid #3b9eff" : "2px solid transparent",
            }}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Mobile bottom nav */}
      <div className="bottom-nav" style={{
        position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 100,
        background: "#0d1f3c", borderTop: "1px solid rgba(255,255,255,0.1)",
        padding: "8px 0 20px",
        justifyContent: "space-around", alignItems: "center",
      }}>
        {[
          { id: "test", icon: "🧪", label: "Test" },
          { id: "results", icon: "📊", label: "Results" },
          { id: "maintenance", icon: "🔧", label: "Tasks" },
          { id: "history", icon: "📋", label: "History" },
          { id: "purchases", icon: "🛒", label: "Purchases" },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
            background: "none", border: "none", cursor: "pointer", padding: "4px 8px",
            color: tab === t.id ? "#7dd3fc" : "#475569",
          }}>
            <span style={{ fontSize: 20 }}>{t.icon}</span>
            <span style={{ fontSize: 10, fontWeight: tab === t.id ? 600 : 400 }}>{t.label}</span>
          </button>
        ))}
      </div>

      <div className="main-content" style={{ maxWidth: 820, margin: "0 auto", padding: "24px 16px" }}>

        {/* Save error banner */}
        {saveError && (
          <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.4)", borderRadius: 12, padding: "12px 16px", marginBottom: 16, display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 14, color: "#fca5a5" }}>⚠️ {saveError}</span>
            <button onClick={() => setSaveError("")} style={{ background: "none", border: "none", color: "#fca5a5", fontSize: 18, cursor: "pointer" }}>✕</button>
          </div>
        )}

        {/* Loading / load error */}
        {loading ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "100px 20px", gap: 16 }}>
            <div className="spinner" />
            <div style={{ fontSize: 14, color: "#64748b" }}>Loading your pool data…</div>
          </div>
        ) : loadError ? (
          <div style={{ textAlign: "center", padding: "60px 20px" }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>📡</div>
            <p style={{ color: "#fca5a5", fontSize: 15, marginBottom: 20 }}>{loadError}</p>
            {supabaseConfigured && (
              <button onClick={() => loadAll()} style={{ padding: "11px 24px", borderRadius: 10, border: "none", cursor: "pointer", background: "linear-gradient(135deg, #1d6fb8, #3b9eff)", color: "#fff", fontSize: 14, fontWeight: 600 }}>Try again</button>
            )}
          </div>
        ) : (<>

        {/* ── TEST TAB ── */}
        {tab === "test" && (
          <div className="fade-in">
            <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 700, marginBottom: 6, color: "#e8f4fd" }}>Water Test Entry</h2>
            <p style={{ color: "#64748b", fontSize: 14, marginBottom: 24 }}>Enter your at-home test kit readings below for chemical recommendations.</p>

            {/* Pool Volume */}
            <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: 20, marginBottom: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#7dd3fc", marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.5px" }}>Pool Size</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {POOL_VOLUMES.map(v => (
                  <button key={v.value} onClick={() => setPoolVolume(v.value)} style={{
                    padding: "8px 14px", borderRadius: 8, border: `1px solid ${poolVolume === v.value ? "#3b9eff" : "rgba(255,255,255,0.1)"}`,
                    background: poolVolume === v.value ? "rgba(59,158,255,0.15)" : "transparent",
                    color: poolVolume === v.value ? "#7dd3fc" : "#94a3b8", fontSize: 13, cursor: "pointer",
                  }}>{v.label}</button>
                ))}
              </div>
              {poolVolume === "custom" && (
                <input type="number" placeholder="Enter gallons…" value={customVolume} onChange={e => setCustomVolume(e.target.value)}
                  className="param-input" style={{ marginTop: 12, width: 200, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8, padding: "8px 12px", color: "#e8f4fd", fontSize: 14 }} />
              )}
            </div>

            {/* Readings */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 14, marginBottom: 20 }}>
              {Object.entries({ ph: "pH Level", chlorine: "Free Chlorine", alkalinity: "Total Alkalinity", hardness: "Calcium Hardness", cyanuric: "Cyanuric Acid (CYA)" }).map(([key, label]) => {
                const r = POOL_IDEAL[key];
                const val = readings[key];
                const status = val !== "" ? getStatus(key, parseFloat(val)) : null;
                return (
                  <div key={key} style={{ background: "rgba(255,255,255,0.04)", border: `${status && status !== "ok" ? "2px" : "1px"} solid ${status ? getStatusColor(status) + (status !== "ok" ? "99" : "44") : "rgba(255,255,255,0.08)"}`, borderRadius: 14, padding: 18 }}>
                    <div style={{ fontSize: 12, color: "#7dd3fc", marginBottom: 6, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>{label}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input type="number" step="0.1" placeholder={`${r.ideal}`} value={val}
                        onChange={e => setReadings(prev => ({ ...prev, [key]: e.target.value }))}
                        className="param-input" style={{ flex: 1, background: "transparent", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, padding: "10px 12px", color: "#e8f4fd", fontSize: 18, fontWeight: 500, width: "100%" }} />
                      {r.unit && <span style={{ color: "#64748b", fontSize: 12 }}>{r.unit}</span>}
                    </div>
                    <div style={{ marginTop: 8, fontSize: 11, color: "#475569" }}>Ideal: {r.min} – {r.max}{r.unit ? " " + r.unit : ""}</div>
                    {status && <div style={{ marginTop: 4, fontSize: 11, fontWeight: 600, color: getStatusColor(status) }}>{status === "ok" ? "✓ In range" : status === "low" ? "↓ Too low" : "↑ Too high"}</div>}
                  </div>
                );
              })}
            </div>

            {/* Notes */}
            <textarea placeholder="Optional notes (weather, recent swim activity, visible algae, etc.)" value={notes} onChange={e => setNotes(e.target.value)}
              style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: "14px 16px", color: "#94a3b8", fontSize: 14, resize: "vertical", minHeight: 80, fontFamily: "inherit", marginBottom: 20 }} />

            <button onClick={handleAnalyze} disabled={!allReadingsEntered || saving} className="btn-primary ripple" style={{
              width: "100%", padding: "16px", borderRadius: 12, border: "none", cursor: allReadingsEntered ? "pointer" : "not-allowed",
              background: allReadingsEntered ? "linear-gradient(135deg, #1d6fb8, #3b9eff)" : "rgba(255,255,255,0.05)",
              color: allReadingsEntered ? "#fff" : "#475569", fontSize: 16, fontWeight: 600, letterSpacing: "0.3px",
            }}>
              {saving ? "Saving…" : "🔬 Analyze & Get Recommendations"}
            </button>
          </div>
        )}

        {/* ── RESULTS TAB ── */}
        {tab === "results" && (
          <div className="fade-in">
            <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 700, marginBottom: 4 }}>What To Do</h2>
            <p style={{ color: "#64748b", fontSize: 14, marginBottom: 24 }}>Follow these steps in order — do one at a time and wait before moving to the next.</p>

            {!recommendations ? (
              <div style={{ textAlign: "center", padding: "60px 20px", color: "#475569" }}>
                <div style={{ fontSize: 48, marginBottom: 16 }}>🧪</div>
                <p>No test data yet. Go to the <strong style={{ color: "#7dd3fc", cursor: "pointer" }} onClick={() => setTab("test")}>Test tab</strong> to enter your readings.</p>
              </div>
            ) : recommendations.length === 0 ? (
              <div style={{ background: "rgba(34,197,94,0.08)", border: "2px solid rgba(34,197,94,0.3)", borderRadius: 16, padding: 32, textAlign: "center" }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: "#22c55e", marginBottom: 8 }}>Pool looks great!</div>
                <div style={{ fontSize: 15, color: "#94a3b8" }}>All your levels are in the safe zone. No chemicals needed right now. Test again in 3–5 days.</div>
              </div>
            ) : (
              <>
                {/* Safety banner if anything is urgent */}
                {recommendations.some(s => s.urgent) && (
                  <div style={{ background: "rgba(239,68,68,0.1)", border: "2px solid rgba(239,68,68,0.4)", borderRadius: 12, padding: "14px 18px", marginBottom: 20, display: "flex", gap: 12, alignItems: "center" }}>
                    <div style={{ fontSize: 22 }}>⚠️</div>
                    <div style={{ fontSize: 14, color: "#fca5a5", lineHeight: 1.5 }}>
                      <strong>Heads up:</strong> One or more readings need urgent attention. Don't swim until chlorine is above 1 ppm and pH is between 7.2–7.6.
                    </div>
                  </div>
                )}

                {/* Numbered Steps */}
                <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                  {recommendations.map((step, i) => (
                    <div key={i} style={{ display: "flex", gap: 0, marginBottom: 16 }}>
                      {/* Step number + connector line */}
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginRight: 16, minWidth: 36 }}>
                        <div style={{
                          width: 36, height: 36, borderRadius: "50%", flexShrink: 0,
                          background: step.urgent ? "#ef4444" : step.color,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: 16, fontWeight: 800, color: "#fff",
                        }}>{i + 1}</div>
                        {i < recommendations.length - 1 && (
                          <div style={{ width: 2, flex: 1, minHeight: 24, background: "rgba(255,255,255,0.08)", marginTop: 6 }} />
                        )}
                      </div>

                      {/* Step card */}
                      <div style={{ flex: 1, background: "rgba(255,255,255,0.04)", border: `2px solid ${step.color}33`, borderRadius: 14, padding: 20, borderLeft: `4px solid ${step.color}` }}>
                        {/* Title */}
                        <div style={{ fontSize: 17, fontWeight: 700, color: "#e8f4fd", marginBottom: 6 }}>{step.title}</div>

                        {/* Badge */}
                        <div style={{ display: "inline-block", padding: "3px 10px", borderRadius: 20, background: step.color + "22", color: step.color, fontSize: 12, fontWeight: 600, marginBottom: 14 }}>
                          {step.badge}
                        </div>

                        {/* Chemical + Amount box */}
                        {step.amount !== "—" && (
                          <div style={{ background: "rgba(0,0,0,0.25)", borderRadius: 10, padding: 14, marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                            <div>
                              <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4 }}>What to buy / use</div>
                              <div style={{ fontSize: 14, fontWeight: 600, color: "#e8f4fd" }}>{step.chemical}</div>
                            </div>
                            <div style={{ textAlign: "right" }}>
                              <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4 }}>How much</div>
                              <div style={{ fontSize: 22, fontWeight: 800, color: "#7dd3fc" }}>{step.amount}</div>
                            </div>
                          </div>
                        )}

                        {/* Instruction */}
                        <div style={{ fontSize: 14, color: "#cbd5e1", lineHeight: 1.7, marginBottom: 12 }}>
                          {step.instruction}
                        </div>

                        {/* Wait message */}
                        <div style={{ display: "flex", alignItems: "center", gap: 8, background: "rgba(255,255,255,0.04)", borderRadius: 8, padding: "10px 14px", marginBottom: 12 }}>
                          <span style={{ fontSize: 16 }}>⏱</span>
                          <span style={{ fontSize: 13, color: "#94a3b8", fontStyle: "italic" }}>{step.waitAfter}</span>
                        </div>

                        {/* Action log */}
                        <div style={{ borderTop: "1px solid rgba(255,255,255,0.07)", paddingTop: 12 }}>
                          <button onClick={() => toggleStepDone(i)} style={{
                            display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderRadius: 8, border: "none", cursor: "pointer",
                            background: actionLog[i]?.done ? "rgba(34,197,94,0.15)" : "rgba(255,255,255,0.06)",
                            color: actionLog[i]?.done ? "#22c55e" : "#94a3b8", fontSize: 13, fontWeight: 600, marginBottom: 8,
                          }}>
                            <span style={{ fontSize: 16 }}>{actionLog[i]?.done ? "✅" : "⬜"}</span>
                            {actionLog[i]?.done ? "Done — marked complete" : "Mark as done"}
                          </button>
                          {actionLog[i]?.done && (
                            <textarea
                              placeholder="Add a note (optional) — e.g. 'added 3.5 lbs, water looked cloudy after'"
                              value={actionLog[i]?.comment || ""}
                              onChange={e => setStepComment(i, e.target.value)}
                              style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: "10px 12px", color: "#cbd5e1", fontSize: 13, resize: "vertical", minHeight: 64, fontFamily: "inherit" }}
                            />
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Safety reminder */}
                <div style={{ marginTop: 8, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: "14px 18px", fontSize: 13, color: "#64748b", lineHeight: 1.6 }}>
                  🧤 <strong style={{ color: "#94a3b8" }}>Safety reminder:</strong> Never mix pool chemicals together. Always add chemicals to water, not water to chemicals. Wash hands after handling.
                </div>

                <button onClick={() => setTab("test")} style={{
                  marginTop: 16, width: "100%", padding: "13px", borderRadius: 12, border: "1px solid rgba(59,158,255,0.3)", cursor: "pointer",
                  background: "transparent", color: "#7dd3fc", fontSize: 14, fontWeight: 500,
                }}>+ Enter New Test</button>
              </>
            )}
          </div>
        )}

        {/* ── MAINTENANCE TAB ── */}
        {tab === "maintenance" && (
          <div className="fade-in">
            <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 700, marginBottom: 6 }}>Maintenance Tracker</h2>
            <p style={{ color: "#64748b", fontSize: 14, marginBottom: 24 }}>Log routine pool upkeep tasks and track what's due.</p>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
              {MAINTENANCE_TASKS.map(task => {
                const daysOverdue = getDaysOverdue(task.id);
                const isDue = daysOverdue >= 0;
                const last = maintenanceLogs[task.id];
                const daysSince = last ? Math.floor((Date.now() - new Date(last).getTime()) / 86400000) : null;

                return (
                  <div key={task.id} className="maintenance-card" style={{
                    background: "rgba(255,255,255,0.04)", border: `1px solid ${isDue ? "#ef444444" : "rgba(255,255,255,0.08)"}`, borderRadius: 16, padding: 20,
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
                      <div>
                        <div style={{ fontSize: 24, marginBottom: 6 }}>{task.icon}</div>
                        <div style={{ fontWeight: 600, fontSize: 15, color: "#e8f4fd" }}>{task.label}</div>
                        <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>Every {task.intervalDays} days</div>
                      </div>
                      <div style={{
                        padding: "4px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700,
                        background: isDue ? "rgba(239,68,68,0.15)" : "rgba(34,197,94,0.12)",
                        color: isDue ? "#ef4444" : "#22c55e",
                      }}>
                        {isDue ? `${daysOverdue === 0 ? "Due today" : `${daysOverdue}d overdue`}` : `${Math.abs(daysOverdue)}d left`}
                      </div>
                    </div>
                    {daysSince !== null && (
                      <div style={{ fontSize: 12, color: "#475569", marginBottom: 12 }}>
                        Last done: {daysSince === 0 ? "Today" : `${daysSince} day${daysSince !== 1 ? "s" : ""} ago`}
                      </div>
                    )}
                    {!last && <div style={{ fontSize: 12, color: "#475569", marginBottom: 12 }}>Never logged</div>}
                    <button onClick={() => logMaintenance(task.id)} style={{
                      width: "100%", padding: "9px", borderRadius: 9, border: "1px solid rgba(59,158,255,0.3)", cursor: "pointer",
                      background: "rgba(59,158,255,0.08)", color: "#7dd3fc", fontSize: 13, fontWeight: 500,
                    }}>✓ Mark Done</button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── HISTORY TAB ── */}
        {tab === "history" && (
          <div className="fade-in">
            <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 700, marginBottom: 6 }}>Test History</h2>
            <p style={{ color: "#64748b", fontSize: 14, marginBottom: 24 }}>{history.length} test{history.length !== 1 ? "s" : ""} recorded.</p>

            {history.length === 0 ? (
              <div style={{ textAlign: "center", padding: "60px 20px", color: "#475569" }}>
                <div style={{ fontSize: 48, marginBottom: 16 }}>📋</div>
                <p>No history yet. Your test results will appear here after your first analysis.</p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {history.map((entry, i) => {
                  const date = new Date(entry.date);
                  const allOk = Object.entries(entry.readings).every(([k, v]) => v === "" || getStatus(k, parseFloat(v)) === "ok");
                  const isEditing = editingHistory === i;
                  const labels = { ph: "pH", chlorine: "Chlorine", alkalinity: "Alkalinity", hardness: "Hardness", cyanuric: "CYA" };
                  return (
                    <div key={entry.id ?? i} style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${isEditing ? "rgba(59,158,255,0.3)" : "rgba(255,255,255,0.08)"}`, borderRadius: 14, overflow: "hidden" }}>
                      
                      {/* Header row */}
                      <div style={{ padding: "14px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}
                        onClick={() => !isEditing && setShowHistory(showHistory === i ? null : i)}>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 15 }}>{date.toLocaleDateString("en-US", { weekday: "short", month: "long", day: "numeric", year: "numeric" })}</div>
                          <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>{date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })} · {entry.poolVolume?.toLocaleString()} gal</div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }} onClick={e => e.stopPropagation()}>
                          <div style={{ width: 10, height: 10, borderRadius: "50%", background: allOk ? "#22c55e" : "#f59e0b" }}></div>
                          {/* Edit button */}
                          <button onClick={() => { isEditing ? (setEditingHistory(null), setEditDraft(null)) : startEditHistory(i); setShowHistory(i); }} style={{
                            padding: "4px 10px", borderRadius: 7, border: "1px solid rgba(59,158,255,0.3)", cursor: "pointer",
                            background: isEditing ? "rgba(59,158,255,0.15)" : "transparent", color: "#7dd3fc", fontSize: 12,
                          }}>✏️ {isEditing ? "Cancel" : "Edit"}</button>
                          {/* Delete button */}
                          <button onClick={() => { if (window.confirm("Delete this test entry?")) deleteHistory(i); }} style={{
                            padding: "4px 10px", borderRadius: 7, border: "1px solid rgba(239,68,68,0.3)", cursor: "pointer",
                            background: "transparent", color: "#ef4444", fontSize: 12,
                          }}>🗑 Delete</button>
                          <span onClick={() => setShowHistory(showHistory === i ? null : i)} style={{ color: "#64748b", fontSize: 18, cursor: "pointer" }}>{showHistory === i ? "▲" : "▼"}</span>
                        </div>
                      </div>

                      {/* Expanded view */}
                      {showHistory === i && (
                        <div style={{ padding: "0 20px 16px", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                          {isEditing ? (
                            /* ── Edit mode ── */
                            <div style={{ marginTop: 14 }}>
                              <div style={{ fontSize: 12, color: "#7dd3fc", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 12 }}>Edit Readings</div>
                              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10, marginBottom: 14 }}>
                                {Object.entries(labels).map(([key, label]) => (
                                  <div key={key}>
                                    <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>{label} {POOL_IDEAL[key].unit ? `(${POOL_IDEAL[key].unit})` : ""}</div>
                                    <input type="number" step="0.1" value={editDraft.readings[key]}
                                      onChange={e => setEditDraft(d => ({ ...d, readings: { ...d.readings, [key]: e.target.value } }))}
                                      style={{ width: "100%", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8, padding: "8px 10px", color: "#e8f4fd", fontSize: 15, fontFamily: "inherit" }} />
                                  </div>
                                ))}
                              </div>
                              <div style={{ marginBottom: 14 }}>
                                <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>Notes</div>
                                <input type="text" value={editDraft.notes || ""}
                                  onChange={e => setEditDraft(d => ({ ...d, notes: e.target.value }))}
                                  style={{ width: "100%", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8, padding: "8px 10px", color: "#e8f4fd", fontSize: 14, fontFamily: "inherit" }} />
                              </div>
                              <div style={{ display: "flex", gap: 8 }}>
                                <button onClick={saveHistoryEdit} style={{ padding: "8px 18px", borderRadius: 8, border: "none", cursor: "pointer", background: "linear-gradient(135deg, #1d6fb8, #3b9eff)", color: "#fff", fontSize: 13, fontWeight: 600 }}>Save Changes</button>
                                <button onClick={() => { setEditingHistory(null); setEditDraft(null); }} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", cursor: "pointer", background: "transparent", color: "#64748b", fontSize: 13 }}>Cancel</button>
                              </div>
                            </div>
                          ) : (
                            /* ── Read mode ── */
                            <>
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
                                {Object.entries(entry.readings).map(([key, val]) => {
                                  if (val === "") return null;
                                  const status = getStatus(key, parseFloat(val));
                                  return (
                                    <div key={key} style={{ padding: "6px 12px", borderRadius: 8, background: getStatusColor(status) + "15", border: `1px solid ${getStatusColor(status)}33` }}>
                                      <span style={{ fontSize: 11, color: "#64748b" }}>{labels[key]} </span>
                                      <span style={{ fontSize: 14, fontWeight: 600, color: getStatusColor(status) }}>{val}{POOL_IDEAL[key].unit ? " " + POOL_IDEAL[key].unit : ""}</span>
                                    </div>
                                  );
                                })}
                              </div>
                              {entry.notes && <div style={{ marginTop: 10, fontSize: 13, color: "#64748b", fontStyle: "italic" }}>"{entry.notes}"</div>}
                              {entry.actionLog && Object.keys(entry.actionLog).length > 0 && (
                                <div style={{ marginTop: 14 }}>
                                  <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 8 }}>Actions taken</div>
                                  {Object.entries(entry.actionLog).map(([idx, log]) => log.done && (
                                    <div key={idx} style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 6 }}>
                                      <span style={{ color: "#22c55e", fontSize: 14, marginTop: 1 }}>✓</span>
                                      <div>
                                        <div style={{ fontSize: 13, color: "#cbd5e1", fontWeight: 500 }}>Step {parseInt(idx) + 1}</div>
                                        {log.comment && <div style={{ fontSize: 12, color: "#64748b", fontStyle: "italic", marginTop: 2 }}>"{log.comment}"</div>}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {/* ── PURCHASES TAB ── */}
        {tab === "purchases" && (
          <div className="fade-in">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
              <div>
                <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 700, marginBottom: 4 }}>Purchase Tracker</h2>
                <p style={{ color: "#64748b", fontSize: 14 }}>{purchases.length} purchase{purchases.length !== 1 ? "s" : ""} · Total spent: <strong style={{ color: "#7dd3fc" }}>${totalSpend.toFixed(2)}</strong></p>
              </div>
              <button onClick={() => setShowPurchaseForm(f => !f)} style={{
                padding: "9px 18px", borderRadius: 10, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600,
                background: "linear-gradient(135deg, #1d6fb8, #3b9eff)", color: "#fff",
              }}>+ Add Purchase</button>
            </div>

            {/* Add Purchase Form */}
            {showPurchaseForm && (
              <div style={{ background: "rgba(59,158,255,0.06)", border: "1px solid rgba(59,158,255,0.2)", borderRadius: 16, padding: 20, marginTop: 20, marginBottom: 20 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#7dd3fc", marginBottom: 16 }}>New Purchase</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12, marginBottom: 12 }}>
                  {[
                    { key: "date", label: "Date", type: "date" },
                    { key: "product", label: "Product / Chemical *", type: "text", placeholder: "e.g. Alkalinity Increaser" },
                    { key: "brand", label: "Brand", type: "text", placeholder: "e.g. HTH, BioGuard" },
                    { key: "store", label: "Store", type: "text", placeholder: "e.g. Home Depot" },
                    { key: "price", label: "Price ($)", type: "number", placeholder: "0.00" },
                  ].map(f => (
                    <div key={f.key}>
                      <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 6 }}>{f.label}</div>
                      <input type={f.type} placeholder={f.placeholder || ""} value={newPurchase[f.key]}
                        onChange={e => setNewPurchase(p => ({ ...p, [f.key]: e.target.value }))}
                        style={{ width: "100%", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, padding: "9px 12px", color: "#e8f4fd", fontSize: 14, fontFamily: "inherit" }} />
                    </div>
                  ))}
                  <div>
                    <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 6 }}>Quantity</div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input type="number" placeholder="0" value={newPurchase.quantity}
                        onChange={e => setNewPurchase(p => ({ ...p, quantity: e.target.value }))}
                        style={{ flex: 1, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, padding: "9px 12px", color: "#e8f4fd", fontSize: 14, fontFamily: "inherit" }} />
                      <select value={newPurchase.unit} onChange={e => setNewPurchase(p => ({ ...p, unit: e.target.value }))}
                        style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, padding: "9px 10px", color: "#e8f4fd", fontSize: 13, cursor: "pointer" }}>
                        {["lbs", "oz", "gal", "L", "tablets", "bags", "bottles"].map(u => <option key={u} value={u} style={{ background: "#0d2444" }}>{u}</option>)}
                      </select>
                    </div>
                  </div>
                </div>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 6 }}>Notes</div>
                  <input type="text" placeholder="e.g. on sale, used half of bag" value={newPurchase.notes}
                    onChange={e => setNewPurchase(p => ({ ...p, notes: e.target.value }))}
                    style={{ width: "100%", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, padding: "9px 12px", color: "#e8f4fd", fontSize: 14, fontFamily: "inherit" }} />
                </div>
                <div style={{ display: "flex", gap: 10 }}>
                  <button onClick={addPurchase} disabled={saving} style={{ padding: "9px 20px", borderRadius: 9, border: "none", cursor: "pointer", background: "linear-gradient(135deg, #1d6fb8, #3b9eff)", color: "#fff", fontSize: 13, fontWeight: 600 }}>{saving ? "Saving…" : "Save Purchase"}</button>
                  <button onClick={() => setShowPurchaseForm(false)} style={{ padding: "9px 16px", borderRadius: 9, border: "1px solid rgba(255,255,255,0.1)", cursor: "pointer", background: "transparent", color: "#64748b", fontSize: 13 }}>Cancel</button>
                </div>
              </div>
            )}

            {/* Purchase List */}
            {purchases.length === 0 ? (
              <div style={{ textAlign: "center", padding: "60px 20px", color: "#475569", marginTop: 20 }}>
                <div style={{ fontSize: 48, marginBottom: 16 }}>🛒</div>
                <p>No purchases logged yet. Hit "+ Add Purchase" to start tracking.</p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 20 }}>
                {purchases.map((p) => (
                  <div key={p.id} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                        <div style={{ fontSize: 15, fontWeight: 700, color: "#e8f4fd" }}>{p.product}</div>
                        {p.brand && <div style={{ fontSize: 11, color: "#64748b", background: "rgba(255,255,255,0.06)", padding: "2px 8px", borderRadius: 10 }}>{p.brand}</div>}
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 13, color: "#64748b" }}>
                        <span>📅 {new Date(p.date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
                        {p.quantity && <span>📦 {p.quantity} {p.unit}</span>}
                        {p.store && <span>🏪 {p.store}</span>}
                        {p.notes && <span style={{ fontStyle: "italic" }}>"{p.notes}"</span>}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                      {p.price && <div style={{ fontSize: 20, fontWeight: 800, color: "#7dd3fc" }}>${parseFloat(p.price).toFixed(2)}</div>}
                      <button onClick={() => deletePurchase(p.id)} style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 7, padding: "5px 10px", color: "#ef4444", fontSize: 12, cursor: "pointer" }}>✕</button>
                    </div>
                  </div>
                ))}

                {/* Spend summary */}
                <div style={{ background: "rgba(59,158,255,0.06)", border: "1px solid rgba(59,158,255,0.15)", borderRadius: 12, padding: "14px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
                  <span style={{ fontSize: 14, color: "#64748b" }}>Total pool spend ({purchases.length} purchase{purchases.length !== 1 ? "s" : ""})</span>
                  <span style={{ fontSize: 22, fontWeight: 800, color: "#7dd3fc" }}>${totalSpend.toFixed(2)}</span>
                </div>
              </div>
            )}
          </div>
        )}

        </>)}
      </div>
    </div>
  );
}

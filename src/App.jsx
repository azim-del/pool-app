import { useState, useEffect, useCallback } from "react";

const POOL_IDEAL = {
  ph: { min: 7.2, max: 7.6, ideal: 7.4, unit: "" },
  chlorine: { min: 1.0, max: 3.0, ideal: 2.0, unit: "ppm" },
  alkalinity: { min: 80, max: 120, ideal: 100, unit: "ppm" },
  hardness: { min: 200, max: 400, ideal: 300, unit: "ppm" },
  cyanuric: { min: 30, max: 50, ideal: 40, unit: "ppm" },
};

const MAINTENANCE_TASKS = [
  { id: "backwash", label: "Backwash Filter", intervalDays: 7, icon: "🔄" },
  { id: "skimmer", label: "Clean Skimmer Basket", intervalDays: 3, icon: "🧺" },
  { id: "brush", label: "Brush Pool Walls", intervalDays: 7, icon: "🖌️" },
  { id: "vacuum", label: "Vacuum Pool Floor", intervalDays: 7, icon: "🌊" },
  { id: "filter", label: "Deep Clean Filter", intervalDays: 90, icon: "⚙️" },
  { id: "shock", label: "Shock Treatment", intervalDays: 14, icon: "⚡" },
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
  const recs = [];
  const vol = poolVolume / 1000; // per 1000 gallons

  if (readings.ph !== "") {
    const ph = parseFloat(readings.ph);
    const status = getStatus("ph", ph);
    if (status === "low") {
      const deficit = 7.4 - ph;
      const ozPerUnit = 6 * deficit * vol;
      recs.push({
        param: "pH",
        status: "low",
        current: ph,
        target: "7.2 – 7.6",
        chemical: "pH Increaser (Sodium Carbonate / Soda Ash)",
        amount: `${(ozPerUnit / 16).toFixed(2)} lbs`,
        note: "Add in front of return jets, wait 4 hours before retesting.",
        color: "#f59e0b",
      });
    } else if (status === "high") {
      const excess = ph - 7.4;
      const ozPerUnit = 5.5 * excess * vol;
      recs.push({
        param: "pH",
        status: "high",
        current: ph,
        target: "7.2 – 7.6",
        chemical: "pH Decreaser (Sodium Bisulfate / Dry Acid)",
        amount: `${(ozPerUnit / 16).toFixed(2)} lbs`,
        note: "Pre-dissolve in bucket of water before adding. Never mix chemicals.",
        color: "#ef4444",
      });
    }
  }

  if (readings.chlorine !== "") {
    const cl = parseFloat(readings.chlorine);
    const status = getStatus("chlorine", cl);
    if (status === "low") {
      const deficit = 2.0 - cl;
      const ozPerUnit = 2.5 * deficit * vol;
      recs.push({
        param: "Free Chlorine",
        status: "low",
        current: cl,
        target: "1 – 3 ppm",
        chemical: "Trichlor Tablets (3\")",
        amount: `${Math.ceil(ozPerUnit)} oz (~${Math.ceil(ozPerUnit / 8)} tablet${Math.ceil(ozPerUnit / 8) !== 1 ? "s" : ""})`,
        note: "Add to skimmer or floater. Test again in 24 hours.",
        color: "#f59e0b",
      });
    } else if (status === "high") {
      recs.push({
        param: "Free Chlorine",
        status: "high",
        current: cl,
        target: "1 – 3 ppm",
        chemical: "No chemicals needed",
        amount: "—",
        note: "Allow chlorine to naturally dissipate with sun exposure. Avoid adding more chlorine products for 48 hours.",
        color: "#ef4444",
      });
    }
  }

  if (readings.alkalinity !== "") {
    const alk = parseFloat(readings.alkalinity);
    const status = getStatus("alkalinity", alk);
    if (status === "low") {
      const deficit = 100 - alk;
      const lbsPerUnit = (deficit / 10) * 1.4 * vol;
      recs.push({
        param: "Total Alkalinity",
        status: "low",
        current: alk,
        target: "80 – 120 ppm",
        chemical: "Alkalinity Increaser (Sodium Bicarbonate / Baking Soda)",
        amount: `${lbsPerUnit.toFixed(2)} lbs`,
        note: "Broadcast evenly across pool surface with pump running.",
        color: "#f59e0b",
      });
    } else if (status === "high") {
      const excess = alk - 100;
      const lbsPerUnit = (excess / 10) * 1.6 * vol;
      recs.push({
        param: "Total Alkalinity",
        status: "high",
        current: alk,
        target: "80 – 120 ppm",
        chemical: "pH Decreaser (Sodium Bisulfate)",
        amount: `${lbsPerUnit.toFixed(2)} lbs`,
        note: "Add near return jets with pump running. Alkalinity adjustments affect pH—retest both.",
        color: "#ef4444",
      });
    }
  }

  if (readings.hardness !== "") {
    const hard = parseFloat(readings.hardness);
    const status = getStatus("hardness", hard);
    if (status === "low") {
      const deficit = 300 - hard;
      const lbsPerUnit = (deficit / 10) * 1.25 * vol;
      recs.push({
        param: "Calcium Hardness",
        status: "low",
        current: hard,
        target: "200 – 400 ppm",
        chemical: "Calcium Hardness Increaser (Calcium Chloride)",
        amount: `${lbsPerUnit.toFixed(2)} lbs`,
        note: "Pre-dissolve in bucket, add slowly. High hardness raises water temp—add in stages.",
        color: "#f59e0b",
      });
    } else if (status === "high") {
      recs.push({
        param: "Calcium Hardness",
        status: "high",
        current: hard,
        target: "200 – 400 ppm",
        chemical: "Partial Water Replacement",
        amount: "Replace 25 – 33% of pool water",
        note: "There is no chemical to reduce hardness. Drain and refill with fresh water is the only solution.",
        color: "#ef4444",
      });
    }
  }

  if (readings.cyanuric !== "") {
    const cya = parseFloat(readings.cyanuric);
    const status = getStatus("cyanuric", cya);
    if (status === "low") {
      const deficit = 40 - cya;
      const lbsPerUnit = (deficit / 10) * 1.1 * vol;
      recs.push({
        param: "Cyanuric Acid (Stabilizer)",
        status: "low",
        current: cya,
        target: "30 – 50 ppm",
        chemical: "Cyanuric Acid (Pool Stabilizer / Conditioner)",
        amount: `${lbsPerUnit.toFixed(2)} lbs`,
        note: "Pre-dissolve in warm water. Takes 24-48 hours to fully register in test.",
        color: "#f59e0b",
      });
    } else if (status === "high") {
      recs.push({
        param: "Cyanuric Acid (Stabilizer)",
        status: "high",
        current: cya,
        target: "30 – 50 ppm",
        chemical: "Partial Water Replacement",
        amount: "Replace 30 – 50% of pool water",
        note: "CYA cannot be chemically reduced. Partially drain and refill. High CYA locks chlorine, reducing effectiveness.",
        color: "#ef4444",
      });
    }
  }

  if (recs.length === 0) {
    recs.push({
      param: "All Parameters",
      status: "ok",
      chemical: "No chemicals needed",
      amount: "—",
      note: "Your pool chemistry is balanced. Keep up the great work! Test again in 3–5 days.",
      color: "#22c55e",
    });
  }

  return recs;
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

// ── Main App ──────────────────────────────────────────────────────────────────
export default function PoolApp() {
  const [tab, setTab] = useState("test");
  const [readings, setReadings] = useState({ ph: "", chlorine: "", alkalinity: "", hardness: "", cyanuric: "" });
  const [poolVolume, setPoolVolume] = useState(10000);
  const [customVolume, setCustomVolume] = useState("");
  const [recommendations, setRecommendations] = useState(null);
  const [aiAnalysis, setAiAnalysis] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem("pool_history") || "[]"); } catch { return []; }
  });
  const [maintenanceLogs, setMaintenanceLogs] = useState(() => {
    try { return JSON.parse(localStorage.getItem("pool_maintenance") || "{}"); } catch { return {}; }
  });
  const [notes, setNotes] = useState("");
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    localStorage.setItem("pool_history", JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    localStorage.setItem("pool_maintenance", JSON.stringify(maintenanceLogs));
  }, [maintenanceLogs]);

  const effectiveVolume = poolVolume === "custom" ? (parseInt(customVolume) || 10000) : poolVolume;

  const handleAnalyze = useCallback(async () => {
    const recs = computeRecommendations(readings, effectiveVolume);
    setRecommendations(recs);
    setAiAnalysis("");

    const entry = {
      date: new Date().toISOString(),
      readings: { ...readings },
      poolVolume: effectiveVolume,
      notes,
    };
    const newHistory = [entry, ...history].slice(0, 50);
    setHistory(newHistory);

    setAiLoading(true);
    try {
      const analysis = await fetchAIRecommendations(readings, effectiveVolume, newHistory);
      setAiAnalysis(analysis);
    } catch {
      setAiAnalysis("AI analysis unavailable. Using calculated recommendations above.");
    }
    setAiLoading(false);
    setTab("results");
  }, [readings, effectiveVolume, notes, history]);

  const logMaintenance = (taskId) => {
    setMaintenanceLogs(prev => ({ ...prev, [taskId]: new Date().toISOString() }));
  };

  const getDaysOverdue = (taskId) => {
    const task = MAINTENANCE_TASKS.find(t => t.id === taskId);
    const last = maintenanceLogs[taskId];
    if (!last) return task.intervalDays; // never done
    const daysSince = Math.floor((Date.now() - new Date(last).getTime()) / 86400000);
    return daysSince - task.intervalDays;
  };

  const allReadingsEntered = Object.values(readings).some(v => v !== "");

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(135deg, #0a1628 0%, #0d2444 50%, #0a1628 100%)",
      fontFamily: "'DM Sans', 'Segoe UI', sans-serif",
      color: "#e8f4fd",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=Playfair+Display:wght@700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #0a1628; }
        ::-webkit-scrollbar-thumb { background: #1e4a7a; border-radius: 3px; }
        input { outline: none; }
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
        .tab-btn { transition: all 0.2s ease; }
        .tab-btn:hover { opacity: 0.85; }
        .card { backdrop-filter: blur(12px); }
        .param-input { transition: border-color 0.2s, box-shadow 0.2s; }
        .param-input:focus { border-color: #3b9eff !important; box-shadow: 0 0 0 3px rgba(59,158,255,0.15); }
        .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 6px 24px rgba(59,158,255,0.35); }
        .btn-primary { transition: all 0.2s; }
        .ripple:active { transform: scale(0.97); }
        .maintenance-card:hover { border-color: rgba(59,158,255,0.4) !important; transform: translateY(-1px); }
        .maintenance-card { transition: all 0.2s; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .fade-in { animation: fadeIn 0.4s ease forwards; }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
        .pulse { animation: pulse 1.5s infinite; }
      `}</style>

      {/* Header */}
      <div style={{ background: "rgba(255,255,255,0.03)", borderBottom: "1px solid rgba(255,255,255,0.08)", padding: "16px 24px", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ fontSize: 28 }}>🏊</div>
        <div>
          <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, fontWeight: 700, color: "#7dd3fc", letterSpacing: "-0.3px" }}>PoolIQ</div>
          <div style={{ fontSize: 11, color: "#64748b", letterSpacing: "0.5px", textTransform: "uppercase" }}>Smart Pool Management</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {["test", "results", "maintenance", "history"].map(t => (
            <button key={t} className="tab-btn" onClick={() => setTab(t)} style={{
              padding: "7px 16px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 500,
              background: tab === t ? "rgba(59,158,255,0.2)" : "transparent",
              color: tab === t ? "#7dd3fc" : "#64748b",
              borderBottom: tab === t ? "2px solid #3b9eff" : "2px solid transparent",
            }}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div style={{ maxWidth: 820, margin: "0 auto", padding: "28px 20px" }}>

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
                  <div key={key} style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${status ? getStatusColor(status) + "44" : "rgba(255,255,255,0.08)"}`, borderRadius: 14, padding: 18 }}>
                    <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>{label}</div>
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

            <button onClick={handleAnalyze} disabled={!allReadingsEntered} className="btn-primary ripple" style={{
              width: "100%", padding: "16px", borderRadius: 12, border: "none", cursor: allReadingsEntered ? "pointer" : "not-allowed",
              background: allReadingsEntered ? "linear-gradient(135deg, #1d6fb8, #3b9eff)" : "rgba(255,255,255,0.05)",
              color: allReadingsEntered ? "#fff" : "#475569", fontSize: 16, fontWeight: 600, letterSpacing: "0.3px",
            }}>
              🔬 Analyze & Get Recommendations
            </button>
          </div>
        )}

        {/* ── RESULTS TAB ── */}
        {tab === "results" && (
          <div className="fade-in">
            <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 700, marginBottom: 6 }}>Recommendations</h2>
            <p style={{ color: "#64748b", fontSize: 14, marginBottom: 24 }}>Based on your latest test — {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p>

            {!recommendations ? (
              <div style={{ textAlign: "center", padding: "60px 20px", color: "#475569" }}>
                <div style={{ fontSize: 48, marginBottom: 16 }}>🧪</div>
                <p>No test data yet. Go to the <strong style={{ color: "#7dd3fc", cursor: "pointer" }} onClick={() => setTab("test")}>Test tab</strong> to enter your readings.</p>
              </div>
            ) : (
              <>
                {/* AI Analysis */}
                <div style={{ background: "rgba(59,158,255,0.08)", border: "1px solid rgba(59,158,255,0.2)", borderRadius: 16, padding: 20, marginBottom: 24 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                    <div style={{ fontSize: 18 }}>✨</div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#7dd3fc", textTransform: "uppercase", letterSpacing: "0.5px" }}>AI Analysis</div>
                  </div>
                  {aiLoading ? (
                    <div className="pulse" style={{ color: "#64748b", fontSize: 14 }}>Analyzing your pool chemistry…</div>
                  ) : (
                    <p style={{ fontSize: 14, lineHeight: 1.7, color: "#cbd5e1", whiteSpace: "pre-wrap" }}>{aiAnalysis || "Run a test to get AI analysis."}</p>
                  )}
                </div>

                {/* Rec Cards */}
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {recommendations.map((rec, i) => (
                    <div key={i} style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${rec.color}44`, borderRadius: 16, padding: 20, borderLeft: `4px solid ${rec.color}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                        <div>
                          <div style={{ fontSize: 13, color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 4 }}>{rec.param}</div>
                          {rec.current !== undefined && (
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <span style={{ fontSize: 22, fontWeight: 700, color: rec.color }}>{rec.current}</span>
                              <span style={{ fontSize: 12, color: "#64748b" }}>→ target: {rec.target}</span>
                            </div>
                          )}
                        </div>
                        <div style={{ padding: "4px 12px", borderRadius: 20, background: rec.color + "22", color: rec.color, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
                          {rec.status === "ok" ? "✓ Balanced" : rec.status === "low" ? "↓ Low" : "↑ High"}
                        </div>
                      </div>
                      {rec.status !== "ok" && (
                        <div style={{ background: "rgba(0,0,0,0.2)", borderRadius: 10, padding: 14, marginBottom: 10 }}>
                          <div style={{ fontSize: 12, color: "#64748b", marginBottom: 4 }}>RECOMMENDED CHEMICAL</div>
                          <div style={{ fontWeight: 600, color: "#e8f4fd", marginBottom: 4 }}>{rec.chemical}</div>
                          <div style={{ fontSize: 20, fontWeight: 700, color: "#7dd3fc" }}>{rec.amount}</div>
                        </div>
                      )}
                      <div style={{ fontSize: 13, color: "#94a3b8", lineHeight: 1.6 }}>💡 {rec.note}</div>
                    </div>
                  ))}
                </div>

                <button onClick={() => setTab("test")} style={{
                  marginTop: 20, width: "100%", padding: "13px", borderRadius: 12, border: "1px solid rgba(59,158,255,0.3)", cursor: "pointer",
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
                  return (
                    <div key={i} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, overflow: "hidden" }}>
                      <div onClick={() => setShowHistory(showHistory === i ? null : i)} style={{ padding: "16px 20px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 15 }}>{date.toLocaleDateString("en-US", { weekday: "short", month: "long", day: "numeric", year: "numeric" })}</div>
                          <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>{date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })} · {entry.poolVolume?.toLocaleString()} gal</div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ width: 10, height: 10, borderRadius: "50%", background: allOk ? "#22c55e" : "#f59e0b" }}></div>
                          <span style={{ color: "#64748b", fontSize: 18 }}>{showHistory === i ? "▲" : "▼"}</span>
                        </div>
                      </div>
                      {showHistory === i && (
                        <div style={{ padding: "0 20px 16px", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
                            {Object.entries(entry.readings).map(([key, val]) => {
                              if (val === "") return null;
                              const status = getStatus(key, parseFloat(val));
                              const labels = { ph: "pH", chlorine: "Chlorine", alkalinity: "Alkalinity", hardness: "Hardness", cyanuric: "CYA" };
                              return (
                                <div key={key} style={{ padding: "6px 12px", borderRadius: 8, background: getStatusColor(status) + "15", border: `1px solid ${getStatusColor(status)}33` }}>
                                  <span style={{ fontSize: 11, color: "#64748b" }}>{labels[key]} </span>
                                  <span style={{ fontSize: 14, fontWeight: 600, color: getStatusColor(status) }}>{val}{POOL_IDEAL[key].unit ? " " + POOL_IDEAL[key].unit : ""}</span>
                                </div>
                              );
                            })}
                          </div>
                          {entry.notes && <div style={{ marginTop: 10, fontSize: 13, color: "#64748b", fontStyle: "italic" }}>"{entry.notes}"</div>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

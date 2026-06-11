import { useState, useEffect, useRef } from "react";

/* ─── helpers ────────────────────────────────────────────── */
function parsePresignedUrl(url: string) {
  try {
    const u     = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    return {
      bucket: parts[0] ?? "—",
      key:    parts.slice(1).join("/") ?? "—",
      expiry: u.searchParams.get("X-Amz-Expires") ?? "—",
      sig:    (u.searchParams.get("X-Amz-Signature") ?? "—").slice(0, 16) + "…",
      date:   u.searchParams.get("X-Amz-Date") ?? "—",
      host:   u.host,
      raw:    url,
    };
  } catch { return null; }
}

/* ─── types ──────────────────────────────────────────────── */
interface GalleryItem {
  key:          string;
  url:          string;
  size:         number;
  lastModified: string;
  etag?:        string;
  metadata?:    Record<string, string>;
}

interface NodeHealth {
  id:     number;
  status: "up" | "down";
}

interface ClusterHealth {
  nodes:    NodeHealth[];
  ec:       { total: number; data: number; parity: number };
  canRead:  boolean;
  canWrite: boolean;
  upCount:  number;
}

type ConceptId =
    | "presigned-url"
    | "object-metadata"
    | "buckets"
    | "s3-api"
    | "versioning"
    | "bucket-policy"
    | "direct-upload"
    | "erasure-coding";

interface InsightEvent {
  conceptId: ConceptId;
  label:     string;
  detail:    string;
}

const CONCEPTS: Record<ConceptId, { title: string; anchor: string }> = {
  "presigned-url":   { title: "Presigned URLs",    anchor: "concept-presigned" },
  "object-metadata": { title: "Object Metadata",   anchor: "concept-metadata" },
  buckets:           { title: "Buckets",            anchor: "concept-buckets" },
  "s3-api":          { title: "S3 API Compat.",     anchor: "concept-s3" },
  versioning:        { title: "Versioning",         anchor: "concept-versioning" },
  "bucket-policy":   { title: "Bucket Policies",   anchor: "concept-policy" },
  "direct-upload":   { title: "Direct Upload",     anchor: "concept-direct-upload" },
  "erasure-coding":  { title: "Erasure Coding",    anchor: "concept-erasure" },
};

/* ═══════════════════════════════════════════════════════════
   ROOT
═══════════════════════════════════════════════════════════ */
export default function App() {
  const [tab,               setTab]               = useState<"app" | "learn">("app");
  const [pendingAnchor,     setPendingAnchor]      = useState<string | null>(null);
  const [exerciseCompleted, setExerciseCompleted] = useState(false);

  function openConcept(conceptId: ConceptId) {
    const anchor = CONCEPTS[conceptId].anchor;
    setTab("learn");
    setPendingAnchor(anchor);
  }

  useEffect(() => {
    if (tab === "learn" && pendingAnchor) {
      const el = document.getElementById(pendingAnchor);
      if (el) {
        setTimeout(() => {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
          el.classList.add("concept-highlight");
          setTimeout(() => el.classList.remove("concept-highlight"), 1800);
        }, 80);
      }
      setPendingAnchor(null);
    }
  }, [tab, pendingAnchor]);

  return (
      <div style={s.root}>
        <style>{globalCss}</style>
        <nav style={s.nav}>
          <div style={s.navInner}>
            <div style={s.navBrand}>
              <span style={s.navDot} />
              <span style={s.navTitle}>Stash</span>
              <span style={s.navSub}>powered by MinIO</span>
            </div>
            <div style={s.navTabs}>
              <button style={{ ...s.navTab, ...(tab === "app"   ? s.navTabActive : {}) }} onClick={() => setTab("app")}>Gallery</button>
              <button style={{ ...s.navTab, ...(tab === "learn" ? s.navTabActive : {}) }} onClick={() => setTab("learn")}>Under the Hood</button>
            </div>
          </div>
        </nav>
        {tab === "app"
            ? <GalleryPage onOpenConcept={openConcept} onExerciseComplete={() => setExerciseCompleted(true)} exerciseCompleted={exerciseCompleted} />
            : <LearnPage exerciseCompleted={exerciseCompleted} />}
      </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   GALLERY PAGE
═══════════════════════════════════════════════════════════ */
function GalleryPage({
                       onOpenConcept,
                       onExerciseComplete,
                       exerciseCompleted,
                     }: {
  onOpenConcept:      (id: ConceptId) => void;
  onExerciseComplete: () => void;
  exerciseCompleted:  boolean;
}) {
  const [gallery,       setGallery]       = useState<GalleryItem[]>([]);
  const [uploading,     setUploading]     = useState(false);
  const [status,        setStatus]        = useState<{ ok: boolean; text: string } | null>(null);
  const [lastUpload,    setLastUpload]    = useState<GalleryItem | null>(null);
  const [dragOver,      setDragOver]      = useState(false);
  const [selected,      setSelected]      = useState<GalleryItem | null>(null);
  const [insights,      setInsights]      = useState<InsightEvent[]>([]);
  const [deleting,      setDeleting]      = useState(false);
  const [uploadMode,    setUploadMode]    = useState<"server" | "direct">("server");
  const [directInfo,    setDirectInfo]    = useState<{ url: string; key: string; file: File } | null>(null);
  const [directReady,   setDirectReady]   = useState(false);
  const [expirySeconds, setExpirySeconds] = useState(30);
  const [cluster,       setCluster]       = useState<ClusterHealth | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);

  function pushInsight(ev: InsightEvent) {
    setInsights((prev) => prev.find((e) => e.conceptId === ev.conceptId) ? prev : [...prev, ev]);
  }

  useEffect(() => {
    let cancelled = false;
    async function pollNodes() {
      try {
        const r = await fetch("/nodes");
        if (!r.ok || cancelled) return;
        const data: ClusterHealth = await r.json();
        setCluster(data);
        if (data.upCount < 4) {
          pushInsight({ conceptId: "erasure-coding", label: "Erasure coding active", detail: `${data.upCount}/4 nodes online — cluster still serving data via EC.` });
        }
      } catch { /* backend not ready yet */ }
    }
    pollNodes();
    const id = setInterval(pollNodes, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  async function fetchGallery(expiry = expirySeconds) {
    const res  = await fetch(`/gallery?expiresIn=${expiry}`);
    const data: GalleryItem[] = await res.json();
    data.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
    setGallery(data);
    if (data.length > 0) {
      pushInsight({ conceptId: "buckets", label: "Bucket loaded", detail: `${data.length} object(s) retrieved.` });
      pushInsight({ conceptId: "s3-api",  label: "S3 API used",   detail: "ListObjectsV2 called via the S3-compatible MinIO endpoint." });
    }
    return data;
  }

  useEffect(() => { fetchGallery(); }, []);

  async function serverUpload(file: File) {
    setUploading(true); setStatus(null); setLastUpload(null);
    const form = new FormData();
    form.append("image", file);
    const res  = await fetch("/upload", { method: "POST", body: form });
    const data = await res.json();
    setUploading(false);
    if (!res.ok) { setStatus({ ok: false, text: `Upload failed: ${data.error}` }); return; }
    setStatus({ ok: true, text: `"${file.name}" uploaded via server` });
    const updated = await fetchGallery();
    const newest  = updated.find((i) => i.key === data.key);
    if (newest) {
      setLastUpload(newest);
      pushInsight({ conceptId: "presigned-url", label: "Presigned URL issued", detail: "Image accessible via a time-limited signed URL." });
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  async function getDirectUrl(file: File) {
    setStatus(null); setLastUpload(null); setDirectReady(false);
    const res  = await fetch(`/presign-upload?filename=${encodeURIComponent(file.name)}&contentType=${encodeURIComponent(file.type)}`);
    const data = await res.json();
    if (!res.ok) { setStatus({ ok: false, text: data.error ?? "Failed to get upload URL" }); return; }
    setDirectInfo({ url: data.url, key: data.key, file });
    setDirectReady(true);
    pushInsight({ conceptId: "direct-upload", label: "Presigned PUT issued", detail: "Backend signed a PUT URL. File goes straight from browser to MinIO." });
  }

  async function executeDirectUpload() {
    if (!directInfo) return;
    setUploading(true);
    const putUrl = directInfo.url.replace("http://localhost:9000", "/minio-direct");
    const res = await fetch(putUrl, { method: "PUT", body: directInfo.file, headers: { "Content-Type": directInfo.file.type } });
    setUploading(false);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      setStatus({ ok: false, text: `Direct upload failed (${res.status})${body ? ": " + body : ""}` });
      return;
    }
    setStatus({ ok: true, text: `"${directInfo.file.name}" uploaded directly to MinIO` });
    onExerciseComplete();
    await new Promise((r) => setTimeout(r, 400));
    const updated = await fetchGallery();
    const newest  = updated.find((i) => i.key === directInfo.key);
    if (newest) setLastUpload(newest);
    setDirectInfo(null); setDirectReady(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function deleteObject(key: string) {
    setDeleting(true);
    await fetch(`/objects/${encodeURIComponent(key)}`, { method: "DELETE" });
    setSelected(null); setDeleting(false);
    await fetchGallery();
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    uploadMode === "server" ? serverUpload(file) : getDirectUrl(file);
  }

  function handleFileChange(file: File) {
    uploadMode === "server" ? serverUpload(file) : getDirectUrl(file);
  }

  return (
      <div style={s.pageWrap}>

        <div style={{ paddingTop: 24, paddingBottom: 4 }}>
          <NodeStatusPanel cluster={cluster} onOpenConcept={onOpenConcept} />
        </div>

        {insights.length > 0 && (
            <div style={s.ribbon}>
              <span style={s.ribbonLabel}>Concepts triggered →</span>
              {insights.map((ins) => (
                  <button key={ins.conceptId} style={s.ribbonChip} title={ins.detail} onClick={() => onOpenConcept(ins.conceptId)}>
                    <span style={s.chipDot} />{CONCEPTS[ins.conceptId].title}<span style={s.chipArrow}>↗</span>
                  </button>
              ))}
            </div>
        )}

        <div style={s.twoCol}>
          {/* ── Sidebar ── */}
          <aside style={s.sidebar}>

            <div style={s.modeToggle}>
              <button style={{ ...s.modeBtn, ...(uploadMode === "server" ? s.modeBtnActive : {}) }}
                      onClick={() => { setUploadMode("server"); setDirectInfo(null); setDirectReady(false); }}>Via Server</button>
              <button style={{ ...s.modeBtn, ...(uploadMode === "direct" ? s.modeBtnActive : {}) }}
                      onClick={() => { setUploadMode("direct"); setDirectInfo(null); setDirectReady(false); }}>Direct to MinIO</button>
            </div>

            <div
                style={{ ...s.dropZone, ...(dragOver ? s.dropZoneActive : {}) }}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => !directReady && fileRef.current?.click()}
            >
              <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }}
                     onChange={(e) => { if (e.target.files?.[0]) handleFileChange(e.target.files[0]); }} />
              {uploading ? (
                  <div style={s.spinnerWrap}><div style={s.spinner} /></div>
              ) : directReady && directInfo ? (
                  <div onClick={(e) => e.stopPropagation()}>
                    <p style={{ ...s.dropText, color: "#4ADE80", fontWeight: 600, marginBottom: 6 }}>✓ Upload URL ready</p>
                    <p style={{ ...s.dropSub, marginBottom: 10 }}>{directInfo.file.name}</p>
                    <button style={s.uploadDirectBtn} onClick={executeDirectUpload}>Upload to MinIO →</button>
                  </div>
              ) : (
                  <>
                    <div style={s.dropIconWrap}>
                      <svg width="28" height="28" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} style={{ color: "#6E7681" }}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                      </svg>
                    </div>
                    <p style={s.dropText}>
                      {uploadMode === "server" ? <>Drop an image or <u>click to browse</u></> : <>Pick a file to get a <u>presigned PUT URL</u></>}
                    </p>
                    <p style={s.dropSub}>PNG · JPG · GIF · WEBP</p>
                  </>
              )}
            </div>

            {uploadMode === "direct" && directInfo && (
                <div style={s.directPanel}>
                  <p style={s.directLabel}>Step 1 — Signed PUT URL from server:</p>
                  <textarea readOnly value={directInfo.url} style={s.directUrlBox} rows={3}
                            onClick={(e) => (e.target as HTMLTextAreaElement).select()} />
                  <div style={s.flowDiagram}>
                    <FlowRow label="Browser" note="your tab"  color="#166534" />
                    <FlowArrow label="GET /presign-upload" sub="got the URL ✓" />
                    <FlowRow label="Backend" note="Express"   color="#4ADE80" />
                    <FlowArrow label="— no file bytes —" sub="backend is done" dim />
                    <FlowArrow label="PUT {signed URL}" sub="step 2 →" color="#4ADE80" />
                    <FlowRow label="MinIO"   note=":9000"     color="#4ADE80" />
                  </div>
                </div>
            )}

            {uploadMode === "direct" && !directInfo && !exerciseCompleted && (
                <div style={s.exercisePanel}>
                  <p style={s.exercisePanelTitle}>📝 Your turn — implement this route</p>
                  <ol style={s.exerciseList}>
                    <li>Open <code style={s.inlineCode}>backend/server.js</code></li>
                    <li>Find <code style={s.inlineCode}>GET /presign-upload</code></li>
                    <li>Write the ~3 lines that build a <code style={s.inlineCode}>PutObjectCommand</code> and call <code style={s.inlineCode}>getSignedUrl</code> with <code style={s.inlineCode}>{"{ expiresIn: 300 }"}</code></li>
                    <li>Return <code style={s.inlineCode}>{"res.json({ url, key })"}</code></li>
                  </ol>
                  <p style={s.exerciseHint}>Hint: copy the pattern from <code style={s.inlineCode}>GET /gallery</code> above it.</p>
                  <p style={s.exerciseDone}>Done when: picking a file here succeeds ✓</p>
                </div>
            )}

            {uploadMode === "direct" && !directInfo && exerciseCompleted && (
                <div style={{ ...s.exercisePanel, background: "#0D1117", borderColor: "#4ADE80" }}>
                  <p style={{ ...s.exercisePanelTitle, color: "#4ADE80" }}>✓ Exercise complete</p>
                  <p style={{ fontSize: 12, color: "#4ADE80", margin: 0 }}>You implemented the presigned PUT route. Direct upload is live.</p>
                </div>
            )}

            {status && (
                <div style={{ ...s.statusBar, background: status.ok ? "#0D1117" : "#1a0a0a", borderColor: status.ok ? "#4ADE80" : "#ef4444" }}>
                  <span style={{ color: status.ok ? "#4ADE80" : "#ef4444", fontSize: 13 }}>{status.ok ? "✓" : "✗"} {status.text}</span>
                </div>
            )}

            {lastUpload && <PresignedUrlReveal item={lastUpload} onOpenConcept={onOpenConcept} />}

            <div style={s.statRow}>
              <div style={s.stat}><span style={s.statVal}>{gallery.length}</span><span style={s.statKey}>objects</span></div>
              <div style={s.stat}><span style={s.statVal}>{(gallery.reduce((a, b) => a + b.size, 0) / 1024).toFixed(0)}</span><span style={s.statKey}>KB stored</span></div>
            </div>
          </aside>

          {/* ── Gallery ── */}
          <main style={s.galleryArea}>
            <div style={s.galleryTopBar}>
              <h2 style={s.sectionTitle}>Gallery</h2>
              <div style={s.galleryControls}>
                <span style={s.sliderLabel}>URL expiry:</span>
                <input
                    type="range"
                    min={5}
                    max={1200}
                    value={expirySeconds}
                    onChange={(e) => setExpirySeconds(parseInt(e.target.value))}
                    style={{ width: 100, accentColor: "#4ADE80", cursor: "pointer" }}
                />
                <span style={s.sliderValue}>{expirySeconds}s</span>
                <button onClick={() => fetchGallery(expirySeconds)} style={s.refreshBtn}>↻</button>
              </div>
            </div>

            {gallery.length === 0 ? (
                <div style={s.empty}>
                  <p style={{ fontSize: 48, margin: "0 0 12px" }}>🗄️</p>
                  <p style={{ color: "#8B949E", margin: 0, fontSize: 14 }}>No images yet — upload one to get started.</p>
                </div>
            ) : (
                <div style={s.grid}>
                  {gallery.map((item) => (
                      <div key={item.key} style={s.tile} onClick={() => setSelected(item)} className="gallery-tile">
                        <div style={s.imgWrap}>
                          <img src={item.url} alt={item.key} style={s.img} loading="lazy" />
                          <button
                              className="tile-open-btn"
                              style={s.tileOpenBtn}
                              title="Open in new tab"
                              onClick={(e) => { e.stopPropagation(); window.open(item.url, "_blank"); }}
                          >↗</button>
                        </div>
                        <div style={s.tileCaption}>
                          <span style={s.tileFilename}>{item.key.replace(/^\d+-/, "")}</span>
                          <span style={s.tileMeta}>{(item.size / 1024).toFixed(1)} KB</span>
                        </div>
                      </div>
                  ))}
                </div>
            )}
          </main>
        </div>

        {/* ── Detail modal ── */}
        {selected && (
            <div style={s.overlay} onClick={() => setSelected(null)}>
              <div style={s.modal} onClick={(e) => e.stopPropagation()}>
                <button style={s.modalClose} onClick={() => setSelected(null)}>✕</button>
                <div style={s.modalImgWrap}>
                  <img src={selected.url} alt={selected.key} style={s.modalImg} />
                </div>
                <div style={s.modalInfo}>
                  <p style={s.modalFilename}>{selected.key.replace(/^\d+-/, "")}</p>
                  <div style={s.modalMeta}>
                    <MetaRow label="Object key"    value={selected.key} mono />
                    <MetaRow label="Size"          value={`${(selected.size / 1024).toFixed(2)} KB`} />
                    <MetaRow label="Last modified" value={new Date(selected.lastModified).toLocaleString()} />
                    {selected.etag && <MetaRow label="ETag (MD5)" value={selected.etag} mono />}
                    {selected.metadata && Object.entries(selected.metadata).map(([k, v]) => <MetaRow key={k} label={k} value={v} />)}
                  </div>

                  {cluster && (
                      <div style={s.shardSection}>
                        <p style={s.shardTitle}>Stored across {cluster.ec.total} nodes (EC:{cluster.ec.data}+{cluster.ec.parity})</p>
                        <div style={s.shardGrid}>
                          {cluster.nodes.map((node, i) => {
                            const isData   = i < cluster.ec.data;
                            const isUp     = node.status === "up";
                            const color    = isData ? "#166534" : "#4ADE80";
                            const label    = isData ? `D${i + 1}` : `P${i - cluster.ec.data + 1}`;
                            const roleText = isData ? "data" : "parity";
                            return (
                                <div key={node.id} style={{ ...s.shardCard, opacity: isUp ? 1 : 0.45, borderColor: isUp ? color + "55" : "#21262D", background: isUp ? color + "11" : "#2a3039" }}>
                                  <div style={{ ...s.shardLabel, color: isUp ? color : "#6E7681" }}>{label}</div>
                                  <div style={s.shardNodeId}>Node {node.id}</div>
                                  <div style={{ ...s.shardRole, color: isUp ? color : "#6E7681" }}>{roleText}</div>
                                  <div style={{ ...s.shardStatus, color: isUp ? "#4ADE80" : "#ef4444" }}>{isUp ? "●" : "✕"}</div>
                                </div>
                            );
                          })}
                        </div>
                        <p style={s.shardNote}>
                          Any {cluster.ec.data} shards reconstruct this object.
                          {cluster.upCount < cluster.ec.data
                              ? " ⚠️ Below read quorum — object unreadable."
                              : cluster.upCount < 3
                                  ? " ✓ Readable  ✗ New uploads blocked (below write quorum)."
                                  : " ✓ Fully operational."}
                        </p>
                      </div>
                  )}

                  <div style={s.modalActions}>
                    <button style={s.openBtn} onClick={() => window.open(selected.url, "_blank")}>↗ Open in new tab</button>
                    <button style={s.deleteBtn} onClick={() => deleteObject(selected.key)} disabled={deleting}>
                      {deleting ? "Deleting…" : "Delete object"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
        )}
      </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   NODE STATUS PANEL
═══════════════════════════════════════════════════════════ */
function NodeStatusPanel({ cluster, onOpenConcept }: { cluster: ClusterHealth | null; onOpenConcept: (id: ConceptId) => void }) {
  if (!cluster) {
    return (
        <div style={{ ...s.ecPanel, opacity: 0.5 }}>
          <div style={s.ecPanelHeader}>
            <div style={s.ecTitle}>
              <span style={s.ecTitleText}>Erasure Coding</span>
              <span style={{ ...s.ecFormula, opacity: 0.4 }}>EC: —</span>
            </div>
          </div>
          <div style={s.ecNodeRow}>
            {[1, 2, 3, 4].map((id) => (
                <div key={id} style={s.ecNodeCard}>
                  <div style={{ ...s.ecNodeIndicator, background: "#21262D" }} />
                  <div style={s.ecNodeId}>Node {id}</div>
                  <div style={{ ...s.ecShardBadge, background: "#2a3039", color: "#6E7681", borderColor: "#21262D" }}>—</div>
                  <div style={{ ...s.ecNodeStatus, color: "#6E7681" }}>…</div>
                </div>
            ))}
          </div>
        </div>
    );
  }

  const { nodes, ec, canRead, canWrite, upCount } = cluster;

  const statusMsg =
      upCount === 4 ? "All nodes online — reads ✓  writes ✓" :
          upCount === 3 ? `1 node down — reads ✓  writes ✓  (write quorum: ${upCount}/3)` :
              upCount === 2 ? "2 nodes down — reads ✓  writes ✗  (below write quorum of 3)" :
                  upCount === 1 ? "3 nodes down — reads ✗  writes ✗  (below read quorum of 2)" :
                      "All nodes down — cluster offline";

  const statusColor =
      upCount === 4 ? "#4ADE80" :
          upCount === 3 ? "#f97316" :
              upCount === 2 ? "#f97316" : "#ef4444";

  const shardMeta = [
    { label: "D1", color: "#166534", title: "Data shard 1"   },
    { label: "D2", color: "#166534", title: "Data shard 2"   },
    { label: "P1", color: "#4ADE80", title: "Parity shard 1" },
    { label: "P2", color: "#4ADE80", title: "Parity shard 2" },
  ];

  return (
      <div style={s.ecPanel}>
        <div style={s.ecPanelHeader}>
          <div style={s.ecTitle}>
            <span style={s.ecTitleText}>Erasure Coding</span>
            <span style={s.ecFormula}>EC: {ec.data}+{ec.parity}</span>
            <span style={s.ecFormulaNote}>{ec.data} data · {ec.parity} parity · {ec.total} nodes</span>
          </div>
          <button style={s.ecLearnBtn} onClick={() => onOpenConcept("erasure-coding")}>How it works ↗</button>
        </div>

        <div style={s.ecNodeRow}>
          {nodes.map((node, i) => {
            const meta = shardMeta[i];
            const isUp = node.status === "up";
            return (
                <div key={node.id} style={s.ecNodeCard}>
                  <div style={{ ...s.ecNodeIndicator, background: isUp ? "#4ADE80" : "#ef4444", boxShadow: isUp ? "0 0 8px #4ADE8055" : "0 0 8px #ef444455" }} />
                  <div style={s.ecNodeId}>Node {node.id}</div>
                  <div title={meta.title} style={{ ...s.ecShardBadge, background: isUp ? meta.color + "22" : "#2a3039", color: isUp ? meta.color : "#6E7681", borderColor: isUp ? meta.color + "55" : "#21262D" }}>
                    {meta.label}
                  </div>
                  <div style={{ ...s.ecNodeStatus, color: isUp ? "#4ADE80" : "#ef4444" }}>{isUp ? "online" : "offline"}</div>
                </div>
            );
          })}
        </div>

        <div style={{ ...s.ecStatusBar, borderColor: statusColor + "44", background: statusColor + "11" }}>
          <div style={{ ...s.ecStatusDot, background: statusColor, boxShadow: `0 0 6px ${statusColor}66` }} />
          <span style={{ ...s.ecStatusMsg, color: statusColor }}>{statusMsg}</span>
          <div style={s.ecQuorumBadges}>
            <span style={{ ...s.ecQuorumBadge, background: canRead  ? "#166534" : "#3d0a0a", color: canRead  ? "#4ADE80" : "#ef4444" }}>Read {canRead   ? "✓" : "✗"}</span>
            <span style={{ ...s.ecQuorumBadge, background: canWrite ? "#166534" : "#3d0a0a", color: canWrite ? "#4ADE80" : "#ef4444" }}>Write {canWrite ? "✓" : "✗"}</span>
          </div>
        </div>

        <p style={s.ecHint}>
          Demo: run <code style={s.ecHintCode}>docker compose stop minio3</code> in a terminal and watch this panel update.
        </p>
      </div>
  );
}

/* ── Flow diagram helpers ── */
function FlowRow({ label, note, color }: { label: string; note: string; color: string }) {
  return (
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: color, flexShrink: 0, boxShadow: `0 0 6px ${color}66` }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: "#E4E5E5" }}>{label}</span>
        <span style={{ fontSize: 11, color: "#6E7681" }}>{note}</span>
      </div>
  );
}

function FlowArrow({ label, sub, color, dim }: { label: string; sub: string; color?: string; dim?: boolean }) {
  return (
      <div style={{ paddingLeft: 5, display: "flex", flexDirection: "column", gap: 2 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 1, height: 18, background: "#21262D", marginLeft: 4 }} />
          <span style={{ fontSize: 11, color: dim ? "#6E7681" : color || "#8B949E", fontFamily: "monospace", fontStyle: dim ? "italic" : "normal" }}>{label}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 1, height: 8, background: "#21262D", marginLeft: 4 }} />
          <span style={{ fontSize: 10, color: "#6E7681" }}>{sub}</span>
        </div>
      </div>
  );
}

/* ── Presigned URL Reveal ── */
function PresignedUrlReveal({ item, onOpenConcept }: { item: GalleryItem; onOpenConcept: (id: ConceptId) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [copied,   setCopied]   = useState(false);
  const parsed       = parsePresignedUrl(item.url);
  const actualExpiry = parsed ? parseInt(parsed.expiry) || 30 : 30;
  const [secondsLeft, setSecondsLeft] = useState(actualExpiry);

  useEffect(() => {
    setSecondsLeft(actualExpiry);
    const t = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [item.url]);

  function copy() { navigator.clipboard.writeText(item.url); setCopied(true); setTimeout(() => setCopied(false), 2000); }

  const pct   = secondsLeft / actualExpiry;
  const mins  = Math.floor(secondsLeft / 60);
  const secs  = secondsLeft % 60;
  const color = pct > 0.5 ? "#4ADE80" : pct > 0.2 ? "#f97316" : "#ef4444";

  return (
      <div style={s.psuRoot}>
        <div style={s.psuHeader}>
          <div style={s.psuThumb}><img src={item.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={s.psuFileName}>{item.key.replace(/^\d+-/, "")}</div>
            <div style={s.psuSubline}>{(item.size / 1024).toFixed(1)} KB · uploaded just now</div>
          </div>
          <button style={s.psuOpenBtn} title="Open in new tab" onClick={() => window.open(item.url, "_blank")}>↗</button>
          <button style={s.psuExpandBtn} onClick={() => setExpanded((v) => !v)}>{expanded ? "▲" : "▼"}</button>
        </div>
        <div style={s.psuExpiryRow}>
          <div style={s.psuBarWrap}><div style={{ ...s.psuBar, width: `${pct * 100}%`, background: color }} /></div>
          <span style={{ ...s.psuTimer, color }}>{secondsLeft > 0 ? `${mins}m ${secs.toString().padStart(2, "0")}s` : "Expired"}</span>
        </div>
        <p style={s.psuExpiryNote}>
          Signed GET URL — expires in {actualExpiry}s. Open in a new tab, wait, then refresh to see the 403.
          <button style={s.psuLearnLink} onClick={() => onOpenConcept("presigned-url")}>Learn why ↗</button>
        </p>
        {expanded && parsed && (
            <div style={s.psuBreakdown}>
              <p style={s.psuBreakdownTitle}>URL breakdown</p>
              <UrlPart color="#166534" label="Host"            value={parsed.host}                       note="MinIO's endpoint. In production: your S3 domain or CDN." />
              <UrlPart color="#4ADE80" label="Bucket / Key"    value={`/${parsed.bucket}/${parsed.key}`} note="Bucket name + object key." />
              <UrlPart color="#f97316" label="X-Amz-Date"      value={parsed.date}                       note="When the signature was generated — baked in so it can't be reused." />
              <UrlPart color="#ef4444" label="X-Amz-Expires"   value={`${parsed.expiry}s`}               note="How long until the URL stops working. Tamper with this and the signature breaks." />
              <UrlPart color="#4ADE80" label="X-Amz-Signature" value={parsed.sig}                        note="HMAC-SHA256 of the URL + expiry + your secret key. Change anything above and this won't match." />
              <div style={s.psuRawWrap}>
                <textarea readOnly value={item.url} style={s.psuRawBox} rows={3} onClick={(e) => (e.target as HTMLTextAreaElement).select()} />
                <button style={s.psuCopyBtn} onClick={copy}>{copied ? "✓ Copied" : "Copy"}</button>
              </div>
            </div>
        )}
      </div>
  );
}

function UrlPart({ color, label, value, note }: { color: string; label: string; value: string; note: string }) {
  return (
      <div style={s.urlPart}>
        <div style={{ ...s.urlPartLabel, color, borderColor: color + "44", background: color + "11" }}>{label}</div>
        <div style={{ flex: 1 }}>
          <code style={s.urlPartValue}>{value}</code>
          <p style={s.urlPartNote}>{note}</p>
        </div>
      </div>
  );
}

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
      <div style={s.metaRow}>
        <span style={s.metaLabel}>{label}</span>
        <span style={{ ...s.metaValue, ...(mono ? { fontFamily: "monospace", fontSize: 11 } : {}) }}>{value}</span>
      </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   LEARN PAGE
═══════════════════════════════════════════════════════════ */
function LearnPage({ exerciseCompleted }: { exerciseCompleted: boolean }) {
  return (
      <div style={s.learnWrap}>
        <div style={s.learnHeader}>
          <h1 style={s.learnH1}>Under the Hood</h1>
          <p style={s.learnSubtitle}>Theory behind what you just did in the Gallery tab.</p>
        </div>

        <div style={s.coreBlock}>
          <p style={s.coreBlockLabel}>Core ideas</p>
          <div style={s.coreGrid}>
            <CoreIdea title="Objects are flat"             text="An object = bytes + a key + metadata, stored in a flat bucket. Keys look like paths but folders aren't real — the / is just part of the key string." />
            <CoreIdea title="Storage ≠ database"           text="Store the blob in object storage, store a pointer (the key) plus searchable fields in your database. Object storage isn't a database." />
            <CoreIdea title="Code against the API, not the vendor" text="The same SDK code runs on MinIO, AWS S3, Cloudflare R2, or Backblaze B2 — you change one config line, not your code." />
          </div>
        </div>

        <ConceptCard id="concept-buckets" badge="01" title="Buckets & Objects" tagline="Flat key-value store" color="#166534">
          <p>A <strong>bucket</strong> is a flat namespace. Every file you upload becomes an <strong>object</strong> with three things: bytes, a key, and metadata. There is no directory tree — <code>2024/photo.png</code> and <code>2024/other.png</code> are just two strings that share a prefix.</p>
          <p>The "folder" the MinIO console draws for <code>2024/</code> is invented by the UI. ListObjectsV2 lets you filter by prefix to simulate folders, but the storage layer is flat.</p>
          <CodeBlock>{`// What the backend runs every time you open the Gallery tab:
const list = await s3.send(new ListObjectsV2Command({ Bucket: "workshop-images" }));
// Each entry: { Key, Size, ETag, LastModified }
// Key examples: "1719000000-cat.jpg"  "1719000001-dog.png"`}</CodeBlock>
          <InfoBox>In the gallery, click any image. The <strong>Object key</strong> row in the metadata panel shows the full key MinIO uses — no folder, just a timestamp-prefixed string.</InfoBox>
        </ConceptCard>

        <ConceptCard id="concept-presigned" badge="02" title="Presigned GET URLs" tagline="Temporary, unforgeable read links" color="#4ADE80">
          <p>After listing objects, the backend calls <code>getSignedUrl</code> for each key. The result is a normal HTTPS URL with an HMAC-SHA256 signature baked into the query string — MinIO verifies it without storing any session.</p>
          <p>The browser loads images <strong>directly from MinIO</strong> — the Express server is not in the transfer loop. Change one character in the URL and the signature check fails with a 403.</p>
          <CodeBlock>{`const url = await getSignedUrl(
  s3,
  new GetObjectCommand({ Bucket: BUCKET, Key: "1719000000-cat.jpg" }),
  { expiresIn: 30 }    // set via the slider in the Gallery tab
);
// → http://localhost:9000/workshop-images/1719000000-cat.jpg
//     ?X-Amz-Expires=30&X-Amz-Signature=a3f8b2…`}</CodeBlock>
          <InfoBox>
            Use the expiry slider in the Gallery tab to set a short window, upload an image, click ↗ to open it in a new tab — then wait for the timer to hit zero and refresh that tab to get a 403.
          </InfoBox>
        </ConceptCard>

        <ConceptCard id="concept-direct-upload" badge="03" title="Direct Upload — Presigned PUT" tagline="Backend as keyholder, not middleman" color="#f97316" exerciseBadge={{ completed: exerciseCompleted }}>
          <p>A presigned URL works for <em>writes</em> too. The backend signs a PUT URL and returns it; the browser uploads straight to MinIO. The server never touches the file bytes — it only holds the secret key and uses it to sign requests.</p>
          <CodeBlock>{`// Via server (default tab):
Browser ──POST /upload──▶ Backend ──PutObject──▶ MinIO
         (file bytes flow through Express)

// Direct upload ("Direct to MinIO" tab):
Browser ──GET /presign-upload──▶ Backend   ← only a tiny JSON response
Browser ──PUT {signed URL}────────────────▶ MinIO   ← file bytes go here directly`}</CodeBlock>
          <p>The backend is the <strong>keyholder</strong>: it holds the MinIO credentials and uses them only to sign URLs. The browser never sees a secret key — only a time-limited signed URL that MinIO will accept.</p>
          <InfoBox>Switch to "Direct to MinIO" in the Gallery tab. When you pick a file, the app asks the backend for a signed PUT URL and shows it in the flow diagram before you upload. The PUT goes straight to <code>:9000</code>.</InfoBox>
        </ConceptCard>

        <ConceptCard id="concept-s3" badge="04" title="S3 API Compatibility" tagline="One SDK, any vendor" color="#4ADE80">
          <p>Amazon S3 defined a standard REST API for object storage. MinIO implements that exact API. The AWS SDK in this project talks to MinIO identically to how it talks to real AWS S3.</p>
          <CodeBlock>{`// Dev (MinIO in Docker):
const s3 = new S3Client({
  endpoint:        "http://localhost:9000",   // ← the only line that changes
  forcePathStyle:  true,
  credentials:     { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
});

// Production (AWS S3) — everything else stays the same:
const s3 = new S3Client({
  region:      "us-east-1",
  credentials: { accessKeyId: process.env.AWS_KEY, secretAccessKey: process.env.AWS_SECRET },
});`}</CodeBlock>
          <p>The same swap works for Cloudflare R2, Backblaze B2, or any S3-compatible store. You are coding against an open standard, not a proprietary SDK.</p>
        </ConceptCard>

        <ConceptCard id="concept-erasure" badge="05" title="Erasure Coding" tagline="Survive node failures without full copies" color="#ef4444">
          <p>Instead of copying the entire file to every node (which costs 4× the storage), MinIO uses <strong>Reed-Solomon erasure coding</strong> to split each object into shards. With a 4-node cluster and the default EC:2, every object becomes <strong>2 data shards + 2 parity shards</strong>. Any 2 shards are enough to reconstruct the full object.</p>
          <CodeBlock>{`4-node cluster, EC:2 (default for 4 drives):

  Node 1  →  Data shard 1    (¼ of the object's data)
  Node 2  →  Data shard 2    (¼ of the object's data)
  Node 3  →  Parity shard 1  (mathematically derived from D1+D2)
  Node 4  →  Parity shard 2  (mathematically derived from D1+D2)

  Read  quorum: 2 nodes  — any 2 shards reconstruct the full object
  Write quorum: 3 nodes  — need 3 online to commit a new write safely

  Storage overhead: 2× (not 4× like full replication)
  Failure tolerance: lose any 2 nodes — data survives`}</CodeBlock>
          <p>The parity shards are computed with XOR-based arithmetic (Reed-Solomon). If node 3 disappears, MinIO can recompute parity shard 1 from data shards 1 and 2.</p>
          <InfoBox>
            Live demo: run <code>docker compose stop minio3</code> in a terminal — the panel turns orange but the gallery still loads. Run <code>docker compose stop minio4</code> as well — two nodes down, reads still work (read quorum = 2). Try uploading — it fails (write quorum = 3). Run <code>docker compose start minio3</code> and uploads are restored.
          </InfoBox>
        </ConceptCard>

        <div style={s.gtkStrip}>
          <span style={s.gtkHeader}>Good to know</span>
          <GtkItem text="ETag = MD5 hash of the bytes — MinIO returns it on every object and you can use it as a cache fingerprint or deduplication key." />
          <GtkItem text="Objects are immutable: you replace rather than edit. Lifecycle rules can auto-expire objects after N days to reclaim space." />
          <GtkItem text="Versioning keeps every overwrite as a new version with its own version ID — deletes create a marker rather than destroying data." />
          <GtkItem text="Bucket policies are JSON access rules. Buckets are private by default; presigned URLs grant temporary exceptions without making the bucket public." />
          <GtkItem text="Erasure coding runs automatically — no configuration needed beyond having 4+ drives. MinIO picks EC:2 for a 4-drive cluster by default." />
        </div>

        <div style={s.learnFooter}>
          <p style={{ color: "#8B949E", fontSize: 13, margin: 0 }}>
            All five concepts are active right now — the Gallery tab is talking to a live 4-node MinIO cluster via Docker.
          </p>
        </div>
      </div>
  );
}

/* ── Sub-components ── */
function CoreIdea({ title, text }: { title: string; text: string }) {
  return (
      <div style={s.coreIdea}>
        <p style={s.coreIdeaTitle}>{title}</p>
        <p style={s.coreIdeaText}>{text}</p>
      </div>
  );
}

function GtkItem({ text }: { text: string }) {
  return (
      <p style={s.gtkItem}>
        <span style={s.gtkDot}>·</span>{text}
      </p>
  );
}

function ConceptCard({ id, badge, title, tagline, color, exerciseBadge, children }: {
  id: string; badge: string; title: string; tagline: string; color: string;
  exerciseBadge?: { completed: boolean };
  children: React.ReactNode;
}) {
  return (
      <div id={id} style={s.conceptCard} className="concept-card">
        <div style={s.conceptHeader}>
          <span style={{ ...s.conceptBadge, background: color + "22", color }}>{badge}</span>
          <div style={{ flex: 1 }}>
            <h2 style={s.conceptTitle}>{title}</h2>
            <p style={{ ...s.conceptTagline, color }}>{tagline}</p>
          </div>
          {exerciseBadge && (
              <div style={exerciseBadge.completed ? s.exBadgeDone : s.exBadgePending}>
                {exerciseBadge.completed ? "✓ You implemented this" : "← Complete the exercise"}
              </div>
          )}
          <div style={{ ...s.conceptAccent, background: color }} />
        </div>
        <div style={s.conceptBody}>{children}</div>
      </div>
  );
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  return <pre style={s.codeBlock}><code style={{ fontFamily: "monospace", fontSize: 12 }}>{children}</code></pre>;
}

function InfoBox({ children }: { children: React.ReactNode }) {
  return (
      <div style={s.infoBox}>
        <span style={s.infoBoxIcon}>💡</span>
        <span style={{ fontSize: 13, color: "#4ADE80", lineHeight: 1.6 }}>{children}</span>
      </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   STYLES
═══════════════════════════════════════════════════════════ */
const globalCss = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0D1117; }

  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  @keyframes highlightPulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(74,222,128,0); }
    40%       { box-shadow: 0 0 0 6px rgba(74,222,128,0.3); }
  }

  .gallery-tile { transition: transform .15s, box-shadow .15s; cursor: pointer; }
  .gallery-tile:hover { transform: translateY(-3px); box-shadow: 0 8px 24px rgba(0,0,0,.4); }
  .tile-open-btn { opacity: 0; transition: opacity .15s; }
  .gallery-tile:hover .tile-open-btn { opacity: 1; }

  .concept-card { animation: fadeIn .3s ease both; }
  .concept-highlight { animation: highlightPulse .6s ease 2; }

  ul, ol { padding-left: 20px; }
  li { margin-bottom: 4px; font-size: 13px; color: #C6C7C7; line-height: 1.6; }
  p  { font-size: 14px; color: #C6C7C7; line-height: 1.7; margin-bottom: 12px; }
  p:last-child { margin-bottom: 0; }
  strong { color: #E4E5E5; }
  code { background: #2a3039; padding: 1px 5px; border-radius: 4px; font-family: monospace; font-size: 12px; color: #4ADE80; border: 1px solid #21262D; }
`;

const s: Record<string, React.CSSProperties> = {
  root: { minHeight: "100vh", fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif", background: "#0D1117", color: "#E4E5E5" },

  /* nav */
  nav:          { background: "#2a3039", borderBottom: "1px solid #21262D", position: "sticky", top: 0, zIndex: 50 },
  navInner:     { maxWidth: 1080, margin: "0 auto", padding: "0 24px", height: 56, display: "flex", alignItems: "center", justifyContent: "space-between" },
  navBrand:     { display: "flex", alignItems: "center", gap: 10 },
  navDot:       { width: 10, height: 10, borderRadius: "50%", background: "#4ADE80", boxShadow: "0 0 10px #4ADE8088" },
  navTitle:     { fontSize: 16, fontWeight: 700, color: "#E4E5E5", letterSpacing: "-0.3px" },
  navSub:       { fontSize: 11, color: "#6E7681", borderLeft: "1px solid #21262D", paddingLeft: 10, marginLeft: 2 },
  navTabs:      { display: "flex", gap: 4 },
  navTab:       { background: "transparent", border: "1px solid transparent", borderRadius: 8, padding: "6px 16px", fontSize: 13, color: "#8B949E", cursor: "pointer", fontWeight: 500 },
  navTabActive: { background: "#0D1117", borderColor: "#21262D", color: "#E4E5E5" },

  /* page layout */
  pageWrap: { maxWidth: 1080, margin: "0 auto", padding: "0 24px 40px" },
  twoCol:   { display: "flex", gap: 24, paddingTop: 20, alignItems: "flex-start" },

  /* insight ribbon */
  ribbon:      { display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", background: "#16653422", border: "1px solid #16653455", borderRadius: 10, marginTop: 12, flexWrap: "wrap" as const },
  ribbonLabel: { fontSize: 11, fontWeight: 600, color: "#4ADE80", textTransform: "uppercase" as const, letterSpacing: ".5px", whiteSpace: "nowrap" as const },
  ribbonChip:  { display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px", background: "#2a3039", border: "1px solid #3D444D", borderRadius: 20, fontSize: 12, fontWeight: 500, color: "#4ADE80", cursor: "pointer" },
  chipDot:     { width: 6, height: 6, borderRadius: "50%", background: "#4ADE80" },
  chipArrow:   { fontSize: 10, opacity: 0.6 },

  /* sidebar */
  sidebar:      { width: 320, flexShrink: 0, display: "flex", flexDirection: "column" as const, gap: 20 },
  sectionTitle: { fontSize: 13, fontWeight: 700, color: "#8B949E", textTransform: "uppercase" as const, letterSpacing: ".06em", marginBottom: 12 },

  /* mode toggle */
  modeToggle:    { display: "flex", background: "#2a3039", borderRadius: 10, padding: 4, gap: 4, border: "1px solid #3D444D" },
  modeBtn:       { flex: 1, padding: "8px 10px", fontSize: 12, fontWeight: 600, border: "none", borderRadius: 7, cursor: "pointer", background: "transparent", color: "#8B949E" },
  modeBtnActive: { background: "#0D1117", color: "#E4E5E5", boxShadow: "0 1px 3px rgba(0,0,0,.4)" },

  /* drop zone */
  dropZone:        { border: "2px dashed #21262D", borderRadius: 14, padding: "40px 28px", textAlign: "center" as const, cursor: "pointer", background: "#2a3039", transition: "all .15s", minHeight: 160 },
  dropZoneActive:  { borderColor: "#166534", background: "#16653411" },
  dropIconWrap:    { display: "flex", justifyContent: "center", marginBottom: 14 },
  dropText:        { fontSize: 14, color: "#8B949E", marginBottom: 6 },
  dropSub:         { fontSize: 12, color: "#6E7681" },
  spinnerWrap:     { display: "flex", justifyContent: "center", padding: "16px 0" },
  spinner:         { width: 30, height: 30, border: "3px solid #21262D", borderTopColor: "#4ADE80", borderRadius: "50%", animation: "spin .7s linear infinite" },
  uploadDirectBtn: { padding: "10px 20px", background: "#166534", color: "#4ADE80", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600 },

  /* direct upload panel */
  directPanel:  { background: "#2a3039", border: "1px solid #3D444D", borderRadius: 12, padding: "18px 20px", display: "flex", flexDirection: "column" as const, gap: 14 },
  directLabel:  { fontSize: 11, fontWeight: 700, color: "#f97316", textTransform: "uppercase" as const, letterSpacing: ".5px" },
  directUrlBox: { fontFamily: "monospace", fontSize: 10, padding: "10px 12px", borderRadius: 8, border: "1px solid #3D444D", background: "#0D1117", resize: "none" as const, color: "#C6C7C7", lineHeight: 1.6, width: "100%" },
  flowDiagram:  { background: "#0D1117", borderRadius: 8, padding: "14px 16px", display: "flex", flexDirection: "column" as const, gap: 6 },

  /* exercise panel */
  exercisePanel:      { background: "#2a3039", border: "1px solid #3D444D", borderRadius: 12, padding: "18px 20px" },
  exercisePanelTitle: { fontSize: 14, fontWeight: 700, color: "#E4E5E5", marginBottom: 14 },
  exerciseList:       { paddingLeft: 20, display: "flex", flexDirection: "column" as const, gap: 8 },
  exerciseHint:       { fontSize: 12, color: "#8B949E", marginTop: 12, marginBottom: 6 },
  exerciseDone:       { fontSize: 12, color: "#4ADE80", fontWeight: 600, margin: 0 },
  inlineCode:         { background: "#0D1117", padding: "2px 5px", borderRadius: 3, fontFamily: "monospace", fontSize: 11, color: "#4ADE80", border: "1px solid #3D444D" },

  statusBar: { padding: "10px 14px", borderRadius: 8, border: "1px solid" },

  /* presigned URL reveal */
  psuRoot:           { background: "#2a3039", border: "1px solid #3D444D", borderRadius: 12, overflow: "hidden" },
  psuHeader:         { display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderBottom: "1px solid #21262D" },
  psuThumb:          { width: 36, height: 36, borderRadius: 6, overflow: "hidden", flexShrink: 0, background: "#0D1117" },
  psuFileName:       { fontSize: 12, fontWeight: 600, color: "#E4E5E5", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const },
  psuSubline:        { fontSize: 11, color: "#6E7681", marginTop: 1 },
  psuOpenBtn:        { background: "#166534", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700, color: "#4ADE80", padding: "4px 8px", borderRadius: 6, flexShrink: 0 },
  psuExpandBtn:      { background: "none", border: "none", cursor: "pointer", fontSize: 10, color: "#6E7681", padding: "4px 6px", flexShrink: 0 },
  psuExpiryRow:      { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px 0" },
  psuBarWrap:        { flex: 1, height: 4, background: "#21262D", borderRadius: 4, overflow: "hidden" },
  psuBar:            { height: "100%", borderRadius: 4, transition: "width 1s linear, background .5s" },
  psuTimer:          { fontSize: 11, fontWeight: 700, fontFamily: "monospace", whiteSpace: "nowrap" as const, minWidth: 52 },
  psuExpiryNote:     { fontSize: 11, color: "#8B949E", padding: "5px 12px 10px", lineHeight: 1.6, margin: 0 },
  psuLearnLink:      { background: "none", border: "none", cursor: "pointer", color: "#4ADE80", fontSize: 11, padding: "0 0 0 4px", fontWeight: 600 },
  psuBreakdown:      { borderTop: "1px solid #21262D", padding: "12px 12px 14px", display: "flex", flexDirection: "column" as const, gap: 8 },
  psuBreakdownTitle: { fontSize: 11, fontWeight: 700, color: "#6E7681", textTransform: "uppercase" as const, letterSpacing: ".5px", margin: 0 },
  urlPart:           { display: "flex", gap: 8, alignItems: "flex-start" },
  urlPartLabel:      { fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, border: "1px solid", whiteSpace: "nowrap" as const, flexShrink: 0, marginTop: 1 },
  urlPartValue:      { fontSize: 11, fontFamily: "monospace", color: "#E4E5E5", display: "block", wordBreak: "break-all" as const, background: "#0D1117", padding: "2px 5px", borderRadius: 3 },
  urlPartNote:       { fontSize: 11, color: "#8B949E", lineHeight: 1.5, margin: "3px 0 0" },
  psuRawWrap:        { display: "flex", gap: 6, alignItems: "flex-start", marginTop: 4 },
  psuRawBox:         { flex: 1, fontFamily: "monospace", fontSize: 10, padding: "7px 8px", borderRadius: 6, border: "1px solid #3D444D", background: "#0D1117", resize: "none" as const, color: "#8B949E", lineHeight: 1.5 },
  psuCopyBtn:        { background: "#166534", color: "#4ADE80", border: "none", borderRadius: 6, padding: "6px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" as const, flexShrink: 0 },

  statRow: { display: "flex", gap: 16, padding: "16px 0", borderTop: "1px solid #21262D" },
  stat:    { flex: 1, display: "flex", flexDirection: "column" as const, gap: 2 },
  statVal: { fontSize: 22, fontWeight: 700, color: "#E4E5E5", lineHeight: 1 },
  statKey: { fontSize: 11, color: "#6E7681" },

  /* gallery */
  galleryArea:     { flex: 1, minWidth: 0 },
  galleryTopBar:   { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  galleryControls: { display: "flex", alignItems: "center", gap: 10 },
  sliderLabel:     { fontSize: 11, color: "#8B949E", whiteSpace: "nowrap" as const },
  sliderValue:     { fontSize: 11, fontFamily: "monospace", color: "#4ADE80", minWidth: 36, textAlign: "right" as const },
  refreshBtn:      { background: "#2a3039", border: "1px solid #3D444D", borderRadius: 8, padding: "6px 12px", fontSize: 16, cursor: "pointer", color: "#8B949E", lineHeight: 1 },
  empty:           { textAlign: "center" as const, padding: "60px 0" },
  grid:            { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 },
  tile:            { borderRadius: 10, overflow: "hidden", border: "1px solid #3D444D", background: "#2a3039" },
  imgWrap:         { width: "100%", aspectRatio: "1/1", background: "#0D1117", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", position: "relative" as const },
  img:             { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  tileOpenBtn:     { position: "absolute" as const, top: 6, right: 6, background: "rgba(0,0,0,.65)", border: "none", color: "#4ADE80", borderRadius: 6, padding: "3px 7px", fontSize: 13, fontWeight: 700, cursor: "pointer" },
  tileCaption:     { padding: "8px 10px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 },
  tileFilename:    { fontSize: 11, color: "#C6C7C7", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, flex: 1 },
  tileMeta:        { fontSize: 11, color: "#6E7681", whiteSpace: "nowrap" as const, flexShrink: 0 },

  /* modal */
  overlay:      { position: "fixed" as const, inset: 0, background: "rgba(0,0,0,.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 24 },
  modal:        { background: "#2a3039", borderRadius: 16, overflow: "hidden", maxWidth: 640, width: "100%", maxHeight: "90vh", overflowY: "auto" as const, position: "relative" as const, boxShadow: "0 24px 60px rgba(0,0,0,.6)", border: "1px solid #3D444D" },
  modalClose:   { position: "absolute" as const, top: 14, right: 14, background: "rgba(0,0,0,.5)", border: "none", color: "#E4E5E5", width: 28, height: 28, borderRadius: "50%", cursor: "pointer", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10 },
  modalImgWrap: { background: "#0D1117", maxHeight: 300, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  modalImg:     { maxWidth: "100%", maxHeight: 300, objectFit: "contain", display: "block" },
  modalInfo:    { padding: "20px 24px" },
  modalFilename:{ fontSize: 16, fontWeight: 600, color: "#E4E5E5", marginBottom: 16 },
  modalMeta:    { display: "flex", flexDirection: "column" as const, gap: 8, marginBottom: 20 },
  metaRow:      { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, padding: "8px 0", borderBottom: "1px solid #21262D" },
  metaLabel:    { fontSize: 11, fontWeight: 600, color: "#6E7681", textTransform: "uppercase" as const, letterSpacing: ".4px", whiteSpace: "nowrap" as const },
  metaValue:    { fontSize: 13, color: "#C6C7C7", textAlign: "right" as const, wordBreak: "break-all" as const },
  modalActions: { display: "flex", flexDirection: "column" as const, gap: 8, marginTop: 16 },
  openBtn:      { width: "100%", padding: "10px 0", background: "#166534", color: "#4ADE80", border: "1px solid #4ADE8044", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600 },
  deleteBtn:    { width: "100%", padding: "10px 0", background: "#3d0a0a", color: "#ef4444", border: "1px solid #ef444444", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600 },

  /* shard distribution */
  shardSection: { background: "#0D1117", border: "1px solid #3D444D", borderRadius: 10, padding: "14px 16px", marginBottom: 16 },
  shardTitle:   { fontSize: 12, fontWeight: 700, color: "#8B949E", marginBottom: 10 },
  shardGrid:    { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 10 },
  shardCard:    { borderRadius: 8, border: "1px solid", padding: "8px 6px", display: "flex", flexDirection: "column" as const, alignItems: "center", gap: 4, transition: "all .4s" },
  shardLabel:   { fontSize: 13, fontWeight: 800, fontFamily: "monospace", transition: "color .4s" },
  shardNodeId:  { fontSize: 10, color: "#8B949E" },
  shardRole:    { fontSize: 10, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: ".04em", transition: "color .4s" },
  shardStatus:  { fontSize: 14, lineHeight: 1, transition: "color .4s" },
  shardNote:    { fontSize: 11, color: "#8B949E", lineHeight: 1.5, margin: 0 },

  /* erasure coding panel */
  ecPanel:         { background: "#2a3039", border: "1px solid #3D444D", borderRadius: 14, padding: "16px 20px", display: "flex", flexDirection: "column" as const, gap: 12 },
  ecPanelHeader:   { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 },
  ecTitle:         { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" as const },
  ecTitleText:     { fontSize: 13, fontWeight: 700, color: "#E4E5E5" },
  ecFormula:       { fontSize: 12, fontWeight: 700, fontFamily: "monospace", background: "#0D1117", color: "#4ADE80", padding: "2px 9px", borderRadius: 6, border: "1px solid #3D444D" },
  ecFormulaNote:   { fontSize: 11, color: "#6E7681" },
  ecLearnBtn:      { background: "none", border: "1px solid #3D444D", borderRadius: 8, padding: "4px 10px", fontSize: 11, fontWeight: 600, color: "#8B949E", cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" as const },
  ecNodeRow:       { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 },
  ecNodeCard:      { background: "#1E242C", border: "1px solid #3D444D", borderRadius: 10, padding: "10px 8px", display: "flex", flexDirection: "column" as const, alignItems: "center", gap: 5 },
  ecNodeIndicator: { width: 10, height: 10, borderRadius: "50%", transition: "background .4s, box-shadow .4s" },
  ecNodeId:        { fontSize: 11, fontWeight: 600, color: "#E4E5E5" },
  ecShardBadge:    { fontSize: 10, fontWeight: 700, fontFamily: "monospace", padding: "2px 7px", borderRadius: 4, border: "1px solid", transition: "all .4s" },
  ecNodeStatus:    { fontSize: 10, fontWeight: 600, transition: "color .4s" },
  ecStatusBar:     { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 8, border: "1px solid", transition: "all .4s", flexWrap: "wrap" as const },
  ecStatusDot:     { width: 8, height: 8, borderRadius: "50%", flexShrink: 0, transition: "all .4s" },
  ecStatusMsg:     { fontSize: 12, fontWeight: 600, flex: 1, transition: "color .4s" },
  ecQuorumBadges:  { display: "flex", gap: 6 },
  ecQuorumBadge:   { fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 99 },
  ecHint:          { fontSize: 11, color: "#6E7681", margin: 0, lineHeight: 1.6 },
  ecHintCode:      { background: "#0D1117", padding: "1px 5px", borderRadius: 4, fontFamily: "monospace", fontSize: 11, color: "#4ADE80", border: "1px solid #3D444D" },

  /* learn page */
  learnWrap:     { maxWidth: 760, margin: "0 auto", padding: "40px 24px 60px" },
  learnHeader:   { marginBottom: 32 },
  learnH1:       { fontSize: 32, fontWeight: 800, color: "#E4E5E5", letterSpacing: "-0.8px", marginBottom: 8 },
  learnSubtitle: { fontSize: 16, color: "#8B949E" },

  /* core ideas block */
  coreBlock:      { background: "#2a3039", border: "1px solid #3D444D", borderRadius: 14, padding: "24px 28px", marginBottom: 28 },
  coreBlockLabel: { fontSize: 11, fontWeight: 700, color: "#6E7681", textTransform: "uppercase" as const, letterSpacing: ".8px", marginBottom: 16 },
  coreGrid:       { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 20 },
  coreIdea:       { display: "flex", flexDirection: "column" as const, gap: 6 },
  coreIdeaTitle:  { fontSize: 13, fontWeight: 700, color: "#E4E5E5", margin: 0 },
  coreIdeaText:   { fontSize: 12, color: "#8B949E", lineHeight: 1.65, margin: 0 },

  /* concept cards */
  conceptCard:   { background: "#2a3039", border: "1px solid #3D444D", borderRadius: 16, marginBottom: 20, overflow: "hidden", scrollMarginTop: 80 },
  conceptHeader: { display: "flex", alignItems: "center", gap: 14, padding: "18px 24px", borderBottom: "1px solid #21262D", position: "relative" as const, overflow: "hidden" },
  conceptAccent: { position: "absolute" as const, right: 0, top: 0, width: 4, height: "100%", opacity: 0.6 },
  conceptBadge:  { fontSize: 11, fontWeight: 800, padding: "4px 8px", borderRadius: 6, letterSpacing: ".5px", flexShrink: 0 },
  conceptTitle:  { fontSize: 18, fontWeight: 700, color: "#E4E5E5", letterSpacing: "-0.3px" },
  conceptTagline:{ fontSize: 12, fontWeight: 500, marginTop: 1 },
  conceptBody:   { padding: "20px 24px", display: "flex", flexDirection: "column" as const, gap: 12 },

  exBadgePending: { fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 20, background: "#2a3039", color: "#6E7681", border: "1px solid #3D444D", whiteSpace: "nowrap" as const, flexShrink: 0 },
  exBadgeDone:    { fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 20, background: "#166534", color: "#4ADE80", whiteSpace: "nowrap" as const, flexShrink: 0 },

  /* good to know */
  gtkStrip:  { background: "#2a3039", border: "1px solid #3D444D", borderRadius: 12, padding: "18px 22px", marginBottom: 24, display: "flex", flexDirection: "column" as const, gap: 10 },
  gtkHeader: { fontSize: 11, fontWeight: 700, color: "#6E7681", textTransform: "uppercase" as const, letterSpacing: ".8px" },
  gtkItem:   { fontSize: 13, color: "#8B949E", lineHeight: 1.6, margin: 0, display: "flex", gap: 8 },
  gtkDot:    { color: "#21262D", flexShrink: 0, marginTop: 1 },

  codeBlock:   { background: "#0D1117", color: "#C6C7C7", padding: "14px 16px", borderRadius: 8, overflowX: "auto" as const, fontSize: 12, lineHeight: 1.7, whiteSpace: "pre" as const, border: "1px solid #3D444D" },
  infoBox:     { display: "flex", gap: 10, alignItems: "flex-start", background: "#16653422", border: "1px solid #16653455", borderRadius: 8, padding: "12px 14px" },
  infoBoxIcon: { fontSize: 16, flexShrink: 0 },
  learnFooter: { textAlign: "center" as const, padding: "24px 0 0", borderTop: "1px solid #21262D" },
};

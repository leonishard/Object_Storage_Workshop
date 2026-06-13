import { useState, useEffect, useRef } from "react";

/* ─── helpers ────────────────────────────────────────────── */
function parseAmzDate(s: string): number | null {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

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

function formatBytes(b: number) {
  if (b < 1024)        return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
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

interface UploadProgress {
  loaded:      number;
  total:       number;
  done:        boolean;
  error:       string | null;
  isMultipart: boolean;
  part?:       number | null;
}

type ConceptId =
    | "presigned-url"
    | "object-metadata"
    | "buckets"
    | "s3-api"
    | "versioning"
    | "bucket-policy"
    | "direct-upload"
    | "erasure-coding"
    | "multipart-upload";

interface InsightEvent {
  conceptId: ConceptId;
  label:     string;
  detail:    string;
}

const CONCEPTS: Record<ConceptId, { title: string; anchor: string }> = {
  "presigned-url":   { title: "Presigned URLs",    anchor: "concept-presigned"  },
  "object-metadata": { title: "Object Metadata",   anchor: "concept-metadata"   },
  buckets:           { title: "Buckets",            anchor: "concept-buckets"    },
  "s3-api":          { title: "S3 API Compat.",     anchor: "concept-s3"         },
  versioning:        { title: "Versioning",         anchor: "concept-versioning" },
  "bucket-policy":   { title: "Bucket Policies",   anchor: "concept-policy"     },
  "direct-upload":   { title: "Direct Upload",     anchor: "concept-direct-upload" },
  "erasure-coding":  { title: "Erasure Coding",    anchor: "concept-erasure"    },
  "multipart-upload":{ title: "Multipart Upload",  anchor: "concept-multipart"  },
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
  const [gallery,           setGallery]           = useState<GalleryItem[]>([]);
  const [uploading,         setUploading]         = useState(false);
  const [status,            setStatus]            = useState<{ ok: boolean; text: string } | null>(null);
  const [lastUpload,        setLastUpload]        = useState<GalleryItem | null>(null);
  const [dragOver,          setDragOver]          = useState(false);
  const [selected,          setSelected]          = useState<GalleryItem | null>(null);
  const [insights,          setInsights]          = useState<InsightEvent[]>([]);
  const [deleting,          setDeleting]          = useState(false);
  const [uploadMode,        setUploadMode]        = useState<"server" | "direct">("server");
  const [directInfo,        setDirectInfo]        = useState<{ url: string; key: string; file: File } | null>(null);
  const [directReady,       setDirectReady]       = useState(false);
  const [expirySeconds,     setExpirySeconds]     = useState(() => parseInt(localStorage.getItem("expirySeconds") || "30"));
  // Slider minimum is 5 — MinIO's hard per-part floor means files under 5 MB
  // always use single PUT regardless of this value.
  const [multipartMB,       setMultipartMB]       = useState(() => Math.max(5, parseInt(localStorage.getItem("multipartMB") || "5")));
  const [uploadProgress,    setUploadProgress]    = useState<UploadProgress | null>(null);
  const [cluster,           setCluster]           = useState<ClusterHealth | null>(null);

  const fileRef    = useRef<HTMLInputElement>(null);
  const sseRef     = useRef<EventSource | null>(null);

  function pushInsight(ev: InsightEvent) {
    setInsights((prev) => prev.find((e) => e.conceptId === ev.conceptId) ? prev : [...prev, ev]);
  }

  // ── Node polling ──────────────────────────────────────────────────────────
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
      pushInsight({ conceptId: "buckets", label: "Bucket loaded",  detail: `${data.length} object(s) retrieved.` });
      pushInsight({ conceptId: "s3-api",  label: "S3 API used",    detail: "ListObjectsV2 called via the S3-compatible MinIO endpoint." });
    }
    return data;
  }

  useEffect(() => { fetchGallery(); }, []);

  // ── Server upload with SSE progress ──────────────────────────────────────
  async function serverUpload(file: File) {
    setUploading(true);
    setStatus(null);
    setLastUpload(null);
    setUploadProgress(null);

    const uploadId   = `upload-${Date.now()}`;
    const thresholdB = Math.max(5 * 1024 * 1024, multipartMB * 1024 * 1024);
    const willMultipart = file.size >= thresholdB;

    // Open SSE connection before POSTing so we don't miss early progress events
    sseRef.current?.close();
    const sse = new EventSource(`/upload-progress/${uploadId}`);
    sseRef.current = sse;

    sse.onmessage = (e) => {
      const p: UploadProgress = JSON.parse(e.data);
      setUploadProgress(p);
      if (p.done || p.error) {
        sse.close();
        sseRef.current = null;
      }
    };
    sse.onerror = () => { sse.close(); sseRef.current = null; };

    if (willMultipart) {
      pushInsight({
        conceptId: "multipart-upload",
        label:     "Multipart upload triggered",
        detail:    `File (${formatBytes(file.size)}) ≥ threshold (${multipartMB} MB) — uploading in chunks.`,
      });
    }

    const form = new FormData();
    form.append("image", file);

    const res  = await fetch(
        `/upload?expiresIn=${expirySeconds}&multipartMB=${multipartMB}&uploadId=${uploadId}`,
        { method: "POST", body: form }
    );
    const data = await res.json();
    setUploading(false);

    if (!res.ok) {
      setStatus({ ok: false, text: `Upload failed: ${data.error}${data.detail ? ` — ${data.detail}` : ""}` });
      return;
    }

    const modeLabel = data.isMultipart ? "multipart" : "single PUT";
    setStatus({ ok: true, text: `"${file.name}" uploaded via server (${modeLabel})` });

    const updated = await fetchGallery();
    const newest  = updated.find((i) => i.key === data.key);
    if (newest) {
      setLastUpload(newest);
      pushInsight({ conceptId: "presigned-url", label: "Presigned URL issued", detail: "Image accessible via a time-limited signed URL." });
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  // ── Direct upload (unchanged) ─────────────────────────────────────────────
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

            {/* Multipart threshold slider — only shown in Via Server mode */}
            {uploadMode === "server" && (
                <div style={s.sliderCard}>
                  <div style={s.sliderCardHeader}>
                    <span style={s.sliderCardTitle}>Multipart threshold</span>
                    <span style={s.sliderCardValue}>{multipartMB} MB</span>
                  </div>
                  <input
                      type="range" min={5} max={50} value={multipartMB}
                      style={{ width: "100%", accentColor: "#059669" }}
                      onChange={(e) => {
                        const v = parseInt(e.target.value);
                        setMultipartMB(v);
                        localStorage.setItem("multipartMB", String(v));
                      }}
                  />
                  <p style={s.sliderCardHint}>
                    Files ≥ {multipartMB} MB use multipart upload (chunked). Files under 5 MB always use a single PUT — MinIO enforces a 5 MB minimum part size.
                    <button style={s.sliderLearnLink} onClick={() => onOpenConcept("multipart-upload")}>Learn more ↗</button>
                  </p>
                </div>
            )}

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
                  <div style={{ padding: "8px 0" }}>
                    <UploadProgressBar progress={uploadProgress} />
                  </div>
              ) : directReady && directInfo ? (
                  <div onClick={(e) => e.stopPropagation()}>
                    <p style={{ ...s.dropText, color: "#059669", fontWeight: 600, marginBottom: 6 }}>✓ Upload URL ready</p>
                    <p style={{ ...s.dropSub, marginBottom: 10 }}>{directInfo.file.name}</p>
                    <button style={s.uploadDirectBtn} onClick={executeDirectUpload}>Upload to MinIO →</button>
                  </div>
              ) : (
                  <>
                    <div style={s.dropIconWrap}>
                      <svg width="28" height="28" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} style={{ color: "#94a3b8" }}>
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
                    <FlowRow label="Browser" note="your tab"  color="#059669" />
                    <FlowArrow label="GET /presign-upload" sub="got the URL ✓" />
                    <FlowRow label="Backend" note="Express"   color="#10b981" />
                    <FlowArrow label="— no file bytes —" sub="backend is done" dim />
                    <FlowArrow label="PUT {signed URL}" sub="step 2 →" color="#10b981" />
                    <FlowRow label="MinIO"   note=":9000"     color="#10b981" />
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
                <div style={{ ...s.exercisePanel, background: "#ecfdf5", borderColor: "#059669" }}>
                  <p style={{ ...s.exercisePanelTitle, color: "#059669" }}>✓ Exercise complete</p>
                  <p style={{ fontSize: 12, color: "#059669", margin: 0 }}>You implemented the presigned PUT route. Direct upload is live.</p>
                </div>
            )}

            {status && (
                <div style={{ ...s.statusBar, background: status.ok ? "#f0fdf4" : "#fff1f2", borderColor: status.ok ? "#059669" : "#ef4444" }}>
                  <span style={{ color: status.ok ? "#059669" : "#dc2626", fontSize: 13 }}>{status.ok ? "✓" : "✗"} {status.text}</span>
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
                <span style={s.sliderLabel}>URL expiry</span>
                <input
                    type="range" min={5} max={300} value={expirySeconds}
                    style={{ accentColor: "#059669" }}
                    onChange={(e) => {
                      const v = parseInt(e.target.value);
                      setExpirySeconds(v);
                      localStorage.setItem("expirySeconds", String(v));
                      fetchGallery(v);
                    }}
                />
                <span style={s.sliderValue}>{expirySeconds}s</span>
              </div>
            </div>

            {gallery.length === 0 ? (
                <div style={s.empty}>
                  <p style={{ fontSize: 48, margin: "0 0 12px" }}>🗄️</p>
                  <p style={{ color: "#64748b", margin: 0, fontSize: 14 }}>No images yet — upload one to get started.</p>
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
                          <TileTimer url={item.url} />
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
                            const color    = isData ? "#059669" : "#10b981";
                            const label    = isData ? `D${i + 1}` : `P${i - cluster.ec.data + 1}`;
                            const roleText = isData ? "data" : "parity";
                            return (
                                <div key={node.id} style={{ ...s.shardCard, opacity: isUp ? 1 : 0.45, borderColor: isUp ? color + "55" : "#e2e8f0", background: isUp ? color + "11" : "#f8fafc" }}>
                                  <div style={{ ...s.shardLabel, color: isUp ? color : "#94a3b8" }}>{label}</div>
                                  <div style={s.shardNodeId}>Node {node.id}</div>
                                  <div style={{ ...s.shardRole, color: isUp ? color : "#94a3b8" }}>{roleText}</div>
                                  <div style={{ ...s.shardStatus, color: isUp ? "#10b981" : "#ef4444" }}>{isUp ? "●" : "✕"}</div>
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
   UPLOAD PROGRESS BAR
   Shown inside the drop zone during a Via Server upload.
   Displays differently for multipart vs single PUT.
═══════════════════════════════════════════════════════════ */
function UploadProgressBar({ progress }: { progress: UploadProgress | null }) {
  if (!progress) {
    return (
        <div style={s.progressWrap}>
          <div style={s.spinnerWrap}><div style={s.spinner} /></div>
          <p style={{ ...s.dropSub, marginTop: 8 }}>Preparing upload…</p>
        </div>
    );
  }

  const pct   = progress.total > 0 ? Math.min(100, (progress.loaded / progress.total) * 100) : 0;
  const color = progress.error ? "#ef4444" : progress.done ? "#059669" : "#10b981";

  return (
      <div style={s.progressWrap}>
        {/* Mode badge */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{
          ...s.uploadModeBadge,
          background: progress.isMultipart ? "#059669" + "22" : "#64748b22",
          color:      progress.isMultipart ? "#059669"        : "#64748b",
          borderColor:progress.isMultipart ? "#059669" + "44" : "#64748b44",
        }}>
          {progress.isMultipart ? "⚡ Multipart" : "→ Single PUT"}
        </span>
          <span style={{ fontSize: 11, fontFamily: "monospace", color }}>
          {progress.done ? "✓ Done" : progress.error ? "✗ Failed" : `${pct.toFixed(0)}%`}
        </span>
        </div>

        {/* Progress bar */}
        <div style={s.progressBarWrap}>
          <div style={{ ...s.progressBar, width: `${pct}%`, background: color, transition: "width .2s, background .3s" }} />
        </div>

        {/* Stats row */}
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
        <span style={{ fontSize: 11, color: "#64748b" }}>
          {formatBytes(progress.loaded)} / {formatBytes(progress.total)}
        </span>
          {progress.isMultipart && progress.part && (
              <span style={{ fontSize: 11, color: "#059669", fontWeight: 600 }}>
            Part {progress.part}
          </span>
          )}
        </div>

        {/* Multipart explanation shown during upload */}
        {progress.isMultipart && !progress.done && !progress.error && (
            <p style={{ fontSize: 11, color: "#64748b", marginTop: 8, lineHeight: 1.5 }}>
              File is being split into chunks and uploaded simultaneously to MinIO.
            </p>
        )}

        {progress.error && (
            <p style={{ fontSize: 11, color: "#ef4444", marginTop: 6 }}>{progress.error}</p>
        )}
      </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   NODE STATUS PANEL (unchanged)
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
                  <div style={{ ...s.ecNodeIndicator, background: "#e2e8f0" }} />
                  <div style={s.ecNodeId}>Node {id}</div>
                  <div style={{ ...s.ecShardBadge, background: "#f1f5f9", color: "#94a3b8", borderColor: "#e2e8f0" }}>—</div>
                  <div style={{ ...s.ecNodeStatus, color: "#94a3b8" }}>…</div>
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
      upCount === 4 ? "#10b981" : upCount === 3 ? "#f97316" : upCount === 2 ? "#f97316" : "#ef4444";

  const shardMeta = [
    { label: "D1", color: "#059669", title: "Data shard 1"   },
    { label: "D2", color: "#059669", title: "Data shard 2"   },
    { label: "P1", color: "#10b981", title: "Parity shard 1" },
    { label: "P2", color: "#10b981", title: "Parity shard 2" },
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
                  <div style={{ ...s.ecNodeIndicator, background: isUp ? "#10b981" : "#ef4444", boxShadow: isUp ? "0 0 8px #10b98155" : "0 0 8px #ef444455" }} />
                  <div style={s.ecNodeId}>Node {node.id}</div>
                  <div title={meta.title} style={{ ...s.ecShardBadge, background: isUp ? meta.color + "22" : "#f1f5f9", color: isUp ? meta.color : "#94a3b8", borderColor: isUp ? meta.color + "55" : "#e2e8f0" }}>
                    {meta.label}
                  </div>
                  <div style={{ ...s.ecNodeStatus, color: isUp ? "#10b981" : "#ef4444" }}>{isUp ? "online" : "offline"}</div>
                </div>
            );
          })}
        </div>
        <div style={{ ...s.ecStatusBar, borderColor: statusColor + "44", background: statusColor + "11" }}>
          <div style={{ ...s.ecStatusDot, background: statusColor, boxShadow: `0 0 6px ${statusColor}66` }} />
          <span style={{ ...s.ecStatusMsg, color: statusColor }}>{statusMsg}</span>
          <div style={s.ecQuorumBadges}>
            <span style={{ ...s.ecQuorumBadge, background: canRead  ? "#d1fae5" : "#fee2e2", color: canRead  ? "#059669" : "#dc2626" }}>Read {canRead   ? "✓" : "✗"}</span>
            <span style={{ ...s.ecQuorumBadge, background: canWrite ? "#d1fae5" : "#fee2e2", color: canWrite ? "#059669" : "#dc2626" }}>Write {canWrite ? "✓" : "✗"}</span>
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
        <span style={{ fontSize: 13, fontWeight: 600, color: "#0f172a" }}>{label}</span>
        <span style={{ fontSize: 11, color: "#94a3b8" }}>{note}</span>
      </div>
  );
}

function FlowArrow({ label, sub, color, dim }: { label: string; sub: string; color?: string; dim?: boolean }) {
  return (
      <div style={{ paddingLeft: 5, display: "flex", flexDirection: "column", gap: 2 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 1, height: 18, background: "#e2e8f0", marginLeft: 4 }} />
          <span style={{ fontSize: 11, color: dim ? "#94a3b8" : color || "#64748b", fontFamily: "monospace", fontStyle: dim ? "italic" : "normal" }}>{label}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 1, height: 8, background: "#e2e8f0", marginLeft: 4 }} />
          <span style={{ fontSize: 10, color: "#94a3b8" }}>{sub}</span>
        </div>
      </div>
  );
}

/* ── Presigned URL Reveal ── */
function PresignedUrlReveal({ item, onOpenConcept }: { item: GalleryItem; onOpenConcept: (id: ConceptId) => void }) {
  const [expanded,    setExpanded]    = useState(false);
  const [copied,      setCopied]      = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const parsed = parsePresignedUrl(item.url);

  useEffect(() => {
    if (!parsed) return;
    const signedAt = parseAmzDate(parsed.date);
    const duration = parseInt(parsed.expiry);
    if (!signedAt || isNaN(duration)) return;
    const expiresAt = signedAt + duration * 1000;
    function tick() { setSecondsLeft(Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))); }
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [item.url]);

  const duration = parsed ? parseInt(parsed.expiry) : 30;

  function copy() { navigator.clipboard.writeText(item.url); setCopied(true); setTimeout(() => setCopied(false), 2000); }

  const pct   = duration > 0 ? secondsLeft / duration : 0;
  const mins  = Math.floor(secondsLeft / 60);
  const secs  = secondsLeft % 60;
  const color = pct > 0.5 ? "#10b981" : pct > 0.2 ? "#f97316" : "#ef4444";

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
          Signed GET URL — expires in {duration}s. Open in a new tab, wait, then refresh to see the 403.
          <button style={s.psuLearnLink} onClick={() => onOpenConcept("presigned-url")}>Learn why ↗</button>
        </p>
        {expanded && parsed && (
            <div style={s.psuBreakdown}>
              <p style={s.psuBreakdownTitle}>URL breakdown</p>
              <UrlPart color="#059669" label="Host"            value={parsed.host}                       note="MinIO's endpoint. In production: your S3 domain or CDN." />
              <UrlPart color="#10b981" label="Bucket / Key"    value={`/${parsed.bucket}/${parsed.key}`} note="Bucket name + object key." />
              <UrlPart color="#f97316" label="X-Amz-Date"      value={parsed.date}                       note="When the signature was generated — baked in so it can't be reused." />
              <UrlPart color="#ef4444" label="X-Amz-Expires"   value={`${parsed.expiry}s`}               note="How long until the URL stops working. Tamper with this and the signature breaks." />
              <UrlPart color="#10b981" label="X-Amz-Signature" value={parsed.sig}                        note="HMAC-SHA256 of the URL + expiry + your secret key. Change anything above and this won't match." />
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

function TileTimer({ url }: { url: string }) {
  const parsed = parsePresignedUrl(url);
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!parsed) return;
    const signedAt = parseAmzDate(parsed.date);
    const duration = parseInt(parsed.expiry);
    if (!signedAt || isNaN(duration)) return;
    const expiresAt = signedAt + duration * 1000;
    function tick() { setSecs(Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))); }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [url]);
  if (!parsed) return null;
  const total = parseInt(parsed.expiry);
  const pct   = total > 0 ? secs / total : 0;
  const color = pct > 0.5 ? "#10b981" : pct > 0.2 ? "#f97316" : "#ef4444";
  return (
      <span style={{ fontSize: 10, fontFamily: "monospace", fontWeight: 700, color, flexShrink: 0, whiteSpace: "nowrap" as const }}>
      {secs > 0 ? `${secs}s` : "exp"}
    </span>
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

        <ConceptCard id="concept-buckets" badge="01" title="Buckets & Objects" tagline="Flat key-value store" color="#059669">
          <p>A <strong>bucket</strong> is a flat namespace. Every file you upload becomes an <strong>object</strong> with three things: bytes, a key, and metadata. There is no directory tree — <code>2024/photo.png</code> and <code>2024/other.png</code> are just two strings that share a prefix.</p>
          <CodeBlock>{`const list = await s3.send(new ListObjectsV2Command({ Bucket: "workshop-images" }));
// Each entry: { Key, Size, ETag, LastModified }`}</CodeBlock>
          <InfoBox>Click any image in the gallery. The <strong>Object key</strong> row shows the full key MinIO uses — no folder, just a timestamp-prefixed string.</InfoBox>
        </ConceptCard>

        <ConceptCard id="concept-presigned" badge="02" title="Presigned GET URLs" tagline="Temporary, unforgeable read links" color="#10b981">
          <p>After listing objects, the backend calls <code>getSignedUrl</code> for each key. The result is a normal HTTPS URL with an HMAC-SHA256 signature baked into the query string.</p>
          <CodeBlock>{`const url = await getSignedUrl(
  s3,
  new GetObjectCommand({ Bucket: BUCKET, Key: "photo.jpg" }),
  { expiresIn: 30 }    // set via the slider in the Gallery tab
);`}</CodeBlock>
          <InfoBox>Use the expiry slider, upload an image, click ↗ to open it in a new tab — then wait for the timer to hit zero and refresh that tab to get a 403.</InfoBox>
        </ConceptCard>

        <ConceptCard id="concept-direct-upload" badge="03" title="Direct Upload — Presigned PUT" tagline="Backend as keyholder, not middleman" color="#f97316" exerciseBadge={{ completed: exerciseCompleted }}>
          <p>A presigned URL works for <em>writes</em> too. The backend signs a PUT URL and returns it; the browser uploads straight to MinIO. The server never touches the file bytes.</p>
          <CodeBlock>{`// Via server:  Browser → Express → MinIO  (bytes go through Express)
// Direct:      Browser → MinIO            (bytes skip Express entirely)
//              Express only signs a URL — one tiny JSON response`}</CodeBlock>
          <InfoBox>Switch to "Direct to MinIO" in the Gallery tab. Pick a file to see the signed PUT URL before you upload.</InfoBox>
        </ConceptCard>

        <ConceptCard id="concept-multipart" badge="04" title="Multipart Upload" tagline="Large files in parallel chunks" color="#8b5cf6">
          <p>
            For files above the threshold, <code>@aws-sdk/lib-storage</code> automatically splits the file into parts
            and uploads them concurrently. MinIO assembles the parts atomically — if the upload fails partway through,
            only the failed parts need to be retried, not the whole file.
          </p>
          <CodeBlock>{`const managed = new Upload({
  client:    s3,
  queueSize: 4,          // 4 parts uploading simultaneously
  partSize:  threshold,  // set by the slider in MB (minimum 5 MB — MinIO hard floor)
  params: {
    Bucket: BUCKET, Key: key,
    Body:   fileBuffer,
    Tagging: "upload-mode=multipart",   // object tag applied automatically
  },
});

managed.on("httpUploadProgress", (p) => {
  console.log(\`Part \${p.part}: \${p.loaded} / \${p.total} bytes\`);
});

await managed.done();   // MinIO assembles all parts here`}</CodeBlock>
          <p>
            The <strong>multipart threshold slider</strong> in the Gallery tab controls when this kicks in (minimum 5 MB).
            Files under 5 MB always use a single PUT — MinIO enforces a 5 MB minimum per part.
            Use a file above your slider value to see chunked uploading in action.
          </p>
          <InfoBox>
            Upload a file in "Via Server" mode. The progress bar shows "⚡ Multipart" or "→ Single PUT" depending on whether your file meets the threshold. Part numbers appear in real time as each chunk lands.
          </InfoBox>
        </ConceptCard>

        <ConceptCard id="concept-s3" badge="05" title="S3 API Compatibility" tagline="One SDK, any vendor" color="#10b981">
          <p>Amazon S3 defined a standard REST API for object storage. MinIO implements that exact API. The AWS SDK in this project talks to MinIO identically to how it talks to real AWS S3.</p>
          <CodeBlock>{`// Dev (MinIO in Docker) — the only line that changes:
endpoint: "http://localhost:9000"

// Production (AWS S3):
region: "us-east-1"   // no endpoint needed — SDK knows where to go`}</CodeBlock>
        </ConceptCard>

        <ConceptCard id="concept-erasure" badge="06" title="Erasure Coding" tagline="Survive node failures without full copies" color="#ef4444">
          <p>MinIO uses <strong>Reed-Solomon erasure coding</strong> to split each object into shards. With EC:2 across 4 nodes: 2 data shards + 2 parity shards. Any 2 shards reconstruct the full object.</p>
          <CodeBlock>{`Node 1 → Data shard 1     Node 3 → Parity shard 1
Node 2 → Data shard 2     Node 4 → Parity shard 2

Read quorum:  2 nodes   Write quorum: 3 nodes
Storage cost: 2× (not 4× like full replication)`}</CodeBlock>
          <InfoBox>
            Run <code>docker compose stop minio3</code> — the panel turns orange but the gallery loads. Stop minio4 too — reads still work, uploads fail. Start minio3 and uploads restore.
          </InfoBox>
        </ConceptCard>

        <div style={s.gtkStrip}>
          <span style={s.gtkHeader}>Good to know</span>
          <GtkItem text="ETag = MD5 hash of the bytes — use it as a cache fingerprint or deduplication key." />
          <GtkItem text="Objects are immutable: you replace rather than edit. Lifecycle rules auto-expire objects after N days." />
          <GtkItem text="Object tagging: every upload in this app applies upload-mode=multipart or upload-mode=single-put as a tag, visible in the MinIO console under object properties." />
          <GtkItem text="Bucket lifecycle: this project sets a 1-day expiry rule on the bucket at startup — objects auto-delete after 24 hours to keep the demo clean." />
          <GtkItem text="Versioning keeps every overwrite as a new version with its own version ID — deletes create a marker rather than destroying data." />
        </div>

        <div style={s.learnFooter}>
          <p style={{ color: "#64748b", fontSize: 13, margin: 0 }}>
            All concepts are active right now — the Gallery tab is talking to a live 4-node MinIO cluster via Docker.
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
      <p style={s.gtkItem}><span style={s.gtkDot}>·</span>{text}</p>
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
        <span style={{ fontSize: 13, color: "#059669", lineHeight: 1.6 }}>{children}</span>
      </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   STYLES
═══════════════════════════════════════════════════════════ */
const globalCss = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #f8fafc; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  @keyframes highlightPulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(16,185,129,0); }
    40%       { box-shadow: 0 0 0 6px rgba(16,185,129,0.3); }
  }
  .gallery-tile { transition: transform .15s, box-shadow .15s; cursor: pointer; }
  .gallery-tile:hover { transform: translateY(-3px); box-shadow: 0 8px 24px rgba(0,0,0,.12); }
  .tile-open-btn { opacity: 0; transition: opacity .15s; }
  .gallery-tile:hover .tile-open-btn { opacity: 1; }
  .concept-card { animation: fadeIn .3s ease both; }
  .concept-highlight { animation: highlightPulse .6s ease 2; }
  ul, ol { padding-left: 20px; }
  li { margin-bottom: 4px; font-size: 13px; color: #374151; line-height: 1.6; }
  p  { font-size: 14px; color: #374151; line-height: 1.7; margin-bottom: 12px; }
  p:last-child { margin-bottom: 0; }
  strong { color: #0f172a; }
  code { background: #f1f5f9; padding: 1px 5px; border-radius: 4px; font-family: monospace; font-size: 12px; color: #059669; border: 1px solid #e2e8f0; }
`;

const s: Record<string, React.CSSProperties> = {
  root: { minHeight: "100vh", fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif", background: "#f8fafc", color: "#0f172a" },
  nav:          { background: "#ffffff", borderBottom: "1px solid #e2e8f0", position: "sticky", top: 0, zIndex: 50 },
  navInner:     { maxWidth: 1080, margin: "0 auto", padding: "0 24px", height: 56, display: "flex", alignItems: "center", justifyContent: "space-between" },
  navBrand:     { display: "flex", alignItems: "center", gap: 10 },
  navDot:       { width: 10, height: 10, borderRadius: "50%", background: "#10b981", boxShadow: "0 0 10px #10b98155" },
  navTitle:     { fontSize: 16, fontWeight: 700, color: "#0f172a", letterSpacing: "-0.3px" },
  navSub:       { fontSize: 11, color: "#94a3b8", borderLeft: "1px solid #e2e8f0", paddingLeft: 10, marginLeft: 2 },
  navTabs:      { display: "flex", gap: 4 },
  navTab:       { background: "transparent", border: "1px solid transparent", borderRadius: 8, padding: "6px 16px", fontSize: 13, color: "#64748b", cursor: "pointer", fontWeight: 500 },
  navTabActive: { background: "#f1f5f9", borderColor: "#e2e8f0", color: "#0f172a" },
  pageWrap: { maxWidth: 1080, margin: "0 auto", padding: "0 24px 40px" },
  twoCol:   { display: "flex", gap: 24, paddingTop: 20, alignItems: "flex-start" },
  ribbon:      { display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 10, marginTop: 12, flexWrap: "wrap" as const },
  ribbonLabel: { fontSize: 11, fontWeight: 600, color: "#059669", textTransform: "uppercase" as const, letterSpacing: ".5px", whiteSpace: "nowrap" as const },
  ribbonChip:  { display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px", background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 20, fontSize: 12, fontWeight: 500, color: "#059669", cursor: "pointer" },
  chipDot:     { width: 6, height: 6, borderRadius: "50%", background: "#10b981" },
  chipArrow:   { fontSize: 10, opacity: 0.6 },
  sidebar:      { width: 320, flexShrink: 0, display: "flex", flexDirection: "column" as const, gap: 20 },
  sectionTitle: { fontSize: 13, fontWeight: 700, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: ".06em", marginBottom: 12 },
  modeToggle:    { display: "flex", background: "#f1f5f9", borderRadius: 10, padding: 4, gap: 4, border: "1px solid #e2e8f0" },
  modeBtn:       { flex: 1, padding: "8px 10px", fontSize: 12, fontWeight: 600, border: "none", borderRadius: 7, cursor: "pointer", background: "transparent", color: "#64748b" },
  modeBtnActive: { background: "#ffffff", color: "#0f172a", boxShadow: "0 1px 3px rgba(0,0,0,.1)" },

  /* multipart threshold slider card */
  sliderCard:       { background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "14px 16px" },
  sliderCardHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  sliderCardTitle:  { fontSize: 12, fontWeight: 700, color: "#0f172a" },
  sliderCardValue:  { fontSize: 12, fontFamily: "monospace", fontWeight: 700, color: "#059669" },
  sliderCardHint:   { fontSize: 11, color: "#64748b", marginTop: 8, lineHeight: 1.5 },
  sliderLearnLink:  { background: "none", border: "none", cursor: "pointer", color: "#059669", fontSize: 11, padding: "0 0 0 4px", fontWeight: 600 },

  dropZone:        { border: "2px dashed #e2e8f0", borderRadius: 14, padding: "28px 28px", textAlign: "center" as const, cursor: "pointer", background: "#f8fafc", transition: "all .15s", minHeight: 140 },
  dropZoneActive:  { borderColor: "#059669", background: "#ecfdf5" },
  dropIconWrap:    { display: "flex", justifyContent: "center", marginBottom: 14 },
  dropText:        { fontSize: 14, color: "#64748b", marginBottom: 6 },
  dropSub:         { fontSize: 12, color: "#94a3b8" },
  spinnerWrap:     { display: "flex", justifyContent: "center", padding: "8px 0" },
  spinner:         { width: 30, height: 30, border: "3px solid #e2e8f0", borderTopColor: "#10b981", borderRadius: "50%", animation: "spin .7s linear infinite" },
  uploadDirectBtn: { padding: "10px 20px", background: "#059669", color: "#ffffff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600 },

  /* upload progress */
  progressWrap:    { padding: "4px 0", width: "100%" },
  progressBarWrap: { height: 8, background: "#e2e8f0", borderRadius: 8, overflow: "hidden" },
  progressBar:     { height: "100%", borderRadius: 8 },
  uploadModeBadge: { fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, border: "1px solid" },

  directPanel:  { background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "18px 20px", display: "flex", flexDirection: "column" as const, gap: 14 },
  directLabel:  { fontSize: 11, fontWeight: 700, color: "#f97316", textTransform: "uppercase" as const, letterSpacing: ".5px" },
  directUrlBox: { fontFamily: "monospace", fontSize: 10, padding: "10px 12px", borderRadius: 8, border: "1px solid #e2e8f0", background: "#f8fafc", resize: "none" as const, color: "#374151", lineHeight: 1.6, width: "100%" },
  flowDiagram:  { background: "#f8fafc", borderRadius: 8, padding: "14px 16px", display: "flex", flexDirection: "column" as const, gap: 6 },
  exercisePanel:      { background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "18px 20px" },
  exercisePanelTitle: { fontSize: 14, fontWeight: 700, color: "#0f172a", marginBottom: 14 },
  exerciseList:       { paddingLeft: 20, display: "flex", flexDirection: "column" as const, gap: 8 },
  exerciseHint:       { fontSize: 12, color: "#64748b", marginTop: 12, marginBottom: 6 },
  exerciseDone:       { fontSize: 12, color: "#059669", fontWeight: 600, margin: 0 },
  inlineCode:         { background: "#f1f5f9", padding: "2px 5px", borderRadius: 3, fontFamily: "monospace", fontSize: 11, color: "#059669", border: "1px solid #e2e8f0" },
  statusBar: { padding: "10px 14px", borderRadius: 8, border: "1px solid" },
  psuRoot:           { background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 12, overflow: "hidden" },
  psuHeader:         { display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderBottom: "1px solid #e2e8f0" },
  psuThumb:          { width: 36, height: 36, borderRadius: 6, overflow: "hidden", flexShrink: 0, background: "#f1f5f9" },
  psuFileName:       { fontSize: 12, fontWeight: 600, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const },
  psuSubline:        { fontSize: 11, color: "#94a3b8", marginTop: 1 },
  psuOpenBtn:        { background: "#059669", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700, color: "#ffffff", padding: "4px 8px", borderRadius: 6, flexShrink: 0 },
  psuExpandBtn:      { background: "none", border: "none", cursor: "pointer", fontSize: 10, color: "#94a3b8", padding: "4px 6px", flexShrink: 0 },
  psuExpiryRow:      { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px 0" },
  psuBarWrap:        { flex: 1, height: 4, background: "#e2e8f0", borderRadius: 4, overflow: "hidden" },
  psuBar:            { height: "100%", borderRadius: 4, transition: "width 1s linear, background .5s" },
  psuTimer:          { fontSize: 11, fontWeight: 700, fontFamily: "monospace", whiteSpace: "nowrap" as const, minWidth: 52 },
  psuExpiryNote:     { fontSize: 11, color: "#64748b", padding: "5px 12px 10px", lineHeight: 1.6, margin: 0 },
  psuLearnLink:      { background: "none", border: "none", cursor: "pointer", color: "#059669", fontSize: 11, padding: "0 0 0 4px", fontWeight: 600 },
  psuBreakdown:      { borderTop: "1px solid #e2e8f0", padding: "12px 12px 14px", display: "flex", flexDirection: "column" as const, gap: 8 },
  psuBreakdownTitle: { fontSize: 11, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase" as const, letterSpacing: ".5px", margin: 0 },
  urlPart:           { display: "flex", gap: 8, alignItems: "flex-start" },
  urlPartLabel:      { fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, border: "1px solid", whiteSpace: "nowrap" as const, flexShrink: 0, marginTop: 1 },
  urlPartValue:      { fontSize: 11, fontFamily: "monospace", color: "#0f172a", display: "block", wordBreak: "break-all" as const, background: "#f1f5f9", padding: "2px 5px", borderRadius: 3 },
  urlPartNote:       { fontSize: 11, color: "#64748b", lineHeight: 1.5, margin: "3px 0 0" },
  psuRawWrap:        { display: "flex", gap: 6, alignItems: "flex-start", marginTop: 4 },
  psuRawBox:         { flex: 1, fontFamily: "monospace", fontSize: 10, padding: "7px 8px", borderRadius: 6, border: "1px solid #e2e8f0", background: "#f8fafc", resize: "none" as const, color: "#64748b", lineHeight: 1.5 },
  psuCopyBtn:        { background: "#059669", color: "#ffffff", border: "none", borderRadius: 6, padding: "6px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" as const, flexShrink: 0 },
  statRow: { display: "flex", gap: 16, padding: "16px 0", borderTop: "1px solid #e2e8f0" },
  stat:    { flex: 1, display: "flex", flexDirection: "column" as const, gap: 2 },
  statVal: { fontSize: 22, fontWeight: 700, color: "#0f172a", lineHeight: 1 },
  statKey: { fontSize: 11, color: "#94a3b8" },
  galleryArea:     { flex: 1, minWidth: 0 },
  galleryTopBar:   { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  galleryControls: { display: "flex", alignItems: "center", gap: 10 },
  sliderLabel:     { fontSize: 11, color: "#64748b", whiteSpace: "nowrap" as const },
  sliderValue:     { fontSize: 11, fontFamily: "monospace", color: "#10b981", minWidth: 36, textAlign: "right" as const },
  empty:           { textAlign: "center" as const, padding: "60px 0" },
  grid:            { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 },
  tile:            { borderRadius: 10, overflow: "hidden", border: "1px solid #e2e8f0", background: "#ffffff" },
  imgWrap:         { width: "100%", aspectRatio: "1/1", background: "#f1f5f9", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", position: "relative" as const },
  img:             { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  tileOpenBtn:     { position: "absolute" as const, top: 6, right: 6, background: "rgba(0,0,0,.45)", border: "none", color: "#ffffff", borderRadius: 6, padding: "3px 7px", fontSize: 13, fontWeight: 700, cursor: "pointer" },
  tileCaption:     { padding: "8px 10px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 },
  tileFilename:    { fontSize: 11, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, flex: 1 },
  tileMeta:        { fontSize: 11, color: "#94a3b8", whiteSpace: "nowrap" as const, flexShrink: 0 },
  overlay:      { position: "fixed" as const, inset: 0, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 24 },
  modal:        { background: "#ffffff", borderRadius: 16, overflow: "hidden", maxWidth: 920, width: "100%", position: "relative" as const, boxShadow: "0 24px 60px rgba(0,0,0,.12)", border: "1px solid #e2e8f0", display: "flex" as const },
  modalClose:   { position: "absolute" as const, top: 14, right: 14, background: "rgba(0,0,0,.08)", border: "none", color: "#374151", width: 28, height: 28, borderRadius: "50%", cursor: "pointer", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10 },
  modalImgWrap: { background: "#f1f5f9", width: "42%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" },
  modalImg:     { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" as const, display: "block" },
  modalInfo:    { flex: 1, padding: "20px 24px", borderLeft: "1px solid #e2e8f0", display: "flex", flexDirection: "column" as const, minWidth: 0, overflowY: "auto" as const },
  modalFilename:{ fontSize: 16, fontWeight: 600, color: "#0f172a", marginBottom: 14 },
  modalMeta:    { display: "flex", flexDirection: "column" as const, gap: 6, marginBottom: 14 },
  metaRow:      { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, padding: "6px 0", borderBottom: "1px solid #e2e8f0" },
  metaLabel:    { fontSize: 11, fontWeight: 600, color: "#94a3b8", textTransform: "uppercase" as const, letterSpacing: ".4px", whiteSpace: "nowrap" as const },
  metaValue:    { fontSize: 13, color: "#374151", textAlign: "right" as const, wordBreak: "break-all" as const },
  modalActions: { display: "flex", flexDirection: "column" as const, gap: 8, marginTop: "auto" as const, paddingTop: 14 },
  openBtn:      { width: "100%", padding: "10px 0", background: "#059669", color: "#ffffff", border: "1px solid #10b98133", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600 },
  deleteBtn:    { width: "100%", padding: "10px 0", background: "#fee2e2", color: "#dc2626", border: "1px solid #fca5a544", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600 },
  shardSection: { background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: "12px 14px", marginBottom: 0 },
  shardTitle:   { fontSize: 12, fontWeight: 700, color: "#64748b", marginBottom: 10 },
  shardGrid:    { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 10 },
  shardCard:    { borderRadius: 8, border: "1px solid", padding: "8px 6px", display: "flex", flexDirection: "column" as const, alignItems: "center", gap: 4, transition: "all .4s" },
  shardLabel:   { fontSize: 13, fontWeight: 800, fontFamily: "monospace", transition: "color .4s" },
  shardNodeId:  { fontSize: 10, color: "#64748b" },
  shardRole:    { fontSize: 10, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: ".04em", transition: "color .4s" },
  shardStatus:  { fontSize: 14, lineHeight: 1, transition: "color .4s" },
  shardNote:    { fontSize: 11, color: "#64748b", lineHeight: 1.5, margin: 0 },
  ecPanel:         { background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 14, padding: "16px 20px", display: "flex", flexDirection: "column" as const, gap: 12 },
  ecPanelHeader:   { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 },
  ecTitle:         { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" as const },
  ecTitleText:     { fontSize: 13, fontWeight: 700, color: "#0f172a" },
  ecFormula:       { fontSize: 12, fontWeight: 700, fontFamily: "monospace", background: "#f1f5f9", color: "#059669", padding: "2px 9px", borderRadius: 6, border: "1px solid #e2e8f0" },
  ecFormulaNote:   { fontSize: 11, color: "#94a3b8" },
  ecLearnBtn:      { background: "none", border: "1px solid #e2e8f0", borderRadius: 8, padding: "4px 10px", fontSize: 11, fontWeight: 600, color: "#64748b", cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" as const },
  ecNodeRow:       { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 },
  ecNodeCard:      { background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: "10px 8px", display: "flex", flexDirection: "column" as const, alignItems: "center", gap: 5 },
  ecNodeIndicator: { width: 10, height: 10, borderRadius: "50%", transition: "background .4s, box-shadow .4s" },
  ecNodeId:        { fontSize: 11, fontWeight: 600, color: "#0f172a" },
  ecShardBadge:    { fontSize: 10, fontWeight: 700, fontFamily: "monospace", padding: "2px 7px", borderRadius: 4, border: "1px solid", transition: "all .4s" },
  ecNodeStatus:    { fontSize: 10, fontWeight: 600, transition: "color .4s" },
  ecStatusBar:     { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 8, border: "1px solid", transition: "all .4s", flexWrap: "wrap" as const },
  ecStatusDot:     { width: 8, height: 8, borderRadius: "50%", flexShrink: 0, transition: "all .4s" },
  ecStatusMsg:     { fontSize: 12, fontWeight: 600, flex: 1, transition: "color .4s" },
  ecQuorumBadges:  { display: "flex", gap: 6 },
  ecQuorumBadge:   { fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 99 },
  ecHint:          { fontSize: 11, color: "#94a3b8", margin: 0, lineHeight: 1.6 },
  ecHintCode:      { background: "#f1f5f9", padding: "1px 5px", borderRadius: 4, fontFamily: "monospace", fontSize: 11, color: "#059669", border: "1px solid #e2e8f0" },
  learnWrap:     { maxWidth: 760, margin: "0 auto", padding: "40px 24px 60px" },
  learnHeader:   { marginBottom: 32 },
  learnH1:       { fontSize: 32, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.8px", marginBottom: 8 },
  learnSubtitle: { fontSize: 16, color: "#64748b" },
  coreBlock:      { background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 14, padding: "24px 28px", marginBottom: 28 },
  coreBlockLabel: { fontSize: 11, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase" as const, letterSpacing: ".8px", marginBottom: 16 },
  coreGrid:       { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 20 },
  coreIdea:       { display: "flex", flexDirection: "column" as const, gap: 6 },
  coreIdeaTitle:  { fontSize: 13, fontWeight: 700, color: "#0f172a", margin: 0 },
  coreIdeaText:   { fontSize: 12, color: "#64748b", lineHeight: 1.65, margin: 0 },
  conceptCard:   { background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 16, marginBottom: 20, overflow: "hidden", scrollMarginTop: 80 },
  conceptHeader: { display: "flex", alignItems: "center", gap: 14, padding: "18px 24px", borderBottom: "1px solid #e2e8f0", position: "relative" as const, overflow: "hidden" },
  conceptAccent: { position: "absolute" as const, right: 0, top: 0, width: 4, height: "100%", opacity: 0.6 },
  conceptBadge:  { fontSize: 11, fontWeight: 800, padding: "4px 8px", borderRadius: 6, letterSpacing: ".5px", flexShrink: 0 },
  conceptTitle:  { fontSize: 18, fontWeight: 700, color: "#0f172a", letterSpacing: "-0.3px" },
  conceptTagline:{ fontSize: 12, fontWeight: 500, marginTop: 1 },
  conceptBody:   { padding: "20px 24px", display: "flex", flexDirection: "column" as const, gap: 12 },
  exBadgePending: { fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 20, background: "#f1f5f9", color: "#94a3b8", border: "1px solid #e2e8f0", whiteSpace: "nowrap" as const, flexShrink: 0 },
  exBadgeDone:    { fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 20, background: "#d1fae5", color: "#059669", whiteSpace: "nowrap" as const, flexShrink: 0 },
  gtkStrip:  { background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "18px 22px", marginBottom: 24, display: "flex", flexDirection: "column" as const, gap: 10 },
  gtkHeader: { fontSize: 11, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase" as const, letterSpacing: ".8px" },
  gtkItem:   { fontSize: 13, color: "#64748b", lineHeight: 1.6, margin: 0, display: "flex", gap: 8 },
  gtkDot:    { color: "#cbd5e1", flexShrink: 0, marginTop: 1 },
  codeBlock:   { background: "#1e293b", color: "#e2e8f0", padding: "14px 16px", borderRadius: 8, overflowX: "auto" as const, fontSize: 12, lineHeight: 1.7, whiteSpace: "pre" as const, border: "1px solid #334155" },
  infoBox:     { display: "flex", gap: 10, alignItems: "flex-start", background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 8, padding: "12px 14px" },
  infoBoxIcon: { fontSize: 16, flexShrink: 0 },
  learnFooter: { textAlign: "center" as const, padding: "24px 0 0", borderTop: "1px solid #e2e8f0" },
};
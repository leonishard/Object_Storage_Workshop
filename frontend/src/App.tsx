import { useState, useEffect, useRef } from "react";

/* ─── helpers ────────────────────────────────────────────── */
const EXPIRY_SECONDS = 3600;

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
  key: string;
  url: string;
  size: number;
  lastModified: string;
  etag?: string;
  metadata?: Record<string, string>;
}

type ConceptId =
  | "presigned-url"
  | "object-metadata"
  | "buckets"
  | "s3-api"
  | "versioning"
  | "bucket-policy"
  | "direct-upload";

interface InsightEvent {
  conceptId: ConceptId;
  label: string;
  detail: string;
}

const CONCEPTS: Record<ConceptId, { title: string; anchor: string }> = {
  "presigned-url":   { title: "Presigned URLs",    anchor: "concept-presigned" },
  "object-metadata": { title: "Object Metadata",   anchor: "concept-metadata" },
  buckets:           { title: "Buckets",            anchor: "concept-buckets" },
  "s3-api":          { title: "S3 API Compat.",     anchor: "concept-s3" },
  versioning:        { title: "Versioning",         anchor: "concept-versioning" },
  "bucket-policy":   { title: "Bucket Policies",   anchor: "concept-policy" },
  "direct-upload":   { title: "Direct Upload",     anchor: "concept-direct-upload" },
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
  onOpenConcept:     (id: ConceptId) => void;
  onExerciseComplete: () => void;
  exerciseCompleted:  boolean;
}) {
  const [gallery,     setGallery]     = useState<GalleryItem[]>([]);
  const [uploading,   setUploading]   = useState(false);
  const [status,      setStatus]      = useState<{ ok: boolean; text: string } | null>(null);
  const [lastUpload,  setLastUpload]  = useState<GalleryItem | null>(null);
  const [dragOver,    setDragOver]    = useState(false);
  const [selected,    setSelected]    = useState<GalleryItem | null>(null);
  const [insights,    setInsights]    = useState<InsightEvent[]>([]);
  const [deleting,    setDeleting]    = useState(false);
  const [uploadMode,  setUploadMode]  = useState<"server" | "direct">("server");
  const [directInfo,  setDirectInfo]  = useState<{ url: string; key: string; file: File } | null>(null);
  const [directReady, setDirectReady] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function pushInsight(ev: InsightEvent) {
    setInsights((prev) => prev.find((e) => e.conceptId === ev.conceptId) ? prev : [...prev, ev]);
  }

  async function fetchGallery() {
    const res  = await fetch("/gallery");
    const data: GalleryItem[] = await res.json();
    data.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
    setGallery(data);
    if (data.length > 0) {
      pushInsight({ conceptId: "buckets",  label: "Bucket loaded",  detail: `${data.length} object(s) retrieved.` });
      pushInsight({ conceptId: "s3-api",   label: "S3 API used",    detail: "ListObjectsV2 called via the S3-compatible MinIO endpoint." });
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
    if (!res.ok) {
      setStatus({ ok: false, text: data.error ?? "Failed to get upload URL" });
      return;
    }
    setDirectInfo({ url: data.url, key: data.key, file });
    setDirectReady(true);
    pushInsight({ conceptId: "direct-upload", label: "Presigned PUT issued", detail: "Backend signed a PUT URL. File goes straight from browser to MinIO." });
  }

  async function executeDirectUpload() {
    if (!directInfo) return;
    setUploading(true);
    // Route the PUT through Vite's dev proxy (/minio-direct → localhost:9000).
    // This avoids the browser CORS block on cross-origin requests to port 9000.
    // changeOrigin in vite.config.ts keeps the Host header as localhost:9000
    // so the presigned-URL signature check still passes on MinIO's side.
    const putUrl = directInfo.url.replace("http://localhost:9000", "/minio-direct");
    const res = await fetch(putUrl, {
      method:  "PUT",
      body:    directInfo.file,
      headers: { "Content-Type": directInfo.file.type },
    });
    setUploading(false);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      setStatus({ ok: false, text: `Direct upload failed (${res.status})${body ? ": " + body : ""}` });
      return;
    }
    setStatus({ ok: true, text: `"${directInfo.file.name}" uploaded directly to MinIO` });
    onExerciseComplete();
    // Small delay — MinIO needs a moment to commit the object before ListObjectsV2 sees it
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
      {/* Insight ribbon */}
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

          {/* Upload mode toggle */}
          <div style={s.modeToggle}>
            <button
              style={{ ...s.modeBtn, ...(uploadMode === "server" ? s.modeBtnActive : {}) }}
              onClick={() => { setUploadMode("server"); setDirectInfo(null); setDirectReady(false); }}
            >Via Server</button>
            <button
              style={{ ...s.modeBtn, ...(uploadMode === "direct" ? s.modeBtnActive : {}) }}
              onClick={() => { setUploadMode("direct"); setDirectInfo(null); setDirectReady(false); }}
            >Direct to MinIO</button>
          </div>

          {/* Drop zone */}
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
                <p style={{ ...s.dropText, color: "#10b981", fontWeight: 600, marginBottom: 6 }}>✓ Upload URL ready</p>
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

          {/* Direct upload: presigned URL + flow diagram */}
          {uploadMode === "direct" && directInfo && (
            <div style={s.directPanel}>
              <p style={s.directLabel}>Step 1 — Signed PUT URL from server:</p>
              <textarea readOnly value={directInfo.url} style={s.directUrlBox} rows={3}
                onClick={(e) => (e.target as HTMLTextAreaElement).select()} />
              <div style={s.flowDiagram}>
                <FlowRow label="Browser" note="your tab"   color="#3b82f6" />
                <FlowArrow label="GET /presign-upload" sub="got the URL ✓" />
                <FlowRow label="Backend" note="Express"    color="#8b5cf6" />
                <FlowArrow label="— no file bytes —" sub="backend is done" dim />
                <FlowArrow label="PUT {signed URL}" sub="step 2 →" color="#10b981" />
                <FlowRow label="MinIO"   note=":9000"      color="#10b981" />
              </div>
            </div>
          )}

          {/* Exercise panel — shown in Direct mode until student completes it */}
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
            <div style={{ ...s.exercisePanel, background: "#f0fdf4", borderColor: "#86efac" }}>
              <p style={{ ...s.exercisePanelTitle, color: "#166534" }}>✓ Exercise complete</p>
              <p style={{ fontSize: 12, color: "#166534", margin: 0 }}>You implemented the presigned PUT route. Direct upload is live.</p>
            </div>
          )}

          {status && (
            <div style={{ ...s.statusBar, background: status.ok ? "#f0fdf4" : "#fff1f2", borderColor: status.ok ? "#86efac" : "#fda4af" }}>
              <span style={{ color: status.ok ? "#166534" : "#9f1239", fontSize: 13 }}>{status.ok ? "✓" : "✗"} {status.text}</span>
            </div>
          )}

          {lastUpload && <PresignedUrlReveal item={lastUpload} onOpenConcept={onOpenConcept} />}

          <div style={s.statRow}>
            <div style={s.stat}><span style={s.statVal}>{gallery.length}</span><span style={s.statKey}>objects</span></div>
            <div style={s.stat}><span style={s.statVal}>{(gallery.reduce((a, b) => a + b.size, 0) / 1024).toFixed(0)}</span><span style={s.statKey}>KB stored</span></div>
          </div>
        </aside>

        {/* ── Gallery grid ── */}
        <main style={s.galleryArea}>
          <div style={s.galleryTopBar}>
            <h2 style={s.sectionTitle}>Gallery</h2>
            <button onClick={fetchGallery} style={s.refreshBtn}>↻</button>
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
                <MetaRow label="Object key"   value={selected.key} mono />
                <MetaRow label="Size"         value={`${(selected.size / 1024).toFixed(2)} KB`} />
                <MetaRow label="Last modified" value={new Date(selected.lastModified).toLocaleString()} />
                {selected.etag && <MetaRow label="ETag (MD5)"  value={selected.etag} mono />}
                {selected.metadata && Object.entries(selected.metadata).map(([k, v]) => <MetaRow key={k} label={k} value={v} />)}
              </div>
              <button style={s.deleteBtn} onClick={() => deleteObject(selected.key)} disabled={deleting}>
                {deleting ? "Deleting…" : "Delete object"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Flow diagram helpers ── */
function FlowRow({ label, note, color }: { label: string; note: string; color: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div style={{ width: 10, height: 10, borderRadius: "50%", background: color, flexShrink: 0, boxShadow: `0 0 6px ${color}66` }} />
      <span style={{ fontSize: 13, fontWeight: 600, color: "#1e293b" }}>{label}</span>
      <span style={{ fontSize: 11, color: "#94a3b8" }}>{note}</span>
    </div>
  );
}
function FlowArrow({ label, sub, color, dim }: { label: string; sub: string; color?: string; dim?: boolean }) {
  return (
    <div style={{ paddingLeft: 5, display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ width: 1, height: 18, background: "#e2e8f0", marginLeft: 4 }} />
        <span style={{ fontSize: 11, color: dim ? "#cbd5e1" : color || "#64748b", fontFamily: "monospace", fontStyle: dim ? "italic" : "normal" }}>{label}</span>
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
  const [secondsLeft, setSecondsLeft] = useState(EXPIRY_SECONDS);
  const parsed = parsePresignedUrl(item.url);

  useEffect(() => {
    setSecondsLeft(EXPIRY_SECONDS);
    const t = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [item.url]);

  function copy() { navigator.clipboard.writeText(item.url); setCopied(true); setTimeout(() => setCopied(false), 2000); }

  const pct   = secondsLeft / EXPIRY_SECONDS;
  const mins  = Math.floor(secondsLeft / 60);
  const secs  = secondsLeft % 60;
  const color = pct > 0.5 ? "#10b981" : pct > 0.2 ? "#f59e0b" : "#ef4444";

  return (
    <div style={s.psuRoot}>
      <div style={s.psuHeader}>
        <div style={s.psuThumb}><img src={item.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={s.psuFileName}>{item.key.replace(/^\d+-/, "")}</div>
          <div style={s.psuSubline}>{(item.size / 1024).toFixed(1)} KB · uploaded just now</div>
        </div>
        <button style={s.psuExpandBtn} onClick={() => setExpanded((v) => !v)}>{expanded ? "▲" : "▼"}</button>
      </div>
      <div style={s.psuExpiryRow}>
        <div style={s.psuBarWrap}><div style={{ ...s.psuBar, width: `${pct * 100}%`, background: color }} /></div>
        <span style={{ ...s.psuTimer, color }}>{secondsLeft > 0 ? `${mins}m ${secs.toString().padStart(2, "0")}s` : "Expired"}</span>
      </div>
      <p style={s.psuExpiryNote}>
        Signed GET URL — expires in 1 hour. After that, anyone with the link gets a 403.
        <button style={s.psuLearnLink} onClick={() => onOpenConcept("presigned-url")}>Learn why ↗</button>
      </p>
      {expanded && parsed && (
        <div style={s.psuBreakdown}>
          <p style={s.psuBreakdownTitle}>URL breakdown</p>
          <UrlPart color="#3b82f6" label="Host"            value={parsed.host}                    note="MinIO's endpoint. In production: your S3 domain or CDN." />
          <UrlPart color="#8b5cf6" label="Bucket / Key"    value={`/${parsed.bucket}/${parsed.key}`} note="Bucket name + object key." />
          <UrlPart color="#f59e0b" label="X-Amz-Date"      value={parsed.date}                    note="When the signature was generated — baked in so it can't be reused." />
          <UrlPart color="#ef4444" label="X-Amz-Expires"   value={`${parsed.expiry}s`}            note="How long until the URL stops working. Tamper with this and the signature breaks." />
          <UrlPart color="#10b981" label="X-Amz-Signature" value={parsed.sig}                     note="HMAC-SHA256 of the URL + expiry + your secret key. Change anything above and this won't match." />
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

      {/* ── Core ideas ── */}
      <div style={s.coreBlock}>
        <p style={s.coreBlockLabel}>Core ideas</p>
        <div style={s.coreGrid}>
          <CoreIdea
            title="Objects are flat"
            text="An object = bytes + a key + metadata, stored in a flat bucket. Keys look like paths but folders aren't real — the / is just part of the key string."
          />
          <CoreIdea
            title="Storage ≠ database"
            text="Store the blob in object storage, store a pointer (the key) plus searchable fields in your database. Object storage isn't a database."
          />
          <CoreIdea
            title="Code against the API, not the vendor"
            text="The same SDK code runs on MinIO, AWS S3, Cloudflare R2, or Backblaze B2 — you change one config line, not your code."
          />
        </div>
      </div>

      {/* ── 4 concept cards ── */}
      <ConceptCard id="concept-buckets" badge="01" title="Buckets & Objects" tagline="Flat key-value store" color="#3b82f6">
        <p>
          A <strong>bucket</strong> is a flat namespace. Every file you upload becomes an <strong>object</strong> with three things:
          bytes, a key, and metadata. There is no directory tree — <code>2024/photo.png</code> and <code>2024/other.png</code> are
          just two strings that share a prefix.
        </p>
        <p>
          The "folder" the MinIO console draws for <code>2024/</code> is invented by the UI. ListObjectsV2 lets you
          filter by prefix to simulate folders, but the storage layer is flat.
        </p>
        <CodeBlock>{`// What the backend runs every time you open the Gallery tab:
const list = await s3.send(new ListObjectsV2Command({ Bucket: "workshop-images" }));
// Each entry: { Key, Size, ETag, LastModified }
// Key examples: "1719000000-cat.jpg"  "1719000001-dog.png"`}</CodeBlock>
        <InfoBox>In the gallery, click any image. The <strong>Object key</strong> row in the metadata panel shows the full key MinIO uses — no folder, just a timestamp-prefixed string.</InfoBox>
      </ConceptCard>

      <ConceptCard id="concept-presigned" badge="02" title="Presigned GET URLs" tagline="Temporary, unforgeable read links" color="#10b981">
        <p>
          After listing objects, the backend calls <code>getSignedUrl</code> for each key. The result is a normal
          HTTPS URL with an HMAC-SHA256 signature baked into the query string — MinIO verifies it without
          storing any session.
        </p>
        <p>
          The browser loads images <strong>directly from MinIO</strong> — the Express server is not in the
          transfer loop. Change one character in the URL and the signature check fails with a 403.
        </p>
        <CodeBlock>{`const url = await getSignedUrl(
  s3,
  new GetObjectCommand({ Bucket: BUCKET, Key: "1719000000-cat.jpg" }),
  { expiresIn: 3600 }   // valid for 1 hour
);
// → http://localhost:9000/workshop-images/1719000000-cat.jpg
//     ?X-Amz-Expires=3600&X-Amz-Signature=a3f8b2…`}</CodeBlock>
        <InfoBox>
          Open DevTools → Network, then hit Refresh in the gallery. Image requests go to <code>:9000</code> (MinIO),
          not <code>:3001</code> (Express). The countdown timer in the sidebar shows the URL expiring in real time.
        </InfoBox>
      </ConceptCard>

      <ConceptCard
        id="concept-direct-upload"
        badge="03"
        title="Direct Upload — Presigned PUT"
        tagline="Backend as keyholder, not middleman"
        color="#f97316"
        exerciseBadge={{ completed: exerciseCompleted }}
      >
        <p>
          A presigned URL works for <em>writes</em> too. The backend signs a PUT URL and returns it; the
          browser uploads straight to MinIO. The server never touches the file bytes — it only holds the
          secret key and uses it to sign requests.
        </p>
        <CodeBlock>{`// Via server (default tab):
Browser ──POST /upload──▶ Backend ──PutObject──▶ MinIO
         (file bytes flow through Express)

// Direct upload ("Direct to MinIO" tab):
Browser ──GET /presign-upload──▶ Backend   ← only a tiny JSON response
Browser ──PUT {signed URL}────────────────▶ MinIO   ← file bytes go here directly`}</CodeBlock>
        <p>
          The backend is the <strong>keyholder</strong>: it holds the MinIO credentials and uses them only
          to sign URLs (upload, list, read). The browser never sees a secret key — only a time-limited
          signed URL that MinIO will accept.
        </p>
        <InfoBox>
          Switch to "Direct to MinIO" in the Gallery tab. When you pick a file, the app asks the backend
          for a signed PUT URL and shows it in the flow diagram before you upload. The PUT goes straight
          to <code>:9000</code>.
        </InfoBox>
      </ConceptCard>

      <ConceptCard id="concept-s3" badge="04" title="S3 API Compatibility" tagline="One SDK, any vendor" color="#8b5cf6">
        <p>
          Amazon S3 defined a standard REST API for object storage. MinIO implements that exact API.
          The AWS SDK in this project talks to MinIO identically to how it talks to real AWS S3.
        </p>
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
        <p>
          The same swap works for Cloudflare R2, Backblaze B2, or any S3-compatible store. You are
          coding against an open standard, not a proprietary SDK.
        </p>
      </ConceptCard>

      {/* ── Good to know strip ── */}
      <div style={s.gtkStrip}>
        <span style={s.gtkHeader}>Good to know</span>
        <GtkItem text="ETag = MD5 hash of the bytes — MinIO returns it on every object and you can use it as a cache fingerprint or deduplication key." />
        <GtkItem text="Objects are immutable: you replace rather than edit. Lifecycle rules can auto-expire objects after N days to reclaim space." />
        <GtkItem text="Versioning keeps every overwrite as a new version with its own version ID — deletes create a marker rather than destroying data." />
        <GtkItem text="Bucket policies are JSON access rules. Buckets are private by default; presigned URLs grant temporary exceptions without making the bucket public." />
      </div>

      <div style={s.learnFooter}>
        <p style={{ color: "#64748b", fontSize: 13, margin: 0 }}>
          All four concepts are active right now — the Gallery tab is talking to a live MinIO container via Docker.
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
      <span style={{ fontSize: 13, color: "#1e40af", lineHeight: 1.6 }}>{children}</span>
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
    0%, 100% { box-shadow: 0 0 0 0 rgba(99,102,241,0); }
    40%       { box-shadow: 0 0 0 6px rgba(99,102,241,0.3); }
  }

  .gallery-tile { transition: transform .15s, box-shadow .15s; cursor: pointer; }
  .gallery-tile:hover { transform: translateY(-3px); box-shadow: 0 8px 24px rgba(0,0,0,.12); }

  .concept-card { animation: fadeIn .3s ease both; }
  .concept-highlight { animation: highlightPulse .6s ease 2; }

  ul, ol { padding-left: 20px; }
  li { margin-bottom: 4px; font-size: 13px; color: #334155; line-height: 1.6; }
  p  { font-size: 14px; color: #334155; line-height: 1.7; margin-bottom: 12px; }
  p:last-child { margin-bottom: 0; }
  strong { color: #1e293b; }
  code { background: #f1f5f9; padding: 1px 5px; border-radius: 4px; font-family: monospace; font-size: 12px; color: #0f172a; }
`;

const s: Record<string, React.CSSProperties> = {
  root: { minHeight: "100vh", fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif", background: "#f8fafc", color: "#0f172a" },

  /* nav */
  nav:          { background: "#0f172a", borderBottom: "1px solid #1e293b", position: "sticky", top: 0, zIndex: 50 },
  navInner:     { maxWidth: 1080, margin: "0 auto", padding: "0 24px", height: 56, display: "flex", alignItems: "center", justifyContent: "space-between" },
  navBrand:     { display: "flex", alignItems: "center", gap: 10 },
  navDot:       { width: 10, height: 10, borderRadius: "50%", background: "#22d3ee", boxShadow: "0 0 10px #22d3ee88" },
  navTitle:     { fontSize: 16, fontWeight: 700, color: "#f1f5f9", letterSpacing: "-0.3px" },
  navSub:       { fontSize: 11, color: "#475569", borderLeft: "1px solid #334155", paddingLeft: 10, marginLeft: 2 },
  navTabs:      { display: "flex", gap: 4 },
  navTab:       { background: "transparent", border: "1px solid transparent", borderRadius: 8, padding: "6px 16px", fontSize: 13, color: "#64748b", cursor: "pointer", fontWeight: 500 },
  navTabActive: { background: "#1e293b", borderColor: "#334155", color: "#f1f5f9" },

  /* page layout */
  pageWrap: { maxWidth: 1080, margin: "0 auto", padding: "0 24px 40px" },
  twoCol:   { display: "flex", gap: 24, paddingTop: 28, alignItems: "flex-start" },

  /* insight ribbon */
  ribbon:      { display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 10, marginTop: 20, flexWrap: "wrap" as const },
  ribbonLabel: { fontSize: 11, fontWeight: 600, color: "#0369a1", textTransform: "uppercase" as const, letterSpacing: ".5px", whiteSpace: "nowrap" as const },
  ribbonChip:  { display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px", background: "#fff", border: "1px solid #bae6fd", borderRadius: 20, fontSize: 12, fontWeight: 500, color: "#0369a1", cursor: "pointer" },
  chipDot:     { width: 6, height: 6, borderRadius: "50%", background: "#22d3ee" },
  chipArrow:   { fontSize: 10, opacity: 0.6 },

  /* sidebar */
  sidebar:      { width: 320, flexShrink: 0, display: "flex", flexDirection: "column" as const, gap: 20 },
  sectionTitle: { fontSize: 13, fontWeight: 700, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: ".06em", marginBottom: 12 },

  /* mode toggle */
  modeToggle:    { display: "flex", background: "#f1f5f9", borderRadius: 10, padding: 4, gap: 4 },
  modeBtn:       { flex: 1, padding: "8px 10px", fontSize: 12, fontWeight: 600, border: "none", borderRadius: 7, cursor: "pointer", background: "transparent", color: "#64748b" },
  modeBtnActive: { background: "#fff", color: "#0f172a", boxShadow: "0 1px 3px rgba(0,0,0,.1)" },

  /* drop zone */
  dropZone:       { border: "2px dashed #cbd5e1", borderRadius: 14, padding: "40px 28px", textAlign: "center" as const, cursor: "pointer", background: "#fff", transition: "all .15s", minHeight: 160 },
  dropZoneActive: { borderColor: "#3b82f6", background: "#eff6ff" },
  dropIconWrap:   { display: "flex", justifyContent: "center", marginBottom: 14 },
  dropText:       { fontSize: 14, color: "#475569", marginBottom: 6 },
  dropSub:        { fontSize: 12, color: "#94a3b8" },
  spinnerWrap:    { display: "flex", justifyContent: "center", padding: "16px 0" },
  spinner:        { width: 30, height: 30, border: "3px solid #e2e8f0", borderTopColor: "#3b82f6", borderRadius: "50%", animation: "spin .7s linear infinite" },
  uploadDirectBtn:{ padding: "10px 20px", background: "#10b981", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600 },

  /* direct upload panel */
  directPanel:  { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "18px 20px", display: "flex", flexDirection: "column" as const, gap: 14 },
  directLabel:  { fontSize: 11, fontWeight: 700, color: "#f97316", textTransform: "uppercase" as const, letterSpacing: ".5px" },
  directUrlBox: { fontFamily: "monospace", fontSize: 10, padding: "10px 12px", borderRadius: 8, border: "1px solid #fed7aa", background: "#fff7ed", resize: "none" as const, color: "#9a3412", lineHeight: 1.6, width: "100%" },
  flowDiagram:  { background: "#f8fafc", borderRadius: 8, padding: "14px 16px", display: "flex", flexDirection: "column" as const, gap: 6 },

  /* exercise panel */
  exercisePanel:      { background: "#fefce8", border: "1px solid #fde047", borderRadius: 12, padding: "18px 20px" },
  exercisePanelTitle: { fontSize: 14, fontWeight: 700, color: "#713f12", marginBottom: 14 },
  exerciseList:       { paddingLeft: 20, display: "flex", flexDirection: "column" as const, gap: 8 },
  exerciseHint:       { fontSize: 12, color: "#92400e", marginTop: 12, marginBottom: 6 },
  exerciseDone:       { fontSize: 12, color: "#166534", fontWeight: 600, margin: 0 },
  inlineCode:         { background: "#fef3c7", padding: "2px 5px", borderRadius: 3, fontFamily: "monospace", fontSize: 11, color: "#78350f" },

  statusBar: { padding: "10px 14px", borderRadius: 8, border: "1px solid" },

  /* presigned URL reveal */
  psuRoot:           { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, overflow: "hidden" },
  psuHeader:         { display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderBottom: "1px solid #f1f5f9" },
  psuThumb:          { width: 36, height: 36, borderRadius: 6, overflow: "hidden", flexShrink: 0, background: "#f1f5f9" },
  psuFileName:       { fontSize: 12, fontWeight: 600, color: "#1e293b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const },
  psuSubline:        { fontSize: 11, color: "#94a3b8", marginTop: 1 },
  psuExpandBtn:      { background: "none", border: "none", cursor: "pointer", fontSize: 10, color: "#94a3b8", padding: "4px 6px", flexShrink: 0 },
  psuExpiryRow:      { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px 0" },
  psuBarWrap:        { flex: 1, height: 4, background: "#f1f5f9", borderRadius: 4, overflow: "hidden" },
  psuBar:            { height: "100%", borderRadius: 4, transition: "width 1s linear, background .5s" },
  psuTimer:          { fontSize: 11, fontWeight: 700, fontFamily: "monospace", whiteSpace: "nowrap" as const, minWidth: 52 },
  psuExpiryNote:     { fontSize: 11, color: "#64748b", padding: "5px 12px 10px", lineHeight: 1.6, margin: 0 },
  psuLearnLink:      { background: "none", border: "none", cursor: "pointer", color: "#3b82f6", fontSize: 11, padding: "0 0 0 4px", fontWeight: 600 },
  psuBreakdown:      { borderTop: "1px solid #f1f5f9", padding: "12px 12px 14px", display: "flex", flexDirection: "column" as const, gap: 8 },
  psuBreakdownTitle: { fontSize: 11, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase" as const, letterSpacing: ".5px", margin: 0 },
  urlPart:           { display: "flex", gap: 8, alignItems: "flex-start" },
  urlPartLabel:      { fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, border: "1px solid", whiteSpace: "nowrap" as const, flexShrink: 0, marginTop: 1 },
  urlPartValue:      { fontSize: 11, fontFamily: "monospace", color: "#1e293b", display: "block", wordBreak: "break-all" as const, background: "#f8fafc", padding: "2px 5px", borderRadius: 3 },
  urlPartNote:       { fontSize: 11, color: "#64748b", lineHeight: 1.5, margin: "3px 0 0" },
  psuRawWrap:        { display: "flex", gap: 6, alignItems: "flex-start", marginTop: 4 },
  psuRawBox:         { flex: 1, fontFamily: "monospace", fontSize: 10, padding: "7px 8px", borderRadius: 6, border: "1px solid #e2e8f0", background: "#f8fafc", resize: "none" as const, color: "#475569", lineHeight: 1.5 },
  psuCopyBtn:        { background: "#0f172a", color: "#f1f5f9", border: "none", borderRadius: 6, padding: "6px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" as const, flexShrink: 0 },

  statRow: { display: "flex", gap: 16, padding: "16px 0", borderTop: "1px solid #f1f5f9" },
  stat:    { flex: 1, display: "flex", flexDirection: "column" as const, gap: 2 },
  statVal: { fontSize: 22, fontWeight: 700, color: "#0f172a", lineHeight: 1 },
  statKey: { fontSize: 11, color: "#94a3b8" },

  /* gallery */
  galleryArea:   { flex: 1, minWidth: 0 },
  galleryTopBar: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 0 },
  refreshBtn:    { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "6px 12px", fontSize: 16, cursor: "pointer", color: "#475569", lineHeight: 1 },
  empty:         { textAlign: "center" as const, padding: "60px 0" },
  grid:          { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12, marginTop: 4 },
  tile:          { borderRadius: 10, overflow: "hidden", border: "1px solid #e2e8f0", background: "#fff" },
  imgWrap:       { width: "100%", aspectRatio: "1/1", background: "#0f172a", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  img:           { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  tileCaption:   { padding: "8px 10px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 },
  tileFilename:  { fontSize: 11, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, flex: 1 },
  tileMeta:      { fontSize: 11, color: "#9ca3af", whiteSpace: "nowrap" as const, flexShrink: 0 },

  /* modal */
  overlay:       { position: "fixed" as const, inset: 0, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 24 },
  modal:         { background: "#fff", borderRadius: 16, overflow: "hidden", maxWidth: 640, width: "100%", maxHeight: "85vh", overflowY: "auto" as const, position: "relative" as const, boxShadow: "0 24px 60px rgba(0,0,0,.3)" },
  modalClose:    { position: "absolute" as const, top: 14, right: 14, background: "rgba(0,0,0,.4)", border: "none", color: "#fff", width: 28, height: 28, borderRadius: "50%", cursor: "pointer", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10 },
  modalImgWrap:  { background: "#0f172a", maxHeight: 340, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  modalImg:      { maxWidth: "100%", maxHeight: 340, objectFit: "contain", display: "block" },
  modalInfo:     { padding: "20px 24px" },
  modalFilename: { fontSize: 16, fontWeight: 600, color: "#0f172a", marginBottom: 16 },
  modalMeta:     { display: "flex", flexDirection: "column" as const, gap: 8, marginBottom: 20 },
  metaRow:       { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, padding: "8px 0", borderBottom: "1px solid #f1f5f9" },
  metaLabel:     { fontSize: 11, fontWeight: 600, color: "#94a3b8", textTransform: "uppercase" as const, letterSpacing: ".4px", whiteSpace: "nowrap" as const },
  metaValue:     { fontSize: 13, color: "#334155", textAlign: "right" as const, wordBreak: "break-all" as const },
  deleteBtn:     { width: "100%", padding: "10px 0", background: "#fef2f2", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600 },

  /* learn page */
  learnWrap:     { maxWidth: 760, margin: "0 auto", padding: "40px 24px 60px" },
  learnHeader:   { marginBottom: 32 },
  learnH1:       { fontSize: 32, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.8px", marginBottom: 8 },
  learnSubtitle: { fontSize: 16, color: "#64748b" },

  /* core ideas block */
  coreBlock:      { background: "#0f172a", borderRadius: 14, padding: "24px 28px", marginBottom: 28 },
  coreBlockLabel: { fontSize: 11, fontWeight: 700, color: "#475569", textTransform: "uppercase" as const, letterSpacing: ".8px", marginBottom: 16 },
  coreGrid:       { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 20 },
  coreIdea:       { display: "flex", flexDirection: "column" as const, gap: 6 },
  coreIdeaTitle:  { fontSize: 13, fontWeight: 700, color: "#f1f5f9", margin: 0 },
  coreIdeaText:   { fontSize: 12, color: "#94a3b8", lineHeight: 1.65, margin: 0 },

  /* concept cards */
  conceptCard:    { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 16, marginBottom: 20, overflow: "hidden", scrollMarginTop: 80 },
  conceptHeader:  { display: "flex", alignItems: "center", gap: 14, padding: "18px 24px", borderBottom: "1px solid #f1f5f9", position: "relative" as const, overflow: "hidden" },
  conceptAccent:  { position: "absolute" as const, right: 0, top: 0, width: 4, height: "100%", opacity: 0.6 },
  conceptBadge:   { fontSize: 11, fontWeight: 800, padding: "4px 8px", borderRadius: 6, letterSpacing: ".5px", flexShrink: 0 },
  conceptTitle:   { fontSize: 18, fontWeight: 700, color: "#0f172a", letterSpacing: "-0.3px" },
  conceptTagline: { fontSize: 12, fontWeight: 500, marginTop: 1 },
  conceptBody:    { padding: "20px 24px", display: "flex", flexDirection: "column" as const, gap: 12 },

  /* exercise badge (on concept card) */
  exBadgePending: { fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 20, background: "#f1f5f9", color: "#94a3b8", whiteSpace: "nowrap" as const, flexShrink: 0 },
  exBadgeDone:    { fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 20, background: "#dcfce7", color: "#166534", whiteSpace: "nowrap" as const, flexShrink: 0 },

  /* good to know */
  gtkStrip:  { background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 12, padding: "18px 22px", marginBottom: 24, display: "flex", flexDirection: "column" as const, gap: 10 },
  gtkHeader: { fontSize: 11, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase" as const, letterSpacing: ".8px" },
  gtkItem:   { fontSize: 13, color: "#64748b", lineHeight: 1.6, margin: 0, display: "flex", gap: 8 },
  gtkDot:    { color: "#cbd5e1", flexShrink: 0, marginTop: 1 },

  codeBlock:    { background: "#0f172a", color: "#e2e8f0", padding: "14px 16px", borderRadius: 8, overflowX: "auto" as const, fontSize: 12, lineHeight: 1.7, whiteSpace: "pre" as const },
  infoBox:      { display: "flex", gap: 10, alignItems: "flex-start", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8, padding: "12px 14px" },
  infoBoxIcon:  { fontSize: 16, flexShrink: 0 },
  learnFooter:  { textAlign: "center" as const, padding: "24px 0 0", borderTop: "1px solid #e2e8f0" },
};

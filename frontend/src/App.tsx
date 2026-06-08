import { useState, useEffect, useRef } from "react";

/* ─── helpers ───────────────────────────────────────────── */
const EXPIRY_SECONDS = 3600; // must match backend

function parsePresignedUrl(url: string) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const bucket = parts[0] ?? "—";
    const key    = parts.slice(1).join("/") ?? "—";
    const expiry = u.searchParams.get("X-Amz-Expires") ?? "—";
    const sig    = u.searchParams.get("X-Amz-Signature") ?? "—";
    const date   = u.searchParams.get("X-Amz-Date") ?? "—";
    const host   = u.host;
    return { bucket, key, expiry, sig: sig.slice(0, 16) + "…", date, host, raw: url };
  } catch {
    return null;
  }
}

/* ─── types ─────────────────────────────────────────────── */
interface GalleryItem {
  key: string;
  url: string;
  size: number;
  lastModified: string;
  metadata?: Record<string, string>;
}

type ConceptId =
    | "presigned-url"
    | "object-metadata"
    | "buckets"
    | "s3-api"
    | "versioning"
    | "bucket-policy";

interface InsightEvent {
  conceptId: ConceptId;
  label: string;
  detail: string;
}

/* ─── concept registry ───────────────────────────────────── */
const CONCEPTS: Record<ConceptId, { title: string; anchor: string }> = {
  "presigned-url":   { title: "Presigned URLs",    anchor: "concept-presigned" },
  "object-metadata": { title: "Object Metadata",   anchor: "concept-metadata" },
  buckets:           { title: "Buckets",            anchor: "concept-buckets" },
  "s3-api":          { title: "S3 API Compatibility", anchor: "concept-s3" },
  versioning:        { title: "Versioning",         anchor: "concept-versioning" },
  "bucket-policy":   { title: "Bucket Policies",   anchor: "concept-policy" },
};

/* ═══════════════════════════════════════════════════════════
   ROOT
═══════════════════════════════════════════════════════════ */
export default function App() {
  const [tab, setTab] = useState<"app" | "learn">("app");
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);

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

        {/* ── Nav ── */}
        <nav style={s.nav}>
          <div style={s.navInner}>
            <div style={s.navBrand}>
              <span style={s.navDot} />
              <span style={s.navTitle}>Stash</span>
              <span style={s.navSub}>powered by MinIO</span>
            </div>
            <div style={s.navTabs}>
              <button
                  style={{ ...s.navTab, ...(tab === "app" ? s.navTabActive : {}) }}
                  onClick={() => setTab("app")}
              >
                Gallery
              </button>
              <button
                  style={{ ...s.navTab, ...(tab === "learn" ? s.navTabActive : {}) }}
                  onClick={() => setTab("learn")}
              >
                Under the Hood
              </button>
            </div>
          </div>
        </nav>

        {/* ── Pages ── */}
        {tab === "app"
            ? <GalleryPage onOpenConcept={openConcept} />
            : <LearnPage />
        }
      </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   GALLERY PAGE  (the "real app")
═══════════════════════════════════════════════════════════ */
function GalleryPage({ onOpenConcept }: { onOpenConcept: (id: ConceptId) => void }) {
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [lastUpload, setLastUpload] = useState<GalleryItem | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [selected, setSelected] = useState<GalleryItem | null>(null);
  const [insights, setInsights] = useState<InsightEvent[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  function pushInsight(ev: InsightEvent) {
    setInsights((prev) => {
      if (prev.find((e) => e.conceptId === ev.conceptId)) return prev;
      return [...prev, ev];
    });
  }

  async function fetchGallery() {
    const res = await fetch("/gallery");
    const data: GalleryItem[] = await res.json();
    data.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
    setGallery(data);
    if (data.length > 0) {
      pushInsight({
        conceptId: "buckets",
        label: "Bucket loaded",
        detail: `${data.length} object${data.length !== 1 ? "s" : ""} retrieved from the bucket.`,
      });
      pushInsight({
        conceptId: "s3-api",
        label: "S3 API used",
        detail: "ListObjectsV2 called via the S3-compatible MinIO endpoint.",
      });
    }
    return data;
  }

  useEffect(() => { fetchGallery(); }, []);

  async function uploadFile(file: File) {
    setUploading(true);
    setStatus(null);
    setLastUpload(null);

    const form = new FormData();
    form.append("image", file);

    const res = await fetch("/upload", { method: "POST", body: form });
    const data = await res.json();
    setUploading(false);

    if (!res.ok) {
      setStatus({ ok: false, text: `Upload failed: ${data.error}` });
      return;
    }

    setStatus({ ok: true, text: `"${file.name}" uploaded` });
    const updated = await fetchGallery();
    const newest = updated.find((i) => i.key === data.key);
    if (newest) {
      setLastUpload(newest);
      pushInsight({
        conceptId: "presigned-url",
        label: "Presigned URL issued",
        detail: "Your image is now accessible via a time-limited signed URL — no credentials needed.",
      });
      pushInsight({
        conceptId: "object-metadata",
        label: "Metadata attached",
        detail: "Size, content-type, and custom headers were stored alongside the object.",
      });
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  }

  return (
      <div style={s.pageWrap}>
        {/* Insight ribbon */}
        {insights.length > 0 && (
            <div style={s.ribbon}>
              <span style={s.ribbonLabel}>Concepts triggered →</span>
              {insights.map((ins) => (
                  <button
                      key={ins.conceptId}
                      style={s.ribbonChip}
                      title={ins.detail}
                      onClick={() => onOpenConcept(ins.conceptId)}
                  >
                    <span style={s.chipDot} />
                    {CONCEPTS[ins.conceptId].title}
                    <span style={s.chipArrow}>↗</span>
                  </button>
              ))}
            </div>
        )}

        <div style={s.twoCol}>
          {/* ── Upload panel ── */}
          <aside style={s.sidebar}>
            <h2 style={s.sectionTitle}>Upload</h2>
            <div
                style={{ ...s.dropZone, ...(dragOver ? s.dropZoneActive : {}) }}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileRef.current?.click()}
            >
              <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  onChange={(e) => { if (e.target.files?.[0]) uploadFile(e.target.files[0]); }}
              />
              {uploading ? (
                  <div style={s.spinnerWrap}><div style={s.spinner} /></div>
              ) : (
                  <>
                    <div style={s.dropIconWrap}>
                      <svg width="28" height="28" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} style={{ color: "#94a3b8" }}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                      </svg>
                    </div>
                    <p style={s.dropText}>Drop an image or <u>click to browse</u></p>
                    <p style={s.dropSub}>PNG · JPG · GIF · WEBP</p>
                  </>
              )}
            </div>

            {status && (
                <div style={{ ...s.statusBar, background: status.ok ? "#f0fdf4" : "#fff1f2", borderColor: status.ok ? "#86efac" : "#fda4af" }}>
              <span style={{ color: status.ok ? "#166534" : "#9f1239", fontSize: 13 }}>
                {status.ok ? "✓" : "✗"} {status.text}
              </span>
                </div>
            )}

            {/* Presigned URL reveal */}
            {lastUpload && <PresignedUrlReveal item={lastUpload} onOpenConcept={onOpenConcept} />}

            <div style={s.statRow}>
              <div style={s.stat}>
                <span style={s.statVal}>{gallery.length}</span>
                <span style={s.statKey}>objects</span>
              </div>
              <div style={s.stat}>
                <span style={s.statVal}>{(gallery.reduce((a, b) => a + b.size, 0) / 1024).toFixed(0)}</span>
                <span style={s.statKey}>KB stored</span>
              </div>
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
                      <div
                          key={item.key}
                          style={s.tile}
                          onClick={() => setSelected(item)}
                          className="gallery-tile"
                      >
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
                    <MetaRow label="Object key" value={selected.key} mono />
                    <MetaRow label="Size" value={`${(selected.size / 1024).toFixed(2)} KB`} />
                    <MetaRow label="Last modified" value={new Date(selected.lastModified).toLocaleString()} />
                    {selected.metadata && Object.entries(selected.metadata).map(([k, v]) => (
                        <MetaRow key={k} label={k} value={v} />
                    ))}
                  </div>
                </div>
              </div>
            </div>
        )}
      </div>
  );
}

/* ── Presigned URL Reveal ── */
function PresignedUrlReveal({
                              item,
                              onOpenConcept,
                            }: {
  item: GalleryItem;
  onOpenConcept: (id: ConceptId) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied]     = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(EXPIRY_SECONDS);
  const parsed = parsePresignedUrl(item.url);

  useEffect(() => {
    setSecondsLeft(EXPIRY_SECONDS);
    const t = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [item.url]);

  function copy() {
    navigator.clipboard.writeText(item.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const pct   = secondsLeft / EXPIRY_SECONDS;
  const mins  = Math.floor(secondsLeft / 60);
  const secs  = secondsLeft % 60;
  const color = pct > 0.5 ? "#10b981" : pct > 0.2 ? "#f59e0b" : "#ef4444";

  return (
      <div style={s.psuRoot}>
        {/* header row */}
        <div style={s.psuHeader}>
          <div style={s.psuThumb}>
            <img src={item.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={s.psuFileName}>{item.key.replace(/^\d+-/, "")}</div>
            <div style={s.psuSubline}>{(item.size / 1024).toFixed(1)} KB · uploaded just now</div>
          </div>
          <button style={s.psuExpandBtn} onClick={() => setExpanded((v) => !v)}>
            {expanded ? "▲" : "▼"}
          </button>
        </div>

        {/* expiry bar — always visible */}
        <div style={s.psuExpiryRow}>
          <div style={s.psuBarWrap}>
            <div style={{ ...s.psuBar, width: `${pct * 100}%`, background: color }} />
          </div>
          <span style={{ ...s.psuTimer, color }}>
          {secondsLeft > 0 ? `${mins}m ${secs.toString().padStart(2, "0")}s` : "Expired"}
        </span>
        </div>
        <p style={s.psuExpiryNote}>
          This URL is cryptographically signed and expires in 1 hour.
          After that, anyone with the link gets a&nbsp;403.
          <button style={s.psuLearnLink} onClick={() => onOpenConcept("presigned-url")}>
            Learn why ↗
          </button>
        </p>

        {/* expanded breakdown */}
        {expanded && parsed && (
            <div style={s.psuBreakdown}>
              <p style={s.psuBreakdownTitle}>URL breakdown</p>

              <UrlPart color="#3b82f6" label="Host" value={parsed.host}
                       note="This is MinIO's endpoint — in production it'd be your S3 bucket domain or a CDN." />
              <UrlPart color="#8b5cf6" label="Bucket / Key" value={`/${parsed.bucket}/${parsed.key}`}
                       note="The bucket name followed by the object key. Think: shelf / box label." />
              <UrlPart color="#f59e0b" label="X-Amz-Date" value={parsed.date}
                       note="When the signature was generated. Baked into the signature so it can't be reused." />
              <UrlPart color="#ef4444" label="X-Amz-Expires" value={`${parsed.expiry}s (1 hour)`}
                       note="How long until the URL stops working. Change this digit — the signature breaks." />
              <UrlPart color="#10b981" label="X-Amz-Signature" value={parsed.sig}
                       note="An HMAC-SHA256 hash of the URL, expiry, and your secret key. Tamper with anything above and this won't match." />

              <div style={s.psuRawWrap}>
            <textarea
                readOnly
                value={item.url}
                style={s.psuRawBox}
                rows={3}
                onClick={(e) => (e.target as HTMLTextAreaElement).select()}
            />
                <button style={s.psuCopyBtn} onClick={copy}>
                  {copied ? "✓ Copied" : "Copy"}
                </button>
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
   LEARN PAGE  ("Under the Hood")
═══════════════════════════════════════════════════════════ */
function LearnPage() {
  return (
      <div style={s.learnWrap}>
        <div style={s.learnHeader}>
          <h1 style={s.learnH1}>Under the Hood</h1>
          <p style={s.learnSubtitle}>Everything the gallery page is quietly doing — explained.</p>
        </div>

        <ConceptCard
            id="concept-buckets"
            badge="01"
            title="Buckets"
            tagline="The warehouse shelves"
            color="#3b82f6"
        >
          <p>A <strong>bucket</strong> is like a top-level folder in object storage. Every object (file) lives inside one. Think of it like this:</p>
          <ul>
            <li>A <strong>bucket</strong> = the warehouse shelf</li>
            <li>An <strong>object</strong> = a labelled box on that shelf</li>
            <li>The <strong>key</strong> = the label on the box (e.g. <code>photos/2024/cat.jpg</code>)</li>
          </ul>
          <p>There are no real folders — just key prefixes. <code>photos/2024/cat.jpg</code> and <code>photos/2025/dog.jpg</code> look like folders but are actually just two objects with similar key names.</p>
          <p>When you opened the gallery, the backend called <strong>ListObjectsV2</strong> on the MinIO bucket to get all the image keys and generate a URL for each one.</p>
          <CodeBlock>{`// Express backend
const objects = await s3.listObjectsV2({
  Bucket: "workshop-images",
}).promise();`}</CodeBlock>
        </ConceptCard>

        <ConceptCard
            id="concept-presigned"
            badge="02"
            title="Presigned URLs"
            tagline="The temporary permission slip"
            color="#10b981"
        >
          <p>This is the single most important concept in the workshop. Here's the problem it solves:</p>
          <p>If a user wants to view a photo stored in MinIO, you have two options:</p>
          <ol>
            <li><strong>Proxy it:</strong> the user asks your server → your server fetches the file from MinIO → your server sends it back. Every byte flows through your app. Slow and expensive at scale.</li>
            <li><strong>Presigned URL:</strong> your server generates a signed, time-limited URL → hands it to the user → the user's browser fetches the file directly from MinIO. Your server is never in the middle of the file transfer.</li>
          </ol>
          <p>A presigned URL looks like this:</p>
          <CodeBlock>{`http://localhost:9000/workshop-images/1719123456-cat.jpg
  ?X-Amz-Algorithm=AWS4-HMAC-SHA256
  &X-Amz-Credential=minioadmin%2F20240623%2F...
  &X-Amz-Date=20240623T120000Z
  &X-Amz-Expires=3600          ← expires in 1 hour
  &X-Amz-SignedHeaders=host
  &X-Amz-Signature=a3f8b2e9...  ← tamper-proof signature`}</CodeBlock>
          <p>The signature is cryptographically tied to the exact URL, expiry, and your secret key. Change any character and it breaks. That's how MinIO verifies it without storing a session.</p>
          <p><strong>Real-world example:</strong> when you hit play on Netflix, Netflix's server doesn't stream the video — it gives your player a presigned CDN URL, and the video chunks flow directly from object storage to your device.</p>
          <InfoBox>
            Open DevTools (F12) → Network tab, then refresh the gallery. You'll see the image requests go to port <code>9000</code> (MinIO), not port <code>3001</code> (Express). That's the presigned URL at work.
          </InfoBox>
        </ConceptCard>

        <ConceptCard
            id="concept-metadata"
            badge="03"
            title="Object Metadata"
            tagline="The label on the box"
            color="#f59e0b"
        >
          <p>Every object in MinIO can carry <strong>metadata</strong> — key-value pairs stored alongside the file bytes, retrieved with a simple HEAD request. There are two kinds:</p>
          <ul>
            <li><strong>System metadata:</strong> set automatically — <code>Content-Type</code>, <code>Content-Length</code>, <code>Last-Modified</code>, <code>ETag</code></li>
            <li><strong>User metadata:</strong> anything you attach, prefixed with <code>x-amz-meta-</code></li>
          </ul>
          <CodeBlock>{`// On upload (Express backend)
await s3.putObject({
  Bucket: "workshop-images",
  Key: key,
  Body: file.buffer,
  ContentType: file.mimetype,
  Metadata: {
    "original-name": file.originalname,
    "upload-timestamp": Date.now().toString(),
  },
}).promise();`}</CodeBlock>
          <p>Click any image in the gallery to see its metadata panel. Notice you don't need a separate database table to store "who uploaded this" or "what type is this" — the object carries that information itself.</p>
          <p>This doesn't replace a database for relational queries, but it's extremely useful for contextual data that belongs to a single file.</p>
        </ConceptCard>

        <ConceptCard
            id="concept-s3"
            badge="04"
            title="S3 API Compatibility"
            tagline="One interface, many warehouses"
            color="#8b5cf6"
        >
          <p>Amazon S3 defined a standard API for object storage. MinIO implements that <em>exact same API</em>. This means:</p>
          <ul>
            <li>Code written for AWS S3 works with MinIO with <strong>one config change</strong> — the endpoint URL</li>
            <li>The AWS SDK you see in the backend treats MinIO identically to real S3</li>
            <li>Any tool that supports S3 (Terraform, rclone, DuckDB, etc.) works with MinIO out of the box</li>
          </ul>
          <CodeBlock>{`// This is the only difference between dev (MinIO) and prod (AWS S3):
const s3 = new AWS.S3({
  endpoint: "http://localhost:9000",  // swap for real S3 endpoint
  accessKeyId: process.env.MINIO_ACCESS_KEY,
  secretAccessKey: process.env.MINIO_SECRET_KEY,
  s3ForcePathStyle: true,
});`}</CodeBlock>
          <p><strong>Why this matters:</strong> you can build and test locally against MinIO for free, then point the same code at AWS S3 in production. No refactoring. This is exactly why MinIO is the standard for local development of S3-dependent systems.</p>
          <InfoBox>
            GitLab's self-hosted version uses MinIO as its default object storage backend for CI artifacts, Docker images, and Git LFS files. When a developer downloads a build artifact, they're getting a presigned URL that points at MinIO — they never know.
          </InfoBox>
        </ConceptCard>

        <ConceptCard
            id="concept-versioning"
            badge="05"
            title="Versioning"
            tagline="Time travel for objects"
            color="#ef4444"
        >
          <p>By default, uploading a file with the same key <strong>silently overwrites</strong> the previous one. Versioning changes this:</p>
          <ul>
            <li>Every upload creates a new version with a unique <strong>version ID</strong></li>
            <li>Deleting an object creates a <strong>delete marker</strong> — the data is still there</li>
            <li>You can restore any previous version at any time</li>
          </ul>
          <CodeBlock>{`// Enable versioning on a bucket
await s3.putBucketVersioning({
  Bucket: "workshop-images",
  VersioningConfiguration: { Status: "Enabled" },
}).promise();

// List all versions of a specific key
const versions = await s3.listObjectVersions({
  Bucket: "workshop-images",
  Prefix: "my-photo.jpg",
}).promise();`}</CodeBlock>
          <p>Try it: upload a photo, then upload a different photo with the same filename. Without versioning, the first is gone. With versioning, both exist — you can retrieve the original by its version ID.</p>
          <p><strong>Real-world use:</strong> S3 versioning is how cloud storage services like Dropbox and Google Drive implement "version history" — every save is a new object version.</p>
        </ConceptCard>

        <ConceptCard
            id="concept-policy"
            badge="06"
            title="Bucket Policies"
            tagline="The access control rulebook"
            color="#06b6d4"
        >
          <p>A bucket policy is a JSON document that defines who can do what with your bucket. It uses the same format as AWS IAM policies.</p>
          <CodeBlock>{`// Make a bucket fully public (read-only for everyone)
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::workshop-images/*"
  }]
}

// Once public — no signature needed, plain URL works:
// http://localhost:9000/workshop-images/cat.jpg ✓`}</CodeBlock>
          <p>With no policy (private bucket), every request must be authenticated — either with access keys, or via a presigned URL generated by someone who has keys.</p>
          <p>Our gallery uses a <strong>private bucket</strong>. Images are never publicly accessible. The presigned URLs you see are the only way to access them — and they expire after 1 hour.</p>
          <InfoBox>
            Revoke any presigned URL by deleting the object, changing the bucket policy, or rotating the secret key. All previously issued URLs immediately stop working.
          </InfoBox>
        </ConceptCard>

        <div style={s.learnFooter}>
          <p style={{ color: "#64748b", fontSize: 13, margin: 0 }}>
            All concepts above are active right now — the Gallery tab is running against a live MinIO container via Docker.
          </p>
        </div>
      </div>
  );
}

/* ── Sub-components ── */
function ConceptCard({
                       id, badge, title, tagline, color, children,
                     }: {
  id: string; badge: string; title: string; tagline: string; color: string; children: React.ReactNode;
}) {
  return (
      <div id={id} style={s.conceptCard} className="concept-card">
        <div style={s.conceptHeader}>
          <span style={{ ...s.conceptBadge, background: color + "22", color }}>{badge}</span>
          <div>
            <h2 style={s.conceptTitle}>{title}</h2>
            <p style={{ ...s.conceptTagline, color }}>{tagline}</p>
          </div>
          <div style={{ ...s.conceptAccent, background: color }} />
        </div>
        <div style={s.conceptBody}>{children}</div>
      </div>
  );
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  return (
      <pre style={s.codeBlock}><code style={{ fontFamily: "monospace", fontSize: 12 }}>{children}</code></pre>
  );
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
    40% { box-shadow: 0 0 0 6px rgba(99,102,241,0.3); }
  }

  .gallery-tile { transition: transform .15s, box-shadow .15s; cursor: pointer; }
  .gallery-tile:hover { transform: translateY(-3px); box-shadow: 0 8px 24px rgba(0,0,0,.12); }

  .concept-card { animation: fadeIn .3s ease both; }
  .concept-highlight { animation: highlightPulse .6s ease 2; }

  ul, ol { padding-left: 20px; }
  li { margin-bottom: 4px; font-size: 14px; color: #334155; line-height: 1.6; }
  p { font-size: 14px; color: #334155; line-height: 1.7; margin-bottom: 12px; }
  p:last-child { margin-bottom: 0; }
  strong { color: #1e293b; }
  code { background: #f1f5f9; padding: 1px 5px; border-radius: 4px; font-family: monospace; font-size: 12px; color: #0f172a; }
`;

const s: Record<string, React.CSSProperties> = {
  root: {
    minHeight: "100vh",
    fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif",
    background: "#f8fafc",
    color: "#0f172a",
  },

  /* nav */
  nav: {
    background: "#0f172a",
    borderBottom: "1px solid #1e293b",
    position: "sticky",
    top: 0,
    zIndex: 50,
  },
  navInner: {
    maxWidth: 1080,
    margin: "0 auto",
    padding: "0 24px",
    height: 56,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  navBrand: { display: "flex", alignItems: "center", gap: 10 },
  navDot: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    background: "#22d3ee",
    boxShadow: "0 0 10px #22d3ee88",
  },
  navTitle: { fontSize: 16, fontWeight: 700, color: "#f1f5f9", letterSpacing: "-0.3px" },
  navSub: { fontSize: 11, color: "#475569", borderLeft: "1px solid #334155", paddingLeft: 10, marginLeft: 2 },
  navTabs: { display: "flex", gap: 4 },
  navTab: {
    background: "transparent",
    border: "1px solid transparent",
    borderRadius: 8,
    padding: "6px 16px",
    fontSize: 13,
    color: "#64748b",
    cursor: "pointer",
    fontWeight: 500,
    transition: "all .15s",
  },
  navTabActive: {
    background: "#1e293b",
    borderColor: "#334155",
    color: "#f1f5f9",
  },

  /* page layout */
  pageWrap: { maxWidth: 1080, margin: "0 auto", padding: "0 24px 40px" },
  twoCol: { display: "flex", gap: 24, paddingTop: 28, alignItems: "flex-start" },

  /* insight ribbon */
  ribbon: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 16px",
    background: "#f0f9ff",
    border: "1px solid #bae6fd",
    borderRadius: 10,
    marginTop: 20,
    flexWrap: "wrap" as const,
  },
  ribbonLabel: { fontSize: 11, fontWeight: 600, color: "#0369a1", textTransform: "uppercase" as const, letterSpacing: ".5px", whiteSpace: "nowrap" as const },
  ribbonChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "4px 10px",
    background: "#fff",
    border: "1px solid #bae6fd",
    borderRadius: 20,
    fontSize: 12,
    fontWeight: 500,
    color: "#0369a1",
    cursor: "pointer",
    transition: "all .12s",
  },
  chipDot: { width: 6, height: 6, borderRadius: "50%", background: "#22d3ee" },
  chipArrow: { fontSize: 10, opacity: 0.6 },

  /* sidebar */
  sidebar: {
    width: 280,
    flexShrink: 0,
    display: "flex",
    flexDirection: "column" as const,
    gap: 16,
  },
  sectionTitle: { fontSize: 13, fontWeight: 700, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: ".06em", marginBottom: 12 },

  dropZone: {
    border: "2px dashed #cbd5e1",
    borderRadius: 12,
    padding: "32px 20px",
    textAlign: "center" as const,
    cursor: "pointer",
    background: "#fff",
    transition: "all .15s",
  },
  dropZoneActive: { borderColor: "#3b82f6", background: "#eff6ff" },
  dropIconWrap: { display: "flex", justifyContent: "center", marginBottom: 10 },
  dropText: { fontSize: 13, color: "#475569", marginBottom: 4 },
  dropSub: { fontSize: 11, color: "#94a3b8" },
  spinnerWrap: { display: "flex", justifyContent: "center", padding: "12px 0" },
  spinner: {
    width: 28,
    height: 28,
    border: "3px solid #e2e8f0",
    borderTopColor: "#3b82f6",
    borderRadius: "50%",
    animation: "spin .7s linear infinite",
  },

  statusBar: {
    padding: "10px 14px",
    borderRadius: 8,
    border: "1px solid",
  },

  /* presigned url reveal */
  psuRoot: {
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 12,
    overflow: "hidden",
  },
  psuHeader: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 12px",
    borderBottom: "1px solid #f1f5f9",
  },
  psuThumb: {
    width: 36,
    height: 36,
    borderRadius: 6,
    overflow: "hidden",
    flexShrink: 0,
    background: "#f1f5f9",
  },
  psuFileName: { fontSize: 12, fontWeight: 600, color: "#1e293b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const },
  psuSubline:  { fontSize: 11, color: "#94a3b8", marginTop: 1 },
  psuExpandBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    fontSize: 10,
    color: "#94a3b8",
    padding: "4px 6px",
    flexShrink: 0,
  },
  psuExpiryRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px 0",
  },
  psuBarWrap: {
    flex: 1,
    height: 4,
    background: "#f1f5f9",
    borderRadius: 4,
    overflow: "hidden",
  },
  psuBar: {
    height: "100%",
    borderRadius: 4,
    transition: "width 1s linear, background .5s",
  },
  psuTimer: { fontSize: 11, fontWeight: 700, fontFamily: "monospace", whiteSpace: "nowrap" as const, minWidth: 52 },
  psuExpiryNote: {
    fontSize: 11,
    color: "#64748b",
    padding: "5px 12px 10px",
    lineHeight: 1.6,
    margin: 0,
  },
  psuLearnLink: {
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "#3b82f6",
    fontSize: 11,
    padding: "0 0 0 4px",
    fontWeight: 600,
  },
  psuBreakdown: {
    borderTop: "1px solid #f1f5f9",
    padding: "12px 12px 14px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
  },
  psuBreakdownTitle: { fontSize: 11, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase" as const, letterSpacing: ".5px", margin: 0 },
  urlPart: { display: "flex", gap: 8, alignItems: "flex-start" },
  urlPartLabel: {
    fontSize: 10,
    fontWeight: 700,
    padding: "2px 6px",
    borderRadius: 4,
    border: "1px solid",
    whiteSpace: "nowrap" as const,
    flexShrink: 0,
    marginTop: 1,
    letterSpacing: ".3px",
  },
  urlPartValue: {
    fontSize: 11,
    fontFamily: "monospace",
    color: "#1e293b",
    display: "block",
    wordBreak: "break-all" as const,
    background: "#f8fafc",
    padding: "2px 5px",
    borderRadius: 3,
  },
  urlPartNote: { fontSize: 11, color: "#64748b", lineHeight: 1.5, margin: "3px 0 0" },
  psuRawWrap: { display: "flex", gap: 6, alignItems: "flex-start", marginTop: 4 },
  psuRawBox: {
    flex: 1,
    fontFamily: "monospace",
    fontSize: 10,
    padding: "7px 8px",
    borderRadius: 6,
    border: "1px solid #e2e8f0",
    background: "#f8fafc",
    resize: "none" as const,
    color: "#475569",
    lineHeight: 1.5,
  },
  psuCopyBtn: {
    background: "#0f172a",
    color: "#f1f5f9",
    border: "none",
    borderRadius: 6,
    padding: "6px 12px",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
    flexShrink: 0,
  },

  statRow: {
    display: "flex",
    gap: 12,
    padding: "12px 0",
    borderTop: "1px solid #f1f5f9",
  },
  stat: { flex: 1, display: "flex", flexDirection: "column" as const, gap: 2 },
  statVal: { fontSize: 22, fontWeight: 700, color: "#0f172a", lineHeight: 1 },
  statKey: { fontSize: 11, color: "#94a3b8" },

  /* gallery */
  galleryArea: { flex: 1, minWidth: 0 },
  galleryTopBar: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 0 },
  refreshBtn: {
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 8,
    padding: "6px 12px",
    fontSize: 16,
    cursor: "pointer",
    color: "#475569",
    lineHeight: 1,
  },
  empty: { textAlign: "center" as const, padding: "60px 0" },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
    gap: 12,
    marginTop: 4,
  },
  tile: {
    borderRadius: 10,
    overflow: "hidden",
    border: "1px solid #e2e8f0",
    background: "#fff",
  },
  imgWrap: {
    width: "100%",
    aspectRatio: "1/1",
    background: "#0f172a",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  img: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  tileCaption: {
    padding: "8px 10px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 6,
  },
  tileFilename: { fontSize: 11, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, flex: 1 },
  tileMeta: { fontSize: 11, color: "#9ca3af", whiteSpace: "nowrap" as const, flexShrink: 0 },

  /* modal */
  overlay: {
    position: "fixed" as const,
    inset: 0,
    background: "rgba(0,0,0,.6)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 100,
    padding: 24,
  },
  modal: {
    background: "#fff",
    borderRadius: 16,
    overflow: "hidden",
    maxWidth: 640,
    width: "100%",
    maxHeight: "85vh",
    overflowY: "auto" as const,
    position: "relative" as const,
    boxShadow: "0 24px 60px rgba(0,0,0,.3)",
  },
  modalClose: {
    position: "absolute" as const,
    top: 14,
    right: 14,
    background: "rgba(0,0,0,.4)",
    border: "none",
    color: "#fff",
    width: 28,
    height: 28,
    borderRadius: "50%",
    cursor: "pointer",
    fontSize: 13,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
  },
  modalImgWrap: { background: "#0f172a", maxHeight: 340, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  modalImg: { maxWidth: "100%", maxHeight: 340, objectFit: "contain", display: "block" },
  modalInfo: { padding: "20px 24px" },
  modalFilename: { fontSize: 16, fontWeight: 600, color: "#0f172a", marginBottom: 16 },
  modalMeta: { display: "flex", flexDirection: "column" as const, gap: 8 },
  metaRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, padding: "8px 0", borderBottom: "1px solid #f1f5f9" },
  metaLabel: { fontSize: 11, fontWeight: 600, color: "#94a3b8", textTransform: "uppercase" as const, letterSpacing: ".4px", whiteSpace: "nowrap" as const },
  metaValue: { fontSize: 13, color: "#334155", textAlign: "right" as const, wordBreak: "break-all" as const },

  /* learn page */
  learnWrap: { maxWidth: 760, margin: "0 auto", padding: "40px 24px 60px" },
  learnHeader: { marginBottom: 40 },
  learnH1: { fontSize: 32, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.8px", marginBottom: 8 },
  learnSubtitle: { fontSize: 16, color: "#64748b" },

  conceptCard: {
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 16,
    marginBottom: 20,
    overflow: "hidden",
    scrollMarginTop: 80,
  },
  conceptHeader: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    padding: "18px 24px",
    borderBottom: "1px solid #f1f5f9",
    position: "relative" as const,
    overflow: "hidden",
  },
  conceptAccent: {
    position: "absolute" as const,
    right: 0,
    top: 0,
    width: 4,
    height: "100%",
    opacity: 0.6,
  },
  conceptBadge: {
    fontSize: 11,
    fontWeight: 800,
    padding: "4px 8px",
    borderRadius: 6,
    letterSpacing: ".5px",
    flexShrink: 0,
  },
  conceptTitle: { fontSize: 18, fontWeight: 700, color: "#0f172a", letterSpacing: "-0.3px" },
  conceptTagline: { fontSize: 12, fontWeight: 500, marginTop: 1 },
  conceptBody: { padding: "20px 24px", display: "flex", flexDirection: "column" as const, gap: 12 },

  codeBlock: {
    background: "#0f172a",
    color: "#e2e8f0",
    padding: "14px 16px",
    borderRadius: 8,
    overflowX: "auto" as const,
    fontSize: 12,
    lineHeight: 1.7,
    whiteSpace: "pre" as const,
  },

  infoBox: {
    display: "flex",
    gap: 10,
    alignItems: "flex-start",
    background: "#eff6ff",
    border: "1px solid #bfdbfe",
    borderRadius: 8,
    padding: "12px 14px",
  },
  infoBoxIcon: { fontSize: 16, flexShrink: 0 },

  learnFooter: {
    textAlign: "center" as const,
    padding: "32px 0 0",
    borderTop: "1px solid #e2e8f0",
    marginTop: 8,
  },
};
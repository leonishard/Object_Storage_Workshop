import { useState, useEffect, useRef } from "react";

interface GalleryItem {
  key: string;
  url: string;
  size: number;
  lastModified: string;
}

export default function App() {
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function fetchGallery() {
    const res = await fetch("/gallery");
    const data: GalleryItem[] = await res.json();
    data.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
    setGallery(data);
    return data;
  }

  useEffect(() => { fetchGallery(); }, []);

  async function uploadFile(file: File) {
    setUploading(true);
    setStatus(null);
    setLastUrl(null);

    const form = new FormData();
    form.append("image", file);

    const res = await fetch("/upload", { method: "POST", body: form });
    const data = await res.json();
    setUploading(false);

    if (!res.ok) {
      setStatus({ ok: false, text: `Upload failed: ${data.error}` });
      return;
    }

    setStatus({ ok: true, text: `Uploaded "${file.name}" successfully` });
    const updated = await fetchGallery();
    const newest = updated.find((i) => i.key === data.key);
    if (newest) setLastUrl(newest.url);
    if (fileRef.current) fileRef.current.value = "";
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (file) uploadFile(file);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  }

  return (
    <div style={s.page}>
      {/* Header */}
      <header style={s.header}>
        <div style={s.headerInner}>
          <div style={s.logo}>
            <span style={s.logoIcon}>🗄️</span>
            <span style={s.logoText}>MinIO Image Workshop</span>
          </div>
          <span style={s.badge}>{gallery.length} image{gallery.length !== 1 ? "s" : ""} stored</span>
        </div>
      </header>

      <main style={s.main}>
        {/* Upload card */}
        <section style={s.card}>
          <h2 style={s.cardTitle}>Upload an Image</h2>
          <form onSubmit={handleSubmit}>
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
                required
                style={{ display: "none" }}
                onChange={(e) => { if (e.target.files?.[0]) uploadFile(e.target.files[0]); }}
              />
              {uploading ? (
                <p style={s.dropText}>Uploading…</p>
              ) : (
                <>
                  <p style={s.dropIcon}>📁</p>
                  <p style={s.dropText}>Drag & drop an image here, or <u>click to browse</u></p>
                  <p style={s.dropSub}>PNG, JPG, GIF, WEBP supported</p>
                </>
              )}
            </div>
          </form>

          {status && (
            <div style={{ ...s.statusBar, background: status.ok ? "#ecfdf5" : "#fef2f2", borderColor: status.ok ? "#6ee7b7" : "#fca5a5" }}>
              <span style={{ color: status.ok ? "#065f46" : "#991b1b" }}>
                {status.ok ? "✓" : "✗"} {status.text}
              </span>
            </div>
          )}
        </section>

        {/* Teaching moment */}
        {lastUrl && (
          <section style={{ ...s.card, background: "#fffbeb", borderColor: "#fcd34d" }}>
            <h2 style={s.cardTitle}>
              <span style={{ marginRight: 6 }}>💡</span>Teaching Moment: Presigned URL
            </h2>
            <p style={s.teachText}>
              Your browser loaded that image <strong>directly from MinIO</strong> — the backend never streamed the file back to you.
              It just handed back this signed, temporary URL. Open DevTools → Network and hit Refresh: watch the image
              requests go to <code style={s.code}>:9000</code>, not <code style={s.code}>:3001</code>.
            </p>
            <div style={s.urlWrap}>
              <label style={s.urlLabel}>Presigned URL (expires in 1 hour)</label>
              <textarea
                readOnly
                value={lastUrl}
                style={s.urlBox}
                rows={3}
                onClick={(e) => (e.target as HTMLTextAreaElement).select()}
              />
            </div>
          </section>
        )}

        {/* Gallery */}
        <section style={s.card}>
          <div style={s.galleryHeader}>
            <h2 style={{ ...s.cardTitle, margin: 0 }}>Gallery</h2>
            <button onClick={fetchGallery} style={s.refreshBtn}>↻ Refresh</button>
          </div>

          {gallery.length === 0 ? (
            <div style={s.empty}>
              <p style={{ fontSize: 40, margin: "0 0 8px" }}>🖼️</p>
              <p style={{ color: "#6b7280", margin: 0 }}>No images yet — upload one above.</p>
            </div>
          ) : (
            <div style={s.grid}>
              {gallery.map((item) => (
                <div key={item.key} style={s.tile}>
                  <div style={s.imgWrap}>
                    <img src={item.url} alt={item.key} style={s.img} loading="lazy" />
                  </div>
                  <div style={s.caption}>
                    <span style={s.filename} title={item.key.replace(/^\d+-/, "")}>
                      {item.key.replace(/^\d+-/, "")}
                    </span>
                    <span style={s.meta}>{(item.size / 1024).toFixed(1)} KB</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "#f3f4f6",
    fontFamily: "'Segoe UI', system-ui, sans-serif",
    color: "#111827",
  },
  header: {
    background: "#1e293b",
    boxShadow: "0 1px 4px rgba(0,0,0,.3)",
    position: "sticky",
    top: 0,
    zIndex: 10,
  },
  headerInner: {
    maxWidth: 960,
    margin: "0 auto",
    padding: "14px 20px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  logo: { display: "flex", alignItems: "center", gap: 10 },
  logoIcon: { fontSize: 22 },
  logoText: { fontSize: 18, fontWeight: 700, color: "#f1f5f9", letterSpacing: "-0.3px" },
  badge: {
    fontSize: 12,
    background: "#334155",
    color: "#94a3b8",
    padding: "4px 10px",
    borderRadius: 20,
  },
  main: { maxWidth: 960, margin: "0 auto", padding: "28px 20px" },
  card: {
    background: "#ffffff",
    borderRadius: 12,
    border: "1px solid #e5e7eb",
    padding: 24,
    marginBottom: 20,
    boxShadow: "0 1px 3px rgba(0,0,0,.06)",
  },
  cardTitle: { fontSize: 16, fontWeight: 700, margin: "0 0 16px", color: "#111827" },
  dropZone: {
    border: "2px dashed #d1d5db",
    borderRadius: 10,
    padding: "36px 24px",
    textAlign: "center",
    cursor: "pointer",
    transition: "border-color .15s, background .15s",
    background: "#f9fafb",
  },
  dropZoneActive: {
    borderColor: "#3b82f6",
    background: "#eff6ff",
  },
  dropIcon: { fontSize: 36, margin: "0 0 8px" },
  dropText: { margin: "0 0 4px", fontSize: 14, color: "#374151" },
  dropSub: { margin: 0, fontSize: 12, color: "#9ca3af" },
  statusBar: {
    marginTop: 14,
    padding: "10px 14px",
    borderRadius: 8,
    border: "1px solid",
    fontSize: 13,
  },
  teachText: { fontSize: 13, color: "#444", lineHeight: 1.6, margin: "0 0 14px" },
  code: {
    background: "#f3f4f6",
    padding: "1px 5px",
    borderRadius: 4,
    fontFamily: "monospace",
    fontSize: 12,
  },
  urlWrap: { display: "flex", flexDirection: "column", gap: 6 },
  urlLabel: { fontSize: 11, fontWeight: 600, color: "#92400e", textTransform: "uppercase", letterSpacing: ".5px" },
  urlBox: {
    width: "100%",
    fontFamily: "monospace",
    fontSize: 11,
    padding: "8px 10px",
    borderRadius: 6,
    border: "1px solid #fcd34d",
    background: "#fffdf0",
    resize: "none",
    boxSizing: "border-box",
    color: "#1c1917",
    lineHeight: 1.5,
  },
  galleryHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  refreshBtn: {
    padding: "5px 14px",
    background: "#fff",
    border: "1px solid #d1d5db",
    borderRadius: 7,
    cursor: "pointer",
    fontSize: 13,
    color: "#374151",
    fontWeight: 500,
  },
  empty: {
    textAlign: "center",
    padding: "40px 0",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: 14,
  },
  tile: {
    borderRadius: 10,
    overflow: "hidden",
    border: "1px solid #e5e7eb",
    background: "#f9fafb",
    transition: "box-shadow .15s",
  },
  imgWrap: {
    width: "100%",
    aspectRatio: "1 / 1",
    background: "#1e293b",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  img: {
    maxWidth: "100%",
    maxHeight: "100%",
    objectFit: "contain",
    display: "block",
  },
  caption: {
    padding: "8px 10px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
    background: "#fff",
  },
  filename: {
    fontSize: 11,
    color: "#374151",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flex: 1,
  },
  meta: {
    fontSize: 11,
    color: "#9ca3af",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
};

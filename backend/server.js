import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const s3 = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT,
  region: "us-east-1",
  credentials: {
    accessKeyId:     process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
  },
  forcePathStyle: true,
});

const BUCKET = process.env.MINIO_BUCKET;

async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    console.log(`Bucket "${BUCKET}" already exists`);
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    console.log(`Bucket "${BUCKET}" created`);
  }
}

// ═══════════════════════════════════════════════════════════════
//  THE TWO UPLOAD PATHS — this is the core lesson
//
//  PATH A  "Via Server"  →  POST /upload
//  ──────────────────────────────────────
//  Browser ──POST (file bytes)──▶ Express ──PutObject (file bytes)──▶ MinIO
//  Every byte goes through this server twice.
//
//  PATH B  "Direct to MinIO"  →  GET /presign-upload  +  browser PUT
//  ──────────────────────────────────────────────────────────────────
//  Step 1:  Browser ──GET /presign-upload──▶ Express  (returns a signed URL, no bytes)
//  Step 2:  Browser ──PUT {signed URL} (file bytes)──────────────────▶ MinIO
//  The file bytes never touch this server.
//
// ═══════════════════════════════════════════════════════════════

// PATH A ─ server receives the file and forwards it to MinIO
app.post("/upload", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file provided" });

  const expiresIn = Math.max(5, Math.min(86400, parseInt(req.query.expiresIn) || 30));
  const key = `${Date.now()}-${req.file.originalname}`;

  await s3.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    Body:        req.file.buffer,
    ContentType: req.file.mimetype,
    Metadata:    { "expires-in": String(expiresIn) },
  }));

  console.log(`[PATH A] Uploaded via server: ${key} (expiresIn: ${expiresIn}s)`);
  res.json({ key });
});

// PATH B step 1 ─ server signs a PUT URL; browser will use it to upload directly
app.get("/presign-upload", async (req, res) => {
  const { filename, contentType } = req.query;
  if (!filename) return res.status(400).json({ error: "filename required" });

  const key = `${Date.now()}-${filename}`;

  // ── STUDENT EXERCISE ──────────────────────────────────────────────────
  // Your job: sign a PUT URL so the browser can PUT the file directly to
  // MinIO. This server never sees the file bytes — it only signs the URL.
  //
  //   Step 1 — build:   new PutObjectCommand({ Bucket, Key, ContentType })
  //   Step 2 — sign:    getSignedUrl(s3, command, { expiresIn: 300 })
  //   Step 3 — respond: res.json({ url, key })
  //
  // Hint: GET /gallery below does the exact same thing with GetObjectCommand.
  // PutObjectCommand and getSignedUrl are already imported at the top.
  // ─────────────────────────────────────────────────────────────────────

  const url = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket:      BUCKET,
        Key:         key,
        ContentType: String(contentType || "application/octet-stream"),
      }),
      { expiresIn: 300 }
  );
  console.log(`[PATH B] Presigned PUT issued for: ${key}`);
  res.json({ url, key });
});

// GET /gallery — list objects and return presigned GET URLs
app.get("/gallery", async (req, res) => {
  const defaultExpiry = Math.max(5, Math.min(86400, parseInt(req.query.expiresIn) || 30));
  const list    = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }));
  const objects = list.Contents ?? [];

  const items = await Promise.all(
      objects.map(async (obj) => {
        // Use the expiry stored at upload time so each image keeps its original duration.
        // Fall back to the slider value for objects uploaded before this was added.
        let expiresIn = defaultExpiry;
        try {
          const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
          const stored = parseInt(head.Metadata?.["expires-in"]);
          if (!isNaN(stored)) expiresIn = stored;
        } catch {}

        const url = await getSignedUrl(
            s3,
            new GetObjectCommand({ Bucket: BUCKET, Key: obj.Key }),
            { expiresIn }
        );
        return {
          key:          obj.Key,
          url,
          size:         obj.Size,
          lastModified: obj.LastModified,
          etag:         obj.ETag?.replace(/"/g, ""),
        };
      })
  );

  items.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
  res.json(items);
});

// DELETE /objects/:key — remove an object from the bucket
app.delete("/objects/:key", async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  console.log(`Deleted: ${key}`);
  res.json({ deleted: key });
});

// ═══════════════════════════════════════════════════════════════
//  GET /nodes  —  erasure coding demo: per-node health status
//
//  Each MinIO node exposes a liveness endpoint at /minio/health/live
//  that returns HTTP 200 if the node process is running, or fails to
//  connect if the container is stopped.
//
//  The 4 nodes are reachable from this host process on ports 9100–9103
//  (mapped in docker-compose.yml; these ports bypass nginx so we can
//  check each node individually).
//
//  Returns:
//    nodes[]    — id (1–4) + status ("up" | "down") for each node
//    ec         — erasure coding config (4 total, 2 data, 2 parity)
//    canRead    — true if ≥ 2 nodes are up  (read  quorum = N/2)
//    canWrite   — true if ≥ 3 nodes are up  (write quorum = N/2 + 1)
//    upCount    — how many nodes are currently online
//
//  Requires Node.js 18+ for native fetch.
// ═══════════════════════════════════════════════════════════════

const NODES = [
  { id: 1, port: 9100 },
  { id: 2, port: 9101 },
  { id: 3, port: 9102 },
  { id: 4, port: 9103 },
];

app.get("/nodes", async (_req, res) => {
  const results = await Promise.all(
      NODES.map(async ({ id, port }) => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 900);
          const r = await fetch(`http://localhost:${port}/minio/health/live`, {
            signal: controller.signal,
          });
          clearTimeout(timer);
          return { id, status: r.ok ? "up" : "down" };
        } catch {
          // Connection refused (container stopped) or aborted (timeout)
          return { id, status: "down" };
        }
      })
  );

  const upCount = results.filter((n) => n.status === "up").length;

  res.json({
    nodes:    results,
    ec:       { total: 4, data: 2, parity: 2 },
    canRead:  upCount >= 2,   // read  quorum: any 2 of 4 shards reconstruct the object
    canWrite: upCount >= 3,   // write quorum: need 3 of 4 to commit safely
    upCount,
  });
});

const PORT = process.env.PORT ?? 3001;
ensureBucket()
    .then(() => app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`)))
    .catch((err) => {
      console.error("Failed to connect to MinIO:", err.message);
      process.exit(1);
    });
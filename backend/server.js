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

  const key = `${Date.now()}-${req.file.originalname}`;

  await s3.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    Body:        req.file.buffer,   // ← file bytes arrive here from the browser...
    ContentType: req.file.mimetype,
  }));                              // ...and get forwarded to MinIO here

  console.log(`[PATH A] Uploaded via server: ${key}`);
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

  // ── TODO — uncomment this block (and comment out the solution) to reset:
  // return res.status(501).json({
  //   error: "Not implemented yet — open backend/server.js and complete the TODO.",
  // });

  // ── SOLUTION — comment out the TODO block above, keep these lines: ────
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
  // ─────────────────────────────────────────────────────────────────────
});
// PATH B step 2 happens entirely in the browser — see App.tsx executeDirectUpload()
// The browser calls: fetch(url, { method: "PUT", body: file })
// This server is not involved in that request at all.

// GET /gallery — list objects and return presigned GET URLs
app.get("/gallery", async (req, res) => {
  const list    = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }));
  const objects = list.Contents ?? [];

  const items = await Promise.all(
    objects.map(async (obj) => {
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: BUCKET, Key: obj.Key }),
        { expiresIn: 3600 }
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

const PORT = process.env.PORT ?? 3001;
ensureBucket()
  .then(() => app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`)))
  .catch((err) => {
    console.error("Failed to connect to MinIO:", err.message);
    process.exit(1);
  });

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
  region: "us-east-1",           // MinIO ignores this but the SDK requires it
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
  },
  forcePathStyle: true,           // required for MinIO — disables virtual-hosted style
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

  // CORS for direct browser upload is configured via MINIO_API_CORS_ALLOW_ORIGIN in docker-compose.yml
}

// POST /upload — server-side upload (backend streams the bytes to MinIO)
app.post("/upload", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file provided" });

  const key = `${Date.now()}-${req.file.originalname}`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: req.file.buffer,
    ContentType: req.file.mimetype,
  }));

  console.log(`Uploaded (via server): ${key}`);
  res.json({ key });
});

// GET /presign-upload — generate a presigned PUT URL for direct browser-to-MinIO upload
// The backend never touches the file bytes — it only signs a URL and returns it.
app.get("/presign-upload", async (req, res) => {
  const { filename, contentType } = req.query;
  if (!filename) return res.status(400).json({ error: "filename required" });

  const key = `${Date.now()}-${filename}`;

  // ── STUDENT EXERCISE ─────────────────────────────────────────────────────
  // Sign a PUT URL so the browser can upload directly to MinIO.
  // Write the ~3 lines below, then delete the res.status(501) line.
  //
  //   Step 1 — build the command:   new PutObjectCommand({ Bucket, Key, ContentType })
  //   Step 2 — sign it:             getSignedUrl(s3, command, { expiresIn: 300 })
  //   Step 3 — respond:             res.json({ url, key })
  //
  // Pattern to copy: GET /gallery above does the same thing with GetObjectCommand.
  // Both PutObjectCommand and getSignedUrl are already imported at the top of this file.
  // ─────────────────────────────────────────────────────────────────────────
  return res.status(501).json({
    error: "Not implemented yet — open backend/server.js and complete the TODO in the /presign-upload route.",
  });
});

// GET /gallery — list objects and return presigned GET URLs (ETag included)
app.get("/gallery", async (req, res) => {
  const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }));
  const objects = list.Contents ?? [];

  const items = await Promise.all(
    objects.map(async (obj) => {
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: BUCKET, Key: obj.Key }),
        { expiresIn: 3600 }
      );
      return {
        key: obj.Key,
        url,
        size: obj.Size,
        lastModified: obj.LastModified,
        etag: obj.ETag?.replace(/"/g, ""), // S3 wraps ETags in quotes — strip them
      };
    })
  );

  items.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
  res.json(items);
});

// DELETE /objects/:key — delete an object from the bucket
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

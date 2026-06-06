import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  CreateBucketCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetObjectCommand } from "@aws-sdk/client-s3";

const app = express();
app.use(cors());
app.use(express.json());

// Multer stores the upload in memory so we can stream it straight to MinIO
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

// Create the bucket if it doesn't exist yet
async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    console.log(`Bucket "${BUCKET}" already exists`);
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    console.log(`Bucket "${BUCKET}" created`);
  }
}

// POST /upload  — accept a file, PUT it to MinIO
app.post("/upload", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file provided" });

  const key = `${Date.now()}-${req.file.originalname}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    })
  );

  console.log(`Uploaded: ${key}`);
  res.json({ key });
});

// GET /gallery  — list all objects and return presigned URLs
// This is the "wow" moment: the browser fetches images directly from MinIO
app.get("/gallery", async (req, res) => {
  const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }));
  const objects = list.Contents ?? [];

  const items = await Promise.all(
    objects.map(async (obj) => {
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: BUCKET, Key: obj.Key }),
        { expiresIn: 3600 } // URL valid for 1 hour
      );
      return { key: obj.Key, url, size: obj.Size, lastModified: obj.LastModified };
    })
  );

  // Newest first
  items.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
  res.json(items);
});

const PORT = process.env.PORT ?? 3001;
ensureBucket()
  .then(() => app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`)))
  .catch((err) => {
    console.error("Failed to connect to MinIO:", err.message);
    process.exit(1);
  });

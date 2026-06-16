import "dotenv/config";
import express from "express";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import cors from "cors";
import multer from "multer";
import {
    S3Client,
    GetObjectCommand,
    ListObjectsV2Command,
    CreateBucketCommand,
    HeadBucketCommand,
    HeadObjectCommand,
    DeleteObjectCommand,
    PutObjectCommand,
    PutBucketTaggingCommand,
    PutBucketLifecycleConfigurationCommand,
    S3ServiceException,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// MinIO enforces a hard 5 MB minimum on each individual multipart part.
// Files below this threshold always use a single PutObjectCommand regardless
// of what the slider is set to.
const MINIO_MIN_PART_SIZE = 5 * 1024 * 1024; // 5 MB

// ═══════════════════════════════════════════════════════════════
//  STORAGE PROVIDER
// ═══════════════════════════════════════════════════════════════

const isR2 = process.env.STORAGE_PROVIDER === "r2";

const s3 = new S3Client(
    isR2
        ? {
            endpoint:    `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
            region:      "auto",
            credentials: {
                accessKeyId:     process.env.R2_ACCESS_KEY,
                secretAccessKey: process.env.R2_SECRET_KEY,
            },
            requestHandler: new NodeHttpHandler({ connectionTimeout: 5000, requestTimeout: 30000 }),
        }
        : {
            endpoint:       process.env.MINIO_ENDPOINT,
            region:         "us-east-1",
            credentials: {
                accessKeyId:     process.env.MINIO_ACCESS_KEY,
                secretAccessKey: process.env.MINIO_SECRET_KEY,
            },
            forcePathStyle: true,
            requestHandler: new NodeHttpHandler({ connectionTimeout: 5000, requestTimeout: 30000 }),
        }
);

const BUCKET = isR2 ? process.env.R2_BUCKET : process.env.MINIO_BUCKET;

// ═══════════════════════════════════════════════════════════════
//  BUCKET SETUP — runs once on startup
//  Creates the bucket if missing, then applies:
//    - bucket-level tags  (object tagging demo)
//    - lifecycle rule     (auto-expire objects after 1 day)
// ═══════════════════════════════════════════════════════════════

async function ensureBucket() {
    // 1 — create if missing
    try {
        await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
        console.log(`[${isR2 ? "R2" : "MinIO"}] Bucket "${BUCKET}" ready`);
    } catch {
        if (isR2) throw new Error(`R2 bucket "${BUCKET}" not found — create it in the Cloudflare dashboard first`);
        await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
        console.log(`[MinIO] Bucket "${BUCKET}" created`);
    }

    // 2 — tag the bucket so it's identifiable
    try {
        await s3.send(new PutBucketTaggingCommand({
            Bucket:  BUCKET,
            Tagging: {
                TagSet: [
                    { Key: "project",     Value: "object-storage-workshop" },
                    { Key: "environment", Value: "local-dev"               },
                ],
            },
        }));
        console.log(`[MinIO] Bucket tags applied`);
    } catch (err) {
        // Tagging failures are non-fatal — log and continue
        console.warn(`[MinIO] Bucket tagging skipped: ${err.message}`);
    }

    // 3 — lifecycle rule: auto-delete objects after 1 day
    //     Keeps the demo bucket clean between sessions.
    //     MinIO honours S3 lifecycle rules on the free edition.
    try {
        await s3.send(new PutBucketLifecycleConfigurationCommand({
            Bucket: BUCKET,
            LifecycleConfiguration: {
                Rules: [
                    {
                        ID:         "expire-workshop-objects",
                        Status:     "Enabled",
                        Filter:     { Prefix: "" },          // applies to every object
                        Expiration: { Days: 1 },             // delete after 1 day
                    },
                ],
            },
        }));
        console.log(`[MinIO] Lifecycle rule applied (expire after 1 day)`);
    } catch (err) {
        console.warn(`[MinIO] Lifecycle rule skipped: ${err.message}`);
    }
}

// ═══════════════════════════════════════════════════════════════
//  UPLOAD PATH A  —  POST /upload
//
//  Uses @aws-sdk/lib-storage Upload, which:
//    • Splits the file into chunks at the threshold the client sends
//    • Uploads each chunk as a separate S3 part (multipart upload)
//    • Assembles them server-side in MinIO
//    • Falls back to a single PutObject if the file is below the threshold
//
//  Query params:
//    expiresIn        — presigned URL lifetime in seconds (default 30)
//    multipartMB      — MB above which multipart kicks in (default 5 MB)
//
//  Multipart only activates when the file is BOTH:
//    - at or above the slider threshold (multipartMB)
//    - at or above MINIO_MIN_PART_SIZE (5 MB hard floor)
//  Files under 5 MB always use a single PutObjectCommand.
//
//  Progress is streamed back via Server-Sent Events on GET /upload-progress/:id
//  The client opens the SSE connection before POSTing the file, then both
//  run in parallel.
// ═══════════════════════════════════════════════════════════════

// In-memory map: uploadId → { loaded, total, done, error }
const progressMap = new Map();

// SSE endpoint — client connects here BEFORE starting the upload
app.get("/upload-progress/:id", (req, res) => {
    const { id } = req.params;

    res.setHeader("Content-Type",  "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection",    "keep-alive");
    res.flushHeaders();

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    // Poll the map every 100 ms and forward updates to the browser
    const interval = setInterval(() => {
        const progress = progressMap.get(id);
        if (!progress) return;

        send(progress);

        if (progress.done || progress.error) {
            clearInterval(interval);
            progressMap.delete(id);
            res.end();
        }
    }, 100);

    // Clean up if client disconnects
    req.on("close", () => {
        clearInterval(interval);
        progressMap.delete(id);
    });
});

app.post("/upload", upload.single("image"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file provided" });

    const expiresIn          = Math.max(5, Math.min(86400, parseInt(req.query.expiresIn)   || 30));
    const multipartThreshold = Math.max(5, Math.min(500,   parseInt(req.query.multipartMB) || 5)) * 1024 * 1024;
    const uploadId           = req.query.uploadId || `upload-${Date.now()}`;
    const key                = `${Date.now()}-${req.file.originalname}`;

    // Multipart only kicks in when the file meets BOTH the slider threshold
    // AND MinIO's hard 5 MB per-part minimum. Files under 5 MB always
    // use a single PUT — no EntityTooSmall error, no forced file size.
    const effectiveThreshold = Math.max(MINIO_MIN_PART_SIZE, multipartThreshold);
    const isMultipart        = req.file.size >= effectiveThreshold;

    progressMap.set(uploadId, { loaded: 0, total: req.file.size, done: false, error: null, isMultipart });

    try {
        if (isMultipart) {
            // ── Multipart path ───────────────────────────────────────────────────
            // @aws-sdk/lib-storage splits Body into chunkSize pieces and uploads
            // them concurrently (queueSize). MinIO assembles the parts atomically.
            const managed = new Upload({
                client: s3,
                queueSize: 4,                                              // up to 4 parts in flight simultaneously
                partSize:  Math.max(MINIO_MIN_PART_SIZE, multipartThreshold), // never go below MinIO's 5 MB floor
                leavePartsOnError: false,
                params: {
                    Bucket:      BUCKET,
                    Key:         key,
                    Body:        req.file.buffer,
                    ContentType: req.file.mimetype,
                    Metadata: {
                        "expires-in":          String(expiresIn),
                        "upload-mode":         "multipart",
                        "multipart-threshold": String(multipartThreshold),
                    },
                    // Tag each object with upload method — visible in MinIO console (MinIO only, R2 doesn't support object tagging)
                    ...(!isR2 && { Tagging: "upload-mode=multipart&source=workshop" }),
                },
            });

            // httpUploadProgress fires after each part lands
            managed.on("httpUploadProgress", (p) => {
                progressMap.set(uploadId, {
                    loaded:      p.loaded ?? 0,
                    total:       p.total  ?? req.file.size,
                    done:        false,
                    error:       null,
                    isMultipart: true,
                    part:        p.part ?? null,
                });
            });

            await managed.done();

        } else {
            // ── Single PUT path ──────────────────────────────────────────────────
            await s3.send(new PutObjectCommand({
                Bucket:      BUCKET,
                Key:         key,
                Body:        req.file.buffer,
                ContentType: req.file.mimetype,
                Metadata: {
                    "expires-in":  String(expiresIn),
                    "upload-mode": "single-put",
                },
                ...(!isR2 && { Tagging: "upload-mode=single-put&source=workshop" }),
            }));

            progressMap.set(uploadId, {
                loaded: req.file.size, total: req.file.size,
                done: false, error: null, isMultipart: false,
            });
        }

        // Mark done so the SSE stream closes cleanly
        progressMap.set(uploadId, {
            loaded: req.file.size, total: req.file.size,
            done: true, error: null, isMultipart,
        });

        console.log(`[PATH A] ${isMultipart ? "Multipart" : "Single PUT"}: ${key} (${(req.file.size / 1024).toFixed(1)} KB, threshold: ${(effectiveThreshold / 1024 / 1024).toFixed(1)} MB)`);
        res.json({ key, isMultipart });

    } catch (err) {
        progressMap.set(uploadId, { loaded: 0, total: req.file.size, done: false, error: err.message, isMultipart });

        if (err instanceof S3ServiceException) {
            console.error(`[PATH A] S3 error (${err.name}): ${err.message}`);
            return res.status(500).json({ error: err.name, detail: err.message });
        }
        console.error(`[PATH A] Upload failed: ${err.message}`);
        res.status(503).json({ error: "Upload failed", detail: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
//  UPLOAD PATH B  —  GET /presign-upload  (unchanged)
// ═══════════════════════════════════════════════════════════════

app.get("/presign-upload", async (req, res) => {
    try {
        const { filename, contentType } = req.query;
        if (!filename) return res.status(400).json({ error: "filename required" });

        const key = `${Date.now()}-${filename}`;

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

    } catch (err) {
        if (err instanceof S3ServiceException) {
            return res.status(500).json({ error: err.name, detail: err.message });
        }
        res.status(503).json({ error: "Could not generate upload URL", detail: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
//  GET /gallery
// ═══════════════════════════════════════════════════════════════

app.get("/gallery", async (req, res) => {
    try {
        const defaultExpiry = Math.max(5, Math.min(86400, parseInt(req.query.expiresIn) || 30));
        const list          = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }));
        const objects       = list.Contents ?? [];

        const items = await Promise.all(
            objects.map(async (obj) => {
                let expiresIn = defaultExpiry;
                try {
                    const head   = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
                    const stored = parseInt(head.Metadata?.["expires-in"]);
                    if (!isNaN(stored)) expiresIn = stored;
                } catch { /* metadata read failure is non-fatal */ }

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

    } catch (err) {
        if (err instanceof S3ServiceException) {
            return res.status(500).json({ error: err.name, detail: err.message });
        }
        res.status(503).json({ error: "Could not list gallery", detail: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
//  DELETE /objects/:key
// ═══════════════════════════════════════════════════════════════

app.delete("/objects/:key", async (req, res) => {
    try {
        const key = decodeURIComponent(req.params.key);
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
        console.log(`Deleted: ${key}`);
        res.json({ deleted: key });
    } catch (err) {
        if (err instanceof S3ServiceException) {
            return res.status(500).json({ error: err.name, detail: err.message });
        }
        res.status(503).json({ error: "Delete failed", detail: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
//  GET /nodes  —  erasure coding health check (unchanged)
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
                const timer      = setTimeout(() => controller.abort(), 900);
                const r          = await fetch(`http://localhost:${port}/minio/health/live`, { signal: controller.signal });
                clearTimeout(timer);
                return { id, status: r.ok ? "up" : "down" };
            } catch {
                return { id, status: "down" };
            }
        })
    );

    const upCount = results.filter((n) => n.status === "up").length;

    res.json({
        nodes:    results,
        ec:       { total: 4, data: 2, parity: 2 },
        canRead:  upCount >= 2,
        canWrite: upCount >= 3,
        upCount,
    });
});

// ═══════════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════════

const PORT = process.env.PORT ?? 3001;
ensureBucket()
    .then(() => app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`)))
    .catch((err) => {
        console.error("Failed to connect to MinIO:", err.message);
        process.exit(1);
    });
# Object Storage Workshop — MinIO Image Demo

A two-hour hands-on workshop showing why object storage beats database BLOBs for images.
Students upload images through a web page, see a gallery, and inspect the presigned URLs that
let the browser fetch images **directly from MinIO** — the app never holds the bytes.

---

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- [Node.js](https://nodejs.org/) 20 or later (`node -v` to check)

---

## Project layout

```
Object_Storage_Workshop/
├── docker-compose.yml   — MinIO container
├── backend/
│   ├── server.js        — Express API (upload, gallery, presigned URLs)
│   ├── .env             — MinIO connection config
│   └── package.json
└── frontend/
    ├── src/App.tsx      — single-page React UI
    └── vite.config.ts   — dev proxy → backend
```

---

## Step-by-step: running the workshop

### 1. Start MinIO

```bash
docker compose up -d
```

Verify it started:

```bash
docker compose ps
# minio should show "Up" and "healthy"
```

Open the MinIO console at **http://localhost:9001**
- Username: `minioadmin`
- Password: `minioadmin`

You won't see any buckets yet — the backend creates `workshop-images` automatically on first run.

---

### 2. Start the backend

```bash
cd backend
npm install
npm run dev
```

You should see:

```
Bucket "workshop-images" created
Backend running on http://localhost:3001
```

> If you see "Failed to connect to MinIO", wait 10 seconds for the container healthcheck to pass and retry.

---

### 3. Start the frontend

Open a **second terminal**:

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173** in your browser.

---

## How it works (teaching notes)

### Upload flow

```
Browser  →  POST /upload (multipart)  →  Express  →  PutObject  →  MinIO bucket
```

The image bytes flow through the backend exactly once on the way *in*. After that, the
backend never touches the file again.

### Gallery / presigned URL flow

```
Browser  →  GET /gallery  →  Express  →  ListObjectsV2  →  MinIO
                                       ↓
                              getSignedUrl() for each key
                                       ↓
              JSON [{key, url, size, lastModified}, …]  →  Browser
                                       ↓
              <img src="http://localhost:9000/…?X-Amz-Signature=…">
              Browser fetches image DIRECTLY from MinIO (no backend hop)
```

The presigned URL is just a regular HTTPS GET with an HMAC signature in the query string.
It expires (1 hour here). This is the "wow" moment — open DevTools → Network and watch the
image request go to `:9000`, not `:3001`.

### Why not store images as database BLOBs?

| | Database BLOB | Object storage (MinIO/S3) |
|---|---|---|
| Serving | Backend must stream every byte on every request | Browser fetches directly via presigned URL |
| Scaling | DB RAM/disk is expensive | Cheap, flat storage; scales horizontally |
| CDN | Hard to put a CDN in front | URL is just HTTP — trivially CDN-able |
| Backup/restore | Mixed with transactional data | Independent lifecycle |

---

## Useful commands during the workshop

```bash
# Watch backend logs live
docker compose logs -f minio

# List objects in the bucket via AWS CLI (if installed)
aws --endpoint-url http://localhost:9000 \
    --no-sign-request \
    s3 ls s3://workshop-images/

# Stop everything
docker compose down

# Stop and delete stored data
docker compose down -v
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `docker compose up` fails on image pull | Try `image: quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z` in docker-compose.yml |
| "Failed to connect to MinIO" on backend start | Container still starting — wait ~10 s and retry `npm run dev` |
| Gallery images don't load (broken img tags) | Check that MinIO is on `:9000` and the container is healthy |
| CORS error in browser | Make sure you're using the Vite proxy (`localhost:5173`), not calling `:3001` directly |

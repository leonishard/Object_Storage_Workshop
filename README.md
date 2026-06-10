# Object Storage Workshop — MinIO Image Demo

A hands-on workshop showing why object storage beats database BLOBs for images.
Students upload images through a web page, see a gallery, and inspect the presigned URLs that
let the browser fetch images **directly from MinIO** — the app never holds the bytes.

There are two upload paths to compare, a live erasure coding visualiser, and a short
coding exercise where students implement a presigned PUT route themselves.

---

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- [Node.js](https://nodejs.org/) 20 or later (`node -v` to check)

---

## Project layout

```
Object_Storage_Workshop/
├── docker-compose.yml   — 4-node MinIO cluster + nginx proxy
├── nginx.conf           — routes :9000 and :9001 across the cluster
├── backend/
│   ├── server.js        — Express API (upload, gallery, presigned URLs, node health)
│   ├── .env             — MinIO connection config (credentials provided separately)
│   └── package.json
└── frontend/
    ├── src/App.tsx      — single-page React UI
    └── vite.config.ts   — dev proxy → backend
```

---

## Step-by-step: running the workshop

### 1. Create the backend .env file

Create a file called `.env` inside the `backend/` folder. The credentials will be provided by your instructor.

### 2. Start MinIO

```bash
docker compose up -d
```

This starts **four MinIO nodes** (minio1–minio4) and an nginx proxy in front of them.
The cluster uses erasure coding (EC:2+2) — any 2 nodes can reconstruct any object.

Verify everything started:

```bash
docker compose ps
# all five containers should show "Up"
```

Open the MinIO console at **http://localhost:9001** and log in with the credentials your instructor provided.

You won't see any buckets yet — the backend creates `workshop-images` automatically on first run.

---

### 3. Start the backend

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

> If you see "Failed to connect to MinIO", wait 10 seconds for the containers to finish their healthchecks and retry.

---

### 4. Start the frontend

Open a **second terminal**:

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173** in your browser.

---

## How it works (teaching notes)

### Upload path A — via server (default)

```
Browser  →  POST /upload (multipart)  →  Express  →  PutObject  →  MinIO bucket
```

The image bytes flow through the backend on the way in. After that the backend never
touches the file again.

### Upload path B — direct to MinIO (presigned PUT)

```
Browser  →  GET /presign-upload  →  Express  (returns a signed PUT URL, no bytes)
Browser  →  PUT {signed URL}  ──────────────────────────────────────▶  MinIO
```

The backend signs a time-limited PUT URL and hands it to the browser. The file bytes
go **directly to MinIO** — the Express server never sees them. This is the scalable
production pattern: the backend is a keyholder, not a courier.

Students implement this route themselves as a short exercise — the stub and hints are
in `server.js` under `GET /presign-upload`.

### Gallery / presigned GET URL flow

```
Browser  →  GET /gallery  →  Express  →  ListObjectsV2  →  MinIO
                                       ↓
                              getSignedUrl() for each key
                                       ↓
              JSON [{key, url, size, lastModified}, …]  →  Browser
                                       ↓
              <img src="http://localhost:9000/…?X-Amz-Signature=…">
              Browser fetches image DIRECTLY from MinIO — no backend hop
```

The presigned URL is a regular HTTP GET with an HMAC-SHA256 signature in the query string.
To see requests go to `:9000` instead of `:3001`, open DevTools → Network and refresh the gallery.

### Erasure coding demo

The node status panel at the top of the Gallery tab polls `/nodes` every 2 seconds and shows
which of the 4 MinIO nodes are online, their shard role (D1/D2 = data, P1/P2 = parity),
and the current read/write quorum.

**Live demo steps:**

```bash
# Take one node offline — reads and writes still work (3/4 up)
docker compose stop minio3

# Take a second node offline — reads still work, writes blocked (2/4 up, below write quorum)
docker compose stop minio4

# Bring them back
docker compose start minio3 minio4
```

Watch the panel update within ~2 seconds each time. The gallery continues to load images
with 2 nodes down because any 2 of the 4 shards reconstruct the full object (read quorum = 2).
Uploads fail with 2 nodes down because writing safely requires 3 of 4 (write quorum = 3).

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
# Watch MinIO logs live
docker compose logs -f minio1

# Check node health directly
curl http://localhost:9100/minio/health/live   # node 1
curl http://localhost:9101/minio/health/live   # node 2
curl http://localhost:9102/minio/health/live   # node 3
curl http://localhost:9103/minio/health/live   # node 4

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
| "Failed to connect to MinIO" on backend start | Containers still starting — wait ~10 s and retry `npm run dev` |
| Gallery images don't load (broken img tags) | Check that MinIO is on `:9000` and all containers are healthy |
| CORS error in browser | Make sure you're using the Vite proxy (`localhost:5173`), not calling `:3001` directly |
| Node panel shows all nodes down | Backend can't reach ports 9100–9103 — check docker-compose.yml port mappings |
| Direct upload fails with 403 | The `GET /presign-upload` exercise route may not be implemented yet |

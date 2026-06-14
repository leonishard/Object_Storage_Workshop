# MinIO Object Storage Workshop

A hands-on 2-hour workshop exploring object storage concepts: presigned URLs, direct uploads, multipart uploads, erasure coding, and S3 API compatibility — all running locally with MinIO in Docker.

---

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- [Node.js](https://nodejs.org/) 20 or later (`node -v` to check)
- Git (`git --version` to check)

---

## Setup

### 1. Clone the repository

```bash
git clone <repo-url>
cd Object_Storage_Workshop
```

### 2. Create the `.env` file

Inside the `backend` folder, copy the example file and rename it to `.env`:

```bash
cp backend/.env.example backend/.env
```

The credentials are already filled in — no changes needed to get started with MinIO.

### 3. Install backend dependencies

```bash
cd backend
npm install
npm install @aws-sdk/lib-storage
```

### 4. Install frontend dependencies

Open a **second terminal**:

```bash
cd frontend
npm install
```

### 5. Start MinIO with Docker

Make sure Docker Desktop is running, then from the **project root**:

```bash
docker compose up -d
```

This starts four MinIO nodes and an nginx proxy. Wait about 15 seconds, then verify:

```bash
docker compose ps
# all five containers should show "Up"
```

You can also open the MinIO console at **http://localhost:9001** and log in with `minioadmin / minioadmin`.

### 6. Start the backend

In your backend terminal:

```bash
npm run dev
```

You should see:
```
[MinIO] Bucket "workshop-images" ready
Backend running on http://localhost:3001
```

> If you see "Failed to connect to MinIO", wait 10–15 seconds and try again — the containers may still be starting.

### 7. Start the frontend

In your frontend terminal:

```bash
npm run dev
```

Open **http://localhost:5173** in your browser.

---

## What you'll explore

| Feature | Where |
|---|---|
| Upload via server vs direct to MinIO | Gallery tab — mode toggle |
| Presigned GET URLs with expiry timers | Gallery tab — sidebar panel |
| Presigned PUT URL (student exercise) | Gallery tab — Direct to MinIO mode |
| Multipart upload threshold slider | Gallery tab — sidebar |
| Erasure coding — live node health | Gallery tab — top panel |
| Theory behind everything | Under the Hood tab |

---

## S3 API compatibility demo — switching to Cloudflare R2

This is the live demo for the "one SDK, any vendor" concept. The app switches from local MinIO to real cloud storage by changing **one line in `.env`** — no code changes at all.

### Before the demo (setup)

1. Log into [dash.cloudflare.com](https://dash.cloudflare.com) → **R2 Object Storage**
2. Create a bucket called `workshop-images`
3. Go to **Manage R2 API Tokens** → Create a token with **Object Read & Write** on that bucket
4. Copy your **Account ID** (shown top-right on the R2 page)
5. Fill in `backend/.env`:

```
R2_ACCOUNT_ID=abc123...
R2_ACCESS_KEY=...
R2_SECRET_KEY=...
R2_BUCKET=workshop-images
```

### The demo (live in front of students)

Open `backend/.env` and change one line:

```
STORAGE_PROVIDER=r2
```

The backend restarts automatically. Upload an image — the gallery loads and presigned URLs now point to `r2.cloudflarestorage.com` instead of `localhost:9000`.

Switch back to MinIO just as fast:

```
STORAGE_PROVIDER=minio
```

The teaching point: the SDK code in `server.js` is identical for both. `S3Client`, `PutObjectCommand`, `GetObjectCommand`, `getSignedUrl` — none of it changes. You're coding against the S3 API standard, not a specific vendor.

---

## Erasure coding demo

```bash
# Take one node offline — reads and writes still work
docker compose stop minio3

# Take a second node offline — reads work, writes blocked
docker compose stop minio4

# Bring them back
docker compose start minio3 minio4
```

Watch the node panel update within ~2 seconds each time.

---

## Useful commands

```bash
# Watch MinIO logs live
docker compose logs -f minio1

# Stop everything
docker compose down

# Stop and wipe all stored data
docker compose down -v
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Failed to connect to MinIO" on backend start | Containers still starting — wait ~15 s and retry |
| Gallery images don't load | Check MinIO is on `:9000` and all containers are healthy |
| Node panel shows all nodes down | Check docker-compose.yml port mappings for 9100–9103 |
| R2 bucket not found error | Create the bucket in the Cloudflare dashboard first |
| `npm` not recognised on Windows | Run `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` in PowerShell |

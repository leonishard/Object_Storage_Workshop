# MinIO Object Storage Workshop

A hands-on 2-hour workshop exploring object storage concepts: presigned URLs, direct uploads, erasure coding, and S3 API compatibility — all running locally with MinIO in Docker.

---

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- [Node.js](https://nodejs.org/) 20 or later (`node -v` to check)

---

## Setup

### 1. Install backend dependencies

```bash
cd backend
npm install
```

### 2. Create the backend `.env` file

Copy the example and you're done — the defaults work out of the box:

```bash
cp .env.example .env
```

The `.env.example` file contains:

```
MINIO_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=workshop-images
PORT=3001
```

### 3. Start MinIO (Docker)

From the project root:

```bash
docker compose up -d
```

This starts four MinIO nodes and an nginx proxy. Wait about 15 seconds for the cluster to become healthy, then verify:

```bash
docker compose ps
# all five containers should show "Up"
```

You can also open the MinIO console at **http://localhost:9001** and log in with `minioadmin / minioadmin`.

### 4. Start the backend

```bash
cd backend
npm run dev
```

You should see:
```
Bucket "workshop-images" created
Backend running on http://localhost:3001
```

> If you see "Failed to connect to MinIO", wait 10 seconds and try again — the containers may still be starting.

### 5. Install frontend dependencies and start the dev server

Open a **second terminal**:

```bash
cd frontend
npm install
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
| Erasure coding — live node health | Gallery tab — top panel |
| Theory behind everything | Under the Hood tab |

---

## Student exercise

Students implement the `GET /presign-upload` route in `backend/server.js`. The stub and hints are already there — it takes about 3 lines of code. The app shows a green badge when it's working.

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
# Watch logs
docker compose logs -f minio1

# Stop everything
docker compose down

# Stop and wipe stored data
docker compose down -v
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Failed to connect to MinIO" on backend start | Containers still starting — wait ~15 s and retry |
| Gallery images don't load | Check MinIO is on `:9000` and all containers are healthy |
| Direct upload fails with 403 | The `/presign-upload` exercise route may not be implemented yet |
| Node panel shows all nodes down | Check docker-compose.yml port mappings for 9100–9103 |
| `npm` not recognised on Windows | Run `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` in PowerShell |

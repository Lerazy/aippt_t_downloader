# Deploying AiPPT Downloader (Open Cloud OS)

This app is a Node 20 + Express server with Playwright (Chromium). You can deploy via Docker (recommended) or PM2.

## 0) Requirements
- Node.js 20 or Docker 24+
- Open Cloud OS server with ports exposed (e.g. 80/443 via Nginx)
- A domain and DNS pointing to your server (optional but recommended)

Environment variables:
- PORT (default 3000)
- PUBLIC_BASE_URL (external base URL for generated links)
- ADMIN_USERNAME, ADMIN_PASSWORD

## 1) Docker (recommended)

### Build image
```bash
# on server or locally
docker build -t aippt-downloader:latest .
```

### Run container
```bash
docker run -d \
  --name aippt-downloader \
  -p 3000:3000 \
  -e PORT=3000 \
  -e PUBLIC_BASE_URL="http://your-domain-or-ip:3000" \
  -e ADMIN_USERNAME="admin" \
  -e ADMIN_PASSWORD="strong_password" \
  -v $(pwd)/data:/app/data \
  aippt-downloader:latest
```

Then open `http://your-domain-or-ip:3000/admin`.

### With Nginx reverse proxy (optional)
- Point Nginx proxy_pass to `http://127.0.0.1:3000` and terminate TLS at Nginx.

## 2) PM2 (no Docker)

### Install system dependencies
```bash
# Open Cloud OS (RHEL/CentOS-like)
sudo yum -y install epel-release
sudo yum -y install git curl tar fontconfig

# Install Node 20 (via NodeSource or nvm)
# Example with nvm:
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.nvm/nvm.sh
nvm install 20
nvm use 20

# PM2
npm i -g pm2
```

### Pull code and install
```bash
git clone <your-repo-url> aippt-downloader
cd aippt-downloader
npm ci --omit=dev
# Install playwright chromium (and deps)
npx --yes playwright install --with-deps chromium || true
```

### Configure env
Create `.env` with:
```
PORT=3000
PUBLIC_BASE_URL=http://your-domain-or-ip
ADMIN_USERNAME=admin
ADMIN_PASSWORD=strong_password
```

### Start with PM2
```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # follow instruction to enable boot start
```

Site: `http://your-domain-or-ip:3000/admin`

## 3) Nginx sample
```
server {
  listen 80;
  server_name your-domain.com;

  location / {
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:3000;
  }
}
```

## 4) Notes
- Data is stored in data/ via lowdb. Mount or back it up.
- Playwright downloads temporary files; container clears them when stream closes.
- Change default admin credentials.

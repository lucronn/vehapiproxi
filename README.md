# Motor API Authentication Proxy

Automated authentication proxy for Motor API using Puppeteer headless browser.

## Features

- 🤖 Automated login flow with Puppeteer
- 💾 Session cookie persistence
- 🔄 Auto-refresh on expiration
- 🚀 Express proxy server
- 📝 Winston logging

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure credentials:**
   Create `.env` file:
   ```env
   LIBRARY_BARCODE=your_barcode_here
   EBSCO_USER=your_username
   EBSCO_PASSWORD=your_password
   MOTOR_API_BASE=https://sites.motor.com/m1
   PROXY_PORT=3001
   NODE_ENV=production
   ```

3. **Start server:**
   ```bash
   npm start
   ```

## Usage

Point your Angular app to `http://localhost:3001/api/*`

Example:
```typescript
// environment.ts
export const environment = {
  apiUrl: 'http://localhost:3001/api'
};
```

## Debug Mode

Watch the browser automation:
```bash
npm run debug
```

## How It Works

1. On startup, launches Puppeteer to authenticate
2. Navigates through library portal → EBSCO → Motor.com
3. Extracts and saves session cookies
4. Proxies all `/api/*` requests with authenticated cookies
5. Auto-refreshes when cookies expire

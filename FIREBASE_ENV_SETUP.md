# Firebase Functions Environment Variables Setup

## Current Local Configuration (.env)
- ✅ LIBRARY_BARCODE: `24777762549152`
- ✅ EBSCO_USER: `pl7321r`
- ✅ EBSCO_PASSWORD: (set in .env)

## Required Firebase Functions Configuration

Since Firebase Functions v2 doesn't use `.env` files directly, you need to set environment variables in the Firebase Console:

### Option 1: Firebase Console (Recommended)

1. Go to: https://console.firebase.google.com/project/vehapi-torque/functions
2. Click on **Configuration** tab
3. Click **Environment Variables** section
4. Add these variables:

   **LIBRARY_BARCODE**
   - Value: `24777762549152`

   **EBSCO_USER**
   - Value: `pl7321r`

   **EBSCO_PASSWORD**
   - Value: (use the password from your .env file)

5. Click **Save**
6. Redeploy: `firebase deploy --only functions:motorApiAuthProxy`

### Option 2: Using Firebase CLI (Alternative)

Since `functions.config()` is deprecated, you can use environment variables via the Firebase Console or migrate to secrets (more complex).

## Quick Deploy Command

After setting environment variables in the Console:

```bash
cd /Users/phobosair/projects/motorapi-proxy
firebase deploy --only functions:motorApiAuthProxy
```

## Verify Configuration

After deployment, test the health endpoint:

```bash
curl https://us-central1-vehapi-torque.cloudfunctions.net/motorApiAuthProxy/health
```

Expected response when authenticated:
```json
{
  "status": "ok",
  "sessionValid": true,
  "lastAuth": <timestamp>
}
```

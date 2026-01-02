# Setting Up Environment Variables for Firebase Functions

The proxy requires authentication credentials to be set as environment variables in Firebase Functions.

## Option 1: Using Firebase Secrets (Recommended for Production)

Firebase Functions v2 supports secrets for sensitive data:

```bash
# Set each secret
echo "YOUR_LIBRARY_BARCODE" | firebase functions:secrets:set LIBRARY_BARCODE
echo "YOUR_EBSCO_USER" | firebase functions:secrets:set EBSCO_USER  
echo "YOUR_EBSCO_PASSWORD" | firebase functions:secrets:set EBSCO_PASSWORD

# Or set them interactively
firebase functions:secrets:set LIBRARY_BARCODE
firebase functions:secrets:set EBSCO_USER
firebase functions:secrets:set EBSCO_PASSWORD
```

Then update `src/function.js` to use secrets:

```javascript
import { defineSecret } from 'firebase-functions/params';

const libraryBarcode = defineSecret('LIBRARY_BARCODE');
const ebscoUser = defineSecret('EBSCO_USER');
const ebscoPassword = defineSecret('EBSCO_PASSWORD');
```

## Option 2: Using Runtime Config (Legacy, but simpler)

```bash
firebase functions:config:set \
  library.barcode="YOUR_LIBRARY_BARCODE" \
  ebsco.user="YOUR_EBSCO_USER" \
  ebsco.password="YOUR_EBSCO_PASSWORD"
```

Then update `src/config.js` to read from `functions.config()`:

```javascript
import functions from 'firebase-functions';

const runtimeConfig = functions.config();

export const config = {
    libraryBarcode: runtimeConfig.library?.barcode || process.env.LIBRARY_BARCODE || '',
    ebscoUser: runtimeConfig.ebsco?.user || process.env.EBSCO_USER || '',
    ebscoPassword: runtimeConfig.ebsco?.password || process.env.EBSCO_PASSWORD || '',
    // ... rest of config
};
```

## Option 3: Using .env file (Local Development Only)

For local testing, create a `.env` file:

```env
LIBRARY_BARCODE=your_barcode_here
EBSCO_USER=your_username
EBSCO_PASSWORD=your_password
MOTOR_API_BASE=https://sites.motor.com/m1
```

**Note:** `.env` files are NOT deployed to Firebase Functions. They only work locally.

## Current Status

The code has been updated to:
- ✅ Initialize authentication on function startup
- ✅ Better error handling and logging
- ✅ Retry authentication if session is invalid

After setting the environment variables/secrets, deploy the function:

```bash
firebase deploy --only functions
```

## Verifying Configuration

After deployment, check the function logs:

```bash
firebase functions:log --only motorApiAuthProxy
```

Look for:
- "Initializing authentication on function startup..."
- "✓ Authentication initialized successfully" or "✓ Valid session loaded from Firestore"

If you see "Missing required configuration" errors, the environment variables are not set correctly.

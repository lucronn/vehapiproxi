# Deployment Issue: Environment Variable Conflict

## Problem
The function has existing environment variables that conflict with secrets:
```
Secret environment variable overlaps non secret environment variable: LIBRARY_BARCODE
```

## Solution

You need to remove the existing environment variables from the deployed function via Firebase Console:

1. Go to: https://console.firebase.google.com/project/vehapi-torque/functions
2. Click on the `motorApiAuthProxy` function
3. Go to the **Configuration** tab
4. Under **Environment Variables**, remove these if they exist:
   - `LIBRARY_BARCODE`
   - `EBSCO_USER`  
   - `EBSCO_PASSWORD`
5. Click **Save**
6. Then redeploy: `firebase deploy --only functions:motorApiAuthProxy`

## Alternative: Use different secret names

If you can't access the console, we could rename the secrets to avoid conflicts (e.g., `MOTOR_LIBRARY_BARCODE`), but that requires code changes.

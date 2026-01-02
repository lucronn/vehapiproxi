import dotenv from 'dotenv';
dotenv.config();

export const config = {
    // Authentication credentials
    // In Firebase Functions, these come from secrets (injected as env vars)
    // Locally, these come from .env file
    libraryBarcode: process.env.LIBRARY_BARCODE || '',
    ebscoUser: process.env.EBSCO_USER || '',
    ebscoPassword: process.env.EBSCO_PASSWORD || '',

    // API configuration
    motorApiBase: process.env.MOTOR_API_BASE || 'https://sites.motor.com/m1',
    proxyPort: parseInt(process.env.PROXY_PORT || '3001', 10),

    // Session management
    maxSessionAge: 24 * 60 * 60 * 1000, // 24 hours in milliseconds

    // Browser settings
    headless: process.env.NODE_ENV !== 'development',

    // URLs from the authentication flow
    urls: {
        libraryPortal: 'https://e-resources.powerlibrary.org/ext/econtent/BarcodeEntry/index.php?lid=PL7321R&dataid=2145&libname=E-Card+or+public+library',
        ebscoLogin: 'https://search.ebscohost.com/login.aspx',
        motorBase: 'https://sites.motor.com'
    },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

// Validate required configuration
export function validateConfig() {
    const required = ['libraryBarcode', 'ebscoUser', 'ebscoPassword'];
    const missing = required.filter(key => !config[key] || config[key].trim() === '');

    if (missing.length > 0) {
        const errorMsg = `Missing required configuration: ${missing.join(', ')}. ` +
            `Please set these as environment variables: ${missing.map(k => k.toUpperCase()).join(', ')}`;
        console.error(errorMsg);
        // In Firebase Functions, we should use runtime config or secrets
        // For now, log the error but don't throw to allow function to start
        // The authentication will fail gracefully with a clear error message
        throw new Error(errorMsg);
    }
}

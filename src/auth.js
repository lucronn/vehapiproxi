import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import https from 'https';
import { URL } from 'url';
import { config } from './config.js';
import logger from './logger.js';

// Initialize Firebase Admin if not already initialized
if (!getApps().length) {
    initializeApp();
}

const db = getFirestore();
const SESSION_DOC_ID = 'motor_proxy_v3'; // Bump version to invalidate old sessions

// Simple cookie jar to track cookies across redirects
class CookieJar {
    constructor() {
        this.cookies = new Map();
    }

    setCookie(setCookieHeader, domain) {
        if (!setCookieHeader) return;
        
        // Parse Set-Cookie header: "name=value; path=/; domain=.example.com"
        const parts = setCookieHeader.split(';');
        const [nameValue] = parts;
        const [name, value] = nameValue.trim().split('=');
        if (name && value) {
            this.cookies.set(name, { value, domain });
        }
    }

    getCookieHeader(hostname) {
        const relevant = Array.from(this.cookies.entries())
            .filter(([_, cookie]) => {
                // Match domain (including subdomains)
                return hostname.includes(cookie.domain.replace(/^\./, '')) || 
                       cookie.domain.includes(hostname);
            })
            .map(([name, cookie]) => `${name}=${cookie.value}`);
        return relevant.join('; ');
    }

    getAllCookies() {
        return Array.from(this.cookies.entries()).map(([name, cookie]) => ({
            name,
            value: cookie.value,
            domain: cookie.domain
        }));
    }
}

// Helper to make HTTP request and handle redirects with cookie tracking
function httpsRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const requestOptions = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: {
                'User-Agent': config.userAgent,
                ...options.headers
            }
        };

        const req = https.request(requestOptions, (res) => {
            const cookies = [];
            const setCookieHeaders = res.headers['set-cookie'] || [];
            
            setCookieHeaders.forEach(header => {
                cookies.push(header);
            });

            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    cookies,
                    data,
                    url: url
                });
            });
        });

        req.on('error', reject);
        req.end();
    });
}

class AuthManager {
    constructor() {
        this.cookies = [];
        this.lastAuthTime = null;
        this.authPromise = null;
        // Progress tracking for UI polling
        this.authProgress = {
            status: 'idle', // 'idle' | 'authenticating' | 'success' | 'error'
            step: null,
            message: null,
            progress: 0, // 0-100
            error: null,
            startedAt: null,
            completedAt: null
        };
    }

    /**
     * Get current authentication progress
     */
    getProgress() {
        return { ...this.authProgress };
    }

    /**
     * Update progress state
     */
    _updateProgress(status, step, message, progress = null) {
        this.authProgress = {
            ...this.authProgress,
            status,
            step,
            message,
            progress: progress !== null ? progress : this.authProgress.progress,
            startedAt: this.authProgress.startedAt || Date.now()
        };
    }

    /**
     * Check if session is valid
     */
    isSessionValid() {
        if (!this.cookies.length || !this.lastAuthTime) {
            return false;
        }

        const age = Date.now() - this.lastAuthTime;
        return age < config.maxSessionAge;
    }

    /**
     * Load saved session cookies from Firestore
     */
    async loadSession() {
        try {
            const doc = await db.collection('sessions').doc(SESSION_DOC_ID).get();

            if (!doc.exists) {
                logger.info('No saved session found in Firestore, will authenticate');
                return false;
            }

            const session = doc.data();
            this.cookies = session.cookies;
            this.lastAuthTime = session.timestamp;

            if (this.isSessionValid()) {
                logger.info('✓ Loaded valid session from Firestore');
                return true;
            } else {
                logger.info('Session expired, re-authenticating...');
                return false;
            }
        } catch (error) {
            logger.error('Error loading session from Firestore:', error);
            return false;
        }
    }

    /**
     * Save session cookies to Firestore
     */
    async saveSession() {
        const session = {
            cookies: this.cookies,
            timestamp: this.lastAuthTime,
            updatedAt: new Date().toISOString()
        };

        try {
            await db.collection('sessions').doc(SESSION_DOC_ID).set(session);
            logger.info('✓ Session saved to Firestore');
        } catch (e) {
            logger.error('Could not save session to Firestore', e);
        }
    }

    /**
     * Delete session from Firestore (called when session is invalid)
     */
    async deleteSession() {
        try {
            await db.collection('sessions').doc(SESSION_DOC_ID).delete();
            logger.info('✓ Session deleted from Firestore');
        } catch (e) {
            logger.error('Could not delete session from Firestore', e);
        }
    }

    /**
     * Invalidate session (clears in-memory and deletes from Firestore)
     */
    async invalidateSession() {
        this.lastAuthTime = 0;
        this.cookies = [];
        await this.deleteSession();
        logger.info('✓ Session invalidated and deleted');
    }

    /**
     * Simplified authentication flow using direct GET request
     */
    async authenticate() {
        // If authentication is already in progress, return the existing promise
        if (this.authPromise) {
            logger.info('Authentication already in progress, waiting for result...');
            try {
                await this.authPromise;
                return;
            } catch (err) {
                throw err;
            }
        }

        // Reset progress state for new authentication
        this.resetProgress();

        // Create a new auth promise
        this.authPromise = (async () => {
            logger.info('Starting simplified authentication flow...');
            this._updateProgress('authenticating', 'init', 'Starting authentication...', 0);

            try {
                const ebscoLoginUrl = 'https://search.ebscohost.com/login.aspx?authtype=uid&user=pl7321r&password=PL%3F7321R&profile=autorepso&groupid=remote';
                const cookieJar = new CookieJar();
                let currentUrl = ebscoLoginUrl;
                let redirectCount = 0;
                const maxRedirects = 10;

                logger.info(`Step 1: Making GET request to EBSCO login URL...`);
                this._updateProgress('authenticating', 'ebsco_login', 'Connecting to EBSCO...', 10);
                
                // Follow redirects manually to capture cookies
                while (redirectCount < maxRedirects) {
                    const urlObj = new URL(currentUrl);
                    const cookieHeader = cookieJar.getCookieHeader(urlObj.hostname);
                    
                    const response = await httpsRequest(currentUrl, {
                        headers: cookieHeader ? { 'Cookie': cookieHeader } : {}
                    });

                    // Store cookies from this response
                    response.cookies.forEach(cookie => {
                        cookieJar.setCookie(cookie, urlObj.hostname);
                    });

                    logger.info(`Response status: ${response.statusCode}, URL: ${currentUrl}`);
                    logger.info(`Cookies received: ${response.cookies.length}`);

                    // Update progress based on redirect count
                    const progressPercent = Math.min(10 + (redirectCount * 15), 70);
                    this._updateProgress('authenticating', 'redirecting', `Following redirect ${redirectCount + 1}...`, progressPercent);

                    // Handle redirect
                    if (response.statusCode >= 300 && response.statusCode < 400) {
                        const location = response.headers.location;
                        if (location) {
                            currentUrl = new URL(location, currentUrl).href;
                            redirectCount++;
                            logger.info(`Redirect ${redirectCount} to: ${currentUrl}`);
                            continue;
                        }
                    }

                    // Check if we've reached motor.com
                    if (currentUrl.includes('motor.com')) {
                        logger.info(`✓ Reached motor.com at: ${currentUrl}`);
                        this._updateProgress('authenticating', 'motor_connect', 'Connecting to Motor.com...', 75);
                        
                        // Make a final request to motor.com/m1 to ensure we have the right cookies
                        const motorUrl = 'https://sites.motor.com/m1';
                        const cookieHeaderForMotor = cookieJar.getCookieHeader('sites.motor.com');
                        
                        logger.info('Step 2: Making final request to motor.com/m1...');
                        this._updateProgress('authenticating', 'motor_auth', 'Authenticating with Motor.com...', 85);
                        const finalResponse = await httpsRequest(motorUrl, {
                            headers: cookieHeaderForMotor ? { 'Cookie': cookieHeaderForMotor } : {}
                        });

                        // Store any additional cookies from motor.com
                        finalResponse.cookies.forEach(cookie => {
                            cookieJar.setCookie(cookie, 'sites.motor.com');
                        });

                        logger.info(`Final response status: ${finalResponse.statusCode}`);
                        break;
                    }

                    // If we get here and no redirect, we're done
                    break;
                }

                // Extract all motor.com cookies
                this.cookies = cookieJar.getAllCookies().filter(cookie => 
                    cookie.domain.includes('motor.com')
                );

                // If we didn't get motor.com cookies, use all cookies we collected
                if (this.cookies.length === 0) {
                    const allCookies = cookieJar.getAllCookies();
                    logger.warn(`No motor.com cookies found, using all cookies: ${allCookies.length}`);
                    this.cookies = allCookies;
                }

                this.lastAuthTime = Date.now();

                logger.info(`✓ Authentication successful! Got ${this.cookies.length} cookies`);
                logger.info(`Cookies: ${this.cookies.map(c => c.name).join(', ')}`);

                this._updateProgress('authenticating', 'saving', 'Saving session...', 95);
                await this.saveSession();

                this._updateProgress('success', 'complete', 'Authentication successful!', 100);
                this.authProgress.completedAt = Date.now();

            } catch (error) {
                logger.error('Authentication failed:', error);
                this._updateProgress('error', 'failed', `Authentication failed: ${error.message}`, 0);
                this.authProgress.error = error.message;
                this.authProgress.completedAt = Date.now();
                throw error;
            }
        })();

        try {
            await this.authPromise;
        } finally {
            this.authPromise = null;
        }
    }

    /**
     * Get session cookies (authenticate if needed)
     */
    async getCookies() {
        if (!this.isSessionValid()) {
            await this.authenticate();
        }
        return this.cookies;
    }

    /**
     * Reset progress state (call before starting new authentication)
     */
    resetProgress() {
        this.authProgress = {
            status: 'idle',
            step: null,
            message: null,
            progress: 0,
            error: null,
            startedAt: null,
            completedAt: null
        };
    }

    /**
     * Get cookies as a Cookie header string
     */
    async getCookieHeader() {
        const cookies = await this.getCookies();
        return cookies.map(c => `${c.name}=${c.value}`).join('; ');
    }
}

// Singleton instance
export const authManager = new AuthManager();

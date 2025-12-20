import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { config } from './config.js';
import logger from './logger.js';

// Initialize Firebase Admin if not already initialized
if (!getApps().length) {
    initializeApp();
}

const db = getFirestore();
const SESSION_DOC_ID = 'motor_proxy_v1';

class AuthManager {
    constructor() {
        this.cookies = [];
        this.lastAuthTime = null;
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
     * Perform authentication flow using Puppeteer
     */
    async authenticate() {
        logger.info('Starting authentication flow...');

        const browser = await puppeteer.launch({
            args: [
                ...chromium.args,
                `--user-agent=${config.userAgent}`
            ],
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
            ignoreHTTPSErrors: true,
        });

        try {
            let page = await browser.newPage();

            // Step 1: Navigate to library portal
            logger.info('Step 1: Navigating to library portal...');
            try {
                await page.goto(config.urls.libraryPortal);
            } catch (err) {
                logger.warn('Navigation error (ignoring if frame detached):', err.message);
            }

            // Wait for page to stabilize/redirect
            await new Promise(r => setTimeout(r, 3000));
            logger.info(`Current URL: ${page.url()}`);

            // Step 2: Submit barcode
            logger.info('Step 2: Submitting library barcode...');
            const inputExists = await page.waitForSelector('input[name="barcode"]', { timeout: 10000 });
            if (inputExists) {
                logger.info('Input found, setting value directly...');
                await page.evaluate((val) => {
                    const el = document.querySelector('input[name="barcode"]');
                    if (el) el.value = val;
                }, config.libraryBarcode);

                logger.info('Clicking submit...');
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(e => logger.warn('Nav wait error:', e.message)),
                    page.click('button[type="submit"], input[type="submit"]')
                ]);
            } else {
                throw new Error('Barcode input not found');
            }

            // Step 3: Wait for EBSCO login (may auto-redirect through OAuth)
            logger.info('Step 3: Handling EBSCO authentication details...');
            await new Promise(r => setTimeout(r, 5000)); // Allow redirects/popups to process

            // Check for new tabs/popups
            const pages = await browser.pages();
            logger.info(`Open pages after navigation: ${pages.length}`);
            page = pages[pages.length - 1]; // Switch to the most recent page
            logger.info(`Current URL (active page): ${page.url()}`);

            // Step 4: Wait for Motor.com or check if we need to click through
            logger.info('Step 4: Waiting for Motor.com...');

            // Wait for either Motor.com to load or an "Access through institution" button
            try {
                await page.waitForFunction(
                    () => window.location.hostname.includes('motor.com'),
                    { timeout: 20000 }
                );
                logger.info('✓ Reached Motor.com');
            } catch (err) {
                // May need to click "Access through institution" on EBSCO page
                const institutionButton = await page.$('button:contains("Access through your institution"), a:contains("institution")');
                if (institutionButton) {
                    logger.info('Clicking "Access through institution"...');
                    await institutionButton.click();
                    await page.waitForFunction(
                        () => window.location.hostname.includes('motor.com'),
                        { timeout: 20000 }
                    );
                }
            }

            // Step 5: Extract cookies from Motor.com
            logger.info('Step 5: Extracting session cookies...');

            // Log requests to find the real API
            page.on('request', req => {
                if (req.resourceType() === 'xhr' || req.resourceType() === 'fetch') {
                    logger.info(`Valid API Request observed: ${req.url()}`);
                }
            });

            // Wait a bit to capture potential initial data loads
            await new Promise(r => setTimeout(r, 5000));

            // PROBE: Check if /years returns JSON or HTML
            try {
                logger.info('PROBING /years endpoint...');
                const probePage = await browser.newPage();
                await probePage.goto(`${config.motorApiBase}/years`);
                const content = await probePage.content();
                const contentType = content.trim().startsWith('<') ? 'HTML' : 'JSON';
                logger.info(`PROBE RESULT: /years returned ${contentType}`);
                logger.info(`Preview: ${content.substring(0, 200)}`);
                await probePage.close();
            } catch (e) {
                logger.error('Probe failed:', e);
            }

            const allCookies = await page.cookies();
            this.cookies = allCookies.filter(cookie =>
                cookie.domain.includes('motor.com')
            );

            this.lastAuthTime = Date.now();

            logger.info(`✓ Authentication successful! Got ${this.cookies.length} cookies`);
            logger.info(`Cookies: ${this.cookies.map(c => c.name).join(', ')}`);

            await this.saveSession();

        } catch (error) {
            logger.error('Authentication failed:', error);
            throw error;
        } finally {
            await browser.close();
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
     * Get cookies as a Cookie header string
     */
    async getCookieHeader() {
        const cookies = await this.getCookies();
        return cookies.map(c => `${c.name}=${c.value}`).join('; ');
    }
}

// Singleton instance
export const authManager = new AuthManager();

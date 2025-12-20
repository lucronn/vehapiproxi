import { onRequest } from 'firebase-functions/v2/https';
import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { config, validateConfig } from './config.js';
import { authManager } from './auth.js';
import logger from './logger.js';

// Validate configuration
validateConfig();

const app = express();

// Enable CORS
app.use(cors({
    origin: true, // Allow all origins for now, or specify the frontend URL
    credentials: true
}));

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        sessionValid: authManager.isSessionValid(),
        lastAuth: authManager.lastAuthTime
    });
});

// Async Authentication Middleware
const authMiddleware = async (req, res, next) => {
    try {
        // Ensure authentication before proxying
        if (!authManager.isSessionValid()) {
            logger.info('Session invalid, attempting to restore/authenticate...');
            await authManager.loadSession();
            if (!authManager.isSessionValid()) {
                await authManager.authenticate();
            }
        }

        const cookieHeader = await authManager.getCookieHeader();
        req.headers['cookie'] = cookieHeader; // Attach to request headers
        req.headers['user-agent'] = config.userAgent; // Match the browser session UA
        req.headers['referer'] = 'https://sites.motor.com/m1/'; // Spoof referer
        req.headers['x-requested-with'] = 'XMLHttpRequest'; // Mark as AJAX
        next();
    } catch (error) {
        logger.error('Authentication check failed:', error);
        res.status(500).json({ error: 'Authentication failed' });
    }
};

// Proxy middleware
app.use('/api', authMiddleware, createProxyMiddleware({
    target: config.motorApiBase,
    changeOrigin: true,
    pathRewrite: {
        '^/api': ''
    },
    onProxyReq: (proxyReq, req, res) => {
        // Headers modified in middleware are automatically forwarded
        logger.info(`→ ${req.method} ${req.path}`);
    },
    onProxyRes: (proxyRes, req, res) => {
        // logger.info(`← ${proxyRes.statusCode} ${req.path}`);
    },
    onError: (err, req, res) => {
        logger.error('Proxy error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Proxy request failed' });
        }
    }
}));

// Export as Firebase Function
export const motorApiAuthProxy = onRequest({
    memory: '2GiB',
    timeoutSeconds: 300,
    region: 'us-central1', // Customize if needed
}, app);

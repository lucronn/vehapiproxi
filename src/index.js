import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { config, validateConfig } from './config.js';
import { authManager } from './auth.js';
import logger from './logger.js';

// Validate configuration on startup
validateConfig();

const app = express();

// Enable CORS for Angular dev server
app.use(cors({
    origin: ['http://localhost:4200', 'http://localhost:4201', 'https://vehapi-torque.web.app'],
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

// Proxy middleware for Motor API
app.use('/api', createProxyMiddleware({
    target: config.motorApiBase,
    changeOrigin: true,
    pathRewrite: {
        '^/api': '' // Remove /api prefix when forwarding
    },
    onProxyReq: async (proxyReq, req, res) => {
        try {
            // Inject authenticated cookies
            const cookieHeader = await authManager.getCookieHeader();
            proxyReq.setHeader('Cookie', cookieHeader);

            logger.info(`→ ${req.method} ${req.path} → ${config.motorApiBase}${req.path.replace('/api', '')}`);
        } catch (error) {
            logger.error('Failed to get cookies for request:', error);
            res.status(500).json({ error: 'Authentication failed' });
        }
    },
    onProxyRes: (proxyRes, req, res) => {
        logger.info(`← ${proxyRes.statusCode} ${req.path}`);
    },
    onError: (err, req, res) => {
        logger.error('Proxy error:', err);
        res.status(500).json({ error: 'Proxy request failed' });
    }
}));

// Start server and authenticate
async function start() {
    try {
        logger.info('Motor API Authentication Proxy starting...');
        logger.info(`Target API: ${config.motorApiBase}`);
        logger.info(`Proxy port: ${config.proxyPort}`);
        logger.info(`Headless mode: ${config.headless}`);

        // Try to load existing session
        const loaded = await authManager.loadSession();

        // If no valid session, authenticate now
        if (!loaded) {
            await authManager.authenticate();
        }

        // Start Express server
        app.listen(config.proxyPort, () => {
            logger.info(`✓ Proxy server listening on http://localhost:${config.proxyPort}`);
            logger.info(`  Health check: http://localhost:${config.proxyPort}/health`);
            logger.info(`  API proxy: http://localhost:${config.proxyPort}/api/*`);
            logger.info('Ready to proxy requests!');
        });

    } catch (error) {
        logger.error('Failed to start proxy server:', error);
        process.exit(1);
    }
}

// Handle shutdown
process.on('SIGINT', () => {
    logger.info('Shutting down proxy server...');
    process.exit(0);
});

start();

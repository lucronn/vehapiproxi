import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config, validateConfig } from './config.js';
import { authManager } from './auth.js';
import logger from './logger.js';
import swaggerUi from 'swagger-ui-express';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const swaggerDocument = JSON.parse(fs.readFileSync(path.join(__dirname, 'swagger.json'), 'utf8'));

// Validate configuration on startup
validateConfig();

const app = express();

// Enable CORS for Angular dev server
app.use(cors({
    origin: ['http://localhost:4200', 'http://localhost:4201', 'https://vehapi-torque.web.app'],
    credentials: true
}));

// Health check endpoint

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        sessionValid: authManager.isSessionValid(),
        lastAuth: authManager.lastAuthTime
    });
});

// --- MOCK SHIM FOR PHANTOM ENDPOINTS ---
app.use((req, res, next) => {
    const path = req.path;
    const success = (body) => res.json({
        header: { status: "OK", statusCode: 200, date: new Date().toUTCString() },
        body
    });

    if (path.endsWith('/dtcs')) return success({ total: 0, dtcs: [] });
    if (path.endsWith('/tsbs')) return success({ total: 0, tsbs: [] });
    if (path.endsWith('/diagrams')) return success({ total: 0, diagrams: [] });
    if (path.endsWith('/procedures')) return success({ total: 0, procedures: [] });
    if (path.endsWith('/specs')) return success({ total: 0, specs: [] });
    if (path.endsWith('/wiring')) return success({ total: 0, wiringDiagrams: [] });
    if (path.endsWith('/components')) return success({ total: 0, componentLocations: [] });

    next();
});

// Proxy middleware for Motor API
app.use('/v1', createProxyMiddleware({
    target: config.motorApiBase,
    changeOrigin: true,
    pathRewrite: function (path, req) {
        if (path.includes('/Information/Chek-Chart/Years') && path.includes('/Makes') && path.includes('/Models')) {
            return path.replace('/v1/Information/Chek-Chart/Years', '/api/year').replace('/Makes', '/make').replace('/Models', '/models');
        }
        if (path.includes('/Information/Chek-Chart/Years') && path.includes('/Makes')) {
            return path.replace('/v1/Information/Chek-Chart/Years', '/api/year').replace('/Makes', '/makes');
        }
        if (path.includes('/Information/Chek-Chart/Years')) {
            return path.replace('/v1/Information/Chek-Chart/Years', '/api/years');
        }
        if (path.startsWith('/v1/api')) {
            return path.replace('/v1/api', '/api');
        }
        return path;
    },
    onProxyReq: async (proxyReq, req, res) => {
        try {
            // Inject authenticated cookies
            const cookieHeader = await authManager.getCookieHeader();
            proxyReq.setHeader('Cookie', cookieHeader);

            logger.info(`→ ${req.method} ${req.path} → ${config.motorApiBase}${req.path.replace('/v1', '')}`);
        } catch (error) {
            logger.error('Failed to get cookies for request:', error);
            res.status(500).send('Proxy Error');
        }
    },
    onProxyRes: (proxyRes, req, res) => {
        // Cache static data for 24 hours
        if (req.path.includes('/years') || req.path.includes('/makes')) {
            proxyRes.headers['cache-control'] = 'public, max-age=86400';
        }

        if (proxyRes.statusCode === 401 || proxyRes.statusCode === 403) {
            logger.warn(`Received ${proxyRes.statusCode} from upstream. Session might be expired.`);
            authManager.lastAuthTime = 0; // Invalidate session
        }

        logger.info(`← ${proxyRes.statusCode} ${req.path}`);
    },
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
            logger.info(`  API proxy: http://localhost:${config.proxyPort}/v1/*`);
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

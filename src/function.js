import { onRequest } from 'firebase-functions/v2/https';
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

// Validate configuration
validateConfig();

const app = express();

// Enable CORS
app.use(cors({
    origin: true, // Allow all origins for now, or specify the frontend URL
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

// Async Authentication Middleware
const authMiddleware = async (req, res, next) => {
    // Skip auth for preflight requests
    if (req.method === 'OPTIONS') {
        return next();
    }

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

// --- MOCK SHIM FOR PHANTOM ENDPOINTS ---
// The frontend still requests these invalid endpoints. 
// We return empty lists to unblock the application initialization.
app.use((req, res, next) => {
    const path = req.path;

    // Helper for standard success response
    const success = (body) => res.json({
        header: { status: "OK", statusCode: 200, date: new Date().toUTCString() },
        body
    });

    if (path.endsWith('/dtcs')) {
        return success({ total: 0, dtcs: [] });
    }
    if (path.endsWith('/tsbs')) {
        return success({ total: 0, tsbs: [] });
    }
    if (path.endsWith('/diagrams')) {
        return success({ total: 0, diagrams: [] });
    }
    if (path.endsWith('/procedures')) {
        return success({ total: 0, procedures: [] });
    }
    if (path.endsWith('/specs')) {
        return success({ total: 0, specs: [] });
    }
    if (path.endsWith('/wiring')) {
        return success({ total: 0, wiringDiagrams: [] });
    }
    if (path.endsWith('/components')) {
        return success({ total: 0, componentLocations: [] });
    }

    next();
});

// Legacy /v1 route - proxies to Motor.com /m1 endpoint with path rewriting
app.use('/v1', authMiddleware, createProxyMiddleware({
    target: config.motorApiBase, // https://sites.motor.com/m1
    changeOrigin: true,
    onProxyReq: (proxyReq, req, res) => {
        try {
            // Get cookies from request headers (set by authMiddleware)
            const cookieHeader = req.headers['cookie'];
            if (cookieHeader) {
                proxyReq.setHeader('Cookie', cookieHeader);
                logger.debug(`Cookie header set for /v1: ${cookieHeader.substring(0, 100)}...`);
            } else {
                logger.warn('No cookie header available for /v1!');
            }
            
            // Set required headers for connector
            proxyReq.setHeader('Origin', 'https://sites.motor.com');
            proxyReq.setHeader('Referer', 'https://sites.motor.com/m1/');
            proxyReq.setHeader('User-Agent', config.userAgent);
            proxyReq.setHeader('X-Requested-With', 'XMLHttpRequest');
            
            logger.info(`→ ${req.method} ${req.path} → ${config.motorApiBase}${req.path.replace('/v1', '')}`);
        } catch (error) {
            logger.error('Error setting proxy request headers for /v1:', error);
        }
    },
    pathRewrite: function (path, req) {
        // Explicit rewrites for Chek-Chart legacy paths to /api
        if (path.includes('/Information/Chek-Chart/Years') && path.includes('/Makes') && path.includes('/Models')) {
            return path.replace('/v1/Information/Chek-Chart/Years', '/api/year').replace('/Makes', '/make').replace('/Models', '/models');
        }
        if (path.includes('/Information/Chek-Chart/Years') && path.includes('/Makes')) {
            return path.replace('/v1/Information/Chek-Chart/Years', '/api/year').replace('/Makes', '/makes');
        }
        if (path.includes('/Information/Chek-Chart/Years')) {
            return path.replace('/v1/Information/Chek-Chart/Years', '/api/years');
        }
        // Passthrough for /v1/api... -> /api...
        if (path.startsWith('/v1/api')) {
            return path.replace('/v1/api', '/api');
        }
        return path;
    },
    // authMiddleware is now applied before this proxy middleware
    // onProxyReq removed as it's not needed for auth injection anymore
    onProxyRes: (proxyRes, req, res) => {
        // STRICTLY override CORS to hide upstream source
        const requestOrigin = req.headers['origin'];
        if (requestOrigin) {
            proxyRes.headers['access-control-allow-origin'] = requestOrigin;
            proxyRes.headers['access-control-allow-credentials'] = 'true';
        } else {
            proxyRes.headers['access-control-allow-origin'] = '*';
        }

        // STRIP upstream headers that might reveal the source or leak data
        delete proxyRes.headers['set-cookie']; // Frontend doesn't need Motor cookies
        delete proxyRes.headers['server'];     // Hide upstream server info
        delete proxyRes.headers['x-powered-by'];

        // Cache static data for 24 hours
        if (req.path.includes('/years') || req.path.includes('/makes')) {
            proxyRes.headers['cache-control'] = 'public, max-age=86400';
        }

        if (proxyRes.statusCode === 401 || proxyRes.statusCode === 403) {
            logger.warn(`Received ${proxyRes.statusCode} from upstream. Session might be expired.`);
            // In a more advanced implementation, we would trigger re-auth here
            // For now, we rely on the client to retry or the next request to trigger auth
            authManager.lastAuthTime = 0; // Invalidate session so next request re-auths
        }
    },
    onError: (err, req, res) => {
        logger.error('Proxy error:', err);
        if (!res.headersSent) {
            res.status(500).send('Proxy Error');
        }
    }
}));

// Direct /api route for Motor.com API
// All /api/* requests are authenticated and proxied to sites.motor.com/m1/api/*
app.use('/api', authMiddleware, createProxyMiddleware({
    target: config.motorApiBase, // https://sites.motor.com/m1
    changeOrigin: true,
    // No path rewrite needed - /api -> /api on connector
    onProxyReq: (proxyReq, req, res) => {
        try {
            // Get cookies from request headers (set by authMiddleware)
            const cookieHeader = req.headers['cookie'];
            if (cookieHeader) {
                proxyReq.setHeader('Cookie', cookieHeader);
                logger.debug(`Cookie header set for /api: ${cookieHeader.substring(0, 100)}...`);
            } else {
                logger.warn('No cookie header available for /api!');
            }
            
            // Set required headers for connector
            proxyReq.setHeader('Origin', 'https://sites.motor.com');
            proxyReq.setHeader('Referer', 'https://sites.motor.com/m1/');
            proxyReq.setHeader('User-Agent', config.userAgent);
            proxyReq.setHeader('X-Requested-With', 'XMLHttpRequest');
            
            logger.info(`→ ${req.method} ${req.path} → ${config.motorApiBase}${req.path}`);
        } catch (error) {
            logger.error('Error setting proxy request headers for /api:', error);
        }
    },
    onProxyRes: (proxyRes, req, res) => {
        // STRICTLY override CORS to hide upstream source
        const requestOrigin = req.headers['origin'];
        if (requestOrigin) {
            proxyRes.headers['access-control-allow-origin'] = requestOrigin;
            proxyRes.headers['access-control-allow-credentials'] = 'true';
        } else {
            proxyRes.headers['access-control-allow-origin'] = '*';
        }

        // STRIP upstream headers that might reveal the source or leak data
        delete proxyRes.headers['set-cookie']; // Frontend doesn't need Motor cookies
        delete proxyRes.headers['server'];     // Hide upstream server info
        delete proxyRes.headers['x-powered-by'];

        // Cache static data for 24 hours
        if (req.path.includes('/years') || req.path.includes('/makes')) {
            proxyRes.headers['cache-control'] = 'public, max-age=86400';
        }

        if (proxyRes.statusCode === 401 || proxyRes.statusCode === 403) {
            logger.warn(`Received ${proxyRes.statusCode} from Motor.com. Session might be expired.`);
            authManager.lastAuthTime = 0; // Invalidate session so next request re-auths
        }

        logger.info(`← ${proxyRes.statusCode} ${req.path}`);
    },
    onError: (err, req, res) => {
        logger.error('Proxy error for /api route:', err);
        if (!res.headersSent) {
            res.status(500).send('Proxy Error');
        }
    }
}));


// Export as Firebase Function
export const motorApiAuthProxy = onRequest({
    memory: '2GiB',
    timeoutSeconds: 300,
    region: 'us-central1', // Customize if needed
}, app);

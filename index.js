/**
 * Doodstream Telegram Bot & Password-Protected File Portal - Entry Point
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const DoodstreamBot = require('./src/bot');
const createWebhookServer = require('./src/webhook');
const logger = require('./src/logger');

// Portal configuration
const PORTAL_PORT = process.env.PORTAL_PORT || process.env.PORT || 3000;
const PORTAL_PASSWORD = process.env.PORTAL_PASSWORD || process.env.BOT_PASSWORD || '12345';
const DOWNLOAD_DIR = path.resolve(process.env.DOWNLOAD_DIR || './downloads');
const SESSION_SECRET = process.env.PORTAL_SECRET || crypto.createHash('sha256').update((process.env.BOT_TOKEN || 'd-d') + PORTAL_PASSWORD).digest('hex');
const COOKIE_NAME = 'dd_portal_auth';
const VIDEO_EXT_RE = /\.(mp4|mkv|webm|mov|avi)$/i;

if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

function signToken(payload) {
    const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
}

function verifyToken(token) {
    if (!token || !token.includes('.')) return false;
    const idx = token.lastIndexOf('.');
    const payload = token.slice(0, idx);
    const sig = token.slice(idx + 1);
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    try {
        return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch {
        return false;
    }
}

function parseCookies(req) {
    const header = req.headers.cookie || '';
    const cookies = {};
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0) {
            const k = part.slice(0, eq).trim();
            const v = decodeURIComponent(part.slice(eq + 1).trim());
            cookies[k] = v;
        }
    }
    return cookies;
}

function isPortalAuthenticated(req) {
    const cookies = parseCookies(req);
    return verifyToken(cookies[COOKIE_NAME]);
}

function requirePortalAuth(req, res, next) {
    if (!isPortalAuthenticated(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

function resolveSafeMediaPath(filename) {
    const base = path.basename(String(filename || ''));
    if (!base || !VIDEO_EXT_RE.test(base)) return null;
    const full = path.resolve(DOWNLOAD_DIR, base);
    if (!full.startsWith(DOWNLOAD_DIR + path.sep)) return null;
    return full;
}

const portalApp = express();
portalApp.use(express.json());
portalApp.use(express.static(path.join(__dirname, 'public')));

portalApp.get('/api/auth', (req, res) => {
    res.json({ authenticated: isPortalAuthenticated(req) });
});

portalApp.post('/api/login', (req, res) => {
    const password = String(req.body?.password || '');
    if (password !== PORTAL_PASSWORD) {
        return res.status(401).json({ ok: false, error: 'Password salah' });
    }
    const token = signToken(`ok:${Date.now()}`);
    res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000
    });
    res.json({ ok: true });
});

portalApp.post('/api/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME);
    res.json({ ok: true });
});

portalApp.get('/api/files', requirePortalAuth, (req, res) => {
    try {
        const entries = fs.readdirSync(DOWNLOAD_DIR)
            .filter(name => VIDEO_EXT_RE.test(name))
            .map(name => {
                const full = path.join(DOWNLOAD_DIR, name);
                const stat = fs.statSync(full);
                return {
                    name,
                    size: stat.size,
                    mtime: stat.mtimeMs
                };
            })
            .filter(f => f.size > 0)
            .sort((a, b) => b.mtime - a.mtime);

        const totalSize = entries.reduce((sum, f) => sum + f.size, 0);
        res.json({ files: entries, totalSize });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

portalApp.get('/media/:filename', requirePortalAuth, (req, res) => {
    const filePath = resolveSafeMediaPath(req.params.filename);
    if (!filePath || !fs.existsSync(filePath)) {
        return res.status(404).send('Not found');
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = {
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mkv': 'video/x-matroska',
        '.mov': 'video/quicktime',
        '.avi': 'video/x-msvideo'
    };
    const contentType = mimeMap[ext] || 'video/mp4';

    if (req.query.download === '1') {
        res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    }

    const range = req.headers.range;
    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        if (isNaN(start) || start >= fileSize || end >= fileSize) {
            res.status(416).setHeader('Content-Range', `bytes */${fileSize}`);
            return res.end();
        }
        const chunkSize = (end - start) + 1;
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': contentType
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
        res.writeHead(200, {
            'Content-Length': fileSize,
            'Accept-Ranges': 'bytes',
            'Content-Type': contentType
        });
        fs.createReadStream(filePath).pipe(res);
    }
});

portalApp.delete('/api/files/:filename', requirePortalAuth, (req, res) => {
    const filePath = resolveSafeMediaPath(req.params.filename);
    if (!filePath || !fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File tidak ditemukan' });
    }
    try {
        fs.unlinkSync(filePath);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

portalApp.listen(PORTAL_PORT, () => {
    logger.info(`Portal web aktif di port ${PORTAL_PORT}`);
});

// Check for required environment variables
if (!process.env.BOT_TOKEN) {
    logger.error('BOT_TOKEN tidak ditemukan!');
    process.exit(1);
}

// Create and start bot
const bot = new DoodstreamBot(process.env.BOT_TOKEN);

// Global error handlers to prevent crashes
process.on('uncaughtException', (error) => {
    logger.error(`Uncaught Exception: ${error.message}`);
});

process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled Rejection: ${reason}`);
});

bot.start().then(() => {
    logger.success('Bot berhasil dijalankan!');

    // Start webhook server for payments only if CASHI_API_KEY is set
    if (process.env.CASHI_API_KEY) {
        const webhookServer = createWebhookServer(
            bot.paymentHandler,
            bot.quotaManager,
            bot.bot,
            process.env.CASHI_WEBHOOK_SECRET || ''
        );

        const WEBHOOK_PORT = process.env.WEBHOOK_PORT || 3001;
        webhookServer.listen(WEBHOOK_PORT, () => {
            logger.payment(`Webhook server aktif di port ${WEBHOOK_PORT}`);
        });
    } else {
        logger.info('Fitur QRIS dinonaktifkan (CASHI_API_KEY kosong).');
    }
}).catch(error => {
    logger.error(`Gagal menjalankan bot: ${error.message}`);
    process.exit(1);
});

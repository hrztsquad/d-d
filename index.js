/**
 * Doodstream Telegram Bot & Minimalist Portal - Entry Point
 */

require('dotenv').config();
const path = require('path');
const express = require('express');
const DoodstreamBot = require('./src/bot');
const createWebhookServer = require('./src/webhook');
const logger = require('./src/logger');

// Start minimalist portal server (serves public/index.html)
const PORTAL_PORT = process.env.PORTAL_PORT || process.env.PORT || 3000;
const portalApp = express();
portalApp.use(express.static(path.join(__dirname, 'public')));
portalApp.listen(PORTAL_PORT, () => {
    logger.info(`Portal web aktif di port ${PORTAL_PORT}`);
});

// Check for required environment variables
if (!process.env.BOT_TOKEN) {
    logger.error('BOT_TOKEN tidak ditemukan!');
    console.error('');
    console.error('Langkah-langkah:');
    console.error('1. Buat file .env di root folder');
    console.error('2. Tambahkan: BOT_TOKEN=your_telegram_bot_token');
    console.error('3. Dapatkan token dari @BotFather di Telegram');
    console.error('');
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

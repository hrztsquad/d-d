const { Telegraf, Markup } = require('telegraf');
const https = require('https');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Core modules
const DoodstreamExtractor = require('./doodstream');
const YtdlpExtractor = require('./ytdlp');
const HttpRegexExtractor = require('./http-extractor');
const QuotaManager = require('./quota');
const PaymentHandler = require('./payment');
const { isValidDoodstreamUrl, formatFileSize, extractUrls, isRedirectWrapper, followRedirect } = require('./utils');
const messages = require('./messages');
const logger = require('./logger');

// Handler modules
const setupCommandHandlers = require('./handlers/commands');
const setupCallbackHandlers = require('./handlers/callbacks');
const setupMessageHandlers = require('./handlers/messages');

class DoodstreamBot {
    constructor(token) {
        // Configure Telegraf with optional local Bot API server or env proxy agent
        const telegrafOptions = {};

        if (process.env.BOT_API_URL) {
            // Use local Bot API server (supports up to 2GB files)
            telegrafOptions.telegram = {
                apiRoot: process.env.BOT_API_URL // e.g., http://localhost:8081
            };
            console.log('📡 Using Local Bot API Server:', process.env.BOT_API_URL);
        }

        if (process.env.HTTPS_PROXY || process.env.https_proxy) {
            telegrafOptions.telegram = {
                ...(telegrafOptions.telegram || {}),
                agent: https.globalAgent
            };
        }

        this.bot = new Telegraf(token, telegrafOptions);

        // Choose extractor based on environment variable
        // EXTRACTOR_MODE: puppeteer (default), ytdlp, or http
        const extractorMode = process.env.EXTRACTOR_MODE || 'puppeteer';
        if (extractorMode === 'ytdlp') {
            this.extractor = new YtdlpExtractor();
            console.log('🎬 Extractor Mode: yt-dlp (fast)');
        } else if (extractorMode === 'http') {
            this.extractor = new HttpRegexExtractor();
            console.log('🎬 Extractor Mode: HTTP Regex (very fast)');
        } else {
            this.extractor = new DoodstreamExtractor();
            console.log('🎬 Extractor Mode: Puppeteer (browser)');
        }
        this.extractorMode = extractorMode;

        this.quotaManager = new QuotaManager('./data');
        this.isQrisEnabled = Boolean(process.env.CASHI_API_KEY);
        this.paymentHandler = new PaymentHandler(process.env.CASHI_API_KEY || '', './data');

        // Configuration
        this.downloadDir = process.env.DOWNLOAD_DIR || './downloads';
        this.ADMIN_ID = process.env.ADMIN_ID || '';
        this.CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || '@your_channel';
        this.CHANNEL_ID = process.env.CHANNEL_ID || '-1001234567890';
        this.BOT_PASSWORD = process.env.BOT_PASSWORD || '';
        this.COOLDOWN_TIME = 30000; // 30 seconds

        // State management
        this.waitingForUrl = new Map();
        this.userCooldowns = new Map();
        this.adminStates = new Map();
        this.authenticatedUsers = new Set();

        // Queue system
        this.downloadQueue = [];
        this.isProcessing = false;
        this.MAX_CONCURRENT = 1;
        this.activeDownloads = 0;

        // Ensure directories exist
        if (!fs.existsSync(this.downloadDir)) {
            fs.mkdirSync(this.downloadDir, { recursive: true });
        }

        this.setupCommands();
        this.setupHandlers();
    }

    /**
     * Setup bot commands in Telegram menu
     */
    setupCommands() {
        const commands = [
            { command: 'start', description: 'Mulai bot' },
            { command: 'help', description: 'Bantuan penggunaan' },
            { command: 'download', description: 'Download video' },
            { command: 'quota', description: 'Cek saldo quota' },
            { command: 'queue', description: 'Cek antrian download' }
        ];
        if (this.isQrisEnabled) {
            commands.splice(4, 0, { command: 'topup', description: 'Beli quota' });
        }
        this.bot.telegram.setMyCommands(commands);
    }

    /**
     * Check if user is authenticated (when BOT_PASSWORD is set)
     */
    isAuthenticated(userId) {
        if (!this.BOT_PASSWORD) return true;
        if (this.ADMIN_ID && String(userId) === String(this.ADMIN_ID)) return true;
        return this.authenticatedUsers.has(userId);
    }

    /**
     * Setup all handlers (commands, callbacks, messages)
     */
    setupHandlers() {
        // Optional password gate middleware
        this.bot.use(async (ctx, next) => {
            if (!this.BOT_PASSWORD || !ctx.from) return next();
            const userId = ctx.from.id;
            if (this.isAuthenticated(userId)) return next();

            const text = ctx.message && ctx.message.text ? ctx.message.text.trim() : '';
            if (text === this.BOT_PASSWORD) {
                this.authenticatedUsers.add(userId);
                await ctx.reply('✅ Password benar! Ketik /start untuk mulai.');
                return;
            }

            if (ctx.callbackQuery) {
                await ctx.answerCbQuery('Masukkan password terlebih dahulu').catch(() => {});
            }
            await ctx.reply('🔒 Masukkan password untuk membuka bot:');
        });

        setupCommandHandlers(this);
        setupCallbackHandlers(this);
        setupMessageHandlers(this);
    }

    /**
     * Handle video download request
     * @param {Context} ctx 
     * @param {string} url 
     * @param {object} options - { skipCooldown: boolean, skipQuotaCheck: boolean }
     */
    async handleDownload(ctx, url, options = {}) {
        const userId = ctx.from.id;
        const chatId = ctx.chat.id;
        const { skipCooldown = false, skipQuotaCheck = false } = options;

        // Check subscription
        const isSubscribed = await this.checkSubscription(userId);
        if (!isSubscribed) return this.sendSubscribeMessage(ctx);

        // Check quota (skip if already checked in batch)
        if (!skipQuotaCheck) {
            const downloadCost = this.quotaManager.DOWNLOAD_COST;
            if (!this.quotaManager.hasEnoughQuota(userId, downloadCost)) {
                const currentQuota = this.quotaManager.getQuota(userId);
                return ctx.replyWithMarkdown(
                    messages.getQuotaNotEnoughMessage(currentQuota, downloadCost),
                    Markup.inlineKeyboard([[Markup.button.callback('💳 Top Up', 'show_topup')]])
                );
            }
        }

        // Check cooldown (skip for batch downloads)
        if (!skipCooldown) {
            const lastDownload = this.userCooldowns.get(userId);
            if (lastDownload && Date.now() - lastDownload < this.COOLDOWN_TIME) {
                const timeLeft = Math.ceil((this.COOLDOWN_TIME - (Date.now() - lastDownload)) / 1000);
                return ctx.reply(`⏳ Tunggu ${timeLeft} detik sebelum download lagi.`);
            }
            this.userCooldowns.set(userId, Date.now());
        }

        // Validate URL
        if (!isValidDoodstreamUrl(url)) {
            return ctx.reply('❌ URL tidak valid.', Markup.inlineKeyboard([
                [Markup.button.callback('🔗 Support URL', 'platforms')]
            ]));
        }

        // Add to queue
        const queuePos = this.downloadQueue.length + this.activeDownloads + 1;
        const statusMsg = queuePos > 1
            ? await ctx.reply(`📋 Antrian #${queuePos}. Mohon tunggu...`)
            : await ctx.reply('🔍 Mencari video...');

        this.downloadQueue.push({
            userId,
            chatId,
            url,
            statusMsgId: statusMsg.message_id,
            ctx
        });

        this.processQueue();
    }

    /**
     * Process download queue
     */
    async processQueue() {
        if (this.isProcessing || this.downloadQueue.length === 0) return;
        if (this.activeDownloads >= this.MAX_CONCURRENT) return;

        this.isProcessing = true;

        while (this.downloadQueue.length > 0 && this.activeDownloads < this.MAX_CONCURRENT) {
            const item = this.downloadQueue.shift();
            this.activeDownloads++;

            // Update remaining queue positions
            this.updateQueuePositions();

            await this.processDownload(item);
            this.activeDownloads--;
        }

        this.isProcessing = false;
    }

    /**
     * Update queue position messages for waiting users
     */
    async updateQueuePositions() {
        for (let i = 0; i < this.downloadQueue.length; i++) {
            const item = this.downloadQueue[i];
            try {
                await item.ctx.telegram.editMessageText(
                    item.chatId,
                    item.statusMsgId,
                    null,
                    `📋 Antrian #${i + 1 + this.activeDownloads}. Mohon tunggu...`
                );
            } catch (e) {
                // Ignore edit errors
            }
        }
    }

    /**
     * Process a single download from queue
     * @param {Object} item 
     */
    async processDownload(item) {
        const { ctx, url, statusMsgId, chatId, userId } = item;
        let extractionDone = false;

        // Animation
        const animationInterval = setInterval(async () => {
            if (extractionDone) return;
            try {
                await ctx.telegram.editMessageText(chatId, statusMsgId, null, '⏳ Mengekstrak video...');
            } catch (e) { }
        }, 3000);

        try {
            let videoInfo;
            let targetUrl = url;

            // Check if URL is a redirect wrapper (like cdn-vid) - ALWAYS follow redirect
            if (isRedirectWrapper(url)) {
                logger.info(`Redirect wrapper terdeteksi: ${url}`);
                try {
                    targetUrl = await followRedirect(url);
                    logger.info(`Redirected to: ${targetUrl}`);
                } catch (e) {
                    logger.warn(`Redirect failed: ${e.message}`);
                }
            }

            // Check if final URL is a direct video link (exclude hosting pages that end with .mp4 like streamtape)
            const isFakeDirectLink = /cdn-vid|ct\.ws|streamtape|strtape|stape|dood|playmog|filemoon|filelions|vidhide|voe|lulu/i.test(targetUrl);
            const isDirectLink = /\.(mp4|mkv|webm|avi|mov)(\?.*)?$/i.test(targetUrl) && !isFakeDirectLink;

            if (isDirectLink) {
                // Direct link - no extraction needed
                extractionDone = true;
                clearInterval(animationInterval);
                logger.info(`Direct link: ${targetUrl}`);

                // Extract filename from URL
                const urlPath = new URL(targetUrl).pathname;
                const fileName = decodeURIComponent(urlPath.split('/').pop().replace(/\.(mp4|mkv|webm|avi|mov)$/i, ''));

                videoInfo = {
                    title: fileName || 'Direct Video',
                    videoUrl: targetUrl
                };
            } else {
                // Extract video info from embed page (30s max)
                videoInfo = await Promise.race([
                    this.extractor.extractVideoInfo(targetUrl),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Extraction timeout')), 30000)
                    )
                ]);

                extractionDone = true;
                clearInterval(animationInterval);
            }

            await ctx.telegram.editMessageText(chatId, statusMsgId, null, '📥 Mengunduh video...');

            // Download and send
            const referer = new URL(url).origin + '/';
            const filePath = path.join(this.downloadDir, `${Date.now()}_video.mp4`);

            try {
                logger.download(`Memulai unduh: ${videoInfo.title || 'Video'}`);

                const response = await axios({
                    method: 'get',
                    url: videoInfo.videoUrl,
                    responseType: 'stream',
                    timeout: 180000, // 3 minutes timeout
                    headers: {
                        'Referer': referer,
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                });

                const contentType = (response.headers['content-type'] || '').toLowerCase();
                if (contentType.includes('text/html') || contentType.includes('application/json')) {
                    response.data.destroy();
                    throw new Error(`Invalid video response (${contentType})`);
                }

                const totalSize = parseInt(response.headers['content-length']) || 0;
                let downloadedSize = 0;
                let lastProgress = 0;

                const writer = fs.createWriteStream(filePath);

                // Progress logging
                response.data.on('data', (chunk) => {
                    downloadedSize += chunk.length;
                    const progress = totalSize > 0 ? Math.floor((downloadedSize / totalSize) * 100) : 0;
                    if (progress >= lastProgress + 20) { // Log every 20%
                        logger.info(`Download progress: ${progress}% (${formatFileSize(downloadedSize)}/${formatFileSize(totalSize)})`);
                        lastProgress = progress;
                    }
                });

                response.data.pipe(writer);
                await new Promise((resolve, reject) => {
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                    // Timeout for stuck downloads
                    setTimeout(() => reject(new Error('Download stuck timeout')), 180000);
                });

                const actualSize = fs.statSync(filePath).size;
                if (actualSize < 10240) {
                    throw new Error(`File video kosong atau rusak (${actualSize} bytes)`);
                }
                logger.download(`Unduhan selesai (${formatFileSize(actualSize)}), mengunggah ke Telegram...`);

                // Always try to upload to Telegram
                await ctx.telegram.editMessageText(chatId, statusMsgId, null, `📤 Mengunggah ke Telegram... (${formatFileSize(actualSize)})`);

                try {
                    const uploadStart = Date.now();
                    logger.info(`Memulai upload: ${formatFileSize(actualSize)}...`);

                    // Upload with timeout (5 minutes for large files)
                    await Promise.race([
                        ctx.replyWithVideo(
                            { source: filePath },
                            {
                                caption: `🎬 *${videoInfo.title || 'Video'}*\n📁 ${formatFileSize(actualSize)}`,
                                parse_mode: 'Markdown'
                            }
                        ),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('Upload timeout')), 300000)
                        )
                    ]);

                    const uploadTime = ((Date.now() - uploadStart) / 1000).toFixed(1);
                    logger.success(`Upload selesai dalam ${uploadTime}s`);

                    // Deduct quota ONLY after successful send
                    this.quotaManager.deductQuota(userId);
                    const newQuota = this.quotaManager.getQuota(userId);

                    await ctx.telegram.deleteMessage(chatId, statusMsgId).catch(() => { });
                    const quotaDisplay = this.quotaManager.UNLIMITED_QUOTA ? '∞ (Unlimited)' : newQuota;
                    await ctx.reply(`💰 Sisa quota: *${quotaDisplay}*`, { parse_mode: 'Markdown' });
                    logger.success(`Video berhasil dikirim ke user ${userId}`);
                } catch (uploadError) {
                    logger.warn(`Upload gagal, memberikan link: ${uploadError.message}`);

                    // Deduct quota even if upload fails but link is provided
                    this.quotaManager.deductQuota(userId);
                    const newQuota = this.quotaManager.getQuota(userId);

                    await ctx.telegram.editMessageText(
                        chatId,
                        statusMsgId,
                        null,
                        `✅ *Video Siap!*\n\n📁 Size: ${formatFileSize(actualSize)}\n💰 Sisa quota: ${newQuota}\n\n⚠️ File terlalu besar untuk Telegram.\n\n⬇️ Link:\n\`${videoInfo.videoUrl}\``,
                        { parse_mode: 'Markdown', disable_web_page_preview: true }
                    );
                    await ctx.reply('📥 Download:', Markup.inlineKeyboard([
                        Markup.button.url('⬇️ Download', videoInfo.videoUrl)
                    ]));
                }

                fs.unlinkSync(filePath);
            } catch (downloadError) {
                console.error('[Bot] Download error:', downloadError.message);
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

                // Deduct quota even if download fails but link is provided
                this.quotaManager.deductQuota(userId);
                const newQuota = this.quotaManager.getQuota(userId);

                await ctx.telegram.editMessageText(
                    chatId,
                    statusMsgId,
                    null,
                    `✅ Link ditemukan!\n\n💰 Sisa quota: ${newQuota}\n\n⬇️ Download:\n\`${videoInfo.videoUrl}\``,
                    { parse_mode: 'Markdown', disable_web_page_preview: true }
                );
                await ctx.reply('📥 Download:', Markup.inlineKeyboard([
                    Markup.button.url('⬇️ Download', videoInfo.videoUrl)
                ]));
            }
        } catch (error) {
            extractionDone = true;
            clearInterval(animationInterval);
            console.error('Download error:', error.message);

            await ctx.telegram.editMessageText(
                chatId,
                statusMsgId,
                null,
                '❌ Gagal mengekstrak video. Video mungkin tidak tersedia.',
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Coba Lagi', 'download')],
                    [Markup.button.callback('🔙 Menu', 'back_to_start')]
                ])
            );
        }
    }

    /**
     * Get queue status
     */
    getQueueStatus() {
        return {
            queueLength: this.downloadQueue.length,
            activeDownloads: this.activeDownloads,
            isProcessing: this.isProcessing
        };
    }

    /**
     * Handle batch download - downloads all files first, then sends all
     * @param {Context} ctx 
     * @param {string[]} urls 
     */
    async handleBatchDownload(ctx, urls) {
        const userId = ctx.from.id;
        const chatId = ctx.chat.id;
        const totalUrls = urls.length;
        const totalCost = totalUrls * this.quotaManager.DOWNLOAD_COST;

        // Verify quota
        if (!this.quotaManager.hasEnoughQuota(userId, totalCost)) {
            return ctx.reply('❌ Quota tidak cukup untuk batch ini.');
        }

        logger.info(`Batch download dimulai: ${totalUrls} video untuk user ${userId}`);

        // Status message
        const statusMsg = await ctx.reply(
            `📦 *Batch Download Started*\n\n` +
            `🔗 Total: ${totalUrls} video\n` +
            `⏳ Mengekstrak link... (0/${totalUrls})`,
            { parse_mode: 'Markdown' }
        );
        const statusMsgId = statusMsg.message_id;

        // Spinner animation for status updates
        const spinnerFrames = ['', '.', '..', '...'];
        let spinnerIndex = 0;
        let spinnerTimer = null;
        let lastStatusBuilder = null;

        const editStatus = async (builder) => {
            lastStatusBuilder = builder;
            const text = builder(spinnerFrames[spinnerIndex]);
            await ctx.telegram.editMessageText(
                chatId, statusMsgId, null, text,
                { parse_mode: 'Markdown' }
            ).catch(() => { });
        };

        const startSpinner = () => {
            spinnerTimer = setInterval(() => {
                if (!lastStatusBuilder) return;
                spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
                const text = lastStatusBuilder(spinnerFrames[spinnerIndex]);
                ctx.telegram.editMessageText(
                    chatId, statusMsgId, null, text,
                    { parse_mode: 'Markdown' }
                ).catch(() => { });
            }, 5000);
        };

        const stopSpinner = () => {
            if (spinnerTimer) {
                clearInterval(spinnerTimer);
                spinnerTimer = null;
            }
        };

        await editStatus((spin) =>
            `📦 *Batch Download Started*\n\n` +
            `🔗 Total: ${totalUrls} video\n` +
            `⏳ Mengekstrak link${spin} (0/${totalUrls})`
        );
        startSpinner();

        const downloadedFiles = [];
        const failedUrls = [];
        // Puppeteer doesn't work well with high parallelism - limit to 2
        // Limit to 1 to prevent network saturation and bot unresponsiveness
        const PARALLEL_LIMIT = 1;

        // Helper function to process single video
        const processVideo = async (url, index) => {
            logger.extract(`Memproses video ${index + 1}/${totalUrls}: ${url}`);

            let videoInfo;
            let targetUrl = url;

            // Check if URL is a redirect wrapper
            if (isRedirectWrapper(url)) {
                logger.info(`Redirect wrapper: ${url}`);
                try {
                    targetUrl = await followRedirect(url);
                    logger.info(`Redirected to: ${targetUrl}`);
                } catch (e) {
                    logger.warn(`Redirect failed: ${e.message}`);
                }
            }

            // Check if direct link (exclude hosting pages that end with .mp4 like streamtape)
            const isFakeDirectLink = /cdn-vid|ct\.ws|streamtape|strtape|stape|dood|playmog|filemoon|filelions|vidhide|voe|lulu/i.test(targetUrl);
            const isDirectLink = /\.(mp4|mkv|webm|avi|mov)(\?.*)?$/i.test(targetUrl) && !isFakeDirectLink;

            if (isDirectLink) {
                logger.info(`Direct link: ${targetUrl}`);
                const urlPath = new URL(targetUrl).pathname;
                const fileName = decodeURIComponent(urlPath.split('/').pop().replace(/\.(mp4|mkv|webm|avi|mov)$/i, ''));
                videoInfo = { title: fileName || `Video ${index + 1}`, videoUrl: targetUrl };
            } else {
                // Extract with timeout (30s max)
                videoInfo = await Promise.race([
                    this.extractor.extractVideoInfo(targetUrl),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 30000))
                ]);
            }

            if (!videoInfo || !videoInfo.videoUrl) {
                throw new Error('Tidak dapat extract');
            }

            logger.extract(`Link ditemukan: ${videoInfo.title || 'Video'}`);

            // Download file
            const referer = new URL(url).origin + '/';
            const filePath = path.join(this.downloadDir, `batch_${Date.now()}_${index}.mp4`);

            const response = await axios({
                method: 'get',
                url: videoInfo.videoUrl,
                responseType: 'stream',
                timeout: 300000,
                headers: { 'Referer': referer }
            });

            const writer = fs.createWriteStream(filePath);
            response.data.pipe(writer);
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            const fileSize = fs.statSync(filePath).size;
            logger.download(`Unduhan selesai: ${videoInfo.title} (${formatFileSize(fileSize)})`);

            return {
                path: filePath,
                title: videoInfo.title || `Video ${index + 1}`,
                size: fileSize,
                url: videoInfo.videoUrl
            };
        };

        // Phase 1: Process videos in parallel batches with retry logic
        const MAX_RETRIES = 3;
        let pendingUrls = urls.map((url, index) => ({ url, index, retries: 0 }));

        try {
            while (pendingUrls.length > 0) {
                // Take a batch from pending
                const batch = pendingUrls.splice(0, PARALLEL_LIMIT);

                // Update status
                const retrying = batch.some(b => b.retries > 0);
                await editStatus((spin) =>
                    `📦 *Batch Download*\n\n` +
                    `⏳ ${retrying ? '🔄 Retry: ' : 'Memproses: '}${batch.length} video${spin}\n` +
                    `✅ Berhasil: ${downloadedFiles.length}\n` +
                    `❌ Gagal: ${failedUrls.length}\n` +
                    `📋 Sisa: ${pendingUrls.length}`
                );

                // Process batch in parallel
                const results = await Promise.allSettled(
                    batch.map(item => processVideo(item.url, item.index))
                );

                // Collect results and queue retries
                for (let i = 0; i < results.length; i++) {
                    const result = results[i];
                    const item = batch[i];

                    if (result.status === 'fulfilled') {
                        downloadedFiles.push(result.value);
                        logger.success(`Berhasil: ${item.url}`);
                    } else {
                        // Check if should retry
                        if (item.retries < MAX_RETRIES) {
                            item.retries++;
                            logger.warn(`Retry ${item.retries}/${MAX_RETRIES}: ${item.url}`);
                            pendingUrls.push(item); // Add back to queue for retry
                        } else {
                            // Max retries reached, mark as failed
                            logger.error(`Gagal setelah ${MAX_RETRIES}x retry: ${item.url}`);
                            failedUrls.push({ url: item.url, reason: result.reason.message });
                        }
                    }
                }

                // Small delay between batches to let resources recover
                if (pendingUrls.length > 0) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            }

            // Update status before sending
            await editStatus((spin) =>
                `📦 *Batch Download*\n\n` +
                `✅ Downloaded: ${downloadedFiles.length}/${totalUrls}\n` +
                `📤 Mengirim ke Telegram${spin}`
            );

            // Phase 2: Send all downloaded files to Telegram
            let sentCount = 0;
            for (const file of downloadedFiles) {
                try {
                    logger.info(`Mengirim ke Telegram: ${file.title} (${formatFileSize(file.size)})`);

                    // Try sending with timeout (5 minutes for large files)
                    let sendSuccess = false;
                    for (let attempt = 1; attempt <= 2 && !sendSuccess; attempt++) {
                        try {
                            await Promise.race([
                                ctx.replyWithVideo(
                                    { source: file.path },
                                    {
                                        caption: `🎬 *${file.title}*\n📁 ${formatFileSize(file.size)}`,
                                        parse_mode: 'Markdown'
                                    }
                                ),
                                new Promise((_, reject) =>
                                    setTimeout(() => reject(new Error('Upload timeout')), 300000)
                                )
                            ]);
                            sentCount++;
                            sendSuccess = true;
                            logger.success(`Berhasil dikirim: ${file.title}`);
                        } catch (uploadErr) {
                            if (attempt < 2) {
                                logger.warn(`Upload gagal (attempt ${attempt}), retrying: ${uploadErr.message}`);
                                await new Promise(r => setTimeout(r, 2000));
                            } else {
                                throw uploadErr;
                            }
                        }
                    }

                } catch (sendError) {
                    logger.warn(`Gagal kirim ${file.title}, memberikan link: ${sendError.message}`);
                    try {
                        await ctx.reply(
                            `📥 *${file.title}*\n📁 ${formatFileSize(file.size)}\n\n⬇️ Download: ${file.url}`,
                            { parse_mode: 'Markdown', disable_web_page_preview: true }
                        );
                        sentCount++;
                    } catch (linkError) {
                        logger.error(`Gagal kirim link juga: ${linkError.message}`);
                    }
                }

                // Cleanup file
                try {
                    if (fs.existsSync(file.path)) {
                        fs.unlinkSync(file.path);
                    }
                } catch (e) {
                    // Ignore cleanup errors
                }
            }

            // Deduct quota for successful downloads only
            const quotaToDeduct = sentCount * this.quotaManager.DOWNLOAD_COST;
            const quotaSaved = failedUrls.length * this.quotaManager.DOWNLOAD_COST;

            if (quotaToDeduct > 0) {
                for (let i = 0; i < sentCount; i++) {
                    this.quotaManager.deductQuota(userId);
                }
            }
            const newQuota = this.quotaManager.getQuota(userId);

            // Final status
            let summaryMessage = `📦 *Batch Download Selesai!*\n\n` +
                `✅ Berhasil: ${sentCount}/${totalUrls}\n` +
                `❌ Gagal: ${failedUrls.length}\n` +
                `💰 Quota terpakai: ${quotaToDeduct}\n`;

            if (quotaSaved > 0) {
                summaryMessage += `🔄 Quota tidak dikurangi (gagal): ${quotaSaved}\n`;
            }
            summaryMessage += `📊 Sisa quota: ${newQuota}`;

            stopSpinner();
            await ctx.telegram.editMessageText(
                chatId, statusMsgId, null,
                summaryMessage,
                { parse_mode: 'Markdown' }
            ).catch(() => { });

            logger.success(`Batch selesai: ${sentCount}/${totalUrls} video dikirim ke user ${userId}`);

            // Report failed URLs if any
            if (failedUrls.length > 0) {
                const failedList = failedUrls.map((f, i) => `${i + 1}. ${f.url}`).join('\n');
                await ctx.reply(`❌ *Video gagal diproses:*\n\n${failedList}`, { parse_mode: 'Markdown' });
            }
        } finally {
            stopSpinner();
        }
    }

    /**
     * Check if user is subscribed to required channel
     */
    async checkSubscription(userId) {
        if (!this.CHANNEL_ID || this.CHANNEL_ID === '-1001234567890') {
            return true;
        }

        try {
            const member = await this.bot.telegram.getChatMember(this.CHANNEL_ID, userId);
            return ['creator', 'administrator', 'member'].includes(member.status);
        } catch (error) {
            console.log(`[Subscribe Check] Error:`, error.message);
            if (error.message.includes('inaccessible') || error.message.includes('not found')) {
                return true;
            }
            return false;
        }
    }

    /**
     * Send subscription required message
     */
    async sendSubscribeMessage(ctx) {
        await ctx.replyWithMarkdown(
            messages.getSubscribeMessage(this.CHANNEL_USERNAME),
            Markup.inlineKeyboard([
                [Markup.button.url('📢 Join Channel', `https://t.me/${this.CHANNEL_USERNAME.replace('@', '')}`)],
                [Markup.button.callback('✅ Sudah Join', 'check_subscription')]
            ])
        );
    }

    /**
     * Send help message
     */
    async sendHelpMessage(ctx) {
        const kb = Markup.inlineKeyboard([
            [Markup.button.callback('🔗 Support URL', 'platforms')],
            [Markup.button.callback('🔙 Kembali', 'back_to_start')]
        ]);

        if (ctx.callbackQuery) {
            await ctx.editMessageText(messages.getHelpMessage(), { parse_mode: 'Markdown', ...kb });
        } else {
            await ctx.replyWithMarkdown(messages.getHelpMessage(), kb);
        }
    }

    /**
     * Send platforms message
     */
    async sendPlatformsMessage(ctx) {
        const kb = Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Kembali', 'back_to_start')]
        ]);

        if (ctx.callbackQuery) {
            await ctx.editMessageText(messages.getPlatformsMessage(), { parse_mode: 'Markdown', ...kb });
        } else {
            await ctx.replyWithMarkdown(messages.getPlatformsMessage(), kb);
        }
    }

    /**
     * Send top up message with package buttons
     */
    async sendTopUpMessage(ctx) {
        if (!this.isQrisEnabled) {
            const kb = Markup.inlineKeyboard([
                [Markup.button.callback('🔙 Kembali', 'back_to_start')]
            ]);
            const disabledMsg = '⚠️ Fitur Top Up QRIS sedang dinonaktifkan.';
            if (ctx.callbackQuery) {
                return ctx.editMessageText(disabledMsg, kb);
            }
            return ctx.reply(disabledMsg, kb);
        }

        const packages = this.paymentHandler.getPackages();
        const buttons = packages.map(pkg =>
            [Markup.button.callback(`💳 ${pkg.label} - Rp ${pkg.price.toLocaleString('id-ID')}`, `buy_${pkg.id}`)]
        );
        buttons.push([Markup.button.callback('🔙 Kembali', 'back_to_start')]);

        const message = `
💳 *Top Up Quota via QRIS*

Pilih paket yang diinginkan:

📱 *Pembayaran Otomatis*
• Scan QRIS dengan e-wallet/m-banking
• Quota langsung masuk setelah bayar
• Support: GoPay, OVO, DANA, ShopeePay, dll

⚡ *1 download = 15 quota*
        `;

        const kb = Markup.inlineKeyboard(buttons);

        if (ctx.callbackQuery) {
            await ctx.editMessageText(message, { parse_mode: 'Markdown', ...kb });
        } else {
            await ctx.replyWithMarkdown(message, kb);
        }
    }

    /**
     * Start the bot
     */
    async start() {
        console.log('🤖 Starting Doodstream Bot...');
        await this.extractor.init();
        this.bot.launch();
        console.log('✅ Bot is running!');

        process.once('SIGINT', () => this.stop('SIGINT'));
        process.once('SIGTERM', () => this.stop('SIGTERM'));
    }

    /**
     * Stop the bot gracefully
     */
    async stop(signal) {
        console.log(`\n🛑 Received ${signal}, shutting down...`);
        await this.extractor.close();
        this.bot.stop(signal);
        console.log('👋 Bot stopped gracefully');
        process.exit(0);
    }
}

module.exports = DoodstreamBot;

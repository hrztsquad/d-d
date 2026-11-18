const { Markup } = require('telegraf');

/**
 * Setup command handlers
 * @param {DoodstreamBot} bot 
 */
function setupCommandHandlers(bot) {
    // /start
    bot.bot.command('start', async (ctx) => {
        const userId = ctx.from.id;
        const isSubscribed = await bot.checkSubscription(userId);
        if (!isSubscribed) return bot.sendSubscribeMessage(ctx);

        const quota = bot.quotaManager.getQuota(userId);
        const { canClaim } = bot.quotaManager.canClaimDailyBonus(userId);
        const bonusText = canClaim ? '🎁 Bonus Harian' : '⏰ Bonus (Claimed)';

        const quotaRow = [Markup.button.callback('💰 Cek Quota', 'show_quota')];
        if (bot.isQrisEnabled) {
            quotaRow.push(Markup.button.callback('💳 Top Up', 'show_topup'));
        }

        const buttons = [
            [Markup.button.callback('📥 Download Video', 'download')],
            quotaRow,
            [Markup.button.callback(bonusText, 'claim_bonus')],
            [Markup.button.callback('📖 Bantuan', 'help'), Markup.button.callback('🔗 Support URL', 'platforms')]
        ];

        if (String(userId) === String(bot.ADMIN_ID)) {
            buttons.push([Markup.button.callback('🛠 Admin Panel', 'admin_panel')]);
        }

        const quotaDisplay = bot.quotaManager.UNLIMITED_QUOTA ? '∞ (Unlimited)' : quota;
        await ctx.replyWithMarkdown(
            `🎬 *Selamat datang di Video Downloader Bot!*\n\n💰 Quota Anda: *${quotaDisplay}*\n\nKirim link video untuk download!`,
            Markup.inlineKeyboard(buttons)
        );
    });

    // /help
    bot.bot.command('help', async (ctx) => {
        await bot.sendHelpMessage(ctx);
    });

    // /quota
    bot.bot.command('quota', async (ctx) => {
        const userId = ctx.from.id;
        const quota = bot.quotaManager.getQuota(userId);
        const user = bot.quotaManager.getUser(userId);
        const possibleDownloads = Math.floor(quota / bot.quotaManager.DOWNLOAD_COST);

        const quotaButtons = [];
        if (bot.isQrisEnabled) {
            quotaButtons.push([Markup.button.callback('💳 Top Up', 'show_topup')]);
        }
        quotaButtons.push([Markup.button.callback('📜 Riwayat', 'show_history')]);

        await ctx.replyWithMarkdown(
            `💰 *Saldo Quota*\n\n📊 Quota: *${quota}*\n🎬 Bisa download: *${possibleDownloads} video*\n📈 Total download: *${user.totalDownloads}x*`,
            Markup.inlineKeyboard(quotaButtons)
        );
    });

    // /topup
    bot.bot.command('topup', async (ctx) => {
        await bot.sendTopUpMessage(ctx);
    });

    // /queue
    bot.bot.command('queue', async (ctx) => {
        const status = bot.getQueueStatus();
        await ctx.replyWithMarkdown(
            `📋 *Status Antrian*\n\n🔄 Diproses: ${status.activeDownloads}\n📝 Antrian: ${status.queueLength}`
        );
    });

    // /download
    bot.bot.command('download', async (ctx) => {
        const url = ctx.message.text.split(' ')[1];
        if (!url) return ctx.reply('Format: /download <url>');
        await bot.handleDownload(ctx, url);
    });

    // /addquota (admin only)
    bot.bot.command('addquota', async (ctx) => {
        if (String(ctx.from.id) !== String(bot.ADMIN_ID)) {
            return ctx.reply('❌ Hanya admin yang bisa menggunakan command ini.');
        }

        const args = ctx.message.text.split(' ').slice(1);
        if (args.length < 2) {
            return ctx.reply('Format: /addquota <user_id> <amount>');
        }

        const [targetId, amount] = [args[0], parseInt(args[1])];
        if (isNaN(amount) || amount <= 0) {
            return ctx.reply('❌ Jumlah quota harus angka positif.');
        }

        bot.quotaManager.addQuota(targetId, amount, `Admin top up (+${amount} quota)`);
        const newBalance = bot.quotaManager.getQuota(targetId);

        await ctx.reply(`✅ Berhasil menambah ${amount} quota ke user ${targetId}.\n💰 Saldo baru: ${newBalance} quota`);

        // Notify user
        try {
            await ctx.telegram.sendMessage(
                targetId,
                `🎉 *Quota Ditambahkan!*\n\n💰 +${amount} quota\n📊 Saldo baru: ${newBalance} quota\n\n_Terima kasih telah top up!_`,
                { parse_mode: 'Markdown' }
            );
        } catch (e) {
            // User may have blocked the bot
        }
    });

    // /bonus - Daily bonus
    bot.bot.command('bonus', async (ctx) => {
        const userId = ctx.from.id;
        const result = bot.quotaManager.claimDailyBonus(userId);

        if (result.success) {
            await ctx.replyWithMarkdown(
                `🎁 *Daily Bonus Claimed!*\n\n` +
                `✅ +${result.quota} quota\n` +
                `💰 Saldo baru: *${result.newBalance} quota*\n\n` +
                `_Kembali besok untuk bonus lagi!_`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('📥 Download Video', 'download')],
                    [Markup.button.callback('🔙 Menu', 'back_to_start')]
                ])
            );
        } else {
            const { nextClaimIn } = bot.quotaManager.canClaimDailyBonus(userId);
            await ctx.replyWithMarkdown(
                `⏰ *Sudah Diklaim!*\n\n` +
                `Anda sudah mengambil bonus hari ini.\n` +
                `🕐 Kembali dalam: *${nextClaimIn} jam*\n\n` +
                `_Bonus reset setiap hari pukul 00:00_`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔙 Menu', 'back_to_start')]
                ])
            );
        }
    });

    // /admin - Admin dashboard (admin only)
    bot.bot.command('admin', async (ctx) => {
        if (String(ctx.from.id) !== String(bot.ADMIN_ID)) {
            return ctx.reply('❌ Akses ditolak.');
        }

        const stats = bot.quotaManager.getStats();
        const queueStatus = bot.getQueueStatus();

        await ctx.replyWithMarkdown(
            `📊 *Admin Dashboard*\n\n` +
            `👥 *Users:*\n` +
            `• Total: ${stats.totalUsers}\n` +
            `• Aktif hari ini: ${stats.activeToday}\n\n` +
            `📈 *Statistics:*\n` +
            `• Total downloads: ${stats.totalDownloads}\n` +
            `• Quota issued: ${stats.totalQuotaIssued}\n\n` +
            `📋 *Queue:*\n` +
            `• Active: ${queueStatus.activeDownloads}\n` +
            `• Waiting: ${queueStatus.queueLength}\n\n` +
            `_Last updated: ${new Date().toLocaleString('id-ID')}_`,
            Markup.inlineKeyboard([
                [Markup.button.callback('📢 Broadcast', 'admin_broadcast')],
                [Markup.button.callback('🔄 Refresh', 'admin_refresh')]
            ])
        );
    });

    // /broadcast - Send message to all users (admin only)
    bot.bot.command('broadcast', async (ctx) => {
        if (String(ctx.from.id) !== String(bot.ADMIN_ID)) {
            return ctx.reply('❌ Akses ditolak.');
        }

        const message = ctx.message.text.replace('/broadcast ', '').trim();
        if (!message || message === '/broadcast') {
            return ctx.reply('Format: /broadcast <pesan>\n\nContoh:\n/broadcast 🎉 Promo! Diskon 50% hari ini!');
        }

        const users = Object.keys(bot.quotaManager.quotaData);
        let sent = 0, failed = 0;

        await ctx.reply(`📢 Mengirim broadcast ke ${users.length} users...`);

        for (const userId of users) {
            try {
                await ctx.telegram.sendMessage(userId, `📢 *Broadcast*\n\n${message}`, { parse_mode: 'Markdown' });
                sent++;
            } catch (e) {
                failed++;
            }
            // Delay to avoid rate limiting
            await new Promise(r => setTimeout(r, 50));
        }

        await ctx.reply(`✅ Broadcast selesai!\n\n📤 Terkirim: ${sent}\n❌ Gagal: ${failed}`);
    });

    // /stats - Quick stats (admin only)
    bot.bot.command('stats', async (ctx) => {
        if (String(ctx.from.id) !== String(bot.ADMIN_ID)) {
            return ctx.reply('❌ Akses ditolak.');
        }

        const stats = bot.quotaManager.getStats();
        await ctx.replyWithMarkdown(
            `📊 *Quick Stats*\n\n` +
            `👥 Users: ${stats.totalUsers}\n` +
            `📥 Downloads: ${stats.totalDownloads}\n` +
            `💰 Quota issued: ${stats.totalQuotaIssued}\n` +
            `🟢 Active today: ${stats.activeToday}`
        );
    });
}

module.exports = setupCommandHandlers;

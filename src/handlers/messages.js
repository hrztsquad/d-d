const { Markup } = require('telegraf');

/**
 * Setup text message handler
 * @param {DoodstreamBot} bot 
 */
function setupMessageHandlers(bot) {
    const { isValidDoodstreamUrl, extractUrls } = require('../utils');

    bot.bot.on('text', async (ctx) => {
        const text = ctx.message.text;

        // Ignore commands
        if (text.startsWith('/')) return;

        // Check for Admin State (Add Quota)
        if (bot.adminStates && bot.adminStates.has(ctx.from.id)) {
            const state = bot.adminStates.get(ctx.from.id);

            if (state === 'add_quota') {
                const args = text.split(' ');
                if (args.length < 2) {
                    return ctx.reply('❌ Format salah. Gunakan:\n`<user_id> <amount>`\n\nContoh: `123456789 100`', { parse_mode: 'Markdown' });
                }

                const targetId = args[0];
                const amount = parseInt(args[1]);

                if (isNaN(amount) || amount <= 0) {
                    return ctx.reply('❌ Jumlah quota harus angka positif valid.');
                }

                bot.quotaManager.addQuota(targetId, amount, `Admin top up (+${amount} quota)`);
                const newBalance = bot.quotaManager.getQuota(targetId);

                // Clear state
                bot.adminStates.delete(ctx.from.id);

                await ctx.reply(`✅ Berhasil menambah ${amount} quota ke user ${targetId}.\n💰 Saldo baru: ${newBalance} quota`,
                    Markup.inlineKeyboard([[Markup.button.callback('🔙 Admin Panel', 'admin_panel')]])
                );

                // Notify target user
                try {
                    await ctx.telegram.sendMessage(
                        targetId,
                        `🎉 *Quota Ditambahkan!*\n\n💰 +${amount} quota\n📊 Saldo baru: ${newBalance} quota\n\n_Terima kasih telah top up!_`,
                        { parse_mode: 'Markdown' }
                    );
                } catch (e) { }

                return;
            }
        }

        // Clear waiting state
        bot.waitingForUrl.delete(ctx.from.id);

        // Extract URLs from message
        const allUrls = extractUrls(text);
        const validUrls = allUrls.filter(url => isValidDoodstreamUrl(url));

        if (allUrls.length === 0) {
            return ctx.reply('🔗 Kirim link video untuk mendownload.', Markup.inlineKeyboard([
                [Markup.button.callback('🔗 Support URL', 'platforms')]
            ]));
        }

        if (validUrls.length === 0) {
            return ctx.reply('❌ URL tidak didukung. Kirim link dari platform yang didukung.', Markup.inlineKeyboard([
                [Markup.button.callback('🔗 Support URL', 'platforms')]
            ]));
        }

        // Single URL - process immediately
        if (validUrls.length === 1) {
            await bot.handleDownload(ctx, validUrls[0]);
            return;
        }

        // Multiple URLs - Batch Download immediately without confirmation
        const isSubscribed = await bot.checkSubscription(ctx.from.id);
        if (!isSubscribed) return bot.sendSubscribeMessage(ctx);

        await bot.handleBatchDownload(ctx, validUrls);
    });
}

module.exports = setupMessageHandlers;

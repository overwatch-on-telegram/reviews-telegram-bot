import { config } from 'dotenv';
config();

import { EventEmitter } from 'events';

import TelegramBot from 'node-telegram-bot-api';
import { WAITING_GENERATION_AUDIT_MESSAGE, fetchTokenStatistics, fetchAuditData, formatTokenStatistics, waitForAuditEndOrError, triggerAudit, escapeMarkdownV2 } from '@overwatch-on-telegram/core-ai-analyzer';

import newPairEmitter from 'listingspyscraper';

import EasyJsonDatabase from 'easy-json-database';
const retryDb = new EasyJsonDatabase('retry_'+process.env.DATABASE_PATH);
const processedDb = new EasyJsonDatabase('processed_'+process.env.DATABASE_PATH);

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
    polling: true
});


async function handlePair (res) {

    console.log(res);

    const main = res.token0.symbol === 'WETH' ? res.token1 : res.token0;
    const pair = res.token0.symbol === 'WETH' ? res.token0 : res.token1;

    if (!pair || !main) return;

    const name = main.name;
    const symbol = main.symbol;
    const contractAddress = main.id;

    const pairName = pair.name;
    const pairSymbol = pair.symbol;
    const pairContractAddress = pair.id;

    const tokenData = {
        name,
        symbol,
        contractAddress,
        pairName,
        pairSymbol,
        pairContractAddress
    }

    if ((processedDb.get('tokens') || []).includes(tokenData.contractAddress)) {
        console.log(`🤖 ${symbol} (${contractAddress}) is already processed!`);
        return;
    };

    console.log(`🤖 Queueing checking ${symbol} (${contractAddress})...`);

    fetchTokenStatistics(tokenData.contractAddress).catch(() => {});

    processedDb.push('tokens', tokenData.contractAddress);
    setTimeout(() => {
        // i want to add the contract address to a list in the database without its data (light db)
        checkSendToken(tokenData, true);
    }, 10_000);

};

newPairEmitter.on('newPair', handlePair);


const checkSendToken = async (tokenData, firstTry) => {

    console.log(`🤖 Checking ${tokenData.name} (${tokenData.contractAddress})...`);

    const contractAddress = tokenData.contractAddress;

    const tokenStatistics = await fetchTokenStatistics(tokenData.contractAddress, tokenData.pairContractAddress)
        .catch((e) => {
            console.log(`🤖 ${tokenData.name} (${tokenData.symbol}) statistics error!`, e);
        });

    if (!tokenStatistics) return;

    if (tokenStatistics.isValidated || (tokenStatistics.isPartiallyValidated && firstTry)) {

        if (tokenStatistics.isPartiallyValidated && firstTry) {
            retryDb.push('tokens', {
                ...tokenData,
                addedAt: Date.now()
            });
        }

        let previousMessageId = null;
        
        if (tokenStatistics.isValidated && !firstTry) {
            const tokenData = await db.getData(`/tokens/${tokenStatistics.contractAddress}`);
            if (tokenStatistics.isLocked) {
                bot.sendMessage(process.env.TELEGRAM_CHAT_ID, `*[Liquidity is now Locked 🔒](${tokenStatistics.secondTokenAuditData?.lpLockLink})*`, {
                    reply_to_message_id: tokenData.messageId,
                    parse_mode: 'MarkdownV2',
                    disable_web_page_preview: true
                });
            } else {
                bot.sendMessage(process.env.TELEGRAM_CHAT_ID, `*[Liquidity is now Burnt 🔥](${tokenStatistics.secondTokenAuditData?.burnLink})*`, {
                    reply_to_message_id: tokenData.messageId,
                    parse_mode: 'MarkdownV2',
                    disable_web_page_preview: true
                });
            }
            previousMessageId = tokenData.messageId;
            retryDb.set('tokens', db.get('tokens').filter((t) => t.contractAddress !== tokenStatistics.contractAddress));
        }

        console.log(`🤖 ${tokenData.name} (${tokenData.symbol}) is validated! (${tokenStatistics.isValidated ? 'COMPLETE': 'PARTIAL'})`);

        const initialAuditData = await fetchAuditData(contractAddress);
        const initialAuditIsReady = initialAuditData && initialAuditData.status === 'success';
        
        const HEADER = `__*New Token Detected by LuckBlock\\!*__\n\n\n`;

        const statisticsMessage = HEADER + formatTokenStatistics(tokenStatistics, true, initialAuditIsReady ? JSON.parse(initialAuditData?.data) : null, true);
    
        const message = !previousMessageId ? await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, statisticsMessage, {
            parse_mode: 'MarkdownV2',
            disable_web_page_preview: true
        }) : await bot.editMessageText(statisticsMessage, {
            parse_mode: 'MarkdownV2',
            message_id: previousMessageId,
            chat_id: process.env.TELEGRAM_CHAT_ID,
            disable_web_page_preview: true
        });

        if (tokenStatistics.isPartiallyValidated && firstTry) {
            retryDb.push('tokens', {
                ...tokenData,
                addedAt: Date.now(),
                messageId: message.message_id
            });
        }

        if (!initialAuditIsReady) {
    
            triggerAudit(contractAddress);
    
            const ee = new EventEmitter();
            // subscribe to audit changes
            waitForAuditEndOrError(contractAddress, ee);
    
            ee.on('status-update', (status) => {
                console.log(`🤖 ${contractAddress} audit status update: ${status}`);
            });
    
            ee.on('end', (audit) => {
                const auditStatisticsMessage = HEADER + formatTokenStatistics(tokenStatistics, true, audit, true);
                bot.editMessageText(auditStatisticsMessage, {
                    parse_mode: 'MarkdownV2',
                    message_id: message.message_id,
                    chat_id: process.env.TELEGRAM_CHAT_ID,
                    disable_web_page_preview: true
                });
            });
    
            ee.on('error', (error) => {
                console.log(`🤖 ${contractAddress} audit error: ${error}`);

                const newStatisticsErrored = statisticsMessage.replace(escapeMarkdownV2(WAITING_GENERATION_AUDIT_MESSAGE), `[Use our web app](https://app.luckblock.io/audit) to generate the audit report\\.`);
                bot.editMessageText(newStatisticsErrored, {
                    parse_mode: 'MarkdownV2',
                    message_id: message.message_id,
                    chat_id: process.env.TELEGRAM_CHAT_ID,
                    disable_web_page_preview: true
                });
            });
        }

    }
    else {
        console.log(`🤖 ${tokenData.name} (${tokenData.symbol}) is not validated!`);

        if (firstTry) {
            console.log(tokenStatistics.goPlusContractSecurity, tokenStatistics.goPlusTradingSecurity);
        }
    }

}

setInterval(() => {

    const tokensToRetry = retryDb.get('/tokens') || [];

    console.log(`🤖 ${Object.keys(tokensToRetry).length} tokens to retry...`);

    for (const token of Object.keys(tokensToRetry)) {
        const tokenData = tokensToRetry[token];
        // if token is added more than 60 minutes ago, remove it from the list
        if (Date.now() - tokenData.addedAt > 60 * 60 * 1000) {
            retryDb.set('tokens', retryDb.get('tokens').filter((t) => t.contractAddress !== tokenData.contractAddress));
        } else {
            checkSendToken(tokenData, false);
        }
    }

}, 30_000);

console.log(`🤖 luckblock bot is started!`);

process.on('uncaughtException', (er) => {
    console.error(er);
    cleanUpServer();
});

function cleanUpServer() {
    console.log(`🤖 luckblock bot is stopped!`);
    bot.stopPolling({ cancel: true });
    process.exit();
}

[`exit`, `SIGINT`, `SIGUSR1`, `SIGUSR2`, `SIGTERM`].forEach((eventType) => {
    process.on(eventType, cleanUpServer.bind(null, eventType));
});
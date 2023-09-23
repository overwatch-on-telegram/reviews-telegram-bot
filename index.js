import { config } from 'dotenv';
config();

import ws from 'ws';

import { appendFileSync } from 'fs';

import { EventEmitter } from 'events';

import TelegramBot from 'node-telegram-bot-api';
import { WAITING_GENERATION_AUDIT_MESSAGE, fetchTokenStatistics, fetchAuditData, formatTokenStatistics, waitForAuditEndOrError, triggerAudit, escapeMarkdownV2 } from '@overwatch-on-telegram/core-ai-analyzer';

import { JsonDB, Config } from 'node-json-db';
const db = new JsonDB(new Config(process.env.DATABASE_PATH, true, true, '/'));

(async () => {
    if (!await db.exists('/tokens')) {
        db.push('/tokens', {});
    }
})();

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
    polling: true
});

let wsClient = null;

let pingInterval = null;
let lastPingReceivedTs = Date.now();

function connect() {
    console.log("Attempting to connect...");

    wsClient = new ws('wss://ws.dextools.io/');

    wsClient.on('open', function open() {
        handleOpen();
    });

    wsClient.on('close', function close() {
        console.log('Connection lost, retrying in 5 seconds...');
        setTimeout(connect, 5000); // Retry every 5 seconds

        if (pingInterval) {
            clearInterval(pingInterval);
        }
    });

    wsClient.on('message', async function incoming(data) {
        handleMessage(data);
    });

    wsClient.on('error', function error(e) {
        console.log('Error: ', e);
    });
}

connect();

function handleOpen () {
    wsClient.send(JSON.stringify({
        jsonrpc: "2.0",
        method: "subscribe",
        params: {
            chain: "ether",
            channel: "uni:common"
        },
        id: 1
    }));

    wsClient.send(JSON.stringify({
        jsonrpc: "2.0",
        method: "subscribe",
        params: {
            chain: "ether",
            channel: "uni:pools"
        },
        id: 2
    }));

    pingInterval = setInterval(() => {
        if (Date.now() - lastPingReceivedTs > 60_000 * 3) {
            console.log('Connection lost (no ping), retrying in 5 seconds...');
            setTimeout(connect, 5000); // Retry every 5 seconds
            if (pingInterval) {
                clearInterval(pingInterval);
            }
            wsClient.terminate();
        }
        console.log(`🤖 Sending ping...`);
        wsClient.send('ping');
    }, 60_000);
}

function handleMessage (data) {

    const receivedString = Buffer.from(data).toString('utf8');

    if (receivedString === 'pong') {
        console.log(`🤖 Received pong!`);
        lastPingReceivedTs = Date.now();
        return;
    }

    const res = JSON.parse(receivedString).result;

    appendFileSync('log.json', JSON.stringify(res) + '\n', 'utf8')

    //if (!res?.data?.pair?.creation) return;
    if (res.data.event !== 'create') return;

    //const main = res.data.pair.token1;
    //const pair = res.data.pair.token0;

    // get the pair that is not weth

    const main = res.data.pair.token0.symbol === 'WETH' ? res.data.pair.token1 : res.data.pair.token0;
    const pair = res.data.pair.token0.symbol === 'WETH' ? res.data.pair.token0 : res.data.pair.token1;

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

    console.log(`🤖 Queueing checking ${symbol} (${contractAddress})...`);

    fetchTokenStatistics(tokenData.contractAddress).catch(() => {});

    setTimeout(() => {
        checkSendToken(tokenData, true);
    }, 60_000);

};


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
            db.push(`/tokens/${tokenData.contractAddress}`, {
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
            db.delete(`/tokens/${tokenData.contractAddress}`);
        }

        console.log(`🤖 ${tokenData.name} (${tokenData.symbol}) is validated! (${tokenStatistics.isValidated ? 'COMPLETE': 'PARTIAL'})`);

        const HEADER = `__*New Token Detected by Overwatch\\!*__\n\n\n`;

        const statisticsMessage = HEADER + formatTokenStatistics(tokenStatistics, true);
    
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
            db.push(`/tokens/${tokenData.contractAddress}`, {
                ...tokenData,
                addedAt: Date.now(),
                messageId: message.message_id
            });
        }

        /*
    
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
        */

    }
    else {
        console.log(`🤖 ${tokenData.name} (${tokenData.symbol}) is not validated!`);

        if (firstTry) {
            console.log(tokenStatistics.goPlusContractSecurity, tokenStatistics.goPlusTradingSecurity);
        }
    }

}

setInterval(async () => {

    const tokensToRetry = await db.getData('/tokens');

    console.log(`🤖 ${Object.keys(tokensToRetry).length} tokens to retry...`);

    for (const token of Object.keys(tokensToRetry)) {
        const tokenData = tokensToRetry[token];
        // if token is added more than 60 minutes ago, remove it from the list
        if (Date.now() - tokenData.addedAt > 60 * 60 * 1000) {
            await db.delete(`/tokens/${tokenData.contractAddress}`);
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
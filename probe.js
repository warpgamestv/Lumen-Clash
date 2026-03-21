const WebSocket = require('ws');

console.log("Probing Matchmaker through standard Proxy 8083...");

const ws1 = new WebSocket('ws://127.0.0.1:8083/play');
ws1.on('open', () => console.log('WS1 Open'));
ws1.on('close', (code, reason) => console.log('WS1 Closed:', code, reason.toString()));
ws1.on('message', (data) => console.log('WS1 MSG:', data.toString()));

setTimeout(() => {
    const ws2 = new WebSocket('ws://127.0.0.1:8083/play');
    ws2.on('open', () => console.log('WS2 Open'));
    ws2.on('close', (code, reason) => console.log('WS2 Closed:', code, reason.toString()));
    ws2.on('message', (data) => console.log('WS2 MSG:', data.toString()));
}, 1000);

setTimeout(() => process.exit(0), 4000);

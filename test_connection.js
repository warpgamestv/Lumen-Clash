const WebSocket = require('ws');

const ws1 = new WebSocket('ws://127.0.0.1:8790/play?char=AegisKnight');
ws1.on('open', () => console.log('WS1 Open'));
ws1.on('close', (code, reason) => console.log('WS1 Closed:', code, reason.toString()));
ws1.on('message', (data) => console.log('WS1 MSG:', data.toString()));
ws1.on('error', (err) => console.log('WS1 Err:', err));

setTimeout(() => {
    const ws2 = new WebSocket('ws://127.0.0.1:8790/play?char=LumenSage');
    ws2.on('open', () => console.log('WS2 Open'));
    ws2.on('close', (code, reason) => console.log('WS2 Closed:', code, reason.toString()));
    ws2.on('message', (data) => console.log('WS2 MSG:', data.toString()));
    ws2.on('error', (err) => console.log('WS2 Err:', err));
}, 1000);

setTimeout(() => process.exit(0), 2000);

const WebSocket = require('ws');

console.log("Starting test...");

const ws1 = new WebSocket('ws://127.0.0.1:8789/play');
ws1.on('open', () => console.log('WS1 Open'));
ws1.on('message', (data) => console.log('WS1:', data.toString()));
ws1.on('error', (err) => console.log('WS1 Err:', err));

setTimeout(() => {
    const ws2 = new WebSocket('ws://127.0.0.1:8789/play');
	ws2.on('open', () => console.log('WS2 Open'));
    ws2.on('message', (data) => console.log('WS2:', data.toString()));
    ws2.on('error', (err) => console.log('WS2 Err:', err));
}, 500);

setTimeout(() => process.exit(0), 4000);

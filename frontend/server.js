const http = require('http');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
    let urlNoQuery = req.url.split('?')[0];

    // Special route for changelog outside the frontend folder
    if (urlNoQuery === '/changelog') {
        const changelogPath = path.join(__dirname, '..', 'CHANGELOG.md');
        fs.readFile(changelogPath, (err, content) => {
            if (err) {
                res.writeHead(404);
                res.end('Changelog Not Found');
            } else {
                res.writeHead(200, { 'Content-Type': 'text/markdown' });
                res.end(content, 'utf-8');
            }
        });
        return;
    }

    let filePath = path.join(__dirname, urlNoQuery);
    if (urlNoQuery === '/') filePath = path.join(__dirname, 'index.html');

    const extname = path.extname(filePath);
    let contentType = 'text/html';
    let isBinary = false;
    switch (extname) {
        case '.js': contentType = 'text/javascript'; break;
        case '.css': contentType = 'text/css'; break;
        case '.png': contentType = 'image/png'; isBinary = true; break;
        case '.jpg': case '.jpeg': contentType = 'image/jpeg'; isBinary = true; break;
        case '.gif': contentType = 'image/gif'; isBinary = true; break;
        case '.ico': contentType = 'image/x-icon'; isBinary = true; break;
    }

    fs.readFile(filePath, (err, content) => {
        if (err) {
            // If file not found, check if it's an API route to proxy to 8790
            const apiRoutes = ['/profile', '/set-username', '/leaderboard', '/add-friend', '/remove-friend', '/friends-status', '/create-private', '/join-private', '/update-presence', '/accept-friend', '/decline-friend', '/lobby-update', '/system-reset', '/reset-player'];
            if (apiRoutes.some(r => urlNoQuery.startsWith(r))) {
                const proxyReq = http.request({
                    host: '127.0.0.1',
                    port: 8790,
                    path: req.url,
                    method: req.method,
                    headers: req.headers
                }, (proxyRes) => {
                    res.writeHead(proxyRes.statusCode, proxyRes.headers);
                    proxyRes.pipe(res);
                });
                proxyReq.on('error', (e) => {
                    res.writeHead(502);
                    res.end('Bad Gateway: ' + e.message);
                });
                req.pipe(proxyReq);
                return;
            }

            res.writeHead(404);
            res.end('File Not Found: ' + filePath);
        } else {
            res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate', 'Expires': '0' });
            if (isBinary) {
                res.end(content); // Don't apply UTF-8 encoding to binary files
            } else {
                res.end(content, 'utf-8');
            }
        }
    });
});

const net = require('net');
server.on('upgrade', (req, socket, head) => {
    console.log("UPGRADE TRIGGERED:", req.url);
    if (req.url.startsWith('/play')) {
        console.log("Connecting proxy to 8790...");
        const proxySocket = net.connect(8790, '127.0.0.1', () => {
            console.log("Connected to 8790! Forwarding headers...");
            proxySocket.write(
                `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` +
                req.rawHeaders.reduce((acc, v, i) => acc + (i % 2 === 0 ? v + ': ' : v + '\r\n'), '') +
                '\r\n'
            );
            proxySocket.write(head);
            proxySocket.pipe(socket);
            socket.pipe(proxySocket);
        });

        proxySocket.on('error', (err) => console.error('Proxy Error:', err.message));
        socket.on('error', (err) => console.error('Client Socket Error:', err.message));
    } else {
        socket.destroy();
    }
});

server.listen(8083);
console.log('Server running at http://127.0.0.1:8083/');

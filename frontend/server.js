const http = require('http');
const fs = require('fs');
const path = require('path');

const API_ROUTES = [
    '/profile', '/set-username', '/leaderboard', '/add-friend', '/remove-friend', '/friends-status',
    '/create-private', '/join-private', '/update-presence', '/accept-friend', '/decline-friend',
    '/lobby-update', '/system-reset', '/reset-player', '/save-customization',
    '/friend-duel-invite', '/friend-duel-decline', '/friend-duel-accept', '/report', '/unlock-premium', '/admin/reports', '/admin/moderate'
];

const BACKEND_PORT = 8790;

/** Stable pathname from Node req.url (leading slash, no trailing slash, decoded). */
function pathnameFromReq(req) {
    let p = (req.url || '/').split('?')[0];
    try {
        p = decodeURIComponent(p);
    } catch (e) {
        /* keep raw */
    }
    if (!p.startsWith('/')) p = `/${p.replace(/^\/+/, '')}`;
    p = p.replace(/\/{2,}/g, '/');
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return p || '/';
}

function isApiPath(urlPath) {
    return API_ROUTES.some((r) => urlPath === r || urlPath.startsWith(`${r}/`));
}

function proxyApiToBackend(req, res) {
    const headers = { ...req.headers, host: `127.0.0.1:${BACKEND_PORT}` };
    delete headers.connection;
    const proxyReq = http.request(
        {
            host: '127.0.0.1',
            port: BACKEND_PORT,
            path: req.url,
            method: req.method,
            headers
        },
        (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        }
    );
    proxyReq.on('error', (e) => {
        console.error('[proxy]', req.method, req.url, e.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `Backend unreachable (${e.message}). Is wrangler dev running on port ${BACKEND_PORT}?` }));
    });
    req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
    const urlPath = pathnameFromReq(req);

    // Special route for changelog outside the frontend folder
    if (urlPath === '/changelog') {
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

    // Proxy API first so POST/JSON routes never hit the filesystem (avoids odd readFile edge cases)
    if (isApiPath(urlPath)) {
        proxyApiToBackend(req, res);
        return;
    }

    let filePath = path.join(__dirname, urlPath);
    if (urlPath === '/') filePath = path.join(__dirname, 'index.html');

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
            if (isApiPath(urlPath)) {
                proxyApiToBackend(req, res);
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
console.log('Server running at http://127.0.0.1:8083/ (API proxy -> 127.0.0.1:' + BACKEND_PORT + ', includes friend-duel-*)');

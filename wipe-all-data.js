const http = require('http');

console.log("");
console.log("⚠️  LUMEN CLASH GLOBAL WIPE UTILITY");
console.log("===================================");
console.log("This will permanently delete all usernames, leaderboard entries, and player profiles.");
console.log("This should ONLY be used for development testing.");
console.log("");

const options = {
    hostname: '127.0.0.1',
    port: 8083,
    path: '/system-reset',
    method: 'GET',
    headers: {
        'X-Dev-Secret': 'dev-reset-2026'
    }
};

const req = http.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
        if (res.statusCode === 200) {
            console.log("✅ SUCCESS: Global data has been wiped.");
            console.log("Note: Players will still need to refresh their tabs to clear their local session.");
        } else if (res.statusCode === 401) {
            console.log("❌ ERROR: Unauthorized. The secret key does not match.");
        } else {
            console.log("❌ ERROR: Server returned status " + res.statusCode);
            console.log(data);
        }
    });
});

req.on('error', (e) => {
    console.error(`❌ ERROR: Could not connect to the server: ${e.message}`);
    console.log("Make sure your local server (npm run dev-frontend) is running.");
});

req.end();

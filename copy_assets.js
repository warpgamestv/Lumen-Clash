const fs = require('fs');
const path = require('path');

const transfers = [
    { src: 'C:\\Users\\WarpGamesHD\\.gemini\\antigravity\\brain\\fdd83982-668e-42bd-add8-b768f034e7a0\\aegis_knight_transparent_1774138262161.png', dest: 'frontend/assets/aegis_knight.png' },
    { src: 'C:\\Users\\WarpGamesHD\\.gemini\\antigravity\\brain\\fdd83982-668e-42bd-add8-b768f034e7a0\\lumen_sage_transparent_1774138272378.png', dest: 'frontend/assets/lumen_sage.png' },
    { src: 'C:\\Users\\WarpGamesHD\\.gemini\\antigravity\\brain\\fdd83982-668e-42bd-add8-b768f034e7a0\\void_weaver_transparent_1774138250547.png', dest: 'frontend/assets/void_weaver.png' },
    { src: 'C:\\Users\\WarpGamesHD\\.gemini\\antigravity\\brain\\fdd83982-668e-42bd-add8-b768f034e7a0\\void_weaver_green_transparent_1774138284947.png', dest: 'frontend/assets/void_weaver_green.png' }
];

transfers.forEach(t => {
    try {
        fs.copyFileSync(t.src, path.join(__dirname, t.dest));
        console.log(`Successfully copied ${t.src} to ${t.dest}`);
    } catch(e) {
        console.error(`Failed to copy ${t.src}: ${e.message}`);
    }
});

const path = require('path');
const fs = require('fs');

async function run() {
    try {
        // Ensure jimp is installed
        try {
            require.resolve('jimp');
        } catch (e) {
            console.log('Jimp not found. Installing jimp...');
            const execSync = require('child_process').execSync;
            execSync('npm install -D jimp@0.22.12', { stdio: 'inherit' });
        }

        const Jimp = require('jimp');
        const sourcePath = path.join(__dirname, '../public/logo.png');

        if (!fs.existsSync(sourcePath)) {
            throw new Error(`Source icon not found at: ${sourcePath}`);
        }

        console.log(`Reading source icon from: ${sourcePath}`);
        const image = await Jimp.read(sourcePath);

        // Dimensions to output
        const targets = [
            { width: 192, height: 192, dest: '../public/icons/icon-192x192.png' },
            { width: 512, height: 512, dest: '../public/icons/icon-512x512.png' },
            { width: 180, height: 180, dest: '../public/icons/apple-touch-icon.png' },
            { width: 512, height: 512, dest: '../app/icon.png' }
        ];

        for (const target of targets) {
            const destPath = path.resolve(__dirname, target.dest);
            // Ensure destination directory exists
            const destDir = path.dirname(destPath);
            if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true });
            }

            console.log(`Generating icon [${target.width}x${target.height}] -> ${destPath}`);
            
            const cloned = image.clone();
            cloned.contain(target.width, target.height, Jimp.HORIZONTAL_ALIGN_CENTER | Jimp.VERTICAL_ALIGN_MIDDLE);
            
            await cloned.writeAsync(destPath);
        }

        console.log('All icons generated successfully!');
    } catch (err) {
        console.error('Failed to generate icons:', err);
        process.exit(1);
    }
}

run();

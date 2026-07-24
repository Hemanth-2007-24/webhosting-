const sharp = require('sharp');
const path = require('path');
const fs = require('fs-extra');

class IconService {
    static async generateIcons(sourceIconPath, outputResDir) {
        const iconResolutions = [
            { name: 'mipmap-mdpi', size: 48 },
            { name: 'mipmap-hdpi', size: 72 },
            { name: 'mipmap-xhdpi', size: 96 },
            { name: 'mipmap-xxhdpi', size: 144 },
            { name: 'mipmap-xxxhdpi', size: 192 }
        ];

        for (const res of iconResolutions) {
            const targetDir = path.join(outputResDir, res.name);
            await fs.ensureDir(targetDir);
            await sharp(sourceIconPath)
                .resize(res.size, res.size)
                .toFile(path.join(targetDir, 'ic_launcher.png'));
        }
    }

    static async generateSplashLogo(sourceLogoPath, outputResDir) {
        const targetDir = path.join(outputResDir, 'drawable');
        await fs.ensureDir(targetDir);
        await sharp(sourceLogoPath)
            .resize(300, 300)
            .toFile(path.join(targetDir, 'splash_logo.png'));
    }
}

module.exports = IconService;

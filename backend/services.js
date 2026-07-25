// =================================================================
// ==                     services.js                             ==
// =================================================================

const cloudinary = require('cloudinary').v2;
const qrcode = require('qrcode');
const archiver = require('archiver');
const crypto = require('crypto');
const sanitizeHtml = require('sanitize-html');
const fs = require('fs-extra');
const { Log } = require('./database');

// --- CLOUDINARY CONFIGURATION ---
if (process.env.CLOUDINARY_URL) {
    cloudinary.config();
}

class CloudinaryService {
    static async uploadImage(filePath, folder, width = 512, height = 512) {
        try {
            const result = await cloudinary.uploader.upload(filePath, {
                folder: `webhost/${folder}`,
                transformation: [
                    { width: width, height: height, crop: "fill" },
                    { quality: "auto:best" },
                    { fetch_format: "auto" }
                ]
            });
            return { url: result.secure_url, publicId: result.public_id };
        } catch (err) {
            throw new Error(`Cloudinary upload failed: ${err.message}`);
        }
    }

    static async deleteImage(publicId) {
        try {
            await cloudinary.uploader.destroy(publicId);
            return true;
        } catch (err) {
            throw new Error(`Cloudinary deletion failed: ${err.message}`);
        }
    }

    static async replaceImage(oldPublicId, newFilePath, folder, width = 512, height = 512) {
        if (oldPublicId) {
            await this.deleteImage(oldPublicId).catch(err => console.error("Cloudinary swap warning:", err.message));
        }
        return await this.uploadImage(newFilePath, folder, width, height);
    }
}

// --- SECURE CUSTOM CODE VALIDATION SERVICE ---
class SecurityService {
    static sanitizeCustomCode(code) {
        if (!code) return '';

        const maxBytes = 500 * 1024; // 500KB limit
        if (Buffer.byteLength(code, 'utf8') > maxBytes) {
            throw new Error("Security Violation: Custom code payload exceeds 500KB limit.");
        }

        // Prevent Arbitrary Shell Executions or Malicious NodeJS Filesystem Commands
        const blacklist = [
            'child_process', 'exec(', 'spawn(', 'fork(', 'execSync', 'spawnSync',
            'process.exit', 'process.env', 'eval(', 'Function(', 'setTimeout(', 'setInterval(',
            'require("fs")', "require('fs')", 'require("child_process")', "require('child_process')",
            'fs.writeFile', 'fs.writeFileSync', 'fs.unlink', 'fs.rmSync', 'fs.removeSync',
            'fs.chmod', 'shelljs', 'sudo', 'rm -rf', 'system(', 'os.system', 'Runtime.getRuntime()'
        ];

        for (const word of blacklist) {
            if (code.includes(word)) {
                throw new Error(`Security Violation: Unsafe command pattern found in code snippet: "${word}".`);
            }
        }

        // Clean any malicious markup tags
        return sanitizeHtml(code, {
            allowedTags: [],
            allowedAttributes: {}
        });
    }
}

// --- UTILITIES AND COMPRESSION SERVICES ---
class QRCodeService {
    static async generateQRCode(url) {
        try {
            return await qrcode.toDataURL(url);
        } catch (err) {
            throw new Error(`Failed to compile QR Code: ${err.message}`);
        }
    }
}

class PackageNameService {
    static generatePackageName(appName) {
        const sanitized = appName.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (sanitized.length < 3) {
            return `com.webhost.app_${crypto.randomBytes(3).toString('hex')}`;
        }
        return `com.webhost.${sanitized}`;
    }
}

class ZipService {
    static zipDirectory(sourceDir, outPath) {
        return new Promise((resolve, reject) => {
            const output = fs.createWriteStream(outPath);
            const archive = archiver('zip', { zlib: { level: 9 } });

            output.on('close', () => resolve());
            archive.on('error', (err) => reject(err));

            archive.pipe(output);
            archive.directory(sourceDir, false);
            archive.finalize();
        });
    }
}

class LoggerService {
    static async log(actionType, details, userId = null, projectId = null) {
        try {
            console.log(`[AUDIT] Action: ${actionType} | Details: ${details}`);
            const logEntry = new Log({ actionType, details, userId, projectId });
            await logEntry.save();
        } catch (err) {
            console.error("Logger writing crash:", err);
        }
    }
}

module.exports = {
    CloudinaryService,
    SecurityService,
    QRCodeService,
    PackageNameService,
    ZipService,
    LoggerService
};

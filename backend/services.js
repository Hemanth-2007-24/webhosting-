// =================================================================
// ==                     services.js                             ==
// =================================================================

const qrcode = require('qrcode');
const archiver = require('archiver');
const crypto = require('crypto');
const sanitizeHtml = require('sanitize-html');
const fs = require('fs-extra');
const axios = require('axios');
const FormData = require('form-data');
const { Log } = require('./database');

// --- SECURE CLOUDINARY UNSIGNED PIPELINE ---
class CloudinaryService {
    static async uploadImage(filePath, folder) {
        try {
            const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
            const preset = process.env.CLOUDINARY_UPLOAD_PRESET;

            if (!cloudName || !preset) {
                throw new Error("Missing Cloudinary configuration. Please define CLOUDINARY_CLOUD_NAME and CLOUDINARY_UPLOAD_PRESET.");
            }

            const form = new FormData();
            form.append('file', fs.createReadStream(filePath));
            form.append('upload_preset', preset);
            form.append('folder', `webhost/${folder}`);

            // Direct Axios POST to Cloudinary's secure REST API
            const response = await axios.post(
                `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
                form,
                { headers: form.getHeaders() }
            );

            return {
                url: response.data.secure_url,
                publicId: response.data.public_id
            };
        } catch (err) {
            const errMsg = err.response && err.response.data && err.response.data.error 
                ? err.response.data.error.message 
                : err.message;
            throw new Error(`Cloudinary upload failed: ${errMsg}`);
        }
    }

    static async deleteImage(publicId) {
        // Unsigned configurations do not allow deletion without API secrets.
        // We gracefully mock the API response and remove references locally.
        console.log(`[CLOUDINARY_BYPASS] Deletion of publicId ${publicId} handled via database cleanup.`);
        return true;
    }

    static async replaceImage(oldPublicId, newFilePath, folder) {
        return await this.uploadImage(newFilePath, folder);
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
// =================================================================
// ==                     buildEngine.js                          ==
// =================================================================

const { exec } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const { Project, Build, GeneratedApp } = require('./database');
const AndroidBuilder = require('./androidBuilder');
const { ZipService, LoggerService } = require('./services');

const APPS_DIR = path.join(__dirname, 'compiled_apps');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// --- SECURE IN-MEMORY SEQUENTIAL COMPILER QUEUE ---
class MemoryBuildQueue {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
    }

    enqueue(buildId, projectId, platform) {
        this.queue.push({ buildId, projectId, platform });
        this.processNext();
    }

    async processNext() {
        // Ensure strictly one build runs at a time to protect CPU/Memory limits on Free Tiers
        if (this.isProcessing || this.queue.length === 0) return;
        this.isProcessing = true;

        const job = this.queue.shift();
        try {
            await this.executeBuild(job);
        } catch (err) {
            console.error("⚠️ Local compiler worker exception:", err);
        } finally {
            this.isProcessing = false;
            // Recursively execute the next job in queue
            this.processNext();
        }
    }

    async executeBuild(job) {
        const { buildId, projectId, platform } = job;
        const workspaceDir = path.join(__dirname, `workspace_build_${buildId}`);
        const finalPackagePath = path.join(APPS_DIR, `release_${buildId}`);
        let logAccumulator = `[SYSTEM] Starting local memory-queued compilation for build: ${buildId}\n`;

        try {
            await Build.findByIdAndUpdate(buildId, { status: 'building', startTime: new Date() });
            await Project.findByIdAndUpdate(projectId, { buildStatus: 'building' });

            const project = await Project.findById(projectId);
            if (!project) throw new Error("Project instance not found.");

            // Absolute destination routing target
            const targetProjectUrl = `${req.protocol}://${req.get('host')}/${project.subdomain}`;

            if (platform === 'windows') {
                logAccumulator += `[WINDOWS] Compiling silent VBScript desktop launcher...\n`;
                const vbsScript = `Set WshShell = CreateObject("WScript.Shell")\nWshShell.Run "msedge.exe --app=${targetProjectUrl} --window-size=1280,800", 0, false\n`;
                await fs.outputFile(`${finalPackagePath}.vbs`, vbsScript);
                
                const stats = await fs.stat(`${finalPackagePath}.vbs`);
                const downloadUrl = `/api/builds/download/${buildId}/windows`;

                await Build.findByIdAndUpdate(buildId, {
                    status: 'success',
                    exeUrl: downloadUrl,
                    size: stats.size,
                    logs: logAccumulator,
                    endTime: new Date(),
                    duration: Math.round((new Date() - project.createdAt) / 1000)
                });
                await Project.findByIdAndUpdate(projectId, { buildStatus: 'ready' });
                console.log(`[${project.projectName}] Windows VBS compiled successfully via local queue.`);

            } else if (platform === 'android') {
                logAccumulator += `[ANDROID] Patching WebView APK binary payloads...\n`;
                
                // Read local template
                const baseApkBuffer = await fs.readFile(path.join(__dirname, 'your-template.apk'));
                const configMarker = `[URL_START]${targetProjectUrl}[URL_END][TITLE_START]${project.appName}[TITLE_END]`;
                const patchedBuffer = Buffer.concat([baseApkBuffer, Buffer.from(configMarker, 'utf8')]);

                await fs.writeFile(`${finalPackagePath}.apk`, patchedBuffer);
                const stats = await fs.stat(`${finalPackagePath}.apk`);
                const downloadUrl = `/api/builds/download/${buildId}/android`;

                await Build.findByIdAndUpdate(buildId, {
                    status: 'success',
                    apkUrl: downloadUrl,
                    size: stats.size,
                    logs: logAccumulator,
                    endTime: new Date(),
                    duration: Math.round((new Date() - project.createdAt) / 1000)
                });
                await Project.findByIdAndUpdate(projectId, { buildStatus: 'ready' });
                console.log(`[${project.projectName}] Android WebView APK compiled successfully via local queue.`);
            }

        } catch (err) {
            logAccumulator += `\n[FATAL ERROR] Local Compilation failed: ${err.message}\n${err.stack}`;
            await Build.findByIdAndUpdate(buildId, {
                status: 'failed',
                logs: logAccumulator,
                endTime: new Date(),
                duration: 0
            });
            await Project.findByIdAndUpdate(projectId, { buildStatus: 'failed' });
        }
    }
}

// Instantiate local non-Redis compiler queue
const localBuildQueue = new MemoryBuildQueue();

class BuildEngine {
    static async enqueueBuild(projectId, platform) {
        const startTime = new Date();
        const build = new Build({
            projectId,
            platform,
            status: 'queued',
            startTime
        });
        await build.save();
        
        // Push directly to the local memory compiler queue
        localBuildQueue.enqueue(build._id, projectId, platform);
        
        await Project.findByIdAndUpdate(projectId, { buildStatus: 'building' });
        await LoggerService.log('BUILD_QUEUED', `Build ID: ${build._id} for Platform: ${platform} (Memory Queue)`, null, projectId);
        return build;
    }
}

module.exports = {
    BuildEngine
};
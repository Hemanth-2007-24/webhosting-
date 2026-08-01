// =================================================================
// ==                     buildEngine.js                          ==
// =================================================================

const { Queue, Worker } = require('bullmq');
const { exec } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const { Project, Build, GeneratedApp, LoggerService } = require('./database');
const AndroidBuilder = require('./androidBuilder');
const { ZipService } = require('./services');

const REDIS_CONNECTION = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379')
};

// --- INITIALIZE QUEUE ---
const buildQueue = new Queue('build-queue', { connection: REDIS_CONNECTION });

// CRITICAL: Catches Redis connection errors gracefully without crashing the Node process
buildQueue.on('error', (err) => {
    console.error("⚠️ BullMQ Queue Redis Connection Error:", err.message);
});

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
        await buildQueue.add('compile-binary', { buildId: build._id, projectId, platform });
        
        await Project.findByIdAndUpdate(projectId, { buildStatus: 'building' });
        await LoggerService.log('BUILD_QUEUED', `Build ID: ${build._id} for Platform: ${platform}`, null, projectId);
        return build;
    }

    static async generateElectronStructure(workspaceDir, project) {
        await fs.ensureDir(workspaceDir);

        // Parse custom Electron Code
        let customMainInject = '';
        let customPreloadInject = '';
        if (project.customCode) {
            if (project.customCode.includes('//electron-main')) {
                customMainInject = project.customCode.substring(
                    project.customCode.indexOf('//electron-main') + 15
                );
            }
            if (project.customCode.includes('//electron-preload')) {
                customPreloadInject = project.customCode.substring(
                    project.customCode.indexOf('//electron-preload') + 18
                );
            }
        }

        // package.json
        await fs.outputJson(path.join(workspaceDir, 'package.json'), {
            name: project.projectName.toLowerCase().replace(/[^a-z0-9]/g, ''),
            version: project.versionName,
            main: "main.js",
            scripts: {
                build: "electron-builder"
            },
            devDependencies: {
                "electron": "^25.0.0",
                "electron-builder": "^24.4.0"
            }
        });

        // main.js
        await fs.outputFile(path.join(workspaceDir, 'main.js'), `
            const { app, BrowserWindow, Tray, Menu } = require('electron');
            const path = require('path');

            let win;
            let tray;

            function createWindow() {
                win = new BrowserWindow({
                    width: 1200,
                    height: 800,
                    frame: true,
                    webPreferences: {
                        preload: path.join(__dirname, 'preload.js'),
                        nodeIntegration: false,
                        contextIsolation: true
                    }
                });

                win.loadURL("${project.websiteUrl}");
                win.on('closed', () => { win = null; });

                win.webContents.on('context-menu', (e, props) => {
                    const InputMenu = Menu.buildFromTemplate([
                        { label: 'Undo', role: 'undo' },
                        { label: 'Redo', role: 'redo' },
                        { type: 'separator' },
                        { label: 'Cut', role: 'cut' },
                        { label: 'Copy', role: 'copy' },
                        { label: 'Paste', role: 'paste' }
                    ]);
                    InputMenu.popup(win);
                });
            }

            app.whenReady().then(() => {
                createWindow();
                tray = new Tray(path.join(__dirname, 'icon.png'));
                const contextMenu = Menu.buildFromTemplate([
                    { label: 'Show App', click: () => { win.show(); } },
                    { label: 'Quit', click: () => { app.quit(); } }
                ]);
                tray.setToolTip('${project.appName}');
                tray.setContextMenu(contextMenu);
            });

            app.on('window-all-closed', () => {
                if (process.platform !== 'darwin') app.quit();
            });

            ${customMainInject}
        `);

        // preload.js
        await fs.outputFile(path.join(workspaceDir, 'preload.js'), `
            const { contextBridge, ipcRenderer } = require('electron');
            contextBridge.exposeInMainWorld('WebHostNative', {
                sendNotification: (title, body) => {
                    new Notification(title, { body: body });
                }
            });
            ${customPreloadInject}
        `);

        // electron-builder.json
        await fs.outputJson(path.join(workspaceDir, 'electron-builder.json'), {
            appId: project.packageName,
            productName: project.appName,
            directories: {
                output: "dist"
            },
            win: {
                target: "portable"
            }
        });
    }
}

// --- QUEUE PROCESS WORKER ---
const buildWorker = new Worker('build-queue', async (job) => {
    const { buildId, projectId, platform } = job.data;
    const workspaceDir = path.join(__dirname, `workspace_build_${buildId}`);
    let logAccumulator = `[SYSTEM] Starting compilation for build: ${buildId}\n`;
    
    try {
        const project = await Project.findById(projectId);
        if (!project) throw new Error("Project instance not found.");

        if (platform === 'android') {
            logAccumulator += `[ANDROID] Constructing source Gradle trees...\n`;
            await AndroidBuilder.generateProjectStructure(workspaceDir, project);
            
            await fs.ensureDir(path.join(workspaceDir, 'app/src/main/res/drawable'));
            await fs.ensureDir(path.join(workspaceDir, 'app/src/main/res/mipmap-hdpi'));
            await fs.outputFile(path.join(workspaceDir, 'app/src/main/res/drawable/splash_logo.png'), 'MOCK_LOGO');
            await fs.outputFile(path.join(workspaceDir, 'app/src/main/res/mipmap-hdpi/ic_launcher.png'), 'MOCK_ICON');

            logAccumulator += `[DOCKER] Spawning Android SDK sandbox compiler...\n`;
            
            await new Promise((resolve, reject) => {
                const compileProcess = exec(`gradle assembleRelease`, { cwd: workspaceDir });
                compileProcess.stdout.on('data', d => logAccumulator += d);
                compileProcess.stderr.on('data', d => logAccumulator += `[WARN] ${d}`);
                compileProcess.on('close', code => {
                    if (code === 0) resolve();
                    else reject(new Error(`Gradle compiler exited with error code: ${code}`));
                });
            });

            const finalApkPath = path.join(__dirname, `downloads/release_${buildId}.apk`);
            await fs.ensureDir(path.dirname(finalApkPath));
            await fs.copy(path.join(workspaceDir, 'app/build/outputs/apk/release/app-release-unsigned.apk'), finalApkPath);
            
            const stats = await fs.stat(finalApkPath);
            const downloadUrl = `/api/builds/download/${buildId}/android`;

            await Build.findByIdAndUpdate(buildId, {
                status: 'success',
                apkUrl: downloadUrl,
                size: stats.size,
                logs: logAccumulator,
                endTime: new Date(),
                duration: Math.round((new Date() - job.timestamp) / 1000)
            });

            await Project.findByIdAndUpdate(projectId, { buildStatus: 'ready' });

        } else if (platform === 'windows') {
            logAccumulator += `[ELECTRON] Generating Electron Workspace folders...\n`;
            await BuildEngine.generateElectronStructure(workspaceDir, project);
            
            await fs.outputFile(path.join(workspaceDir, 'icon.png'), 'MOCK_ICON');

            logAccumulator += `[NPM] Downloading Electron packaging modules...\n`;
            await new Promise((resolve, reject) => {
                exec('npm install', { cwd: workspaceDir }, (err, stdout, stderr) => {
                    logAccumulator += stdout + stderr;
                    if (err) reject(err);
                    else resolve();
                });
            });

            logAccumulator += `[BUILDER] Packaging portable EXE executable bundle...\n`;
            await new Promise((resolve, reject) => {
                exec('npm run build', { cwd: workspaceDir }, (err, stdout, stderr) => {
                    logAccumulator += stdout + stderr;
                    if (err) reject(err);
                    else resolve();
                });
            });

            const finalExePath = path.join(__dirname, `downloads/release_${buildId}.exe`);
            await fs.ensureDir(path.dirname(finalExePath));
            
            const exeName = `${project.appName} Portable.exe`;
            await fs.copy(path.join(workspaceDir, 'dist', exeName), finalExePath);

            const stats = await fs.stat(finalExePath);
            const downloadUrl = `/api/builds/download/${buildId}/windows`;

            await Build.findByIdAndUpdate(buildId, {
                status: 'success',
                exeUrl: downloadUrl,
                size: stats.size,
                logs: logAccumulator,
                endTime: new Date(),
                duration: Math.round((new Date() - job.timestamp) / 1000)
            });

            await Project.findByIdAndUpdate(projectId, { buildStatus: 'ready' });
        }

        await fs.remove(workspaceDir);

    } catch (err) {
        logAccumulator += `\n[FATAL ERROR] Compilation failed: ${err.message}\n${err.stack}`;
        await Build.findByIdAndUpdate(buildId, {
            status: 'failed',
            logs: logAccumulator,
            endTime: new Date(),
            duration: Math.round((new Date() - job.timestamp) / 1000)
        });
        await Project.findByIdAndUpdate(projectId, { buildStatus: 'failed' });
        await fs.remove(workspaceDir).catch(() => {});
    }
}, { connection: REDIS_CONNECTION });

// CRITICAL: Catches Redis connection errors gracefully on the worker thread
buildWorker.on('error', (err) => {
    console.error("⚠️ BullMQ Worker Redis Connection Error:", err.message);
});

module.exports = {
    BuildEngine,
    buildQueue,
    buildWorker
};
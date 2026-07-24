const { Worker } = require('bullmq');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const Project = require('../models/Project');
const BuildLog = require('../models/BuildLog');
const AndroidTemplateService = require('../services/androidTemplateService');
const IconService = require('../services/iconService');

const buildWorker = new Worker('build-queue', async (job) => {
    const { projectId, buildId } = job.data;
    const startTime = new Date();
    
    await BuildLog.findByIdAndUpdate(buildId, { status: 'building', startTime });
    const project = await Project.findById(projectId);
    
    const buildWorkspace = path.join(__dirname, `../builds/build_${buildId}`);
    let buildLogs = '';
    
    try {
        // Step 1: Generate Source Tree Structure
        buildLogs += '[1/4] Generating native android source trees...\n';
        await AndroidTemplateService.generateProjectStructure(buildWorkspace, project);
        
        // Handle Icons if configured
        if (project.appIcon) {
            buildLogs += '[2/4] Formatting & scaling application assets...\n';
            const resDir = path.join(buildWorkspace, 'app/src/main/res');
            await IconService.generateIcons(project.appIcon, resDir);
            await IconService.generateSplashLogo(project.appIcon, resDir);
        }

        // Copy Firebase Config if uploaded
        const firebaseConfigPath = path.join(__dirname, `../uploads/google_services_${projectId}.json`);
        if (await fs.pathExists(firebaseConfigPath)) {
            await fs.copy(firebaseConfigPath, path.join(buildWorkspace, 'app/google-services.json'));
        }

        // Step 2: Trigger compilation in Docker Sandbox container
        buildLogs += '[3/4] Initializing isolated Docker container compiler...\n';
        const buildCommand = `docker run --rm -v "${buildWorkspace}":/workspace android-builder-base gradlew assembleRelease`;
        
        const runBuild = () => new Promise((resolve, reject) => {
            const process = exec(buildCommand);
            process.stdout.on('data', data => { buildLogs += data; });
            process.stderr.on('data', data => { buildLogs += `[WARN/ERR] ${data}`; });
            process.on('close', code => {
                if (code === 0) resolve();
                else reject(new Error(`Gradle compilation failed with exit code: ${code}`));
            });
        });

        await runBuild();

        // Step 3: Copy generated artifact
        buildLogs += '[4/4] Finalizing APK compilation package artifacts...\n';
        const generatedApk = path.join(buildWorkspace, 'app/build/outputs/apk/release/app-release-unsigned.apk');
        const finalApkPath = path.join(__dirname, `../uploads/${project.subdomain}_release.apk`);
        
        await fs.ensureDir(path.dirname(finalApkPath));
        await fs.copy(generatedApk, finalApkPath);

        const endTime = new Date();
        const duration = Math.round((endTime - startTime) / 1000);
        const apkSize = (await fs.stat(finalApkPath)).size;

        await BuildLog.findByIdAndUpdate(buildId, {
            status: 'success',
            endTime,
            duration,
            size: apkSize,
            apkUrl: `/api/download-app-direct/${project.subdomain}/android`,
            logs: buildLogs
        });

        // Clean up raw workspace
        await fs.remove(buildWorkspace);
        console.log(`✅ Build successful for project: ${project.projectName}`);

    } catch (error) {
        console.error(`❌ Compilation failure:`, error);
        buildLogs += `\n[FATAL ERROR] Compilation failed: ${error.message}\n${error.stack}`;
        
        await BuildLog.findByIdAndUpdate(buildId, {
            status: 'failed',
            endTime: new Date(),
            logs: buildLogs
        });
        await fs.remove(buildWorkspace);
    }
}, { connection: { host: process.env.REDIS_HOST || '127.0.0.1', port: 6379 } });

module.exports = buildWorker;

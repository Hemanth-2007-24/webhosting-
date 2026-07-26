// =================================================================
// ==                  WebHost Platform Server                    ==
// =================================================================

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const simpleGit = require('simple-git');
const unzipper = require('unzipper');
const fs = require('fs-extra');
const cuid = require('cuid');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const { execFile } = require('child_process');

// --- APP & MIDDLEWARE SETUP ---
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- DATABASE CONNECTION ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- DATABASE MODELS ---
const UserSchema = new mongoose.Schema({ 
    email: { type: String, required: true, unique: true, trim: true, lowercase: true }, 
    password: { type: String, required: true },
    githubPat: { type: String, default: '' }
});

UserSchema.pre('save', async function(next) { if (this.isModified('password')) { this.password = await bcrypt.hash(this.password, 10); } next(); });
const User = mongoose.model('User', UserSchema);

const ProjectSchema = new mongoose.Schema({ 
    name: { type: String, required: true }, 
    subdomain: { type: String, required: true, unique: true }, 
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, 
    status: { type: String, enum: ['queued', 'deploying', 'ready', 'failed'], default: 'queued' },
    rootDir: { type: String, default: '' },
    
    // Local app compiler state properties
    appAndroidStatus: { type: String, enum: ['none', 'building', 'ready', 'failed'], default: 'none' },
    appWindowsStatus: { type: String, enum: ['none', 'building', 'ready', 'failed'], default: 'none' },
    appName: { type: String, default: '' }
}, { timestamps: true });

const Project = mongoose.model('Project', ProjectSchema);

// --- AUTH MIDDLEWARE ---
const authMiddleware = (req, res, next) => { 
    const authHeader = req.headers.authorization; 
    if (!authHeader || !authHeader.startsWith('Bearer ')) { 
        return res.status(401).json({ message: 'Authorization denied, no token provided.' }); 
    } 
    try { 
        const token = authHeader.split(' ')[1]; 
        const decoded = jwt.verify(token, process.env.JWT_SECRET); 
        req.user = decoded; 
        next(); 
    } catch (e) { 
        res.status(400).json({ message: 'Token is not valid.' }); 
    }
};

// --- DIRECTORIES & FILE UPLOAD ---
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DEPLOYMENTS_DIR = path.join(__dirname, 'deployments');
const APPS_DIR = path.join(__dirname, 'compiled_apps');

fs.ensureDirSync(UPLOADS_DIR); 
fs.ensureDirSync(DEPLOYMENTS_DIR); 
fs.ensureDirSync(APPS_DIR); 

const upload = multer({ dest: UPLOADS_DIR });

// --- SMART INDEX FINDER SYSTEM ---
async function findIndexHtmlRecursive(dir, currentDepth, maxDepth) {
    if (currentDepth > maxDepth) return null;
    const items = await fs.readdir(dir, { withFileTypes: true });
    
    // Check files in current folder first
    for (const item of items) {
        if (item.isFile() && item.name.toLowerCase() === 'index.html') {
            return dir;
        }
    }
    
    // Check nested folders, ignoring system folders
    for (const item of items) {
        if (item.isDirectory() && !['node_modules', '.git', '.github'].includes(item.name)) {
            const subPath = path.join(dir, item.name);
            const found = await findIndexHtmlRecursive(subPath, currentDepth + 1, maxDepth);
            if (found) return found;
        }
    }
    return null;
}

async function findIndexHtmlDir(basePath) { 
    // 1. Check root directory
    if (await fs.pathExists(path.join(basePath, 'index.html'))) { 
        return basePath; 
    } 
    
    // 2. Check common output build subdirectories
    const commonDirs = ['dist', 'build', 'public', 'out']; 
    for (const dir of commonDirs) { 
        const potentialPath = path.join(basePath, dir); 
        if (await fs.pathExists(path.join(potentialPath, 'index.html'))) { 
            return potentialPath; 
        } 
    } 
    
    // 3. Recursive lookup fallback (Up to 3 directories deep)
    try {
        const detectedPath = await findIndexHtmlRecursive(basePath, 0, 3);
        if (detectedPath) return detectedPath;
    } catch (error) {
        console.error("Smart Index Finder lookup error:", error);
    }
    
    return basePath; 
}

// --- PURE JS ZIP UTILITY COMPILER ---
function zipDirectory(sourceDir, outPath) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => {
            console.log(`[ZIPPER] Successfully packaged files. Size: ${archive.pointer()} bytes.`);
            resolve();
        });

        archive.on('warning', (err) => {
            if (err.code === 'ENOENT') {
                console.warn('[ZIPPER_WARN]', err);
            } else {
                reject(err);
            }
        });

        archive.on('error', (err) => reject(err));

        archive.pipe(output);
        archive.directory(sourceDir, false); 
        archive.finalize();
    });
}

// --- INITIALIZE GENERIC ANDROID WEBVIEW TEMPLATE APK ---
const TEMPLATE_APK_PATH = path.join(APPS_DIR, 'webview_base_template.apk');

// Robust download checker helper with promise resolution
async function ensureBaseApkTemplate() {
    if (!(await fs.pathExists(TEMPLATE_APK_PATH))) {
        console.log("📥 Baseline template APK missing or not yet cached. Fetching on demand from jsDelivr CDN...");
        const response = await fetch('https://cdn.jsdelivr.net/gh/mrepol742/web-appp@master/release/debug.apk');
        if (!response.ok) {
            throw new Error("Unable to retrieve baseline APK template from secure CDN.");
        }
        const buffer = await response.arrayBuffer();
        await fs.ensureDir(path.dirname(TEMPLATE_APK_PATH));
        await fs.writeFile(TEMPLATE_APK_PATH, Buffer.from(buffer));
        console.log("✅ Baseline APK template cached successfully.");
    }
}

// Trigger background download on server startup
ensureBaseApkTemplate().catch(err => console.error("⚠️ Background template pre-fetch failed:", err.message));

// --- OPTIONAL DEBUG SIGNING (only runs if a keystore + jarsigner are configured) ---
// APKs are validated against a signature block computed over the exact file bytes.
// Editing a signed template APK — even correctly, via a real zip writer — breaks
// that signature, so Android will refuse to install it ("app not installed")
// unless it gets re-signed. This project can't ship a private key, so signing is
// optional and only kicks in if you set these env vars on your own server
// (requires a JDK on PATH): DEBUG_KEYSTORE_PATH, DEBUG_KEYSTORE_PASS, DEBUG_KEY_ALIAS
function signApkIfConfigured(apkPath) {
    return new Promise((resolve) => {
        const keystore = process.env.DEBUG_KEYSTORE_PATH;
        const storePass = process.env.DEBUG_KEYSTORE_PASS;
        const alias = process.env.DEBUG_KEY_ALIAS || 'androiddebugkey';
        if (!keystore || !storePass) {
            console.warn('[APK_SIGN] No DEBUG_KEYSTORE_PATH/DEBUG_KEYSTORE_PASS configured — APK will be left unsigned and will need manual signing (jarsigner/apksigner) before install.');
            return resolve(false);
        }
        execFile('jarsigner', [
            '-verbose',
            '-sigalg', 'SHA256withRSA',
            '-digestalg', 'SHA-256',
            '-keystore', keystore,
            '-storepass', storePass,
            apkPath,
            alias
        ], (err) => {
            if (err) {
                console.error('[APK_SIGN] jarsigner failed, APK left unsigned:', err.message);
                return resolve(false);
            }
            console.log('[APK_SIGN] APK re-signed successfully with debug keystore.');
            resolve(true);
        });
    });
}

// --- REAL APK PATCHER ---
// Unlike naively concatenating bytes onto the raw APK file (which corrupts the
// zip's central directory and produces a file nothing can open), this opens the
// template as an actual zip, writes the config and any user-supplied assets as
// real entries, and re-serializes a valid archive.
async function buildAndroidApk({ targetUrl, appName, iconFilePath, extraFilePaths, outPath }) {
    await ensureBaseApkTemplate();
    if (!(await fs.pathExists(TEMPLATE_APK_PATH))) {
        throw new Error('Baseline template APK was not cached on server.');
    }

    const zip = new AdmZip(TEMPLATE_APK_PATH);

    // Config the WebView shell reads at runtime (a packaged asset, not appended bytes)
    const config = {
        url: targetUrl,
        title: appName,
        generatedAt: new Date().toISOString()
    };
    zip.addFile('assets/webhost_config.json', Buffer.from(JSON.stringify(config, null, 2), 'utf8'));

    if (iconFilePath && await fs.pathExists(iconFilePath)) {
        const iconBuffer = await fs.readFile(iconFilePath);
        zip.addFile('assets/webhost_icon.png', iconBuffer);
    }

    if (Array.isArray(extraFilePaths)) {
        for (const filePath of extraFilePaths) {
            if (!(await fs.pathExists(filePath))) continue;
            const safeName = path.basename(filePath).replace(/[^a-zA-Z0-9._-]/g, '_');
            const buffer = await fs.readFile(filePath);
            zip.addFile(`assets/user_files/${safeName}`, buffer);
        }
    }

    await fs.ensureDir(path.dirname(outPath));
    zip.writeZip(outPath);

    const signed = await signApkIfConfigured(outPath);
    return { signed };
}

// =================================================================
// ==                         API ROUTES                          ==
// =================================================================

app.post('/api/auth/register', async (req, res) => { 
    try { 
        const { email, password } = req.body; 
        if (!email || !password || password.length < 6) { 
            return res.status(400).json({ message: 'Invalid email or password (min 6 chars).' }); 
        } 
        if (await User.findOne({ email })) { 
            return res.status(400).json({ message: 'User with this email already exists.' }); 
        } 
        const user = new User({ email, password }); 
        await user.save(); 
        res.status(201).json({ message: 'User registered successfully.' }); 
    } catch (error) { 
        console.error("Register Error:", error); 
        res.status(500).json({ message: 'Server error during registration.' }); 
    }
});

app.post('/api/auth/login', async (req, res) => { 
    try { 
        const { email, password } = req.body; 
        const user = await User.findOne({ email }); 
        if (!user || !(await bcrypt.compare(password, user.password))) { 
            return res.status(400).json({ message: 'Invalid credentials.' }); 
        } 
        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' }); 
        res.json({ token }); 
    } catch (error) { 
        console.error("Login Error:", error); 
        res.status(500).json({ message: 'Server error during login.' }); 
    }
});

app.get('/api/user/pat', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        res.json({ pat: user ? user.githubPat || '' : '' });
    } catch (error) {
        console.error("Fetch PAT Error:", error);
        res.status(500).json({ message: 'Server error fetching GitHub PAT.' });
    }
});

app.post('/api/user/pat', authMiddleware, async (req, res) => {
    try {
        const { pat } = req.body;
        await User.findByIdAndUpdate(req.user.id, { githubPat: pat || '' });
        res.json({ message: 'GitHub PAT updated successfully.' });
    } catch (error) {
        console.error("Save PAT Error:", error);
        res.status(500).json({ message: 'Server error saving GitHub PAT.' });
    }
});

app.get('/api/user/repos', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user || !user.githubPat) {
            return res.status(400).json({ message: 'GitHub Personal Access Token not configured.' });
        }
        
        const response = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
            headers: {
                'Authorization': `token ${user.githubPat}`,
                'User-Agent': 'WebHost-Platform'
            }
        });

        if (!response.ok) {
            const errText = await response.text();
            return res.status(response.status).json({ message: `GitHub API error: ${errText}` });
        }

        const repos = await response.json();
        
        if (!Array.isArray(repos)) {
            return res.status(400).json({ message: repos.message || 'Unable to load repositories. Verify PAT scope details.' });
        }

        const simplifiedRepos = repos.map(repo => ({
            name: repo.full_name,
            clone_url: repo.clone_url,
            private: repo.private
        }));

        res.json(simplifiedRepos);
    } catch (error) {
        console.error("Fetch User Repos Error:", error);
        res.status(500).json({ message: 'Server error fetching user repositories.' });
    }
});

app.post('/api/projects', authMiddleware, async (req, res) => { 
    try { 
        const { name } = req.body; 
        if (!name || name.trim().length < 3) { 
            return res.status(400).json({ message: 'Project name must be at least 3 characters.' }); 
        } 
        const subdomain = name.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20) + '-' + cuid.slug(); 
        if (await Project.findOne({ subdomain })) { 
            return res.status(400).json({ message: 'A project with a similar name already exists.' }); 
        } 
        const project = new Project({ name, subdomain, owner: req.user.id, status: 'queued' }); 
        await project.save(); 
        res.status(201).json(project); 
    } catch (error) { 
        console.error("Create Project Error:", error); 
        res.status(500).json({ message: 'Server error creating project.' }); 
    }
});

app.get('/api/projects', authMiddleware, async (req, res) => { 
    try { 
        const projects = await Project.find({ owner: req.user.id }).sort({ createdAt: -1 }); 
        res.json(projects); 
    } catch (error) { 
        console.error("Get Projects Error:", error); 
        res.status(500).json({ message: 'Server error fetching projects.' }); 
    }
});

app.delete('/api/projects/:id', authMiddleware, async (req, res) => { 
    try { 
        const projectId = req.params.id; 
        const project = await Project.findById(projectId); 
        if (!project) { 
            return res.status(404).json({ message: 'Project not found.' }); 
        } 
        if (project.owner.toString() !== req.user.id) { 
            return res.status(403).json({ message: 'Forbidden: You do not own this project.' }); 
        } 
        const projectDeployPath = path.join(DEPLOYMENTS_DIR, project.id); 
        await fs.remove(projectDeployPath); 
        console.log(`[${project.name}] --> Files deleted from disk at ${projectDeployPath}`); 
        await Project.findByIdAndDelete(projectId); 
        console.log(`[${project.name}] --> Record deleted from database.`); 
        res.status(204).send(); 
    } catch (error) { 
        console.error("Delete Project Error:", error); 
        res.status(500).json({ message: 'Server error while deleting project.' }); 
    }
});

app.post('/api/deploy', authMiddleware, upload.single('file'), async (req, res) => { 
    const { projectId, gitURL, rootDir } = req.body; 
    let project; 
    try { 
        project = await Project.findById(projectId); 
        if (!project || project.owner.toString() !== req.user.id) { 
            return res.status(404).json({ message: 'Project not found or you are not the owner.' }); 
        } 
        
        const normalizedRootDir = rootDir !== undefined ? rootDir.trim() : project.rootDir;
        await project.updateOne({ status: 'deploying', rootDir: normalizedRootDir }); 
        console.log(`[${project.name}] --> Deployment started.`); 
        res.status(202).json({ message: 'Deployment accepted and is in progress.' }); 
        
        const projectDeployPath = path.join(DEPLOYMENTS_DIR, project.id); 
        console.log(`[${project.name}] STEP 1: Cleaning up old deployment at ${projectDeployPath}`); 
        await fs.ensureDir(projectDeployPath); 
        await fs.emptyDir(projectDeployPath); 
        
        if (gitURL) { 
            console.log(`[${project.name}] STEP 2: Preparing cloning URL.`); 
            const tempCloneDir = path.join(UPLOADS_DIR, `_temp_git_${project.id}`); 
            await fs.emptyDir(tempCloneDir); 
            
            const user = await User.findById(req.user.id); 
            const pat = user ? user.githubPat : ''; 
            let cloneURL = gitURL; 
            
            if (pat && gitURL.includes('github.com')) { 
                if (gitURL.startsWith('https://')) { 
                    cloneURL = gitURL.replace('https://', `https://${pat}@`); 
                } else if (!gitURL.startsWith('http')) { 
                    cloneURL = `https://${pat}@github.com/${gitURL.replace(/^github\.com\//, '')}`; 
                } 
            } 
            
            console.log(`[${project.name}] ... Cloning repository.`); 
            await simpleGit().clone(cloneURL, tempCloneDir, { '--depth': 1 }); 
            console.log(`[${project.name}] ... Git clone successful.`); 
            
            // Resolve starting path cleanly
            let startPath = tempCloneDir;
            if (normalizedRootDir) {
                const resolvedPath = path.resolve(tempCloneDir, normalizedRootDir);
                if (!resolvedPath.startsWith(tempCloneDir)) {
                    throw new Error("Security Violation: Target path escapes deployment directory.");
                }
                startPath = resolvedPath;
                if (!(await fs.pathExists(startPath))) {
                    throw new Error(`The configured root directory '${normalizedRootDir}' does not exist inside the repository.`);
                }
            }
            
            // Run Smart Index Finder starting from the resolved start folder
            const sourceDir = await findIndexHtmlDir(startPath);
            
            console.log(`[${project.name}] STEP 3: Deploying from directory containing index.html: ${sourceDir}`); 
            await fs.copy(sourceDir, projectDeployPath); 
            console.log(`[${project.name}] STEP 4: Copied files to final deployment directory.`); 
            await fs.remove(tempCloneDir); 
        } else if (req.file) { 
            console.log(`[${project.name}] STEP 2: Preparing extraction workspace.`); 
            const tempExtractDir = path.join(UPLOADS_DIR, `_temp_zip_${project.id}`); 
            await fs.ensureDir(tempExtractDir); 
            await fs.emptyDir(tempExtractDir); 

            // Extract file using standard promise open file methods
            console.log(`[${project.name}] ... Extracting zip archive.`); 
            const zipArchive = await unzipper.Open.file(req.file.path);
            await zipArchive.extract({ path: tempExtractDir });
            console.log(`[${project.name}] ... Unzip successful.`); 
            await fs.remove(req.file.path); 

            // Resolve target directory path
            let startPath = tempExtractDir;
            if (normalizedRootDir) {
                const resolvedPath = path.resolve(tempExtractDir, normalizedRootDir);
                if (!resolvedPath.startsWith(tempExtractDir)) {
                    throw new Error("Security Violation: Target path escapes deployment directory.");
                }
                startPath = resolvedPath;
                if (!(await fs.pathExists(startPath))) {
                    throw new Error(`The configured root directory '${normalizedRootDir}' does not exist inside the archive.`);
                }
            }

            // Run Smart Index Finder on Zip exactly like Git workflow
            const sourceDir = await findIndexHtmlDir(startPath);
            console.log(`[${project.name}] STEP 3: Deploying from directory containing index.html: ${sourceDir}`); 
            await fs.copy(sourceDir, projectDeployPath); 
            console.log(`[${project.name}] STEP 4: Copied files to final deployment directory.`); 
            await fs.remove(tempExtractDir); 
        } else { 
            throw new Error("No Git URL or file was provided for deployment."); 
        } 
        await project.updateOne({ status: 'ready' }); 
        console.log(`[${project.name}] --> ✅ Deployment Succeeded. Status set to 'ready'.`); 
    } catch (error) { 
        console.error(`[${project ? project.name : projectId}] --> ❌ Critical deployment failure:`, error.message); 
        console.error(error.stack); 
        if (project) { 
            await project.updateOne({ status: 'failed' }); 
            console.log(`[${project.name}] ... Status updated to 'failed'.`); 
        } 
    }
});

// --- NATIVE WEBVIEW APP COMPILER ROUTE (APK CONFIG INJECTION & SILENT VBS BUNDLING) ---
app.post('/api/projects/:id/build-app', authMiddleware, upload.fields([{ name: 'icon', maxCount: 1 }, { name: 'files', maxCount: 10 }]), async (req, res) => {
    const { platform, appName } = req.body;
    const iconFile = req.files && req.files.icon ? req.files.icon[0] : null;
    const extraFiles = (req.files && req.files.files) || [];
    const projectId = req.params.id;

    if (!platform || !['android', 'windows'].includes(platform)) {
        return res.status(400).json({ message: 'Invalid platform configuration.' });
    }

    const cleanAppName = (appName || 'Web Launcher').trim();
    if (cleanAppName.length < 2) {
        return res.status(400).json({ message: 'Application name is too short.' });
    }

    try {
        const project = await Project.findById(projectId);
        if (!project || project.owner.toString() !== req.user.id) {
            return res.status(404).json({ message: 'Instance not found or unauthorized.' });
        }

        const updateField = platform === 'android' ? { appAndroidStatus: 'building', appName: cleanAppName } : { appWindowsStatus: 'building', appName: cleanAppName };
        await Project.findByIdAndUpdate(projectId, updateField);

        console.log(`[${project.name}] --> Compiling borderless native WebView container for: ${platform}`);
        res.status(202).json({ message: 'Native WebView compilation sequence active.' });

        // Background compile task
        setTimeout(async () => {
            const finalPackagePath = path.join(APPS_DIR, `${project.subdomain}_${platform}`);
            
            try {
                const targetProjectUrl = `${req.protocol}://${req.get('host')}/${project.subdomain}`;

                if (platform === 'windows') {
                    // Create silent native VBScript wrapper directly to run natively without EXE header errors
                    const vbsScript = `Set WshShell = CreateObject("WScript.Shell")\nWshShell.Run "msedge.exe --app=${targetProjectUrl} --window-size=1280,800", 0, false\n`;
                    await fs.outputFile(`${finalPackagePath}.vbs`, vbsScript);
                    
                    await Project.findByIdAndUpdate(projectId, { appWindowsStatus: 'ready' });
                    console.log(`[${project.name}] Windows Desktop launcher VBS compiled successfully.`);

                } else if (platform === 'android') {
                    // Proper zip-level patch — writes real entries instead of
                    // corrupting the archive by appending raw bytes to the end.
                    const { signed } = await buildAndroidApk({
                        targetUrl: targetProjectUrl,
                        appName: cleanAppName,
                        iconFilePath: iconFile ? iconFile.path : null,
                        extraFilePaths: extraFiles.map(f => f.path),
                        outPath: `${finalPackagePath}.apk`
                    });

                    await Project.findByIdAndUpdate(projectId, { appAndroidStatus: 'ready' });
                    console.log(`[${project.name}] Android WebView APK compiled successfully.${signed ? '' : ' (unsigned — configure DEBUG_KEYSTORE_PATH to auto-sign)'}`);
                }

                if (iconFile) await fs.remove(iconFile.path);
                for (const f of extraFiles) await fs.remove(f.path);
            } catch (err) {
                console.error(`Native App Compilation failure for project ${project.name}:`, err);
                const failField = platform === 'android' ? { appAndroidStatus: 'failed' } : { appWindowsStatus: 'failed' };
                await Project.findByIdAndUpdate(projectId, failField);
                if (iconFile) await fs.remove(iconFile.path).catch(() => {});
                for (const f of extraFiles) await fs.remove(f.path).catch(() => {});
            }
        }, 10000);

    } catch (err) {
        console.error("App Build Request failure:", err);
        res.status(500).json({ message: 'Internal Server Error.' });
    }
});

// --- D_I_R_E_C_T WEB-TO-APP STANDALONE CONVERTER ROUTE ---
app.post('/api/build-app-direct', authMiddleware, upload.fields([{ name: 'icon', maxCount: 1 }, { name: 'files', maxCount: 10 }]), async (req, res) => {
    const { url, platform, appName } = req.body;
    const iconFile = req.files && req.files.icon ? req.files.icon[0] : null;
    const extraFiles = (req.files && req.files.files) || [];

    if (!url || !platform || !appName) {
        return res.status(400).json({ message: 'Missing app compiling parameters.' });
    }

    const cleanAppName = appName.trim();
    if (cleanAppName.length < 2) {
        return res.status(400).json({ message: 'Application name is too short.' });
    }

    const appFilename = `direct_${cuid()}_${platform}`;
    const finalPackagePath = path.join(APPS_DIR, appFilename);

    try {
        console.log(`[DIRECT_BUILD] --> Compiling native WebView wrapper directly for URL: ${url}`);

        if (platform === 'windows') {
            const vbsScript = `Set WshShell = CreateObject("WScript.Shell")\nWshShell.Run "msedge.exe --app=${url} --window-size=1280,800", 0, false\n`;
            await fs.outputFile(`${finalPackagePath}.vbs`, vbsScript);
            console.log(`[DIRECT_BUILD] Direct VBScript launcher packaged successfully.`);
        } else if (platform === 'android') {
            // Proper zip-level patch — see buildAndroidApk() for why raw byte
            // appending was corrupting every APK produced by this route.
            const { signed } = await buildAndroidApk({
                targetUrl: url,
                appName: cleanAppName,
                iconFilePath: iconFile ? iconFile.path : null,
                extraFilePaths: extraFiles.map(f => f.path),
                outPath: `${finalPackagePath}.apk`
            });
            console.log(`[DIRECT_BUILD] Direct Android WebView APK compiled successfully.${signed ? '' : ' (unsigned)'}`);
        }

        if (iconFile) await fs.remove(iconFile.path);
        for (const f of extraFiles) await fs.remove(f.path);

        const downloadUrl = `/api/download-app-direct/${appFilename}/${platform}`;
        res.json({ downloadUrl });
    } catch (err) {
        console.error("Direct app compilation failure:", err);
        if (iconFile) await fs.remove(iconFile.path).catch(() => {});
        for (const f of extraFiles) await fs.remove(f.path).catch(() => {});
        res.status(500).json({ message: 'App compilation pipeline failed.' });
    }
});

// --- DOWNLOAD DIRECTLY COMPILED NATIVE APP PACKAGES WITH CUSTOM USER FILENAMES ---
app.get('/api/download-app-direct/:filename/:platform', async (req, res) => {
    const { filename, platform } = req.params;
    const extension = platform === 'android' ? '.apk' : '.vbs';
    const absoluteFilePath = path.join(APPS_DIR, filename + extension);

    if (!(await fs.pathExists(absoluteFilePath))) {
        return res.status(404).send('Compiled application binary package was not found.');
    }

    // Sanitize and use custom name if passed in query parameters
    const customAppName = req.query.name || 'compiled_launcher';
    const cleanDownloadName = customAppName.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
    
    res.download(absoluteFilePath, `${cleanDownloadName}${extension}`);
});

// --- DOWNLOAD COMPILED NATIVE APP PACKAGES WITH CUSTOM INSTANCE APP FILENAMES ---
app.get('/api/projects/:id/download-app/:platform', async (req, res) => {
    const projectId = req.params.id;
    const platform = req.params.platform;

    if (!['android', 'windows'].includes(platform)) {
        return res.status(400).send('Invalid platform parameters.');
    }

    try {
        const project = await Project.findById(projectId);
        if (!project) return res.status(404).send('Project instance mapping does not exist.');

        const extension = platform === 'android' ? '.apk' : '.vbs';
        const absoluteFilePath = path.join(APPS_DIR, `${project.subdomain}_${platform}${extension}`);

        if (!(await fs.pathExists(absoluteFilePath))) {
            return res.status(404).send('Compiled application binary package was not found.');
        }

        // Sanitize and use the specific appName or projectName configured on project card
        const customAppName = project.appName || project.name;
        const cleanDownloadName = customAppName.trim().replace(/[^a-zA-Z0-9_-]/g, '_');

        res.download(absoluteFilePath, `${cleanDownloadName}${extension}`);
    } catch (err) {
        console.error("Download delivery failure:", err);
        res.status(500).send('Server Error.');
    }
});

// =================================================================
// ==      PATH-BASED ROUTING & SERVING LOGIC                     ==
// =================================================================
app.use(async (req, res, next) => { 
    if (req.path.startsWith('/api/')) return next(); 
    const projectIdentifier = req.path.split('/')[1]; 
    if (!projectIdentifier) return next(); 
    try { 
        const project = await Project.findOne({ subdomain: projectIdentifier, status: 'ready' }); 
        if (project) { 
            const projectPath = path.join(DEPLOYMENTS_DIR, project.id); 
            req.url = req.url.replace(`/${projectIdentifier}`, '') || '/'; 
            return express.static(projectPath)(req, res, (err) => { 
                res.sendFile(path.join(projectPath, 'index.html')); 
            }); 
        } 
        return next(); 
    } catch (error) { 
        console.error("Path-based Proxy Error:", error); 
        return res.status(500).send('Server error.'); 
    }
});

app.use(express.static(path.join(__dirname, '/')));

app.get('*', (req, res) => { 
    res.sendFile(path.join(__dirname, 'index.html')); 
});

// --- SERVER START ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
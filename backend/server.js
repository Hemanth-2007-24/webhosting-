// =================================================================
// ==                       server.js                             ==
// =================================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const mongoose = require('mongoose');
const cuid = require('cuid');
const unzipper = require('unzipper');
const simpleGit = require('simple-git');
const archiver = require('archiver');

// --- CRITICAL UNCAUGHT EXCEPTION SAFETY HANDLERS ---
process.on('uncaughtException', (err) => {
    console.error('🔥 CRITICAL UNCAUGHT EXCEPTION ENCOUNTERED:');
    console.error(err.message);
    console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ UNHANDLED PROMISE REJECTION:');
    console.error(reason);
});

const app = express();

// --- CRITICAL SAFE-BOOT INITIALIZATION CHECK ---
const PORT = process.env.PORT || 8080;

if (!process.env.MONGO_URI) {
    console.warn("⚠️ WARNING: MONGO_URI environment variable is missing!");
    console.warn("Please add MONGO_URI to your Back4App Container environment variables.");
    
    app.get('*', (req, res) => {
        res.status(500).send(`
            <h1>WebHost is in Safe Mode</h1>
            <p><strong>Config Error:</strong> MONGO_URI is missing from your environment variables.</p>
        `);
    });
    
    app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Safe Mode server successfully listening on port ${PORT}`));
    return; 
}

// --- DATABASE CONNECTION ---
const { connectDatabase, User, Project, Build, Log } = require('./database');
const { CloudinaryService, SecurityService, PackageNameService, LoggerService } = require('./services');
const { BuildEngine } = require('./buildEngine');

connectDatabase(process.env.MONGO_URI);

// --- SECURITY MIDDLEWARES ---
app.use(helmet({
    contentSecurityPolicy: false, 
    crossOriginEmbedderPolicy: false
}));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Global Rate Limiting
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100,
    message: "Too many requests from this IP. Please try again later."
});
app.use(globalLimiter);

// File Upload configuration
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.ensureDirSync(UPLOADS_DIR);
const upload = multer({ dest: UPLOADS_DIR });

// --- JWT AUTHENTICATION MIDDLEWARE ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: "Access Token missing." });

    jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret_key', (err, user) => {
        if (err) return res.status(403).json({ message: "Invalid or expired session token." });
        req.user = user;
        next();
    });
};

// --- SMART INDEX FINDER SYSTEM ---
async function findIndexHtmlRecursive(dir, currentDepth, maxDepth) {
    if (currentDepth > maxDepth) return null;
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
        if (item.isFile() && item.name.toLowerCase() === 'index.html') {
            return dir;
        }
    }
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
    if (await fs.pathExists(path.join(basePath, 'index.html'))) { 
        return basePath; 
    } 
    const commonDirs = ['dist', 'build', 'public', 'out']; 
    for (const dir of commonDirs) {
        const potentialPath = path.join(basePath, dir); 
        if (await fs.pathExists(path.join(potentialPath, 'index.html'))) { 
            return potentialPath; 
        } 
    } 
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

// --- AUTOMATED ANDROID WEBVIEW TEMPLATE RESOLVER & CREATOR ---
const APPS_DIR = path.join(__dirname, 'compiled_apps');
const TEMPLATE_APK_PATH = path.join(APPS_DIR, 'webview_base_template.apk');
const LOCAL_TEMPLATE_SOURCE = path.join(__dirname, 'your-template.apk');

async function ensureBaseApkTemplate() {
    if (await fs.pathExists(TEMPLATE_APK_PATH)) {
        if (!(await fs.pathExists(LOCAL_TEMPLATE_SOURCE))) {
            await fs.copy(TEMPLATE_APK_PATH, LOCAL_TEMPLATE_SOURCE);
        }
        return;
    }

    if (await fs.pathExists(LOCAL_TEMPLATE_SOURCE)) {
        console.log("📥 Copying local 'your-template.apk' from root workspace to compiler cache...");
        await fs.ensureDir(path.dirname(TEMPLATE_APK_PATH));
        await fs.copy(LOCAL_TEMPLATE_SOURCE, TEMPLATE_APK_PATH);
        console.log("✅ Local APK template copied successfully.");
        return;
    }

    try {
        const fallbackUrl = 'https://raw.githubusercontent.com/bishwassagar/Android-Webview-App/master/app/release/app-release.apk';
        console.log(`📥 Base template missing. Downloading baseline APK template from secure fallback repository: ${fallbackUrl}`);
        
        const response = await fetch(fallbackUrl);
        if (!response.ok) {
            throw new Error(`Fallback repository returned HTTP status: ${response.status}`);
        }
        
        const buffer = await response.arrayBuffer();
        await fs.ensureDir(path.dirname(TEMPLATE_APK_PATH));
        await fs.writeFile(TEMPLATE_APK_PATH, Buffer.from(buffer));
        await fs.copy(TEMPLATE_APK_PATH, LOCAL_TEMPLATE_SOURCE);
        console.log("✅ Baseline APK template compiled and cached successfully both in workspace and root directory.");
    } catch (err) {
        console.error("❌ Failed to resolve baseline APK template:", err.message);
        throw new Error("Unable to retrieve baseline APK template. Please place a valid APK inside your root folder named 'your-template.apk' and push via Git.");
    }
}

ensureBaseApkTemplate().catch(err => console.error("⚠️ Background template check skipped:", err.message));

// --- DEFENSIVE ZIP EXTRACTION PIPELINE (Anti-Zip Bomb & Path Traversal) ---
async function extractZipSafely(zipPath, targetDir) {
    const MAX_TOTAL_SIZE = 50 * 1024 * 1024; // 50MB Maximum Uncompressed Size
    const MAX_FILES_COUNT = 1000;            // 1,000 files maximum limit
    const FORBIDDEN_EXTENSIONS = ['.exe', '.dll', '.bat', '.vbs', '.sh', '.apk', '.jar', '.php', '.jsp', '.asp'];

    const zip = await unzipper.Open.file(zipPath);
    let totalSize = 0;
    let fileCount = 0;

    // Step 1: Pre-extraction validation (Scans metadata to prevent Zip Bombs)
    for (const file of zip.files) {
        fileCount++;
        if (fileCount > MAX_FILES_COUNT) {
            throw new Error(`Security Violation: Archive contains too many files (Max Limit: ${MAX_FILES_COUNT}).`);
        }

        totalSize += file.uncompressedSize;
        if (totalSize > MAX_TOTAL_SIZE) {
            throw new Error(`Security Violation: Decompressed archive size exceeds safety threshold limit of 50MB.`);
        }

        // Prevention: Decompression Ratio Validation (Busts 42.zip or dense payloads)
        const compressionRatio = file.uncompressedSize / (file.compressedSize || 1);
        if (file.uncompressedSize > 1024 * 1024 && compressionRatio > 100) {
            throw new Error(`Security Violation: Unusually high compression ratio detected (${compressionRatio.toFixed(1)}x). Archive flagged as potential Zip Bomb.`);
        }

        // Prevention: Malicious executable files extension blocker
        const ext = path.extname(file.path).toLowerCase();
        if (FORBIDDEN_EXTENSIONS.includes(ext)) {
            throw new Error("Security Violation: Unauthorized file type '" + ext + "' found inside archive.");
        }
    }

    // Step 2: Extraction execution with strict path boundary checking
    for (const file of zip.files) {
        if (file.type === 'Directory') continue;

        const resolvedPath = path.resolve(targetDir, file.path);
        
        // Prevention: Path Traversal boundary check
        if (!resolvedPath.startsWith(targetDir)) {
            throw new Error(`Security Violation: Attempted directory traversal outside target workspace.`);
        }

        // Write file safely
        await fs.ensureDir(path.dirname(resolvedPath));
        await new Promise((resolve, reject) => {
            file.stream()
                .pipe(fs.createWriteStream(resolvedPath))
                .on('finish', resolve)
                .on('error', reject);
        });
    }
}

// =================================================================
// ==                     AUTH API ENDPOINTS                      ==
// =================================================================

app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password || password.length < 6) {
            return res.status(400).json({ message: "Invalid email structure or password length (min 6 chars)." });
        }

        const existing = await User.findOne({ email });
        if (existing) return res.status(400).json({ message: "User account already exists." });

        // Auto-promote user to administrator if matching the env configuration
        const role = email.toLowerCase() === (process.env.ADMIN_EMAIL || '').toLowerCase() ? 'admin' : 'user';

        const user = new User({ email, password, role });
        await user.save();
        await LoggerService.log('USER_REGISTERED', `Registered Account: ${email} | Role: ${role}`, user._id);
        res.status(201).json({ message: "User account created successfully." });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(400).json({ message: "Invalid email or credentials." });
        }

        // Dynamic Admin Promotion: If an existing user matches ADMIN_EMAIL but is not yet marked as 'admin', promote them automatically on login.
        if (email.toLowerCase() === (process.env.ADMIN_EMAIL || '').toLowerCase() && user.role !== 'admin') {
            user.role = 'admin';
            await user.save();
            console.log(`[ADMIN_PROMOTION] Successfully promoted existing user ${email} to admin role.`);
        }

        const accessToken = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET || 'fallback_secret_key', { expiresIn: '1h' });
        const refreshToken = jwt.sign({ id: user._id }, process.env.REFRESH_SECRET || 'refresh_secret_key', { expiresIn: '7d' });

        user.refreshToken = refreshToken;
        await user.save();

        await LoggerService.log('USER_LOGIN', `Logged In Account: ${email}`, user._id);
        res.json({ accessToken, refreshToken });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.post('/api/auth/refresh', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(401).json({ message: "Refresh Token missing." });
    try {
        const user = await User.findOne({ refreshToken: token });
        if (!user) return res.status(403).json({ message: "Invalid session." });

        jwt.verify(token, process.env.REFRESH_SECRET || 'refresh_secret_key', (err, decoded) => {
            if (err) return res.status(403).json({ message: "Session expired." });
            const accessToken = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET || 'fallback_secret_key', { expiresIn: '1h' });
            res.json({ accessToken });
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.post('/api/auth/logout', authenticateToken, async (req, res) => {
    try {
        await User.findByIdAndUpdate(req.user.id, { refreshToken: '' });
        res.json({ message: "Logged out cleanly." });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// =================================================================
// ==                   PROJECT API ENDPOINTS                     ==
// =================================================================

app.post('/api/projects', authenticateToken, async (req, res) => {
    try {
        const name = req.body.projectName || req.body.name;
        const websiteUrl = req.body.websiteUrl || 'https://o4dhomepage.onrender.com/c.html';
        const platform = req.body.platform || 'android';

        if (!name || name.trim().length < 3) {
            return res.status(400).json({ message: "Project name must be at least 3 characters." });
        }

        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ message: "Creator account not found." });

        const username = user.email.split('@')[0].toLowerCase().replace(/[^a-z0-9-]/g, '');
        const containerName = name.toLowerCase().replace(/[^a-z0-9-]/g, '');
        const subdomain = `${username}-${containerName}`;

        const appName = req.body.appName || name;
        const packageName = PackageNameService.generatePackageName(appName);

        const project = new Project({
            projectName: name,
            subdomain,
            websiteUrl,
            packageName,
            appName,
            platform,
            themeColor: req.body.themeColor || '#6366F1',
            permissions: req.body.permissions || { internet: true },
            createdBy: req.user.id,
            status: 'ready'
        });

        await project.save();
        await LoggerService.log('PROJECT_CREATED', `Project ${name} initiated.`, req.user.id, project._id);
        res.status(201).json(project);
    } catch (err) {
        console.error("Create Project Error:", err);
        res.status(500).json({ message: err.message });
    }
});

app.get('/api/projects', authenticateToken, async (req, res) => {
    try {
        const filter = { createdBy: req.user.id, isArchived: false };
        if (req.query.search) {
            filter.projectName = { $regex: req.query.search, $options: 'i' };
        }
        const projects = await Project.find(filter).sort({ createdAt: -1 });
        res.json(projects);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.get('/api/projects/:id', authenticateToken, async (req, res) => {
    try {
        const project = await Project.findOne({ _id: req.params.id, createdBy: req.user.id });
        if (!project) return res.status(404).json({ message: "Project not found." });
        res.json(project);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.put('/api/projects/:id', authenticateToken, async (req, res) => {
    try {
        const updated = await Project.findOneAndUpdate(
            { _id: req.params.id, createdBy: req.user.id },
            req.body,
            { new: true }
        );
        if (!updated) return res.status(404).json({ message: "Project not found." });
        res.json(updated);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.delete('/api/projects/:id', authenticateToken, async (req, res) => {
    try {
        const deleted = await Project.findOneAndDelete({ _id: req.params.id, createdBy: req.user.id });
        if (!deleted) return res.status(404).json({ message: "Project not found." });
        res.json({ message: "Project deleted permanently." });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// --- CLOUDINARY UPLOADS ON PROJECTS ---
app.post('/api/projects/:id/upload-assets', authenticateToken, upload.fields([{ name: 'icon' }, { name: 'splash' }]), async (req, res) => {
    try {
        const project = await Project.findOne({ _id: req.params.id, createdBy: req.user.id });
        if (!project) return res.status(404).json({ message: "Project not found." });

        if (req.files['icon']) {
            const iconRes = await CloudinaryService.uploadImage(req.files['icon'][0].path, 'icons');
            project.iconUrl = iconRes.url;
            await fs.remove(req.files['icon'][0].path);
        }

        if (req.files['splash']) {
            const splashRes = await CloudinaryService.uploadImage(req.files['splash'][0].path, 'splashes');
            project.splashUrl = splashRes.url;
            await fs.remove(req.files['splash'][0].path);
        }

        await project.save();
        res.json(project);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// =================================================================
// ==                 CUSTOM CODE API ENDPOINTS                   ==
// =================================================================

app.post('/api/project/:id/custom-code', authenticateToken, async (req, res) => {
    try {
        const { customCode } = req.body;
        const sanitized = SecurityService.sanitizeCustomCode(customCode);

        const project = await Project.findOneAndUpdate(
            { _id: req.params.id, createdBy: req.user.id },
            { customCode: sanitized },
            { new: true }
        );
        if (!project) return res.status(404).json({ message: "Project instance invalid." });

        await LoggerService.log('CUSTOM_CODE_UPDATE', `Injected code saved on project: ${project.projectName}`, req.user.id, project._id);
        res.json({ message: "Custom Code injected and verified.", project });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

app.get('/api/project/:id/custom-code', authenticateToken, async (req, res) => {
    try {
        const project = await Project.findOne({ _id: req.params.id, createdBy: req.user.id });
        if (!project) return res.status(404).json({ message: "Project instance invalid." });
        res.json({ customCode: project.customCode });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.delete('/api/project/:id/custom-code', authenticateToken, async (req, res) => {
    try {
        const project = await Project.findOneAndUpdate(
            { _id: req.params.id, createdBy: req.user.id },
            { customCode: '' },
            { new: true }
        );
        if (!project) return res.status(404).json({ message: "Project instance invalid." });
        res.json({ message: "Custom Code cleared successfully.", project });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// =================================================================
// ==               USER PROFILE / CREDENTIAL DETAILS             ==
// =================================================================

app.get('/api/user/pat', authenticateToken, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        res.json({ pat: user ? user.githubPat || '' : '' });
    } catch (error) {
        console.error("Fetch PAT Error:", error);
        res.status(500).json({ message: 'Server error fetching GitHub PAT.' });
    }
});

app.post('/api/user/pat', authenticateToken, async (req, res) => {
    try {
        const { pat } = req.body;
        await User.findByIdAndUpdate(req.user.id, { githubPat: pat || '' });
        res.json({ message: 'GitHub PAT updated successfully.' });
    } catch (error) {
        console.error("Save PAT Error:", error);
        res.status(500).json({ message: 'Server error saving GitHub PAT.' });
    }
});

app.get('/api/user/repos', authenticateToken, async (req, res) => {
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

// =================================================================
// ==            COMPILER API (PWA & WINDOWS GENERATORS)          ==
// =================================================================

app.post('/api/projects/:id/build-app', authenticateToken, upload.single('icon'), async (req, res) => {
    const { platform, appName } = req.body;
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

        console.log(`[${project.name}] --> Packaging PWA/Windows container for: ${platform}`);
        res.status(202).json({ message: 'WebView compilation sequence active.' });

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
                    // Compile fully functional, ready-to-deploy Progressive Web Application (PWA) Zip Container
                    const tempWorkspace = path.join(UPLOADS_DIR, `_app_compile_${project.id}_pwa`);
                    await fs.ensureDir(tempWorkspace);
                    await fs.emptyDir(tempWorkspace);

                    const manifest = {
                        name: cleanAppName,
                        short_name: cleanAppName,
                        start_url: targetProjectUrl,
                        display: "standalone",
                        background_color: project.themeColor || "#050816",
                        theme_color: project.themeColor || "#6366F1",
                        icons: [
                            { src: "icon.png", sizes: "192x192", type: "image/png" },
                            { src: "icon.png", sizes: "512x512", type: "image/png" }
                        ]
                    };

                    const serviceWorker = `
                        const CACHE_NAME = 'webhost-pwa-cache-v1';
                        const urlsToCache = ['/', '/index.html'];

                        self.addEventListener('install', event => {
                            event.waitUntil(
                                caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
                            );
                        });

                        self.addEventListener('fetch', event => {
                            event.respondWith(
                                caches.match(event.request).then(response => {
                                    return response || fetch(event.request);
                                })
                            );
                        });
                    `;

                    const indexHtml = `
                        <!DOCTYPE html>
                        <html lang="en">
                        <head>
                            <meta charset="UTF-8">
                            <meta name="viewport" content="width=device-width, initial-scale=1.0">
                            <title>${cleanAppName}</title>
                            <link rel="manifest" href="manifest.json">
                            <meta name="theme-color" content="${project.themeColor || '#6366F1'}">
                            <script>
                                if ('serviceWorker' in navigator) {
                                    window.addEventListener('load', () => {
                                        navigator.serviceWorker.register('sw.js')
                                            .then(reg => console.log('Service Worker registered'))
                                            .catch(err => console.log('Service Worker failed', err));
                                    });
                                }
                            </script>
                            <style>
                                body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background-color: ${project.themeColor || '#050816'}; }
                                iframe { border: none; width: 100%; height: 100%; }
                            </style>
                        </head>
                        <body>
                            <iframe src="${targetProjectUrl}"></iframe>
                        </body>
                        </html>
                    `;

                    const readme = `WebHost Progressive Web App (PWA): ${cleanAppName}\n==================================================\n\n- Extract these files into your static project deployment folder on WebHost.\n- Ensure your custom icon is saved as "icon.png" in the same folder.\n- Redeploy your static site to activate PWA support.\n`;

                    await fs.outputJson(path.join(tempWorkspace, 'manifest.json'), manifest);
                    await fs.outputFile(path.join(tempWorkspace, 'sw.js'), serviceWorker);
                    await fs.outputFile(path.join(tempWorkspace, 'index.html'), indexHtml);
                    await fs.outputFile(path.join(tempWorkspace, 'README.txt'), readme);

                    if (req.file) {
                        await fs.copy(req.file.path, path.join(tempWorkspace, 'icon.png'));
                    } else {
                        await fs.outputFile(path.join(tempWorkspace, 'icon.png'), 'MOCK_ICON');
                    }

                    // Zip files together into final APK-mapped .zip package
                    await zipDirectory(tempWorkspace, `${finalPackagePath}.apk`); // Maintained as .apk path internally to prevent breaks
                    await Project.findByIdAndUpdate(projectId, { appAndroidStatus: 'ready' });
                    await fs.remove(tempWorkspace);
                    console.log(`[${project.name}] Android PWA package compiled successfully.`);
                }

                if (req.file) {
                    await fs.remove(req.file.path);
                }
            } catch (err) {
                console.error(`Native App Compilation failure for project ${project.name}:`, err);
                const failField = platform === 'android' ? { appAndroidStatus: 'failed' } : { appWindowsStatus: 'failed' };
                await Project.findByIdAndUpdate(projectId, failField);
                if (req.file) {
                    await fs.remove(req.file.path);
                }
            }
        }, 10000);

    } catch (err) {
        console.error("App Build Request failure:", err);
        res.status(500).json({ message: 'Internal Server Error.' });
    }
});

app.post('/api/builds/trigger', authenticateToken, async (req, res) => {
    const { projectId, platform } = req.body;
    try {
        const project = await Project.findOne({ _id: projectId, createdBy: req.user.id });
        if (!project) return res.status(404).json({ message: "Project not found." });

        const build = await BuildEngine.enqueueBuild(projectId, platform, req.protocol, req.get('host'));
        res.status(202).json({ message: "App compilation pipeline queued.", buildId: build._id });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.get('/api/builds/:id/logs', authenticateToken, async (req, res) => {
    try {
        const build = await Build.findById(req.params.id);
        if (!build) return res.status(404).json({ message: "Compilation logs not found." });
        res.json({ status: build.status, logs: build.logs });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.get('/api/builds/download/:id/:platform', async (req, res) => {
    const { id, platform } = req.params;
    const extension = platform === 'android' ? '.apk' : '.exe';
    const filePath = path.join(__dirname, `compiled_apps/downloads/release_${id}${extension}`);

    if (!(await fs.pathExists(filePath))) {
        return res.status(404).send("Application artifact was not found or is currently packaging.");
    }
    res.download(filePath, `release_${id}${extension}`);
});

// =================================================================
// ==           STATIC WEBSITE DEPLOYMENT PIPELINE ROUTE          ==
// =================================================================

app.post('/api/deploy', authenticateToken, upload.single('file'), async (req, res) => {
    const { projectId, gitURL, rootDir } = req.body;
    let project;
    try {
        project = await Project.findById(projectId);
        if (!project || project.createdBy.toString() !== req.user.id) {
            return res.status(404).json({ message: 'Project not found or unauthorized.' });
        }
        
        await project.updateOne({ status: 'deploying' });
        console.log(`[${project.projectName}] --> Deployment started.`);
        res.status(202).json({ message: 'Deployment accepted and is in progress.' });
        
        const DEPLOYMENTS_DIR = path.join(__dirname, 'deployments');
        const projectDeployPath = path.join(DEPLOYMENTS_DIR, project._id.toString());
        console.log(`[${project.projectName}] STEP 1: Cleaning up old deployment at ${projectDeployPath}`);
        await fs.ensureDir(projectDeployPath);
        await fs.emptyDir(projectDeployPath);
        
        if (gitURL) {
            console.log(`[${project.projectName}] STEP 2: Preparing cloning URL.`);
            const tempCloneDir = path.join(UPLOADS_DIR, `_temp_git_${project._id}`);
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
            
            console.log(`[${project.projectName}] ... Cloning repository.`);
            await simpleGit().clone(cloneURL, tempCloneDir, { '--depth': 1 });
            console.log(`[${project.projectName}] ... Git clone successful.`);
            
            let startPath = tempCloneDir;
            if (rootDir) {
                const resolvedPath = path.resolve(tempCloneDir, rootDir.trim());
                if (!resolvedPath.startsWith(tempCloneDir)) {
                    throw new Error("Security Violation: Target path escapes deployment directory.");
                }
                startPath = resolvedPath;
                if (!(await fs.pathExists(startPath))) {
                    throw new Error(`The configured root directory '${rootDir}' does not exist inside the repository.`);
                }
            }
            
            const sourceDir = await findIndexHtmlDir(startPath);
            console.log(`[${project.projectName}] STEP 3: Deploying from directory containing index.html: ${sourceDir}`);
            await fs.copy(sourceDir, projectDeployPath);
            await fs.remove(tempCloneDir);
        } else if (req.file) {
            console.log(`[${project.projectName}] STEP 2: Preparing extraction workspace.`);
            const tempExtractDir = path.join(UPLOADS_DIR, `_temp_zip_${project._id}`);
            await fs.ensureDir(tempExtractDir);
            await fs.emptyDir(tempExtractDir);

            console.log(`[${project.projectName}] ... Extracting zip archive.`);
            
            // Invoking defensive, path-traversal & zip-bomb protected extraction system instead of raw extraction
            await extractZipSafely(req.file.path, tempExtractDir);
            
            console.log(`[${project.projectName}] ... Unzip successful.`);
            await fs.remove(req.file.path);

            let startPath = tempExtractDir;
            if (rootDir) {
                const resolvedPath = path.resolve(tempExtractDir, rootDir.trim());
                if (!resolvedPath.startsWith(tempExtractDir)) {
                    throw new Error("Security Violation: Target path escapes deployment directory.");
                }
                startPath = resolvedPath;
                if (!(await fs.pathExists(rootDir))) {
                    throw new Error(`The configured root directory '${rootDir}' does not exist inside the archive.`);
                }
            }

            const sourceDir = await findIndexHtmlDir(startPath);
            console.log(`[${project.projectName}] STEP 3: Deploying from directory containing index.html: ${sourceDir}`);
            await fs.copy(sourceDir, projectDeployPath);
            await fs.remove(tempExtractDir);
        } else {
            throw new Error("No Git URL or file was provided for deployment.");
        }
        
        await project.updateOne({ status: 'ready' });
        console.log(`[${project.projectName}] --> ✅ Deployment Succeeded. Status set to 'ready'.`);
    } catch (error) {
        console.error(`[${project ? project.projectName : projectId}] --> ❌ Critical deployment failure:`, error.message);
        if (project) {
            await project.updateOne({ status: 'failed' });
        }
    }
});

// =================================================================
// ==                 ADMIN MANAGEMENT ENDPOINTS                  ==
// =================================================================

// 1. Fetch platform statistics (Admin Only)
app.get('/api/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const totalUsers = await User.countDocuments();
        const totalProjects = await Project.countDocuments();
        const readyProjects = await Project.countDocuments({ status: 'ready' });
        
        res.json({
            totalUsers,
            totalProjects,
            activeDeployments: readyProjects
        });
    } catch (err) {
        console.error("Admin stats fetch error:", err);
        res.status(500).json({ message: "Server error compiling platform statistics." });
    }
});

// 2. Fetch all system projects with owner emails (Admin Only)
app.get('/api/admin/projects', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const projects = await Project.find()
            .populate('createdBy', 'email')
            .sort({ createdAt: -1 });
        res.json(projects);
    } catch (err) {
        console.error("Admin projects fetch error:", err);
        res.status(500).json({ message: "Server error retrieving system projects." });
    }
});

// 3. Administrative delete of any project container and files (Admin Only)
app.delete('/api/admin/projects/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const project = await Project.findById(req.params.id);
        if (!project) return res.status(404).json({ message: "Project not found." });

        const DEPLOYMENTS_DIR = path.join(__dirname, 'deployments');
        const projectPath = path.join(DEPLOYMENTS_DIR, project._id.toString());
        
        // Remove deployed files from local disk
        await fs.remove(projectPath);
        
        // Remove DB document
        await Project.findByIdAndDelete(req.params.id);
        
        await LoggerService.log('ADMIN_PROJECT_DELETED', `Admin deleted project instance: ${project.projectName}`, req.user.id);
        res.json({ message: "Project administratively deleted successfully." });
    } catch (err) {
        console.error("Admin project delete error:", err);
        res.status(500).json({ message: "Server error deleting project." });
    }
});

// =================================================================
// ==      PATH-BASED DEPLOYMENT ROUTING & FRONTEND SERVING       ==
// =================================================================

// 1. Route requests to deployed project subdomains (e.g., /test-subdomain)
app.use(async (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    const projectIdentifier = req.path.split('/')[1];
    if (!projectIdentifier) return next();
    
    try {
        const ProjectModel = mongoose.model('Project'); // Safely retrieve compiled model reference
        const project = await ProjectModel.findOne({ subdomain: projectIdentifier, status: 'ready' });
        
        if (project) {
            const DEPLOYMENTS_DIR = path.join(__dirname, 'deployments');
            const projectPath = path.join(DEPLOYMENTS_DIR, project._id.toString());
            req.url = req.url.replace(`/${projectIdentifier}`, '') || '/';
            return express.static(projectPath)(req, res, () => {
                res.sendFile(path.join(projectPath, 'index.html'));
            });
        }
        return next();
    } catch (error) {
        console.error("Path-based Proxy Error:", error);
        return res.status(500).send('Server error.');
    }
});

// 2. Serve static frontend files (index.html, dashboard.html, style.css) from root
app.use(express.static(__dirname));

// 3. Catch-all route to serve your landing page (index.html)
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ message: "API endpoint not found." });
    }
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- SERVER INITIALIZATION ---
// Explicitly binding to host 0.0.0.0 as required by Railway documentation to prevent port check failures
app.listen(PORT, "0.0.0.0", () => console.log("🚀 WebHost Core Engine operational on port " + PORT));
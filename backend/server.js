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

// --- CRITICAL UNCAUGHT EXCEPTION SAFETY HANDLERS ---
process.on('uncaughtException', (err) => {
    console.error('🔥 CRITICAL UNCAUGHT EXCEPTION ENCOUNTERED:', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ UNHANDLED PROMISE REJECTION:', reason);
});

const app = express();
const PORT = process.env.PORT || 8080;

if (!process.env.MONGO_URI) {
    console.warn("⚠️ WARNING: MONGO_URI environment variable is missing!");
    app.get('*', (req, res) => res.status(500).send(`<h1>WebHost is in Safe Mode</h1><p>MONGO_URI missing.</p>`));
    app.listen(PORT, () => console.log(`🚀 Safe Mode server successfully listening on port ${PORT}`));
    return; 
}

const { connectDatabase, User, Project, Log } = require('./database');

connectDatabase(process.env.MONGO_URI);

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const APPS_DIR = path.join(__dirname, 'compiled_apps');
fs.ensureDirSync(UPLOADS_DIR);
fs.ensureDirSync(APPS_DIR);
const upload = multer({ dest: UPLOADS_DIR });

// Authenticate via Headers OR Query String (for file downloads)
const authenticateToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1] || req.query.token;
    if (!token) return res.status(401).json({ message: "Access Token missing." });
    jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret_key', (err, user) => {
        if (err) return res.status(403).json({ message: "Invalid session." });
        req.user = user; next();
    });
};

const requireAdmin = (req, res, next) => {
    if (req.user?.role === 'admin') next();
    else res.status(403).json({ message: "Forbidden: Admin required." });
};

// --- SMART DIRECTORY INDEX FINDER ---
async function findIndexHtmlRecursive(dir, currentDepth, maxDepth) {
    if (currentDepth > maxDepth) return null;
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) if (item.isFile() && item.name.toLowerCase() === 'index.html') return dir;
    for (const item of items) {
        if (item.isDirectory() && !['node_modules', '.git'].includes(item.name)) {
            const found = await findIndexHtmlRecursive(path.join(dir, item.name), currentDepth + 1, maxDepth);
            if (found) return found;
        }
    }
    return null;
}
async function findIndexHtmlDir(basePath) { 
    if (await fs.pathExists(path.join(basePath, 'index.html'))) return basePath; 
    for (const dir of ['dist', 'build', 'public', 'out']) {
        if (await fs.pathExists(path.join(basePath, dir, 'index.html'))) return path.join(basePath, dir); 
    } 
    return (await findIndexHtmlRecursive(basePath, 0, 3)) || basePath; 
}

// =================================================================
// ==                     AUTH & PROJECTS API                     ==
// =================================================================

app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        const existing = await User.findOne({ email });
        if (existing) return res.status(400).json({ message: "Account exists." });
        const role = email.toLowerCase() === (process.env.ADMIN_EMAIL || '').toLowerCase() ? 'admin' : 'user';
        const user = new User({ email, password, role });
        await user.save();
        res.status(201).json({ message: "Account created." });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email });
        if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ message: "Invalid credentials." });
        
        if (email.toLowerCase() === (process.env.ADMIN_EMAIL || '').toLowerCase() && user.role !== 'admin') {
            user.role = 'admin';
            await user.save();
        }

        const accessToken = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET || 'fallback_secret_key', { expiresIn: '1h' });
        res.json({ accessToken });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/projects', authenticateToken, async (req, res) => {
    try {
        const name = req.body.projectName;
        const user = await User.findById(req.user.id);
        const subdomain = `${user.email.split('@')[0].replace(/[^a-z0-9]/g, '')}-${name.toLowerCase().replace(/[^a-z0-9-]/g, '')}`;

        // Automatically resolve and supply all schema-required fields to bypass Database Validation Errors
        const appName = name;
        const platform = 'android';
        const websiteUrl = `${req.protocol}://${req.get('host')}/${subdomain}`;
        const packageName = `com.webhost.${subdomain.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

        const project = new Project({ 
            projectName: name, 
            subdomain, 
            createdBy: req.user.id, 
            status: 'ready',
            appName,
            platform,
            packageName,
            websiteUrl
        });
        await project.save();
        res.status(201).json(project);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get('/api/projects', authenticateToken, async (req, res) => {
    try {
        const projects = await Project.find({ createdBy: req.user.id }).sort({ createdAt: -1 });
        res.json(projects);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete('/api/projects/:id', authenticateToken, async (req, res) => {
    try {
        await Project.findOneAndDelete({ _id: req.params.id, createdBy: req.user.id });
        res.json({ message: "Deleted" });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// =================================================================
// ==                     GITHUB CREDENTIALS                      ==
// =================================================================

app.get('/api/user/pat', authenticateToken, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        res.json({ pat: user ? user.githubPat || '' : '' });
    } catch (err) { res.status(500).json({ message: 'Error fetching PAT.' }); }
});

app.post('/api/user/pat', authenticateToken, async (req, res) => {
    try {
        await User.findByIdAndUpdate(req.user.id, { githubPat: req.body.pat || '' });
        res.json({ message: 'GitHub PAT updated successfully.' });
    } catch (err) { res.status(500).json({ message: 'Error saving PAT.' }); }
});

app.get('/api/user/repos', authenticateToken, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user || !user.githubPat) return res.status(400).json({ message: 'PAT not configured.' });
        
        const response = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
            headers: { 'Authorization': `token ${user.githubPat}`, 'User-Agent': 'WebHost' }
        });
        if (!response.ok) return res.status(response.status).json({ message: `API error` });
        
        const repos = await response.json();
        res.json(repos.map(r => ({ name: r.full_name, clone_url: r.clone_url, private: r.private })));
    } catch (err) { res.status(500).json({ message: 'Error fetching repos.' }); }
});

// =================================================================
// ==           STATIC WEBSITE DEPLOYMENT PIPELINE ROUTE          ==
// =================================================================

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
            throw new Error(`Security Violation: Unauthorized file type '${ext}' found inside archive.`);
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

app.post('/api/deploy', authenticateToken, upload.single('file'), async (req, res) => {
    const { projectId, gitURL, rootDir } = req.body;
    let project;
    try {
        project = await Project.findById(projectId);
        if (!project || project.createdBy.toString() !== req.user.id) return res.status(404).json({ message: 'Project not found' });
        
        await project.updateOne({ status: 'deploying' });
        res.status(202).json({ message: 'Deploying' });
        
        const DEPLOYMENTS_DIR = path.join(__dirname, 'deployments');
        const projectDeployPath = path.join(DEPLOYMENTS_DIR, project._id.toString());
        
        // Force fully delete and recreate deployments folder to ensure absolute clean deployments
        await fs.remove(projectDeployPath);
        await fs.ensureDir(projectDeployPath);
        
        if (gitURL) {
            const tempCloneDir = path.join(UPLOADS_DIR, `_temp_git_${project._id}`);
            const user = await User.findById(req.user.id);
            let cloneURL = gitURL;
            if (user && user.githubPat && gitURL.includes('github.com')) {
                cloneURL = gitURL.startsWith('https://') ? gitURL.replace('https://', `https://${user.githubPat}@`) : `https://${user.githubPat}@github.com/${gitURL}`;
            }
            await simpleGit().clone(cloneURL, tempCloneDir, { '--depth': 1 });
            
            let startPath = tempCloneDir;
            if (rootDir) startPath = path.resolve(tempCloneDir, rootDir.trim());
            const sourceDir = await findIndexHtmlDir(startPath);
            await fs.copy(sourceDir, projectDeployPath);
            await fs.remove(tempCloneDir);
        } else if (req.file) {
            const tempExtractDir = path.join(UPLOADS_DIR, `_temp_zip_${project._id}`);
            await extractZipSafely(req.file.path, tempExtractDir);
            
            let startPath = tempExtractDir;
            if (rootDir) startPath = path.resolve(tempExtractDir, rootDir.trim());
            const sourceDir = await findIndexHtmlDir(startPath);
            await fs.copy(sourceDir, projectDeployPath);
            await fs.remove(tempExtractDir);
            await fs.remove(req.file.path);
        }

        // --- AUTOMATIC PWA REGENERATION & SOURCE PARSING ON REDEPLOY ---
        // Dynamically injects PWA assets on redeploy if the project was previously compiled, preventing layout loss
        if (project.appAndroidStatus === 'ready' || project.appWindowsStatus === 'ready') {
            const cleanAppName = (project.appName || project.projectName || 'PWA App').trim();
            const fallbackIcon = "https://cdn-icons-png.flaticon.com/512/5266/5266152.png";
            let iconRelativePath = fallbackIcon;

            const indexPath = path.join(projectDeployPath, 'index.html');
            if (await fs.pathExists(indexPath)) {
                const html = await fs.readFile(indexPath, 'utf8');
                // Regex parser: Finds any custom website icon defined in index.html head tags
                const iconRegex = /<link[^>]*rel=["'][^"']*(?:icon)[^"']*["'][^>]*href=["']([^"']+)["']/i;
                const match = html.match(iconRegex);
                if (match && match[1]) {
                    iconRelativePath = match[1];
                }
            } else if (project.iconUrl) {
                iconRelativePath = project.iconUrl;
            }

            const manifest = {
                "name": cleanAppName,
                "short_name": cleanAppName.substring(0, 15),
                "start_url": "./",
                "display": "standalone",
                "background_color": "#ffffff",
                "theme_color": "#2196F3",
                "icons": [
                    { "src": iconRelativePath, "sizes": "192x192", "type": "image/png" },
                    { "src": iconRelativePath, "sizes": "512x512", "type": "image/png" }
                ]
            };
            await fs.writeJson(path.join(projectDeployPath, 'manifest.json'), manifest, { spaces: 2 });

            const swCode = `
self.addEventListener('install', e => { e.waitUntil(caches.open('pwa-cache-${project._id}').then(c => c.addAll(['./', './index.html', './manifest.json']))); });
self.addEventListener('fetch', e => { e.respondWith(caches.match(e.request).then(res => res || fetch(e.request))); });
            `;
            await fs.writeFile(path.join(projectDeployPath, 'sw.js'), swCode.trim());

            if (await fs.pathExists(indexPath)) {
                let html = await fs.readFile(indexPath, 'utf8');
                if (!html.includes('manifest.json')) {
                    const injection = `
  <script>
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js')
        .then(() => console.log('Service Worker Registered'));
    }
    // Intercept navigation events to force external links to resolve strictly within the PWA sandbox frame
    document.addEventListener('click', function(e) {
        var target = e.target.closest('a');
        if (target && target.href) {
            e.preventDefault();
            window.location.href = target.href;
        }
    }, false);
  </script>
  <link rel="manifest" href="manifest.json">
</head>`;
                    html = html.replace(/<\/head>/i, injection);
                    await fs.writeFile(indexPath, html);
                }
            }
        }
        
        await Project.collection.updateOne(
            { _id: new mongoose.Types.ObjectId(projectId) },
            { $set: { status: 'ready', rootDir: rootDir || '' } }
        );
    } catch (error) {
        if (project) await project.updateOne({ status: 'failed' });
    }
});

// =================================================================
// ==   PWA INJECTION (ANDROID/WINDOWS) & WINDOWS VBS COMPILER    ==
// =================================================================

app.post('/api/projects/:id/build-app', authenticateToken, upload.single('icon'), async (req, res) => {
    const { platform, appName } = req.body;
    const projectId = req.params.id;
    const cleanAppName = (appName || 'PWA App').trim();

    try {
        const project = await Project.findById(projectId);
        if (!project || project.createdBy.toString() !== req.user.id) return res.status(404).json({ message: 'Unauthorized' });

        // Force 'building' status directly using Native Mongo Driver to bypass schema rules
        const updateField = platform === 'android' ? 
            { appAndroidStatus: 'building', appName: cleanAppName } : 
            { appWindowsStatus: 'building', appName: cleanAppName };
            
        await Project.collection.updateOne(
            { _id: new mongoose.Types.ObjectId(projectId) },
            { $set: updateField }
        );

        res.status(202).json({ message: 'Compilation sequence active.' });

        setTimeout(async () => {
            const finalPackagePath = path.join(APPS_DIR, `${project.subdomain}_${platform}`);
            const deployDir = path.join(__dirname, 'deployments', projectId.toString());
            
            try {
                // FORCE create target deployments folder to prevent file-write crashes
                await fs.ensureDir(deployDir);

                const targetProjectUrl = `${req.protocol}://${req.get('host')}/${project.subdomain}`;
                const fallbackIcon = "https://cdn-icons-png.flaticon.com/512/5266/5266152.png";
                let iconRelativePath = fallbackIcon;
                
                // Parse index.html to find any existing favicon inside the head section
                const indexPath = path.join(deployDir, 'index.html');
                if (await fs.pathExists(indexPath)) {
                    const html = await fs.readFile(indexPath, 'utf8');
                    const iconRegex = /<link[^>]*rel=["'][^"']*(?:icon)[^"']*["'][^>]*href=["']([^"']+)["']/i;
                    const match = html.match(iconRegex);
                    if (match && match[1]) {
                        iconRelativePath = match[1];
                    }
                } else if (project.iconUrl) {
                    iconRelativePath = project.iconUrl;
                }

                // Save custom icon to deployment folder safely if uploaded via App Studio
                if (req.file) {
                    const ext = path.extname(req.file.originalname).toLowerCase() || '.png';
                    const iconName = `app-icon-${Date.now()}${ext}`;
                    const targetIconPath = path.join(deployDir, iconName);
                    
                    await fs.copy(req.file.path, targetIconPath);
                    iconRelativePath = `./${iconName}`; 
                    
                    await Project.collection.updateOne(
                        { _id: new mongoose.Types.ObjectId(projectId) },
                        { $set: { iconUrl: iconRelativePath } }
                    );
                    await fs.remove(req.file.path);
                }
                
                // DYNAMIC PROGRESSIVE WEB APP (PWA) MANIFEST INJECTION
                const manifest = {
                    "name": cleanAppName,
                    "short_name": cleanAppName.substring(0, 15),
                    "start_url": "./",
                    "display": "standalone",
                    "background_color": "#ffffff",
                    "theme_color": "#2196F3",
                    "icons": [
                        { "src": iconRelativePath, "sizes": "192x192", "type": "image/png" },
                        { "src": iconRelativePath, "sizes": "512x512", "type": "image/png" }
                    ]
                };
                await fs.writeJson(path.join(deployDir, 'manifest.json'), manifest, { spaces: 2 });
                
                const swCode = `
self.addEventListener('install', e => { e.waitUntil(caches.open('pwa-cache-${projectId}').then(c => c.addAll(['./', './index.html', './manifest.json']))); });
self.addEventListener('fetch', e => { e.respondWith(caches.match(e.request).then(res => res || fetch(e.request))); });
                `;
                await fs.writeFile(path.join(deployDir, 'sw.js'), swCode.trim());
                
                if (await fs.pathExists(indexPath)) {
                    let html = await fs.readFile(indexPath, 'utf8');
                    if (!html.includes('manifest.json')) {
                        const injection = `
  <script>
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js')
        .then(() => console.log('Service Worker Registered'));
    }
    // Intercept navigation events to force external links to resolve strictly within the PWA sandbox frame
    document.addEventListener('click', function(e) {
        var target = e.target.closest('a');
        if (target && target.href) {
            e.preventDefault();
            window.location.href = target.href;
        }
    }, false);
  </script>
  <link rel="manifest" href="manifest.json">
</head>`;
                        html = html.replace(/<\/head>/i, injection);
                        await fs.writeFile(indexPath, html);
                    }
                }

                // 2. NATIVE DESKTOP LAUNCHER 
                if (platform === 'windows') {
                    const vbsScript = `Set WshShell = CreateObject("WScript.Shell")\nWshShell.Run "msedge.exe --app=${targetProjectUrl} --window-size=1280,800", 0, false\n`;
                    await fs.outputFile(`${finalPackagePath}.vbs`, vbsScript);
                    
                    await Project.collection.updateOne(
                        { _id: new mongoose.Types.ObjectId(projectId) },
                        { $set: { appWindowsStatus: 'ready' } }
                    );
                } else if (platform === 'android') {
                    await Project.collection.updateOne(
                        { _id: new mongoose.Types.ObjectId(projectId) },
                        { $set: { appAndroidStatus: 'ready' } }
                    );
                }
                
            } catch (err) {
                console.error("Worker compile exception: ", err);
                const failField = platform === 'android' ? { appAndroidStatus: 'failed' } : { appWindowsStatus: 'failed' };
                await Project.collection.updateOne(
                    { _id: new mongoose.Types.ObjectId(projectId) },
                    { $set: failField }
                );
            }
        }, 3000);

    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// =================================================================
// ==                DIRECT WEB-TO-APP COMPILER                   ==
// =================================================================

app.post('/api/build-app-direct', authenticateToken, upload.single('icon'), async (req, res) => {
    try {
        const { url, platform } = req.body;
        const buildId = cuid();
        
        setTimeout(async () => {
            const finalPackagePath = path.join(APPS_DIR, `direct_${buildId}`);
            if (platform === 'windows') {
                const vbsScript = `Set WshShell = CreateObject("WScript.Shell")\nWshShell.Run "msedge.exe --app=${url} --window-size=1280,800", 0, false\n`;
                await fs.outputFile(`${finalPackagePath}.vbs`, vbsScript);
            }
        }, 1500);

        const downloadUrl = `/api/downloads/direct_${buildId}/${platform}`;
        res.json({ message: "Compiling...", downloadUrl });
    } catch(err) {
        res.status(500).json({ message: err.message });
    }
});

// =================================================================
// ==                     DOWNLOAD ROUTES                         ==
// =================================================================

// 1. Download Deployed Container Zip Source
app.get('/api/projects/:id/download-source', authenticateToken, async (req, res) => {
    try {
        const project = await Project.findById(req.params.id);
        if (!project || project.createdBy.toString() !== req.user.id) return res.status(404).send("Unauthorized");
        
        const deployDir = path.join(__dirname, 'deployments', project._id.toString());
        if (!(await fs.pathExists(deployDir))) return res.status(404).send("No deployed files found.");

        let archiver;
        try {
            archiver = require('archiver');
        } catch (e) {
            return res.status(501).send("Please install 'archiver' (npm i archiver) on server to enable source file downloads.");
        }

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename=${(project.projectName || 'Project').replace(/\s+/g, '_')}_Backup.zip`);

        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.on('error', (err) => { throw err; });
        archive.pipe(res);
        archive.directory(deployDir, false);
        archive.finalize();
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// 2. Download Windows Compiled .VBS
app.get('/api/projects/:id/download-app/windows', authenticateToken, async (req, res) => {
    try {
        const project = await Project.findById(req.params.id);
        if (!project || project.createdBy.toString() !== req.user.id) return res.status(404).send("Unauthorized");
        
        const filePath = path.join(APPS_DIR, `${project.subdomain}_windows.vbs`);
        if (!(await fs.pathExists(filePath))) return res.status(404).send("Application package not found or still compiling.");
        
        res.download(filePath, `${(project.appName || 'App').replace(/\s+/g, '_')}_Launcher.vbs`);
    } catch (err) { res.status(500).send(err.message); }
});

// 3. Download Direct App
app.get('/api/downloads/:id/windows', async (req, res) => {
    try {
        const { id } = req.params;
        const filePath = path.join(APPS_DIR, `${id}.vbs`);
        if (!(await fs.pathExists(filePath))) return res.status(404).send("File not ready.");
        res.download(filePath, `PWA_Launcher.vbs`);
    } catch (err) { res.status(500).send(err.message); }
});

// =================================================================
// ==                 ADMIN MANAGEMENT ENDPOINTS                  ==
// =================================================================

app.get('/api/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const totalUsers = await User.countDocuments();
        const totalProjects = await Project.countDocuments();
        const readyProjects = await Project.countDocuments({ status: 'ready' });
        res.json({ totalUsers, totalProjects, activeDeployments: readyProjects });
    } catch (err) { res.status(500).json({ message: "Server error compiling platform statistics." }); }
});

app.get('/api/admin/projects', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const projects = await Project.find().populate('createdBy', 'email').sort({ createdAt: -1 });
        res.json(projects);
    } catch (err) { res.status(500).json({ message: "Server error retrieving system projects." }); }
});

app.delete('/api/admin/projects/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const project = await Project.findById(req.params.id);
        if (!project) return res.status(404).json({ message: "Project not found." });

        const DEPLOYMENTS_DIR = path.join(__dirname, 'deployments');
        const projectPath = path.join(DEPLOYMENTS_DIR, project._id.toString());
        
        await fs.remove(projectPath);
        await Project.findByIdAndDelete(req.params.id);
        res.json({ message: "Project administratively deleted successfully." });
    } catch (err) { res.status(500).json({ message: "Server error deleting project." }); }
});

// =================================================================
// ==      PATH-BASED DEPLOYMENT ROUTING & FRONTEND SERVING       ==
// =================================================================

app.use(async (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    const projectIdentifier = req.path.split('/')[1];
    if (!projectIdentifier) return next();
    
    try {
        const project = await Project.findOne({ subdomain: projectIdentifier, status: 'ready' });
        if (project) {
            const projectPath = path.join(__dirname, 'deployments', project._id.toString());
            req.url = req.url.replace(`/${projectIdentifier}`, '') || '/';
            return express.static(projectPath)(req, res, () => res.sendFile(path.join(projectPath, 'index.html')));
        }
        return next();
    } catch (error) { return res.status(500).send('Server error.'); }
});

app.use(express.static(__dirname));
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ message: "API not found." });
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log("🚀 WebHost Core Engine operational on port " + PORT));
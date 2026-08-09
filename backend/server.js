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

const { connectDatabase, User, Project } = require('./database');

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

const authenticateToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ message: "Access Token missing." });
    jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret_key', (err, user) => {
        if (err) return res.status(403).json({ message: "Invalid session." });
        req.user = user; next();
    });
};

const requireAdmin = (req, res, next) => {
    if (req.user?.role === 'admin') next();
    else res.status(403).json({ message: "Forbidden" });
};

// =================================================================
// ==                     AUTH & PROJECTS API                     ==
// =================================================================

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email });
        if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ message: "Invalid credentials." });
        
        const accessToken = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET || 'fallback_secret_key', { expiresIn: '1h' });
        res.json({ accessToken });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/projects', authenticateToken, async (req, res) => {
    try {
        const name = req.body.projectName;
        const user = await User.findById(req.user.id);
        const subdomain = `${user.email.split('@')[0].replace(/[^a-z0-9]/g, '')}-${name.toLowerCase().replace(/[^a-z0-9-]/g, '')}`;

        const project = new Project({
            projectName: name, subdomain,
            createdBy: req.user.id, status: 'ready'
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
// ==           STATIC WEBSITE DEPLOYMENT PIPELINE ROUTE          ==
// =================================================================

app.post('/api/deploy', authenticateToken, upload.single('file'), async (req, res) => {
    const { projectId, gitURL } = req.body;
    let project;
    try {
        project = await Project.findById(projectId);
        if (!project) return res.status(404).json({ message: 'Project not found' });
        
        await project.updateOne({ status: 'deploying' });
        res.status(202).json({ message: 'Deploying' });
        
        const DEPLOYMENTS_DIR = path.join(__dirname, 'deployments');
        const projectDeployPath = path.join(DEPLOYMENTS_DIR, project._id.toString());
        await fs.ensureDir(projectDeployPath);
        await fs.emptyDir(projectDeployPath);
        
        if (gitURL) {
            const tempCloneDir = path.join(UPLOADS_DIR, `_temp_git_${project._id}`);
            await simpleGit().clone(gitURL, tempCloneDir, { '--depth': 1 });
            await fs.copy(tempCloneDir, projectDeployPath);
            await fs.remove(tempCloneDir);
        } else if (req.file) {
            await unzipper.Open.file(req.file.path).then(zip => zip.extract({ path: projectDeployPath }));
            await fs.remove(req.file.path);
        }
        
        await project.updateOne({ status: 'ready' });
    } catch (error) {
        if (project) await project.updateOne({ status: 'failed' });
    }
});

// =================================================================
// ==      PWA INJECTION & NATIVE WINDOWS VBS COMPILER ROUTE      ==
// =================================================================

app.post('/api/projects/:id/build-app', authenticateToken, upload.single('icon'), async (req, res) => {
    const { appName } = req.body;
    const projectId = req.params.id;
    const cleanAppName = (appName || 'Web Launcher').trim();

    try {
        const project = await Project.findById(projectId);
        if (!project || project.createdBy.toString() !== req.user.id) return res.status(404).json({ message: 'Unauthorized' });

        await Project.findByIdAndUpdate(projectId, { appWindowsStatus: 'building', appName: cleanAppName });

        res.status(202).json({ message: 'PWA Compilation sequence active.' });

        setTimeout(async () => {
            const finalPackagePath = path.join(APPS_DIR, `${project.subdomain}_windows`);
            
            try {
                const targetProjectUrl = `${req.protocol}://${req.get('host')}/${project.subdomain}`;
                const deployDir = path.join(__dirname, 'deployments', projectId.toString());
                
                // 1. DYNAMIC PROGRESSIVE WEB APP (PWA) MANIFEST INJECTION
                if (await fs.pathExists(deployDir)) {
                    console.log(`[${project.projectName}] Injecting PWA Manifest and Service Worker...`);
                    const manifest = {
                        name: cleanAppName, short_name: cleanAppName,
                        start_url: `./`, display: "standalone",
                        background_color: project.themeColor || "#ffffff", theme_color: project.themeColor || "#6366F1",
                        icons: [{ src: project.iconUrl || "https://cdn-icons-png.flaticon.com/512/5266/5266152.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }]
                    };
                    await fs.writeJson(path.join(deployDir, 'manifest.json'), manifest, { spaces: 2 });
                    
                    const swCode = `const CACHE_NAME = 'pwa-cache-${projectId}';\nself.addEventListener('install', e => { e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(['./', './index.html', './manifest.json']))); });\nself.addEventListener('fetch', e => { e.respondWith(caches.match(e.request).then(res => res || fetch(e.request))); });`;
                    await fs.writeFile(path.join(deployDir, 'service-worker.js'), swCode.trim());
                    
                    const indexPath = path.join(deployDir, 'index.html');
                    if (await fs.pathExists(indexPath)) {
                        let html = await fs.readFile(indexPath, 'utf8');
                        if (!html.includes('manifest.json')) {
                            const injection = `\n<!-- PWA Setup --><link rel="manifest" href="./manifest.json">\n<meta name="theme-color" content="${project.themeColor || '#6366F1'}">\n<script>if('serviceWorker' in navigator){window.addEventListener('load',()=>{navigator.serviceWorker.register('./service-worker.js');});}</script>\n</head>`;
                            html = html.replace(/<\/head>/i, injection);
                            await fs.writeFile(indexPath, html);
                        }
                    }
                }

                // 2. NATIVE DESKTOP LAUNCHER 
                // Windows PWA Desktop Wrapper (.VBS) executing MS Edge native PWA mode
                const vbsScript = `Set WshShell = CreateObject("WScript.Shell")\nWshShell.Run "msedge.exe --app=${targetProjectUrl} --window-size=1280,800", 0, false\n`;
                await fs.outputFile(`${finalPackagePath}.vbs`, vbsScript);
                await Project.findByIdAndUpdate(projectId, { appWindowsStatus: 'ready' });
                
            } catch (err) {
                await Project.findByIdAndUpdate(projectId, { appWindowsStatus: 'failed' });
            }
        }, 3000); // Shorter timeout as there are no binary builds

    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// =================================================================
// ==                DIRECT WEB-TO-APP COMPILER                   ==
// =================================================================

app.post('/api/build-app-direct', authenticateToken, upload.single('icon'), async (req, res) => {
    try {
        const { url } = req.body;
        const buildId = cuid();
        
        setTimeout(async () => {
            const finalPackagePath = path.join(APPS_DIR, `direct_${buildId}`);
            // Force create the .vbs wrapper
            const vbsScript = `Set WshShell = CreateObject("WScript.Shell")\nWshShell.Run "msedge.exe --app=${url} --window-size=1280,800", 0, false\n`;
            await fs.outputFile(`${finalPackagePath}.vbs`, vbsScript);
        }, 1500);

        const downloadUrl = `/api/downloads/direct_${buildId}/windows`;
        res.json({ message: "Compiling...", downloadUrl });
    } catch(err) {
        res.status(500).json({ message: err.message });
    }
});

// =================================================================
// ==                     DOWNLOAD ROUTES                         ==
// =================================================================

// Download Project specific App
app.get('/api/projects/:id/download-app/windows', async (req, res) => {
    try {
        const project = await Project.findById(req.params.id);
        if (!project) return res.status(404).send("Project not found.");
        
        const filePath = path.join(APPS_DIR, `${project.subdomain}_windows.vbs`);
        
        if (!(await fs.pathExists(filePath))) return res.status(404).send("Application package not found or still compiling.");
        res.download(filePath, `${(project.appName || 'App').replace(/\s+/g, '_')}_Launcher.vbs`);
    } catch (err) { res.status(500).send(err.message); }
});

// Download Direct Studio App
app.get('/api/downloads/:id/windows', async (req, res) => {
    try {
        const { id } = req.params;
        const filePath = path.join(APPS_DIR, `${id}.vbs`);
        if (!(await fs.pathExists(filePath))) return res.status(404).send("File not ready.");
        res.download(filePath, `PWA_Launcher.vbs`);
    } catch (err) { res.status(500).send(err.message); }
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
            return express.static(projectPath)(req, res, () => {
                res.sendFile(path.join(projectPath, 'index.html'));
            });
        }
        return next();
    } catch (error) { return res.status(500).send('Server error.'); }
});

app.use(express.static(__dirname));

app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ message: "API endpoint not found." });
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log("🚀 WebHost Core Engine operational on port " + PORT));
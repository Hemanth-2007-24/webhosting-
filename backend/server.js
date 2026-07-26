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

const { connectDatabase, User, Project, Build, Log } = require('./database');
const { CloudinaryService, SecurityService, PackageNameService, LoggerService } = require('./services');
const { BuildEngine } = require('./buildEngine');

const app = express();

// --- SECURITY MIDDLEWARES ---
app.use(helmet({
    contentSecurityPolicy: false, // Disabled to support external resources loading within sandbox WebViews
    crossOriginEmbedderPolicy: false
}));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Global Rate Limiting
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    message: "Too many requests from this IP. Please try again later."
});
app.use(globalLimiter);

// File Upload configuration
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.ensureDirSync(UPLOADS_DIR);
const upload = multer({ dest: UPLOADS_DIR });

// Connect Mongoose to Atlas
connectDatabase(process.env.MONGO_URI);

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

        const user = new User({ email, password });
        await user.save();
        await LoggerService.log('USER_REGISTERED', `Registered Account: ${email}`, user._id);
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
        // Robust fallback supporting both `projectName` and original `name` payload keys
        const name = req.body.projectName || req.body.name;
        const websiteUrl = req.body.websiteUrl || 'https://o4dhomepage.onrender.com/c.html';
        const platform = req.body.platform || 'android';

        if (!name || name.trim().length < 3) {
            return res.status(400).json({ message: "Project name must be at least 3 characters." });
        }

        const appName = req.body.appName || name;
        const subdomain = name.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20) + '-' + cuid.slug();
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
            createdBy: req.user.id
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
// ==                    BUILD ENGINE API                         ==
// =================================================================

app.post('/api/builds/trigger', authenticateToken, async (req, res) => {
    const { projectId, platform } = req.body;
    try {
        const project = await Project.findOne({ _id: projectId, createdBy: req.user.id });
        if (!project) return res.status(404).json({ message: "Project not found." });

        const build = await BuildEngine.enqueueBuild(projectId, platform);
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
            const zipArchive = await unzipper.Open.file(req.file.path);
            await zipArchive.extract({ path: tempExtractDir });
            console.log(`[${project.projectName}] ... Unzip successful.`);
            await fs.remove(req.file.path);

            let startPath = tempExtractDir;
            if (rootDir) {
                const resolvedPath = path.resolve(tempExtractDir, rootDir.trim());
                if (!resolvedPath.startsWith(tempExtractDir)) {
                    throw new Error("Security Violation: Target path escapes deployment directory.");
                }
                startPath = resolvedPath;
                if (!(await fs.pathExists(startPath))) {
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
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 WebHost Core Engine operational on port ${PORT}`));
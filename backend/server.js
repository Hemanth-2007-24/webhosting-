// ============================================================
//                     server.js                           
// ============================================================

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

const { connectDatabase, User, Project, Build, Log } = require('./database');
const { CloudinaryService, SecurityService, PackageNameService, LoggerService } = require('./services');
const { BuildEngine } = require('./buildengine');

const app = express();

// --- MIDDLEWARES ---
app.use(helmet());
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
const upload = multer({ dest: path.join(__dirname, 'uploads/') });

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
        const { projectName, websiteUrl, appName, platform, themeColor, permissions } = req.body;
        const packageName = PackageNameService.generatePackageName(appName || projectName);

        const project = new Project({
            projectName,
            websiteUrl,
            packageName,
            appName: appName || projectName,
            platform,
            themeColor,
            permissions,
            createdBy: req.user.id
        });

        await project.save();
        await LoggerService.log('PROJECT_CREATED', `Project ${projectName} initiated.`, req.user.id, project._id);
        res.status(201).json(project);
    } catch (err) {
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
            const iconRes = await CloudinaryService.uploadImage(req.files['icon'][0].path, 'icons', 512, 512);
            project.iconUrl = iconRes.url;
            await fs.remove(req.files['icon'][0].path);
        }

        if (req.files['splash']) {
            const splashRes = await CloudinaryService.uploadImage(req.files['splash'][0].path, 'splashes', 1280, 1920);
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

// --- SERVER INITIALIZATION ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 WebHost Core Engine operational on port ${PORT}`));

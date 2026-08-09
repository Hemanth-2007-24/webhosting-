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

        const project = new Project({ projectName: name, subdomain, createdBy: req.user.id, status: 'ready' });
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

app.get('/api/user/repos', authenticateToken, async
// server.js
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

// --- APP & MIDDLEWARE SETUP ---
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- DATABASE CONNECTION ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('MongoDB Connected'))
    .catch(err => console.error('MongoDB Connection Error:', err));

// --- DATABASE MODELS ---
const UserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    password: { type: String, required: true },
});
UserSchema.pre('save', async function(next) {
    if (this.isModified('password')) {
        this.password = await bcrypt.hash(this.password, 10);
    }
    next();
});
const User = mongoose.model('User', UserSchema);

const ProjectSchema = new mongoose.Schema({
    name: { type: String, required: true },
    subdomain: { type: String, required: true, unique: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['queued', 'deploying', 'ready', 'failed'], default: 'queued' },
});
const Project = mongoose.model('Project', ProjectSchema);

// --- AUTH MIDDLEWARE ---
const authMiddleware = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Authorization denied' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (e) {
        res.status(400).json({ message: 'Token is not valid' });
    }
};

// --- FILE UPLOAD MIDDLEWARE (MULTER) ---
const upload = multer({ dest: path.join(__dirname, 'uploads/') });

// --- DEPLOYMENT LOGIC & HELPERS ---
const DEPLOYMENTS_DIR = path.join(__dirname, 'deployments');

async function findBuildDir(basePath) {
    const commonDirs = ['dist', 'build', 'public', 'out'];
    for (const dir of commonDirs) {
        const potentialPath = path.join(basePath, dir);
        if (await fs.pathExists(potentialPath)) {
            return potentialPath;
        }
    }
    return basePath; // Assume root if no common dir found
}

// --- API ROUTES ---

// AUTH ROUTES
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password || password.length < 6) {
            return res.status(400).json({ message: 'Invalid email or password (min 6 chars).' });
        }
        if (await User.findOne({ email })) {
            return res.status(400).json({ message: 'User already exists.' });
        }
        const user = new User({ email, password });
        await user.save();
        res.status(201).json({ message: 'User registered successfully.' });
    } catch (error) {
        res.status(500).json({ message: 'Server error' });
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
        res.status(500).json({ message: 'Server error' });
    }
});

// PROJECT ROUTES
app.post('/api/projects', authMiddleware, async (req, res) => {
    try {
        const { name } = req.body;
        const subdomain = name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 30) + '-' + cuid.slug();
        if (await Project.findOne({ subdomain })) {
            return res.status(400).json({ message: 'A project with a similar name already exists.' });
        }
        const project = new Project({ name, subdomain, owner: req.user.id });
        await project.save();
        res.status(201).json(project);
    } catch (error) {
        res.status(500).json({ message: 'Server error creating project.' });
    }
});

app.get('/api/projects', authMiddleware, async (req, res) => {
    try {
        const projects = await Project.find({ owner: req.user.id }).sort({ createdAt: -1 });
        res.json(projects);
    } catch (error) {
        res.status(500).json({ message: 'Server error fetching projects.' });
    }
});

// DEPLOYMENT ROUTE
app.post('/api/deploy', authMiddleware, upload.single('file'), async (req, res) => {
    const { projectId, gitURL } = req.body;
    
    try {
        const project = await Project.findById(projectId);
        if (!project || project.owner.toString() !== req.user.id) {
            return res.status(404).json({ message: 'Project not found.' });
        }

        await Project.updateOne({ _id: projectId }, { status: 'deploying' });
        res.status(202).json({ message: 'Deployment accepted and is in progress.' }); // Respond immediately

        // --- Asynchronous deployment process ---
        const projectDeployPath = path.join(DEPLOYMENTS_DIR, project.id);
        await fs.ensureDir(projectDeployPath);
        await fs.emptyDir(projectDeployPath);
        
        if (gitURL) { // Deploy from Git
            const tempCloneDir = path.join(__dirname, 'uploads', `_temp_git_${project.id}`);
            await fs.emptyDir(tempCloneDir);
            await simpleGit().clone(gitURL, tempCloneDir, { '--depth': 1 });
            const buildDir = await findBuildDir(tempCloneDir);
            await fs.copy(buildDir, projectDeployPath);
            await fs.remove(tempCloneDir);
        } else if (req.file) { // Deploy from ZIP
            await new Promise((resolve, reject) => {
                fs.createReadStream(req.file.path)
                    .pipe(unzipper.Extract({ path: projectDeployPath }))
                    .on('finish', resolve)
                    .on('error', reject);
            });
            await fs.remove(req.file.path);
        } else {
             throw new Error("No Git URL or file provided.");
        }

        await Project.updateOne({ _id: projectId }, { status: 'ready' });
        console.log(`Deployment for ${project.name} succeeded.`);

    } catch (error) {
        console.error(`Deployment for ${projectId} failed:`, error);
        await Project.updateOne({ _id: projectId }, { status: 'failed' });
    }
});

// --- STATIC FILE SERVING FOR FRONTEND DASHBOARD ---
// This serves your index.html, dashboard.html, and style.css
app.use(express.static(path.join(__dirname, '/')));

// --- REVERSE PROXY & DEPLOYED SITE SERVING ---
// This MUST be the last middleware.
app.use(async (req, res) => {
    const host = req.hostname;
    const subdomain = host.split('.')[0];
    
    // Don't proxy the main domain, let it fall through to the static handler above
    if (!subdomain || host === process.env.DOMAIN_NAME) {
       return res.sendFile(path.join(__dirname, 'index.html'));
    }

    try {
        const project = await Project.findOne({ subdomain: subdomain, status: 'ready' });
        if (!project) {
            return res.status(404).send('<html><body><h1>404 Not Found</h1><p>Project does not exist or is not deployed.</p></body></html>');
        }

        const projectPath = path.join(DEPLOYMENTS_DIR, project.id);
        // Serve index.html for root requests to the subdomain, otherwise serve the specific file
        const requestedFile = req.path === '/' ? 'index.html' : req.path;
        res.sendFile(path.join(projectPath, requestedFile));

    } catch (error) {
        res.status(500).send('Server error.');
    }
});

// --- SERVER START ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
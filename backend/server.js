// backend/server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs/promises');
const multer = require('multer');
const simpleGit = require('simple-git');
const unzipper = require('unzipper');

// --- 1. INITIAL SETUP & MIDDLEWARE ---
const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const DEPLOYMENTS_DIR = path.join(__dirname, 'deployments');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.mkdir(DEPLOYMENTS_DIR, { recursive: true });
fs.mkdir(UPLOADS_DIR, { recursive: true });

const upload = multer({ dest: UPLOADS_DIR });

// --- 2. DATABASE CONNECTION & MODELS ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('MongoDB Connected...'))
    .catch(err => console.error('DB Connection Error:', err));

const UserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
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
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    status: { type: String, enum: ['queued', 'deploying', 'ready', 'failed'], default: 'queued' },
}, { timestamps: true });
const Project = mongoose.model('Project', ProjectSchema);


// --- 3. AUTHENTICATION MIDDLEWARE ---
const authMiddleware = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Authorization denied' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.id;
        next();
    } catch (e) {
        res.status(400).json({ message: 'Token is not valid' });
    }
};

// --- 4. DEPLOYMENT LOGIC ---
const deployProject = async (project, sourcePath, isZip = false) => {
    await project.updateOne({ status: 'deploying' });
    const projectDir = path.join(DEPLOYMENTS_DIR, project.id);

    try {
        await fs.rm(projectDir, { recursive: true, force: true });
        await fs.mkdir(projectDir, { recursive: true });

        if (isZip) {
            await fs.createReadStream(sourcePath)
                .pipe(unzipper.Extract({ path: projectDir }))
                .promise();
        } else { // Git Clone - sourcePath is the temp clone dir
            const files = await fs.readdir(sourcePath);
            for (const file of files) {
                if (file !== '.git') {
                    await fs.rename(path.join(sourcePath, file), path.join(projectDir, file));
                }
            }
        }
        await project.updateOne({ status: 'ready' });
        console.log(`[${project.subdomain}] Deployed successfully.`);
    } catch (error) {
        await project.updateOne({ status: 'failed' });
        console.error(`[${project.subdomain}] Deployment failed:`, error);
    } finally {
        // Cleanup temp files
        await fs.rm(sourcePath, { recursive: true, force: true });
    }
};

// --- 5. API ROUTES ---
app.post('/api/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (await User.findOne({ email })) return res.status(400).json({ message: 'User already exists' });
        const user = await User.create({ email, password });
        res.status(201).json({ message: 'User created' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email });
        if (!user || !await bcrypt.compare(password, user.password)) {
            return res.status(400).json({ message: 'Invalid credentials' });
        }
        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1d' });
        res.json({ token });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.get('/api/projects', authMiddleware, async (req, res) => {
    const projects = await Project.find({ owner: req.userId });
    res.json(projects);
});

app.post('/api/projects', authMiddleware, async (req, res) => {
    try {
        const { name } = req.body;
        const subdomain = name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20);
        if (await Project.findOne({ subdomain })) return res.status(400).json({ message: 'Project name taken' });
        const project = await Project.create({ name, subdomain, owner: req.userId });
        res.status(201).json(project);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.post('/api/deploy', authMiddleware, upload.single('file'), async (req, res) => {
    const { projectId, gitURL } = req.body;
    const project = await Project.findOne({ _id: projectId, owner: req.userId });
    if (!project) return res.status(404).json({ message: 'Project not found' });

    if (req.file) { // Manual ZIP upload
        await deployProject(project, req.file.path, true);
        res.json({ message: 'Deployment from ZIP started.' });
    } else if (gitURL) { // Git URL
        const tempCloneDir = path.join(UPLOADS_DIR, `git-${project.id}`);
        try {
            await simpleGit().clone(gitURL, tempCloneDir, { '--depth': 1 });
            await deployProject(project, tempCloneDir, false);
            res.json({ message: 'Deployment from Git started.' });
        } catch (error) {
            await project.updateOne({ status: 'failed' });
            res.status(500).json({ message: 'Git clone failed.' });
        }
    } else {
        res.status(400).json({ message: 'No file or Git URL provided.' });
    }
});

app.get('/api/health', (req, res) => res.status(200).send('OK'));

// --- 6. REVERSE PROXY ---
// This MUST be the last middleware.
app.use(async (req, res) => {
    const host = req.hostname;
    const platformDomain = process.env.RENDER_EXTERNAL_HOSTNAME;
    
    // Ignore requests to the main API domain itself
    if (host === platformDomain) {
      return res.status(404).send('API endpoint. Not a hosted site.');
    }

    const subdomain = host.split('.')[0];
    const project = await Project.findOne({ subdomain, status: 'ready' });

    if (project) {
        const projectPath = path.join(DEPLOYMENTS_DIR, project.id);
        // Serve static files from the found project directory
        return express.static(projectPath)(req, res, () => {
          // If express.static doesn't find a file, it calls next().
          // We can serve the index.html for SPA routing.
          res.sendFile(path.join(projectPath, 'index.html'), (err) => {
            if (err) res.status(404).send('Site found, but content is missing or misconfigured.');
          });
        });
    } else {
        res.status(404).send(`Project with subdomain "${subdomain}" not found or not ready.`);
    }
});


// --- 7. SERVER START ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
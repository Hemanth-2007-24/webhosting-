// =================================================================
// ==                  WebHost Platform Server                    ==
// =================================================================
// This single file powers the entire backend:
// - Express web server
// - API for user auth and project management
// - Mongoose for MongoDB interaction
// - Deployment engine for Git and ZIP files
// - Reverse proxy to serve deployed user sites on subdomains
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
const UserSchema = new mongoose.Schema({ email: { type: String, required: true, unique: true, trim: true, lowercase: true }, password: { type: String, required: true }, });
UserSchema.pre('save', async function(next) { if (this.isModified('password')) { this.password = await bcrypt.hash(this.password, 10); } next(); });
const User = mongoose.model('User', UserSchema);
const ProjectSchema = new mongoose.Schema({ name: { type: String, required: true }, subdomain: { type: String, required: true, unique: true }, owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, status: { type: String, enum: ['queued', 'deploying', 'ready', 'failed'], default: 'queued' }, }, { timestamps: true });
const Project = mongoose.model('Project', ProjectSchema);

// --- AUTH MIDDLEWARE ---
const authMiddleware = (req, res, next) => { const authHeader = req.headers.authorization; if (!authHeader || !authHeader.startsWith('Bearer ')) { return res.status(401).json({ message: 'Authorization denied, no token provided.' }); } try { const token = authHeader.split(' ')[1]; const decoded = jwt.verify(token, process.env.JWT_SECRET); req.user = decoded; next(); } catch (e) { res.status(400).json({ message: 'Token is not valid.' }); }};

// --- FILE UPLOAD MIDDLEWARE (MULTER) ---
const upload = multer({ dest: path.join(__dirname, 'uploads/') });

// --- DEPLOYMENT LOGIC & HELPERS ---
const DEPLOYMENTS_DIR = path.join(__dirname, 'deployments');
async function findBuildDir(basePath) { const commonDirs = ['dist', 'build', 'public', 'out']; for (const dir of commonDirs) { const potentialPath = path.join(basePath, dir); if (await fs.pathExists(potentialPath)) { return potentialPath; } } return basePath; }

// =================================================================
// ==                         API ROUTES                          ==
// =================================================================

// The API routes must be defined BEFORE the general serving logic
app.post('/api/auth/register', async (req, res) => { try { const { email, password } = req.body; if (!email || !password || password.length < 6) { return res.status(400).json({ message: 'Invalid email or password (min 6 chars).' }); } if (await User.findOne({ email })) { return res.status(400).json({ message: 'User with this email already exists.' }); } const user = new User({ email, password }); await user.save(); res.status(201).json({ message: 'User registered successfully.' }); } catch (error) { console.error("Register Error:", error); res.status(500).json({ message: 'Server error during registration.' }); }});
app.post('/api/auth/login', async (req, res) => { try { const { email, password } = req.body; const user = await User.findOne({ email }); if (!user || !(await bcrypt.compare(password, user.password))) { return res.status(400).json({ message: 'Invalid credentials.' }); } const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' }); res.json({ token }); } catch (error) { console.error("Login Error:", error); res.status(500).json({ message: 'Server error during login.' }); }});
app.post('/api/projects', authMiddleware, async (req, res) => { try { const { name } = req.body; if (!name || name.trim().length < 3) { return res.status(400).json({ message: 'Project name must be at least 3 characters.' }); } const subdomain = name.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20) + '-' + cuid.slug(); if (await Project.findOne({ subdomain })) { return res.status(400).json({ message: 'A project with a similar name already exists.' }); } const project = new Project({ name, subdomain, owner: req.user.id, status: 'queued' }); await project.save(); res.status(201).json(project); } catch (error) { console.error("Create Project Error:", error); res.status(500).json({ message: 'Server error creating project.' }); }});
app.get('/api/projects', authMiddleware, async (req, res) => { try { const projects = await Project.find({ owner: req.user.id }).sort({ createdAt: -1 }); res.json(projects); } catch (error) { console.error("Get Projects Error:", error); res.status(500).json({ message: 'Server error fetching projects.' }); }});
app.delete('/api/projects/:id', authMiddleware, async (req, res) => { try { const projectId = req.params.id; const project = await Project.findById(projectId); if (!project) { return res.status(404).json({ message: 'Project not found.' }); } if (project.owner.toString() !== req.user.id) { return res.status(403).json({ message: 'Forbidden: You do not own this project.' }); } const projectDeployPath = path.join(DEPLOYMENTS_DIR, project.id); await fs.remove(projectDeployPath); console.log(`[${project.name}] --> Files deleted from disk at ${projectDeployPath}`); await Project.findByIdAndDelete(projectId); console.log(`[${project.name}] --> Record deleted from database.`); res.status(204).send(); } catch (error) { console.error("Delete Project Error:", error); res.status(500).json({ message: 'Server error while deleting project.' }); }});
app.post('/api/deploy', authMiddleware, upload.single('file'), async (req, res) => { const { projectId, gitURL } = req.body; let project; try { project = await Project.findById(projectId); if (!project || project.owner.toString() !== req.user.id) { return res.status(404).json({ message: 'Project not found or you are not the owner.' }); } await project.updateOne({ status: 'deploying' }); console.log(`[${project.name}] --> Deployment started.`); res.status(202).json({ message: 'Deployment accepted and is in progress.' }); const projectDeployPath = path.join(DEPLOYMENTS_DIR, project.id); console.log(`[${project.name}] STEP 1: Cleaning up old deployment at ${projectDeployPath}`); await fs.ensureDir(projectDeployPath); await fs.emptyDir(projectDeployPath); if (gitURL) { console.log(`[${project.name}] STEP 2: Cloning from Git URL: ${gitURL}`); const tempCloneDir = path.join(__dirname, 'uploads', `_temp_git_${project.id}`); await fs.emptyDir(tempCloneDir); await simpleGit().clone(gitURL, tempCloneDir, { '--depth': 1 }); console.log(`[${project.name}] ... Git clone successful.`); const buildDir = await findBuildDir(tempCloneDir); console.log(`[${project.name}] STEP 3: Found build directory at: ${buildDir}`); await fs.copy(buildDir, projectDeployPath); console.log(`[${project.name}] STEP 4: Copied files to final deployment directory.`); await fs.remove(tempCloneDir); } else if (req.file) { console.log(`[${project.name}] STEP 2: Unzipping file: ${req.file.path}`); await new Promise((resolve, reject) => { fs.createReadStream(req.file.path) .pipe(unzipper.Extract({ path: projectDeployPath })) .on('finish', () => { console.log(`[${project.name}] ... Unzip successful.`); resolve(); }) .on('error', (err) => { console.error(`[${project.name}] ... Unzip error:`, err); reject(err); }); }); await fs.remove(req.file.path); } else { throw new Error("No Git URL or file was provided for deployment."); } await project.updateOne({ status: 'ready' }); console.log(`[${project.name}] --> ✅ Deployment Succeeded. Status set to 'ready'.`); } catch (error) { console.error(`[${project ? project.name : projectId}] --> ❌ Critical deployment failure:`, error.message); console.error(error.stack); if (project) { await project.updateOne({ status: 'failed' }); console.log(`[${project.name}] ... Status updated to 'failed'.`); } }});

// =================================================================
// ==      PATH-BASED ROUTING & SERVING LOGIC (FINAL VERSION)     ==
// =================================================================

// Middleware #1: User Project Proxy
// This middleware runs for every request that is NOT an API call.
app.use(async (req, res, next) => {
    // Extract the first segment of the path, which could be a project identifier.
    const projectIdentifier = req.path.split('/')[1];

    // If there's no identifier, it's a request for the root, so skip to next middleware.
    if (!projectIdentifier) {
        return next();
    }

    try {
        // Check if a project with this identifier exists and is ready.
        const project = await Project.findOne({ subdomain: projectIdentifier, status: 'ready' });

        // If a project is found, serve its files.
        if (project) {
            const projectPath = path.join(DEPLOYMENTS_DIR, project.id);
            
            // We need to modify the request URL for the static server.
            // e.g., a request for '/myproject/css/style.css' should look for '/css/style.css' inside the project's folder.
            req.url = req.url.replace(`/${projectIdentifier}`, '') || '/';

            return express.static(projectPath)(req, res, (err) => {
                // If a specific file isn't found in the user's project,
                // it might be an SPA. Send their index.html as a fallback.
                res.sendFile(path.join(projectPath, 'index.html'));
            });
        }
        
        // If no project was found with that name, pass control to the next middleware.
        return next();

    } catch (error) {
        console.error("Path-based Proxy Error:", error);
        return res.status(500).send('Server error.');
    }
});

// Middleware #2: Main Dashboard Static Files
// This serves index.html, dashboard.html, style.css, etc., for our main site.
app.use(express.static(path.join(__dirname, '/')));

// Middleware #3: Catch-all for SPA-like navigation on the Dashboard
// If a request makes it this far (e.g., a user types /dashboard directly),
// it wasn't a project and wasn't a specific file. Send the main index.html.
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- SERVER START ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

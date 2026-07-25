// =================================================================
// ==                    database.js                              ==
// =================================================================

const mongoose = require('mongoose');

const connectDatabase = async (uri) => {
    try {
        await mongoose.connect(uri, {
            useNewUrlParser: true,
            useUnifiedTopology: true
        });
        console.log('✅ Connected securely to MongoDB Atlas.');
    } catch (err) {
        console.error('❌ MongoDB Atlas connection error:', err);
        process.exit(1);
    }
};

// --- USER SCHEMA ---
const UserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    password: { type: String, required: true },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    refreshToken: { type: String, default: '' },
    resetPasswordToken: { type: String, default: '' },
    resetPasswordExpires: { type: Date, default: null }
}, { timestamps: true });

// --- PROJECT SCHEMA ---
const ProjectSchema = new mongoose.Schema({
    projectName: { type: String, required: true },
    websiteUrl: { type: String, required: true },
    packageName: { type: String, required: true, unique: true },
    appName: { type: String, required: true },
    platform: { type: String, enum: ['android', 'windows', 'both'], required: true },
    iconUrl: { type: String, default: '' },
    splashUrl: { type: String, default: '' },
    themeColor: { type: String, default: '#6366F1' },
    versionName: { type: String, default: '1.0.0' },
    versionCode: { type: Number, default: 1 },
    permissions: {
        internet: { type: Boolean, default: true },
        camera: { type: Boolean, default: false },
        notifications: { type: Boolean, default: false },
        storage: { type: Boolean, default: false },
        location: { type: Boolean, default: false }
    },
    customCode: { type: String, default: '' },
    buildStatus: { type: String, enum: ['none', 'building', 'ready', 'failed'], default: 'none' },
    isArchived: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

// --- BUILDS SCHEMA ---
const BuildSchema = new mongoose.Schema({
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    platform: { type: String, enum: ['android', 'windows'], required: true },
    status: { type: String, enum: ['queued', 'building', 'success', 'failed'], default: 'queued' },
    apkUrl: { type: String, default: '' },
    exeUrl: { type: String, default: '' },
    size: { type: Number, default: 0 },
    logs: { type: String, default: '' },
    startTime: { type: Date, required: true },
    endTime: { type: Date, default: null },
    duration: { type: Number, default: 0 }
}, { timestamps: true });

// --- UPLOADS SCHEMA ---
const UploadSchema = new mongoose.Schema({
    fileName: { type: String, required: true },
    url: { type: String, required: true },
    publicId: { type: String, required: true },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

// --- NOTIFICATIONS SCHEMA ---
const NotificationSchema = new mongoose.Schema({
    title: { type: String, required: true },
    body: { type: String, required: true },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    status: { type: String, enum: ['queued', 'sent', 'failed'], default: 'queued' }
}, { timestamps: true });

// --- LOGS SCHEMA ---
const LogSchema = new mongoose.Schema({
    actionType: { type: String, required: true },
    details: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', default: null },
    timestamp: { type: Date, default: Date.now }
}, { timestamps: true });

// --- ANALYTICS SCHEMA ---
const AnalyticsSchema = new mongoose.Schema({
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    platform: { type: String, enum: ['android', 'windows'], required: true },
    downloads: { type: Number, default: 0 },
    launches: { type: Number, default: 0 }
}, { timestamps: true });

// --- GENERATED APPS SCHEMA ---
const GeneratedAppSchema = new mongoose.Schema({
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    platform: { type: String, enum: ['android', 'windows'], required: true },
    downloadUrl: { type: String, required: true },
    versionCode: { type: Number, required: true }
}, { timestamps: true });

const User = mongoose.model('User', UserSchema);
const Project = mongoose.model('Project', ProjectSchema);
const Build = mongoose.model('Build', BuildSchema);
const Upload = mongoose.model('Upload', UploadSchema);
const Notification = mongoose.model('Notification', NotificationSchema);
const Log = mongoose.model('Log', LogSchema);
const Analytics = mongoose.model('Analytics', AnalyticsSchema);
const GeneratedApp = mongoose.model('GeneratedApp', GeneratedAppSchema);

module.exports = {
    connectDatabase,
    User,
    Project,
    Build,
    Upload,
    Notification,
    Log,
    Analytics,
    GeneratedApp
};

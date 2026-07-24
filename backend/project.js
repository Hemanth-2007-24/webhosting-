const mongoose = require('mongoose');

const ProjectSchema = new mongoose.Schema({
    projectName: { type: String, required: true },
    websiteURL: { type: String, required: true },
    packageName: { type: String, required: true, unique: true },
    appName: { type: String, required: true },
    appIcon: { type: String, default: '' },
    splashScreen: {
        backgroundColor: { type: String, default: '#050816' },
        logo: { type: String, default: '' },
        fadeAnimation: { type: Boolean, default: true }
    },
    permissions: {
        internet: { type: Boolean, default: true },
        camera: { type: Boolean, default: false },
        notifications: { type: Boolean, default: false },
        storage: { type: Boolean, default: false },
        location: { type: Boolean, default: false }
    },
    themeColor: { type: String, default: '#6366F1' },
    buildType: { type: String, enum: ['debug', 'release'], default: 'release' },
    versionCode: { type: Number, default: 1 },
    versionName: { type: String, default: '1.0.0' },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

module.exports = mongoose.model('Project', ProjectSchema);
